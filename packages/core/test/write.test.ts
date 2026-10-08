import { createClient } from "@libsql/client";
import * as schema from "@life-os/schema";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { DEFAULT_STATES, DEFAULT_TEAMS, seedCompany } from "../src/seed.js";
import { insertRows } from "../src/write.js";

const db = drizzle(createClient({ url: ":memory:" }), { schema });

/** Bound parameter count of a built statement. */
const params = (op: unknown) => (op as { toSQL(): { params: unknown[] } }).toSQL().params.length;

describe("insertRows", () => {
  it("splits inserts to stay under D1's 100 bound parameters per statement", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      teamId: "t",
      name: `State ${i}`,
      type: "backlog" as const,
      color: "#000",
      position: i,
      createdAt: 0,
      updatedAt: 0,
    }));
    const ops = insertRows(db as never, schema.workflowStates, rows);
    for (const op of ops) {
      expect(params(op)).toBeLessThanOrEqual(100);
    }
    expect(ops.length).toBeGreaterThan(1);
  });
});

describe("seedCompany", () => {
  it("creates the company in few statements, each within D1 limits", () => {
    const ops = seedCompany(db as never, {
      ownerId: "o",
      ownerName: "O",
      companyName: "Co",
      now: 0,
    });
    // D1 on the free plan allows 50 queries per invocation; the whole setup must fit comfortably.
    expect(ops.length).toBeLessThan(25);
    for (const op of ops) expect(params(op)).toBeLessThanOrEqual(100);
    expect(DEFAULT_TEAMS.length * DEFAULT_STATES.length).toBe(56);
  });
});
