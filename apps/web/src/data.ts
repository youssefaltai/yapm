import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { graphql } from "./api.js";

export type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface WorkflowState {
  id: string;
  name: string;
  type: StateType;
  color: string;
  position: number;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Member {
  id: string;
  name: string;
  kind: "owner" | "agent";
  title: string | null;
  isMe: boolean;
  manager: { id: string } | null;
}

export interface Team {
  id: string;
  key: string;
  name: string;
  description: string | null;
  lead: { id: string; name: string } | null;
  members: { nodes: { id: string }[] };
  states: { nodes: WorkflowState[] };
  labels: { nodes: Label[] };
  triageEnabled: boolean;
  cyclesEnabled: boolean;
  cycleDuration: number;
  cycleStartDay: number;
  cycleCooldownTime: number;
  upcomingCycleCount: number;
  slaHours: Record<string, number> | null;
  autoArchivePeriod: number;
  templates: IssueTemplate[];
}

export interface Schedule {
  frequency: "daily" | "weekdays" | "weekly" | "monthly";
  time: string;
  weekday: number | null;
  monthDay: number | null;
  description?: string;
}

export interface IssueTemplate {
  id: string;
  name: string;
  templateData: {
    title?: string;
    description?: string;
    priority?: number;
    assigneeId?: string;
    labelIds?: string[];
    stateId?: string;
  };
  schedule: Schedule | null;
  nextRunAt: string | null;
}

export interface SavedView {
  id: string;
  name: string;
  shared: boolean;
  filterData: Record<string, unknown>;
  team: { id: string } | null;
}

export interface Workspace {
  organization: { name: string; timezone: string };
  customViews: { nodes: SavedView[] };
  viewer: { id: string; name: string; kind: "owner" | "agent" };
  teams: { nodes: Team[] };
  users: { nodes: Member[] };
}

export const WORKSPACE_QUERY = `{
  organization { name timezone }
  viewer { id name kind }
  customViews { nodes { id name shared filterData team { id } } }
  teams {
    nodes {
      id key name description
      lead { id name }
      members { nodes { id } }
      states { nodes { id name type color position } }
      labels { nodes { id name color } }
      triageEnabled cyclesEnabled cycleDuration cycleStartDay cycleCooldownTime upcomingCycleCount
      slaHours autoArchivePeriod
      templates { id name templateData nextRunAt schedule { frequency time weekday monthDay description } }
    }
  }
  users { nodes { id name kind title isMe manager { id } } }
}`;

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  team: { id: string; key: string };
  state: WorkflowState;
  assignee: { id: string; name: string; kind: "owner" | "agent" } | null;
  labels: { nodes: Label[] };
  parent: { id: string; identifier: string; title: string } | null;
  project: { id: string; name: string; color: string } | null;
  projectMilestone: { id: string; name: string } | null;
  cycle: { id: string; number: number; name: string | null } | null;
  slaBreachesAt: string | null;
}

export const ISSUE_FIELDS = `
  fragment IssueFields on Issue {
    id identifier title priority estimate dueDate createdAt updatedAt completedAt archivedAt
    team { id key }
    state { id name type color position }
    assignee { id name kind }
    labels { nodes { id name color } }
    parent { id identifier title }
    project { id name color }
    projectMilestone { id name }
    cycle { id number name }
    slaBreachesAt
  }
`;

// Every mounted query registers here; mutations call `invalidate()` so all views refetch.
const reloaders = new Set<() => unknown>();

/** Refetches every view; settles once they've all landed. */
export function invalidate() {
  return Promise.allSettled([...reloaders].map((reload) => reload()));
}

// Changes shown before the hub confirms them, like Linear: each patches the issues it names
// wherever they appear in a query's result, until the refetch after it lands.
type Patch = { ids: Set<string>; change: (issue: Issue) => Partial<Issue> };
let patches: Patch[] = [];
const patchListeners = new Set<() => void>();
const setPatches = (next: Patch[]) => {
  patches = next;
  for (const listener of patchListeners) listener();
};
const subscribePatches = (listener: () => void) => {
  patchListeners.add(listener);
  return () => {
    patchListeners.delete(listener);
  };
};

/** Applies the patches, keeping untouched objects as they are so their views don't re-render. */
function applyPatches<T>(value: T, list: Patch[]): T {
  if (!value || typeof value !== "object") return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, field]) => {
    const next = applyPatches(field, list);
    if (next !== field) changed = true;
    return [key, next] as const;
  });
  if (Array.isArray(value)) return (changed ? entries.map(([, item]) => item) : value) as T;
  let next = (changed ? Object.fromEntries(entries) : value) as Record<string, unknown>;
  const id = next.id;
  for (const patch of list) {
    if (typeof id === "string" && patch.ids.has(id))
      next = { ...next, ...patch.change(next as unknown as Issue) };
  }
  return next as T;
}

/** Runs `listener` whenever views refetch, for data kept outside `useQuery`. */
export function onInvalidate(listener: () => void) {
  reloaders.add(listener);
  return () => {
    reloaders.delete(listener);
  };
}

/** Runs a GraphQL query and keeps it fresh: it refetches whenever any mutation goes through. */
export function useQuery<T>(
  query: string | null,
  variables?: Record<string, unknown>,
  /** Also refetch on this interval, for things that change without a live event. */
  pollMs?: number,
) {
  const key = query ? `${query}\n${JSON.stringify(variables ?? {})}` : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({
    key: null,
    data: null,
    error: null,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` captures query and variables
  useEffect(() => {
    if (!query || !key) return;
    let alive = true;
    // Only the latest request may land: an older one finishing last would show stale data.
    let latest = 0;
    const run = (quiet = true) => {
      const request = ++latest;
      const current = () => alive && request === latest;
      return graphql<T>(query, variables, { quiet })
        .then((data) => current() && setState({ key, data, error: null }))
        .catch(
          (error: Error) => current() && setState((s) => ({ ...s, key, error: error.message })),
        );
    };
    run(false);
    reloaders.add(run);
    const timer = pollMs ? setInterval(run, pollMs) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
      reloaders.delete(run);
    };
  }, [key, pollMs]);

  // When the variables change (a new filter, another period), keep showing the last result until
  // the new one lands, like Linear, rather than blanking the view; `stale` says it's outdated.
  const current = state.key === key;
  const pending = useSyncExternalStore(subscribePatches, () => patches);
  const data = useMemo(
    () => (state.data && pending.length ? applyPatches(state.data, pending) : state.data),
    [state.data, pending],
  );
  return {
    data: key ? data : null,
    error: current ? state.error : null,
    stale: !current && state.data !== null,
  };
}

/** Runs a mutation, then refreshes every view. Errors go to the shared toast. */
export async function mutate<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T | null> {
  try {
    const data = await graphql<T>(query, variables);
    invalidate();
    return data;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export interface Toast {
  message: string;
  action?: { label: string; run: () => void };
}

const toastListeners = new Set<(toast: Toast | null) => void>();

/** Shows a short message at the bottom of the screen, like Linear's "Created PF-3". */
export function toast(message: string, action?: Toast["action"]) {
  for (const listener of toastListeners) listener({ message, ...(action ? { action } : {}) });
}

export function useToast() {
  const [current, setCurrent] = useState<Toast | null>(null);
  useEffect(() => {
    toastListeners.add(setCurrent);
    return () => {
      toastListeners.delete(setCurrent);
    };
  }, []);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent(null), 5000);
    return () => clearTimeout(timer);
  }, [current]);
  return { toast: current, dismiss: useCallback(() => setCurrent(null), []) };
}

const PLAIN_FIELDS = ["title", "priority", "estimate", "dueDate"] as const;

/**
 * Updates issues, showing the change at once: plain fields from `input`, plus `change` for the
 * related ones (state, assignee, labels). A failure rolls it back and says why.
 */
export async function updateIssues(
  ids: string[],
  input: Record<string, unknown>,
  change?: Partial<Issue> | ((issue: Issue) => Partial<Issue>),
) {
  const plain = Object.fromEntries(
    PLAIN_FIELDS.filter((f) => f in input).map((f) => [f, input[f]]),
  );
  const patch: Patch = {
    ids: new Set(ids),
    change: (issue) => ({
      ...plain,
      ...(typeof change === "function" ? change(issue) : change),
    }),
  };
  setPatches([...patches, patch]);
  const drop = () => setPatches(patches.filter((p) => p !== patch));
  // The API takes up to 50 issues per batch.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  try {
    await Promise.all(
      chunks.map((chunk) =>
        graphql(
          "mutation($ids: [String!]!, $input: IssueUpdateInput!) { issueBatchUpdate(ids: $ids, input: $input) { success } }",
          { ids: chunk, input },
          { quiet: true },
        ),
      ),
    );
  } catch (error) {
    drop();
    toast(error instanceof Error ? error.message : String(error));
    // Other chunks may have gone through.
    void invalidate();
    return;
  }
  await invalidate();
  drop();
}

export const PRIORITIES = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
] as const;

/** Linear's ordering for priority: urgent first, no priority last. */
export function priorityRank(priority: number) {
  return priority === 0 ? 5 : priority;
}
