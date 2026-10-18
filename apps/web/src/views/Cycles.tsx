import { cycleName, workspaceStore } from "../actions.js";
import { type Team, useQuery } from "../data.js";
import { Breadcrumbs, listRow, PageHeader, teamTrail } from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState, ListSkeleton, PageSkeleton } from "../states.js";
import { shortDate, useStore } from "../ui.js";
import { IssuesView } from "./IssuesView.js";
import { Progress } from "./Projects.js";
import { TeamTabs } from "./TeamTabs.js";

interface CycleRow {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  isActive: boolean;
  isFuture: boolean;
  progress: number;
  uncompletedIssuesUponCloseCount: number | null;
}

const CYCLE_ROW =
  "id number name startsAt endsAt completedAt isActive isFuture progress uncompletedIssuesUponCloseCount";

function CycleStatus({ cycle }: { cycle: CycleRow }) {
  if (cycle.isActive) return <span className="text-[12px] font-medium text-accent">Current</span>;
  if (cycle.isFuture) return <span className="text-[12px] text-muted">Upcoming</span>;
  return <span className="text-[12px] text-faint">Completed</span>;
}

export function CyclesView({ team }: { team: Team }) {
  const { data, error } = useQuery<{ team: { cycles: { nodes: CycleRow[] } } }>(
    `query($id: String!) { team(id: $id) { cycles(first: 100) { nodes { ${CYCLE_ROW} } } } }`,
    { id: team.id },
  );
  const cycles = data?.team.cycles.nodes ?? [];
  const teams = useStore(workspaceStore)?.teams.nodes ?? [];
  return (
    <div className="flex h-full flex-col">
      <PageHeader tabs={<TeamTabs team={team} active="cycles" />}>
        <Breadcrumbs trail={teamTrail(teams, team)}>{team.name}</Breadcrumbs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-critical">{error}</p>}
        {team.cyclesEnabled && !data && !error && <ListSkeleton rows={4} />}
        {!team.cyclesEnabled && (
          <EmptyState
            icon="cycle"
            title="Cycles are off"
            description="Cycles are short, repeating stretches of focused work, like sprints."
            action={{
              label: "Turn on cycles",
              onClick: () => navigate(paths.teamSettings(team.key)),
            }}
          />
        )}
        <ul>
          {cycles.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => navigate(paths.cycle(c.id))}
                className={`${listRow} ${c.isActive ? "bg-raised/50" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{cycleName(c)}</span>
                  <span className="block text-[12px] text-faint">
                    {shortDate(c.startsAt)} – {shortDate(c.endsAt)}
                    {c.uncompletedIssuesUponCloseCount
                      ? ` · ${c.uncompletedIssuesUponCloseCount} moved on`
                      : ""}
                  </span>
                </span>
                <CycleStatus cycle={c} />
                <Progress value={c.progress} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface CycleDetail extends CycleRow {
  scopeHistory: number[];
  completedScopeHistory: number[];
  team: { key: string };
}

export function CyclePage({ id }: { id: string }) {
  const workspace = useStore(workspaceStore);
  const { data, error } = useQuery<{ cycle: CycleDetail }>(
    `query($id: String!) { cycle(id: $id) { ${CYCLE_ROW} scopeHistory completedScopeHistory team { key } } }`,
    { id },
  );
  const cycle = data?.cycle;
  const team = workspace?.teams.nodes.find((t) => t.key === cycle?.team.key);
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!cycle || !team) return <PageSkeleton />;
  return (
    <IssuesView
      source={{ kind: "cycle", cycle, team }}
      title={
        <Breadcrumbs
          trail={[
            ...teamTrail(workspace?.teams.nodes ?? [], team),
            { label: team.name, to: paths.team(team.key), wide: true },
            { label: "Cycles", to: paths.cycles(team.key) },
          ]}
        >
          {cycleName(cycle)}
        </Breadcrumbs>
      }
      tabs={
        <span className="text-[12px] text-faint max-sm:hidden">
          {shortDate(cycle.startsAt)} – {shortDate(cycle.endsAt)}
        </span>
      }
      banner={<BurnUp cycle={cycle} />}
    />
  );
}

/** Scope and completed issues per day, like Linear's cycle graph. */
function BurnUp({ cycle }: { cycle: CycleDetail }) {
  const scope = cycle.scopeHistory;
  const done = cycle.completedScopeHistory;
  const last = scope.length - 1;
  return (
    <div className="flex items-center gap-6 border-b border-line px-4 py-3 md:px-6">
      <div className="shrink-0 space-y-1 text-[12px]">
        <p className="text-muted">
          <span className="inline-block size-2 rounded-full bg-faint" /> Scope{" "}
          <span className="text-ink">{scope[last] ?? 0}</span>
        </p>
        <p className="text-muted">
          <span className="inline-block size-2 rounded-full bg-accent" /> Completed{" "}
          <span className="text-ink">{done[last] ?? 0}</span>
        </p>
        <p className="text-faint">{Math.round(cycle.progress * 100)}% done</p>
      </div>
      {scope.length > 0 ? (
        <BurnUpChart cycle={cycle} className="h-24 min-w-0 flex-1" />
      ) : (
        <p className="text-[12px] text-faint">
          The graph fills in day by day once the cycle starts.
        </p>
      )}
    </div>
  );
}

/** Scope against completed, one point a day, with the ideal line dashed. */
function BurnUpChart({ cycle, className }: { cycle: CycleDetail; className: string }) {
  const days = Math.max(
    1,
    Math.round((Date.parse(cycle.endsAt) - Date.parse(cycle.startsAt)) / 86_400_000),
  );
  const scope = cycle.scopeHistory;
  const done = cycle.completedScopeHistory;
  const max = Math.max(1, ...scope);
  const w = 600;
  const h = 120;
  const x = (i: number) => (i / days) * w;
  const y = (v: number) => h - (v / max) * (h - 8);
  const line = (values: number[]) => values.map((v, i) => `${x(i + 1)},${y(v)}`).join(" ");
  const last = scope.length - 1;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label="Cycle progress"
    >
      <line
        x1="0"
        y1={h}
        x2={w}
        y2={y(scope[last] ?? 0)}
        className="stroke-line"
        strokeDasharray="4 4"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={`0,${y(scope[0] ?? 0)} ${line(scope)}`}
        fill="none"
        className="stroke-faint"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={`0,${h} ${line(done)}`}
        fill="none"
        className="stroke-accent"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
