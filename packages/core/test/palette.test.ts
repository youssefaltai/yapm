import { describe, expect, it } from "vitest";
import { DEFAULT_STATES } from "../src/seed.js";
import { neutral } from "../src/testing/contract.js";

describe("default workflow states", () => {
  it("are neutral greys, like the rest of the palette", () => {
    for (const state of DEFAULT_STATES) expect(state.color).toSatisfy(neutral);
  });
});
