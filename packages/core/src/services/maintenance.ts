import { issues, teams, users } from "@life-os/schema";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { type AuditInput, audit } from "../audit.js";
import { commit, type HubDb } from "../db.js";
import type { Ctx } from "./common.js";
import { type NotificationInput, notify } from "./notifications.js";

/** Most issues one tick touches per step, to stay inside D1's per-invocation limits. */
const BATCH = 50;
const MONTH = 30 * 86_400_000;

/**
 * Announces open issues that just passed their SLA deadline, once each: to the assignee
 * (which wakes an agent) and to the owner. Returns whether it notified anyone.
 */
export async function checkSlas(db: HubDb, at: number) {
  const breached = await db
    .select()
    .from(issues)
    .where(
      and(
        lte(issues.slaBreachesAt, at),
        isNull(issues.slaBreachedAt),
        isNull(issues.completedAt),
        isNull(issues.canceledAt),
        isNull(issues.archivedAt),
      ),
    )
    .limit(BATCH)
    .all();
  if (!breached.length) return false;
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.kind, "owner")).get();
  // The hub raises it, not a member, so nobody is skipped as the actor.
  const ctx: Ctx = { db, actorId: "", now: at };
  const inputs: NotificationInput[] = [];
  for (const issue of breached) {
    for (const userId of new Set([issue.assigneeId, owner?.id])) {
      if (userId) inputs.push({ userId, type: "issueSlaBreached", issueId: issue.id });
    }
  }
  const ids = breached.map((i) => i.id);
  const ops = notify(ctx, inputs);
  await commit(db, [
    db.update(issues).set({ slaBreachedAt: at }).where(inArray(issues.id, ids)),
    ...ops,
    ...audit(
      db,
      breached.map(
        (i): AuditInput => ({
          actorId: null,
          action: "issue.slaBreached",
          entityType: "issue",
          entityId: i.id,
          data: { slaBreachesAt: i.slaBreachesAt },
        }),
      ),
      at,
    ),
  ]);
  return !!ctx.notified;
}

/** Archives done and canceled issues older than their team's auto-archive period, like Linear. */
export async function autoArchive(db: HubDb, at: number) {
  const list = await db
    .select({ id: teams.id, months: teams.autoArchivePeriod })
    .from(teams)
    .where(gt(teams.autoArchivePeriod, 0))
    .all();
  for (const team of list) {
    const before = at - team.months * MONTH;
    const old = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.teamId, team.id),
          isNull(issues.archivedAt),
          or(
            and(isNotNull(issues.completedAt), lte(issues.completedAt, before)),
            and(isNotNull(issues.canceledAt), lte(issues.canceledAt, before)),
          ),
        ),
      )
      .limit(BATCH)
      .all();
    if (!old.length) continue;
    const ids = old.map((i) => i.id);
    await commit(db, [
      db.update(issues).set({ archivedAt: at }).where(inArray(issues.id, ids)),
      ...audit(
        db,
        ids.map(
          (id): AuditInput => ({
            actorId: null,
            action: "issue.archive",
            entityType: "issue",
            entityId: id,
            reason: `Closed more than ${team.months} months ago`,
          }),
        ),
        at,
      ),
    ]);
  }
}
