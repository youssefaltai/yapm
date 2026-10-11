import { useState } from "react";
import { useQuery } from "../data.js";
import { Page, PageHeader, PageTitle, Section, Tabs } from "../layout.js";
import { navigate, paths } from "../router.js";
import { Bone, EmptyState } from "../states.js";
import { Avatar } from "../ui.js";
import { ENGINES } from "./Runs.js";

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
  engine: string | null;
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
    routes { kind modelTier engine model effort routeRule runs completed successRate costUsd costPerCompletedRun }
    metrics { metric { id name unit target } value previousValue }
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
    metrics: {
      metric: { id: string; name: string; unit: string | null; target: number | null };
      value: number | null;
      previousValue: number | null;
    }[];
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
const num = (v: number | null) =>
  v === null || Number.isInteger(v) ? compact(v) : String(Math.round(v * 100) / 100);
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
    <Page>
      <PageHeader
        actions={
          <Tabs
            label="Period"
            group="insights-period"
            options={PERIODS.map((p) => ({ id: p as number, label: `${p} days` }))}
            value={days}
            onChange={setDays}
          />
        }
      >
        <PageTitle>Insights</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!company && !error && (
          <div
            aria-hidden
            className="mx-auto grid max-w-5xl animate-skeleton-in grid-cols-2 gap-3 px-4 pt-6 md:grid-cols-4 md:px-6"
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
          <div className={`mx-auto max-w-5xl px-4 pt-6 pb-16 md:px-6 ${stale ? "stale" : "fresh"}`}>
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
              <Stat label="Cost" value={usd(company.costUsd)} hint="as each engine reports" />
              <Stat
                label="Cost per issue"
                value={usd(company.costPerCompletedIssue)}
                hint="per completed issue"
              />
            </div>

            {(insights?.metrics ?? []).length > 0 && (
              <Section title="Our metrics">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {insights?.metrics.map(({ metric: m, value, previousValue }) => (
                    <Stat
                      key={m.id}
                      label={m.name}
                      value={`${num(value)}${m.unit ? ` ${m.unit}` : ""}`}
                      hint={`${num(previousValue)} before${m.target === null ? "" : ` · target ${m.target}`}`}
                    />
                  ))}
                </div>
              </Section>
            )}

            <Daily rows={data?.metricHistory ?? []} />

            <Section title="Agents">
              {agents.length === 0 ? (
                <EmptyState
                  compact
                  icon="chart"
                  title="No agent activity in this period"
                  description="Once agents finish runs and close issues, how each one is doing shows up here."
                  className="rounded-lg border border-dashed border-line"
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
            </Section>

            <Section title="Teams">
              {(insights?.teams ?? []).length === 0 ? (
                <EmptyState
                  compact
                  icon="team"
                  title="No team activity in this period"
                  description="Teams show up here as their issues move."
                  className="rounded-lg border border-dashed border-line"
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
            </Section>
            <Section title="Model routes">
              {(insights?.routes ?? []).length === 0 ? (
                <p className="text-muted">No runs ended in this period.</p>
              ) : (
                <Routes rows={insights?.routes ?? []} />
              )}
            </Section>
            <p className="mt-6 text-faint">
              Agents read these with get_metrics in their retros, compared with the period before.
            </p>
          </div>
        )}
      </div>
    </Page>
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
    <Section title="Completed per day">
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
    </Section>
  );
}

/** Which engine, model, effort and rule each run used, and what it bought: the evidence for routing. */
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
            const key = [r.kind, r.modelTier, r.engine, r.model, r.effort, r.routeRule].join("|");
            return (
              <tr key={key}>
                <td className="px-4 py-2 whitespace-nowrap">
                  {r.kind} · {r.model ?? r.modelTier}
                  {r.effort && <span className="text-muted"> · {r.effort}</span>}
                  {r.engine && (
                    <span className="text-faint"> · {ENGINES[r.engine] ?? r.engine}</span>
                  )}
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
