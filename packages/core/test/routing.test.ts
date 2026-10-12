import type { MachineProvider } from "@yapm/schema";
import { describe, expect, it } from "vitest";
import {
  cleanRouting,
  cleanTiers,
  DEFAULT_ROUTING,
  type RouteFacts,
  route,
} from "../src/runs/routing.js";

const work = (facts: Partial<RouteFacts> = {}): RouteFacts => ({
  kind: "work",
  labels: [],
  priority: 0,
  estimate: null,
  agent: { topRunsPerWeek: 3 },
  topRunsThisWeek: 0,
  ...facts,
});

const routing = { ...DEFAULT_ROUTING, labels: { research: "top", admin: "small" } } as const;
const claude = (model: string, effort: string) => ({ provider: "anthropic", model, effort });

/** A machine signed in to ChatGPT, which names its own efforts per model, and Claude. */
const catalog: MachineProvider[] = [
  {
    id: "anthropic",
    name: "Claude",
    models: [{ id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "medium", "high"] }],
  },
  {
    id: "openai",
    name: "ChatGPT",
    models: [
      { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["minimal", "low", "high"] },
      { id: "gpt-6-plain", name: "GPT-6 Plain", efforts: [] },
    ],
  },
];

describe("model routing", () => {
  it("runs decisions on the small tier whatever else is true", () => {
    expect(route({ ...work({ priority: 1, estimate: 8 }), kind: "decision" }, routing)).toEqual({
      modelTier: "small",
      ...claude("claude-sonnet-5-5", "medium"),
      routeRule: "decision",
    });
  });

  it("mixes providers across tiers: each tier runs where its model is", () => {
    const mixed = {
      ...routing,
      tiers: {
        ...routing.tiers,
        small: { provider: "openai", model: "gpt-6-luna", effort: "low" },
      },
    };
    expect(route({ ...work(), kind: "decision" }, mixed)).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      effort: "low",
    });
    expect(route(work(), mixed)).toMatchObject(claude("claude-opus-5-5", "medium"));
  });

  it("keeps a resumed session on the provider, model and effort it started with", () => {
    const resumed = route(
      work({
        resumes: { modelTier: "top", provider: "openai", model: "gpt-6-sol", effort: null },
        labels: ["admin"],
      }),
      routing,
    );
    expect(resumed).toEqual({
      modelTier: "top",
      provider: "openai",
      model: "gpt-6-sol",
      effort: null,
      routeRule: "resume",
    });
  });

  it("lets the owner overrule the agent's budget", () => {
    const owned = route(
      work({ ownerTier: "top", agent: { topRunsPerWeek: 0 }, topRunsThisWeek: 0 }),
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

  it("takes the decision's request", () => {
    expect(route(work({ requestedTier: "small" }), routing)).toMatchObject({
      modelTier: "small",
      model: "claude-sonnet-5-5",
      routeRule: "requested",
    });
  });

  it("drops to standard once the agent's weekly top-tier budget is spent", () => {
    expect(route(work({ requestedTier: "top", topRunsThisWeek: 3 }), routing)).toEqual({
      modelTier: "standard",
      ...claude("claude-opus-5-5", "medium"),
      routeRule: "requested+budget",
    });
  });

  it("checks the routing the owner saves", () => {
    expect(
      cleanRouting(
        {
          tiers: { standard: { model: "claude-sonnet-5-5", effort: "medium" } },
          labels: { " Research ": "top" },
        },
        catalog,
      ),
    ).toEqual({
      tiers: { ...DEFAULT_ROUTING.tiers, standard: claude("claude-sonnet-5-5", "medium") },
      labels: { research: "top" },
    });
    expect(() =>
      cleanRouting({ tiers: { top: { model: "gpt-5", effort: "high" } } }, catalog),
    ).toThrow(/Claude model id/);
    expect(() =>
      cleanRouting({ tiers: { top: { model: "claude-opus-5-5", effort: "huge" } } }, catalog),
    ).toThrow(/effort/);
    expect(() => cleanRouting({ labels: { research: "giant" } }, catalog)).toThrow(
      /small, standard or top/,
    );
  });

  it("takes another provider's model only when a machine has it, at an effort it supports", () => {
    const tiers = (small: Record<string, unknown>) =>
      cleanTiers({ small }, DEFAULT_ROUTING.tiers, catalog);
    expect(tiers({ provider: "openai", model: "gpt-6-luna", effort: "minimal" }).small).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      effort: "minimal",
    });
    // A model with no effort levels takes none.
    expect(tiers({ provider: "openai", model: "gpt-6-plain", effort: null }).small.effort).toBe(
      null,
    );
    expect(() => tiers({ provider: "openai", model: "gpt-6-plain", effort: "high" })).toThrow(
      /has no effort levels/,
    );
    expect(() => tiers({ provider: "openai", model: "gpt-6-luna", effort: "max" })).toThrow(
      /minimal, low, high/,
    );
    expect(() => tiers({ provider: "deepseek", model: "deepseek-v4", effort: null })).toThrow(
      /No machine has deepseek\/deepseek-v4/,
    );
    // Claude models check against the machines' list when they report one.
    expect(() => tiers({ provider: "anthropic", model: "claude-opus-5-5", effort: "max" })).toThrow(
      /low, medium, high/,
    );
  });
});
