import { describe, expect, it } from "vitest";
import { open, seal } from "../src/crypto.js";

describe("sealed secrets", () => {
  it("round-trips under the hub's secret and nothing else", async () => {
    const sealed = await seal("hub secret", "xoxb-123");
    expect(sealed).not.toContain("xoxb");
    expect(await open("hub secret", sealed)).toBe("xoxb-123");
    await expect(open("another secret", sealed)).rejects.toThrow();
  });

  it("refuses to store one without LIFE_OS_SECRET", async () => {
    await expect(seal(undefined, "xoxb-123")).rejects.toThrow(/LIFE_OS_SECRET/);
  });
});
