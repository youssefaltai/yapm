import { createHub, type Hub, type HubDb, type HubDeps, tick } from "@life-os/core";
import * as schema from "@life-os/schema";
import { drizzle } from "drizzle-orm/d1";
import { durableObjectRealtime, type LiveHub } from "./live.js";

export { LiveHub } from "./live.js";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LIVE: DurableObjectNamespace<LiveHub>;
  LIFE_OS_VERSION?: string;
  /** Public origin, when the app is served from a custom domain behind another proxy. */
  ORIGIN?: string;
  RP_NAME?: string;
}

let hub: Hub | undefined;

function depsOf(env: Env): HubDeps {
  return {
    db: drizzle(env.DB, { schema }) as unknown as HubDb,
    config: {
      platform: "cloudflare",
      version: env.LIFE_OS_VERSION ?? "dev",
      ...(env.ORIGIN ? { origin: env.ORIGIN } : {}),
      ...(env.RP_NAME ? { rpName: env.RP_NAME } : {}),
    },
    realtime: durableObjectRealtime(env.LIVE),
  };
}

export default {
  fetch(request, env, ctx) {
    hub ??= createHub(depsOf(env));
    return hub.fetch(request, env, ctx);
  },
  // Cycles, recurring issues and other time-based work (see the cron trigger in wrangler.jsonc).
  scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(depsOf(env), controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
