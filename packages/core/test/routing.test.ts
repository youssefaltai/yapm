import { describe, expect, it } from "vitest";
import { cleanRouting, DEFAULT_ROUTING, type RouteFacts, route } from "../src/runs/routing.js";

const work = (facts: Partial<RouteFacts> = {}): RouteFacts => ({
  kind: "work",
  labels: [],
  priority: 0,
  estimate: null,
  agent: { modelFloor: "small", modelCeiling: "top", topRunsPerWeek: 3 },
  topRunsThisWeek: 0,
  ...facts,
});

const routing = { ...DEFAULT_ROUTING, labels: { research: "top", admin: "small" } } as const;

describe("model routing", () => {
  it("runs decisions on the small tier whatever else is true", () => {
    expect(route({ ...work({ priority: 1, estimate: 8 }), kind: "decision" }, routing)).toEqual({
      modelTier: "small",
      model: "claude-haiku-5-5",
      effort: "low",
      routeRule: "decision",
    });
  });

  it("keeps a resumed session on the model and effort it started with", () => {
    const resumed = route(
      work({
        resumes: { modelTier: "top", model: "claude-opus-5", effort: "xhigh" },
        labels: ["admin"],
      }),
      routing,
    );
    expect(resumed).toEqual({
      modelTier: "top",
      model: "claude-opus-5",
      effort: "xhigh",
      routeRule: "resume",
    });
  });

  it("lets the owner overrule the agent's ceiling and budget", () => {
    const owned = route(
      work({
        ownerTier: "top",
        agent: { modelFloor: "small", modelCeiling: "standard", topRunsPerWeek: 0 },
      }),
      routing,
    );
    expect(owned).toMatchObject({ modelTier: "top", routeRule: "owner" });
  });

  it("steps up one tier after a failure, once, and never drops below what failed", () => {
    const failed = { modelTier: "small", routeRule: "label:admin" };
    expect(route(work({ lastFailure: failed, labels: ["admin"] }), routing)).toMatchObject({
      modelTier: "standard",
      routeRule: "retry",
    });
    const again = { modelTier: "standard", routeRule: "retry" };
    expect(route(work({ lastFailure: again, labels: ["admin"] }), routing)).toMatchObject({
      modelTier: "standard",
      routeRule: "retry-held",
    });
    // A rule that already picks higher wins over the retry.
    expect(route(work({ lastFailure: failed, labels: ["research"] }), routing)).toMatchObject({
      modelTier: "top",
      routeRule: "label:research",
    });
    // The retry is still capped by the agent's limits.
    const capped = work({
      lastFailure: { modelTier: "standard", routeRule: "default" },
      agent: { modelFloor: "small", modelCeiling: "standard", topRunsPerWeek: 3 },
    });
    expect(route(capped, routing)).toMatchObject({
      modelTier: "standard",
      routeRule: "retry+ceiling",
    });
  });

  it("routes by the highest-tier label before the decision's request", () => {
    expect(
      route(work({ labels: ["admin", "research"], requestedTier: "small" }), routing),
    ).toMatchObject({ modelTier: "top", routeRule: "label:research" });
    expect(route(work({ labels: ["admin"], requestedTier: "top" }), routing)).toMatchObject({
      modelTier: "small",
      routeRule: "label:admin",
    });
  });

  it("gives urgent, large issues the top tier", () => {
    expect(route(work({ priority: 1, estimate: 5 }), routing)).toMatchObject({
      modelTier: "top",
      routeRule: "urgent-large",
    });
    expect(route(work({ priority: 2, estimate: 8 }), routing)).toMatchObject({
      modelTier: "standard",
      routeRule: "default",
    });
  });

  it("takes the decision's request, then caps it to the agent's limits", () => {
    expect(route(work({ requestedTier: "small" }), routing)).toMatchObject({
      modelTier: "small",
      model: "claude-haiku-5-5",
      routeRule: "requested",
    });
    const capped = work({
      requestedTier: "top",
      agent: { modelFloor: "small", modelCeiling: "standard", topRunsPerWeek: 3 },
    });
    expect(route(capped, routing)).toMatchObject({
      modelTier: "standard",
      routeRule: "requested+ceiling",
    });
    const floored = work({
      requestedTier: "small",
      agent: { modelFloor: "standard", modelCeiling: "top", topRunsPerWeek: 3 },
    });
    expect(route(floored, routing)).toMatchObject({
      modelTier: "standard",
      routeRule: "requested+floor",
    });
  });

  it("drops to standard once the agent's weekly top-tier budget is spent", () => {
    expect(route(work({ requestedTier: "top", topRunsThisWeek: 3 }), routing)).toEqual({
      modelTier: "standard",
      model: "claude-opus-5-5",
      effort: "medium",
      routeRule: "requested+budget",
    });
  });

  it("checks the routing the owner saves", () => {
    expect(
      cleanRouting({
        tiers: { standard: { model: "claude-sonnet-5-5", effort: "medium" } },
        labels: { " Research ": "top" },
      }),
    ).toEqual({
      tiers: {
        ...DEFAULT_ROUTING.tiers,
        standard: { model: "claude-sonnet-5-5", effort: "medium" },
      },
      labels: { research: "top" },
    });
    expect(() => cleanRouting({ tiers: { top: { model: "gpt-5", effort: "high" } } })).toThrow(
      /Claude model id/,
    );
    expect(() =>
      cleanRouting({ tiers: { top: { model: "claude-opus-5-5", effort: "huge" } } }),
    ).toThrow(/effort/);
    expect(() => cleanRouting({ labels: { research: "giant" } })).toThrow(/small, standard or top/);
  });
});
