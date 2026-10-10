import { useState } from "react";
import { issueCopyable, linkEntries } from "../actions.js";
import { type ContextEntry, contextMenu } from "../contextMenu.js";
import { mutate, mutateEach, toast, useQuery } from "../data.js";
import { plainText } from "../editor/plain.js";
import { icon } from "../icons.js";
import { button, PageHeader, PageTitle } from "../layout.js";
import { usePushState } from "../push.js";
import { navigate, paths } from "../router.js";
import { EmptyState, ListSkeleton } from "../states.js";
import { Avatar, timeAgo } from "../ui.js";
import { IssuePage } from "./IssuePage.js";
import { ProjectPage } from "./Projects.js";
import { RequestPage } from "./Requests.js";

type NotificationType =
  | "issueAssignedToYou"
  | "issueUnassignedFromYou"
  | "issueMention"
  | "issueCommentMention"
  | "issueNewComment"
  | "issueStatusChanged"
  | "requestCreated"
  | "requestAnswered"
  | "projectUpdateCreated"
  | "issueSlaBreached";

interface Notification {
  id: string;
  type: NotificationType;
  readAt: string | null;
  createdAt: string;
  data: Record<string, unknown> | null;
  actor: { id: string; name: string; kind: "owner" | "agent" } | null;
  issue: { identifier: string; title: string } | null;
  comment: { body: string } | null;
  request: { id: string; title: string; status: string } | null;
  project: { id: string; name: string } | null;
  projectUpdate: { body: string; health: string } | null;
}

const INBOX_QUERY = `{ notifications(first: 100) { nodes {
  id type readAt createdAt data
  actor { id name kind }
  issue { identifier title }
  comment { body }
  request { id title status }
  project { id name }
  projectUpdate { body health }
} } }`;

/** Unread notifications, for the sidebar. */
export function useUnreadCount(): number {
  const { data } = useQuery<{ notificationsUnreadCount: number }>("{ notificationsUnreadCount }");
  return data?.notificationsUnreadCount ?? 0;
}

function describe(n: Notification): string {
  const who = n.actor?.name ?? "Someone";
  switch (n.type) {
    case "issueAssignedToYou":
      return n.actor ? `${who} assigned it to you` : "Assigned to you";
    case "issueUnassignedFromYou":
      return `${who} unassigned you`;
    case "issueMention":
      return `${who} mentioned you`;
    case "issueCommentMention":
      return `${who} mentioned you: ${snippet(n.comment?.body)}`;
    case "issueNewComment":
      return `${who} commented: ${snippet(n.comment?.body)}`;
    case "issueStatusChanged":
      return `${who} moved it to ${String(n.data?.to ?? "a new status")}`;
    case "requestCreated":
      return `${who} asks for your approval`;
    case "requestAnswered":
      return n.data?.status === "rejected"
        ? `${who} rejected your request: ${String(n.data?.reason ?? "")}`
        : `${who} approved your request${n.data?.always ? " for good" : ""}`;
    case "projectUpdateCreated":
      return `${who} posted an update: ${snippet(n.projectUpdate?.body)}`;
    case "issueSlaBreached":
      return "Missed its SLA";
  }
}

function snippet(body: string | undefined) {
  const text = plainText(body);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function heading(n: Notification) {
  if (n.request) return n.request.title;
  if (n.issue) return n.issue.title;
  if (n.project) return n.project.name;
  return "Notification";
}

/** Where a notification leads, if anywhere. */
function pathOf(n: Notification): string | null {
  if (n.request) return paths.request(n.request.id);
  if (n.issue) return paths.issue(n.issue.identifier);
  if (n.project) return paths.project(n.project.id);
  return null;
}

/** One row per issue, request or project, like Linear: its latest notification stands for all. */
interface Group {
  latest: Notification;
  all: Notification[];
  read: boolean;
}

function grouped(items: Notification[]): Group[] {
  const groups = new Map<string, Group>();
  for (const n of items) {
    const key = pathOf(n) ?? n.id;
    const group = groups.get(key);
    if (group) group.all.push(n);
    else groups.set(key, { latest: n, all: [n], read: true });
  }
  for (const group of groups.values()) group.read = group.all.every((n) => n.readAt !== null);
  return [...groups.values()];
}

const markRead = (g: Group, read: boolean) =>
  mutateEach(
    g.all.filter((n) => !n.readAt === read).map((n) => n.id),
    "notificationUpdate",
    ", input: { readAt: $at }",
    { at: ["DateTime", read ? new Date().toISOString() : null] },
  );

const archiveAll = (g: Group, op: "notificationArchive" | "notificationUnarchive") =>
  mutateEach(
    g.all.map((n) => n.id),
    op,
  );

async function archive(g: Group) {
  if (!(await archiveAll(g, "notificationArchive"))) return;
  toast("Archived notification", {
    label: "Undo",
    run: () => void archiveAll(g, "notificationUnarchive"),
  });
}

function notificationMenu(g: Group, open: () => void): ContextEntry[] {
  const n = g.latest;
  const path = pathOf(n);
  return [
    { id: "open", icon: icon("open"), label: "Open", onSelect: open },
    g.read
      ? {
          id: "unread",
          icon: icon("unread"),
          label: "Mark as unread",
          onSelect: () => markRead(g, false),
        }
      : {
          id: "read",
          icon: icon("read"),
          label: "Mark as read",
          onSelect: () => markRead(g, true),
        },
    "divider",
    ...(path
      ? linkEntries(
          n.request ? { path } : n.issue ? issueCopyable(n.issue) : { path, name: n.project?.name },
        )
      : []),
    "divider",
    { id: "archive", icon: icon("archive"), label: "Archive", onSelect: () => archive(g) },
  ];
}

export function InboxView() {
  const { data, error } = useQuery<{ notifications: { nodes: Notification[] } }>(INBOX_QUERY);
  const [selected, setSelected] = useState<string | null>(null);
  const items = data?.notifications.nodes ?? [];
  const groups = grouped(items);
  const current = groups.find((g) => g.all.some((n) => n.id === selected))?.latest ?? null;

  function open(g: Group) {
    const n = g.latest;
    if (!g.read) void markRead(g, true);
    if (window.matchMedia("(min-width: 768px)").matches && (n.request || n.issue)) {
      setSelected(n.id);
      return;
    }
    const path = pathOf(n);
    if (path) navigate(path);
  }

  return (
    <div className="flex h-full">
      <section className="flex w-full min-w-0 flex-col border-line md:w-96 md:shrink-0 md:border-r">
        <PageHeader
          actions={
            items.some((n) => !n.readAt) && (
              <button
                type="button"
                onClick={() => void mutate("mutation { notificationMarkReadAll { success } }")}
                className={button("ghost", "sm")}
              >
                Mark all read
              </button>
            )
          }
        >
          <PageTitle>Inbox</PageTitle>
        </PageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PushBanner />
          {error && <p className="p-6 text-critical">{error}</p>}
          {!data && !error && <ListSkeleton rows={6} />}
          {data && items.length === 0 && (
            <EmptyState
              fill={false}
              icon="inbox"
              title="You're all caught up."
              description="Assignments, mentions, comments on issues you follow and agents' requests land here."
            />
          )}
          <ul aria-label="Notifications">
            {groups.map((g) => (
              <li key={pathOf(g.latest) ?? g.latest.id} className="group relative animate-fade-in">
                <button
                  type="button"
                  onClick={() => open(g)}
                  onContextMenu={contextMenu(() => notificationMenu(g, () => open(g)))}
                  className={`flex w-full gap-3 border-b border-line px-4 py-3 text-left hover:bg-raised md:px-6 ${
                    g.latest === current ? "bg-raised" : ""
                  }`}
                >
                  <span className="relative mt-0.5">
                    <Avatar
                      name={g.latest.actor?.name ?? "?"}
                      kind={g.latest.actor?.kind}
                      size={20}
                    />
                    {!g.read && (
                      <span
                        role="img"
                        aria-label="Unread"
                        className="absolute -top-0.5 -left-1 size-2 rounded-full bg-accent"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate ${g.read ? "text-muted" : "font-medium"}`}>
                        {heading(g.latest)}
                      </span>
                      <span className="ml-auto shrink-0 text-[12px] text-faint">
                        {timeAgo(g.latest.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-muted">
                      {g.latest.issue && (
                        <span className="text-faint">{g.latest.issue.identifier} · </span>
                      )}
                      {describe(g.latest)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Archive"
                  title="Archive"
                  onClick={() => void archive(g)}
                  className="absolute right-4 bottom-2 hidden md:right-6 animate-fade-in rounded bg-raised px-1.5 text-[12px] text-faint group-hover:block hover:bg-panel hover:text-ink"
                >
                  Archive
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section
        key={current?.id ?? "none"}
        className="hidden min-w-0 flex-1 animate-fade-in md:block"
      >
        {current?.project && !current.issue && !current.request ? (
          <ProjectPage key={current.project.id} id={current.project.id} tab="overview" />
        ) : current?.request ? (
          <RequestPage key={current.request.id} id={current.request.id} />
        ) : current?.issue ? (
          <IssuePage key={current.issue.identifier} identifier={current.issue.identifier} />
        ) : (
          items.length > 0 && (
            <EmptyState
              icon="select"
              title="Select a notification"
              description="Its issue or request opens here, so you can answer without leaving the Inbox."
            />
          )
        )}
      </section>
    </div>
  );
}

/** Offers push notifications, or explains how to get them on an iPhone. */
function PushBanner() {
  const [state, turnOn] = usePushState();
  if (state === "install-first")
    return (
      <p className="m-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-[13px] text-muted">
        To get notifications on your iPhone, tap Share, then <b>Add to Home Screen</b>, and open
        Life OS from there.
      </p>
    );
  if (state !== "off") return null;
  return (
    <div className="m-3 flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5">
      <p className="flex-1 text-[13px] text-muted">
        Get a notification when an agent needs your approval.
      </p>
      <button type="button" onClick={() => void turnOn()} className={button("primary", "sm")}>
        Turn on
      </button>
    </div>
  );
}
