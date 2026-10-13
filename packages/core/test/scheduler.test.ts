import { createClient } from "@libsql/client";
import * as schema from "@yapm/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { describe, expect, it } from "vitest";
import { commit, type HubDb } from "../src/db.js";
import type { HubEvent } from "../src/realtime.js";
import { tick } from "../src/scheduler.js";
import { seedCompany } from "../src/seed.js";
import { syncCycles } from "../src/services/cycles.js";
import { createIssue, updateIssue } from "../src/services/issues.js";
import { autoArchive, checkSlas } from "../src/services/maintenance.js";
import {
  countAll,
  createMetric,
  deriveMetrics,
  emptyCounts,
  lastDays,
  metricHistory,
  metricValues,
  snapshotMetrics,
} from "../src/services/metrics.js";
import { archiveState, createState } from "../src/services/states.js";
import { createTeam, updateTeam } from "../src/services/teams.js";
import { createRecurringIssues, createTemplate } from "../src/services/templates.js";
import { usageHistory } from "../src/services/usage.js";
import { addDays, localDate, nextOccurrence, weekday, zonedTime } from "../src/time.js";

const migrationsFolder = decodeURIComponent(
  new URL("../../schema/migrations", import.meta.url).pathname,
);

/** The item at `i`, failing the test when it's missing. */
function nth<T>(list: T[], i: number): T {
  const item = list[i];
  if (item === undefined) throw new Error(`Nothing at index ${i}`);
  return item;
}

async function company(timezone: string, now: number) {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  const hub = db as unknown as HubDb;
  await commit(
    hub,
    seedCompany(hub, { ownerId: "owner", ownerName: "Owner", companyName: "Co", now }),
  );
  await hub.update(schema.workspaces).set({ timezone });
  return hub;
}

const DAY = 86_400_000;

/** A team's cycles, oldest first. */
function cycleList(db: HubDb, teamId: string) {
  return db
    .select()
    .from(schema.cycles)
    .where(eq(schema.cycles.teamId, teamId))
    .orderBy(schema.cycles.number)
    .all();
}

/** The id of the team's first state of `type`. */
async function stateOf(db: HubDb, teamId: string, type: string) {
  const states = await db
    .select()
    .from(schema.workflowStates)
    .where(eq(schema.workflowStates.teamId, teamId))
    .all();
  return nth(
    states.filter((s) => s.type === type),
    0,
  ).id;
}

describe("time", () => {
  it("finds local midnight across daylight saving changes", () => {
    // Berlin moves clocks forward on 2026-03-29.
    expect(new Date(zonedTime("2026-03-29", "Europe/Berlin")).toISOString()).toBe(
      "2026-03-28T23:00:00.000Z",
    );
    expect(new Date(zonedTime("2026-03-30", "Europe/Berlin")).toISOString()).toBe(
      "2026-03-29T22:00:00.000Z",
    );
    expect(localDate(Date.parse("2026-10-08T23:30:00Z"), "Asia/Tokyo")).toBe("2026-10-09");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(weekday("2026-10-08")).toBe(4);
  });
});

describe("cycles", () => {
  it("opens cycles on the start day, closes them and rolls unfinished issues over", async () => {
    // Thursday 8 October 2026, 10:00 in Cairo.
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("Africa/Cairo", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Health", key: "HEA" });
    await updateTeam(ctx, teamId, { cyclesEnabled: true, cycleStartDay: 1 });

    const list = () =>
      db
        .select()
        .from(schema.cycles)
        .where(eq(schema.cycles.teamId, teamId))
        .orderBy(schema.cycles.number)
        .all();
    let cycles = await list();
    expect(cycles.map((c) => c.number)).toEqual([1, 2, 3]);
    // The current cycle began on Monday 5 October at local midnight and lasts a week.
    expect(localDate(nth(cycles, 0).startsAt, "Africa/Cairo")).toBe("2026-10-05");
    expect(nth(cycles, 0).endsAt).toBe(nth(cycles, 1).startsAt);
    expect(nth(cycles, 0).endsAt - nth(cycles, 0).startsAt).toBe(7 * DAY);

    const done = await createIssue(ctx, {
      teamId,
      title: "Book checkup",
      cycleId: nth(cycles, 0).id,
    });
    const open = await createIssue(ctx, { teamId, title: "Run 5k", cycleId: nth(cycles, 0).id });
    const states = await db
      .select()
      .from(schema.workflowStates)
      .where(eq(schema.workflowStates.teamId, teamId))
      .all();
    const doneState = nth(
      states.filter((s) => s.type === "completed"),
      0,
    );
    await updateIssue(ctx, done, { stateId: doneState.id });

    // A tick the next day records history without opening more cycles.
    await syncCycles(db, start + DAY);
    cycles = await list();
    expect(cycles).toHaveLength(3);
    expect(nth(cycles, 0).history.scope.at(-1)).toBe(2);
    expect(nth(cycles, 0).history.completed.at(-1)).toBe(1);

    // After the cycle ends, it closes and the open issue moves into cycle 2.
    await syncCycles(db, nth(cycles, 0).endsAt + 60_000);
    cycles = await list();
    expect(nth(cycles, 0).completedAt).not.toBeNull();
    expect(nth(cycles, 0).uncompletedCount).toBe(1);
    expect(cycles.map((c) => c.number)).toEqual([1, 2, 3, 4]);
    const moved = await db.select().from(schema.issues).where(eq(schema.issues.id, open)).get();
    expect(moved?.cycleId).toBe(nth(cycles, 1).id);
    const kept = await db.select().from(schema.issues).where(eq(schema.issues.id, done)).get();
    expect(kept?.cycleId).toBe(nth(cycles, 0).id);

    // Running the same tick twice changes nothing.
    await syncCycles(db, nth(cycles, 0).endsAt + 120_000);
    expect(await list()).toHaveLength(4);
    await expect(updateIssue(ctx, open, { cycleId: nth(cycles, 0).id })).rejects.toThrow(
      /already completed/,
    );
  });

  it("records today's progress in the burn-up as it happens", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Health", key: "HEA" });
    await updateTeam(ctx, teamId, { cyclesEnabled: true });
    const [cycle] = await cycleList(db, teamId);
    const ids = [];
    for (const title of ["One", "Two", "Three"])
      ids.push(await createIssue(ctx, { teamId, title, cycleId: cycle?.id }));
    await syncCycles(db, start + 60_000);
    const done = await stateOf(db, teamId, "completed");
    for (const id of ids.slice(0, 2)) await updateIssue(ctx, id, { stateId: done });

    await syncCycles(db, start + 3_600_000);
    const [after] = await cycleList(db, teamId);
    expect(after?.history.scope.at(-1)).toBe(3);
    expect(after?.history.completed.at(-1)).toBe(2);
  });

  it("keeps archived issues in a cycle's scope", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Health", key: "HEA" });
    await updateTeam(ctx, teamId, { cyclesEnabled: true });
    const [cycle] = await cycleList(db, teamId);
    const done = await stateOf(db, teamId, "completed");
    await createIssue(ctx, { teamId, title: "Open", cycleId: cycle?.id });
    for (const title of ["One", "Two"])
      await createIssue(ctx, { teamId, title, cycleId: cycle?.id, stateId: done });
    await db
      .update(schema.issues)
      .set({ archivedAt: start })
      .where(eq(schema.issues.stateId, done));

    await syncCycles(db, start + DAY);
    const [after] = await cycleList(db, teamId);
    expect(after?.history.scope.at(-1)).toBe(3);
    expect(after?.history.completed.at(-1)).toBe(2);
  });

  it("re-lays the cycles that haven't started when the cycle settings change", async () => {
    // Thursday 8 October 2026; cycles start on Mondays.
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Health", key: "HEA" });
    await updateTeam(ctx, teamId, { cyclesEnabled: true, cycleStartDay: 1 });
    const before = await cycleList(db, teamId);

    await updateTeam(ctx, teamId, { cycleStartDay: 3, cycleDuration: 2, cycleCooldown: 1 });
    const after = await cycleList(db, teamId);
    const days = (c: (typeof after)[number]) => [
      localDate(c.startsAt, "UTC"),
      localDate(c.endsAt, "UTC"),
    ];
    expect(after.map((c) => [c.id, c.number])).toEqual(before.map((c) => [c.id, c.number]));
    expect(after.map(days)).toEqual([
      ["2026-10-05", "2026-10-12"],
      ["2026-10-21", "2026-11-04"],
      ["2026-11-11", "2026-11-25"],
    ]);
  });

  it("skips ahead after a long pause", async () => {
    const start = Date.parse("2026-01-07T12:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Money", key: "MON" });
    await updateTeam(ctx, teamId, { cyclesEnabled: true, cycleDuration: 2, upcomingCycleCount: 1 });
    const later = start + 90 * DAY;
    await syncCycles(db, later);
    const cycles = await db
      .select()
      .from(schema.cycles)
      .where(eq(schema.cycles.teamId, teamId))
      .orderBy(schema.cycles.number)
      .all();
    const current = cycles.find((c) => c.startsAt <= later && c.endsAt > later);
    expect(current).toBeDefined();
    expect(cycles.filter((c) => c.completedAt)).toHaveLength(2);
    expect(cycles.filter((c) => c.startsAt > later)).toHaveLength(1);
  });
});

describe("recurring issues", () => {
  it("finds the next time a schedule fires", () => {
    // Thursday 8 October 2026, 10:00 in Berlin.
    const at = Date.parse("2026-10-08T08:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(iso(nextOccurrence({ frequency: "daily", time: "08:00" }, "Europe/Berlin", at))).toBe(
      "2026-10-09T06:00:00.000Z",
    );
    expect(iso(nextOccurrence({ frequency: "weekdays", time: "11:00" }, "Europe/Berlin", at))).toBe(
      "2026-10-08T09:00:00.000Z",
    );
    // Friday → Monday, across the end of summer time on 25 October.
    expect(
      iso(
        nextOccurrence(
          { frequency: "weekly", time: "09:00", weekday: 1 },
          "Europe/Berlin",
          Date.parse("2026-10-24T00:00:00Z"),
        ),
      ),
    ).toBe("2026-10-26T08:00:00.000Z");
    // The 31st in a 30-day month falls on its last day.
    expect(
      iso(
        nextOccurrence(
          { frequency: "monthly", time: "07:00", monthDay: 31 },
          "UTC",
          Date.parse("2026-11-02T00:00:00Z"),
        ),
      ),
    ).toBe("2026-11-30T07:00:00.000Z");
  });

  it("creates the issue each time and wakes an agent that assigned it to itself", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const owner = { db, actorId: "owner", now: start };
    const teamId = await createTeam(owner, { name: "Home", key: "HOM" });
    const ceo = await db.select().from(schema.users).where(eq(schema.users.name, "CEO")).get();
    const ceoId = ceo?.id ?? "";
    await createTemplate(
      { db, actorId: ceoId, now: start },
      {
        teamId,
        templateData: { title: "Morning brief {date}", assigneeId: ceoId, priority: 3 },
        schedule: { frequency: "daily", time: "08:00" },
      },
    );
    const deps = { db, config: { platform: "node" as const, version: "test" } };
    expect(await createRecurringIssues(deps, start + 30 * 60_000)).toBe(false);
    expect(await createRecurringIssues(deps, start + 61 * 60_000)).toBe(true);
    await createRecurringIssues(deps, start + 62 * 60_000);
    const created = await db.select().from(schema.issues).all();
    expect(created.map((i) => i.title)).toEqual(["Morning brief 2026-10-08"]);
    expect(created[0]?.assigneeId).toBe(ceoId);
    const woke = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, ceoId))
      .all();
    expect(woke.map((n) => n.type)).toEqual(["issueAssignedToYou"]);
    await createRecurringIssues(deps, start + DAY + 61 * 60_000);
    expect(await db.select().from(schema.issues).all()).toHaveLength(2);
  });

  it("falls back to the team's default status when the template's is gone", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const owner = { db, actorId: "owner", now: start };
    const teamId = await createTeam(owner, { name: "Home", key: "HOM" });
    const stateId = await createState(owner, { teamId, name: "Weekly", type: "unstarted" });
    await createTemplate(owner, {
      teamId,
      templateData: { title: "Water the plants", stateId },
      schedule: { frequency: "daily", time: "08:00" },
    });
    await archiveState(owner, stateId);
    await createRecurringIssues(
      { db, config: { platform: "node" as const, version: "test" } },
      start + 61 * 60_000,
    );
    const [issue] = await db.select().from(schema.issues).all();
    const backlog = await db
      .select()
      .from(schema.workflowStates)
      .where(eq(schema.workflowStates.id, issue?.stateId ?? ""))
      .get();
    expect(backlog?.name).toBe("Backlog");
  });
});

describe("SLAs and auto-archive", () => {
  it("announces a breach once and archives old closed issues", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Bills", key: "BIL" });
    await updateTeam(ctx, teamId, { slaHours: { "1": 4 }, autoArchivePeriod: 1 });
    const urgent = await createIssue(ctx, { teamId, title: "Card blocked", priority: 1 });
    const done = await createIssue(ctx, { teamId, title: "Old bill" });
    const states = await db
      .select()
      .from(schema.workflowStates)
      .where(eq(schema.workflowStates.teamId, teamId))
      .all();
    await updateIssue(ctx, done, {
      stateId: nth(
        states.filter((s) => s.type === "completed"),
        0,
      ).id,
    });

    expect(await checkSlas(db, start + 3 * 3_600_000)).toBe(false);
    expect(await checkSlas(db, start + 5 * 3_600_000)).toBe(true);
    expect(await checkSlas(db, start + 6 * 3_600_000)).toBe(false);
    const breaches = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.type, "issueSlaBreached"))
      .all();
    // The CEO has it, since the owner filed it unassigned; both hear about the breach.
    const ceo = await db.select().from(schema.users).where(eq(schema.users.kind, "agent")).get();
    expect(breaches.map((n) => [n.userId, n.issueId, n.actorId])).toEqual([
      [ceo?.id, urgent, null],
      ["owner", urgent, null],
    ]);

    await autoArchive(db, start + 10 * DAY);
    const kept = await db.select().from(schema.issues).where(eq(schema.issues.id, done)).get();
    expect(kept?.archivedAt).toBeNull();
    await autoArchive(db, start + 31 * DAY);
    const archived = await db.select().from(schema.issues).all();
    expect(archived.find((i) => i.id === done)?.archivedAt).not.toBeNull();
    expect(archived.find((i) => i.id === urgent)?.archivedAt).toBeNull();
  });
  it("moves open issues' deadlines when the team's SLA changes", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Bills", key: "BIL" });
    const urgent = await createIssue(ctx, { teamId, title: "Card blocked", priority: 1 });
    const closed = await createIssue(ctx, {
      teamId,
      title: "Old bill",
      priority: 1,
      stateId: await stateOf(db, teamId, "completed"),
    });
    const deadline = async (id: string) =>
      (await db.select().from(schema.issues).where(eq(schema.issues.id, id)).get())?.slaBreachesAt;

    const later = { ...ctx, now: start + 3_600_000 };
    await updateTeam(later, teamId, { slaHours: { "1": 4 } });
    expect(await deadline(urgent)).toBe(later.now + 4 * 3_600_000);
    expect(await deadline(closed)).toBeNull();
    await updateTeam({ ...ctx, now: start + 2 * 3_600_000 }, teamId, { slaHours: { "1": 2 } });
    expect(await deadline(urgent)).toBe(later.now + 2 * 3_600_000);
    await updateTeam(ctx, teamId, { slaHours: null });
    expect(await deadline(urgent)).toBeNull();
  });
});

describe("tick", () => {
  it("tells open apps when time-based work changed something, and only then", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Bills", key: "BIL" });
    await updateTeam(ctx, teamId, { autoArchivePeriod: 1 });
    const done = await createIssue(ctx, { teamId, title: "Old bill" });
    const states = await db
      .select()
      .from(schema.workflowStates)
      .where(eq(schema.workflowStates.teamId, teamId))
      .all();
    await updateIssue(ctx, done, {
      stateId: nth(
        states.filter((s) => s.type === "completed"),
        0,
      ).id,
    });
    const events: HubEvent[] = [];
    const deps = {
      db,
      config: { platform: "node" as const, version: "test" },
      realtime: { connect: () => new Response(), publish: (e: HubEvent) => void events.push(e) },
    };

    await tick(deps, start + 10 * DAY);
    expect(events).toEqual([]);
    await tick(deps, start + 31 * DAY);
    expect(events).toEqual([{ type: "change", actorId: "", clientId: null, at: start + 31 * DAY }]);
  });
});

describe("lost runs", () => {
  it("fails a run whose machine went quiet and announces the change", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ceo = await db.select().from(schema.users).where(eq(schema.users.kind, "agent")).get();
    await db.insert(schema.runs).values({
      id: "lost",
      agentId: ceo?.id ?? "",
      kind: "work",
      status: "running",
      heartbeatAt: start,
      createdAt: start,
      updatedAt: start,
    });
    const events: HubEvent[] = [];
    const deps = {
      db,
      config: { platform: "node" as const, version: "test" },
      realtime: { connect: () => new Response(), publish: (e: HubEvent) => void events.push(e) },
    };

    const at = start + 10 * 60_000;
    await tick(deps, at);
    const run = await db.select().from(schema.runs).where(eq(schema.runs.id, "lost")).get();
    expect(run?.status).toBe("failed");
    expect(events).toEqual([{ type: "change", actorId: "", clientId: null, at }]);
  });
});

describe("metrics", () => {
  it("counts the day's work and snapshots it once after the day ends", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    const ctx = { db, actorId: "owner", now: start };
    const teamId = await createTeam(ctx, { name: "Home", key: "HOM" });
    const states = await db
      .select()
      .from(schema.workflowStates)
      .where(eq(schema.workflowStates.teamId, teamId))
      .all();
    const ofType = (type: string) =>
      nth(
        states.filter((s) => s.type === type),
        0,
      ).id;
    const done = await createIssue(ctx, { teamId, title: "Fix the tap" });
    await createIssue(ctx, { teamId, title: "Paint the door" });
    await updateIssue({ ...ctx, now: start + 3_600_000 }, done, { stateId: ofType("started") });
    await updateIssue({ ...ctx, now: start + 5 * 3_600_000 }, done, {
      stateId: ofType("completed"),
    });
    const ceo = await db.select().from(schema.users).where(eq(schema.users.kind, "agent")).get();
    const run = (id: string, extra: Partial<typeof schema.runs.$inferInsert>) => ({
      id,
      agentId: ceo?.id ?? "",
      kind: "work" as const,
      inputTokens: 600,
      outputTokens: 400,
      endedAt: start + 2 * 3_600_000,
      createdAt: start,
      updatedAt: start,
      ...extra,
    });
    await db
      .insert(schema.runs)
      .values([
        run("r1", { status: "completed" }),
        run("r2", { status: "stopped", stoppedById: "owner" }),
      ]);

    const day = await countAll(
      db,
      Date.parse("2026-10-08T00:00:00Z"),
      Date.parse("2026-10-09T00:00:00Z"),
    );
    expect(deriveMetrics(day.get("company:") ?? emptyCounts())).toMatchObject({
      created: 2,
      completed: 1,
      cycleTimeHours: 4,
      runs: 2,
      runSuccessRate: 0.5,
      stopRate: 0.5,
      tokens: 2000,
      tokensPerCompletedIssue: 2000,
    });
    expect(day.get(`team:${teamId}`)?.completed).toBe(1);
    expect(day.get(`team:${teamId}`)?.runs).toBe(0);
    expect(day.get(`user:${ceo?.id}`)?.runsStopped).toBe(1);

    const nextMorning = Date.parse("2026-10-09T00:30:00Z");
    expect(await snapshotMetrics(db, nextMorning)).toBe(true);
    expect(await snapshotMetrics(db, nextMorning + 60_000)).toBe(false);
    const history = await metricHistory(db, "company", "", 7, nextMorning);
    expect(history.map((h) => [h.date, h.counts.completed, h.counts.tokens])).toEqual([
      ["2026-10-08", 1, 2000],
    ]);
  });

  it("counts what happened in the very millisecond it is asked", async () => {
    const at = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", at);
    const ctx = { db, actorId: "owner", now: at };
    await createMetric(ctx, { name: "Issues filed", numerator: { action: "issue.create" } });
    await createIssue(ctx, {
      teamId: await createTeam(ctx, { name: "Home" }),
      title: "Fix the tap",
    });
    const [filed] = await metricValues(db, ...lastDays(at, 7));
    expect(filed?.value).toBe(1);
  });
  it("fills in the days the hub missed", async () => {
    const start = Date.parse("2026-10-08T07:00:00Z");
    const db = await company("UTC", start);
    expect(await snapshotMetrics(db, Date.parse("2026-10-09T00:30:00Z"))).toBe(true);
    const later = Date.parse("2026-10-12T00:30:00Z");
    expect(await snapshotMetrics(db, later)).toBe(true);
    expect(await snapshotMetrics(db, later + 60_000)).toBe(false);
    const history = await metricHistory(db, "company", "", 7, later);
    expect(history.map((h) => h.date)).toEqual([
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });

  it("counts a run on its local day in half-hour time zones", async () => {
    const at = Date.parse("2026-10-08T12:00:00Z");
    const db = await company("Asia/Kolkata", at);
    const ceo = await db.select().from(schema.users).where(eq(schema.users.kind, "agent")).get();
    // 00:10 on 9 October in Kolkata.
    const endedAt = Date.parse("2026-10-08T18:40:00Z");
    await db.insert(schema.runs).values({
      id: "r1",
      agentId: ceo?.id ?? "",
      kind: "work",
      status: "completed",
      endedAt,
      createdAt: endedAt,
      updatedAt: endedAt,
    });
    const points = await usageHistory(db, "agent", at, at + DAY);
    expect(points.map((p) => p.date)).toEqual(["2026-10-09"]);
  });
});
