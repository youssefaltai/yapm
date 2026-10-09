import { DurableObject } from "cloudflare:workers";
import type { HubEvent, Realtime } from "@life-os/core";
import type { Env } from "./worker.js";

/**
 * One Durable Object holds every live connection. It uses the hibernation API, so
 * idle sockets cost nothing on the free plan; it wakes only to fan out an event.
 * The Worker authenticates each connection before forwarding it here.
 */
export class LiveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer the apps' keep-alive pings without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/publish") {
      const message = await request.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // A socket closing mid-send is cleaned up by webSocketClose.
        }
      }
      return new Response(null, { status: 204 });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    ws.close(code === 1005 ? 1000 : code);
  }
}

export function durableObjectRealtime(namespace: DurableObjectNamespace<LiveHub>): Realtime {
  const hub = () => namespace.get(namespace.idFromName("live"));
  return {
    connect: (c) => hub().fetch(c.req.raw),
    async publish(event: HubEvent) {
      await hub().fetch("https://live/publish", { method: "POST", body: JSON.stringify(event) });
    },
  };
}
