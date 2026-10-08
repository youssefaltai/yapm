import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createDocument, createProjectStore, workspaceStore } from "../actions.js";
import { mutate, toast, useQuery } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import { navigate, paths } from "../router.js";
import { Avatar, Modal, openMenu, shortDate, timeAgo, useStore } from "../ui.js";
import { IssuesView } from "./IssuesView.js";

export type ProjectState = "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";
export type Health = "onTrack" | "atRisk" | "offTrack";

export const PROJECT_STATES: { value: ProjectState; label: string; color: string }[] = [
  { value: "backlog", label: "Backlog", color: "#bec2c8" },
  { value: "planned", label: "Planned", color: "#e2e2e2" },
  { value: "started", label: "In Progress", color: "#f2c94c" },
  { value: "paused", label: "Paused", color: "#95a2b3" },
  { value: "completed", label: "Completed", color: "#5e6ad2" },
  { value: "canceled", label: "Canceled", color: "#95a2b3" },
];

export const HEALTH: Record<Health, { label: string; className: string }> = {
  onTrack: { label: "On track", className: "text-emerald-400" },
  atRisk: { label: "At risk", className: "text-amber-400" },
  offTrack: { label: "Off track", className: "text-red-400" },
};

interface ProjectRow {
  id: string;
  name: string;
  summary: string | null;
  color: string;
  state: ProjectState;
  health: Health | null;
  targetDate: string | null;
  lead: { id: string; name: string; kind: "owner" | "agent" } | null;
  progress: { progress: number; scope: number };
  initiative: { id: string; name: string } | null;
}

const PROJECT_ROW =
  "id name summary color state health targetDate lead { id name kind } progress { progress scope } initiative { id name }";

export function ProjectDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-[3px]"
      style={{ background: color, width: size, height: size }}
      aria-hidden
    />
  );
}

export function HealthBadge({ health }: { health: Health | null }) {
  if (!health) return <span className="text-[12px] text-faint">No updates</span>;
  const h = HEALTH[health];
  return <span className={`text-[12px] ${h.className}`}>{h.label}</span>;
}

export function Progress({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
      <span className="w-8 text-right text-[12px] text-muted">{Math.round(value * 100)}%</span>
    </span>
  );
}

export function ProjectsView() {
  const { data, error } = useQuery<{ projects: { nodes: ProjectRow[] } }>(
    `{ projects(first: 200) { nodes { ${PROJECT_ROW} } } }`,
  );
  const rows = data?.projects.nodes ?? [];
  const groups = PROJECT_STATES.map((s) => ({
    ...s,
    rows: rows.filter((p) => p.state === s.value),
  })).filter((g) => g.rows.length);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <span className="font-medium">Projects</span>
        <button
          type="button"
          onClick={() => navigate(paths.initiatives())}
          className="ml-2 text-muted hover:text-ink"
        >
          Initiatives
        </button>
        <button
          type="button"
          onClick={() => navigate(paths.roadmap())}
          className="text-muted hover:text-ink"
        >
          Roadmap
        </button>
        <button
          type="button"
          onClick={() => createProjectStore.set(true)}
          className="ml-auto rounded-md bg-accent px-2.5 py-1 font-medium text-white"
        >
          New project
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-red-400">{error}</p>}
        {data && rows.length === 0 && (
          <p className="px-6 py-16 text-center text-muted">
            No projects yet. A project is a goal with a date: a move, a marathon, a launch.
          </p>
        )}
        {groups.map((g) => (
          <section key={g.value}>
            <h2 className="flex items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-[12px] font-medium text-muted md:px-6">
              <span className="size-2 rounded-full" style={{ background: g.color }} aria-hidden />
              {g.label}
              <span className="text-faint">{g.rows.length}</span>
            </h2>
            <ul>
              {g.rows.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => navigate(paths.project(p.id))}
                    className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left hover:bg-raised md:px-6"
                  >
                    <ProjectDot color={p.color} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      {p.summary && (
                        <span className="block truncate text-[12px] text-faint">{p.summary}</span>
                      )}
                    </span>
                    <span className="max-sm:hidden">
                      <HealthBadge health={p.health} />
                    </span>
                    {p.lead && <Avatar name={p.lead.name} kind={p.lead.kind} size={18} />}
                    <span className="w-16 text-right text-[12px] text-faint max-sm:hidden">
                      {p.targetDate ? shortDate(p.targetDate) : ""}
                    </span>
                    <Progress value={p.progress.progress} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export function CreateProjectHost() {
  const open = useStore(createProjectStore);
  const close = useCallback(() => createProjectStore.set(false), []);
  return open ? <CreateProject onClose={close} /> : null;
}

function CreateProject({ onClose }: { onClose: () => void }) {
  const workspace = useStore(workspaceStore);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [leadId, setLeadId] = useState("");
  const [teamId, setTeamId] = useState(workspace?.teams.nodes[0]?.id ?? "");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await mutate<{ projectCreate: { project: { id: string } } }>(
      "mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }",
      {
        input: {
          name,
          summary: summary || null,
          leadId: leadId || null,
          teamIds: teamId ? [teamId] : [],
          targetDate: targetDate || null,
        },
      },
    );
    setBusy(false);
    if (result) {
      onClose();
      navigate(paths.project(result.projectCreate.project.id));
    }
  }
  const input =
    "w-full rounded-md border border-line bg-canvas px-3 py-2 outline-none placeholder:text-faint focus:border-accent";
  return (
    <Modal onClose={onClose} label="New project">
      <form onSubmit={submit} className="p-5">
        <h2 className="mb-4 text-[15px] font-medium">New project</h2>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-muted">Name</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to type a name
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Run a marathon"
            className={input}
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-muted">Summary</span>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One line: what it achieves"
            className={input}
          />
        </label>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-muted">Lead</span>
            <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={input}>
              <option value="">No lead</option>
              {workspace?.users.nodes.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-muted">Team</span>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={input}>
              <option value="">No team</option>
              {workspace?.teams.nodes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-muted">Target date</span>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className={`${input} [color-scheme:dark]`}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ProjectDetail extends ProjectRow {
  description: string | null;
  startDate: string | null;
  archivedAt: string | null;
  teams: { nodes: { id: string; name: string }[] };
  progress: { progress: number; scope: number; completed: number; started: number };
  projectMilestones: {
    nodes: {
      id: string;
      name: string;
      targetDate: string | null;
      progress: { progress: number; scope: number };
    }[];
  };
  projectUpdates: {
    nodes: {
      id: string;
      body: string;
      health: Health;
      createdAt: string;
      editedAt: string | null;
      user: { id: string; name: string; kind: "owner" | "agent" };
    }[];
  };
  documents: { nodes: { id: string; title: string; updatedAt: string }[] };
}

const PROJECT_DETAIL = `query($id: String!) { project(id: $id) {
  ${PROJECT_ROW} description startDate archivedAt
  teams { nodes { id name } }
  progress { progress scope completed started }
  projectMilestones { nodes { id name targetDate progress { progress scope } } }
  projectUpdates(first: 20) { nodes { id body health createdAt editedAt user { id name kind } } }
  documents { nodes { id title updatedAt } }
} }`;

const updateProject = (id: string, input: Record<string, unknown>) =>
  mutate(
    "mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success } }",
    { id, input },
  );

export function ProjectPage({ id, tab }: { id: string; tab: "overview" | "issues" }) {
  const { data, error } = useQuery<{ project: ProjectDetail }>(PROJECT_DETAIL, { id });
  const p = data?.project;
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!p) return null;
  const tabs = (
    <>
      <Tab active={tab === "overview"} to={paths.project(p.id)}>
        Overview
      </Tab>
      <Tab active={tab === "issues"} to={paths.project(p.id, "issues")}>
        Issues
      </Tab>
    </>
  );
  if (tab === "issues")
    return (
      <IssuesView
        key={`project-${p.id}`}
        source={{ kind: "project", project: { id: p.id, name: p.name } }}
        title={
          <>
            <button
              type="button"
              onClick={() => navigate(paths.projects())}
              className="text-muted hover:text-ink"
            >
              Projects
            </button>
            <span className="text-faint">›</span>
            <ProjectDot color={p.color} />
            <span className="max-w-48 truncate">{p.name}</span>
          </>
        }
        tabs={tabs}
      />
    );
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <button
          type="button"
          onClick={() => navigate(paths.projects())}
          className="text-muted hover:text-ink"
        >
          Projects
        </button>
        <span className="text-faint">›</span>
        <ProjectDot color={p.color} />
        <span className="max-w-48 truncate font-medium">{p.name}</span>
        <span className="ml-2 flex gap-1">{tabs}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6 md:px-6 lg:flex-row">
          <div className="min-w-0 flex-1">
            <Overview project={p} />
          </div>
          <aside className="w-full shrink-0 lg:w-72">
            <ProjectProperties project={p} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function Tab({ active, to, children }: { active: boolean; to: string; children: ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
      className={`shrink-0 rounded-md border px-2 py-0.5 font-normal ${
        active ? "border-line bg-raised text-ink" : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {children}
    </a>
  );
}

function Overview({ project: p }: { project: ProjectDetail }) {
  const [name, setName] = useState(p.name);
  const [summary, setSummary] = useState(p.summary ?? "");
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => setSummary(p.summary ?? ""), [p.summary]);
  const latest = p.projectUpdates.nodes[0];
  return (
    <>
      <input
        aria-label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== p.name && void updateProject(p.id, { name })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="w-full bg-transparent text-2xl font-semibold outline-none"
      />
      <input
        aria-label="Summary"
        value={summary}
        placeholder="Add a short summary…"
        onChange={(e) => setSummary(e.target.value)}
        onBlur={() => summary !== (p.summary ?? "") && void updateProject(p.id, { summary })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="mt-1 w-full bg-transparent text-muted outline-none placeholder:text-faint"
      />

      {latest && (
        <div className="mt-5 rounded-lg border border-line px-4 py-3">
          <p className="flex items-center gap-2 text-[12px]">
            <HealthBadge health={latest.health} />
            <span className="text-faint">
              · {latest.user.name} · {timeAgo(latest.createdAt)}
            </span>
          </p>
          <RichText source={latest.body} className="mt-2" />
        </div>
      )}

      <section className="mt-6">
        <h2 className="mb-2 font-medium">Description</h2>
        <RichEditor
          label="Description"
          value={p.description ?? ""}
          placeholder="Why this project, what done looks like, and how you'll get there…"
          onBlur={(description) => {
            if (description.trim() !== (p.description ?? "").trim())
              void updateProject(p.id, { description });
          }}
          className="min-h-16 text-[14px]"
        />
      </section>

      <Milestones project={p} />
      <Updates project={p} />

      <section className="mt-8">
        <div className="mb-2 flex items-center">
          <h2 className="font-medium">Documents</h2>
          <button
            type="button"
            onClick={() => void createDocument(p.id)}
            className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
          >
            + New document
          </button>
        </div>
        {p.documents.nodes.length === 0 ? (
          <p className="text-faint">Plans, specs and notes for this project live here.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {p.documents.nodes.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => navigate(paths.document(d.id))}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  <span className="text-[12px] text-faint">{timeAgo(d.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Milestones({ project: p }: { project: ProjectDetail }) {
  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  return (
    <section className="mt-8">
      <h2 className="mb-2 font-medium">Milestones</h2>
      <ul className="divide-y divide-line rounded-lg border border-line empty:hidden">
        {p.projectMilestones.nodes.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="size-2.5 rotate-45 border border-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
            <span className="text-[12px] text-faint">
              {m.targetDate ? shortDate(m.targetDate) : ""}
            </span>
            <Progress value={m.progress.progress} />
            <button
              type="button"
              aria-label={`Delete ${m.name}`}
              onClick={() =>
                window.confirm(
                  `Delete the milestone "${m.name}"? Its issues stay in the project.`,
                ) &&
                void mutate(
                  "mutation($id: String!) { projectMilestoneDelete(id: $id) { success } }",
                  {
                    id: m.id,
                  },
                )
              }
              className="text-faint hover:text-red-400"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await mutate(
            "mutation($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { success } }",
            { input: { projectId: p.id, name, targetDate: targetDate || null } },
          );
          if (ok) {
            setName("");
            setTargetDate("");
          }
        }}
      >
        <input
          aria-label="New milestone"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add a milestone"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 outline-none placeholder:text-faint focus:border-faint"
        />
        <input
          type="date"
          aria-label="Milestone date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          className="w-36 rounded-md border border-line bg-panel px-2 py-1.5 outline-none [color-scheme:dark]"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-md border border-line px-3 py-1.5 hover:bg-raised disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </section>
  );
}

function Updates({ project: p }: { project: ProjectDetail }) {
  const [body, setBody] = useState("");
  const [health, setHealth] = useState<Health>(p.health ?? "onTrack");
  const [writing, setWriting] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center">
        <h2 className="font-medium">Updates</h2>
        {!writing && (
          <button
            type="button"
            onClick={() => setWriting(true)}
            className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
          >
            + Write update
          </button>
        )}
      </div>
      {writing && (
        <form
          ref={form}
          className="mb-4 rounded-lg border border-line p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await mutate(
              "mutation($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success } }",
              { input: { projectId: p.id, body, health } },
            );
            if (ok) {
              setBody("");
              setWriting(false);
              toast("Update posted");
            }
          }}
        >
          <div className="mb-2 flex gap-1">
            {(Object.keys(HEALTH) as Health[]).map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={health === h}
                onClick={() => setHealth(h)}
                className={`rounded-md border px-2 py-0.5 text-[12px] ${
                  health === h
                    ? `border-line bg-raised ${HEALTH[h].className}`
                    : "border-transparent text-muted"
                }`}
              >
                {HEALTH[h].label}
              </button>
            ))}
          </div>
          <div className="rounded-md border border-line bg-panel px-3 py-2 focus-within:border-faint">
            <RichEditor
              label="Update"
              autoFocus
              value=""
              onChange={setBody}
              onSubmit={() => body.trim() && form.current?.requestSubmit()}
              onEscape={() => setWriting(false)}
              placeholder="What moved, what's next, what's in the way…"
              className="min-h-20"
            />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setWriting(false)}
              className="rounded-md px-3 py-1.5 text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!body.trim()}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
            >
              Post update
            </button>
          </div>
        </form>
      )}
      {p.projectUpdates.nodes.length === 0 && !writing ? (
        <p className="text-faint">No updates yet. The project's lead posts how it's going here.</p>
      ) : (
        <ol className="space-y-3">
          {p.projectUpdates.nodes.map((u) => (
            <li key={u.id} className="rounded-lg border border-line px-4 py-3">
              <p className="flex items-center gap-2 text-[12px]">
                <Avatar name={u.user.name} kind={u.user.kind} size={16} />
                <span>{u.user.name}</span>
                <HealthBadge health={u.health} />
                <span className="text-faint">{timeAgo(u.createdAt)}</span>
              </p>
              <RichText source={u.body} className="mt-2" />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ProjectProperties({ project: p }: { project: ProjectDetail }) {
  const workspace = useStore(workspaceStore);
  const state = PROJECT_STATES.find((s) => s.value === p.state);
  const row = "flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-raised";
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-1">
      <span className="text-faint">Status</span>
      <button
        type="button"
        className={row}
        onClick={() =>
          openMenu({
            placeholder: "Change project status…",
            items: PROJECT_STATES.map((s) => ({
              id: s.value,
              label: s.label,
              checked: s.value === p.state,
              icon: <span className="size-2 rounded-full" style={{ background: s.color }} />,
              onSelect: () => void updateProject(p.id, { state: s.value }),
            })),
          })
        }
      >
        <span className="size-2 rounded-full" style={{ background: state?.color }} aria-hidden />
        {state?.label}
      </button>
      <span className="text-faint">Health</span>
      <span className="px-2 py-1">
        <HealthBadge health={p.health} />
      </span>
      <span className="text-faint">Lead</span>
      <button
        type="button"
        className={row}
        onClick={() =>
          openMenu({
            placeholder: "Who leads this project?",
            items: [
              {
                id: "none",
                label: "No lead",
                checked: !p.lead,
                onSelect: () => void updateProject(p.id, { leadId: null }),
              },
              ...(workspace?.users.nodes ?? []).map((u) => ({
                id: u.id,
                label: u.name,
                hint: u.title ?? undefined,
                icon: <Avatar name={u.name} kind={u.kind} size={16} />,
                checked: u.id === p.lead?.id,
                onSelect: () => void updateProject(p.id, { leadId: u.id }),
              })),
            ],
          })
        }
      >
        {p.lead ? (
          <>
            <Avatar name={p.lead.name} kind={p.lead.kind} size={16} />
            {p.lead.name}
          </>
        ) : (
          <span className="text-faint">Add lead</span>
        )}
      </button>
      <span className="text-faint">Teams</span>
      <button
        type="button"
        className={row}
        onClick={() => {
          const current = new Set(p.teams.nodes.map((t) => t.id));
          openMenu({
            placeholder: "Teams working on it…",
            items: (workspace?.teams.nodes ?? []).map((t) => ({
              id: t.id,
              label: t.name,
              checked: current.has(t.id),
              onSelect: () => {
                const next = new Set(current);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                void updateProject(p.id, { teamIds: [...next] });
              },
            })),
          });
        }}
      >
        {p.teams.nodes.length ? (
          <span className="truncate">{p.teams.nodes.map((t) => t.name).join(", ")}</span>
        ) : (
          <span className="text-faint">Add team</span>
        )}
      </button>
      <span className="text-faint">Start date</span>
      <DateField
        label="Start date"
        value={p.startDate}
        onChange={(startDate) => void updateProject(p.id, { startDate })}
      />
      <span className="text-faint">Target date</span>
      <DateField
        label="Target date"
        value={p.targetDate}
        onChange={(targetDate) => void updateProject(p.id, { targetDate })}
      />
      <span className="text-faint">Initiative</span>
      <span className="truncate px-2 py-1 text-muted">{p.initiative?.name ?? "None"}</span>
      <span className="text-faint">Progress</span>
      <span className="px-2 py-1 text-muted">
        {p.progress.completed} of {p.progress.scope} done
      </span>
      <span />
      <button
        type="button"
        onClick={async () => {
          if (!window.confirm(`Archive ${p.name}?`)) return;
          if (
            await mutate("mutation($id: String!) { projectArchive(id: $id) { success } }", {
              id: p.id,
            })
          )
            navigate(paths.projects());
        }}
        className="mt-2 justify-self-start rounded-md px-2 py-1 text-[12px] text-faint hover:text-red-400"
      >
        Archive project
      </button>
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex items-center rounded-md px-2 py-1 hover:bg-raised">
      <input
        type="date"
        aria-label={label}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={`w-full bg-transparent outline-none [color-scheme:dark] ${value ? "" : "text-faint"}`}
      />
    </label>
  );
}
