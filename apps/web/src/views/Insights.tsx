import { useState } from "react";
import { useQuery } from "../data.js";
import { navigate, paths } from "../router.js";
import { Bone, EmptyState, SelectedPill } from "../states.js";
import { Avatar } from "../ui.js";

interface Metrics {
  created: number;
  completed: number;
  cycleTimeHours: number | null;
  slaBreaches: number;
  runs: number;
  runSuccessRate: number | null;
  stopRate: number | null;
  requestsAnswered: number;
  rejectionRate: number | null;
  tokens: number;
  tokensPerCompletedIssue: number | null;
  costUsd: number;
  costPerCompletedIssue: number | null;
}

interface RouteMetrics {
  kind: string;
  modelTier: string;
  model: string | null;
  effort: string | null;
  routeRule: string | null;
  runs: number;
  completed: number;
  successRate: number | null;
  costUsd: number;
  costPerCompletedRun: number | null;
}

const FIELDS =
  "created completed cycleTimeHours slaBreaches runs runSuccessRate stopRate requestsAnswered rejectionRate tokens tokensPerCompletedIssue costUsd costPerCompletedIssue";

const QUERY = `query($days: Int) {
  insights(days: $days) {
    company { ${FIELDS} }
    teams { team { id key name } metrics { ${FIELDS} } }
    users { user { id name kind title } metrics { ${FIELDS} } }
    routes { kind modelTier model effort routeRule runs completed successRate costUsd costPerCompletedRun }
  }
  metricHistory(days: $days) { date metrics { completed created } }
}`;

interface InsightsData {
  insights: {
    company: Metrics;
    teams: { team: { id: string; key: string; name: string } | null; metrics: Metrics }[];
    users: {
      user: { id: string; name: string; kind: "owner" | "agent"; title: string | null } | null;
      metrics: Metrics;
    }[];
    routes: RouteMetrics[];
  };
  metricHistory: { date: string; metrics: { completed: number; created: number } }[];
}

const PERIODS = [7, 30, 90] as const;

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const hours = (v: number | null) =>
  v === null ? "–" : v < 48 ? `${v.toFixed(1)}h` : `${(v / 24).toFixed(1)}d`;
const compact = (v: number | null) =>
  v === null
    ? "–"
    : v >= 1_000_000
      ? `${(v / 1_000_000).toFixed(1)}M`
      : v >= 1000
        ? `${(v / 1000).toFixed(1)}k`
        : String(Math.round(v));
const usd = (v: number | null) =>
  v === null ? "–" : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(v >= 1 ? 2 : 3)}`;

/** How the company is working: throughput, speed, and how often agents needed correcting. */
export function Insights() {
  const [days, setDays] = useState<number>(7);
  const { data, error, stale } = useQuery<InsightsData>(QUERY, { days });
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  const insights = data?.insights;
  const company = insights?.company;
  const agents = (insights?.users ?? [])
    .filter((u) => u.user?.kind === "agent")
    .sort((a, b) => b.metrics.completed - a.metrics.completed || b.metrics.runs - a.metrics.runs);
  return (
    <div className="h-full overflow-y-auto">
      <header className="isolate flex h-11 items-center gap-3 border-b border-line px-4 md:px-6">
        <span className="font-medium">Insights</span>
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={days === p}
              onClick={() => setDays(p)}
              className={`relative rounded-md px-2 py-0.5 ${days === p ? "text-ink" : "text-muted hover:text-ink"}`}
            >
              {days === p && <SelectedPill group="insights-period" />}
              {p} days
            </button>
          ))}
        </div>
      </header>
      {!company && !error && (
        <div
          aria-hidden
          className="mx-auto grid max-w-5xl animate-skeleton-in grid-cols-2 gap-3 px-4 py-6 md:grid-cols-4 md:px-6"
        >
          {["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
            <div key={k} className="space-y-2.5 rounded-lg border border-line px-4 py-3">
              <Bone className="h-2.5 w-20" />
              <Bone className="h-5 w-12" />
            </div>
          ))}
        </div>
      )}
      {company && (
        <div className={`mx-auto max-w-5xl px-4 py-6 md:px-6 ${stale ? "stale" : "fresh"}`}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Completed"
              value={String(company.completed)}
              hint={`${company.created} created`}
            />
            <Stat label="Cycle time" value={hours(company.cycleTimeHours)} hint="start to done" />
            <Stat
              label="Runs stopped"
              value={pct(company.stopRate)}
              hint={`of ${company.runs} runs`}
            />
            <Stat
              label="Requests rejected"
              value={pct(company.rejectionRate)}
              hint={`of ${company.requestsAnswered} answered`}
            />
            <Stat label="SLA breaches" value={String(company.slaBreaches)} />
            <Stat label="Run success" value={pct(company.runSuccessRate)} />
            <Stat label="Tokens" value={compact(company.tokens)} />
            <Stat
              label="Tokens per issue"
              value={compact(company.tokensPerCompletedIssue)}
              hint="per completed issue"
            />
            <Stat label="Cost" value={usd(company.costUsd)} hint="at API prices" />
            <Stat
              label="Cost per issue"
              value={usd(company.costPerCompletedIssue)}
              hint="per completed issue"
            />
          </div>

          <Daily rows={data?.metricHistory ?? []} />

          <h2 className="mt-8 mb-2 text-[12px] font-medium text-faint uppercase">Agents</h2>
          {agents.length === 0 ? (
            <EmptyState
              compact
              icon="chart"
              title="No agent activity in this period"
              description="Once agents finish runs and close issues, how each one is doing shows up here."
              className="rounded-xl border border-dashed border-line"
            />
          ) : (
            <Table
              rows={agents.map((a) => ({
                id: a.user?.id ?? "",
                label: (
                  <span className="flex items-center gap-2">
                    <Avatar name={a.user?.name ?? "?"} kind="agent" size={18} />
                    {a.user?.name}
                  </span>
                ),
                onOpen: () => a.user && navigate(paths.member(a.user.id)),
                metrics: a.metrics,
              }))}
            />
          )}

          <h2 className="mt-8 mb-2 text-[12px] font-medium text-faint uppercase">Teams</h2>
          {(insights?.teams ?? []).length === 0 ? (
            <EmptyState
              compact
              icon="team"
              title="No team activity in this period"
              description="Teams show up here as their issues move."
              className="rounded-xl border border-dashed border-line"
            />
          ) : (
            <Table
              teams
              rows={(insights?.teams ?? []).map((t) => ({
                id: t.team?.id ?? "",
                label: t.team?.name ?? "Deleted team",
                onOpen: () => t.team && navigate(paths.team(t.team.key)),
                metrics: t.metrics,
              }))}
            />
          )}
          <h2 className="mt-8 mb-2 text-[12px] font-medium text-faint uppercase">Model routes</h2>
          {(insights?.routes ?? []).length === 0 ? (
            <p className="text-muted">No runs ended in this period.</p>
          ) : (
            <Routes rows={insights?.routes ?? []} />
          )}
          <p className="mt-6 text-faint">
            Agents read these with get_metrics in their retros, compared with the period before.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <section aria-label={label} className="rounded-lg border border-line px-4 py-3">
      <p className="text-[12px] text-faint">{label}</p>
      <p key={value} className="mt-1 animate-fade-in text-xl font-medium tabular-nums">
        {value}
      </p>
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </section>
  );
}

/** Issues completed per day, from the hub's daily snapshots. */
function Daily({ rows }: { rows: InsightsData["metricHistory"] }) {
  if (rows.length < 2) return null;
  const max = Math.max(1, ...rows.map((r) => r.metrics.completed));
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-[12px] font-medium text-faint uppercase">Completed per day</h2>
      <div className="flex h-24 items-end gap-1 rounded-lg border border-line px-3 py-2">
        {rows.map((r) => (
          <div
            key={r.date}
            title={`${r.date}: ${r.metrics.completed} completed`}
            className="min-w-1 flex-1 rounded-sm bg-accent/70"
            style={{ height: `${Math.max(4, (r.metrics.completed / max) * 100)}%` }}
          />
        ))}
      </div>
    </section>
  );
}

/** Which model, effort and rule each run used, and what it bought: the evidence for routing. */
function Routes({ rows }: { rows: RouteMetrics[] }) {
  const head = ["Rule", "Runs", "Success", "Cost", "Per completed run"];
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left">
        <thead className="text-[12px] text-faint">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-normal">Route</th>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 text-right font-normal whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const cells = [
              r.routeRule ?? "–",
              String(r.runs),
              pct(r.successRate),
              usd(r.costUsd),
              usd(r.costPerCompletedRun),
            ];
            const key = [r.kind, r.modelTier, r.model, r.effort, r.routeRule].join("|");
            return (
              <tr key={key}>
                <td className="px-4 py-2 whitespace-nowrap">
                  {r.kind} · {r.model ?? r.modelTier}
                  {r.effort && <span className="text-muted"> · {r.effort}</span>}
                </td>
                {cells.map((c, i) => (
                  <td key={head[i]} className="px-3 py-2 text-right text-muted tabular-nums">
                    {c}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Table({
  rows,
  teams = false,
}: {
  teams?: boolean;
  rows: { id: string; label: React.ReactNode; onOpen: () => void; metrics: Metrics }[];
}) {
  const head = teams
    ? ["Created", "Completed", "Cycle time", "SLA breaches"]
    : ["Completed", "Cycle time", "Runs", "Stopped", "Rejected", "Tokens / issue"];
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left">
        <thead className="text-[12px] text-faint">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-normal">{teams ? "Team" : "Agent"}</th>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 text-right font-normal whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const m = r.metrics;
            const cells = teams
              ? [
                  String(m.created),
                  String(m.completed),
                  hours(m.cycleTimeHours),
                  String(m.slaBreaches),
                ]
              : [
                  String(m.completed),
                  hours(m.cycleTimeHours),
                  String(m.runs),
                  pct(m.stopRate),
                  pct(m.rejectionRate),
                  compact(m.tokensPerCompletedIssue),
                ];
            return (
              <tr key={r.id} onClick={r.onOpen} className="cursor-pointer hover:bg-raised">
                <td className="px-4 py-2">{r.label}</td>
                {cells.map((c, i) => (
                  <td key={head[i]} className="px-3 py-2 text-right text-muted tabular-nums">
                    {c}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
