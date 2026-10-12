import { createClient } from "@libsql/client";
import * as schema from "@yapm/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { expect, it } from "vitest";
import { commit, type HubDb } from "../src/db.js";
import { seedCompany } from "../src/seed.js";
import {
  approveMachine,
  enrolMachine,
  modelCatalog,
  waitingFor,
} from "../src/services/machines.js";

const migrationsFolder = decodeURIComponent(
  new URL("../../schema/migrations", import.meta.url).pathname,
);

it("forgets the pairing code once the owner has approved the machine", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const db = drizzle(createClient({ url: ":memory:" }), { schema });
  await migrate(db, { migrationsFolder });
  const hub = db as unknown as HubDb;
  await commit(
    hub,
    seedCompany(hub, { ownerId: "owner", ownerName: "Owner", companyName: "Co", now }),
  );
  const machine = await enrolMachine(hub, { name: "Laptop" }, now);
  await approveMachine({ db: hub, actorId: "owner", now }, machine.id, machine.pairingCode);
  const row = await hub
    .select()
    .from(schema.machines)
    .where(eq(schema.machines.id, machine.id))
    .get();
  expect(row?.status).toBe("active");
  expect(row?.pairingCode).toBe("");
});

it("says why a run waits: no machine online, none with its tags, none signed in to its provider", () => {
  const chatgpt = {
    id: "openai",
    name: "ChatGPT",
    models: [{ id: "gpt-6-luna", name: "GPT-6 Luna", efforts: [] }],
  };
  const mac = { tags: ["home"], engines: null, providers: null };
  const agent = { runnerTags: ["home"] };
  expect(waitingFor(agent, "openai", [])).toBe("Waiting for a machine to come online");
  expect(waitingFor({ runnerTags: ["gym", "home"] }, "openai", [mac])).toBe(
    "Waiting for a machine tagged gym, home",
  );
  // Runners before 0.7 don't list providers: with no engines they run Claude only.
  expect(waitingFor(agent, "openai", [mac])).toBe("Waiting for a machine signed in to ChatGPT");
  expect(waitingFor({ runnerTags: null }, "anthropic", [mac])).toBeNull();
  // An older runner with OpenCode runs whatever its own settings say.
  expect(waitingFor(agent, "openai", [{ ...mac, engines: ["opencode"] }])).toBeNull();
  // Newer ones say which providers they're signed in to.
  const signedIn = {
    ...mac,
    engines: ["claude" as const, "opencode" as const],
    providers: [chatgpt],
  };
  expect(waitingFor(agent, "openai", [signedIn])).toBeNull();
  expect(waitingFor(agent, "anthropic", [signedIn])).toBe(
    "Waiting for a machine signed in to Claude",
  );
  expect(waitingFor(agent, "openrouter", [signedIn])).toBe(
    "Waiting for a machine signed in to openrouter",
  );
});

it("offers the models some machine has: each provider once, Claude's known ones from older runners", () => {
  const opus = { id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "high"] };
  const luna = { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low"] };
  const sol = { id: "gpt-6-sol", name: "GPT-6 Sol", efforts: [] };
  const catalog = modelCatalog([
    {
      engines: ["claude", "opencode"],
      providers: [
        { id: "anthropic", name: "Claude", models: [opus] },
        { id: "openai", name: "ChatGPT", models: [luna] },
      ],
    },
    { engines: ["opencode"], providers: [{ id: "openai", name: "ChatGPT", models: [luna, sol] }] },
  ]);
  expect(catalog).toEqual([
    { id: "anthropic", name: "Claude", models: [opus] },
    { id: "openai", name: "ChatGPT", models: [luna, sol] },
  ]);
  // An older runner with Claude reports nothing: the models the hub knows stand in.
  const old = modelCatalog([{ engines: null, providers: null }]);
  expect(old.map((p) => p.id)).toEqual(["anthropic"]);
  expect(old[0]?.models.map((m) => m.id)).toContain("claude-opus-5-5");
  expect(modelCatalog([{ engines: ["opencode"], providers: null }])).toEqual([]);
  // Named as owners know them; a runner that couldn't list Claude's models gets the known ones.
  const named = modelCatalog([
    {
      engines: null,
      providers: [
        { id: "anthropic", name: "Claude", models: [] },
        { id: "openai", name: "OpenAI", models: [luna] },
      ],
    },
  ]);
  expect(named.map((p) => p.name)).toEqual(["Claude", "ChatGPT"]);
  expect(named[0]?.models.length).toBeGreaterThan(0);
});
