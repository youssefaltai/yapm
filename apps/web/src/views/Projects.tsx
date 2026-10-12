import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  createDocument,
  createIssueStore,
  createProjectStore,
  dateMenu,
  documentContextMenu,
  linkEntries,
  workspaceStore,
} from "../actions.js";
import { graphql } from "../api.js";
import { type ContextEntry, contextMenu } from "../contextMenu.js";
import { confirmDialog, DatePicker, Select } from "../controls.js";
import { mutate, toast, useQuery } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import { icon } from "../icons.js";
import {
  Breadcrumbs,
  button,
  dialogField,
  field,
  GroupHeader,
  listRow,
  PageHeader,
  PageTitle,
  pageHeading,
  Section,
  TabLink,
  TabRow,
} from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState, ListSkeleton, PageSkeleton } from "../states.js";
import {
  Avatar,
  DetailLayout,
  Modal,
  openMenu,
  ProjectDot,
  Property,
  PropertyList,
  propertyButton,
  shortDate,
  timeAgo,
  useStore,
} from "../ui.js";
import { IssuesView } from "./IssuesView.js";

export type ProjectState = "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";
export type Health = "onTrack" | "atRisk" | "offTrack";

export const PROJECT_STATES: { value: ProjectState; label: string; color: string }[] = [
  { value: "backlog", label: "Backlog", color: "var(--color-faint)" },
  { value: "planned", label: "Planned", color: "var(--color-muted)" },
  { value: "started", label: "In Progress", color: "var(--color-ink)" },
  { value: "paused", label: "Paused", color: "var(--color-faint)" },
  { value: "completed", label: "Completed", color: "var(--color-muted)" },
  { value: "canceled", label: "Canceled", color: "var(--color-faint)" },
];

export const HEALTH: Record<Health, { label: string; className: string }> = {
  onTrack: { label: "On track", className: "text-success" },
  atRisk: { label: "At risk", className: "text-warning" },
  offTrack: { label: "Off track", className: "text-critical" },
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
          className="block h-full animate-grow-x rounded-full bg-accent transition-[width] duration-500 ease-snappy"
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
      <PageHeader
        actions={
          <button
            type="button"
            onClick={() => createProjectStore.set(true)}
            className={button("primary", "sm")}
          >
            New project
          </button>
        }
        tabs={<ProjectsTabs active="projects" />}
      >
        <PageTitle>Projects</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-critical">{error}</p>}
        {!data && !error && <ListSkeleton rows={6} />}
        {data && rows.length === 0 && (
          <EmptyState
            icon="project"
            title="No projects yet"
            description="A project is a goal with a date: a move, a marathon, a launch. Agents plan the issues that get it done."
            action={{ label: "New project", onClick: () => createProjectStore.set(true) }}
            secondary={{ label: "See initiatives", onClick: () => navigate(paths.initiatives()) }}
          />
        )}
        {groups.map((g) => (
          <section key={g.value}>
            <GroupHeader
              icon={
                <span className="size-2 rounded-full" style={{ background: g.color }} aria-hidden />
              }
              label={g.label}
              count={g.rows.length}
            />
            <ul>
              {g.rows.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => navigate(paths.project(p.id))}
                    onContextMenu={contextMenu(() => projectContextMenu(p))}
                    className={listRow}
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
  const input = dialogField;
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
          <div className="block">
            <span className="mb-1.5 block text-muted">Lead</span>
            <Select
              aria-label="Lead"
              value={leadId}
              onChange={setLeadId}
              options={[
                { value: "", label: "No lead" },
                ...(workspace?.users.nodes.map((u) => ({
                  value: u.id,
                  label: u.name,
                  icon: <Avatar name={u.name} size={16} />,
                })) ?? []),
              ]}
              className={input}
            />
          </div>
          <div className="block">
            <span className="mb-1.5 block text-muted">Team</span>
            <Select
              aria-label="Team"
              value={teamId}
              onChange={setTeamId}
              options={[
                { value: "", label: "No team" },
                ...(workspace?.teams.nodes.map((t) => ({ value: t.id, label: t.name })) ?? []),
              ]}
              className={input}
            />
          </div>
          <div className="block">
            <span className="mb-1.5 block text-muted">Target date</span>
            <DatePicker
              aria-label="Target date"
              value={targetDate || null}
              onChange={(d) => setTargetDate(d ?? "")}
              placeholder="No date"
              className={input}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={button("ghost")}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={button("primary")}>
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

export async function archiveProject(p: { id: string; name: string }) {
  if (!(await confirmDialog({ title: `Archive ${p.name}?`, confirmLabel: "Archive" }))) return;
  if (await mutate("mutation($id: String!) { projectArchive(id: $id) { success } }", { id: p.id }))
    navigate(paths.projects());
}

/** Linear's project menu: its properties, new work in it, its link, and archive. */
export function projectContextMenu(p: ProjectRow): ContextEntry[] {
  const users = workspaceStore.get()?.users.nodes ?? [];
  const state = PROJECT_STATES.find((s) => s.value === p.state);
  return [
    {
      id: "status",
      label: "Status",
      icon: <span className="size-2 rounded-full" style={{ background: state?.color }} />,
      submenu: () => ({
        placeholder: "Change project status…",
        items: PROJECT_STATES.map((s) => ({
          id: s.value,
          label: s.label,
          checked: s.value === p.state,
          icon: <span className="size-2 rounded-full" style={{ background: s.color }} />,
          onSelect: () => void updateProject(p.id, { state: s.value }),
        })),
      }),
    },
    {
      id: "lead",
      label: "Lead",
      icon: p.lead && <Avatar name={p.lead.name} kind={p.lead.kind} size={14} />,
      submenu: () => ({
        placeholder: "Who leads this project?",
        items: [
          {
            id: "none",
            label: "No lead",
            checked: !p.lead,
            onSelect: () => void updateProject(p.id, { leadId: null }),
          },
          ...users.map((u) => ({
            id: u.id,
            label: u.name,
            icon: <Avatar name={u.name} kind={u.kind} size={16} />,
            checked: u.id === p.lead?.id,
            onSelect: () => void updateProject(p.id, { leadId: u.id }),
          })),
        ],
      }),
    },
    {
      id: "target",
      icon: icon("calendar"),
      label: "Target date",
      submenu: () =>
        dateMenu({
          placeholder: "Target date… try “end of june”",
          value: p.targetDate,
          onPick: (targetDate) => updateProject(p.id, { targetDate }),
        }),
    },
    {
      id: "initiative",
      icon: icon("initiative"),
      label: "Initiative",
      submenu: async () => {
        const data = await graphql<{ initiatives: { nodes: { id: string; name: string }[] } }>(
          "{ initiatives { nodes { id name } } }",
        );
        return {
          placeholder: "Add to initiative…",
          items: [
            {
              id: "none",
              label: "No initiative",
              checked: !p.initiative,
              onSelect: () => void updateProject(p.id, { initiativeId: null }),
            },
            ...data.initiatives.nodes.map((i) => ({
              id: i.id,
              label: i.name,
              checked: i.id === p.initiative?.id,
              onSelect: () => void updateProject(p.id, { initiativeId: i.id }),
            })),
          ],
        };
      },
    },
    "divider",
    {
      id: "new-issue",
      icon: icon("newIssue"),
      label: "New issue in project",
      onSelect: () => createIssueStore.set({ projectId: p.id }),
    },
    {
      id: "new-document",
      icon: icon("document"),
      label: "New document in project",
      onSelect: () => createDocument(p.id),
    },
    "divider",
    ...linkEntries({ path: paths.project(p.id), name: p.name }),
    "divider",
    { id: "archive", icon: icon("archive"), label: "Archive…", onSelect: () => archiveProject(p) },
  ];
}

export function ProjectPage({ id, tab }: { id: string; tab: "overview" | "issues" }) {
  const { data, error } = useQuery<{ project: ProjectDetail }>(PROJECT_DETAIL, { id });
  const p = data?.project;
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!p) return <PageSkeleton />;
  const tabs = (
    <TabRow>
      <TabLink group="project-tabs" active={tab === "overview"} to={paths.project(p.id)}>
        Overview
      </TabLink>
      <TabLink group="project-tabs" active={tab === "issues"} to={paths.project(p.id, "issues")}>
        Issues
      </TabLink>
    </TabRow>
  );
  if (tab === "issues")
    return (
      <IssuesView
        key={`project-${p.id}`}
        source={{ kind: "project", project: { id: p.id, name: p.name } }}
        title={<ProjectCrumbs project={p} />}
        tabs={tabs}
      />
    );
  return (
    <div className="flex h-full animate-fade-in flex-col">
      <PageHeader tabs={tabs}>
        <ProjectCrumbs project={p} />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailLayout
          head={<ProjectHeading project={p} />}
          side={<ProjectProperties project={p} />}
        >
          <Overview project={p} />
        </DetailLayout>
      </div>
    </div>
  );
}

function ProjectCrumbs({ project: p }: { project: ProjectDetail }) {
  return (
    <Breadcrumbs trail={[{ label: "Projects", to: paths.projects() }]}>
      <ProjectDot color={p.color} />
      <span className="max-w-48 truncate">{p.name}</span>
    </Breadcrumbs>
  );
}

/** Projects, initiatives and the roadmap share a header, so moving between them holds still. */
export function ProjectsTabs({ active }: { active: "projects" | "initiatives" | "roadmap" }) {
  return (
    <TabRow>
      <TabLink group="projects-tabs" active={active === "projects"} to={paths.projects()}>
        All
      </TabLink>
      <TabLink group="projects-tabs" active={active === "initiatives"} to={paths.initiatives()}>
        Initiatives
      </TabLink>
      <TabLink group="projects-tabs" active={active === "roadmap"} to={paths.roadmap()}>
        Roadmap
      </TabLink>
    </TabRow>
  );
}

function ProjectHeading({ project: p }: { project: ProjectDetail }) {
  const [name, setName] = useState(p.name);
  const [summary, setSummary] = useState(p.summary ?? "");
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => setSummary(p.summary ?? ""), [p.summary]);
  return (
    <>
      <input
        aria-label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== p.name && void updateProject(p.id, { name })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={`w-full bg-transparent outline-none ${pageHeading}`}
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
    </>
  );
}

function Overview({ project: p }: { project: ProjectDetail }) {
  const latest = p.projectUpdates.nodes[0];
  return (
    <>
      {latest && (
        <div className="rounded-lg border border-line px-4 py-3">
          <p className="flex items-center gap-2 text-[12px]">
            <HealthBadge health={latest.health} />
            <span className="text-faint">
              · {latest.user.name} · {timeAgo(latest.createdAt)}
            </span>
          </p>
          <RichText source={latest.body} className="mt-2" />
        </div>
      )}

      <Section title="Description">
        <RichEditor
          label="Description"
          value={p.description ?? ""}
          placeholder="Why this project, what done looks like, and how you'll get there…"
          onBlur={(description) => {
            if (description.trim() !== (p.description ?? "").trim())
              void updateProject(p.id, { description });
          }}
          className="min-h-16 text-[15px]"
        />
      </Section>

      <Milestones project={p} />
      <Updates project={p} />

      <Section
        title="Documents"
        actions={
          <button
            type="button"
            onClick={() => void createDocument(p.id)}
            className={button("ghost", "sm")}
          >
            + New document
          </button>
        }
      >
        {p.documents.nodes.length === 0 ? (
          <p className="text-faint">Plans, specs and notes for this project live here.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {p.documents.nodes.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => navigate(paths.document(d.id))}
                  onContextMenu={contextMenu(() =>
                    documentContextMenu({ ...d, project: { id: p.id } }),
                  )}
                  className="flex w-full animate-fade-in items-center gap-3 px-4 py-2.5 text-left hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  <span className="text-[12px] text-faint">{timeAgo(d.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function Milestones({ project: p }: { project: ProjectDetail }) {
  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  return (
    <Section title="Milestones">
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
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Delete the milestone “${m.name}”?`,
                    body: "Its issues stay in the project.",
                    confirmLabel: "Delete",
                    destructive: true,
                  })
                )
                  void mutate(
                    "mutation($id: String!) { projectMilestoneDelete(id: $id) { success } }",
                    { id: m.id },
                  );
              }}
              className="text-faint hover:text-critical"
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
          className={`flex-1 ${field}`}
        />
        <DatePicker
          aria-label="Milestone date"
          value={targetDate || null}
          onChange={(d) => setTargetDate(d ?? "")}
          placeholder="Target date"
          className={`w-36 ${field} hover:bg-raised`}
        />
        <button type="submit" disabled={!name.trim()} className={button("secondary")}>
          Add
        </button>
      </form>
    </Section>
  );
}

function Updates({ project: p }: { project: ProjectDetail }) {
  const [body, setBody] = useState("");
  const [health, setHealth] = useState<Health>(p.health ?? "onTrack");
  const [writing, setWriting] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  return (
    <Section
      title="Updates"
      actions={
        !writing && (
          <button type="button" onClick={() => setWriting(true)} className={button("ghost", "sm")}>
            + Write update
          </button>
        )
      }
    >
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
            <button type="button" onClick={() => setWriting(false)} className={button("ghost")}>
              Cancel
            </button>
            <button type="submit" disabled={!body.trim()} className={button("primary")}>
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
    </Section>
  );
}

function ProjectProperties({ project: p }: { project: ProjectDetail }) {
  const workspace = useStore(workspaceStore);
  const state = PROJECT_STATES.find((s) => s.value === p.state);
  return (
    <>
      <PropertyList>
        <Property label="Status" control>
          <button
            type="button"
            className={propertyButton}
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
            <span
              className="size-2 rounded-full"
              style={{ background: state?.color }}
              aria-hidden
            />
            {state?.label}
          </button>
        </Property>
        <Property label="Health">
          <HealthBadge health={p.health} />
        </Property>
        <Property label="Lead" control>
          <button
            type="button"
            className={propertyButton}
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
        </Property>
        <Property label="Teams" control>
          <button
            type="button"
            className={propertyButton}
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
        </Property>
        <Property label="Start date" control>
          <DateField
            label="Start date"
            value={p.startDate}
            onChange={(startDate) => void updateProject(p.id, { startDate })}
          />
        </Property>
        <Property label="Target date" control>
          <DateField
            label="Target date"
            value={p.targetDate}
            onChange={(targetDate) => void updateProject(p.id, { targetDate })}
          />
        </Property>
        <Property label="Initiative">
          <span className="truncate">{p.initiative?.name ?? "None"}</span>
        </Property>
        <Property label="Progress">
          {p.progress.completed} of {p.progress.scope} done
        </Property>
      </PropertyList>
      <button
        type="button"
        onClick={() => void archiveProject(p)}
        className="mt-4 rounded-md px-2 py-1 text-[12px] text-faint hover:text-critical"
      >
        Archive project
      </button>
    </>
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
    <DatePicker
      aria-label={label}
      value={value}
      onChange={onChange}
      placeholder="Set date"
      className="w-full rounded-md px-2 py-1 outline-none hover:bg-raised"
    />
  );
}
