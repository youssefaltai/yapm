import { issueSubscriptions, NOTIFICATION_TYPES, notifications, users } from "@life-os/schema";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { findIssue } from "../services/issues.js";
import {
  archiveNotification,
  inInbox,
  markAllRead,
  setSubscribed,
  updateNotification,
} from "../services/notifications.js";
import {
  act,
  builder,
  connection,
  db,
  notFoundError,
  now,
  pageArgs,
  paginate,
  requireViewer,
} from "./builder.js";
import { IssuePayload } from "./mutations.js";
import { Request } from "./requests.js";
import { Comment, Issue, User, UserConnection } from "./types.js";

type NotificationRow = typeof notifications.$inferSelect;

const NotificationType = builder.enumType("NotificationType", { values: NOTIFICATION_TYPES });
export const Notification = builder.objectRef<NotificationRow>("Notification");
const NotificationConnection = connection<NotificationRow>("Notification", Notification);

Notification.implement({
  description: "An entry in a member's Inbox.",
  fields: (t) => ({
    id: t.exposeID("id"),
    type: t.field({ type: NotificationType, resolve: (n) => n.type }),
    data: t.field({ type: "JSONObject", nullable: true, resolve: (n) => n.data ?? null }),
    readAt: t.field({ type: "DateTime", nullable: true, resolve: (n) => n.readAt }),
    snoozedUntilAt: t.field({ type: "DateTime", nullable: true, resolve: (n) => n.snoozedUntilAt }),
    archivedAt: t.field({ type: "DateTime", nullable: true, resolve: (n) => n.archivedAt }),
    createdAt: t.field({ type: "DateTime", resolve: (n) => n.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (n) => n.updatedAt }),
    actor: t.field({
      type: User,
      nullable: true,
      resolve: (n, _args, ctx) => (n.actorId ? ctx.loaders.user.load(n.actorId) : null),
    }),
    issue: t.field({
      type: Issue,
      nullable: true,
      resolve: (n, _args, ctx) => (n.issueId ? ctx.loaders.issue.load(n.issueId) : null),
    }),
    comment: t.field({
      type: Comment,
      nullable: true,
      resolve: (n, _args, ctx) => (n.commentId ? ctx.loaders.comment.load(n.commentId) : null),
    }),
    request: t.field({
      type: Request,
      nullable: true,
      resolve: (n, _args, ctx) => (n.requestId ? ctx.loaders.request.load(n.requestId) : null),
    }),
  }),
});

builder.queryFields((t) => ({
  notifications: t.field({
    type: NotificationConnection,
    description:
      "The viewer's Inbox, newest first. Snoozed and archived ones are left out unless asked for.",
    args: { ...pageArgs, includeArchived: t.arg.boolean({ required: false }) },
    resolve: async (_root, args, ctx) => {
      const viewer = requireViewer(ctx);
      const rows = await db(ctx)
        .select()
        .from(notifications)
        .where(
          args.includeArchived
            ? eq(notifications.userId, viewer.user.id)
            : inInbox(viewer.user.id, now(ctx)),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(250)
        .all();
      return paginate(rows, args);
    },
  }),
  notificationsUnreadCount: t.int({
    description: "Unread notifications in the viewer's Inbox.",
    resolve: async (_root, _args, ctx) => {
      const viewer = requireViewer(ctx);
      const row = await db(ctx)
        .select({ n: count() })
        .from(notifications)
        .where(and(inInbox(viewer.user.id, now(ctx)), isNull(notifications.readAt)))
        .get();
      return row?.n ?? 0;
    },
  }),
}));

builder.objectFields(Issue, (t) => ({
  subscribers: t.field({
    type: UserConnection,
    description: "Members following this issue: they hear about its comments and status changes.",
    args: pageArgs,
    resolve: async (issue, args, ctx) => {
      const rows = await db(ctx)
        .select({ user: users })
        .from(issueSubscriptions)
        .innerJoin(users, eq(users.id, issueSubscriptions.userId))
        .where(eq(issueSubscriptions.issueId, issue.id))
        .orderBy(asc(issueSubscriptions.createdAt))
        .all();
      return paginate(
        rows.map((r) => r.user),
        args,
      );
    },
  }),
}));

const NotificationPayload = builder.objectRef<{ id: string }>("NotificationPayload").implement({
  fields: (t) => ({
    success: t.boolean({ resolve: () => true }),
    notification: t.field({
      type: Notification,
      resolve: async (p, _args, ctx) => {
        const row = await db(ctx)
          .select()
          .from(notifications)
          .where(eq(notifications.id, p.id))
          .get();
        if (!row) throw notFoundError("Notification");
        return row;
      },
    }),
  }),
});

const NotificationUpdateInput = builder.inputType("NotificationUpdateInput", {
  fields: (t) => ({
    readAt: t.field({ type: "DateTime", required: false, description: "Null marks it unread." }),
    snoozedUntilAt: t.field({
      type: "DateTime",
      required: false,
      description: "Hide it until then; null brings it back now.",
    }),
  }),
});

const SuccessPayload = builder.objectRef<object>("SuccessPayload").implement({
  fields: (t) => ({ success: t.boolean({ resolve: () => true }) }),
});

async function issueFor(ctx: Parameters<typeof db>[0], id: string) {
  const issue = await findIssue(db(ctx), id);
  if (!issue) throw notFoundError("Issue");
  return issue;
}

builder.mutationFields((t) => ({
  notificationUpdate: t.field({
    type: NotificationPayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: NotificationUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const input: { readAt?: number | null; snoozedUntilAt?: number | null } = {};
      // An omitted field stays as it is; an explicit null clears it.
      if (args.input.readAt !== undefined) input.readAt = args.input.readAt?.getTime() ?? null;
      if (args.input.snoozedUntilAt !== undefined)
        input.snoozedUntilAt = args.input.snoozedUntilAt?.getTime() ?? null;
      return { id: await act(ctx, (s) => updateNotification(s, args.id, input)) };
    },
  }),
  notificationArchive: t.field({
    type: NotificationPayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => archiveNotification(s, args.id)),
    }),
  }),
  notificationUnarchive: t.field({
    type: NotificationPayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => archiveNotification(s, args.id, false)),
    }),
  }),
  notificationMarkReadAll: t.field({
    type: SuccessPayload,
    description: "Marks the viewer's Inbox read, or only one issue's notifications.",
    args: { issueId: t.arg.string({ required: false }) },
    resolve: async (_root, args, ctx) => {
      const issueId = args.issueId ? (await issueFor(ctx, args.issueId)).id : null;
      await act(ctx, (s) => markAllRead(s, issueId));
      return {};
    },
  }),
  issueSubscribe: t.field({
    type: IssuePayload,
    description: "Follows an issue: yourself, or (owner only) another member.",
    args: { id: t.arg.string({ required: true }), userId: t.arg.string({ required: false }) },
    resolve: async (_root, args, ctx) => {
      const issue = await issueFor(ctx, args.id);
      const userId = args.userId ?? requireViewer(ctx).user.id;
      await act(ctx, (s) => setSubscribed(s, issue.id, userId, true));
      return { entity: issue };
    },
  }),
  issueUnsubscribe: t.field({
    type: IssuePayload,
    args: { id: t.arg.string({ required: true }), userId: t.arg.string({ required: false }) },
    resolve: async (_root, args, ctx) => {
      const issue = await issueFor(ctx, args.id);
      const userId = args.userId ?? requireViewer(ctx).user.id;
      await act(ctx, (s) => setSubscribed(s, issue.id, userId, false));
      return { entity: issue };
    },
  }),
}));
