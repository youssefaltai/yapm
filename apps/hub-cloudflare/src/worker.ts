import { createHub, type Hub, type HubDb } from "@life-os/core";
import * as schema from "@life-os/schema";
import { drizzle } from "drizzle-orm/d1";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LIFE_OS_VERSION?: string;
  /** Public origin, when the app is served from a custom domain behind another proxy. */
  ORIGIN?: string;
  RP_NAME?: string;
}

let hub: Hub | undefined;

export default {
  fetch(request, env, ctx) {
    hub ??= createHub({
      db: drizzle(env.DB, { schema }) as unknown as HubDb,
      config: {
        platform: "cloudflare",
        version: env.LIFE_OS_VERSION ?? "dev",
        ...(env.ORIGIN ? { origin: env.ORIGIN } : {}),
        ...(env.RP_NAME ? { rpName: env.RP_NAME } : {}),
      },
    });
    return hub.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
