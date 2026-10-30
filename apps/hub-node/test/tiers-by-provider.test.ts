import { readdirSync, readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import { expect, it } from "vitest";

const dir = new URL("../../../packages/schema/migrations/", import.meta.url);
const MIGRATION = "0025_tiers_by_provider.sql";

async function apply(db: Client, file: string) {
  for (const sql of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint")) {
    if (sql.trim()) await db.execute(sql);
  }
}

const rows = async (db: Client, sql: string) => (await db.execute(sql)).rows.map((r) => ({ ...r }));

it("names Anthropic on the company's tiers and splits each run's provider from its model", async () => {
  const db = createClient({ url: ":memory:" });
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < MIGRATION)
    .sort())
    await apply(db, file);
  const tiers = {
    small: { model: "claude-sonnet-5-5", effort: "medium" },
    standard: { model: "claude-opus-5-5", effort: "medium" },
    top: { model: "claude-opus-5-5", effort: "high" },
  };
  await db.batch([
    {
      sql: "INSERT INTO workspaces (id, name, url_key, model_routing, created_at, updated_at) VALUES ('w', 'Co', 'w', ?, 0, 0)",
      args: [JSON.stringify({ tiers, labels: { bills: "top" } })],
    },
    `INSERT INTO users (id, kind, name, display_name, engine, created_at, updated_at) VALUES
      ('ceo', 'agent', 'CEO', 'CEO', 'claude', 0, 0), ('gpt', 'agent', 'Gpt', 'Gpt', 'opencode', 0, 0)`,
    `INSERT INTO runs (id, agent_id, kind, status, model, engine, created_at, updated_at) VALUES
      ('a', 'ceo', 'work', 'completed', 'claude-opus-5-5', 'claude', 0, 0),
      ('b', 'gpt', 'work', 'completed', 'openai/gpt-6-sol', 'opencode', 0, 0),
      ('c', 'ceo', 'decision', 'queued', 'claude-sonnet-5-5', NULL, 0, 0)`,
  ]);
  await apply(db, MIGRATION);

  const [company] = await rows(db, "SELECT model_routing FROM workspaces");
  expect(JSON.parse(String(company?.model_routing))).toEqual({
    tiers: {
      small: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
      standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
      top: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
    },
    labels: { bills: "top" },
  });
  // Every agent takes the company's tiers: there's no OpenCode model on the hub to keep.
  expect(await rows(db, "SELECT id, models FROM users ORDER BY id")).toEqual([
    { id: "ceo", models: null },
    { id: "gpt", models: null },
  ]);
  expect(await rows(db, "SELECT id, provider, model FROM runs ORDER BY id")).toEqual([
    { id: "a", provider: "anthropic", model: "claude-opus-5-5" },
    { id: "b", provider: "openai", model: "gpt-6-sol" },
    { id: "c", provider: "anthropic", model: "claude-sonnet-5-5" },
  ]);
});
