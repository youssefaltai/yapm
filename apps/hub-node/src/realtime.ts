import { upgradeWebSocket } from "@hono/node-server";
import type { HubEvent, Realtime } from "@yapm/core";
import type { WSContext } from "hono/ws";

/** Live updates for a single Node process: sockets live in memory and every event goes to all. */
export function createNodeRealtime(): Realtime & { size(): number } {
  const sockets = new Set<WSContext>();
  const upgrade = upgradeWebSocket(() => ({
    onOpen: (_event, ws) => {
      sockets.add(ws);
    },
    onClose: (_event, ws) => {
      sockets.delete(ws);
    },
    onMessage: (event, ws) => {
      // Clients ping to keep idle connections alive through proxies.
      if (event.data === "ping") ws.send("pong");
    },
  }));
  return {
    async connect(c) {
      const response = await upgrade(c, async () => {});
      return response ?? c.text("Upgrade failed", 400);
    },
    publish(event: HubEvent) {
      const message = JSON.stringify(event);
      for (const ws of sockets) {
        try {
          ws.send(message);
        } catch {
          sockets.delete(ws);
        }
      }
    },
    size: () => sockets.size,
  };
}
