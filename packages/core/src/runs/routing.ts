import {
  EFFORTS,
  issueLabels,
  issues,
  labels,
  type MachineProvider,
  MODEL_TIERS,
  type ModelRouting,
  type ModelTier,
  type ModelTiers,
  runs,
  type TierModel,
  users,
  workspaces,
} from "@yapm/schema";
import { and, count, desc, eq, gte, ne } from "drizzle-orm";
import type { HubDb } from "../db.js";
import { badRequest, notFound } from "../errors.js";

// Which model and effort a run gets is decided here, by rules, never by a model. The decision
// step may ask for a tier; the rules and the agent's weekly top-tier budget decide. Each tier is a
// provider's model: the company's, or the agent's own.

/**
 * Starting points: Sonnet 5.5 at medium effort for decisions and small work, since a decision
 * gates everything after it and Haiku at low effort misread plain events; Opus 5.5 at its
 * default medium for most agentic work, which measured cheaper per solved task than smaller
 * models; high for hard problems. Tune them per company from the route metrics on the Insights
 * page.
 */
export const DEFAULT_ROUTING: ModelRouting = {
  tiers: {
    small: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
    standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
    top: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  },
  labels: {},
};

const rank = (tier: ModelTier) => MODEL_TIERS.indexOf(tier);
const byRank = (i: number): ModelTier =>
  MODEL_TIERS[Math.min(Math.max(i, 0), MODEL_TIERS.length - 1)] ?? "standard";
const isTier = (v: unknown): v is ModelTier => MODEL_TIERS.includes(v as ModelTier);

/** What the rules look at. Everything here is data the hub already has. */
export interface RouteFacts {
  kind: "decision" | "work";
  /** The paused run this one continues: it keeps its model, so its cache and thinking hold. */
  resumes?: {
    modelTier: string;
    provider: string | null;
    model: string | null;
    effort: string | null;
  } | null;
  /** The owner picked a tier when starting the run. */
  ownerTier?: ModelTier | null;
  /** The decision step's request. */
  requestedTier?: ModelTier | null;
  /** Lowercase names of the issue's labels. */
  labels: string[];
  /** 1 urgent … 4 low, 0 none. */
  priority: number;
  estimate: number | null;
  /** The latest earlier work run on the issue, when it failed. */
  lastFailure?: { modelTier: string; routeRule: string | null } | null;
  agent: { topRunsPerWeek: number };
  /** Top-tier work runs this agent started in the last 7 days. */
  topRunsThisWeek: number;
}

export interface Route extends TierModel {
  modelTier: ModelTier;
  /** Which rule chose it, e.g. `label:research`, plus `+budget` when capped. */
  routeRule: string;
}

/** Large and urgent work gets the top tier. */
const LARGE_ESTIMATE = 5;

/** The ordered rules: the first that matches picks the tier, then the agent's budget applies. */
export function route(facts: RouteFacts, routing: ModelRouting): Route {
  const pick = (tier: ModelTier, rule: string): Route => ({
    modelTier: tier,
    ...routing.tiers[tier],
    routeRule: rule,
  });
  if (facts.kind === "decision") return pick("small", "decision");
  const resumed = facts.resumes;
  if (resumed) {
    const tier = isTier(resumed.modelTier) ? resumed.modelTier : "standard";
    const base = pick(tier, "resume");
    if (!resumed.model) return base;
    return {
      ...base,
      provider: resumed.provider ?? "anthropic",
      model: resumed.model,
      effort: resumed.effort,
    };
  }
  // The owner is the one person who may overrule the agent's budget.
  if (facts.ownerTier) return pick(facts.ownerTier, "owner");

  let tier: ModelTier = "standard";
  let rule = "default";
  const failed = facts.lastFailure;
  const labelTiers = facts.labels
    .map((name) => [name, routing.labels[name]] as const)
    .filter((entry): entry is readonly [string, ModelTier] => isTier(entry[1]))
    .sort((a, b) => rank(b[1]) - rank(a[1]) || a[0].localeCompare(b[0]));
  if (labelTiers[0]) {
    [, tier] = labelTiers[0];
    rule = `label:${labelTiers[0][0]}`;
  } else if (facts.priority === 1 && (facts.estimate ?? 0) >= LARGE_ESTIMATE) {
    tier = "top";
    rule = "urgent-large";
  } else if (facts.requestedTier) {
    tier = facts.requestedTier;
    rule = "requested";
  }
  if (failed) {
    // After a failure, one step up from the tier that failed, once; after that, never below it.
    const failedTier = isTier(failed.modelTier) ? failed.modelTier : "standard";
    const retried = failed.routeRule?.startsWith("retry") ?? false;
    const least = retried ? failedTier : byRank(rank(failedTier) + 1);
    if (rank(least) > rank(tier)) {
      tier = least;
      rule = retried ? "retry-held" : "retry";
    }
  }

  if (tier === "top" && facts.topRunsThisWeek >= facts.agent.topRunsPerWeek) {
    tier = "standard";
    rule += "+budget";
  }
  return pick(tier, rule);
}

/** The company's routing, or the defaults. */
export async function loadRouting(db: HubDb): Promise<ModelRouting> {
  const company = await db.select({ routing: workspaces.modelRouting }).from(workspaces).get();
  return company?.routing ?? DEFAULT_ROUTING;
}

/** The agent's own tiers, or the company's. */
export async function loadTiers(db: HubDb, agentId: string): Promise<ModelTiers> {
  const [routing, agent] = await Promise.all([
    loadRouting(db),
    db.select({ models: users.models }).from(users).where(eq(users.id, agentId)).get(),
  ]);
  return agent?.models ?? routing.tiers;
}

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const MODEL = /^[\w.:/@-]{1,120}$/;

/**
 * Checks tiers the owner sends against the models machines have: a provider's model and an
 * effort it supports. Tiers left out keep `base`'s. Claude's models may also be named before any
 * machine lists them, as older runners don't; anything else is an error, never a guess.
 */
export function cleanTiers(value: unknown, base: ModelTiers, catalog: MachineProvider[]) {
  const tiersIn = (value ?? {}) as Record<string, Partial<Record<keyof TierModel, unknown>>>;
  const tiers = {} as ModelTiers;
  for (const tier of MODEL_TIERS) {
    const entry = tiersIn[tier] ?? base[tier];
    const provider = typeof entry.provider === "string" ? entry.provider : "anthropic";
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    const effort = typeof entry.effort === "string" ? entry.effort : null;
    if (!PROVIDER.test(provider) || !MODEL.test(model))
      throw badRequest(`The ${tier} tier needs a provider and a model`);
    const known = catalog.find((p) => p.id === provider)?.models.find((m) => m.id === model);
    const efforts = known?.efforts ?? (provider === "anthropic" ? [...EFFORTS] : null);
    if (!efforts) {
      throw badRequest(
        `No machine has ${provider}/${model}; sign a machine in to it first (the ${tier} tier)`,
      );
    }
    if (provider === "anthropic" && !known && !/^claude-[a-z0-9.-]+$/.test(model))
      throw badRequest(`The ${tier} tier needs a Claude model id, e.g. claude-opus-5-5`);
    if (!efforts.length && effort !== null)
      throw badRequest(`${model} has no effort levels (the ${tier} tier)`);
    if (efforts.length && !efforts.includes(effort ?? ""))
      throw badRequest(`The ${tier} tier's effort is one of ${efforts.join(", ")}`);
    tiers[tier] = { provider, model, effort };
  }
  return tiers;
}

/** Checks routing the owner sends; tiers left out take the hub's defaults. */
export function cleanRouting(value: unknown, catalog: MachineProvider[]): ModelRouting {
  const v = (value ?? {}) as Partial<Record<keyof ModelRouting, unknown>>;
  const tiers = cleanTiers(v.tiers, DEFAULT_ROUTING.tiers, catalog);
  const labelsIn = (v.labels ?? {}) as Record<string, unknown>;
  if (Object.keys(labelsIn).length > 100) throw badRequest("Route at most 100 labels");
  const labelsOut: Record<string, ModelTier> = {};
  for (const [name, tier] of Object.entries(labelsIn)) {
    const key = name.trim().toLowerCase();
    if (!key || key.length > 60) throw badRequest("Label names are 1–60 characters");
    if (!isTier(tier)) throw badRequest(`Label "${name}" routes to small, standard or top`);
    labelsOut[key] = tier;
  }
  return { tiers, labels: labelsOut };
}

const WEEK = 7 * 86_400_000;

/**
 * Routes a run about to be queued, on the agent's own tiers or the company's. A decision reads
 * only those; a fresh work run also reads its issue, the issue's last work run and the budget.
 */
export async function routeRun(
  db: HubDb,
  run: {
    kind: "decision" | "work";
    agentId: string;
    issueId: string | null;
    resumes?: RouteFacts["resumes"];
    ownerTier?: ModelTier | null;
    requestedTier?: ModelTier | null;
  },
  at: number,
): Promise<Route> {
  const [routing, agent] = await Promise.all([
    loadRouting(db),
    db
      .select({ models: users.models, topRunsPerWeek: users.topRunsPerWeek })
      .from(users)
      .where(eq(users.id, run.agentId))
      .get(),
  ]);
  if (!agent) throw notFound("Agent");
  const facts: RouteFacts = {
    kind: run.kind,
    resumes: run.resumes ?? null,
    ownerTier: run.ownerTier ?? null,
    requestedTier: run.requestedTier ?? null,
    labels: [],
    priority: 0,
    estimate: null,
    agent,
    topRunsThisWeek: 0,
  };
  if (run.kind === "work" && !run.resumes && !run.ownerTier) {
    const [issue, names, last, top] = await Promise.all([
      run.issueId
        ? db
            .select({ priority: issues.priority, estimate: issues.estimate })
            .from(issues)
            .where(eq(issues.id, run.issueId))
            .get()
        : undefined,
      run.issueId
        ? db
            .select({ name: labels.name })
            .from(issueLabels)
            .innerJoin(labels, eq(labels.id, issueLabels.labelId))
            .where(eq(issueLabels.issueId, run.issueId))
            .all()
        : [],
      run.issueId
        ? db
            .select({ status: runs.status, modelTier: runs.modelTier, routeRule: runs.routeRule })
            .from(runs)
            .where(
              and(
                eq(runs.issueId, run.issueId),
                eq(runs.agentId, run.agentId),
                eq(runs.kind, "work"),
              ),
            )
            .orderBy(desc(runs.createdAt))
            .get()
        : undefined,
      db
        .select({ n: count() })
        .from(runs)
        .where(
          and(
            eq(runs.agentId, run.agentId),
            eq(runs.kind, "work"),
            eq(runs.modelTier, "top"),
            ne(runs.status, "canceled"),
            gte(runs.createdAt, at - WEEK),
          ),
        )
        .get(),
    ]);
    facts.priority = issue?.priority ?? 0;
    facts.estimate = issue?.estimate ?? null;
    facts.labels = names.map((l) => l.name.toLowerCase());
    facts.lastFailure = last?.status === "failed" ? last : null;
    facts.topRunsThisWeek = top?.n ?? 0;
  }
  return route(facts, { ...routing, tiers: agent.models ?? routing.tiers });
}
