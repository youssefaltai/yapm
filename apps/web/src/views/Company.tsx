import { type ReactNode, useState } from "react";
import { createTeamStore, hireAgentStore } from "../actions.js";
import { type Member, mutate, type Workspace } from "../data.js";
import { navigate, paths } from "../router.js";
import { EmptyState } from "../states.js";
import { Avatar } from "../ui.js";

export function Company({ workspace }: { workspace: Workspace }) {
  const members = workspace.users.nodes;
  const teams = workspace.teams.nodes;
  const owner = members.find((m) => m.kind === "owner");
  const isOwner = workspace.viewer.kind === "owner";
  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-11 items-center border-b border-line px-4 md:px-6">
        <span className="font-medium">Company</span>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-10">
        <h1 className="text-xl font-semibold">{workspace.organization.name}</h1>
        <p className="mt-1 text-muted">{summary(members, teams.length)}</p>

        <div className="mt-8 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <section aria-labelledby="org-title">
              <div className="mb-2 flex items-center">
                <h2 id="org-title" className="text-[12px] font-medium text-faint uppercase">
                  Organization
                </h2>
                {isOwner && (
                  <button
                    type="button"
                    onClick={() => hireAgentStore.set(true)}
                    className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
                  >
                    + Hire agent
                  </button>
                )}
              </div>
              <div className="overflow-hidden rounded-lg border border-line">
                {owner && <OrgNode member={owner} members={members} depth={0} />}
              </div>
            </section>

            <section aria-labelledby="teams-title" className="mt-8">
              <div className="mb-2 flex items-center">
                <h2 id="teams-title" className="text-[12px] font-medium text-faint uppercase">
                  Teams
                </h2>
                <button
                  type="button"
                  onClick={() => createTeamStore.set(true)}
                  className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
                >
                  + New team
                </button>
              </div>
              {teams.length === 0 && (
                <EmptyState
                  compact
                  icon="team"
                  title="No teams yet"
                  description="Your CEO creates them as your life's work takes shape."
                  action={{ label: "New team", onClick: () => createTeamStore.set(true) }}
                  className="rounded-xl border border-dashed border-line"
                />
              )}
              <TeamList teams={teams} members={members} />
            </section>
          </div>

          <aside className="min-w-0 space-y-3">
            <SideCard
              title="Handbook"
              body="How the company works: the conventions, preferences and rules every agent follows."
            >
              <button
                type="button"
                onClick={() => navigate(paths.handbook())}
                className="rounded-md border border-line px-3 py-1.5 hover:bg-raised"
              >
                Handbook
              </button>
            </SideCard>
            {isOwner && <MoveData />}
          </aside>
        </div>
      </div>
    </div>
  );
}

function SideCard({
  title,
  body,
  children,
}: {
  title: string;
  body: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-panel px-4 py-3">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-0.5 text-[13px] text-muted">{body}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function TeamList({ teams, members }: { teams: Workspace["teams"]["nodes"]; members: Member[] }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line empty:hidden">
      {teams.map((team) => {
        const people = team.members.nodes
          .map((m) => members.find((u) => u.id === m.id))
          .filter((m): m is Member => !!m);
        return (
          <button
            key={team.id}
            type="button"
            onClick={() => navigate(paths.team(team.key))}
            className="flex w-full animate-fade-in items-center gap-3 px-4 py-2.5 text-left hover:bg-raised"
          >
            <span className="w-10 shrink-0 text-[11px] font-medium text-faint">{team.key}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{team.name}</span>
              {team.description && (
                <span className="block truncate text-[13px] text-muted">{team.description}</span>
              )}
            </span>
            <span className="hidden w-32 shrink-0 truncate text-muted sm:block">
              {team.lead?.name ?? <span className="text-faint">No lead</span>}
            </span>
            <span
              className="flex shrink-0 -space-x-1"
              title={`${people.length} ${people.length === 1 ? "member" : "members"}`}
            >
              {people.slice(0, 5).map((m) => (
                <span key={m.id} className="rounded-full ring-2 ring-canvas">
                  <Avatar name={m.name} kind={m.kind} size={18} />
                </span>
              ))}
              {people.length > 5 && (
                <span className="pl-2 text-[12px] text-faint">+{people.length - 5}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Moving in from Linear, and taking everything out. */
function MoveData() {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <>
      <SideCard
        title="Import from Linear"
        body={
          <>
            Brings over teams, workflows, labels, projects, issues with their numbers, and comments.
            Create a personal API key in Linear under Settings › Security &amp; access; it's used
            once and not kept.
          </>
        }
      >
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setResult(null);
            const done = await mutate<{
              linearImport: { teams: number; projects: number; issues: number; comments: number };
            }>(
              "mutation($key: String!) { linearImport(apiKey: $key) { teams projects issues comments } }",
              { key: apiKey },
            );
            setBusy(false);
            if (done) {
              const r = done.linearImport;
              setApiKey("");
              setResult(
                `Imported ${r.teams} teams, ${r.projects} projects, ${r.issues} issues and ${r.comments} comments.`,
              );
            }
          }}
        >
          <input
            aria-label="Linear API key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="lin_api_…"
            className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 outline-none placeholder:text-faint focus:border-faint"
          />
          <button
            type="submit"
            disabled={!apiKey.trim() || busy}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </form>
        {result && (
          <p className="mt-2 text-muted" role="status">
            {result}
          </p>
        )}
      </SideCard>
      <SideCard
        title="Export"
        body="Everything as JSON, or issues as CSV in Linear's columns. Passkeys, tokens and machine secrets are left out."
      >
        <div className="flex gap-2">
          <a
            href="/api/export"
            download
            className="rounded-md border border-line px-3 py-1.5 hover:bg-raised"
          >
            Export JSON
          </a>
          <a
            href="/api/export?format=csv"
            download
            className="rounded-md border border-line px-3 py-1.5 hover:bg-raised"
          >
            Export CSV
          </a>
        </div>
      </SideCard>
    </>
  );
}

function summary(members: Member[], teamCount: number): string {
  const agents = members.filter((m) => m.kind === "agent").length;
  const people = agents === 1 ? "1 AI employee" : `${agents} AI employees`;
  if (teamCount === 0) return `${people}, no teams yet.`;
  return `${people} across ${teamCount === 1 ? "1 team" : `${teamCount} teams`}.`;
}

/** The org chart as a dense tree: each person on a row, indented under who they report to. */
function OrgNode({ member, members, depth }: { member: Member; members: Member[]; depth: number }) {
  const reports = members.filter((m) => m.manager?.id === member.id);
  return (
    <>
      <button
        type="button"
        onClick={() => navigate(paths.member(member.id))}
        style={{ paddingLeft: 16 + depth * 24 }}
        className="flex w-full items-center gap-2.5 border-line py-2 pr-4 text-left not-first:border-t hover:bg-raised"
      >
        {depth > 0 && <span className="-ml-3 h-px w-2 shrink-0 bg-line" aria-hidden />}
        <Avatar name={member.name} kind={member.kind} size={22} />
        <span className="shrink-0 font-medium">{member.name}</span>
        {member.title && member.title !== member.name && (
          <span className="min-w-0 truncate text-muted">{member.title}</span>
        )}
        <span className="ml-auto shrink-0 text-[12px] text-faint">
          {reports.length > 0
            ? `${reports.length} ${reports.length === 1 ? "report" : "reports"}`
            : member.kind === "agent"
              ? "Agent"
              : ""}
        </span>
      </button>
      {reports.map((report) => (
        <OrgNode key={report.id} member={report} members={members} depth={depth + 1} />
      ))}
    </>
  );
}
