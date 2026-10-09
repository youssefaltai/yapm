import { useState } from "react";
import { linkEntries } from "../actions.js";
import { type ContextEntry, contextMenu } from "../contextMenu.js";
import { mutate, toast, useQuery } from "../data.js";
import { plainText } from "../editor/plain.js";
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
  | "issueSlaBreached"
  | "mcpServerNeedsAuth";

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
    case "mcpServerNeedsAuth":
      return `Sign in so agents on ${String(n.data?.machine ?? "a machine")} can use it`;
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
  if (n.type === "mcpServerNeedsAuth") return `Connect ${String(n.data?.name ?? "an MCP server")}`;
  return "Notification";
}

/** Where a notification leads, if anywhere. */
function pathOf(n: Notification): string | null {
  if (n.request) return paths.request(n.request.id);
  if (n.issue) return paths.issue(n.issue.identifier);
  if (n.project) return paths.project(n.project.id);
  if (n.type === "mcpServerNeedsAuth") return paths.machines();
  return null;
}

const markRead = (n: Notification, read: boolean) =>
  mutate(
    "mutation($id: String!, $at: DateTime) { notificationUpdate(id: $id, input: { readAt: $at }) { success } }",
    { id: n.id, at: read ? new Date().toISOString() : null },
  );

async function archive(n: Notification) {
  if (
    !(await mutate("mutation($id: String!) { notificationArchive(id: $id) { success } }", {
      id: n.id,
    }))
  )
    return;
  toast("Archived notification", {
    label: "Undo",
    run: () =>
      void mutate("mutation($id: String!) { notificationUnarchive(id: $id) { success } }", {
        id: n.id,
      }),
  });
}

function notificationMenu(n: Notification, open: () => void): ContextEntry[] {
  const path = pathOf(n);
  return [
    { id: "open", label: "Open", onSelect: open },
    n.readAt
      ? { id: "unread", label: "Mark as unread", onSelect: () => markRead(n, false) }
      : { id: "read", label: "Mark as read", onSelect: () => markRead(n, true) },
    "divider",
    ...(path ? linkEntries(path) : []),
    "divider",
    { id: "archive", label: "Archive", onSelect: () => archive(n) },
  ];
}

export function InboxView() {
  const { data, error } = useQuery<{ notifications: { nodes: Notification[] } }>(INBOX_QUERY);
  const [selected, setSelected] = useState<string | null>(null);
  const items = data?.notifications.nodes ?? [];
  const current = items.find((n) => n.id === selected) ?? null;

  function open(n: Notification) {
    if (!n.readAt) void markRead(n, true);
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
          {error && <p className="p-6 text-red-400">{error}</p>}
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
            {items.map((n) => (
              <li key={n.id} className="group relative animate-fade-in">
                <button
                  type="button"
                  onClick={() => open(n)}
                  onContextMenu={contextMenu(() => notificationMenu(n, () => open(n)))}
                  className={`flex w-full gap-3 border-b border-line px-4 py-3 text-left hover:bg-raised md:px-6 ${
                    n.id === selected ? "bg-raised" : ""
                  }`}
                >
                  <span className="relative mt-0.5">
                    <Avatar name={n.actor?.name ?? "?"} kind={n.actor?.kind} size={20} />
                    {!n.readAt && (
                      <span
                        role="img"
                        aria-label="Unread"
                        className="absolute -top-0.5 -left-1 size-2 rounded-full bg-accent"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate ${n.readAt ? "text-muted" : "font-medium"}`}>
                        {heading(n)}
                      </span>
                      <span className="ml-auto shrink-0 text-[12px] text-faint">
                        {timeAgo(n.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-muted">
                      {n.issue && <span className="text-faint">{n.issue.identifier} · </span>}
                      {describe(n)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Archive"
                  title="Archive"
                  onClick={() => void archive(n)}
                  className="absolute right-4 bottom-2 hidden md:right-6 animate-fade-in rounded px-1.5 text-[12px] text-faint group-hover:block hover:bg-panel hover:text-ink"
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
