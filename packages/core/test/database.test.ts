import { createClient } from "@libsql/client";
import * as schema from "@life-os/schema";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { databaseProblem } from "../src/hub.js";
import { createHub, type HubDb } from "../src/index.js";

describe("database problems", () => {
  it("tells the owner when the database has no tables", async () => {
    const db = drizzle(createClient({ url: ":memory:" }), { schema }) as unknown as HubDb;
    const hub = createHub({ db, config: { platform: "node", version: "test" } });
    const response = await hub.request("/api/setup");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/migrations/);
  });

  it("recognises a D1 database that is gone", () => {
    const error = new Error("Failed query", {
      cause: new Error("D1_ERROR: Couldn't find a D1 DB with the name or binding"),
    });
    expect(databaseProblem(error)).toMatch(/deploy again/);
    expect(databaseProblem(new Error("boom"))).toBeNull();
  });
});
