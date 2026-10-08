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

export type Route =
  | { name: "myIssues"; tab: "assigned" | "created" }
  | { name: "team"; key: string; view: "all" | "active" | "backlog" }
  | { name: "issue"; identifier: string }
  | { name: "company" }
  | { name: "member"; id: string }
  | { name: "requests"; tab: RequestsTab }
  | { name: "request"; id: string }
  | { name: "notFound" };

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second, third] = parts;
  if (!first) return { name: "myIssues", tab: "assigned" };
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
  if (first === "issue" && second) return { name: "issue", identifier: second.toUpperCase() };
  if (first === "team" && second) {
    const view = third === "active" || third === "backlog" ? third : "all";
    return { name: "team", key: second.toUpperCase(), view };
  }
  return { name: "notFound" };
}

export const paths = {
  myIssues: (tab: "assigned" | "created" = "assigned") =>
    tab === "assigned" ? "/my-issues" : "/my-issues/created",
  team: (key: string, view: "all" | "active" | "backlog" = "all") =>
    view === "all" ? `/team/${key}` : `/team/${key}/${view}`,
  issue: (identifier: string) => `/issue/${identifier}`,
  company: () => "/company",
  member: (id: string) => `/member/${id}`,
  requests: (tab: RequestsTab = "pending") =>
    tab === "pending" ? "/approvals" : `/approvals/${tab}`,
  request: (id: string) => `/request/${id}`,
};
