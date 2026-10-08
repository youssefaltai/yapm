import { type ReactNode, useEffect, useState } from "react";
import {
  commandPalette,
  createIssueStore,
  createTeamStore,
  shortcutsStore,
  workspaceStore,
} from "./actions.js";
import type { Viewer } from "./api.js";
import { mutate, type Team, useQuery, useToast, WORKSPACE_QUERY, type Workspace } from "./data.js";
import { useLiveUpdates } from "./live.js";
import { navigate, parseRoute, paths, type Route, usePath } from "./router.js";
import { EmptyState, SelectedPill, TabLink } from "./states.js";
import { Kbd, MenuHost, openMenu, useHotkeys, usePresence } from "./ui.js";
import { Company } from "./views/Company.js";
import { CreateIssueHost } from "./views/CreateIssue.js";
import { CreateTeamHost } from "./views/CreateTeam.js";
import { CyclePage, CyclesView } from "./views/Cycles.js";
import { DocumentPage, DocumentsView } from "./views/Documents.js";
import { Handbook } from "./views/Handbook.js";
import { HireAgentHost } from "./views/HireAgent.js";
import { InboxView, useUnreadCount } from "./views/Inbox.js";
import { InitiativesView } from "./views/Initiatives.js";
import { Insights } from "./views/Insights.js";
import { IssuePage } from "./views/IssuePage.js";
import { IssuesView } from "./views/IssuesView.js";
import { MachinesView } from "./views/Machines.js";
import { MemberPage } from "./views/MemberPage.js";
import { CreateProjectHost, ProjectPage, ProjectsView } from "./views/Projects.js";
import { RequestPage, RequestsView, usePendingCount } from "./views/Requests.js";
import { RoadmapView } from "./views/Roadmap.js";
import { RunPage, RunsView, useRunningCount } from "./views/Runs.js";
import { ViewPage } from "./views/SavedView.js";
import { ShortcutsHost } from "./views/Shortcuts.js";
import { TeamSettings } from "./views/TeamSettings.js";

export function Shell({ viewer, onSignOut }: { viewer: Viewer; onSignOut: () => void }) {
  const { data: workspace, error } = useQuery<Workspace>(WORKSPACE_QUERY);
  const path = usePath();
  const route = parseRoute(path);
  const [drawer, setDrawer] = useState(false);
  useLiveUpdates();

  useEffect(() => {
    if (workspace) workspaceStore.set(workspace);
  }, [workspace]);
  // Cycles and rituals follow the owner's clock: adopt the browser's time zone the first time.
  const timezone = workspace?.organization.timezone;
  useEffect(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone === "UTC" && viewer.kind === "owner" && local && local !== "UTC") {
      void mutate(
        "mutation($tz: String!) { organizationUpdate(input: { timezone: $tz }) { success } }",
        { tz: local },
      );
    }
  }, [timezone, viewer.kind]);
  // Close the mobile drawer on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on path change
  useEffect(() => setDrawer(false), [path]);

  const currentTeam = teamFor(workspace ?? null, route);
  useHotkeys({
    "mod+k": () => openMenu(commandPalette()),
    "?": () => shortcutsStore.set(true),
    c: () => createIssueStore.set(currentTeam ? { teamId: currentTeam.id } : {}),
  });

  return (
    <div className="flex h-full animate-fade-in">
      <aside
        className={`isolate fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-line bg-panel px-3 py-3 md:static md:flex md:w-60 md:animate-none ${
          drawer ? "flex animate-drawer-in" : "hidden"
        }`}
      >
        <Sidebar workspace={workspace} viewer={viewer} route={route} onSignOut={onSignOut} />
      </aside>
      {drawer && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-20 animate-fade-in bg-black/50 md:hidden"
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
          {workspace && (
            // A fresh page fades in; switching tabs within a page doesn't.
            <div key={pageKey(route)} className="h-full animate-fade-in">
              <RouteView route={route} workspace={workspace} />
            </div>
          )}
        </div>
      </main>
      <CreateIssueHost />
      <CreateTeamHost />
      <HireAgentHost />
      <ShortcutsHost />
      <CreateProjectHost />
      <MenuHost />
      <ToastHost />
    </div>
  );
}

function RouteView({ route, workspace }: { route: Route; workspace: Workspace }) {
  switch (route.name) {
    case "inbox":
      return <InboxView />;
    case "myIssues":
      return (
        <IssuesView
          key={`my-${route.tab}`}
          source={{ kind: "my", tab: route.tab }}
          title="My issues"
          tabs={
            <>
              <TabLink
                group="view-tabs"
                active={route.tab === "assigned"}
                to={paths.myIssues("assigned")}
              >
                Assigned
              </TabLink>
              <TabLink
                group="view-tabs"
                active={route.tab === "created"}
                to={paths.myIssues("created")}
              >
                Created
              </TabLink>
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
              <TabLink
                group="view-tabs"
                active={route.view === "all"}
                to={paths.team(team.key, "all")}
              >
                All issues
              </TabLink>
              <TabLink
                group="view-tabs"
                active={route.view === "active"}
                to={paths.team(team.key, "active")}
              >
                Active
              </TabLink>
              <TabLink
                group="view-tabs"
                active={route.view === "backlog"}
                to={paths.team(team.key, "backlog")}
              >
                Backlog
              </TabLink>
              {team.triageEnabled && (
                <TabLink
                  group="view-tabs"
                  active={route.view === "triage"}
                  to={paths.team(team.key, "triage")}
                >
                  Triage
                </TabLink>
              )}
              {team.cyclesEnabled && (
                <TabLink group="view-tabs" active={false} to={paths.cycles(team.key)}>
                  Cycles
                </TabLink>
              )}
            </>
          }
        />
      );
    }
    case "cycles":
    case "teamSettings": {
      const team = workspace.teams.nodes.find((t) => t.key === route.key);
      if (!team) return <NotFound what="Team" />;
      return route.name === "cycles" ? <CyclesView team={team} /> : <TeamSettings team={team} />;
    }
    case "cycle":
      return <CyclePage key={route.id} id={route.id} />;
    case "view":
      return <ViewPage key={route.id} id={route.id} />;
    case "issue":
      return <IssuePage key={route.identifier} identifier={route.identifier} />;
    case "company":
      return <Company workspace={workspace} />;
    case "member":
      return <MemberPage key={route.id} id={route.id} />;
    case "requests":
      return <RequestsView key={route.tab} tab={route.tab} />;
    case "request":
      return <RequestPage key={route.id} id={route.id} />;
    case "runs":
      return <RunsView key={route.tab} tab={route.tab} />;
    case "run":
      return <RunPage key={route.id} id={route.id} />;
    case "machines":
      return <MachinesView />;
    case "projects":
      return <ProjectsView />;
    case "project":
      return <ProjectPage key={route.id} id={route.id} tab={route.tab} />;
    case "initiatives":
      return <InitiativesView />;
    case "roadmap":
      return <RoadmapView />;
    case "handbook":
      return <Handbook />;
    case "insights":
      return <Insights />;
    case "documents":
      return <DocumentsView />;
    case "document":
      return <DocumentPage key={route.id} id={route.id} />;
    case "notFound":
      return <NotFound what="Page" />;
  }
}

function pageKey(route: Route): string {
  if ("id" in route) return `${route.name}:${route.id}`;
  if ("key" in route) return `${route.name}:${route.key}`;
  if ("identifier" in route) return `${route.name}:${route.identifier}`;
  return route.name;
}

function NotFound({ what }: { what: string }) {
  return (
    <EmptyState
      icon="compass"
      title={`${what} not found`}
      description="It may have been moved or deleted, or the link is mistyped."
      action={{ label: "Go to Inbox", onClick: () => navigate(paths.inbox()) }}
    />
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
  const pending = usePendingCount();
  const running = useRunningCount();
  const unread = useUnreadCount();
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
              teamFor(workspace, route) ? { teamId: teamFor(workspace, route)?.id } : {},
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
        <NavLink to={paths.inbox()} active={route.name === "inbox"}>
          <span className="flex w-full items-center justify-between">
            Inbox
            {unread > 0 && <span className="animate-fade-in text-[11px] text-muted">{unread}</span>}
          </span>
        </NavLink>
        <NavLink to={paths.myIssues()} active={route.name === "myIssues"}>
          My issues
        </NavLink>
        <NavLink
          to={paths.requests()}
          active={route.name === "requests" || route.name === "request"}
        >
          <span className="flex w-full items-center justify-between">
            Approvals
            {pending > 0 && (
              <span className="animate-badge-in rounded-full bg-accent px-1.5 text-[11px] font-medium text-white">
                {pending}
              </span>
            )}
          </span>
        </NavLink>
        <NavLink
          to={paths.projects()}
          active={
            route.name === "projects" ||
            route.name === "project" ||
            route.name === "initiatives" ||
            route.name === "roadmap"
          }
        >
          Projects
        </NavLink>
        <NavLink
          to={paths.documents()}
          active={route.name === "documents" || route.name === "document"}
        >
          Documents
        </NavLink>
        <NavLink
          to={paths.runs()}
          active={route.name === "runs" || route.name === "run" || route.name === "machines"}
        >
          <span className="flex w-full items-center justify-between">
            Runs
            {running > 0 && (
              <span className="animate-fade-in text-[11px] text-accent">{running}</span>
            )}
          </span>
        </NavLink>
        <NavLink to={paths.insights()} active={route.name === "insights"}>
          Insights
        </NavLink>
        <NavLink
          to={paths.company()}
          active={route.name === "company" || route.name === "handbook"}
        >
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
          const active = "key" in route && route.key === team.key;
          const view = route.name === "team" ? route.view : null;
          return (
            <div key={team.id}>
              <NavLink to={paths.team(team.key)} active={active && view === "all"}>
                <span className="flex w-full items-center justify-between">
                  <span className="truncate">{team.name}</span>
                  <span className="text-[11px] text-faint">{team.key}</span>
                </span>
              </NavLink>
              {active && (
                <div className="ml-3 animate-reveal space-y-0.5 border-l border-line pl-2">
                  {team.triageEnabled && (
                    <NavLink to={paths.team(team.key, "triage")} active={view === "triage"}>
                      Triage
                    </NavLink>
                  )}
                  <NavLink to={paths.team(team.key, "active")} active={view === "active"}>
                    Active
                  </NavLink>
                  <NavLink to={paths.team(team.key, "backlog")} active={view === "backlog"}>
                    Backlog
                  </NavLink>
                  {team.cyclesEnabled && (
                    <NavLink to={paths.cycles(team.key)} active={route.name === "cycles"}>
                      Cycles
                    </NavLink>
                  )}
                  <NavLink to={paths.teamSettings(team.key)} active={route.name === "teamSettings"}>
                    Settings
                  </NavLink>
                </div>
              )}
            </div>
          );
        })}
      </nav>
      {!!workspace?.customViews.nodes.length && (
        <>
          <p className="mt-6 px-2 text-[11px] font-medium text-faint uppercase">Views</p>
          <nav className="mt-1 space-y-0.5">
            {workspace.customViews.nodes.map((v) => (
              <NavLink
                key={v.id}
                to={paths.view(v.id)}
                active={route.name === "view" && route.id === v.id}
              >
                <span className="truncate">{v.name}</span>
              </NavLink>
            ))}
          </nav>
        </>
      )}
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
  return "key" in route ? workspace?.teams.nodes.find((t) => t.key === route.key) : undefined;
}

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center rounded-md px-2 py-1.5 ${
        active ? "text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
      }`}
    >
      {active && <SelectedPill group="sidebar" />}
      {children}
    </a>
  );
}

function ToastHost() {
  const { toast: current, dismiss } = useToast();
  const { shown: toast, leaving } = usePresence(current);
  if (!toast) return null;
  return (
    <div
      key={toast.message}
      role="status"
      aria-hidden={leaving || undefined}
      className={`fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-line bg-raised px-4 py-3 shadow-2xl ${
        leaving ? "pointer-events-none animate-sink-out" : "animate-rise-in"
      }`}
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
