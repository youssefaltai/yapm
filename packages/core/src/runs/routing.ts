import {
  EFFORTS,
  type Effort,
  issueLabels,
  issues,
  labels,
  MODEL_TIERS,
  type ModelRouting,
  type ModelTier,
  runs,
  users,
  workspaces,
} from "@life-os/schema";
import { and, count, desc, eq, gte, ne } from "drizzle-orm";
import type { HubDb } from "../db.js";
import { badRequest, notFound } from "../errors.js";

// Which model and effort a run gets is decided here, by rules, never by a model. The decision
// step may ask for a tier; the rules, the agent's limits and its weekly top-tier budget decide.

/**
 * Starting points from Anthropic's published guidance (October 2026): Haiku 5.5 at low effort
 * for short, simple, high-volume calls; Opus 5.5 at its default medium for most agentic work,
 * which measured cheaper per solved task than smaller models; high for hard problems. Tune them
 * per company from the route metrics on the Insights page.
 */
export const DEFAULT_ROUTING: ModelRouting = {
  tiers: {
    small: { model: "claude-haiku-5-5", effort: "low" },
    standard: { model: "claude-opus-5-5", effort: "medium" },
    top: { model: "claude-opus-5-5", effort: "high" },
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
  resumes?: { modelTier: string; model: string | null; effort: string | null } | null;
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
  agent: { modelFloor: ModelTier; modelCeiling: ModelTier; topRunsPerWeek: number };
  /** Top-tier work runs this agent started in the last 7 days. */
  topRunsThisWeek: number;
}

export interface Route {
  modelTier: ModelTier;
  model: string;
  effort: Effort;
  /** Which rule chose it, e.g. `label:research`, plus `+ceiling` or `+budget` when capped. */
  routeRule: string;
}

/** Large and urgent work gets the top tier. */
const LARGE_ESTIMATE = 5;

/** The ordered rules: the first that matches picks the tier, then the agent's limits apply. */
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
    return {
      ...base,
      model: resumed.model ?? base.model,
      effort: EFFORTS.includes(resumed.effort as Effort) ? (resumed.effort as Effort) : base.effort,
    };
  }
  // The owner is the one person who may overrule the agent's limits.
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

  const { modelFloor, modelCeiling, topRunsPerWeek } = facts.agent;
  if (rank(tier) > rank(modelCeiling)) {
    tier = modelCeiling;
    rule += "+ceiling";
  }
  if (rank(tier) < rank(modelFloor)) {
    tier = modelFloor;
    rule += "+floor";
  }
  if (tier === "top" && facts.topRunsThisWeek >= topRunsPerWeek) {
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

/** Checks routing the owner sends; anything off is an error, never a guess. */
export function cleanRouting(value: unknown): ModelRouting {
  const v = (value ?? {}) as Partial<Record<keyof ModelRouting, unknown>>;
  const tiersIn = (v.tiers ?? {}) as Record<string, { model?: unknown; effort?: unknown }>;
  const tiers = {} as ModelRouting["tiers"];
  for (const tier of MODEL_TIERS) {
    const entry = tiersIn[tier] ?? DEFAULT_ROUTING.tiers[tier];
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!/^claude-[a-z0-9.-]+$/.test(model) || model.length > 80)
      throw badRequest(`The ${tier} tier needs a Claude model id, e.g. claude-opus-5-5`);
    if (!EFFORTS.includes(entry.effort as Effort))
      throw badRequest(`The ${tier} tier's effort is one of ${EFFORTS.join(", ")}`);
    tiers[tier] = { model, effort: entry.effort as Effort };
  }
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
 * Routes a run about to be queued, reading what the rules need. A decision reads only the
 * routing; a fresh work run also reads its issue, the issue's last work run and the agent.
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
  const routing = await loadRouting(db);
  const facts: RouteFacts = {
    kind: run.kind,
    resumes: run.resumes ?? null,
    ownerTier: run.ownerTier ?? null,
    requestedTier: run.requestedTier ?? null,
    labels: [],
    priority: 0,
    estimate: null,
    agent: { modelFloor: "small", modelCeiling: "top", topRunsPerWeek: 0 },
    topRunsThisWeek: 0,
  };
  if (run.kind === "work" && !run.resumes && !run.ownerTier) {
    const [agent, issue, names, last, top] = await Promise.all([
      db
        .select({
          modelFloor: users.modelFloor,
          modelCeiling: users.modelCeiling,
          topRunsPerWeek: users.topRunsPerWeek,
        })
        .from(users)
        .where(eq(users.id, run.agentId))
        .get(),
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
    if (!agent) throw notFound("Agent");
    facts.agent = agent;
    facts.priority = issue?.priority ?? 0;
    facts.estimate = issue?.estimate ?? null;
    facts.labels = names.map((l) => l.name.toLowerCase());
    facts.lastFailure = last?.status === "failed" ? last : null;
    facts.topRunsThisWeek = top?.n ?? 0;
  }
  return route(facts, routing);
}
