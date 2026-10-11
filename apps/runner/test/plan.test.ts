import { describe, expect, it } from "vitest";
import { applyRateLimit, PlanTracker, planFromHeaders, usageFrom } from "../src/plan.js";

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

  it("reads a ChatGPT plan's windows off a response's headers", () => {
    // As a real ChatGPT Plus response sends them.
    const plan = planFromHeaders(
      {
        "x-codex-plan-type": "plus",
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1791766345",
        "x-codex-secondary-used-percent": "3.5",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": "1792353145",
        "x-codex-credits-has-credits": "False",
      },
      at,
    );
    expect(plan).toEqual({
      provider: "chatgpt",
      name: "plus",
      usage: {
        observedAt: at,
        source: "rate_limit",
        available: true,
        limits: [
          {
            kind: "five_hour",
            label: "Current session (5 hours)",
            utilization: 12,
            resetsAt: 1_791_766_345_000,
            status: null,
          },
          {
            kind: "seven_day",
            label: "This week",
            utilization: 3.5,
            resetsAt: 1_792_353_145_000,
            status: null,
          },
        ],
        extraUsage: null,
      },
    });
  });

  it("keeps a ChatGPT window it can't name, and leaves out what wasn't said", () => {
    const plan = planFromHeaders(
      { "x-codex-primary-window-minutes": "60", "x-codex-primary-reset-at": "1791766345" },
      at,
    );
    expect(plan?.name).toBeNull();
    // A missing percentage isn't 0%.
    expect(plan?.usage.limits).toEqual([
      {
        kind: "window:60",
        label: "60 minutes",
        utilization: null,
        resetsAt: 1_791_766_345_000,
        status: null,
      },
    ]);
  });

  it("reads Copilot's premium requests for the month", () => {
    const plan = planFromHeaders(
      {
        "x-quota-snapshot-chat": "ent=-1&ov=0.0&ovPerm=false&rem=100&rst=2026-11-01T00:00:00Z",
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=72.5&rst=2026-11-01T00:00:00Z",
      },
      at,
    );
    expect(plan).toEqual({
      provider: "copilot",
      name: null,
      usage: {
        observedAt: at,
        source: "rate_limit",
        available: true,
        limits: [
          {
            kind: "monthly",
            label: "Premium requests this month",
            utilization: 27.5,
            resetsAt: Date.parse("2026-11-01T00:00:00Z"),
            status: null,
          },
        ],
        extraUsage: null,
      },
    });
    // Unlimited premium requests have no window to fill.
    expect(
      planFromHeaders({ "x-quota-snapshot-premium_models": "ent=-1&rem=100&rst=" }, at)?.usage
        .limits,
    ).toEqual([]);
    expect(planFromHeaders({ "content-type": "text/event-stream" }, at)).toBeNull();
  });

  it("sends an OpenCode plan's newest reading once", () => {
    const tracker = new PlanTracker();
    const chatgpt = planFromHeaders({ "x-codex-primary-used-percent": "5" }, at);
    if (!chatgpt) throw new Error("no plan");
    tracker.update({ plan: chatgpt }, at);
    const report = tracker.pending();
    expect(report).toEqual({ plans: [chatgpt] });
    tracker.sent(report);
    expect(tracker.pending()).toEqual({});
  });
});
