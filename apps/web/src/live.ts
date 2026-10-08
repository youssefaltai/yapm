import { useEffect } from "react";
import { CLIENT_ID } from "./api.js";
import { invalidate } from "./data.js";

/**
 * Keeps every view current: the hub says "something changed" over a WebSocket after
 * any mutation, by the owner in another tab or by an agent, and the app refetches.
 */
export function useLiveUpdates() {
  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    // Batch bursts (a bulk edit is one event per request, but agents can be busy).
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(invalidate, 100);
    };

    const connect = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`;
      socket = new WebSocket(url);
      socket.onopen = () => {
        // Anything could have changed while disconnected.
        if (retry > 0) refresh();
        retry = 0;
      };
      socket.onmessage = (message) => {
        if (message.data === "pong") return;
        try {
          const event = JSON.parse(String(message.data)) as { clientId?: string | null };
          if (event.clientId !== CLIENT_ID) refresh();
        } catch {
          refresh();
        }
      };
      socket.onclose = () => {
        if (closed) return;
        retry++;
        reconnectTimer = setTimeout(connect, Math.min(30_000, 500 * 2 ** retry));
      };
    };
    connect();

    // Keep the connection alive through proxies that drop idle sockets.
    const ping = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    }, 30_000);

    // Phones suspend background tabs; catch up when the app comes back.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(reconnectTimer);
      clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
    };
  }, []);
}
