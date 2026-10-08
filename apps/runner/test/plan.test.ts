import { describe, expect, it } from "vitest";
import { applyRateLimit, usageFrom } from "../src/plan.js";

describe("plan readings", () => {
  const at = Date.parse("2026-10-08T12:00:00Z");

  it("reads /usage windows, per-model windows and extra usage", () => {
    const plan = usageFrom(
      {
        session: {
          total_cost_usd: 0,
          total_api_duration_ms: 0,
          total_duration_ms: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
          model_usage: {},
        },
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 37, resets_at: "2026-10-08T14:00:00Z" },
          seven_day: { utilization: 12, resets_at: null },
          seven_day_opus: null,
          model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: null }],
          extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 120,
            utilization: 2.4,
            currency: "USD",
          },
        },
        behaviors: null,
      } as unknown as Parameters<typeof usageFrom>[0],
      at,
    );
    expect(plan.available).toBe(true);
    expect(plan.limits.map((l) => [l.kind, l.utilization, l.resetsAt])).toEqual([
      ["five_hour", 37, Date.parse("2026-10-08T14:00:00Z")],
      ["seven_day", 12, null],
      ["model:Fable", 5, null],
    ]);
    expect(plan.extraUsage).toMatchObject({ enabled: true, usedCredits: 120, currency: "USD" });
  });

  it("says plan limits don't apply to an API key", () => {
    const plan = usageFrom(
      { rate_limits_available: false, rate_limits: null } as unknown as Parameters<
        typeof usageFrom
      >[0],
      at,
    );
    expect(plan).toMatchObject({ available: false, limits: [] });
  });

  it("folds a rate-limit event into one window, as a percentage", () => {
    const first = applyRateLimit(
      null,
      { status: "allowed", rateLimitType: "seven_day", utilization: 0.5, resetsAt: 1_791_500_000 },
      at,
    );
    expect(first?.limits).toEqual([
      {
        kind: "seven_day",
        label: "This week, all models",
        utilization: 50,
        resetsAt: 1_791_500_000_000,
        status: "allowed",
      },
    ]);
    // Without a type there's no window to put it in.
    expect(applyRateLimit(first, { status: "rejected" }, at)).toBe(first);
    const second = applyRateLimit(first, { status: "rejected", rateLimitType: "seven_day" }, at);
    expect(second?.limits[0]).toMatchObject({ utilization: 50, status: "rejected" });
  });
});
