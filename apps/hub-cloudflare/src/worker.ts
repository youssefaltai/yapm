import { createHub, type Hub, type HubDb, type HubDeps, tick } from "@yapm/core";
import * as schema from "@yapm/schema";
import { drizzle } from "drizzle-orm/d1";
import { durableObjectRealtime, type LiveHub } from "./live.js";

export { LiveHub } from "./live.js";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LIVE: DurableObjectNamespace<LiveHub>;
  YAPM_VERSION?: string;
  /** Public origin, when the app is served from a custom domain behind another proxy. */
  ORIGIN?: string;
  RP_NAME?: string;
  /** Encrypts MCP sign-ins; set with `wrangler secret put YAPM_SECRET`. */
  YAPM_SECRET?: string;
}

let hub: Hub | undefined;

function depsOf(env: Env): HubDeps {
  return {
    db: drizzle(env.DB, { schema }) as unknown as HubDb,
    config: {
      platform: "cloudflare",
      version: env.YAPM_VERSION ?? "dev",
      ...(env.ORIGIN ? { origin: env.ORIGIN } : {}),
      ...(env.RP_NAME ? { rpName: env.RP_NAME } : {}),
      ...(env.YAPM_SECRET ? { secret: env.YAPM_SECRET } : {}),
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
