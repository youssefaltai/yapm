import { createClient } from "@libsql/client";
import * as schema from "@yapm/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { expect, it } from "vitest";
import { commit, type HubDb } from "../src/db.js";
import { seedCompany } from "../src/seed.js";
import { approveMachine, enrolMachine, waitingFor } from "../src/services/machines.js";

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

it("says why an agent's run waits: no machine online, none with its tags, none with its engine", () => {
  const mac = { tags: ["home"], engines: null };
  const agent = { engine: "opencode" as const, runnerTags: ["home"] };
  expect(waitingFor(agent, [])).toBe("Waiting for a machine to come online");
  expect(waitingFor({ ...agent, runnerTags: ["gym", "home"] }, [mac])).toBe(
    "Waiting for a machine tagged gym, home",
  );
  // Older runners don't say which engines they have: Claude only.
  expect(waitingFor(agent, [mac])).toBe("Waiting for a machine that runs OpenCode");
  expect(waitingFor(agent, [mac, { tags: ["home"], engines: ["opencode"] }])).toBeNull();
  expect(waitingFor({ engine: "claude", runnerTags: null }, [mac])).toBeNull();
});
