import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import type { HubDb } from "@yapm/core";
import * as schema from "@yapm/schema";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

/** The schema package's migrations; same relative path from `src/` and `dist/`. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/schema/migrations", import.meta.url),
);

export async function openDatabase(url: string, migrationsFolder = DEFAULT_MIGRATIONS_DIR) {
  const client = createClient({ url });
  // WAL lets the web app read while agents write; foreign keys are on, as D1 enforces them.
  if (url.startsWith("file:")) await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as HubDb, client };
}
