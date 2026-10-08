import { createClient } from "@libsql/client";
import * as schema from "@life-os/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { describe, expect, it } from "vitest";
import { commit, type HubDb } from "../src/db.js";
import { seedCompany } from "../src/seed.js";
import { syncCycles } from "../src/services/cycles.js";
import { createIssue, updateIssue } from "../src/services/issues.js";
import { createTeam, updateTeam } from "../src/services/teams.js";
import { addDays, localDate, weekday, zonedTime } from "../src/time.js";

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
