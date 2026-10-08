import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  archiveIssues,
  assigneeMenu,
  createIssueStore,
  estimateMenu,
  labelsMenu,
  parentMenu,
  priorityMenu,
  relationMenu,
  statusMenu,
  targetStore,
  workspaceStore,
} from "../actions.js";
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
import { navigate, paths } from "../router.js";
import {
  Avatar,
  dueLabel,
  Kbd,
  LabelChip,
  type MenuSpec,
  openMenu,
  PriorityIcon,
  StatusIcon,
  timeAgo,
  UnassignedIcon,
  useHotkeys,
  useStore,
} from "../ui.js";

interface MiniIssue {
  id: string;
  identifier: string;
  title: string;
  state: { type: StateType; color: string };
}

interface Reaction {
  id: string;
  emoji: string;
  user: { id: string; name: string; isMe: boolean };
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
}

const MINI = "id identifier title state { type color }";
const REACTIONS = "reactions { id emoji user { id name isMe } }";

const ISSUE_QUERY = `query($id: String!) { issue(id: $id) {
  ...IssueFields
  description
  creator { id name kind }
  children(first: 250) { nodes { ...IssueFields } }
  relations { nodes { id type relatedIssue { ${MINI} } } }
  inverseRelations { nodes { id type issue { ${MINI} } } }
  comments(first: 250) { nodes { id body createdAt editedAt parent { id } user { id name kind isMe } ${REACTIONS} } }
  ${REACTIONS}
  history(first: 250) { nodes { id action createdAt reason data actor { id name kind } } }
} } ${ISSUE_FIELDS}`;

export function IssuePage({ identifier }: { identifier: string }) {
  const { data, error } = useQuery<{ issue: IssueDetail }>(ISSUE_QUERY, { id: identifier });
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
    Escape: () => issue && navigate(paths.team(issue.team.key)),
  });

  if (error) {
    return (
      <p className="px-6 py-10 text-center text-muted">
        {error.includes("not found") ? "Issue not found." : error}
      </p>
    );
  }
  if (!issue || !workspace) return null;
  const team = workspace.teams.nodes.find((t) => t.id === issue.team.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <button
          type="button"
          onClick={() => navigate(paths.team(issue.team.key))}
          className="text-muted hover:text-ink"
        >
          {team?.name ?? issue.team.key}
        </button>
        <span className="text-faint">›</span>
        <span className="font-medium">{issue.identifier}</span>
        {issue.archivedAt && (
          <span className="rounded bg-raised px-1.5 text-[12px] text-muted">Archived</span>
        )}
        <div className="ml-auto flex items-center gap-1">
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
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row">
          <div className="min-w-0 flex-1 px-4 py-6 md:px-10">
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
            <Properties issue={issue} workspace={workspace} className="mt-6 lg:hidden" />
            <SubIssues issue={issue} />
            <Relations issue={issue} />
            <Activity issue={issue} workspace={workspace} />
          </div>
          <aside className="hidden w-72 shrink-0 border-l border-line px-5 py-6 lg:block">
            <Properties issue={issue} workspace={workspace} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
    >
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
      className="w-full bg-transparent text-2xl font-semibold outline-none"
    />
  );
}

function EditableDescription({ issue }: { issue: IssueDetail }) {
  const [text, setText] = useState(issue.description ?? "");
  useEffect(() => setText(issue.description ?? ""), [issue.description]);
  return (
    <AutoTextarea
      aria-label="Issue description"
      value={text}
      placeholder="Add description…"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== (issue.description ?? ""))
          void updateIssues([issue.id], { description: text });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
      }}
      className="mt-3 min-h-16 w-full bg-transparent leading-relaxed text-ink/90 outline-none placeholder:text-faint"
    />
  );
}

function Properties({
  issue,
  workspace,
  className = "",
}: {
  issue: IssueDetail;
  workspace: Workspace;
  className?: string;
}) {
  const open = (spec: MenuSpec | undefined) => () => spec && openMenu(spec);
  const due = issue.dueDate ? dueLabel(issue.dueDate) : null;
  const priority = PRIORITIES.find((p) => p.value === issue.priority)?.label ?? "No priority";
  return (
    <div className={`grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-1 ${className}`}>
      <PropertyLabel>Status</PropertyLabel>
      <PropertyButton onClick={open(statusMenu([issue]))} hint="S">
        <StatusIcon type={issue.state.type} color={issue.state.color} />
        {issue.state.name}
      </PropertyButton>
      <PropertyLabel>Priority</PropertyLabel>
      <PropertyButton onClick={open(priorityMenu([issue]))} hint="P">
        <PriorityIcon priority={issue.priority} />
        {priority}
      </PropertyButton>
      <PropertyLabel>Assignee</PropertyLabel>
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
      <PropertyLabel>Labels</PropertyLabel>
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
      <PropertyLabel>Estimate</PropertyLabel>
      <PropertyButton onClick={open(estimateMenu([issue]))} hint="E">
        {issue.estimate != null ? (
          `${issue.estimate} points`
        ) : (
          <span className="text-faint">Set estimate</span>
        )}
      </PropertyButton>
      <PropertyLabel>Due date</PropertyLabel>
      <label className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised">
        <input
          type="date"
          aria-label="Due date"
          value={issue.dueDate ?? ""}
          onChange={(e) => void updateIssues([issue.id], { dueDate: e.target.value || null })}
          className={`w-full bg-transparent outline-none [color-scheme:dark] ${due?.overdue ? "text-red-400" : issue.dueDate ? "" : "text-faint"}`}
        />
      </label>
      <PropertyLabel>Parent</PropertyLabel>
      <PropertyButton onClick={open(parentMenu(issue))}>
        {issue.parent ? issue.parent.identifier : <span className="text-faint">Set parent</span>}
      </PropertyButton>
      <PropertyLabel>Created by</PropertyLabel>
      <span className="px-2 py-1 text-muted">
        {issue.creator?.name ?? "Unknown"} · {timeAgo(issue.createdAt)}
      </span>
      <PropertyLabel>Team</PropertyLabel>
      <span className="px-2 py-1 text-muted">
        {workspace.teams.nodes.find((t) => t.id === issue.team.id)?.name ?? issue.team.key}
      </span>
    </div>
  );
}

function PropertyLabel({ children }: { children: ReactNode }) {
  return <span className="text-faint">{children}</span>;
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
      className="flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-raised"
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
    <section className="mt-8">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-medium">Sub-issues</h2>
        {children.length > 0 && (
          <span className="text-faint">
            {done}/{children.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => createIssueStore.set({ teamId: issue.team.id, parentId: issue.id })}
          className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
        >
          + Add sub-issue
        </button>
      </div>
      {children.length > 0 && (
        <div className="rounded-lg border border-line">
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() => navigate(paths.issue(child.identifier))}
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
    </section>
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
    <section className="mt-6">
      <div className="mb-2 flex items-center">
        <h2 className="font-medium">Relations</h2>
        <button
          type="button"
          onClick={() => openMenu(relationMenu(issue))}
          className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
        >
          + Add relation
        </button>
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
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
    </section>
  );
}

// Activity: history and comments, oldest first, like Linear ------------------

function Activity({ issue, workspace }: { issue: IssueDetail; workspace: Workspace }) {
  const comments = issue.comments.nodes;
  const items: (
    | { at: string; kind: "event"; entry: HistoryEntry }
    | { at: string; kind: "comment"; comment: Comment }
  )[] = [
    ...issue.history.nodes
      .filter(
        (entry) => !entry.action.startsWith("comment.") && !entry.action.startsWith("reaction."),
      )
      .map((entry) => ({ at: entry.createdAt, kind: "event" as const, entry })),
    ...comments
      .filter((c) => !c.parent)
      .map((comment) => ({ at: comment.createdAt, kind: "comment" as const, comment })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="mt-10 border-t border-line pt-6">
      <h2 className="mb-4 font-medium">Activity</h2>
      <ol className="space-y-3">
        {items.map((item) =>
          item.kind === "event" ? (
            <li key={item.entry.id} className="flex items-start gap-2 text-muted">
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
          ) : (
            <li key={item.comment.id}>
              <CommentThread
                comment={item.comment}
                replies={comments.filter((c) => c.parent?.id === item.comment.id)}
                issue={issue}
              />
            </li>
          ),
        )}
      </ol>
      <CommentComposer issueId={issue.id} />
    </section>
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
}: {
  comment: Comment;
  replies: Comment[];
  issue: IssueDetail;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-panel">
      <CommentBody comment={comment} />
      {replies.map((reply) => (
        <div key={reply.id} className="border-t border-line/60">
          <CommentBody comment={reply} />
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

function CommentBody({ comment }: { comment: Comment }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  return (
    <div className="group px-4 py-3">
      <div className="flex items-center gap-2">
        <Avatar name={comment.user.name} kind={comment.user.kind} size={18} />
        <span className="font-medium">{comment.user.name}</span>
        <span className="text-faint">
          {timeAgo(comment.createdAt)}
          {comment.editedAt ? " (edited)" : ""}
        </span>
        <span className="ml-auto flex gap-2 opacity-0 group-hover:opacity-100">
          {comment.user.isMe && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-faint hover:text-ink"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Delete this comment and its replies?")) {
                void mutate("mutation($id: String!) { commentDelete(id: $id) { success } }", {
                  id: comment.id,
                });
              }
            }}
            className="text-faint hover:text-ink"
          >
            Delete
          </button>
        </span>
      </div>
      {editing ? (
        <div className="mt-2">
          <AutoTextarea
            aria-label="Edit comment"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 outline-none focus:border-accent"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-2 py-1 text-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                await mutate(
                  "mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }",
                  {
                    id: comment.id,
                    body: text,
                  },
                );
                setEditing(false);
              }}
              className="rounded-md bg-accent px-3 py-1 text-white"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{comment.body}</p>
      )}
      <Reactions reactions={comment.reactions} target={{ commentId: comment.id }} />
    </div>
  );
}

const QUICK_EMOJI = ["👍", "👎", "❤️", "🎉", "😄", "👀", "🚀", "🙏"];

function Reactions({
  reactions,
  target,
}: {
  reactions: Reaction[];
  target: { issueId?: string; commentId?: string };
}) {
  const groups = new Map<string, Reaction[]>();
  for (const r of reactions) groups.set(r.emoji, [...(groups.get(r.emoji) ?? []), r]);
  const toggle = (emoji: string) => {
    const mine = groups.get(emoji)?.find((r) => r.user.isMe);
    if (mine)
      void mutate("mutation($id: String!) { reactionDelete(id: $id) { success } }", {
        id: mine.id,
      });
    else
      void mutate(
        "mutation($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }",
        {
          input: { emoji, ...target },
        },
      );
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {[...groups].map(([emoji, list]) => (
        <button
          key={emoji}
          type="button"
          title={list.map((r) => r.user.name).join(", ")}
          onClick={() => toggle(emoji)}
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] ${
            list.some((r) => r.user.isMe) ? "border-accent/60 bg-accent/10" : "border-line"
          }`}
        >
          {emoji} <span className="text-muted">{list.length}</span>
        </button>
      ))}
      <button
        type="button"
        aria-label="Add reaction"
        onClick={() =>
          openMenu({
            placeholder: "React with…",
            items: QUICK_EMOJI.map((emoji) => ({
              id: emoji,
              label: emoji,
              onSelect: () => toggle(emoji),
            })),
          })
        }
        className="rounded-full px-1.5 py-0.5 text-[12px] text-faint hover:bg-raised hover:text-ink"
      >
        ☺︎+
      </button>
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
      <AutoTextarea
        aria-label={parentId ? "Reply" : "Leave a comment"}
        autoFocus={autoFocus}
        value={body}
        placeholder={parentId ? "Leave a reply…" : "Leave a comment…"}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            e.currentTarget.blur();
            onDone?.();
          }
        }}
        className="min-h-6 w-full bg-transparent outline-none placeholder:text-faint"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="text-[12px] text-faint max-sm:hidden">
          <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
        </span>
        <button
          type="button"
          disabled={!body.trim() || busy}
          onClick={() => void submit()}
          className="rounded-md bg-accent px-3 py-1 text-white disabled:opacity-40"
        >
          {parentId ? "Reply" : "Comment"}
        </button>
      </div>
    </div>
  );
}
