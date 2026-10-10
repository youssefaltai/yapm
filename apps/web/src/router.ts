import { useSyncExternalStore } from "react";

// A tiny history router: the app has a handful of Linear-style routes, so a library isn't worth it.

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(path: string, options: { replace?: boolean } = {}) {
  if (path === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export type RequestsTab = "pending" | "answered" | "grants";
export type RunsTab = "active" | "all";
export type TeamView = "all" | "active" | "backlog" | "triage";

export type Route =
  | { name: "inbox" }
  | { name: "myIssues"; tab: "assigned" | "created" }
  | { name: "team"; key: string; view: TeamView }
  | { name: "cycles"; key: string }
  | { name: "cycle"; id: string }
  | { name: "teamSettings"; key: string }
  | { name: "view"; id: string }
  | { name: "issue"; identifier: string }
  | { name: "company" }
  | { name: "member"; id: string }
  | { name: "requests"; tab: RequestsTab }
  | { name: "request"; id: string }
  | { name: "runs"; tab: RunsTab }
  | { name: "run"; id: string }
  | { name: "machines" }
  | { name: "machine"; id: string }
  | { name: "projects" }
  | { name: "project"; id: string; tab: "overview" | "issues" }
  | { name: "initiatives" }
  | { name: "roadmap" }
  | { name: "handbook" }
  | { name: "insights" }
  | { name: "usage" }
  | { name: "documents" }
  | { name: "document"; id: string }
  | { name: "notFound" };

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second, third] = parts;
  if (!first || first === "inbox") return { name: "inbox" };
  if (first === "my-issues")
    return { name: "myIssues", tab: second === "created" ? "created" : "assigned" };
  if (first === "company") return { name: "company" };
  if (first === "member" && second) return { name: "member", id: second };
  if (first === "approvals")
    return {
      name: "requests",
      tab: second === "answered" || second === "grants" ? second : "pending",
    };
  if (first === "request" && second) return { name: "request", id: second };
  if (first === "runs") return { name: "runs", tab: second === "all" ? "all" : "active" };
  if (first === "run" && second) return { name: "run", id: second };
  if (first === "machines") return { name: "machines" };
  if (first === "machine" && second) return { name: "machine", id: second };
  if (first === "projects") return { name: "projects" };
  if (first === "project" && second)
    return { name: "project", id: second, tab: third === "issues" ? "issues" : "overview" };
  if (first === "initiatives") return { name: "initiatives" };
  if (first === "roadmap") return { name: "roadmap" };
  if (first === "handbook") return { name: "handbook" };
  if (first === "insights") return { name: "insights" };
  if (first === "usage") return { name: "usage" };
  if (first === "documents") return { name: "documents" };
  if (first === "document" && second) return { name: "document", id: second };
  if (first === "issue" && second) return { name: "issue", identifier: second.toUpperCase() };
  if (first === "cycle" && second) return { name: "cycle", id: second };
  if (first === "view" && second) return { name: "view", id: second };
  if (first === "team" && second && third === "cycles")
    return { name: "cycles", key: second.toUpperCase() };
  if (first === "team" && second && third === "settings")
    return { name: "teamSettings", key: second.toUpperCase() };
  if (first === "team" && second) {
    const view = third === "active" || third === "backlog" || third === "triage" ? third : "all";
    return { name: "team", key: second.toUpperCase(), view };
  }
  return { name: "notFound" };
}

export const paths = {
  inbox: () => "/inbox",
  myIssues: (tab: "assigned" | "created" = "assigned") =>
    tab === "assigned" ? "/my-issues" : "/my-issues/created",
  team: (key: string, view: TeamView = "all") =>
    view === "all" ? `/team/${key}` : `/team/${key}/${view}`,
  cycles: (key: string) => `/team/${key}/cycles`,
  cycle: (id: string) => `/cycle/${id}`,
  teamSettings: (key: string) => `/team/${key}/settings`,
  view: (id: string) => `/view/${id}`,
  issue: (identifier: string) => `/issue/${identifier}`,
  company: () => "/company",
  member: (id: string) => `/member/${id}`,
  requests: (tab: RequestsTab = "pending") =>
    tab === "pending" ? "/approvals" : `/approvals/${tab}`,
  request: (id: string) => `/request/${id}`,
  runs: (tab: RunsTab = "active") => (tab === "active" ? "/runs" : "/runs/all"),
  run: (id: string) => `/run/${id}`,
  machines: () => "/machines",
  machine: (id: string) => `/machine/${id}`,
  projects: () => "/projects",
  project: (id: string, tab: "overview" | "issues" = "overview") =>
    tab === "overview" ? `/project/${id}` : `/project/${id}/issues`,
  initiatives: () => "/initiatives",
  roadmap: () => "/roadmap",
  handbook: () => "/handbook",
  insights: () => "/insights",
  usage: () => "/usage",
  documents: () => "/documents",
  document: (id: string) => `/document/${id}`,
};
