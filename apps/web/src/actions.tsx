import { graphql } from "./api.js";
import type { ContextEntry } from "./contextMenu.js";
import { confirmDialog, formatDate, isoDate, parseDate, promptDialog } from "./controls.js";
import {
  ISSUE_FIELDS,
  type Issue,
  type IssueTemplate,
  type Label,
  mutate,
  mutateEach,
  PRIORITIES,
  type Team,
  toast,
  updateIssues,
  type Workspace,
} from "./data.js";
import { icon } from "./icons.js";
import { navigate, paths } from "./router.js";
import { setTheme, themeChoice } from "./theme.js";
import {
  Avatar,
  createStore,
  type MenuItem,
  type MenuSpec,
  PriorityIcon,
  ProjectDot,
  StatusIcon,
  shortDate,
  tint,
  UnassignedIcon,
} from "./ui.js";

/** The workspace (teams, states, labels, members), loaded once by the shell. */
export const workspaceStore = createStore<Workspace | null>(null);

export interface CreateIssueDefaults {
  teamId?: string;
  stateId?: string;
  parentId?: string;
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  /** Edit or create a template (with a schedule, a recurring issue) instead of an issue. */
  template?: IssueTemplate | { recurring: boolean };
}

export const createIssueStore = createStore<CreateIssueDefaults | null>(null);
export const createTeamStore = createStore(false);
export const hireAgentStore = createStore(false);
export const createProjectStore = createStore(false);
export const shortcutsStore = createStore(false);

/** The issues the next shortcut or command applies to: the open issue, or the list's selection. */
export const targetStore = createStore<Issue[]>([]);

function teamOf(issue: Pick<Issue, "team">): Team | undefined {
  return workspaceStore.get()?.teams.nodes.find((t) => t.id === issue.team.id);
}

const plural = (issues: Issue[]) =>
  issues.length === 1 ? issues[0]?.identifier : `${issues.length} issues`;

export function statusMenu(issues: Issue[]): MenuSpec | undefined {
  const teamIds = new Set(issues.map((i) => i.team.id));
  const [first] = issues;
  if (!first) return undefined;
  if (teamIds.size > 1) {
    return {
      placeholder: "Pick issues from one team to change their status",
      items: [],
    };
  }
  const states = teamOf(first)?.states.nodes ?? [];
  return {
    placeholder: `Change status of ${plural(issues)}…`,
    items: states.map((state, index) => ({
      id: state.id,
      label: state.name,
      icon: <StatusIcon type={state.type} color={state.color} />,
      hint: String(index + 1),
      checked: issues.every((i) => i.state.id === state.id),
      onSelect: () => {
        void updateIssues(
          issues.map((i) => i.id),
          { stateId: state.id },
          { state },
        );
      },
    })),
  };
}

interface ProjectOption {
  id: string;
  name: string;
  color: string;
  projectMilestones: { nodes: { id: string; name: string }[] };
}

/** Creates an untitled document (optionally in a project) and opens it to write. */
export async function createDocument(projectId?: string) {
  const result = await mutate<{ documentCreate: { document: { id: string } } }>(
    "mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }",
    { input: { title: "Untitled", projectId: projectId ?? null } },
  );
  if (result) navigate(paths.document(result.documentCreate.document.id));
}

/** Moves issues into a project, or one of its milestones. Loads the projects first. */
export async function projectMenu(issues: Issue[]): Promise<MenuSpec> {
  const data = await graphql<{ projects: { nodes: ProjectOption[] } }>(
    "{ projects(first: 100) { nodes { id name color projectMilestones { nodes { id name } } } } }",
  );
  const ids = issues.map((i) => i.id);
  const dot = (color: string) => (
    <span
      className="size-2.5 rounded-full"
      style={{ background: tint(color, "var(--color-muted)") }}
      aria-hidden
    />
  );
  return {
    placeholder: `Move ${plural(issues)} to project…`,
    items: [
      {
        id: "none",
        label: "No project",
        checked: issues.every((i) => !i.project),
        onSelect: () =>
          void updateIssues(ids, { projectId: null }, { project: null, projectMilestone: null }),
      },
      ...data.projects.nodes.flatMap((p): MenuItem[] => [
        {
          id: p.id,
          label: p.name,
          icon: dot(p.color),
          checked: issues.every((i) => i.project?.id === p.id && !i.projectMilestone),
          onSelect: () =>
            void updateIssues(
              ids,
              { projectId: p.id },
              { project: { id: p.id, name: p.name, color: p.color }, projectMilestone: null },
            ),
        },
        ...p.projectMilestones.nodes.map((m) => ({
          id: m.id,
          label: `${p.name} › ${m.name}`,
          keywords: p.name,
          icon: dot(p.color),
          checked: issues.every((i) => i.projectMilestone?.id === m.id),
          onSelect: () =>
            void updateIssues(
              ids,
              { projectMilestoneId: m.id },
              { project: { id: p.id, name: p.name, color: p.color }, projectMilestone: m },
            ),
        })),
      ]),
    ],
  };
}

export interface CycleOption {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  isPast: boolean;
}

export const cycleName = (c: { number: number; name: string | null }) =>
  c.name ? `${c.name} (Cycle ${c.number})` : `Cycle ${c.number}`;

/** Moves issues into one of their team's current or upcoming cycles. */
export async function cycleMenu(issues: Issue[]): Promise<MenuSpec | undefined> {
  const teamIds = [...new Set(issues.map((i) => i.team.id))];
  const [teamId] = teamIds;
  if (teamIds.length !== 1 || !teamId) {
    toast("Pick issues from one team to set their cycle.");
    return undefined;
  }
  const data = await graphql<{
    team: { cyclesEnabled: boolean; key: string; cycles: { nodes: CycleOption[] } };
  }>(
    "query($id: String!) { team(id: $id) { key cyclesEnabled cycles(first: 20) { nodes { id number name startsAt endsAt isActive isPast } } } }",
    { id: teamId },
  );
  if (!data.team.cyclesEnabled) {
    toast("This team doesn't use cycles yet.", {
      label: "Turn on",
      run: () => navigate(paths.teamSettings(data.team.key)),
    });
    return undefined;
  }
  const ids = issues.map((i) => i.id);
  const open = data.team.cycles.nodes.filter((c) => !c.isPast).reverse();
  return {
    placeholder: `Move ${plural(issues)} to cycle…`,
    items: [
      {
        id: "none",
        label: "No cycle",
        checked: issues.every((i) => !i.cycle),
        onSelect: () => void updateIssues(ids, { cycleId: null }, { cycle: null }),
      },
      ...open.map((c) => ({
        id: c.id,
        label: `${cycleName(c)}${c.isActive ? " · current" : ""}`,
        hint: `${shortDate(c.startsAt)} – ${shortDate(c.endsAt)}`,
        checked: issues.every((i) => i.cycle?.id === c.id),
        onSelect: () =>
          void updateIssues(
            ids,
            { cycleId: c.id },
            { cycle: { id: c.id, number: c.number, name: c.name } },
          ),
      })),
    ],
  };
}

export function priorityMenu(issues: Issue[]): MenuSpec {
  return {
    placeholder: `Set priority of ${plural(issues)}…`,
    items: PRIORITIES.map((p, index) => ({
      id: String(p.value),
      label: p.label,
      icon: <PriorityIcon priority={p.value} />,
      hint: String(index),
      checked: issues.every((i) => i.priority === p.value),
      onSelect: () => {
        void updateIssues(
          issues.map((i) => i.id),
          { priority: p.value },
        );
      },
    })),
  };
}

export function assigneeMenu(issues: Issue[]): MenuSpec {
  const members = workspaceStore.get()?.users.nodes ?? [];
  const ids = issues.map((i) => i.id);
  return {
    placeholder: `Assign ${plural(issues)} to…`,
    items: [
      {
        id: "none",
        label: "No assignee",
        icon: <UnassignedIcon size={16} />,
        checked: issues.every((i) => !i.assignee),
        onSelect: () => {
          void updateIssues(ids, { assigneeId: null }, { assignee: null });
        },
      },
      ...members.map((m) => ({
        id: m.id,
        label: m.isMe ? `${m.name} (you)` : m.name,
        keywords: m.title ?? "",
        icon: <Avatar name={m.name} kind={m.kind} size={16} />,
        hint: m.title ?? undefined,
        checked: issues.every((i) => i.assignee?.id === m.id),
        onSelect: () => {
          void updateIssues(
            ids,
            { assigneeId: m.id },
            { assignee: { id: m.id, name: m.name, kind: m.kind } },
          );
        },
      })),
    ],
  };
}

export function labelsMenu(issues: Issue[]): MenuSpec | undefined {
  const [first] = issues;
  if (!first) return undefined;
  const team = teamOf(first);
  // Labels available to every selected issue's team.
  const labels = (team?.labels.nodes ?? []).filter((label) =>
    issues.every((i) => teamOf(i)?.labels.nodes.some((l) => l.id === label.id)),
  );
  // Track the selection locally so the menu can stay open while toggling.
  const has = new Map<string, boolean>(
    labels.map((l) => [l.id, issues.every((i) => i.labels.nodes.some((x) => x.id === l.id))]),
  );
  const ids = issues.map((i) => i.id);
  const build = (): MenuItem[] => [
    ...labels.map((label) => ({
      id: label.id,
      label: label.name,
      icon: (
        <span
          className="size-2.5 rounded-full"
          style={{ background: tint(label.color, "var(--color-muted)") }}
        />
      ),
      checked: has.get(label.id) ?? false,
      onSelect: () => {
        const on = !has.get(label.id);
        has.set(label.id, on);
        void updateIssues(
          ids,
          on ? { addedLabelIds: [label.id] } : { removedLabelIds: [label.id] },
          (issue) => {
            const rest = (issue.labels?.nodes ?? []).filter((l) => l.id !== label.id);
            return { labels: { nodes: on ? [...rest, label] : rest } };
          },
        );
      },
    })),
    {
      id: "new",
      label: "Create new label…",
      section: labels.length ? "Labels" : undefined,
      onSelect: () => newLabelMenu(team, ids),
    },
  ];
  return {
    placeholder: `Labels for ${plural(issues)}…`,
    items: build(),
    multi: true,
    refresh: build,
  };
}

function newLabelMenu(team: Team | undefined, issueIds: string[]): MenuSpec {
  let name = "";
  return {
    placeholder: "Type the new label's name, then pick where it applies…",
    items: [],
    search: async (query) => {
      name = query;
      const create = async (teamId: string | null) => {
        const created = await mutate<{ issueLabelCreate: { issueLabel: Label } }>(
          "mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name color } } }",
          { input: { name, teamId } },
        );
        const label = created?.issueLabelCreate.issueLabel;
        if (label && issueIds.length) await updateIssues(issueIds, { addedLabelIds: [label.id] });
      };
      return [
        ...(team
          ? [
              {
                id: "team",
                label: `Create “${query}” in ${team.name}`,
                onSelect: () => create(team.id),
              },
            ]
          : []),
        {
          id: "workspace",
          label: `Create “${query}” for all teams`,
          onSelect: () => create(null),
        },
      ];
    },
  };
}

export function estimateMenu(issues: Issue[]): MenuSpec {
  const ids = issues.map((i) => i.id);
  return {
    placeholder: `Estimate ${plural(issues)}…`,
    items: [
      {
        id: "none",
        label: "No estimate",
        onSelect: () => void updateIssues(ids, { estimate: null }),
      },
      ...[1, 2, 3, 5, 8].map((points) => ({
        id: String(points),
        label: `${points} point${points === 1 ? "" : "s"}`,
        checked: issues.every((i) => i.estimate === points),
        onSelect: () => {
          void updateIssues(ids, { estimate: points });
        },
      })),
    ],
  };
}

export async function searchIssueItems(
  query: string,
  onPick: (issue: Issue) => void | Promise<void>,
  exclude: string[] = [],
): Promise<MenuItem[]> {
  const result = await graphql<{ searchIssues: { nodes: Issue[] } }>(
    `query($term: String!) { searchIssues(term: $term, first: 20) { nodes { ...IssueFields } } } ${ISSUE_FIELDS}`,
    { term: query },
  ).catch(() => null);
  return (result?.searchIssues.nodes ?? [])
    .filter((issue) => !exclude.includes(issue.id))
    .map((issue) => ({
      id: issue.id,
      label: issue.title,
      section: "Issues",
      icon: <StatusIcon type={issue.state.type} color={issue.state.color} />,
      hint: issue.identifier,
      onSelect: () => onPick(issue),
    }));
}

export function parentMenu(issue: Issue): MenuSpec {
  return {
    placeholder: `Set parent of ${issue.identifier}… (search issues)`,
    items: issue.parent
      ? [
          {
            id: "none",
            label: "Remove parent",
            onSelect: () => void updateIssues([issue.id], { parentId: null }, { parent: null }),
          },
        ]
      : [],
    search: (query) =>
      searchIssueItems(
        query,
        (parent) =>
          void updateIssues(
            [issue.id],
            { parentId: parent.id },
            { parent: { id: parent.id, identifier: parent.identifier, title: parent.title } },
          ),
        [issue.id],
      ),
  };
}

export function relationMenu(issue: Issue): MenuSpec {
  const kinds = [
    { id: "blocks", label: "Blocks…", type: "blocks", inverse: false },
    { id: "blockedBy", label: "Blocked by…", type: "blocks", inverse: true },
    { id: "related", label: "Related to…", type: "related", inverse: false },
    { id: "duplicate", label: "Duplicate of…", type: "duplicate", inverse: false },
  ];
  return {
    placeholder: `Add a relation to ${issue.identifier}…`,
    items: kinds.map((kind) => ({
      id: kind.id,
      label: kind.label,
      onSelect: () => ({
        placeholder: `${issue.identifier} ${kind.label.toLowerCase().replace("…", "")} … (search issues)`,
        items: [],
        search: (query: string) =>
          searchIssueItems(
            query,
            async (other) => {
              await mutate(
                "mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }",
                {
                  input: {
                    type: kind.type,
                    issueId: kind.inverse ? other.id : issue.id,
                    relatedIssueId: kind.inverse ? issue.id : other.id,
                  },
                },
              );
            },
            [issue.id],
          ),
      }),
    })),
  };
}

export const archiveIssues = (issues: Issue[]) =>
  mutateEach(
    issues.map((i) => i.id),
    "issueArchive",
  );

const unarchiveIssues = (issues: Issue[]) =>
  mutateEach(
    issues.map((i) => i.id),
    "issueUnarchive",
  );

// Context menus -------------------------------------------------------------

/** Copies text and says so, like Linear's "Copied PF-1 to clipboard". */
export function copyText(text: string, what: string) {
  if (!navigator.clipboard) return toast("Copying needs a secure (https) page.");
  navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${what} to clipboard`),
    () => toast("Couldn't copy to the clipboard."),
  );
}

export const linkTo = (path: string) => new URL(path, window.location.origin).href;

export function openInNewTab(path: string) {
  window.open(path, "_blank", "noopener");
}

/** The entries every linkable thing shares: open it in a new tab, copy its link. */
export function linkEntries(path: string, name = "link"): ContextEntry[] {
  return [
    {
      id: "new-tab",
      icon: icon("newTab"),
      label: "Open in new tab",
      onSelect: () => openInNewTab(path),
    },
    {
      id: "copy-link",
      icon: icon("link"),
      label: "Copy link",
      onSelect: () => copyText(linkTo(path), name),
    },
  ];
}

const addDays = (n: number) => {
  const d = new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};

/** Picks a date from a few presets, or whatever is typed ("fri", "in 3 days", "oct 20"). */
export function dateMenu({
  placeholder,
  value,
  onPick,
}: {
  placeholder: string;
  value: string | null;
  onPick: (date: string | null) => unknown;
}): MenuSpec {
  const friday = (5 - new Date().getDay() + 7) % 7;
  const presets: [string, string][] = [
    ["Today", addDays(0)],
    ["Tomorrow", addDays(1)],
    ["End of this week", addDays(friday)],
    ["In one week", addDays(7)],
    ["In two weeks", addDays(14)],
    ["In a month", isoDate(new Date(new Date().setMonth(new Date().getMonth() + 1)))],
  ];
  return {
    placeholder,
    items: [
      ...presets.map(([label, date]) => ({
        id: label,
        label,
        hint: formatDate(date),
        checked: value === date,
        onSelect: () => void onPick(date),
      })),
      ...(value ? [{ id: "none", label: "Remove date", onSelect: () => void onPick(null) }] : []),
    ],
    search: async (query) => {
      const date = parseDate(query);
      return date
        ? [{ id: `on-${date}`, label: formatDate(date), onSelect: () => void onPick(date) }]
        : [];
    },
  };
}

function copyMenu(issues: Issue[]): MenuSpec {
  const [only] = issues;
  const ids = issues.map((i) => i.identifier).join(", ");
  return {
    placeholder: `Copy ${plural(issues)}…`,
    items: [
      { id: "id", label: "Copy ID", hint: ids, onSelect: () => copyText(ids, ids) },
      {
        id: "link",
        label: issues.length === 1 ? "Copy link" : "Copy links",
        onSelect: () =>
          copyText(
            issues.map((i) => linkTo(paths.issue(i.identifier))).join("\n"),
            issues.length === 1 ? "link" : "links",
          ),
      },
      ...(only && issues.length === 1
        ? [
            {
              id: "title",
              label: "Copy title",
              onSelect: () => copyText(only.title, "title"),
            },
            {
              id: "markdown",
              label: "Copy as Markdown link",
              onSelect: () =>
                copyText(
                  `[${only.identifier} ${only.title}](${linkTo(paths.issue(only.identifier))})`,
                  "link",
                ),
            },
          ]
        : []),
    ],
  };
}

/** Linear's issue menu: every property, then copy, relations and archive. For a row or a selection. */
export function issueContextMenu(issues: Issue[]): ContextEntry[] {
  const [first] = issues;
  if (!first) return [];
  const one = issues.length === 1 ? first : undefined;
  const sameTeam = issues.every((i) => i.team.id === first.team.id);
  const team = teamOf(first);
  const archived = issues.every((i) => i.archivedAt);
  return [
    sameTeam && {
      id: "status",
      label: "Status",
      hint: "S",
      icon: one && <StatusIcon type={one.state.type} color={one.state.color} />,
      submenu: () => statusMenu(issues),
    },
    {
      id: "assignee",
      label: "Assignee",
      hint: "A",
      icon:
        one &&
        (one.assignee ? (
          <Avatar name={one.assignee.name} kind={one.assignee.kind} size={14} />
        ) : (
          <UnassignedIcon size={14} />
        )),
      submenu: () => assigneeMenu(issues),
    },
    {
      id: "priority",
      label: "Priority",
      hint: "P",
      icon: one && <PriorityIcon priority={one.priority} />,
      submenu: () => priorityMenu(issues),
    },
    {
      id: "labels",
      icon: icon("label"),
      label: "Labels",
      hint: "L",
      submenu: () => labelsMenu(issues),
    },
    {
      id: "project",
      icon: icon("project"),
      label: "Project",
      hint: "⇧P",
      submenu: () => projectMenu(issues),
    },
    sameTeam &&
      team?.cyclesEnabled && {
        id: "cycle",
        icon: icon("cycle"),
        label: "Cycle",
        hint: "⇧C",
        submenu: () => cycleMenu(issues),
      },
    {
      id: "estimate",
      icon: icon("estimate"),
      label: "Estimate",
      hint: "E",
      submenu: () => estimateMenu(issues),
    },
    {
      id: "due",
      icon: icon("calendar"),
      label: "Due date",
      submenu: () =>
        dateMenu({
          placeholder: "Due date… try “fri” or “in 2 weeks”",
          value: issues.every((i) => i.dueDate === first.dueDate) ? first.dueDate : null,
          onPick: (dueDate) =>
            updateIssues(
              issues.map((i) => i.id),
              { dueDate },
            ),
        }),
    },
    "divider",
    one && {
      id: "sub",
      icon: icon("subIssue"),
      label: "Create sub-issue",
      onSelect: () => createIssueStore.set({ teamId: one.team.id, parentId: one.id }),
    },
    one && {
      id: "parent",
      icon: icon("parent"),
      label: "Set parent issue",
      submenu: () => parentMenu(one),
    },
    one && {
      id: "relation",
      icon: icon("relation"),
      label: "Add relation",
      submenu: () => relationMenu(one),
    },
    "divider",
    { id: "copy", icon: icon("copy"), label: "Copy", submenu: () => copyMenu(issues) },
    one && {
      id: "new-tab",
      icon: icon("newTab"),
      label: "Open in new tab",
      onSelect: () => openInNewTab(paths.issue(one.identifier)),
    },
    "divider",
    archived
      ? {
          id: "unarchive",
          icon: icon("unarchive"),
          label: "Unarchive",
          onSelect: () => unarchiveIssues(issues),
        }
      : {
          id: "archive",
          icon: icon("archive"),
          label: "Archive",
          onSelect: async () => {
            await archiveIssues(issues);
            toast(`Archived ${plural(issues)}`, {
              label: "Undo",
              run: () => void unarchiveIssues(issues),
            });
          },
        },
  ];
}

/** Moves a document into a project, or out of one. */
async function documentProjectMenu(doc: {
  id: string;
  project: { id: string } | null;
}): Promise<MenuSpec> {
  const data = await graphql<{ projects: { nodes: ProjectOption[] } }>(
    "{ projects(first: 100) { nodes { id name color projectMilestones { nodes { id name } } } } }",
  );
  const move = (projectId: string | null) =>
    mutate(
      "mutation($id: String!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { success } }",
      { id: doc.id, input: { projectId } },
    );
  return {
    placeholder: "Move to project…",
    items: [
      {
        id: "none",
        label: "No project",
        checked: !doc.project,
        onSelect: () => void move(null),
      },
      ...data.projects.nodes.map((p) => ({
        id: p.id,
        label: p.name,
        icon: <ProjectDot color={p.color} />,
        checked: doc.project?.id === p.id,
        onSelect: () => void move(p.id),
      })),
    ],
  };
}

export function documentContextMenu(
  doc: { id: string; title: string; project: { id: string } | null },
  /** Where to go once it's deleted, when it's the open page. */
  afterDelete?: string,
): ContextEntry[] {
  const title = doc.title || "Untitled";
  return [
    ...linkEntries(paths.document(doc.id)),
    "divider",
    {
      id: "rename",
      icon: icon("edit"),
      label: "Rename…",
      onSelect: async () => {
        const next = await promptDialog({
          title: "Rename document",
          label: "Title",
          initial: title,
          confirmLabel: "Rename",
        });
        if (next && next !== doc.title)
          await mutate(
            "mutation($id: String!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { success } }",
            { id: doc.id, input: { title: next } },
          );
      },
    },
    {
      id: "project",
      icon: icon("project"),
      label: "Move to project",
      submenu: () => documentProjectMenu(doc),
    },
    "divider",
    {
      id: "delete",
      icon: icon("trash"),
      label: "Delete…",
      danger: true,
      onSelect: async () => {
        if (
          !(await confirmDialog({
            title: `Delete “${title}”?`,
            body: "The document is deleted for everyone.",
            confirmLabel: "Delete",
            destructive: true,
          }))
        )
          return;
        const deleted = await mutate(
          "mutation($id: String!) { documentDelete(id: $id) { success } }",
          { id: doc.id },
        );
        if (deleted && afterDelete) navigate(afterDelete);
      },
    },
  ];
}

/** Everything Cmd+K offers: navigation, creation, and actions on the current issues. */
export function commandPalette(): MenuSpec {
  const workspace = workspaceStore.get();
  const targets = targetStore.get();
  const items: MenuItem[] = [];
  if (targets.length) {
    const label = plural(targets);
    const section = `Actions on ${label}`;
    const status = statusMenu(targets);
    const labels = labelsMenu(targets);
    items.push(
      ...(status
        ? [{ id: "status", label: "Change status…", section, hint: "S", onSelect: () => status }]
        : []),
      {
        id: "priority",
        label: "Set priority…",
        section,
        hint: "P",
        onSelect: () => priorityMenu(targets),
      },
      {
        id: "assign",
        label: "Assign to…",
        section,
        hint: "A",
        onSelect: () => assigneeMenu(targets),
      },
      ...(labels
        ? [
            {
              id: "labels",
              icon: icon("label"),
              label: "Add or remove labels…",
              section,
              hint: "L",
              onSelect: () => labels,
            },
          ]
        : []),
      {
        id: "estimate",
        icon: icon("estimate"),
        label: "Set estimate…",
        section,
        hint: "E",
        onSelect: () => estimateMenu(targets),
      },
      {
        id: "project",
        icon: icon("project"),
        label: "Move to project…",
        section,
        hint: "⇧P",
        onSelect: () => projectMenu(targets),
      },
      {
        id: "cycle",
        icon: icon("cycle"),
        label: "Move to cycle…",
        section,
        hint: "⇧C",
        onSelect: () => cycleMenu(targets),
      },
      {
        id: "archive",
        icon: icon("archive"),
        label: "Archive",
        section,
        onSelect: () => void archiveIssues(targets),
      },
    );
    const [only] = targets;
    if (targets.length === 1 && only) {
      items.push(
        {
          id: "parent",
          icon: icon("parent"),
          label: "Set parent issue…",
          section,
          onSelect: () => parentMenu(only),
        },
        {
          id: "relation",
          icon: icon("relation"),
          label: "Add relation…",
          section,
          onSelect: () => relationMenu(only),
        },
        {
          id: "sub",
          icon: icon("subIssue"),
          label: "Create sub-issue",
          section,
          onSelect: () => createIssueStore.set({ teamId: only.team.id, parentId: only.id }),
        },
        {
          id: "copy",
          icon: icon("copy"),
          label: "Copy issue ID",
          section,
          onSelect: () => void navigator.clipboard?.writeText(only.identifier),
        },
      );
    }
  }
  items.push(
    {
      id: "create",
      icon: icon("newIssue"),
      label: "Create new issue",
      section: "Create",
      hint: "C",
      onSelect: () => createIssueStore.set({}),
    },
    {
      id: "team",
      icon: icon("team"),
      label: "Create new team",
      section: "Create",
      onSelect: () => createTeamStore.set(true),
    },
    {
      id: "hire",
      icon: icon("hire"),
      label: "Hire an agent",
      section: "Create",
      onSelect: () => hireAgentStore.set(true),
    },
    {
      id: "new-project",
      icon: icon("project"),
      label: "Create new project",
      section: "Create",
      onSelect: () => createProjectStore.set(true),
    },
    {
      id: "new-document",
      icon: icon("document"),
      label: "Create new document",
      section: "Create",
      onSelect: () => void createDocument(),
    },
    {
      id: "shortcuts",
      icon: icon("keyboard"),
      label: "Keyboard shortcuts",
      section: "Preferences",
      hint: "?",
      onSelect: () => shortcutsStore.set(true),
    },
    ...(["light", "dark", "system"] as const).map((choice) => ({
      id: `theme-${choice}`,
      label: choice === "system" ? "Change theme: match the system" : `Change theme: ${choice}`,
      section: "Preferences",
      icon: icon(choice === "light" ? "sun" : choice === "dark" ? "moon" : "monitor"),
      ...(themeChoice() === choice ? { hint: "Current" } : {}),
      onSelect: () => setTheme(choice),
    })),
    {
      id: "projects",
      icon: icon("project"),
      label: "Go to Projects",
      section: "Navigation",
      onSelect: () => navigate(paths.projects()),
    },
    {
      id: "roadmap",
      icon: icon("roadmap"),
      label: "Go to Roadmap",
      section: "Navigation",
      onSelect: () => navigate(paths.roadmap()),
    },
    {
      id: "insights",
      icon: icon("insights"),
      label: "Go to Insights",
      section: "Navigation",
      onSelect: () => navigate(paths.insights()),
    },
    {
      id: "usage",
      icon: icon("usage"),
      label: "Go to Usage",
      section: "Navigation",
      onSelect: () => navigate(paths.usage()),
    },
    {
      id: "handbook",
      icon: icon("handbook"),
      label: "Go to Handbook",
      section: "Navigation",
      onSelect: () => navigate(paths.handbook()),
    },
    {
      id: "initiatives",
      icon: icon("initiative"),
      label: "Go to Initiatives",
      section: "Navigation",
      onSelect: () => navigate(paths.initiatives()),
    },
    {
      id: "documents",
      icon: icon("document"),
      label: "Go to Documents",
      section: "Navigation",
      onSelect: () => navigate(paths.documents()),
    },
    {
      id: "inbox",
      icon: icon("inbox"),
      label: "Go to Inbox",
      section: "Navigation",
      onSelect: () => navigate(paths.inbox()),
    },
    {
      id: "my",
      icon: icon("myIssues"),
      label: "Go to My issues",
      section: "Navigation",
      onSelect: () => navigate(paths.myIssues()),
    },
    {
      id: "approvals",
      icon: icon("approval"),
      label: "Go to Approvals",
      section: "Navigation",
      onSelect: () => navigate(paths.requests()),
    },
    {
      id: "runs",
      icon: icon("run"),
      label: "Go to Runs",
      section: "Navigation",
      onSelect: () => navigate(paths.runs()),
    },
    {
      id: "machines",
      icon: icon("machine"),
      label: "Go to Machines",
      section: "Navigation",
      onSelect: () => navigate(paths.machines()),
    },
    {
      id: "company",
      icon: icon("company"),
      label: "Go to Company",
      section: "Navigation",
      onSelect: () => navigate(paths.company()),
    },
    ...(workspace?.teams.nodes ?? []).map((team) => ({
      id: `team-${team.id}`,
      label: `Go to ${team.name}`,
      section: "Navigation",
      icon: icon("team"),
      hint: team.key,
      onSelect: () => navigate(paths.team(team.key)),
    })),
  );
  return {
    placeholder: "Type a command or search…",
    items,
    search: async (query) => {
      const [issues, other] = await Promise.all([
        searchIssueItems(query, (issue) => navigate(paths.issue(issue.identifier))),
        graphql<{
          searchProjects: { nodes: { id: string; name: string; color: string }[] };
          searchDocuments: { nodes: { id: string; title: string }[] };
        }>(
          "query($term: String!) { searchProjects(term: $term, first: 5) { nodes { id name color } } searchDocuments(term: $term, first: 8) { nodes { id title } } }",
          { term: query },
        ).catch(() => null),
      ]);
      return [
        ...issues,
        ...(other?.searchProjects.nodes ?? []).map((p) => ({
          id: `project-${p.id}`,
          label: p.name,
          section: "Projects",
          icon: <ProjectDot color={p.color} />,
          onSelect: () => navigate(paths.project(p.id)),
        })),
        ...(other?.searchDocuments.nodes ?? []).map((d) => ({
          id: `document-${d.id}`,
          label: d.title || "Untitled",
          section: "Documents",
          icon: icon("document"),
          onSelect: () => navigate(paths.document(d.id)),
        })),
      ];
    },
  };
}
