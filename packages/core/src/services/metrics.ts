import {
  type AuditFilter,
  auditEvents,
  issues,
  METRIC_DIRECTIONS,
  type MetricDirection,
  type MetricScope,
  metricSnapshots,
  metrics,
  requests,
  runs,
} from "@life-os/schema";
import {
  type AnyColumn,
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { addDays, localDate, zonedTime } from "../time.js";
import { insertRows } from "../write.js";
import { type Ctx, changes, cleanText, event } from "./common.js";
import { companyTimeZone } from "./cycles.js";
import { authorize } from "./requests.js";

// Built-in measures of how the company works. The hub only counts; agents decide what the
// numbers mean in their retros, and the owner reads them on the Insights page.

export const COUNT_KEYS = [
  "created",
  "completed",
  "cycleMs",
  "slaBreaches",
  "runs",
  "runsCompleted",
  "runsStopped",
  "tokens",
  "costUsd",
  "requestsAnswered",
  "requestsRejected",
] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
export type Counts = Record<CountKey, number>;

const DAY = 86_400_000;

export function emptyCounts(): Counts {
  return Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Counts;
}

export function addCounts(into: Counts, from: Partial<Counts>) {
  for (const key of COUNT_KEYS) into[key] += Number(from[key] ?? 0);
  return into;
}

/** Rates and averages from raw counts; null where there is nothing to divide by. */
export function deriveMetrics(c: Counts) {
  return {
    created: c.created,
    completed: c.completed,
    cycleTimeHours: c.completed ? c.cycleMs / c.completed / 3_600_000 : null,
    slaBreaches: c.slaBreaches,
    runs: c.runs,
    runSuccessRate: c.runs ? c.runsCompleted / c.runs : null,
    stopRate: c.runs ? c.runsStopped / c.runs : null,
    requestsAnswered: c.requestsAnswered,
    rejectionRate: c.requestsAnswered ? c.requestsRejected / c.requestsAnswered : null,
    tokens: c.tokens,
    tokensPerCompletedIssue: c.completed ? c.tokens / c.completed : null,
    costUsd: c.costUsd,
    costPerCompletedIssue: c.completed ? c.costUsd / c.completed : null,
  };
}
export type Metrics = ReturnType<typeof deriveMetrics>;

export const scopeKey = (scope: MetricScope, id = "") => `${scope}:${id}`;

const within = (column: AnyColumn, from: number, to: number) =>
  sql`(${column} >= ${from} and ${column} < ${to})`;

/**
 * Raw counts for [from, to), for the company and for every team and member at once:
 * three grouped queries however big the company is.
 */
export async function countAll(db: HubDb, from: number, to: number) {
  const [issueRows, runRows, requestRows] = await Promise.all([
    db
      .select({
        teamId: issues.teamId,
        assigneeId: issues.assigneeId,
        created: sql<number>`sum(case when ${within(issues.createdAt, from, to)} then 1 else 0 end)`,
        completed: sql<number>`sum(case when ${within(issues.completedAt, from, to)} then 1 else 0 end)`,
        cycleMs: sql<number>`sum(case when ${within(issues.completedAt, from, to)} then ${issues.completedAt} - coalesce(${issues.startedAt}, ${issues.createdAt}) else 0 end)`,
        slaBreaches: sql<number>`sum(case when ${within(issues.slaBreachedAt, from, to)} then 1 else 0 end)`,
      })
      .from(issues)
      .where(
        or(
          and(gte(issues.createdAt, from), lt(issues.createdAt, to)),
          and(gte(issues.completedAt, from), lt(issues.completedAt, to)),
          and(gte(issues.slaBreachedAt, from), lt(issues.slaBreachedAt, to)),
        ),
      )
      .groupBy(issues.teamId, issues.assigneeId)
      .all(),
    db
      .select({
        agentId: runs.agentId,
        runs: sql<number>`count(*)`,
        runsCompleted: sql<number>`sum(case when ${runs.status} = 'completed' then 1 else 0 end)`,
        runsStopped: sql<number>`sum(case when ${runs.stoppedById} is not null then 1 else 0 end)`,
        tokens: sql<number>`sum(${runs.inputTokens} + ${runs.outputTokens})`,
        costUsd: sql<number>`sum(${runs.costUsd})`,
      })
      .from(runs)
      .where(and(gte(runs.endedAt, from), lt(runs.endedAt, to)))
      .groupBy(runs.agentId)
      .all(),
    db
      .select({
        requesterId: requests.requesterId,
        requestsAnswered: sql<number>`count(*)`,
        requestsRejected: sql<number>`sum(case when ${requests.status} = 'rejected' then 1 else 0 end)`,
      })
      .from(requests)
      .where(
        and(
          isNotNull(requests.answeredAt),
          gte(requests.answeredAt, from),
          lt(requests.answeredAt, to),
          inArray(requests.status, ["approved", "rejected"]),
        ),
      )
      .groupBy(requests.requesterId)
      .all(),
  ]);
  const all = new Map<string, Counts>();
  const add = (key: string, counts: Partial<Counts>) => {
    let current = all.get(key);
    if (!current) {
      current = emptyCounts();
      all.set(key, current);
    }
    addCounts(current, counts);
  };
  add(scopeKey("company"), {});
  for (const { teamId, assigneeId, ...counts } of issueRows) {
    add(scopeKey("company"), counts);
    add(scopeKey("team", teamId), counts);
    if (assigneeId) add(scopeKey("user", assigneeId), counts);
  }
  // Runs and requests belong to members; teams are measured by their issues.
  for (const { agentId, ...counts } of runRows) {
    add(scopeKey("company"), counts);
    add(scopeKey("user", agentId), counts);
  }
  for (const { requesterId, ...counts } of requestRows) {
    add(scopeKey("company"), counts);
    add(scopeKey("user", requesterId), counts);
  }
  return all;
}

/**
 * How each model route did over [from, to): the evidence for tuning the routing table. A route
 * is one model, effort and rule; work is judged by cost per completed run, since a cheap run
 * that fails and has to be redone isn't cheap.
 */
export async function routeStats(db: HubDb, from: number, to: number) {
  const rows = await db
    .select({
      kind: runs.kind,
      modelTier: runs.modelTier,
      model: runs.model,
      effort: runs.effort,
      routeRule: runs.routeRule,
      runs: sql<number>`count(*)`,
      completed: sql<number>`sum(case when ${runs.status} = 'completed' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${runs.status} = 'failed' then 1 else 0 end)`,
      stopped: sql<number>`sum(case when ${runs.stoppedById} is not null then 1 else 0 end)`,
      tokens: sql<number>`sum(${runs.inputTokens} + ${runs.outputTokens})`,
      costUsd: sql<number>`sum(${runs.costUsd})`,
    })
    .from(runs)
    .where(and(gte(runs.endedAt, from), lt(runs.endedAt, to)))
    .groupBy(runs.kind, runs.modelTier, runs.model, runs.effort, runs.routeRule)
    .all();
  return rows
    .map((r) => {
      const n = (v: unknown) => Number(v ?? 0);
      const completed = n(r.completed);
      return {
        ...r,
        runs: n(r.runs),
        completed,
        failed: n(r.failed),
        stopped: n(r.stopped),
        tokens: n(r.tokens),
        costUsd: n(r.costUsd),
        successRate: n(r.runs) ? completed / n(r.runs) : null,
        costPerCompletedRun: completed ? n(r.costUsd) / completed : null,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
}
export type RouteStats = Awaited<ReturnType<typeof routeStats>>[number];

/** Metrics over the last `days` days up to `at`, for one scope. */
export async function metricsFor(
  db: HubDb,
  scope: MetricScope,
  scopeId: string,
  days: number,
  at: number,
): Promise<Metrics> {
  const span = Math.min(Math.max(Math.floor(days), 1), 365);
  const all = await countAll(db, at - span * DAY, at);
  return deriveMetrics(
    all.get(scopeKey(scope, scope === "company" ? "" : scopeId)) ?? emptyCounts(),
  );
}

/**
 * After each local day ends, keeps its counts for every scope that had activity, so trends
 * survive and retros can compare weeks. Idempotent: a day is taken once.
 */
export async function snapshotMetrics(db: HubDb, at: number) {
  const timeZone = await companyTimeZone(db);
  const today = localDate(at, timeZone);
  const day = addDays(today, -1);
  const taken = await db
    .select({ id: metricSnapshots.id })
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.scope, "company"),
        eq(metricSnapshots.scopeId, ""),
        eq(metricSnapshots.date, day),
      ),
    )
    .get();
  if (taken) return false;
  const all = await countAll(db, zonedTime(day, timeZone), zonedTime(today, timeZone));
  const rows = [...all].map(([key, counts]) => {
    const [scope, scopeId = ""] = key.split(":") as [MetricScope, string];
    return { id: newId(), date: day, scope, scopeId, counts, createdAt: at };
  });
  await commit(db, insertRows(db, metricSnapshots, rows));
  return true;
}

/** Daily snapshots for one scope, oldest first. */
export async function metricHistory(
  db: HubDb,
  scope: MetricScope,
  scopeId: string,
  days: number,
  at: number,
) {
  const timeZone = await companyTimeZone(db);
  const since = addDays(localDate(at, timeZone), -Math.min(Math.max(Math.floor(days), 1), 365));
  return db
    .select()
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.scope, scope),
        eq(metricSnapshots.scopeId, scope === "company" ? "" : scopeId),
        gte(metricSnapshots.date, since),
      ),
    )
    .orderBy(asc(metricSnapshots.date))
    .all();
}

// Metrics the company defines as data: counts of audit log entries, or a ratio of two counts.
// Only structured filters are stored, and they are always bound as parameters.

export type MetricRow = typeof metrics.$inferSelect;

type FilterInput = { action: string; entityType?: string | null };

export interface MetricInput {
  name?: string | null;
  description?: string | null;
  numerator?: FilterInput | null;
  /** Null makes it a plain count. */
  denominator?: FilterInput | null;
  unit?: string | null;
  target?: number | null;
  direction?: string | null;
}

const ACTION = /^[a-zA-Z]+(\.[a-zA-Z]+)+$/;
const ENTITY_TYPE = /^[a-zA-Z_]+$/;

function cleanFilter(value: unknown, label: string): AuditFilter {
  const f = (value ?? {}) as Record<string, unknown>;
  const action = typeof f.action === "string" ? f.action.trim() : "";
  if (!ACTION.test(action) || action.length > 60)
    throw badRequest(`${label} needs an audit action like issue.create`);
  const entityType = typeof f.entityType === "string" ? f.entityType.trim() : "";
  if (!entityType) return { action };
  if (!ENTITY_TYPE.test(entityType) || entityType.length > 40)
    throw badRequest(`${label} has an entity type that isn't one, e.g. issue`);
  return { action, entityType };
}

function cleanFields(input: MetricInput) {
  const next: Partial<MetricRow> = {};
  if (input.name != null) next.name = cleanText(input.name, "Name", 80);
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  if (input.numerator != null) next.numerator = cleanFilter(input.numerator, "The numerator");
  if (input.denominator !== undefined)
    next.denominator = input.denominator ? cleanFilter(input.denominator, "The denominator") : null;
  if (input.unit !== undefined)
    next.unit = input.unit?.trim() ? cleanText(input.unit, "Unit", 20) : null;
  if (input.target !== undefined) {
    if (input.target !== null && !Number.isFinite(input.target))
      throw badRequest("The target must be a number");
    next.target = input.target;
  }
  if (input.direction !== undefined) {
    if (input.direction && !METRIC_DIRECTIONS.includes(input.direction as MetricDirection))
      throw badRequest("The direction is up or down");
    next.direction = (input.direction || null) as MetricDirection | null;
  }
  return next;
}

async function checkName(db: HubDb, name: string, id = "") {
  const taken = await db
    .select({ id: metrics.id })
    .from(metrics)
    .where(and(eq(metrics.name, name), isNull(metrics.archivedAt), ne(metrics.id, id)))
    .get();
  if (taken) throw badRequest(`A metric named ${name} already exists`);
}

export async function requireMetric(db: HubDb, id: string) {
  const row = await db.select().from(metrics).where(eq(metrics.id, id)).get();
  if (!row) throw notFound("Metric");
  return row;
}

export async function createMetric(ctx: Ctx, input: MetricInput) {
  const { db, now } = ctx;
  const fields = cleanFields(input);
  if (!fields.name) throw badRequest("Give the metric a name");
  if (!fields.numerator) throw badRequest("Say what the metric counts: a numerator");
  await checkName(db, fields.name);
  const allowed = await authorize(ctx, "metric.update");
  const id = newId();
  const row = { ...fields, name: fields.name, numerator: fields.numerator };
  await commit(db, [
    db
      .insert(metrics)
      .values({ ...row, id, creatorId: ctx.actorId, createdAt: now, updatedAt: now }),
    ...allowed,
    ...audit(db, [event(ctx, "metric.create", "metric", id, row)], now),
  ]);
  return id;
}

export async function updateMetric(ctx: Ctx, id: string, input: MetricInput) {
  const { db, now } = ctx;
  const metric = await requireMetric(db, id);
  const next = cleanFields(input);
  const { numerator, denominator, ...plain } = next;
  const diff = changes(metric, plain) ?? {};
  for (const [key, to] of Object.entries({ numerator, denominator }))
    if (to !== undefined && JSON.stringify(to) !== JSON.stringify(metric[key as "numerator"]))
      diff[key] = { from: metric[key as "numerator"], to };
  if (!Object.keys(diff).length) return id;
  if (next.name && !metric.archivedAt) await checkName(db, next.name, id);
  const allowed = await authorize(ctx, "metric.update");
  await commit(db, [
    db
      .update(metrics)
      .set({ ...next, updatedAt: now })
      .where(eq(metrics.id, id)),
    ...allowed,
    ...audit(db, [event(ctx, "metric.update", "metric", id, diff)], now),
  ]);
  return id;
}

export async function archiveMetric(ctx: Ctx, id: string) {
  const { db, now } = ctx;
  const metric = await requireMetric(db, id);
  if (metric.archivedAt) return id;
  const allowed = await authorize(ctx, "metric.update");
  await commit(db, [
    db.update(metrics).set({ archivedAt: now, updatedAt: now }).where(eq(metrics.id, id)),
    ...allowed,
    ...audit(db, [event(ctx, "metric.archive", "metric", id)], now),
  ]);
  return id;
}

export const listMetrics = (db: HubDb) =>
  db.select().from(metrics).where(isNull(metrics.archivedAt)).orderBy(asc(metrics.name)).all();

export interface MetricValue {
  metric: MetricRow;
  /** Over [from, to). */
  value: number | null;
  /** Over the same length of time before `from`. */
  previousValue: number | null;
}

/**
 * Every active metric over [from, to) and the period before, for the company or one member:
 * two queries however many metrics there are.
 */
export async function metricValues(
  db: HubDb,
  from: number,
  to: number,
  actorId: string | null = null,
): Promise<MetricValue[]> {
  const [defined, rows] = await Promise.all([
    listMetrics(db),
    db
      .select({
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        current: sql<number>`sum(case when ${auditEvents.createdAt} >= ${from} then 1 else 0 end)`,
        previous: sql<number>`sum(case when ${auditEvents.createdAt} < ${from} then 1 else 0 end)`,
      })
      .from(auditEvents)
      .where(
        and(
          gte(auditEvents.createdAt, from - (to - from)),
          lt(auditEvents.createdAt, to),
          actorId ? eq(auditEvents.actorId, actorId) : undefined,
        ),
      )
      .groupBy(auditEvents.action, auditEvents.entityType)
      .all(),
  ]);
  const count = (f: AuditFilter, period: "current" | "previous") =>
    rows
      .filter((r) => r.action === f.action && (!f.entityType || r.entityType === f.entityType))
      .reduce((sum, r) => sum + Number(r[period] ?? 0), 0);
  const value = (m: MetricRow, period: "current" | "previous") => {
    const n = count(m.numerator, period);
    if (!m.denominator) return n;
    const d = count(m.denominator, period);
    return d ? n / d : null;
  };
  return defined.map((metric) => ({
    metric,
    value: value(metric, "current"),
    previousValue: value(metric, "previous"),
  }));
}
