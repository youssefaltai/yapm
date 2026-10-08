import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { type HubDeps, tick } from "@life-os/core";
import { WebSocketServer } from "ws";
import { createNodeApp } from "./app.js";
import { openDatabase } from "./db.js";
import { createNodeRealtime } from "./realtime.js";

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
const deps: HubDeps = {
  db,
  config: {
    platform: "node",
    version: env.LIFE_OS_VERSION ?? "dev",
    ...(env.ORIGIN ? { origin: env.ORIGIN } : {}),
    ...(env.RP_NAME ? { rpName: env.RP_NAME } : {}),
  },
  realtime: createNodeRealtime(),
};
const app = createNodeApp(deps, webDir);

// The scheduler: cycles, rituals and other time-based work, once a minute.
const runTick = () => tick(deps).catch((error) => console.error("Scheduler tick failed", error));
setInterval(runTick, 60_000).unref();
void runTick();

serve(
  { fetch: app.fetch, port, websocket: { server: new WebSocketServer({ noServer: true }) } },
  (info) => {
    console.log(`Life OS hub listening on http://localhost:${info.port}`);
  },
);
