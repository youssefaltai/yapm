import { pushSubscriptions } from "@yapm/schema";
import { and, desc, eq } from "drizzle-orm";
import { sendPush, vapidKeys } from "../push.js";
import { createPushSubscription, deletePushSubscription } from "../services/pushSubscriptions.js";
import { act, builder, db, now, requireViewer } from "./builder.js";

type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

const PushSubscription = builder.objectRef<PushSubscriptionRow>("PushSubscription").implement({
  description: "A browser or phone that receives the member's notifications as Web Push.",
  fields: (t) => ({
    id: t.exposeID("id"),
    userAgent: t.exposeString("userAgent", { nullable: true }),
    createdAt: t.field({ type: "DateTime", resolve: (p) => p.createdAt }),
    lastUsedAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.lastUsedAt }),
  }),
});

builder.queryFields((t) => ({
  pushVapidPublicKey: t.string({
    description: "The hub's Web Push key: pass it as applicationServerKey when subscribing.",
    resolve: async (_root, _args, ctx) => {
      requireViewer(ctx);
      return (await vapidKeys(db(ctx), now(ctx))).publicKey;
    },
  }),
  pushSubscriptions: t.field({
    type: [PushSubscription],
    description: "The viewer's devices that receive push notifications.",
    resolve: (_root, _args, ctx) =>
      db(ctx)
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, requireViewer(ctx).user.id))
        .orderBy(desc(pushSubscriptions.createdAt))
        .all(),
  }),
}));

const PushSubscriptionPayload = builder
  .objectRef<{ id: string }>("PushSubscriptionPayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      pushSubscription: t.field({
        type: PushSubscription,
        nullable: true,
        resolve: async (p, _args, ctx) =>
          (await db(ctx)
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.id, p.id))
            .get()) ?? null,
      }),
    }),
  });

const PushSubscriptionCreateInput = builder.inputType("PushSubscriptionCreateInput", {
  fields: (t) => ({
    data: t.string({ required: true, description: "JSON.stringify(pushSubscription)" }),
    userAgent: t.string({ required: false }),
  }),
});

builder.mutationFields((t) => ({
  pushSubscriptionCreate: t.field({
    type: PushSubscriptionPayload,
    args: { input: t.arg({ type: PushSubscriptionCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) =>
        createPushSubscription(s, args.input.data, args.input.userAgent ?? null),
      ),
    }),
  }),
  pushSubscriptionDelete: t.field({
    type: PushSubscriptionPayload,
    description: "Stops push to a device, by id or by its push endpoint.",
    args: {
      id: t.arg.string({ required: false }),
      endpoint: t.arg.string({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      const viewer = requireViewer(ctx);
      const row = await db(ctx)
        .select()
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.userId, viewer.user.id),
            args.id
              ? eq(pushSubscriptions.id, args.id)
              : eq(pushSubscriptions.endpoint, args.endpoint ?? ""),
          ),
        )
        .get();
      if (row) await act(ctx, (s) => deletePushSubscription(s, row.id));
      return { id: row?.id ?? "" };
    },
  }),
  pushSubscriptionTest: t.field({
    type: "Int",
    description: "Sends a test notification to the viewer's devices; returns how many accepted it.",
    resolve: async (_root, _args, ctx) => {
      const viewer = requireViewer(ctx);
      return sendPush(ctx.deps, viewer.user.id, ctx.origin ?? "", {
        title: "yapm",
        body: "Notifications are on. Requests for your approval will show up like this.",
        url: "/inbox",
        tag: "test",
      });
    },
  }),
}));
