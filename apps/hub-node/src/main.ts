import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { type HubDeps, tick } from "@yapm/core";
import { WebSocketServer } from "ws";
import { configWarnings, createNodeApp } from "./app.js";
import { openDatabase } from "./db.js";
import { publicFetch } from "./public-fetch.js";
import { createNodeRealtime } from "./realtime.js";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const databaseUrl = env.DATABASE_URL ?? "file:./data/yapm.db";
const webDir = env.WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
for (const warning of configWarnings(env)) console.warn(`Warning: ${warning}`);

if (databaseUrl.startsWith("file:")) {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(databaseUrl.slice("file:".length)), { recursive: true });
}

const { db } = await openDatabase(databaseUrl, env.MIGRATIONS_DIR);
const deps: HubDeps = {
  db,
  config: {
    platform: "node",
    version: env.YAPM_VERSION ?? "dev",
    ...(env.ORIGIN ? { origin: env.ORIGIN } : {}),
    ...(env.RP_NAME ? { rpName: env.RP_NAME } : {}),
    ...(env.YAPM_SECRET ? { secret: env.YAPM_SECRET } : {}),
  },
  realtime: createNodeRealtime(),
  fetch: publicFetch,
};
const app = createNodeApp(deps, webDir);

// The scheduler: cycles, recurring issues and other time-based work, once a minute.
const runTick = () => tick(deps).catch((error) => console.error("Scheduler tick failed", error));
setInterval(runTick, 60_000).unref();
void runTick();

serve(
  { fetch: app.fetch, port, websocket: { server: new WebSocketServer({ noServer: true }) } },
  (info) => {
    console.log(`yapm hub listening on http://localhost:${info.port}`);
  },
);
