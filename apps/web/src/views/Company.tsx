import { createTeamStore, hireAgentStore } from "../actions.js";
import type { Member, Workspace } from "../data.js";
import { navigate, paths } from "../router.js";
import { Avatar } from "../ui.js";

export function Company({ workspace }: { workspace: Workspace }) {
  const members = workspace.users.nodes;
  const teams = workspace.teams.nodes;
  const owner = members.find((m) => m.kind === "owner");
  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-11 items-center border-b border-line px-4 md:px-6">
        <span className="font-medium">Company</span>
      </header>
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-medium">{workspace.organization.name}</h1>
            <p className="mt-1 text-muted">{summary(members, teams.length)}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(paths.handbook())}
            className="rounded-md border border-line px-3 py-1.5 text-muted hover:bg-raised hover:text-ink"
          >
            Handbook
          </button>
        </div>

        <div className="mt-8 mb-3 flex items-center">
          <h2 className="text-[12px] font-medium text-faint uppercase">Organization</h2>
          {workspace.viewer.kind === "owner" && (
            <button
              type="button"
              onClick={() => hireAgentStore.set(true)}
              className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
            >
              + Hire agent
            </button>
          )}
        </div>
        {owner && <OrgNode member={owner} members={members} />}

        <div className="mt-8 mb-3 flex items-center">
          <h2 className="text-[12px] font-medium text-faint uppercase">Teams</h2>
          <button
            type="button"
            onClick={() => createTeamStore.set(true)}
            className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
          >
            + New team
          </button>
        </div>
        {teams.length === 0 && (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-muted">
            No teams yet. Your CEO creates them as your life's work takes shape.
          </p>
        )}
        <div className="divide-y divide-line rounded-lg border border-line empty:hidden">
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              onClick={() => navigate(paths.team(team.key))}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-raised"
            >
              <span className="mt-0.5 w-10 shrink-0 text-[11px] font-medium text-faint">
                {team.key}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{team.name}</p>
                {team.description && <p className="mt-0.5 text-muted">{team.description}</p>}
              </div>
              <div className="hidden shrink-0 text-right text-muted sm:block">
                <p>{team.lead?.name ?? "No lead"}</p>
                <p className="text-faint">{team.members.nodes.length} members</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function summary(members: Member[], teamCount: number): string {
  const agents = members.filter((m) => m.kind === "agent").length;
  const people = agents === 1 ? "1 AI employee" : `${agents} AI employees`;
  if (teamCount === 0) return `${people}, no teams yet.`;
  return `${people} across ${teamCount === 1 ? "1 team" : `${teamCount} teams`}.`;
}

function OrgNode({ member, members }: { member: Member; members: Member[] }) {
  const reports = members.filter((m) => m.manager?.id === member.id);
  return (
    <div>
      <button
        type="button"
        onClick={() => navigate(paths.member(member.id))}
        className="inline-flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-left hover:bg-raised"
      >
        <Avatar name={member.name} kind={member.kind} size={24} />
        <span className="font-medium">{member.name}</span>
        {member.title && member.title !== member.name && (
          <span className="text-muted">{member.title}</span>
        )}
      </button>
      {reports.length > 0 && (
        <div className="mt-2 ml-3 space-y-2 border-l border-line pl-5">
          {reports.map((report) => (
            <OrgNode key={report.id} member={report} members={members} />
          ))}
        </div>
      )}
    </div>
  );
}
