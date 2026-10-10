import { readdirSync, readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import { DEFAULT_STATES, suggestKey } from "@yapm/core";
import { describe, expect, it } from "vitest";

const dir = new URL("../../../packages/schema/migrations/", import.meta.url);
const DEFAULT_TEAM = "0021_default_team.sql";

async function apply(db: Client, file: string) {
  for (const sql of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint")) {
    if (sql.trim()) await db.execute(sql);
  }
}

/** A hub from before companies started with a team: the workspace, the owner and the CEO. */
async function company(name: string, teams: string[] = []) {
  const db = createClient({ url: ":memory:" });
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < DEFAULT_TEAM)
    .sort()) {
    await apply(db, file);
  }
  await db.batch([
    {
      sql: "INSERT INTO workspaces (id, name, url_key, created_at, updated_at) VALUES ('w', ?, 'w', 0, 0)",
      args: [name],
    },
    `INSERT INTO users (id, kind, name, display_name, manager_id, created_at, updated_at) VALUES
      ('owner', 'owner', 'Youssef', 'Youssef', NULL, 0, 0),
      ('ceo', 'agent', 'CEO', 'CEO', 'owner', 1, 1),
      ('coach', 'agent', 'Coach', 'Coach', 'owner', 2, 2)`,
    ...teams.map(
      (key) =>
        `INSERT INTO teams (id, key, name, created_at, updated_at) VALUES ('${key}', '${key}', '${key}', 0, 0)`,
    ),
  ]);
  return db;
}

const rows = async (db: Client, sql: string) => (await db.execute(sql)).rows.map((r) => ({ ...r }));

describe("giving existing companies their default team", () => {
  it("creates the team setup makes, with its members, states and audit entry", async () => {
    const db = await company("Youssef Inc");
    await apply(db, DEFAULT_TEAM);

    const [team] = await rows(db, "SELECT id, key, name, description, issue_count FROM teams");
    expect(team).toMatchObject({
      key: "YI",
      name: "Youssef Inc",
      description: null,
      issue_count: 0,
    });
    expect(team?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      await rows(db, "SELECT team_id, user_id FROM team_memberships ORDER BY user_id"),
    ).toEqual([
      { team_id: team?.id, user_id: "ceo" },
      { team_id: team?.id, user_id: "owner" },
    ]);
    expect(
      await rows(db, "SELECT name, type, color, position FROM workflow_states ORDER BY position"),
    ).toEqual(DEFAULT_STATES.map((s, position) => ({ ...s, position })));
    const [entry] = await rows(
      db,
      "SELECT actor_id, action, entity_type, entity_id, data FROM audit_events",
    );
    expect(entry).toMatchObject({
      actor_id: "owner",
      action: "team.create",
      entity_type: "team",
      entity_id: team?.id,
    });
    expect(JSON.parse(String(entry?.data))).toEqual({
      key: "YI",
      name: "Youssef Inc",
      leadId: null,
    });
  });

  it("keys the team the way setup does", async () => {
    for (const name of ["Youssef Inc", "acme", "Al-Tai & Sons Ltd", "3D Labs", "!!", "x"]) {
      const db = await company(name);
      await apply(db, DEFAULT_TEAM);
      expect((await rows(db, "SELECT key FROM teams"))[0]?.key).toBe(suggestKey(name));
    }
  });

  it("leaves companies that already have a team alone", async () => {
    const db = await company("Youssef Inc", ["PF"]);
    await apply(db, DEFAULT_TEAM);
    expect(await rows(db, "SELECT key FROM teams")).toEqual([{ key: "PF" }]);
    expect(await rows(db, "SELECT id FROM audit_events")).toEqual([]);
  });

  it("does nothing on a hub that hasn't been set up", async () => {
    const db = createClient({ url: ":memory:" });
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f <= DEFAULT_TEAM)
      .sort()) {
      await apply(db, file);
    }
    expect(await rows(db, "SELECT id FROM teams")).toEqual([]);
  });
});
