import { createClient } from "@libsql/client";
import * as schema from "@life-os/schema";
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
import { createTeam, updateTeam } from "../src/services/teams.js";
import { createRecurringIssues, createTemplate } from "../src/services/templates.js";
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
    expect(breaches.map((n) => [n.userId, n.issueId, n.actorId])).toEqual([
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
});
