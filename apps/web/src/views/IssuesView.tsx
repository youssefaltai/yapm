import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveIssues,
  assigneeMenu,
  createIssueStore,
  cycleMenu,
  estimateMenu,
  labelsMenu,
  priorityMenu,
  projectMenu,
  statusMenu,
  targetStore,
  workspaceStore,
} from "../actions.js";
import { promptDialog } from "../controls.js";
import {
  ISSUE_FIELDS,
  type Issue,
  mutate,
  PRIORITIES,
  priorityRank,
  type StateType,
  type Team,
  toast,
  updateIssues,
  useQuery,
  type WorkflowState,
} from "../data.js";
import { navigate, paths, type TeamView } from "../router.js";
import {
  Avatar,
  dueLabel,
  Kbd,
  LabelChip,
  type MenuItem,
  type MenuSpec,
  openMenu,
  PriorityIcon,
  SlaBadge,
  StatusIcon,
  shortDate,
  UnassignedIcon,
  useHotkeys,
  useStore,
} from "../ui.js";

export type IssueSource =
  | { kind: "team"; team: Team; view: TeamView }
  | { kind: "my"; tab: "assigned" | "created" }
  | { kind: "project"; project: { id: string; name: string } }
  | { kind: "cycle"; cycle: { id: string }; team: Team }
  | { kind: "view"; view: { id: string; name: string; teamId: string | null } };

/** The team whose workflow the issues follow, when the list is one team's. */
function teamOf(source: IssueSource): Team | null {
  return source.kind === "team" || source.kind === "cycle" ? source.team : null;
}

interface Filters {
  stateTypes: StateType[];
  priorities: number[];
  assigneeIds: string[];
  labelIds: string[];
}

const NO_FILTERS: Filters = { stateTypes: [], priorities: [], assigneeIds: [], labelIds: [] };

const STATE_TYPES: { type: StateType; label: string; color: string }[] = [
  { type: "triage", label: "Triage", color: "#fc7840" },
  { type: "backlog", label: "Backlog", color: "#bec2c8" },
  { type: "unstarted", label: "Todo", color: "#e2e2e2" },
  { type: "started", label: "In Progress", color: "#f2c94c" },
  { type: "completed", label: "Done", color: "#5e6ad2" },
  { type: "canceled", label: "Canceled", color: "#95a2b3" },
];

const VIEW_TYPES: Record<TeamView, StateType[] | null> = {
  all: null,
  active: ["unstarted", "started"],
  backlog: ["triage", "backlog"],
  triage: ["triage"],
};

/** Turns the toolbar's filters into Linear's IssueFilter. */
function toIssueFilter(filters: Filters, viewTypes: StateType[] | null) {
  const and: Record<string, unknown>[] = [];
  if (viewTypes) and.push({ state: { type: { in: viewTypes } } });
  if (filters.stateTypes.length) and.push({ state: { type: { in: filters.stateTypes } } });
  if (filters.priorities.length) and.push({ priority: { in: filters.priorities } });
  if (filters.assigneeIds.length) {
    const ids = filters.assigneeIds.filter((id) => id !== "none");
    const or: Record<string, unknown>[] = [];
    if (ids.length) or.push({ assignee: { id: { in: ids } } });
    if (filters.assigneeIds.includes("none")) or.push({ assignee: { null: true } });
    and.push({ or });
  }
  if (filters.labelIds.length) and.push({ labels: { some: { id: { in: filters.labelIds } } } });
  return and.length ? { and } : null;
}

function readLayout(key: string): "list" | "board" {
  try {
    return localStorage.getItem(`layout:${key}`) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

const SOURCE_QUERIES: Record<Exclude<IssueSource["kind"], "my">, string> = {
  team: "team(id: $key)",
  project: "project(id: $key)",
  cycle: "cycle(id: $key)",
  view: "customView(id: $key)",
};

function sourceId(source: IssueSource) {
  switch (source.kind) {
    case "team":
      return source.team.key;
    case "project":
      return source.project.id;
    case "cycle":
      return source.cycle.id;
    case "view":
      return source.view.id;
    case "my":
      return source.tab;
  }
}

export function IssuesView({
  source,
  title,
  tabs,
  banner,
}: {
  source: IssueSource;
  title: ReactNode;
  tabs: ReactNode;
  /** Shown above the list, e.g. a cycle's chart. */
  banner?: ReactNode;
}) {
  const sourceKey = `${source.kind}:${sourceId(source)}`;
  const team = teamOf(source);
  const [layout, setLayoutState] = useState<"list" | "board">(() => readLayout(sourceKey));
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const setLayout = (next: "list" | "board") => {
    setLayoutState(next);
    try {
      localStorage.setItem(`layout:${sourceKey}`, next);
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  };

  const viewTypes = source.kind === "team" ? VIEW_TYPES[source.view] : null;
  const filter = toIssueFilter(filters, viewTypes);
  const query =
    source.kind === "my"
      ? `query($filter: IssueFilter) { source: viewer { issues: ${source.tab === "assigned" ? "assignedIssues" : "createdIssues"}(first: 250, filter: $filter) { nodes { ...IssueFields } } } } ${ISSUE_FIELDS}`
      : `query($key: String!, $filter: IssueFilter) { source: ${SOURCE_QUERIES[source.kind]} { issues(first: 250, filter: $filter) { nodes { ...IssueFields } } } } ${ISSUE_FIELDS}`;
  const { data, error } = useQuery<{ source: { issues: { nodes: Issue[] } } }>(
    query,
    source.kind === "my" ? { filter } : { key: sourceId(source), filter },
  );
  const issues = useMemo(
    () =>
      [...(data?.source.issues.nodes ?? [])].sort(
        (a, b) =>
          priorityRank(a.priority) - priorityRank(b.priority) ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
    [data],
  );

  const groups = useMemo(
    () => groupIssues(issues, source, viewTypes, layout),
    [issues, source, viewTypes, layout],
  );
  const ordered = useMemo(() => groups.flatMap((g) => g.issues), [groups]);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const focused = ordered.find((i) => i.id === focusedId) ?? null;
  const selectedIssues = ordered.filter((i) => selected.has(i.id));
  const targets = selectedIssues.length ? selectedIssues : focused ? [focused] : [];

  useEffect(() => {
    targetStore.set(targets);
  });
  useEffect(() => () => targetStore.set([]), []);

  const move = (delta: number) => {
    if (!ordered.length) return;
    const index = focused ? ordered.indexOf(focused) : -1;
    const next = ordered[Math.min(Math.max(index + delta, 0), ordered.length - 1)];
    if (next) {
      setFocusedId(next.id);
      document.getElementById(`issue-${next.id}`)?.scrollIntoView({ block: "nearest" });
    }
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const withTargets = (menu: (issues: Issue[]) => MenuSpec | undefined) => () => {
    const spec = targets.length ? menu(targets) : undefined;
    if (spec) openMenu(spec);
  };

  useHotkeys({
    j: () => move(1),
    ArrowDown: () => move(1),
    k: () => move(-1),
    ArrowUp: () => move(-1),
    x: () => focused && toggle(focused.id),
    "mod+a": () => setSelected(new Set(ordered.map((i) => i.id))),
    Escape: () => (selected.size ? setSelected(new Set()) : setFocusedId(null)),
    Enter: () => focused && navigate(paths.issue(focused.identifier)),
    o: () => focused && navigate(paths.issue(focused.identifier)),
    s: withTargets(statusMenu),
    p: withTargets(priorityMenu),
    a: withTargets(assigneeMenu),
    l: withTargets(labelsMenu),
    e: withTargets(estimateMenu),
    "shift+p": () => targets.length && void projectMenu(targets).then(openMenu),
    "shift+c": () =>
      targets.length && void cycleMenu(targets).then((spec) => spec && openMenu(spec)),
    "mod+b": () => setLayout(layout === "list" ? "board" : "list"),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4 md:px-6">
        <div className="flex shrink-0 items-center gap-2 font-medium whitespace-nowrap">
          {title}
        </div>
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">{tabs}</div>
        <div className="ml-auto flex items-center gap-1">
          {filter && source.kind !== "view" && (
            <button
              type="button"
              onClick={() => void saveView(filter, source)}
              className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
            >
              Save view
            </button>
          )}
          <FilterButton filters={filtersRef} setFilters={setFilters} team={team} />
          <fieldset className="flex rounded-md border border-line p-0.5" aria-label="Layout">
            {(["list", "board"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={layout === option}
                onClick={() => setLayout(option)}
                className={`rounded px-2 py-0.5 capitalize ${layout === option ? "bg-raised text-ink" : "text-faint hover:text-muted"}`}
              >
                {option}
              </button>
            ))}
          </fieldset>
        </div>
      </header>
      <FilterChips filters={filters} setFilters={setFilters} />
      {banner}

      {error && <p className="px-6 py-4 text-red-400">{error}</p>}
      {data && issues.length === 0 && (
        <EmptyState
          filtered={filter !== null}
          onCreate={() =>
            createIssueStore.set(
              source.kind === "project"
                ? { projectId: source.project.id }
                : source.kind === "cycle"
                  ? { teamId: source.team.id, cycleId: source.cycle.id }
                  : team
                    ? { teamId: team.id }
                    : {},
            )
          }
        />
      )}
      {issues.length > 0 && layout === "list" && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-24">
          {groups.map((group) =>
            group.issues.length === 0 ? null : (
              <section key={group.key} aria-label={group.label}>
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-raised/95 px-4 py-1.5 backdrop-blur md:px-6">
                  <StatusIcon type={group.type} color={group.color} />
                  <span className="font-medium">{group.label}</span>
                  <span className="text-faint">{group.issues.length}</span>
                  {team && group.state && (
                    <button
                      type="button"
                      aria-label={`New issue in ${group.label}`}
                      onClick={() =>
                        createIssueStore.set({
                          teamId: team.id,
                          stateId: group.state?.id,
                          ...(source.kind === "cycle" ? { cycleId: source.cycle.id } : {}),
                        })
                      }
                      className="ml-auto px-1 text-faint hover:text-ink"
                    >
                      +
                    </button>
                  )}
                </div>
                {group.issues.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    focused={issue.id === focusedId}
                    selected={selected.has(issue.id)}
                    onFocus={() => setFocusedId(issue.id)}
                    onToggle={() => toggle(issue.id)}
                    showTeam={!team}
                    triage={issue.state.type === "triage" ? team : null}
                  />
                ))}
              </section>
            ),
          )}
        </div>
      )}
      {data && layout === "board" && issues.length > 0 && (
        <Board
          groups={groups}
          source={source}
          focusedId={focusedId}
          selected={selected}
          onFocus={setFocusedId}
          onToggle={toggle}
        />
      )}
      {selected.size > 0 && (
        <BulkBar issues={selectedIssues} onClear={() => setSelected(new Set())} />
      )}
    </div>
  );
}

interface Group {
  key: string;
  label: string;
  type: StateType;
  color: string;
  state: WorkflowState | null;
  issues: Issue[];
}

function groupIssues(
  issues: Issue[],
  source: IssueSource,
  viewTypes: StateType[] | null,
  layout: "list" | "board",
): Group[] {
  const team = teamOf(source);
  const groups: Group[] = team
    ? team.states.nodes.map((state) => ({
        key: state.id,
        label: state.name,
        type: state.type,
        color: state.color,
        state,
        issues: [],
      }))
    : STATE_TYPES.map((t) => ({
        key: t.type,
        label: t.label,
        type: t.type,
        color: t.color,
        state: null,
        issues: [],
      }));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const issue of issues) {
    byKey.get(team ? issue.state.id : issue.state.type)?.issues.push(issue);
  }
  // Boards show every column the view allows, even empty ones, so issues can be dragged there.
  // Like Linear, an empty Triage column stays hidden.
  return groups.filter((g) =>
    layout === "board"
      ? (!viewTypes || viewTypes.includes(g.type)) && (g.type !== "triage" || g.issues.length > 0)
      : g.issues.length > 0,
  );
}

/** Saves the current filters as a view everyone can open from the sidebar. */
async function saveView(filter: Record<string, unknown>, source: IssueSource) {
  const name = await promptDialog({
    title: "Save as view",
    label: "View name",
    placeholder: "e.g. Urgent bugs",
    confirmLabel: "Save view",
  });
  if (!name) return;
  const team = teamOf(source);
  const scoped =
    source.kind === "project"
      ? { and: [{ project: { id: { eq: source.project.id } } }, filter] }
      : source.kind === "my"
        ? {
            and: [
              { [source.tab === "assigned" ? "assignee" : "creator"]: { isMe: { eq: true } } },
              filter,
            ],
          }
        : source.kind === "cycle"
          ? { and: [{ cycle: { id: { eq: source.cycle.id } } }, filter] }
          : filter;
  const data = await mutate<{ customViewCreate: { customView: { id: string } } }>(
    "mutation($input: CustomViewCreateInput!) { customViewCreate(input: $input) { customView { id } } }",
    { input: { name, filterData: scoped, ...(team ? { teamId: team.id } : {}) } },
  );
  if (data) {
    toast(`Saved view “${name}”`);
    navigate(paths.view(data.customViewCreate.customView.id));
  }
}

/** Triage: accept into the team's first unstarted state, or decline as canceled. */
function TriageActions({ issue, team }: { issue: Issue; team: Team }) {
  const states = team.states.nodes;
  const accept =
    states.find((s) => s.type === "unstarted") ?? states.find((s) => s.type === "backlog");
  const decline = states.find((s) => s.type === "canceled");
  const button = (label: string, stateId: string | undefined) =>
    stateId && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void updateIssues([issue.id], { stateId });
        }}
        className="rounded-md border border-line px-2 py-0.5 text-[12px] text-muted hover:bg-raised hover:text-ink"
      >
        {label}
      </button>
    );
  return (
    <span className="flex shrink-0 items-center gap-1">
      {button("Accept", accept?.id)}
      {button("Decline", decline?.id)}
    </span>
  );
}

function IssueRow({
  issue,
  focused,
  selected,
  onFocus,
  onToggle,
  showTeam,
  triage,
}: {
  issue: Issue;
  focused: boolean;
  selected: boolean;
  onFocus: () => void;
  onToggle: () => void;
  showTeam: boolean;
  /** The team, when the issue waits in its Triage. */
  triage: Team | null;
}) {
  const due = issue.dueDate ? dueLabel(issue.dueDate) : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row holds its own controls, so it can't be one button
    <div
      id={`issue-${issue.id}`}
      role="button"
      tabIndex={-1}
      onMouseEnter={onFocus}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) onToggle();
        else navigate(paths.issue(issue.identifier));
      }}
      onKeyDown={() => undefined}
      className={`group flex h-10 animate-fade-in cursor-default items-center gap-2.5 border-b border-line/60 px-4 md:px-6 ${
        selected ? "bg-accent/10" : focused ? "bg-raised" : ""
      }`}
    >
      <input
        type="checkbox"
        aria-label={`Select ${issue.identifier}`}
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
        className={`size-3.5 shrink-0 accent-accent ${selected ? "" : "opacity-0 group-hover:opacity-100"} max-md:hidden`}
      />
      <PriorityIcon priority={issue.priority} />
      <span className="w-14 shrink-0 text-faint max-sm:hidden">{issue.identifier}</span>
      <StatusIcon type={issue.state.type} color={issue.state.color} />
      <span className="min-w-0 flex-1 truncate">
        {issue.title}
        {issue.parent && (
          <span className="ml-2 text-faint max-sm:hidden">› {issue.parent.title}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 max-lg:hidden">
        {issue.labels.nodes.slice(0, 3).map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
      </span>
      <SlaBadge
        breachesAt={issue.slaBreachesAt}
        open={issue.state.type !== "completed" && issue.state.type !== "canceled"}
      />
      {due && (
        <span className={`shrink-0 text-[12px] ${due.overdue ? "text-red-400" : "text-muted"}`}>
          {due.text}
        </span>
      )}
      {issue.estimate != null && (
        <span className="shrink-0 text-[12px] text-faint max-sm:hidden">{issue.estimate}</span>
      )}
      {showTeam && (
        <span className="shrink-0 text-[11px] text-faint max-sm:hidden">{issue.team.key}</span>
      )}
      {triage && <TriageActions issue={issue} team={triage} />}
      <span className="w-12 shrink-0 text-right text-[12px] text-faint max-md:hidden">
        {shortDate(issue.createdAt)}
      </span>
      {issue.assignee ? (
        <Avatar name={issue.assignee.name} kind={issue.assignee.kind} />
      ) : (
        <UnassignedIcon />
      )}
    </div>
  );
}

function Board({
  groups,
  source,
  focusedId,
  selected,
  onFocus,
  onToggle,
}: {
  groups: Group[];
  source: IssueSource;
  focusedId: string | null;
  selected: Set<string>;
  onFocus: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const teams = useStore(workspaceStore)?.teams.nodes ?? [];
  const team = teamOf(source);

  function drop(group: Group, issueId: string) {
    setOver(null);
    const issue = groups.flatMap((g) => g.issues).find((i) => i.id === issueId);
    if (!issue) return;
    // Across teams (My issues), a column is a state category: use the issue's team's state of that type.
    const state =
      group.state ??
      teams.find((t) => t.id === issue.team.id)?.states.nodes.find((s) => s.type === group.type) ??
      null;
    if (state && state.id !== issue.state.id) void updateIssues([issue.id], { stateId: state.id });
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:px-6">
      {groups.map((group) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: drop target for dragged cards
        <div
          key={group.key}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(group.key);
          }}
          onDragLeave={() => setOver((o) => (o === group.key ? null : o))}
          onDrop={(e) => drop(group, e.dataTransfer.getData("text/issue-id"))}
          className={`flex w-72 shrink-0 flex-col rounded-lg transition-colors duration-150 ${over === group.key ? "bg-raised" : ""}`}
        >
          <div className="flex items-center gap-2 px-2 py-2">
            <StatusIcon type={group.type} color={group.color} />
            <span className="font-medium">{group.label}</span>
            <span className="text-faint">{group.issues.length}</span>
            {team && group.state && (
              <button
                type="button"
                aria-label={`New issue in ${group.label}`}
                onClick={() =>
                  createIssueStore.set({
                    teamId: team.id,
                    stateId: group.state?.id,
                    ...(source.kind === "cycle" ? { cycleId: source.cycle.id } : {}),
                  })
                }
                className="ml-auto px-1 text-faint hover:text-ink"
              >
                +
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-1 pb-4">
            {group.issues.map((issue) => (
              <BoardCard
                key={issue.id}
                issue={issue}
                focused={issue.id === focusedId}
                selected={selected.has(issue.id)}
                onFocus={() => onFocus(issue.id)}
                onToggle={() => onToggle(issue.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BoardCard({
  issue,
  focused,
  selected,
  onFocus,
  onToggle,
}: {
  issue: Issue;
  focused: boolean;
  selected: boolean;
  onFocus: () => void;
  onToggle: () => void;
}) {
  const due = issue.dueDate ? dueLabel(issue.dueDate) : null;
  const [dragging, setDragging] = useState(false);
  return (
    <button
      type="button"
      id={`issue-${issue.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/issue-id", issue.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onMouseEnter={onFocus}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) onToggle();
        else navigate(paths.issue(issue.identifier));
      }}
      className={`block w-full animate-fade-in rounded-lg border bg-panel p-3 text-left ${
        selected ? "border-accent" : focused ? "border-faint" : "border-line"
      } ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-center justify-between text-faint">
        <span>{issue.identifier}</span>
        {issue.assignee ? (
          <Avatar name={issue.assignee.name} kind={issue.assignee.kind} />
        ) : (
          <UnassignedIcon />
        )}
      </div>
      <p className="mt-1.5 line-clamp-3">{issue.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-line p-0.5">
          <PriorityIcon priority={issue.priority} size={12} />
        </span>
        {issue.labels.nodes.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
        {due && (
          <span className={`text-[12px] ${due.overdue ? "text-red-400" : "text-muted"}`}>
            {due.text}
          </span>
        )}
      </div>
    </button>
  );
}

function BulkBar({ issues, onClear }: { issues: Issue[]; onClear: () => void }) {
  const open = (menu: (issues: Issue[]) => MenuSpec | undefined) => () => {
    const spec = menu(issues);
    if (spec) openMenu(spec);
  };
  const actions: [string, string, () => void][] = [
    ["Status", "S", open(statusMenu)],
    ["Priority", "P", open(priorityMenu)],
    ["Assignee", "A", open(assigneeMenu)],
    ["Labels", "L", open(labelsMenu)],
  ];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-3">
      <div className="pointer-events-auto flex animate-rise-in items-center gap-1 rounded-xl border border-line bg-panel px-2 py-1.5 shadow-2xl">
        <span className="px-2 font-medium">{issues.length} selected</span>
        {actions.map(([label, key, action]) => (
          <button
            key={label}
            type="button"
            onClick={action}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
          >
            {label} <Kbd>{key}</Kbd>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            void archiveIssues(issues);
            onClear();
          }}
          className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
        >
          Archive
        </button>
        <button
          type="button"
          aria-label="Clear selection"
          onClick={onClear}
          className="rounded-md px-2 py-1 text-faint hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function EmptyState({ filtered, onCreate }: { filtered: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-1 animate-fade-in flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-muted">
        {filtered ? "No issues match these filters." : "No issues here yet."}
      </p>
      {!filtered && (
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 hover:bg-raised"
        >
          Create issue <Kbd>C</Kbd>
        </button>
      )}
    </div>
  );
}

// Filters -------------------------------------------------------------------

type FilterField = keyof Filters;

function FilterButton({
  filters,
  setFilters,
  team,
}: {
  filters: React.RefObject<Filters>;
  setFilters: (f: Filters) => void;
  team: Team | null;
}) {
  const workspace = useStore(workspaceStore);

  function toggleMenu<T extends string | number>(
    field: FilterField,
    placeholder: string,
    options: { value: T; label: string; icon?: ReactNode }[],
  ): MenuSpec {
    const build = (): MenuItem[] =>
      options.map((option) => ({
        id: String(option.value),
        label: option.label,
        icon: option.icon,
        checked: (filters.current[field] as T[]).includes(option.value),
        onSelect: () => {
          const current = filters.current[field] as T[];
          const next = current.includes(option.value)
            ? current.filter((v) => v !== option.value)
            : [...current, option.value];
          const updated = { ...filters.current, [field]: next };
          filters.current = updated;
          setFilters(updated);
        },
      }));
    return { placeholder, items: build(), multi: true, refresh: build };
  }

  const labels = team
    ? team.labels.nodes
    : [
        ...new Map(
          (workspace?.teams.nodes ?? []).flatMap((t) => t.labels.nodes).map((l) => [l.id, l]),
        ).values(),
      ];

  return (
    <button
      type="button"
      onClick={() =>
        openMenu({
          placeholder: "Filter by…",
          items: [
            {
              id: "status",
              label: "Status",
              onSelect: () =>
                toggleMenu(
                  "stateTypes",
                  "Filter by status…",
                  STATE_TYPES.map((t) => ({
                    value: t.type,
                    label: t.label,
                    icon: <StatusIcon type={t.type} color={t.color} />,
                  })),
                ),
            },
            {
              id: "priority",
              label: "Priority",
              onSelect: () =>
                toggleMenu(
                  "priorities",
                  "Filter by priority…",
                  PRIORITIES.map((p) => ({
                    value: p.value,
                    label: p.label,
                    icon: <PriorityIcon priority={p.value} />,
                  })),
                ),
            },
            {
              id: "assignee",
              label: "Assignee",
              onSelect: () =>
                toggleMenu("assigneeIds", "Filter by assignee…", [
                  { value: "none", label: "No assignee", icon: <UnassignedIcon size={16} /> },
                  ...(workspace?.users.nodes ?? []).map((m) => ({
                    value: m.id,
                    label: m.name,
                    icon: <Avatar name={m.name} kind={m.kind} size={16} />,
                  })),
                ]),
            },
            {
              id: "labels",
              label: "Labels",
              onSelect: () =>
                toggleMenu(
                  "labelIds",
                  "Filter by label…",
                  labels.map((l) => ({
                    value: l.id,
                    label: l.name,
                    icon: (
                      <span className="size-2.5 rounded-full" style={{ background: l.color }} />
                    ),
                  })),
                ),
            },
          ],
        })
      }
      className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
    >
      Filter
    </button>
  );
}

function FilterChips({
  filters,
  setFilters,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
}) {
  const workspace = useStore(workspaceStore);
  const allLabels = (workspace?.teams.nodes ?? []).flatMap((t) => t.labels.nodes);
  const chips: { field: FilterField; label: string; values: string[] }[] = [
    {
      field: "stateTypes",
      label: "Status",
      values: filters.stateTypes.map((t) => STATE_TYPES.find((s) => s.type === t)?.label ?? t),
    },
    {
      field: "priorities",
      label: "Priority",
      values: filters.priorities.map(
        (p) => PRIORITIES.find((x) => x.value === p)?.label ?? String(p),
      ),
    },
    {
      field: "assigneeIds",
      label: "Assignee",
      values: filters.assigneeIds.map((id) =>
        id === "none"
          ? "No assignee"
          : (workspace?.users.nodes.find((u) => u.id === id)?.name ?? "?"),
      ),
    },
    {
      field: "labelIds",
      label: "Labels",
      values: filters.labelIds.map((id) => allLabels.find((l) => l.id === id)?.name ?? "?"),
    },
  ].filter((chip) => chip.values.length) as {
    field: FilterField;
    label: string;
    values: string[];
  }[];
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 md:px-6">
      {chips.map((chip) => (
        <span
          key={chip.field}
          className="flex items-center gap-1 rounded-md border border-line text-[12px]"
        >
          <span className="py-0.5 pl-2 text-muted">
            {chip.label} {chip.values.length > 1 ? "is any of" : "is"}{" "}
            <span className="text-ink">{chip.values.join(", ")}</span>
          </span>
          <button
            type="button"
            aria-label={`Remove ${chip.label} filter`}
            onClick={() => setFilters({ ...filters, [chip.field]: [] })}
            className="px-1.5 py-0.5 text-faint hover:text-ink"
          >
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => setFilters(NO_FILTERS)}
        className="text-[12px] text-faint hover:text-ink"
      >
        Clear
      </button>
    </div>
  );
}
