import { useMemo } from "react";
import { createProjectStore } from "../actions.js";
import { useQuery } from "../data.js";
import { Page, PageHeader } from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState, ListSkeleton } from "../states.js";
import { ProjectDot, ProjectsTabs } from "./Projects.js";

interface RoadmapProject {
  id: string;
  name: string;
  color: string;
  state: string;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  progress: { progress: number };
  initiative: { id: string; name: string } | null;
  projectMilestones: { nodes: { id: string; name: string; targetDate: string | null }[] };
}

const QUERY = `{ projects(first: 200) { nodes {
  id name color state startDate targetDate createdAt progress { progress } initiative { id name }
  projectMilestones { nodes { id name targetDate } }
} } }`;

const MONTH_WIDTH = 140;
const DAY = 86_400_000;

const day = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);

/** Projects on a timeline from start to target date, like Linear's roadmap. */
export function RoadmapView() {
  const { data, error } = useQuery<{ projects: { nodes: RoadmapProject[] } }>(QUERY);
  const projects = (data?.projects.nodes ?? []).filter((p) => p.state !== "canceled");
  const today = day(new Date().toISOString());

  const { from, months } = useMemo(() => {
    const dates = projects.flatMap((p) =>
      [p.startDate, p.targetDate].filter((d): d is string => !!d).map(day),
    );
    const min = Math.min(today - 30 * DAY, ...dates);
    const max = Math.max(today + 120 * DAY, ...dates);
    const first = new Date(min);
    const start = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
    const list: number[] = [];
    for (let m = start; m <= max; ) {
      list.push(m);
      const d = new Date(m);
      m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return { from: start, months: list };
  }, [projects, today]);

  const x = (ms: number) => {
    // Position within the month it falls in, so months keep equal widths.
    const index = months.findIndex((m, i) => ms >= m && ms < (months[i + 1] ?? Infinity));
    const m = months[Math.max(index, 0)] ?? from;
    const d = new Date(m);
    const length = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - m;
    return Math.max(index, 0) * MONTH_WIDTH + ((ms - m) / length) * MONTH_WIDTH;
  };
  const width = months.length * MONTH_WIDTH;

  const groups = new Map<string, { name: string; projects: RoadmapProject[] }>();
  for (const p of projects) {
    const key = p.initiative?.id ?? "";
    const group = groups.get(key) ?? { name: p.initiative?.name ?? "No initiative", projects: [] };
    group.projects.push(p);
    groups.set(key, group);
  }

  return (
    <Page>
      <PageHeader>
        <ProjectsTabs active="roadmap" />
      </PageHeader>
      {error && <p className="p-6 text-red-400">{error}</p>}
      {!data && !error && <ListSkeleton rows={5} />}
      {data && projects.length === 0 && (
        <EmptyState
          icon="roadmap"
          title="Nothing on the roadmap yet"
          description="Projects with dates show up here on a timeline, grouped by initiative."
          action={{ label: "New project", onClick: () => createProjectStore.set(true) }}
        />
      )}
      {projects.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="relative" style={{ minWidth: width + 220 }}>
            <div className="sticky top-0 z-10 flex border-b border-line bg-panel">
              <div className="sticky left-0 w-[220px] shrink-0 bg-panel" />
              {months.map((m) => (
                <div
                  key={m}
                  className="shrink-0 border-l border-line px-2 py-1.5 text-[12px] text-muted"
                  style={{ width: MONTH_WIDTH }}
                >
                  {new Date(m).toLocaleDateString(undefined, {
                    month: "short",
                    year: "2-digit",
                    timeZone: "UTC",
                  })}
                </div>
              ))}
            </div>
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-0 w-px bg-accent/60"
              style={{ left: 220 + x(today) }}
              aria-hidden
            />
            {[...groups.values()].map((group) => (
              <section key={group.name} aria-label={group.name}>
                <div className="flex h-8 items-center border-b border-line bg-raised/95">
                  <h2 className="sticky left-0 px-4 font-medium md:px-6">{group.name}</h2>
                </div>
                {group.projects.map((p) => {
                  const start = p.startDate ? day(p.startDate) : day(p.createdAt);
                  const end = p.targetDate ? day(p.targetDate) : null;
                  return (
                    <div key={p.id} className="flex h-10 items-center border-b border-line/60">
                      <button
                        type="button"
                        onClick={() => navigate(paths.project(p.id))}
                        className="sticky left-0 z-10 flex h-full w-[220px] shrink-0 items-center gap-2 truncate bg-canvas px-4 text-left hover:text-ink md:px-6"
                      >
                        <ProjectDot color={p.color} />
                        <span className="truncate">{p.name}</span>
                      </button>
                      <div className="relative h-full" style={{ width }}>
                        {end ? (
                          <button
                            type="button"
                            aria-label={`${p.name} timeline`}
                            onClick={() => navigate(paths.project(p.id))}
                            className="absolute top-2.5 h-5 overflow-hidden rounded"
                            style={{
                              left: x(start),
                              width: Math.max(x(end) - x(start), 8),
                              background: `${p.color}33`,
                              border: `1px solid ${p.color}`,
                            }}
                          >
                            <span
                              className="block h-full animate-grow-x transition-[width] duration-500 ease-snappy"
                              style={{
                                width: `${Math.round(p.progress.progress * 100)}%`,
                                background: `${p.color}88`,
                              }}
                            />
                          </button>
                        ) : (
                          <span
                            className="absolute top-3 text-[11px] text-faint"
                            style={{ left: x(start) }}
                          >
                            No target date
                          </span>
                        )}
                        {p.projectMilestones.nodes
                          .filter((m) => m.targetDate)
                          .map((m) => (
                            <span
                              key={m.id}
                              title={`${m.name} · ${m.targetDate}`}
                              className="absolute top-3.5 size-2.5 rotate-45 border border-ink bg-panel"
                              style={{ left: x(day(m.targetDate ?? "")) - 5 }}
                            />
                          ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
