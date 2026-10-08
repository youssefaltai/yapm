import { type ReactNode, useEffect, useState } from "react";
import { commandPalette, createIssueStore, createTeamStore, workspaceStore } from "./actions.js";
import type { Viewer } from "./api.js";
import { type Team, useQuery, useToast, WORKSPACE_QUERY, type Workspace } from "./data.js";
import { navigate, parseRoute, paths, type Route, usePath } from "./router.js";
import { Kbd, MenuHost, openMenu, useHotkeys } from "./ui.js";
import { Company } from "./views/Company.js";
import { CreateIssueHost } from "./views/CreateIssue.js";
import { CreateTeamHost } from "./views/CreateTeam.js";
import { IssuePage } from "./views/IssuePage.js";
import { IssuesView } from "./views/IssuesView.js";

export function Shell({ viewer, onSignOut }: { viewer: Viewer; onSignOut: () => void }) {
  const { data: workspace, error } = useQuery<Workspace>(WORKSPACE_QUERY);
  const path = usePath();
  const route = parseRoute(path);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (workspace) workspaceStore.set(workspace);
  }, [workspace]);
  // Close the mobile drawer on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on path change
  useEffect(() => setDrawer(false), [path]);

  const currentTeam =
    route.name === "team" ? workspace?.teams.nodes.find((t) => t.key === route.key) : undefined;
  useHotkeys({
    "mod+k": () => openMenu(commandPalette()),
    c: () => createIssueStore.set(currentTeam ? { teamId: currentTeam.id } : {}),
  });

  return (
    <div className="flex h-full">
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-line bg-panel px-3 py-3 md:static md:flex md:w-60 ${
          drawer ? "flex" : "hidden"
        }`}
      >
        <Sidebar workspace={workspace} viewer={viewer} route={route} onSignOut={onSignOut} />
      </aside>
      {drawer && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={() => setDrawer(false)}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
            className="text-muted"
          >
            ☰
          </button>
          <span className="truncate font-medium">{workspace?.organization.name}</span>
          <button
            type="button"
            aria-label="New issue"
            onClick={() => createIssueStore.set(currentTeam ? { teamId: currentTeam.id } : {})}
            className="ml-auto text-lg text-muted"
          >
            +
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {error && <p className="p-6 text-red-400">{error}</p>}
          {workspace && <RouteView route={route} workspace={workspace} />}
        </div>
      </main>
      <CreateIssueHost />
      <CreateTeamHost />
      <MenuHost />
      <ToastHost />
    </div>
  );
}

function RouteView({ route, workspace }: { route: Route; workspace: Workspace }) {
  switch (route.name) {
    case "myIssues":
      return (
        <IssuesView
          key={`my-${route.tab}`}
          source={{ kind: "my", tab: route.tab }}
          title="My issues"
          tabs={
            <>
              <Tab active={route.tab === "assigned"} to={paths.myIssues("assigned")}>
                Assigned
              </Tab>
              <Tab active={route.tab === "created"} to={paths.myIssues("created")}>
                Created
              </Tab>
            </>
          }
        />
      );
    case "team": {
      const team = workspace.teams.nodes.find((t) => t.key === route.key);
      if (!team) return <NotFound what="Team" />;
      return (
        <IssuesView
          key={`${team.id}-${route.view}`}
          source={{ kind: "team", team, view: route.view }}
          title={team.name}
          tabs={
            <>
              <Tab active={route.view === "all"} to={paths.team(team.key, "all")}>
                All issues
              </Tab>
              <Tab active={route.view === "active"} to={paths.team(team.key, "active")}>
                Active
              </Tab>
              <Tab active={route.view === "backlog"} to={paths.team(team.key, "backlog")}>
                Backlog
              </Tab>
            </>
          }
        />
      );
    }
    case "issue":
      return <IssuePage key={route.identifier} identifier={route.identifier} />;
    case "company":
      return <Company workspace={workspace} />;
    case "notFound":
      return <NotFound what="Page" />;
  }
}

function NotFound({ what }: { what: string }) {
  return <p className="px-6 py-10 text-center text-muted">{what} not found.</p>;
}

function Tab({ active, to, children }: { active: boolean; to: string; children: ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
      className={`shrink-0 rounded-md border px-2 py-0.5 ${
        active ? "border-line bg-raised text-ink" : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {children}
    </a>
  );
}

function Sidebar({
  workspace,
  viewer,
  route,
  onSignOut,
}: {
  workspace: Workspace | null;
  viewer: Viewer;
  route: Route;
  onSignOut: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <img src="/icon.svg" alt="" className="size-5" />
        <span className="truncate font-medium">{workspace?.organization.name ?? " "}</span>
      </div>
      <div className="mt-3 flex gap-1.5">
        <button
          type="button"
          onClick={() =>
            createIssueStore.set(
              route.name === "team" ? { teamId: teamFor(workspace, route)?.id } : {},
            )
          }
          className="flex flex-1 items-center justify-between rounded-md border border-line bg-raised px-2 py-1.5 text-muted hover:text-ink"
        >
          New issue <Kbd>C</Kbd>
        </button>
        <button
          type="button"
          aria-label="Search and commands"
          onClick={() => openMenu(commandPalette())}
          className="flex items-center rounded-md border border-line bg-raised px-2 py-1.5 text-muted hover:text-ink"
        >
          <Kbd>⌘K</Kbd>
        </button>
      </div>
      <nav className="mt-4 space-y-0.5">
        <NavLink to={paths.myIssues()} active={route.name === "myIssues"}>
          My issues
        </NavLink>
        <NavLink to={paths.company()} active={route.name === "company"}>
          Company
        </NavLink>
      </nav>
      <div className="mt-6 flex items-center px-2">
        <p className="text-[11px] font-medium text-faint uppercase">Teams</p>
        <button
          type="button"
          aria-label="Create team"
          onClick={() => createTeamStore.set(true)}
          className="ml-auto text-faint hover:text-ink"
        >
          +
        </button>
      </div>
      <nav className="mt-1 min-h-0 space-y-0.5 overflow-y-auto">
        {workspace?.teams.nodes.length === 0 && <p className="px-2 py-1.5 text-faint">None yet</p>}
        {workspace?.teams.nodes.map((team) => {
          const active = route.name === "team" && route.key === team.key;
          return (
            <div key={team.id}>
              <NavLink to={paths.team(team.key)} active={active && route.view === "all"}>
                <span className="flex w-full items-center justify-between">
                  <span className="truncate">{team.name}</span>
                  <span className="text-[11px] text-faint">{team.key}</span>
                </span>
              </NavLink>
              {active && (
                <div className="ml-3 space-y-0.5 border-l border-line pl-2">
                  <NavLink to={paths.team(team.key, "active")} active={route.view === "active"}>
                    Active
                  </NavLink>
                  <NavLink to={paths.team(team.key, "backlog")} active={route.view === "backlog"}>
                    Backlog
                  </NavLink>
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="mt-auto flex items-center justify-between px-2 pt-3">
        <span className="truncate text-muted">{viewer.displayName}</span>
        <button type="button" onClick={onSignOut} className="text-faint hover:text-ink">
          Sign out
        </button>
      </div>
    </>
  );
}

function teamFor(workspace: Workspace | null, route: Route): Team | undefined {
  return route.name === "team"
    ? workspace?.teams.nodes.find((t) => t.key === route.key)
    : undefined;
}

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
      className={`flex items-center rounded-md px-2 py-1.5 ${
        active ? "bg-raised text-ink" : "text-muted hover:bg-raised hover:text-ink"
      }`}
    >
      {children}
    </a>
  );
}

function ToastHost() {
  const { toast, dismiss } = useToast();
  if (!toast) return null;
  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-line bg-raised px-4 py-3 shadow-2xl"
    >
      <span className="whitespace-pre-line">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            dismiss();
          }}
          className="font-medium text-accent"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="text-faint hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
