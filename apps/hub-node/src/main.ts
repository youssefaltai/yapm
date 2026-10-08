import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createNodeApp } from "./app.js";
import { openDatabase } from "./db.js";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const databaseUrl = env.DATABASE_URL ?? "file:./data/life-os.db";
const webDir = env.WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

if (databaseUrl.startsWith("file:")) {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(databaseUrl.slice("file:".length)), { recursive: true });
}

const { db } = await openDatabase(databaseUrl, env.MIGRATIONS_DIR);
const app = createNodeApp(
  {
    db,
    config: {
      platform: "node",
      version: env.LIFE_OS_VERSION ?? "dev",
      ...(env.ORIGIN ? { origin: env.ORIGIN } : {}),
      ...(env.RP_NAME ? { rpName: env.RP_NAME } : {}),
    },
  },
  webDir,
);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Life OS hub listening on http://localhost:${info.port}`);
});
