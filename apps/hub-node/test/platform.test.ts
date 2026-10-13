import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings } from "../src/app.js";
import { openDatabase } from "../src/db.js";

describe("the Node hub matches D1", () => {
  it("enforces foreign keys", async () => {
    for (const url of [
      ":memory:",
      `file:${join(mkdtempSync(join(tmpdir(), "yapm-")), "yapm.db")}`,
    ]) {
      const { client } = await openDatabase(url);
      expect((await client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys).toBe(1);
    }
  });
});

describe("boot config", () => {
  it("warns about each required setting left empty", () => {
    expect(configWarnings({})).toEqual([
      expect.stringContaining("YAPM_SECRET"),
      expect.stringContaining("ORIGIN"),
    ]);
    expect(configWarnings({ YAPM_SECRET: "", ORIGIN: "https://hub.example.com" })).toEqual([
      expect.stringContaining("YAPM_SECRET"),
    ]);
    expect(configWarnings({ YAPM_SECRET: "s", ORIGIN: "https://hub.example.com" })).toEqual([]);
  });
});
