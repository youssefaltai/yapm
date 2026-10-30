import type { Context } from "hono";
import type { HubEnv } from "./context.js";

/**
 * Tells connected apps and runners that something changed, so they refetch.
 * Events are deliberately small: who changed what, never the data itself, so a
 * subscriber always reads current state through the API and its permissions.
 */
export type HubEvent =
  | {
      type: "change";
      actorId: string;
      /** The tab or runner that made the change, so it can skip its own echo. */
      clientId: string | null;
      at: number;
    }
  /** Runs were queued or asked to stop: runners should check in. */
  | { type: "runs"; at: number };

/** Live updates over WebSockets. Node keeps sockets in process; Cloudflare uses a Durable Object. */
export interface Realtime {
  /** Accepts an authenticated WebSocket upgrade request. */
  connect(c: Context<HubEnv>): Response | Promise<Response>;
  publish(event: HubEvent): void | Promise<void>;
}

export const CLIENT_ID_HEADER = "x-yapm-client";

/** Publishes an event; a failed broadcast never fails the change it reports. */
export async function announce(realtime: Realtime | undefined, event: HubEvent) {
  try {
    await realtime?.publish(event);
  } catch (error) {
    console.error("Live update failed", error);
  }
}
