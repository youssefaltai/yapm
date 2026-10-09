import { describe, expect, it } from "vitest";
import { DEFAULT_STATES } from "../src/seed.js";
import { neutral } from "../src/testing/contract.js";

describe("default workflow states", () => {
  it("use Linear's colours, so statuses read at a glance", () => {
    const color = (name: string) => DEFAULT_STATES.find((s) => s.name === name)?.color ?? "";
    for (const name of ["Triage", "In Progress", "In Review", "Done"]) {
      expect(color(name)).not.toSatisfy(neutral);
    }
  });
});
