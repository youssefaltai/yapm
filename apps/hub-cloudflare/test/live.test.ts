import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// The runtime refuses to send the codes that only describe a close (1005, 1006, 1015).
const socket = () => {
  const sent: number[] = [];
  return {
    sent,
    close(code: number) {
      if ([1005, 1006, 1015].includes(code))
        throw new TypeError(`Invalid WebSocket close code: ${code}.`);
      sent.push(code);
    },
  } as unknown as WebSocket & { sent: number[] };
};

it("closes a socket that dropped without a close frame", async () => {
  const stub = env.LIVE.get(env.LIVE.idFromName("live"));
  await runInDurableObject(stub, async (hub) => {
    for (const [code, reply] of [
      [1006, 1000],
      [1005, 1000],
      [1001, 1001],
    ]) {
      const ws = socket();
      await hub.webSocketClose(ws, code as number);
      expect(ws.sent).toEqual([reply]);
    }
  });
});
