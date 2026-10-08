import { cycles, issues, teams, workspaces } from "@life-os/schema";
import { and, asc, count, eq, gt, inArray, isNull } from "drizzle-orm";
import { type AuditInput, audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { addDays, DAY_MS, localDate, weekday, zonedTime } from "../time.js";
import { insertRows } from "../write.js";
import { type Ctx, changes, event } from "./common.js";

type TeamRow = typeof teams.$inferSelect;
export type CycleRow = typeof cycles.$inferSelect;

export async function companyTimeZone(db: HubDb): Promise<string> {
  const company = await db.select({ timezone: workspaces.timezone }).from(workspaces).get();
  return company?.timezone || "UTC";
}

export async function requireCycle(db: HubDb, id: string) {
  const cycle = await db.select().from(cycles).where(eq(cycles.id, id)).get();
  if (!cycle) throw notFound("Cycle");
  return cycle;
}

/** Checks a cycle an issue in `teamId` is moving into. */
export async function checkIssueCycle(db: HubDb, teamIds: Iterable<string>, cycleId: string) {
  const cycle = await requireCycle(db, cycleId);
  for (const teamId of teamIds) {
    if (cycle.teamId !== teamId) throw badRequest("That cycle belongs to another team");
  }
  if (cycle.completedAt) throw badRequest("That cycle is already completed");
  return cycle;
}

export async function updateCycle(
  ctx: Ctx,
  id: string,
  input: { name?: string | null; description?: string | null },
) {
  const { db, now } = ctx;
  const cycle = await requireCycle(db, id);
  const next: Partial<CycleRow> = {};
  if (input.name !== undefined) next.name = input.name?.trim().slice(0, 80) || null;
  const diff = changes(cycle, next);
  if (!diff) return id;
  await commit(db, [
    db
      .update(cycles)
      .set({ ...next, updatedAt: now })
      .where(eq(cycles.id, id)),
    ...audit(db, [event(ctx, "cycle.update", "cycle", id, diff)], now),
  ]);
  return id;
}

/** Issue counts in each cycle: scope leaves out canceled issues, as Linear does. */
async function cycleCounts(db: HubDb, cycleIds: string[]) {
  const counts = new Map<string, { scope: number; completed: number; open: number }>();
  if (!cycleIds.length) return counts;
  const rows = await db
    .select({
      cycleId: issues.cycleId,
      total: count(),
      completed: count(issues.completedAt),
      canceled: count(issues.canceledAt),
    })
    .from(issues)
    .where(and(inArray(issues.cycleId, cycleIds), isNull(issues.archivedAt)))
    .groupBy(issues.cycleId)
    .all();
  for (const id of cycleIds) {
    const row = rows.find((r) => r.cycleId === id);
    const scope = (row?.total ?? 0) - (row?.canceled ?? 0);
    const completed = row?.completed ?? 0;
    counts.set(id, { scope, completed, open: scope - completed });
  }
  return counts;
}

/** Appends today's counts (and any missed days) to a running cycle's history. */
function withHistory(cycle: CycleRow, at: number, point: { scope: number; completed: number }) {
  const days = Math.min(Math.floor((at - cycle.startsAt) / DAY_MS) + 1, 400);
  const history = { scope: [...cycle.history.scope], completed: [...cycle.history.completed] };
  if (history.scope.length >= days) {
    history.scope[history.scope.length - 1] = point.scope;
    history.completed[history.completed.length - 1] = point.completed;
    return { history, changed: false };
  }
  while (history.scope.length < days) {
    history.scope.push(point.scope);
    history.completed.push(point.completed);
  }
  return { history, changed: true };
}

/**
 * Keeps one team's cycles in step with the clock, like Linear's automation:
 * creates the current and upcoming cycles, closes ended ones (moving unfinished
 * issues into the next cycle) and records daily progress for the burn-up chart.
 */
export async function syncTeamCycles(db: HubDb, team: TeamRow, timeZone: string, at: number) {
  if (!team.cyclesEnabled || team.archivedAt) return;
  const existing = await db
    .select()
    .from(cycles)
    .where(eq(cycles.teamId, team.id))
    .orderBy(asc(cycles.number))
    .all();
  const ops: WriteOp[] = [];
  const events: AuditInput[] = [];
  const system = (action: string, id: string, data: Record<string, unknown>): AuditInput => ({
    actorId: null,
    action,
    entityType: "cycle",
    entityId: id,
    data,
  });

  // 1. Make sure the current cycle (or the next, during a cooldown) and the upcoming ones exist.
  const weeks = Math.max(1, team.cycleDuration) * 7;
  const rest = Math.max(0, team.cycleCooldown) * 7;
  const last = existing.at(-1);
  let start: string;
  if (last) {
    start = addDays(localDate(last.endsAt, timeZone), rest);
  } else {
    const today = localDate(at, timeZone);
    start = addDays(today, -((weekday(today) - team.cycleStartDay + 7) % 7));
  }
  // After a long pause, skip ahead to the cycle that includes today.
  while (zonedTime(addDays(start, weeks), timeZone) <= at) start = addDays(start, weeks + rest);
  const ahead = existing.filter((c) => c.endsAt > at).length;
  const wanted = 1 + Math.max(0, Math.min(team.upcomingCycleCount, 10));
  const created: CycleRow[] = [];
  let number = Math.max(team.cycleCount, last?.number ?? 0);
  for (let i = ahead; i < wanted; i++) {
    number += 1;
    const end = addDays(start, weeks);
    created.push({
      id: newId(),
      teamId: team.id,
      number,
      name: null,
      startsAt: zonedTime(start, timeZone),
      endsAt: zonedTime(end, timeZone),
      completedAt: null,
      history: { scope: [], completed: [] },
      uncompletedCount: null,
      createdAt: at,
      updatedAt: at,
    });
    start = addDays(end, rest);
  }
  if (created.length) {
    ops.push(
      ...insertRows(db, cycles, created),
      db.update(teams).set({ cycleCount: number }).where(eq(teams.id, team.id)),
    );
    for (const c of created) {
      events.push(
        system("cycle.create", c.id, { teamId: team.id, number: c.number, startsAt: c.startsAt }),
      );
    }
  }

  // 2. Close cycles that have ended; unfinished issues roll into the next open cycle.
  const all = [...existing, ...created];
  const ended = existing.filter((c) => !c.completedAt && c.endsAt <= at);
  const running = existing.filter((c) => !c.completedAt && c.startsAt <= at && c.endsAt > at);
  const counts = await cycleCounts(
    db,
    [...ended, ...running].map((c) => c.id),
  );
  const next = all.find((c) => c.endsAt > at && !c.completedAt);
  for (const cycle of ended) {
    const point = counts.get(cycle.id) ?? { scope: 0, completed: 0, open: 0 };
    const { history } = withHistory(cycle, Math.min(at, cycle.endsAt - 1), point);
    ops.push(
      db
        .update(cycles)
        .set({ completedAt: at, uncompletedCount: point.open, history, updatedAt: at })
        .where(eq(cycles.id, cycle.id)),
    );
    if (next && point.open) {
      ops.push(
        db
          .update(issues)
          .set({ cycleId: next.id, updatedAt: at })
          .where(
            and(
              eq(issues.cycleId, cycle.id),
              isNull(issues.completedAt),
              isNull(issues.canceledAt),
              isNull(issues.archivedAt),
            ),
          ),
      );
    }
    events.push(
      system("cycle.complete", cycle.id, {
        number: cycle.number,
        completed: point.completed,
        uncompleted: point.open,
        movedTo: point.open ? (next?.id ?? null) : null,
      }),
    );
  }

  // 3. One history point per day for running cycles.
  for (const cycle of running) {
    const point = counts.get(cycle.id) ?? { scope: 0, completed: 0, open: 0 };
    const { history, changed } = withHistory(cycle, at, point);
    if (changed) {
      ops.push(db.update(cycles).set({ history }).where(eq(cycles.id, cycle.id)));
    }
  }

  ops.push(...audit(db, events, at));
  await commit(db, ops);
}

/** Syncs every team with cycles turned on. */
export async function syncCycles(db: HubDb, at: number) {
  const timeZone = await companyTimeZone(db);
  const list = await db
    .select()
    .from(teams)
    .where(and(eq(teams.cyclesEnabled, true), isNull(teams.archivedAt)))
    .all();
  for (const team of list) {
    try {
      await syncTeamCycles(db, team, timeZone, at);
    } catch (error) {
      console.error(`Cycle sync failed for team ${team.key}`, error);
    }
  }
}

/** The team's cycle running at `at`, if any. */
export async function activeCycle(db: HubDb, teamId: string, at: number) {
  return db
    .select()
    .from(cycles)
    .where(and(eq(cycles.teamId, teamId), gt(cycles.endsAt, at), isNull(cycles.completedAt)))
    .orderBy(asc(cycles.startsAt))
    .all()
    .then((rows) => rows.find((c) => c.startsAt <= at) ?? null);
}
