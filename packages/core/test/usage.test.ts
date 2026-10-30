import { describe, expect, it } from "vitest";
import { cleanPlanUsage, ownUsage } from "../src/services/usage.js";

describe("ownUsage", () => {
  it("takes the resumed run's totals off a session that carried them on", () => {
    expect(
      ownUsage(
        { inputTokens: 1500, outputTokens: 120, costUsd: 0.9 },
        { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 },
      ),
    ).toEqual({ inputTokens: 500, outputTokens: 20, costUsd: expect.closeTo(0.4) });
  });

  it("keeps totals that started afresh", () => {
    const reported = { inputTokens: 300, outputTokens: 20, costUsd: 0.1 };
    expect(ownUsage(reported, { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 })).toEqual(
      reported,
    );
    expect(ownUsage(reported, null)).toEqual(reported);
  });
});

describe("cleanPlanUsage", () => {
  const at = Date.parse("2026-10-08T12:00:00Z");

  it("refuses readings without a time and clamps readings from the future", () => {
    expect(cleanPlanUsage({ limits: [] }, at)).toBeNull();
    expect(cleanPlanUsage({ observedAt: at + 60_000, limits: [] }, at)?.observedAt).toBe(at);
  });

  it("keeps one entry per kind, with percentages in range", () => {
    const plan = cleanPlanUsage(
      {
        observedAt: at,
        limits: [
          { kind: "five_hour", utilization: -5, resetsAt: "2026-10-08T15:00:00Z" },
          { kind: "five_hour", utilization: 50 },
          { kind: "seven_day", utilization: "lots" },
        ],
      },
      at,
    );
    expect(plan?.limits).toEqual([
      {
        kind: "five_hour",
        label: "five_hour",
        utilization: 0,
        resetsAt: Date.parse("2026-10-08T15:00:00Z"),
        status: null,
      },
      { kind: "seven_day", label: "seven_day", utilization: null, resetsAt: null, status: null },
    ]);
  });
});
