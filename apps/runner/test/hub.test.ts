import { describe, expect, it } from "vitest";
import { HubClient } from "../src/hub.js";

describe("hub client", () => {
  it("gives up on a call the hub doesn't answer, and tries again", async () => {
    let tries = 0;
    const hub = new HubClient(
      "http://hub",
      (_input, init) =>
        new Promise((_resolve, reject) => {
          tries++;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { timeoutMs: 10, retryMs: 1 },
    );
    await expect(hub.me("t")).rejects.toThrow(/timeout/);
    expect(tries).toBe(4);
  });

  it("tries again after a blip, but not when the hub refuses", async () => {
    const answers = [502, 429, 200, 403];
    const hub = new HubClient(
      "http://hub",
      async () => {
        const status = answers.shift() ?? 500;
        return new Response(JSON.stringify(status === 200 ? { id: "m" } : { error: "No" }), {
          status,
        });
      },
      { retryMs: 1 },
    );
    expect(await hub.me("t")).toEqual({ id: "m" });
    await expect(hub.me("t")).rejects.toThrow("No");
    expect(answers).toEqual([]);
  });
});
