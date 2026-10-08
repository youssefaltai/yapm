import type { users } from "@life-os/schema";
import type { HubDb } from "./db.js";
import type { Realtime } from "./realtime.js";

export type User = typeof users.$inferSelect;

export interface HubConfig {
  /** Which adapter is serving the hub, reported by the health check. */
  platform: "node" | "cloudflare";
  version: string;
  /** Shown by the browser when creating a passkey. */
  rpName?: string;
  /**
   * Public origin of the web app, e.g. `https://life.example.com`. When unset, the
   * origin of each request is used, which is right whenever the hub serves the app itself.
   */
  origin?: string;
}

export interface HubDeps {
  db: HubDb;
  config: HubConfig;
  /** Clock override for tests. */
  now?: () => number;
  /** Live updates; without it, apps fall back to refetching on focus. */
  realtime?: Realtime;
}

export interface Viewer {
  user: User;
  via: "session" | "token";
}

export type HubEnv = {
  Variables: {
    deps: HubDeps;
    viewer: Viewer | null;
  };
};
