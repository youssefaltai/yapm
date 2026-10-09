import { readdirSync, readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import { neutral } from "@life-os/core/testing";
import { describe, expect, it } from "vitest";

const dir = new URL("../../../packages/schema/migrations/", import.meta.url);
const RECOLOR = "0018_recolor_defaults.sql";

async function apply(db: Client, file: string) {
  for (const sql of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint")) {
    if (sql.trim()) await db.execute(sql);
  }
}

describe("recolouring the grey defaults", () => {
  it("gives Linear's colours back to defaults saved while the palette was grey", async () => {
    const db = createClient({ url: ":memory:" });
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f < RECOLOR)
      .sort()) {
      await apply(db, file);
    }
    await db.batch([
      `INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at) VALUES
        ('s1', 't', 'Triage', 'triage', '#8b8b90', 0, 0, 0),
        ('s2', 't', 'In Progress', 'started', '#aaaaae', 1, 0, 0),
        ('s3', 't', 'In Review', 'started', '#aaaaae', 2, 0, 0),
        ('s4', 't', 'Done', 'completed', '#d0d0d3', 3, 0, 0),
        ('s5', 't', 'Shipped', 'completed', '#123456', 4, 0, 0)`,
      `INSERT INTO labels (id, name, color, created_at, updated_at) VALUES
        ('l1', 'Bills', '#bec2c8', 0, 0), ('l2', 'Mine', '#eb5757', 0, 0)`,
      `INSERT INTO projects (id, name, color, sort_order, created_at, updated_at) VALUES
        ('p1', 'Car', '#8b8b90', 0, 0, 0), ('p2', 'House', '#8b8b90', 1, 0, 0)`,
    ]);

    await apply(db, RECOLOR);

    const colors = async (table: string) =>
      Object.fromEntries(
        (await db.execute(`SELECT id, color FROM ${table}`)).rows.map((r) => [r.id, r.color]),
      );
    expect(await colors("workflow_states")).toEqual({
      s1: "#fc7840",
      s2: "#f2c94c",
      s3: "#0f973d",
      s4: "#5e6ad2",
      s5: "#123456",
    });
    const labels = await colors("labels");
    expect(labels.l1).not.toSatisfy(neutral);
    expect(labels.l2).toBe("#eb5757");
    const projects = await colors("projects");
    expect(projects.p1).not.toSatisfy(neutral);
    expect(projects.p2).not.toBe(projects.p1);
  });
});
