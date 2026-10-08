import { issues, type MetricScope, metricSnapshots, requests, runs } from "@life-os/schema";
import { type AnyColumn, and, asc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { newId } from "../crypto.js";
import { commit, type HubDb } from "../db.js";
import { addDays, localDate, zonedTime } from "../time.js";
import { insertRows } from "../write.js";
import { companyTimeZone } from "./cycles.js";

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
