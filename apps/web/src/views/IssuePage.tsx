import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  archiveIssues,
  assigneeMenu,
  copyText,
  createIssueStore,
  cycleMenu,
  cycleName,
  estimateMenu,
  issueContextMenu,
  issueCopyable,
  labelsMenu,
  linkEntries,
  parentMenu,
  priorityMenu,
  projectMenu,
  relationMenu,
  statusMenu,
  targetStore,
  workspaceStore,
} from "../actions.js";
import { contextMenu } from "../contextMenu.js";
import { confirmDialog, DatePicker } from "../controls.js";
import {
  ISSUE_FIELDS,
  type Issue,
  mutate,
  PRIORITIES,
  type StateType,
  updateIssues,
  useQuery,
  type Workspace,
} from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import {
  openReactionPicker,
  type Reaction,
  Reactions,
  reactionMenu,
  SmileyPlus,
} from "../emoji/Reactions.js";
import { Breadcrumbs, button, PageHeader, pageHeading, Section, TitleTag } from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState, PageSkeleton } from "../states.js";
import {
  Avatar,
  DetailLayout,
  dueLabel,
  Kbd,
  LabelChip,
  type MenuSpec,
  openMenu,
  PriorityIcon,
  Property,
  PropertyList,
  propertyButton,
  SlaBadge,
  StatusIcon,
  shortDate,
  timeAgo,
  tint,
  UnassignedIcon,
  useHotkeys,
  useStore,
} from "../ui.js";
import { canCoach, FeedbackForm } from "./Learning.js";
import { RUN_SUMMARY, type RunSummary, RunsSection } from "./Runs.js";

interface MiniIssue {
  id: string;
  identifier: string;
  title: string;
  state: { type: StateType; color: string };
}

interface Comment {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  parent: { id: string } | null;
  user: { id: string; name: string; kind: "owner" | "agent"; isMe: boolean };
  reactions: Reaction[];
}

interface HistoryEntry {
  id: string;
  action: string;
  createdAt: string;
  reason: string | null;
  data: Record<string, unknown> | null;
  actor: { id: string; name: string; kind: "owner" | "agent" } | null;
}

interface IssueDetail extends Issue {
  description: string | null;
  creator: { id: string; name: string; kind: "owner" | "agent" } | null;
  children: { nodes: Issue[] };
  relations: { nodes: { id: string; type: string; relatedIssue: MiniIssue }[] };
  inverseRelations: { nodes: { id: string; type: string; issue: MiniIssue }[] };
  comments: { nodes: Comment[] };
  reactions: Reaction[];
  history: { nodes: HistoryEntry[] };
  subscribers: { nodes: { id: string; isMe: boolean }[] };
  runs: { nodes: RunSummary[] };
}

interface IssueFeedback {
  id: string;
  kind: "stop" | "rejection" | "note";
  body: string;
  createdAt: string;
  agent: { id: string; name: string } | null;
  author: { id: string; name: string; kind: "owner" | "agent" } | null;
  addressedAt: string | null;
  addressedNote: string | null;
}

const FEEDBACK_QUERY = `query($id: String!) { feedbacks(issueId: $id, first: 200) {
  id kind body createdAt agent { id name } author { id name kind } addressedAt addressedNote
} }`;

const MINI = "id identifier title state { type color }";
const REACTIONS = "reactions { id emoji user { id name isMe } }";

const ISSUE_QUERY = `query($id: String!) { issue(id: $id) {
  subscribers { nodes { id isMe } }
  ...IssueFields
  description
  creator { id name kind }
  children(first: 250) { nodes { ...IssueFields } }
  relations { nodes { id type relatedIssue { ${MINI} } } }
  inverseRelations { nodes { id type issue { ${MINI} } } }
  comments(last: 250) { nodes { id body createdAt editedAt parent { id } user { id name kind isMe } ${REACTIONS} } }
  ${REACTIONS}
  history(last: 250) { nodes { id action createdAt reason data actor { id name kind } } }
  runs(first: 20) { nodes { ${RUN_SUMMARY} } }
} } ${ISSUE_FIELDS}`;

export function IssuePage({
  identifier,
  onClose = () => history.back(),
}: {
  identifier: string;
  /** Where Escape goes: back to where the issue was opened from, unless a pane says otherwise. */
  onClose?: () => void;
}) {
  const { data, error } = useQuery<{ issue: IssueDetail }>(ISSUE_QUERY, { id: identifier });
  const feedback = useQuery<{ feedbacks: IssueFeedback[] }>(FEEDBACK_QUERY, { id: identifier });
  const issue = data?.issue;
  const workspace = useStore(workspaceStore);

  useEffect(() => {
    targetStore.set(issue ? [issue] : []);
  }, [issue]);
  useEffect(() => () => targetStore.set([]), []);

  const open = (menu: (issues: Issue[]) => MenuSpec | undefined) => () => {
    const spec = issue ? menu([issue]) : undefined;
    if (spec) openMenu(spec);
  };
  useHotkeys({
    s: open(statusMenu),
    p: open(priorityMenu),
    a: open(assigneeMenu),
    l: open(labelsMenu),
    e: open(estimateMenu),
    "shift+p": () => issue && void projectMenu([issue]).then(openMenu),
    "shift+c": () => issue && void cycleMenu([issue]).then((spec) => spec && openMenu(spec)),
    Escape: onClose,
  });

  if (error) {
    return error.includes("not found") ? (
      <EmptyState
        icon="compass"
        title="Issue not found"
        description="It may have been deleted or moved to another team, or the link is mistyped."
        action={{ label: "Go to My issues", onClick: () => navigate(paths.myIssues()) }}
      />
    ) : (
      <p className="px-6 py-10 text-center text-muted">{error}</p>
    );
  }
  // Everything the page shows arrives before it renders, so nothing pops in and pushes it down.
  const feedbackItems = feedback.data?.feedbacks ?? (feedback.error ? [] : null);
  if (!issue || !workspace || !feedbackItems) return <PageSkeleton />;
  const team = workspace.teams.nodes.find((t) => t.id === issue.team.id);

  return (
    <div className="flex h-full min-h-0 animate-fade-in flex-col">
      <PageHeader
        actions={
          <>
            <SubscribeButton issue={issue} />
            {issue.archivedAt ? (
              <ToolbarButton
                onClick={() =>
                  void mutate("mutation($id: String!) { issueUnarchive(id: $id) { success } }", {
                    id: issue.id,
                  })
                }
              >
                Unarchive
              </ToolbarButton>
            ) : (
              <ToolbarButton onClick={() => void archiveIssues([issue])}>Archive</ToolbarButton>
            )}
          </>
        }
      >
        <Breadcrumbs
          trail={[{ label: team?.name ?? issue.team.key, to: paths.team(issue.team.key) }]}
        >
          {issue.identifier}
          {issue.archivedAt && <TitleTag>Archived</TitleTag>}
        </Breadcrumbs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailLayout
          head={
            <>
              {issue.parent && (
                <button
                  type="button"
                  onClick={() => issue.parent && navigate(paths.issue(issue.parent.identifier))}
                  className="mb-2 text-muted hover:text-ink"
                >
                  Sub-issue of {issue.parent.identifier} {issue.parent.title}
                </button>
              )}
              <EditableTitle issue={issue} />
              <EditableDescription issue={issue} />
              <Reactions reactions={issue.reactions} target={{ issueId: issue.id }} />
            </>
          }
          side={<Properties issue={issue} workspace={workspace} />}
        >
          <SubIssues issue={issue} />
          <Relations issue={issue} />
          <RunsSection runs={issue.runs.nodes} showIssue={false} />
          <Activity issue={issue} workspace={workspace} feedback={feedbackItems} />
        </DetailLayout>
      </div>
    </div>
  );
}

function ToolbarButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={button("ghost", "sm")}>
      {children}
    </button>
  );
}

function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      {...props}
      className={`resize-none overflow-hidden ${props.className ?? ""}`}
    />
  );
}

function EditableTitle({ issue }: { issue: IssueDetail }) {
  const [title, setTitle] = useState(issue.title);
  useEffect(() => setTitle(issue.title), [issue.title]);
  const save = () => {
    const next = title.trim();
    if (next && next !== issue.title) void updateIssues([issue.id], { title: next });
    else setTitle(issue.title);
  };
  return (
    <AutoTextarea
      aria-label="Issue title"
      value={title}
      onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setTitle(issue.title);
          e.currentTarget.blur();
        }
      }}
      className={`w-full bg-transparent outline-none ${pageHeading}`}
    />
  );
}

function EditableDescription({ issue }: { issue: IssueDetail }) {
  const saved = useRef(issue.description ?? "");
  saved.current = issue.description ?? "";
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const save = (text: string) => {
    clearTimeout(timer.current);
    if (text.trim() !== saved.current.trim()) {
      saved.current = text;
      void updateIssues([issue.id], { description: text });
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="mt-3 min-h-16 text-[15px]">
      <RichEditor
        label="Issue description"
        value={issue.description ?? ""}
        placeholder="Add description…"
        onChange={(text) => {
          // Saves as you pause, like Linear, and again when you leave the editor.
          clearTimeout(timer.current);
          timer.current = setTimeout(() => save(text), 1000);
        }}
        onBlur={save}
      />
    </div>
  );
}

function Properties({ issue, workspace }: { issue: IssueDetail; workspace: Workspace }) {
  const open = (spec: MenuSpec | undefined) => () => spec && openMenu(spec);
  const due = issue.dueDate ? dueLabel(issue.dueDate) : null;
  const priority = PRIORITIES.find((p) => p.value === issue.priority)?.label ?? "No priority";
  return (
    <PropertyList>
      <Property label="Status" control>
        <PropertyButton onClick={open(statusMenu([issue]))} hint="S">
          <StatusIcon type={issue.state.type} color={issue.state.color} />
          {issue.state.name}
        </PropertyButton>
      </Property>
      <Property label="Priority" control>
        <PropertyButton onClick={open(priorityMenu([issue]))} hint="P">
          <PriorityIcon priority={issue.priority} />
          {priority}
        </PropertyButton>
      </Property>
      <Property label="Assignee" control>
        <PropertyButton onClick={open(assigneeMenu([issue]))} hint="A">
          {issue.assignee ? (
            <>
              <Avatar name={issue.assignee.name} kind={issue.assignee.kind} />
              {issue.assignee.name}
            </>
          ) : (
            <>
              <UnassignedIcon />
              <span className="text-faint">Unassigned</span>
            </>
          )}
        </PropertyButton>
      </Property>
      <Property label="Labels" control>
        <PropertyButton onClick={open(labelsMenu([issue]))} hint="L">
          {issue.labels.nodes.length ? (
            <span className="flex flex-wrap gap-1">
              {issue.labels.nodes.map((label) => (
                <LabelChip key={label.id} label={label} />
              ))}
            </span>
          ) : (
            <span className="text-faint">Add label</span>
          )}
        </PropertyButton>
      </Property>
      <Property label="Estimate" control>
        <PropertyButton onClick={open(estimateMenu([issue]))} hint="E">
          {issue.estimate != null ? (
            `${issue.estimate} points`
          ) : (
            <span className="text-faint">Set estimate</span>
          )}
        </PropertyButton>
      </Property>
      <Property label="Due date" control>
        <DatePicker
          aria-label="Due date"
          value={issue.dueDate}
          onChange={(dueDate) => void updateIssues([issue.id], { dueDate })}
          placeholder="Set due date"
          className={`${propertyButton} w-full outline-none ${due?.overdue ? "text-critical!" : ""}`}
        />
      </Property>
      <Property label="Project" control>
        <PropertyButton onClick={() => void projectMenu([issue]).then(openMenu)} hint="Shift+P">
          {issue.project ? (
            <>
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: tint(issue.project.color, "var(--color-muted)") }}
                aria-hidden
              />
              <span className="truncate">
                {issue.project.name}
                {issue.projectMilestone && (
                  <span className="text-faint"> › {issue.projectMilestone.name}</span>
                )}
              </span>
            </>
          ) : (
            <span className="text-faint">Add to project</span>
          )}
        </PropertyButton>
      </Property>
      {issue.slaBreachesAt && (
        <Property label="SLA">
          <SlaBadge
            breachesAt={issue.slaBreachesAt}
            open={issue.state.type !== "completed" && issue.state.type !== "canceled"}
          />
          {shortDate(issue.slaBreachesAt)}
        </Property>
      )}
      <Property label="Cycle" control>
        <PropertyButton
          onClick={() => void cycleMenu([issue]).then((spec) => spec && openMenu(spec))}
          hint="Shift+C"
        >
          {issue.cycle ? (
            <span className="truncate">{cycleName(issue.cycle)}</span>
          ) : (
            <span className="text-faint">Add to cycle</span>
          )}
        </PropertyButton>
      </Property>
      <Property label="Parent" control>
        <PropertyButton onClick={open(parentMenu(issue))}>
          {issue.parent ? issue.parent.identifier : <span className="text-faint">Set parent</span>}
        </PropertyButton>
      </Property>
      <Property label="Created by">
        {issue.creator?.name ?? "Unknown"} · {timeAgo(issue.createdAt)}
      </Property>
      <Property label="Team">
        {workspace.teams.nodes.find((t) => t.id === issue.team.id)?.name ?? issue.team.key}
      </Property>
    </PropertyList>
  );
}

function PropertyButton({
  onClick,
  children,
  hint,
}: {
  onClick: () => void;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint ? `Shortcut: ${hint}` : undefined}
      className={propertyButton}
    >
      {children}
    </button>
  );
}

function SubIssues({ issue }: { issue: IssueDetail }) {
  const children = issue.children.nodes;
  const done = children.filter(
    (c) => c.state.type === "completed" || c.state.type === "canceled",
  ).length;
  return (
    <Section
      title="Sub-issues"
      count={children.length > 0 ? `${done}/${children.length}` : undefined}
      actions={
        <button
          type="button"
          onClick={() => createIssueStore.set({ teamId: issue.team.id, parentId: issue.id })}
          className={button("ghost", "sm")}
        >
          + Add sub-issue
        </button>
      }
    >
      {children.length > 0 && (
        <div className="rounded-lg border border-line">
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() => navigate(paths.issue(child.identifier))}
              onContextMenu={contextMenu(() => issueContextMenu([child]))}
              className="flex w-full items-center gap-2.5 border-b border-line/60 px-3 py-2 text-left last:border-b-0 hover:bg-raised"
            >
              <PriorityIcon priority={child.priority} />
              <span className="w-14 shrink-0 text-faint">{child.identifier}</span>
              <StatusIcon type={child.state.type} color={child.state.color} />
              <span className="min-w-0 flex-1 truncate">{child.title}</span>
              {child.assignee ? (
                <Avatar name={child.assignee.name} kind={child.assignee.kind} />
              ) : (
                <UnassignedIcon />
              )}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

const RELATION_LABELS: Record<string, [string, string]> = {
  blocks: ["Blocks", "Blocked by"],
  duplicate: ["Duplicate of", "Duplicated by"],
  related: ["Related to", "Related to"],
};

function Relations({ issue }: { issue: IssueDetail }) {
  const rows = [
    ...issue.relations.nodes.map((r) => ({
      id: r.id,
      label: RELATION_LABELS[r.type]?.[0] ?? r.type,
      other: r.relatedIssue,
    })),
    ...issue.inverseRelations.nodes.map((r) => ({
      id: r.id,
      label: RELATION_LABELS[r.type]?.[1] ?? r.type,
      other: r.issue,
    })),
  ];
  return (
    <Section
      title="Relations"
      actions={
        <button
          type="button"
          onClick={() => openMenu(relationMenu(issue))}
          className={button("ghost", "sm")}
        >
          + Add relation
        </button>
      }
    >
      {rows.map((row) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: the right-click menu repeats its buttons
        <div
          key={row.id}
          onContextMenu={contextMenu(() => [
            {
              id: "open",
              label: "Open",
              onSelect: () => navigate(paths.issue(row.other.identifier)),
            },
            ...linkEntries(issueCopyable(row.other)),
            "divider",
            {
              id: "remove",
              label: "Remove relation",
              danger: true,
              onSelect: () =>
                mutate("mutation($id: String!) { issueRelationDelete(id: $id) { success } }", {
                  id: row.id,
                }),
            },
          ])}
          className="group flex items-center gap-2.5 rounded-md px-1 py-1.5 hover:bg-raised"
        >
          <span className="w-24 shrink-0 text-faint">{row.label}</span>
          <StatusIcon type={row.other.state.type} color={row.other.state.color} />
          <button
            type="button"
            onClick={() => navigate(paths.issue(row.other.identifier))}
            className="min-w-0 flex-1 truncate text-left hover:underline"
          >
            <span className="mr-2 text-faint">{row.other.identifier}</span>
            {row.other.title}
          </button>
          <button
            type="button"
            aria-label="Remove relation"
            onClick={() =>
              void mutate("mutation($id: String!) { issueRelationDelete(id: $id) { success } }", {
                id: row.id,
              })
            }
            className="px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-ink"
          >
            ✕
          </button>
        </div>
      ))}
    </Section>
  );
}

// Activity: history and comments, oldest first, like Linear ------------------

function Activity({
  issue,
  workspace,
  feedback,
}: {
  issue: IssueDetail;
  workspace: Workspace;
  feedback: IssueFeedback[];
}) {
  const comments = issue.comments.nodes;
  const items: (
    | { at: string; kind: "event"; entry: HistoryEntry }
    | { at: string; kind: "comment"; comment: Comment }
    | { at: string; kind: "feedback"; feedback: IssueFeedback }
  )[] = [
    ...issue.history.nodes
      .filter(
        (entry) => !entry.action.startsWith("comment.") && !entry.action.startsWith("reaction."),
      )
      .map((entry) => ({ at: entry.createdAt, kind: "event" as const, entry })),
    ...comments
      .filter((c) => !c.parent)
      .map((comment) => ({ at: comment.createdAt, kind: "comment" as const, comment })),
    ...feedback.map((f) => ({ at: f.createdAt, kind: "feedback" as const, feedback: f })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <Section title="Activity" className="border-t border-line pt-6">
      <ol className="mt-2 space-y-3">
        {items.map((item) =>
          item.kind === "event" ? (
            <li key={item.entry.id} className="flex animate-fade-in items-start gap-2 text-muted">
              <span className="mt-0.5">
                {item.entry.actor ? (
                  <Avatar name={item.entry.actor.name} kind={item.entry.actor.kind} size={16} />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-ink">{item.entry.actor?.name ?? "Someone"}</span>{" "}
                {describe(item.entry, issue, workspace)}
                <span className="text-faint"> · {timeAgo(item.entry.createdAt)}</span>
                {item.entry.reason && (
                  <span className="block text-faint">“{item.entry.reason}”</span>
                )}
              </span>
            </li>
          ) : item.kind === "feedback" ? (
            <li key={item.feedback.id}>
              <FeedbackEntry feedback={item.feedback} />
            </li>
          ) : (
            <li key={item.comment.id} className="animate-fade-in">
              <CommentThread
                comment={item.comment}
                replies={comments.filter((c) => c.parent?.id === item.comment.id)}
                issue={issue}
                workspace={workspace}
              />
            </li>
          ),
        )}
      </ol>
      <CommentComposer issueId={issue.id} />
      {issue.assignee && canCoach(workspace, issue.assignee.id) && (
        <AssigneeFeedback issue={issue} agent={issue.assignee} />
      )}
    </Section>
  );
}

const FEEDBACK_VERB = {
  note: "gave feedback to",
  stop: "stopped a run by",
  rejection: "rejected a request from",
};

/** Feedback about this issue, and what the agent changed because of it. */
function FeedbackEntry({ feedback: f }: { feedback: IssueFeedback }) {
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-2.5">
      <div className="flex items-center gap-2">
        {f.author && <Avatar name={f.author.name} kind={f.author.kind} size={18} />}
        <span className="min-w-0 flex-1 text-muted">
          <span className="font-medium text-ink">{f.author?.name ?? "The hub"}</span>{" "}
          {FEEDBACK_VERB[f.kind]} <span className="text-ink">{f.agent?.name ?? "an agent"}</span>
          <span className="text-faint"> · {timeAgo(f.createdAt)}</span>
        </span>
      </div>
      <RichText source={f.body} className="mt-1.5" />
      {f.addressedAt ? (
        <p className="mt-1 text-[12px] text-muted">✓ {f.addressedNote}</p>
      ) : (
        <p className="mt-1 text-[12px] text-faint">Not addressed yet</p>
      )}
    </div>
  );
}

/** Feedback for the agent the issue is assigned to, about how it handled this issue. */
function AssigneeFeedback({
  issue,
  agent,
}: {
  issue: IssueDetail;
  agent: { id: string; name: string };
}) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="mt-3">
      <FeedbackForm
        agent={agent}
        issueId={issue.id}
        label={`Feedback for ${agent.name}`}
        autoFocus
        onDone={() => setOpen(false)}
      />
    </div>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="mt-3 text-faint hover:text-ink">
      Give {agent.name} feedback…
    </button>
  );
}

function describe(entry: HistoryEntry, issue: IssueDetail, workspace: Workspace): string {
  const data = (entry.data ?? {}) as Record<string, { from: unknown; to: unknown } | unknown>;
  const team = workspace.teams.nodes.find((t) => t.id === issue.team.id);
  const stateName = (id: unknown) =>
    team?.states.nodes.find((s) => s.id === id)?.name ?? "another status";
  const userName = (id: unknown) =>
    id ? (workspace.users.nodes.find((u) => u.id === id)?.name ?? "someone") : "no one";
  const labelName = (id: string) => team?.labels.nodes.find((l) => l.id === id)?.name ?? "a label";
  switch (entry.action) {
    case "issue.create":
      return "created the issue";
    case "issue.archive":
      return "archived the issue";
    case "issue.unarchive":
      return "restored the issue";
    case "issueRelation.create":
      return `added a ${String(data.type)} relation`;
    case "issueRelation.delete":
      return `removed a ${String(data.type)} relation`;
    case "issue.update": {
      const parts: string[] = [];
      for (const [field, change] of Object.entries(data)) {
        const { from, to } = change as { from: unknown; to: unknown };
        if (field === "stateId")
          parts.push(`changed status from ${stateName(from)} to ${stateName(to)}`);
        else if (field === "assigneeId")
          parts.push(to ? `assigned to ${userName(to)}` : "removed the assignee");
        else if (field === "priority")
          parts.push(
            `set priority to ${PRIORITIES.find((p) => p.value === to)?.label ?? String(to)}`,
          );
        else if (field === "title") parts.push(`renamed the issue to “${String(to)}”`);
        else if (field === "description") parts.push("updated the description");
        else if (field === "estimate")
          parts.push(to == null ? "removed the estimate" : `estimated ${String(to)} points`);
        else if (field === "dueDate")
          parts.push(to ? `set the due date to ${String(to)}` : "removed the due date");
        else if (field === "parentId")
          parts.push(to ? "set the parent issue" : "removed the parent issue");
        else if (field === "labelIds") {
          const before = (from as string[]) ?? [];
          const after = (to as string[]) ?? [];
          const added = after.filter((id) => !before.includes(id)).map(labelName);
          const removed = before.filter((id) => !after.includes(id)).map(labelName);
          if (added.length) parts.push(`added ${added.join(", ")}`);
          if (removed.length) parts.push(`removed ${removed.join(", ")}`);
        } else parts.push(`changed ${field}`);
      }
      return parts.join(", ") || "updated the issue";
    }
    default:
      return entry.action;
  }
}

function CommentThread({
  comment,
  replies,
  issue,
  workspace,
}: {
  comment: Comment;
  replies: Comment[];
  issue: IssueDetail;
  workspace: Workspace;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-panel">
      <CommentBody
        comment={comment}
        issueId={issue.id}
        workspace={workspace}
        onReply={() => setReplying(true)}
      />
      {replies.map((reply) => (
        <div key={reply.id} className="border-t border-line/60">
          <CommentBody
            comment={reply}
            issueId={issue.id}
            workspace={workspace}
            onReply={() => setReplying(true)}
          />
        </div>
      ))}
      <div className="border-t border-line/60 px-4 py-2">
        {replying ? (
          <CommentComposer
            issueId={issue.id}
            parentId={comment.id}
            onDone={() => setReplying(false)}
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="text-faint hover:text-ink"
          >
            Reply…
          </button>
        )}
      </div>
    </div>
  );
}

function CommentBody({
  comment,
  issueId,
  workspace,
  onReply,
}: {
  comment: Comment;
  issueId: string;
  workspace: Workspace;
  onReply: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reactRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [coaching, setCoaching] = useState(false);
  const [text, setText] = useState(comment.body);
  async function saveEdit() {
    if (!text.trim()) return;
    if (
      await mutate(
        "mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }",
        { id: comment.id, body: text },
      )
    )
      setEditing(false);
  }
  const startEditing = () => {
    setText(comment.body);
    setEditing(true);
  };
  const remove = async () => {
    if (
      await confirmDialog({
        title: "Delete this comment?",
        body: "Its replies are deleted too.",
        confirmLabel: "Delete",
        destructive: true,
      })
    ) {
      void mutate("mutation($id: String!) { commentDelete(id: $id) { success } }", {
        id: comment.id,
      });
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the right-click menu repeats its buttons
    <div
      ref={ref}
      className="group px-4 py-3"
      onContextMenu={contextMenu(() => [
        { id: "reply", label: "Reply", onSelect: onReply },
        {
          id: "react",
          label: "Add reaction",
          submenu: () =>
            reactionMenu(comment.reactions, { commentId: comment.id }, () => ref.current),
        },
        comment.user.isMe && { id: "edit", label: "Edit", onSelect: startEditing },
        canCoach(workspace, comment.user.id) && {
          id: "feedback",
          label: "Give feedback",
          onSelect: () => setCoaching(true),
        },
        "divider",
        { id: "copy", label: "Copy text", onSelect: () => copyText(comment.body, "comment") },
        "divider",
        { id: "delete", label: "Delete…", danger: true, onSelect: remove },
      ])}
    >
      <div className="flex items-center gap-2">
        <Avatar name={comment.user.name} kind={comment.user.kind} size={18} />
        <span className="font-medium">{comment.user.name}</span>
        <span className="text-faint">
          {timeAgo(comment.createdAt)}
          {comment.editedAt ? " (edited)" : ""}
        </span>
        <span className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 has-[:focus-visible]:opacity-100">
          <button
            ref={reactRef}
            type="button"
            aria-label="React"
            title="Add reaction"
            onClick={() =>
              reactRef.current &&
              openReactionPicker(reactRef.current, comment.reactions, { commentId: comment.id })
            }
            className="text-faint hover:text-ink"
          >
            <SmileyPlus size={15} />
          </button>
          {canCoach(workspace, comment.user.id) && (
            <button
              type="button"
              onClick={() => setCoaching(true)}
              className="text-faint hover:text-ink"
            >
              Give feedback
            </button>
          )}
          {comment.user.isMe && (
            <button type="button" onClick={startEditing} className="text-faint hover:text-ink">
              Edit
            </button>
          )}
          <button type="button" onClick={() => void remove()} className="text-faint hover:text-ink">
            Delete
          </button>
        </span>
      </div>
      {editing ? (
        <div className="mt-2">
          <div className="rounded-md border border-line bg-canvas px-3 py-2 focus-within:border-accent">
            <RichEditor
              label="Edit comment"
              value={comment.body}
              autoFocus
              onChange={setText}
              onSubmit={() => void saveEdit()}
              onEscape={() => setEditing(false)}
            />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className={button("ghost")}>
              Cancel
            </button>
            <button type="button" onClick={() => void saveEdit()} className={button("primary")}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <RichText source={comment.body} className="mt-1.5" />
      )}
      <Reactions
        reactions={comment.reactions}
        target={{ commentId: comment.id }}
        addWhenEmpty={false}
      />
      {coaching && (
        <div className="mt-2">
          <FeedbackForm
            agent={comment.user}
            issueId={issueId}
            label={`Feedback for ${comment.user.name}`}
            autoFocus
            onDone={() => setCoaching(false)}
          />
        </div>
      )}
    </div>
  );
}

function CommentComposer({
  issueId,
  parentId,
  onDone,
  autoFocus,
}: {
  issueId: string;
  parentId?: string;
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Each sent comment starts a fresh editor.
  const [sent, setSent] = useState(0);
  async function submit() {
    if (!body.trim() || busy) return;
    setBusy(true);
    const ok = await mutate(
      "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
      {
        input: { issueId, body, parentId },
      },
    );
    setBusy(false);
    if (ok) {
      setBody("");
      setSent((n) => n + 1);
      onDone?.();
    }
  }
  return (
    <div
      className={
        parentId
          ? ""
          : "mt-5 rounded-lg border border-line bg-panel px-4 py-3 focus-within:border-faint"
      }
    >
      <RichEditor
        key={sent}
        label={parentId ? "Reply" : "Leave a comment"}
        autoFocus={autoFocus || sent > 0}
        value=""
        placeholder={parentId ? "Leave a reply…" : "Leave a comment…"}
        onChange={setBody}
        onSubmit={() => void submit()}
        onEscape={onDone}
        className="min-h-6"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="text-[12px] text-faint max-sm:hidden">
          <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
        </span>
        <button
          type="button"
          disabled={!body.trim() || busy}
          onClick={() => void submit()}
          className={button("primary")}
        >
          {parentId ? "Reply" : "Comment"}
        </button>
      </div>
    </div>
  );
}

/** Follow an issue to hear about its comments and status changes in your Inbox. */
function SubscribeButton({ issue }: { issue: IssueDetail }) {
  const following = issue.subscribers.nodes.some((u) => u.isMe);
  return (
    <ToolbarButton
      onClick={() =>
        void mutate(
          `mutation($id: String!) { ${following ? "issueUnsubscribe" : "issueSubscribe"}(id: $id) { success } }`,
          { id: issue.id },
        )
      }
    >
      {following ? "Unsubscribe" : "Subscribe"}
    </ToolbarButton>
  );
}
