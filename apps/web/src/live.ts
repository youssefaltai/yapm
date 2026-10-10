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
    let pongTimer: ReturnType<typeof setTimeout> | undefined;

    // Batch bursts (a bulk edit is one event per request, but agents can be busy). A hidden tab
    // skips them: it refetches everything when it becomes visible.
    const refresh = () => {
      if (document.hidden) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(invalidate, 100);
    };

    const connect = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`;
      socket = new WebSocket(url);
      socket.onopen = () => {
        // Anything could have changed while disconnected, or between the first load and now.
        refresh();
        retry = 0;
      };
      socket.onmessage = (message) => {
        if (message.data === "pong") {
          clearTimeout(pongTimer);
          return;
        }
        try {
          // "runs" events are for runners, and each comes with a "change" event.
          const event = JSON.parse(String(message.data)) as {
            type?: string;
            clientId?: string | null;
          };
          if (event.type === "change" && event.clientId !== CLIENT_ID) refresh();
        } catch {
          refresh();
        }
      };
      socket.onclose = () => {
        clearTimeout(pongTimer);
        if (closed) return;
        retry++;
        reconnectTimer = setTimeout(connect, Math.min(30_000, 500 * 2 ** retry));
      };
    };
    connect();

    // Keep the connection alive through proxies that drop idle sockets, and notice when it has
    // died without closing (common on phones switching networks): no pong means reconnect.
    const ping = setInterval(() => {
      const current = socket;
      if (current?.readyState !== WebSocket.OPEN) return;
      current.send("ping");
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        if (socket !== current) return;
        current.onclose = null;
        current.close();
        retry++;
        connect();
      }, 10_000);
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
      clearTimeout(pongTimer);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
    };
  }, []);
}
