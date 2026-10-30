import { type ReactNode, useState } from "react";
import { useQuery } from "../data.js";
import { Page, PageBody, PageHeader, PageTitle, Section, Tabs } from "../layout.js";
import { navigate, paths } from "../router.js";
import { Bone } from "../states.js";
import { timeAgo } from "../ui.js";

export interface PlanLimit {
  kind: string;
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  status: string | null;
}

interface PlanUsage {
  observedAt: string;
  stale: boolean;
  source: "usage" | "rate_limit";
  available: boolean;
  limits: PlanLimit[];
  extraUsage: {
    enabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
}

interface Subscription {
  id: string;
  account: {
    email: string | null;
    organization: string | null;
    subscriptionType: string | null;
    apiProvider: string | null;
  } | null;
  machines: { id: string; name: string; online: boolean; lastSeenAt: string | null }[];
  reportedBy: { name: string } | null;
  planUsage: PlanUsage | null;
}

export interface MachinePlan {
  provider: "claude" | "chatgpt" | "copilot";
  name: string | null;
  usage: PlanUsage | null;
}

interface UsageMachine {
  id: string;
  name: string;
  status: string;
  engines: string[];
  plans: MachinePlan[];
}

interface Point {
  date: string;
  key: string;
  label: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

type GroupBy = "agent" | "model" | "machine";
type Measure = "costUsd" | "tokens" | "runs";

const QUERY = `query($days: Int, $groupBy: UsageGroupBy!) {
  claudeSubscriptions {
    id
    account { email organization subscriptionType apiProvider }
    machines { id name online lastSeenAt }
    reportedBy { name }
    planUsage {
      observedAt stale source available
      limits { kind label utilization resetsAt status }
      extraUsage { enabled monthlyLimit usedCredits utilization currency }
    }
  }
  machines {
    id name status engines
    plans {
      provider name
      usage { observedAt stale source available limits { kind label utilization resetsAt status } }
    }
  }
  usageHistory(days: $days, groupBy: $groupBy) { date key label runs inputTokens outputTokens costUsd }
}`;

const PERIODS = [7, 30, 90] as const;
const GROUPS: { id: GroupBy; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "model", label: "Model" },
  { id: "machine", label: "Machine" },
];
const MEASURES: { id: Measure; label: string }[] = [
  { id: "costUsd", label: "Cost" },
  { id: "tokens", label: "Tokens" },
  { id: "runs", label: "Runs" },
];
/** Five named series and Other: more colors than that stop telling things apart. */
const SERIES = 5;
const color = (i: number) =>
  i < SERIES ? `var(--color-series-${i + 1})` : "var(--color-series-other)";

const compact = (v: number) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1000
      ? `${(v / 1000).toFixed(1)}k`
      : String(Math.round(v));
const usd = (v: number) =>
  v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(v >= 1 || v === 0 ? 2 : 3)}`;
const money = (minor: number | null, currency: string | null) =>
  minor === null
    ? "–"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD" }).format(
        minor / 100,
      );
const amountOf = (p: Point, measure: Measure) =>
  measure === "tokens" ? p.inputTokens + p.outputTokens : measure === "runs" ? p.runs : p.costUsd;
const format = (v: number, measure: Measure) => (measure === "costUsd" ? usd(v) : compact(v));

function untilLabel(iso: string) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h ${minutes % 60}m`;
  return `Resets ${new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

export const planName = (type: string | null) =>
  !type ? null : type.length <= 12 ? `${type[0]?.toUpperCase()}${type.slice(1)} plan` : type;

export const PROVIDERS: Record<MachinePlan["provider"], string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  copilot: "GitHub Copilot",
};

/** The plans agents run on: how close each is to its limits, and what agents used. */
export function UsageView() {
  const [days, setDays] = useState<number>(30);
  const [groupBy, setGroupBy] = useState<GroupBy>("agent");
  const [measure, setMeasure] = useState<Measure>("costUsd");
  const { data, error } = useQuery<{
    claudeSubscriptions: Subscription[];
    machines: UsageMachine[];
    usageHistory: Point[];
  }>(QUERY, { days, groupBy }, 60_000);
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  const opencode = (data?.machines ?? []).filter(
    (m) => m.status !== "revoked" && m.engines.includes("opencode"),
  );
  return (
    <Page>
      <PageHeader
        actions={
          <Tabs
            label="Period"
            group="usage-period"
            options={PERIODS.map((p) => ({ id: p, label: `${p} days` }))}
            value={days}
            onChange={setDays}
          />
        }
      >
        <PageTitle>Usage</PageTitle>
      </PageHeader>
      {!data && (
        <div
          aria-hidden
          className="mx-auto grid w-full max-w-5xl animate-skeleton-in gap-3 px-4 pt-6 md:grid-cols-2 md:px-6"
        >
          {["a", "b"].map((k) => (
            <div key={k} className="space-y-3 rounded-lg border border-line px-4 py-3">
              <Bone className="h-2.5 w-32" />
              <Bone className="h-1.5 w-full" />
              <Bone className="h-1.5 w-full" />
            </div>
          ))}
        </div>
      )}
      {data && (
        <PageBody width="wide">
          <Section title="Plan limits">
            {data.claudeSubscriptions.length === 0 && opencode.length === 0 ? (
              <p className="text-muted">
                No machines yet.{" "}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => navigate(paths.machines())}
                >
                  Add one
                </button>{" "}
                and it reports its plan here.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {data.claudeSubscriptions.map((s) => (
                  <SubscriptionCard key={s.id} subscription={s} />
                ))}
                {opencode.map((m) => (
                  <OpencodeCards key={m.id} machine={m} />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Usage over time"
            actions={
              <div className="flex flex-wrap items-center justify-end gap-3">
                <Tabs
                  label="Group by"
                  group="usage-group"
                  options={GROUPS}
                  value={groupBy}
                  onChange={setGroupBy}
                />
                <Tabs
                  label="Measure"
                  group="usage-measure"
                  options={MEASURES}
                  value={measure}
                  onChange={setMeasure}
                />
              </div>
            }
          >
            <History points={data.usageHistory} days={days} measure={measure} groupBy={groupBy} />
          </Section>

          <p className="mt-6 max-w-3xl text-[12px] text-faint">
            Plans don't publish their limits in tokens or dollars, only how full each window is, so
            limits show as percentages. Cost is what the same tokens would cost at API prices for
            Claude runs, and what's reported for other runs (0 on a subscription); the subscription
            doesn't charge it. Your own use of Claude, ChatGPT or Copilot counts toward the limits
            above but isn't among the runs below.
          </p>
        </PageBody>
      )}
    </Page>
  );
}

function SubscriptionCard({ subscription: s }: { subscription: Subscription }) {
  const plan = s.planUsage;
  const name = planName(s.account?.subscriptionType ?? null);
  return (
    <section
      aria-label={s.account?.email ?? "Claude login"}
      className="rounded-lg border border-line px-4 py-3"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {s.account?.email ?? "Unknown login"}
        </span>
        {name && <span className="text-[12px] text-muted">{name}</span>}
      </div>
      <p className="text-[12px] text-faint">
        Used by{" "}
        {s.machines
          .map((m) =>
            m.online
              ? m.name
              : `${m.name} (offline${m.lastSeenAt ? `, seen ${timeAgo(m.lastSeenAt)}` : ""})`,
          )
          .join(", ")}
      </p>
      {!plan ? (
        <p className="mt-3 text-muted">
          No reading yet. Runners read the plan when they start and every 10 minutes; older runners
          need an update to report it.
        </p>
      ) : !plan.available ? (
        <p className="mt-3 text-muted">
          This login has no plan limits: it uses an API key or a cloud provider, which bill per
          token. Its runs still count below, at API prices.
        </p>
      ) : (
        <>
          {plan.limits.length === 0 ? (
            <p className="mt-3 text-muted">No limit windows reported yet.</p>
          ) : (
            <ul className={`mt-3 space-y-3 ${plan.stale ? "opacity-60" : ""}`}>
              {plan.limits.map((l) => (
                <Meter key={l.kind} limit={l} />
              ))}
            </ul>
          )}
          {plan.extraUsage?.enabled && (
            <p className="mt-3 text-[13px] text-muted">
              Extra usage: {money(plan.extraUsage.usedCredits, plan.extraUsage.currency)}
              {plan.extraUsage.monthlyLimit !== null &&
                ` of ${money(plan.extraUsage.monthlyLimit, plan.extraUsage.currency)}`}{" "}
              this month
            </p>
          )}
        </>
      )}
      {plan && (
        <ReadingAge usage={plan}>
          {s.reportedBy && ` by ${s.reportedBy.name}`}
          {plan.source === "rate_limit" && ", from a run's rate-limit notices"}
        </ReadingAge>
      )}
    </section>
  );
}

/** OpenCode's plans on one machine; a machine has its own, as they don't say whose they are. */
function OpencodeCards({ machine: m }: { machine: UsageMachine }) {
  const plans = m.plans.filter((p) => p.provider !== "claude");
  if (plans.length === 0)
    return (
      <section
        aria-label={`ChatGPT, Copilot & more on ${m.name}`}
        className="rounded-lg border border-line px-4 py-3"
      >
        <span className="font-medium">ChatGPT, Copilot & more</span>
        <p className="text-[12px] text-faint">On {m.name}</p>
        <p className="mt-3 text-muted">
          A ChatGPT or Copilot plan's limits are shown after the first run on one. An API key has no
          plan limits.
        </p>
      </section>
    );
  return plans.map((p) => (
    <section
      key={p.provider}
      aria-label={`${PROVIDERS[p.provider]} on ${m.name}`}
      className="rounded-lg border border-line px-4 py-3"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{PROVIDERS[p.provider]}</span>
        {planName(p.name) && <span className="text-[12px] text-muted">{planName(p.name)}</span>}
      </div>
      <p className="text-[12px] text-faint">Used by {m.name}</p>
      {p.usage?.limits.length ? (
        <ul className={`mt-3 space-y-3 ${p.usage.stale ? "opacity-60" : ""}`}>
          {p.usage.limits.map((l) => (
            <Meter key={l.kind} limit={l} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-muted">No limit windows: the plan reported none.</p>
      )}
      {p.usage && <ReadingAge usage={p.usage}>, from a run</ReadingAge>}
    </section>
  ));
}

/**
 * When a reading was taken. Runners read the plan every 10 minutes, so one over 20 minutes old
 * is stale: the plan may have moved since.
 */
export function ReadingAge({
  usage,
  children,
}: {
  usage: { observedAt: string; stale: boolean };
  children?: ReactNode;
}) {
  return (
    <p className="mt-3 text-[12px] text-faint">
      {usage.stale && (
        <>
          <span aria-hidden style={{ color: "var(--color-warning)" }}>
            ●{" "}
          </span>
          <span className="text-ink">Stale</span> ·{" "}
        </>
      )}
      Read {timeAgo(usage.observedAt)}
      {children}
    </p>
  );
}

export function Meter({ limit: l }: { limit: PlanLimit }) {
  // The hub empties a window once it resets; one may reset between polls, too.
  const reset = !!l.resetsAt && new Date(l.resetsAt).getTime() <= Date.now();
  const used = reset ? 0 : l.utilization;
  const level =
    l.status === "rejected" || (used ?? 0) >= 100
      ? "critical"
      : l.status === "allowed_warning" || (used ?? 0) >= 80
        ? "warning"
        : "normal";
  const fill =
    level === "critical"
      ? "var(--color-critical)"
      : level === "warning"
        ? "var(--color-warning)"
        : "var(--color-accent)";
  return (
    <li>
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate">{l.label}</span>
        {level !== "normal" && (
          <span className="text-[12px] text-ink">
            <span aria-hidden style={{ color: fill }}>
              ●{" "}
            </span>
            {level === "critical" ? "Limit reached" : "Near the limit"}
          </span>
        )}
        <span className="text-muted tabular-nums">
          {used === null ? "–" : `${Math.round(used)}%`}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> can't take the theme's colors everywhere */}
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-label={l.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
      >
        {used !== null && (
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.min(Math.max(used, 1), 100)}%`, background: fill }}
          />
        )}
      </div>
      {l.resetsAt && !reset && (
        <p className="mt-0.5 text-[12px] text-faint">{untilLabel(l.resetsAt)}</p>
      )}
    </li>
  );
}

/** Dates for the last `days` days, ending today, in the browser's time zone. */
function dateRange(days: number) {
  const out: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }
  return out;
}

function History({
  points,
  days,
  measure,
  groupBy,
}: {
  points: Point[];
  days: number;
  measure: Measure;
  groupBy: GroupBy;
}) {
  const [hover, setHover] = useState<string | null>(null);
  // The biggest series over the period keep their own color; the rest fold into Other.
  const totals = new Map<string, Point>();
  for (const p of points) {
    const t = totals.get(p.key) ?? {
      ...p,
      date: "",
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    t.runs += p.runs;
    t.inputTokens += p.inputTokens;
    t.outputTokens += p.outputTokens;
    t.costUsd += p.costUsd;
    totals.set(p.key, t);
  }
  const ranked = [...totals.values()].sort(
    (a, b) => amountOf(b, measure) - amountOf(a, measure) || b.runs - a.runs,
  );
  if (ranked.length === 0) return <p className="text-muted">No runs ended in this period.</p>;
  const named = ranked.slice(0, ranked.length > SERIES + 1 ? SERIES : SERIES + 1);
  const slot = new Map(named.map((p, i) => [p.key, i]));
  const legend = [
    ...named.map((p, i) => ({ key: p.key, label: p.label, color: color(i) })),
    ...(ranked.length > named.length
      ? [{ key: "", label: `Other (${ranked.length - named.length})`, color: color(SERIES) }]
      : []),
  ];

  const dates = dateRange(days);
  const byDate = new Map<string, number[]>();
  for (const p of points) {
    const row = byDate.get(p.date) ?? new Array(legend.length).fill(0);
    const i = slot.get(p.key) ?? legend.length - 1;
    row[i] += amountOf(p, measure);
    byDate.set(p.date, row);
  }
  const max = Math.max(...[...byDate.values()].map((r) => r.reduce((a, b) => a + b, 0)), 0) || 1;
  const hovered = hover ? byDate.get(hover) : undefined;
  const what = groupBy === "agent" ? "Agent" : groupBy === "model" ? "Model" : "Machine";

  return (
    <>
      <ul
        className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted"
        aria-label="Legend"
      >
        {legend.map((s) => (
          <li key={s.key || "other"} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="relative rounded-lg border border-line px-3 pt-3 pb-2">
        <div className="mb-1 flex justify-between text-[11px] text-faint tabular-nums">
          <span>{format(max, measure)}</span>
          <span>per day</span>
        </div>
        <div className="flex h-40 items-end gap-0.5 border-b border-line">
          {dates.map((date) => {
            const row = byDate.get(date);
            const total = row?.reduce((a, b) => a + b, 0) ?? 0;
            return (
              <button
                type="button"
                key={date}
                aria-label={`${date}: ${format(total, measure)}`}
                className={`flex h-full min-w-0 flex-1 cursor-default flex-col-reverse justify-start rounded-t-sm ${hover === date ? "bg-raised" : ""}`}
                onMouseEnter={() => setHover(date)}
                onFocus={() => setHover(date)}
                onMouseLeave={() => setHover(null)}
                onBlur={() => setHover(null)}
              >
                {row?.map((v, i) =>
                  v > 0 ? (
                    <div
                      key={legend[i]?.key || "other"}
                      className="w-full last:rounded-t-sm"
                      style={{
                        height: `${(v / max) * 100}%`,
                        minHeight: 2,
                        background: legend[i]?.color,
                        borderTop: "2px solid var(--color-panel)",
                      }}
                    />
                  ) : null,
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-faint">
          <span>{dates[0]}</span>
          <span>{dates.at(-1)}</span>
        </div>
        {hover && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-2 right-3 min-w-44 rounded-md border border-line bg-panel px-3 py-2 text-[12px] shadow-lg"
          >
            <p className="mb-1 font-medium">{hover}</p>
            {hovered ? (
              legend.map((s, i) =>
                (hovered[i] ?? 0) > 0 ? (
                  <p key={s.key || "other"} className="flex items-center gap-1.5 text-muted">
                    <span className="size-2 rounded-sm" style={{ background: s.color }} />
                    <span className="flex-1">{s.label}</span>
                    <span className="text-ink tabular-nums">
                      {format(hovered[i] ?? 0, measure)}
                    </span>
                  </p>
                ) : null,
              )
            ) : (
              <p className="text-faint">No runs</p>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left">
          <thead className="text-[12px] text-faint">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-normal">{what}</th>
              {["Runs", "Input tokens", "Output tokens", "Cost"].map((h) => (
                <th key={h} className="px-3 py-2 text-right font-normal whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ranked.map((p) => {
              const i = slot.get(p.key);
              const open =
                groupBy === "agent" && p.key
                  ? () => navigate(paths.member(p.key))
                  : groupBy === "machine" && p.key
                    ? () => navigate(paths.machine(p.key))
                    : undefined;
              return (
                <tr
                  key={p.key || "none"}
                  onClick={open}
                  className={open ? "cursor-pointer hover:bg-raised" : ""}
                >
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ background: color(i ?? SERIES) }}
                        aria-hidden
                      />
                      {p.label}
                    </span>
                  </td>
                  {[
                    String(p.runs),
                    compact(p.inputTokens),
                    compact(p.outputTokens),
                    usd(p.costUsd),
                  ].map((c, n) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed columns
                      key={n}
                      className="px-3 py-2 text-right text-muted tabular-nums"
                    >
                      {c}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
