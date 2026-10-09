import {
  type ClaudeAccount,
  machines,
  type PlanLimit,
  type PlanUsage,
  type ReportedUsage,
  runs,
  users,
} from "@life-os/schema";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { HubDb } from "../db.js";
import { localDate } from "../time.js";
import { companyTimeZone } from "./cycles.js";
import { machineName } from "./machines.js";

// What the owner's Claude subscription is doing. Claude Code tells each runner how full the
// plan's windows are (as percentages, with reset times) and what each session would cost at
// API prices; the hub keeps the latest reading per machine and sums runs over time. Plans
// don't publish their limits as token or dollar amounts, so neither does the hub.

const HOUR = 3_600_000;

const text = (value: unknown, max = 200) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const percent = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : null;
const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
/** An instant from a runner: epoch ms or an ISO string, within a few years of now. */
function instant(value: unknown, at: number) {
  const ms =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms - at) < 3 * 365 * 24 * HOUR ? Math.round(ms) : null;
}

/** The Claude login a runner reports, kept to the fields the app shows. */
export function cleanAccount(value: unknown): ClaudeAccount | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const account = {
    email: text(v.email),
    organization: text(v.organization),
    subscriptionType: text(v.subscriptionType, 40),
    apiProvider: text(v.apiProvider, 40),
  };
  return Object.values(account).some((x) => x !== null) ? account : null;
}

/** A runner's reading of the plan's limits, checked field by field. */
export function cleanPlanUsage(value: unknown, at: number): PlanUsage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const observedAt = instant(v.observedAt, at);
  if (observedAt === null) return null;
  const limits: PlanLimit[] = [];
  for (const raw of Array.isArray(v.limits) ? v.limits.slice(0, 20) : []) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    const kind = text(l.kind, 80);
    if (!kind || limits.some((x) => x.kind === kind)) continue;
    limits.push({
      kind,
      label: text(l.label, 80) ?? kind,
      utilization: percent(l.utilization),
      resetsAt: instant(l.resetsAt, at),
      status: text(l.status, 40),
    });
  }
  const extra = v.extraUsage as Record<string, unknown> | null | undefined;
  return {
    // A machine's clock may run ahead; a reading can't come from the future.
    observedAt: Math.min(observedAt, at),
    source: v.source === "rate_limit" ? "rate_limit" : "usage",
    available: v.available !== false,
    limits,
    extraUsage:
      extra && typeof extra === "object"
        ? {
            enabled: extra.enabled === true,
            monthlyLimit: amount(extra.monthlyLimit),
            usedCredits: amount(extra.usedCredits),
            utilization: percent(extra.utilization),
            currency: text(extra.currency, 8),
          }
        : null,
  };
}

/** The usage totals a runner reported, without anything that isn't a sane number. */
export function cleanReportedUsage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const count = (x: unknown) => (typeof x === "number" && x >= 0 ? Math.floor(x) : undefined);
  const usage: ReportedUsage & { numTurns?: number } = {};
  if (count(v.inputTokens) !== undefined) usage.inputTokens = count(v.inputTokens);
  if (count(v.outputTokens) !== undefined) usage.outputTokens = count(v.outputTokens);
  if (count(v.numTurns) !== undefined) usage.numTurns = count(v.numTurns);
  if (typeof v.costUsd === "number" && v.costUsd >= 0 && v.costUsd < 10_000)
    usage.costUsd = v.costUsd;
  return Object.keys(usage).length ? usage : null;
}

/**
 * This run's own usage from what the SDK reported. A resumed session's totals carry on from
 * the run it resumed, so that run's reported totals are taken off; totals that went down mean
 * the session started counting afresh, and are this run's own.
 */
export function ownUsage(reported: ReportedUsage, before: ReportedUsage | null) {
  const keys = ["inputTokens", "outputTokens", "costUsd"] as const;
  const carried =
    before !== null &&
    keys.some((k) => (before[k] ?? 0) > 0) &&
    keys.every((k) => reported[k] === undefined || reported[k] >= (before[k] ?? 0));
  const own: ReportedUsage = {};
  for (const k of keys) {
    const value = reported[k];
    if (value === undefined) continue;
    own[k] = carried ? Math.max(value - (before?.[k] ?? 0), 0) : value;
  }
  return own;
}

/**
 * The run columns to set for a usage report: the raw totals, and the run's own share of them.
 * Costs one read, only for a resumed run.
 */
export async function runUsageSet(
  db: HubDb,
  run: { resumeOfRunId: string | null; sessionId: string | null },
  value: unknown,
  sessionId?: string | null,
) {
  const usage = cleanReportedUsage(value);
  if (!usage) return {};
  const { numTurns, ...reported } = usage;
  let before: ReportedUsage | null = null;
  if (run.resumeOfRunId) {
    const prior = await db
      .select({ sessionId: runs.sessionId, reportedUsage: runs.reportedUsage })
      .from(runs)
      .where(eq(runs.id, run.resumeOfRunId))
      .get();
    const session = sessionId ?? run.sessionId;
    if (prior?.reportedUsage && prior.sessionId && prior.sessionId === session)
      before = prior.reportedUsage;
  }
  const own = ownUsage(reported, before);
  return {
    reportedUsage: reported,
    ...(own.inputTokens !== undefined ? { inputTokens: own.inputTokens } : {}),
    ...(own.outputTokens !== undefined ? { outputTokens: own.outputTokens } : {}),
    ...(own.costUsd !== undefined ? { costUsd: own.costUsd } : {}),
    ...(numTurns !== undefined ? { numTurns } : {}),
  };
}

type MachineRow = typeof machines.$inferSelect;

export interface Subscription {
  /** The login's email, or the machine id when the machine didn't say who it is. */
  id: string;
  account: ClaudeAccount | null;
  machines: MachineRow[];
  /** The newest reading from any machine on this login. */
  planUsage: PlanUsage | null;
  /** The machine that took that reading. */
  reportedBy: MachineRow | null;
}

/**
 * Machines grouped by the Claude login they use: every machine on one login draws from the
 * same plan, so they share one set of limits.
 */
export async function claudeSubscriptions(db: HubDb): Promise<Subscription[]> {
  const rows = await db
    .select()
    .from(machines)
    .where(inArray(machines.status, ["pending", "active"]))
    .all();
  const groups = new Map<string, Subscription>();
  for (const machine of rows) {
    const email = machine.claudeAccount?.email?.toLowerCase();
    const id = email ?? machine.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        account: machine.claudeAccount,
        machines: [],
        planUsage: null,
        reportedBy: null,
      };
      groups.set(id, group);
    }
    group.machines.push(machine);
    const usage = machine.planUsage;
    if (usage && (!group.planUsage || usage.observedAt > group.planUsage.observedAt)) {
      group.planUsage = usage;
      group.reportedBy = machine;
      if (machine.claudeAccount) group.account = machine.claudeAccount;
    }
  }
  return [...groups.values()].sort(
    (a, b) => (b.planUsage?.observedAt ?? 0) - (a.planUsage?.observedAt ?? 0),
  );
}

export const USAGE_GROUPS = ["agent", "model", "machine"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export interface UsagePoint {
  /** YYYY-MM-DD in the company's time zone. */
  date: string;
  key: string;
  label: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Runs that ended in [from, to), summed per local day and per agent, model or machine. The
 * database sums per hour so local days stay right across time zones and clock changes.
 */
export async function usageHistory(
  db: HubDb,
  groupBy: UsageGroup,
  from: number,
  to: number,
): Promise<UsagePoint[]> {
  const column =
    groupBy === "agent"
      ? runs.agentId
      : groupBy === "machine"
        ? runs.machineId
        : sql<string>`coalesce(${runs.model}, ${runs.modelTier})`;
  const [timeZone, rows] = await Promise.all([
    companyTimeZone(db),
    db
      .select({
        hour: sql<number>`cast(${runs.endedAt} / ${HOUR} as integer)`,
        key: sql<string | null>`${column}`,
        runs: sql<number>`count(*)`,
        inputTokens: sql<number>`sum(${runs.inputTokens})`,
        outputTokens: sql<number>`sum(${runs.outputTokens})`,
        costUsd: sql<number>`sum(${runs.costUsd})`,
      })
      .from(runs)
      .where(and(gte(runs.endedAt, from), lte(runs.endedAt, to)))
      .groupBy(sql`1`, sql`2`)
      .all(),
  ]);
  const keys = [...new Set(rows.map((r) => r.key ?? ""))].filter(Boolean);
  const labels = new Map<string, string>();
  if (groupBy === "agent" && keys.length)
    for (const u of await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, keys.slice(0, 90)))
      .all())
      labels.set(u.id, u.name);
  if (groupBy === "machine" && keys.length)
    for (const m of await db
      .select({ id: machines.id, name: machines.name, displayName: machines.displayName })
      .from(machines)
      .where(inArray(machines.id, keys.slice(0, 90)))
      .all())
      labels.set(m.id, machineName(m));
  const points = new Map<string, UsagePoint>();
  for (const r of rows) {
    const date = localDate(Number(r.hour) * HOUR, timeZone);
    const key = r.key ?? "";
    const id = `${date}|${key}`;
    let point = points.get(id);
    if (!point) {
      point = {
        date,
        key,
        label: labels.get(key) ?? (key ? key : groupBy === "machine" ? "No machine" : "Unknown"),
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      points.set(id, point);
    }
    point.runs += Number(r.runs ?? 0);
    point.inputTokens += Number(r.inputTokens ?? 0);
    point.outputTokens += Number(r.outputTokens ?? 0);
    point.costUsd += Number(r.costUsd ?? 0);
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date) || b.costUsd - a.costUsd);
}
