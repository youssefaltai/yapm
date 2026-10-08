import { useEffect, useState } from "react";
import { graphql, type Viewer } from "./api.js";

interface Member {
  id: string;
  name: string;
  kind: "owner" | "agent";
  title: string | null;
  manager: { id: string } | null;
}

interface CompanyData {
  organization: { name: string };
  teams: {
    nodes: {
      id: string;
      key: string;
      name: string;
      description: string | null;
      lead: { name: string } | null;
      members: { nodes: { id: string }[] };
    }[];
  };
  users: { nodes: Member[] };
}

const COMPANY_QUERY = `{
  organization { name }
  teams { nodes { id key name description lead { name } members { nodes { id } } } }
  users { nodes { id name kind title manager { id } } }
}`;

export function Home({ viewer, onSignOut }: { viewer: Viewer; onSignOut: () => void }) {
  const [data, setData] = useState<CompanyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    graphql<CompanyData>(COMPANY_QUERY)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel px-3 py-3 md:flex">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <img src="/icon.svg" alt="" className="size-5" />
          <span className="truncate font-medium">{data?.organization.name ?? " "}</span>
        </div>
        <nav className="mt-4 space-y-0.5">
          <NavItem label="Inbox" soon />
          <NavItem label="My issues" soon />
        </nav>
        <p className="mt-6 px-2 text-[11px] font-medium text-faint uppercase">Teams</p>
        <nav className="mt-1 space-y-0.5">
          {data?.teams.nodes.length === 0 && <p className="px-2 py-1.5 text-faint">None yet</p>}
          {data?.teams.nodes.map((team) => (
            <NavItem key={team.id} label={team.name} badge={team.key} />
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between px-2 pt-3">
          <span className="truncate text-muted">{viewer.displayName}</span>
          <button type="button" onClick={onSignOut} className="text-faint hover:text-ink">
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="flex h-11 items-center justify-between border-b border-line px-4 md:px-6">
          <span className="font-medium">Company</span>
          <button type="button" onClick={onSignOut} className="text-faint hover:text-ink md:hidden">
            Sign out
          </button>
        </header>
        <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
          {error && <p className="text-red-400">{error}</p>}
          {data && <Company data={data} />}
        </div>
      </main>
    </div>
  );
}

function NavItem({ label, badge, soon }: { label: string; badge?: string; soon?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md px-2 py-1.5 text-muted hover:bg-raised hover:text-ink">
      <span className="truncate">{label}</span>
      {badge && <span className="text-[11px] text-faint">{badge}</span>}
      {soon && <span className="text-[11px] text-faint">soon</span>}
    </div>
  );
}

function Company({ data }: { data: CompanyData }) {
  const members = data.users.nodes;
  const owner = members.find((m) => m.kind === "owner");
  return (
    <>
      <h1 className="text-lg font-medium">{data.organization.name}</h1>
      <p className="mt-1 text-muted">{summary(members, data.teams.nodes.length)}</p>

      <h2 className="mt-8 mb-3 text-[12px] font-medium text-faint uppercase">Organization</h2>
      {owner && <OrgNode member={owner} members={members} />}

      <h2 className="mt-8 mb-3 text-[12px] font-medium text-faint uppercase">Teams</h2>
      {data.teams.nodes.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-muted">
          No teams yet. Your CEO creates them as your life's work takes shape.
        </p>
      )}
      <div className="divide-y divide-line rounded-lg border border-line empty:hidden">
        {data.teams.nodes.map((team) => (
          <div key={team.id} className="flex items-start gap-3 px-4 py-3">
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
          </div>
        ))}
      </div>
    </>
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
      <div className="inline-flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2">
        <span
          className={`flex size-6 items-center justify-center rounded-full text-[11px] font-medium ${
            member.kind === "agent" ? "bg-accent/20 text-accent" : "bg-raised text-ink"
          }`}
        >
          {member.name.slice(0, 1)}
        </span>
        <span className="font-medium">{member.name}</span>
        {member.title && member.title !== member.name && (
          <span className="text-muted">{member.title}</span>
        )}
      </div>
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
