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
  /** `LIFE_OS_SECRET`: encrypts the MCP sign-ins the hub keeps. Without it, it keeps none. */
  secret?: string;
}

export interface HubDeps {
  db: HubDb;
  config: HubConfig;
  /** Clock override for tests. */
  now?: () => number;
  /** Live updates; without it, apps fall back to refetching on focus. */
  realtime?: Realtime;
  /** Outgoing HTTP, e.g. to push services; tests replace it. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface Viewer {
  user: User;
  via: "session" | "token";
  /** Set when the token was minted for one agent run; its changes are attributed to the run. */
  runId?: string;
}

export type HubEnv = {
  Variables: {
    deps: HubDeps;
    viewer: Viewer | null;
  };
};
