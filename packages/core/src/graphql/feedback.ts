import {
  feedback,
  REVISION_SUBJECTS,
  type RevisionSubject,
  type revisions,
  workspaces,
} from "@life-os/schema";
import { eq } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import {
  addressFeedback,
  createFeedback,
  listFeedback,
  listRevisions,
} from "../services/feedback.js";
import { act, builder, db, notFoundError, requireViewer } from "./builder.js";
import { payload } from "./mutations.js";
import { Issue, User } from "./types.js";

type FeedbackRow = typeof feedback.$inferSelect;
type RevisionRow = typeof revisions.$inferSelect;

export const Feedback = builder.objectRef<FeedbackRow>("Feedback");
export const Revision = builder.objectRef<RevisionRow>("Revision");

Feedback.implement({
  description:
    "Something an agent should learn from: why a run was stopped, why a request was rejected, or a note.",
  fields: (t) => ({
    id: t.exposeID("id"),
    kind: t.exposeString("kind", { description: "stop, rejection or note." }),
    body: t.exposeString("body"),
    agent: t.field({
      type: User,
      nullable: true,
      resolve: (f, _a, ctx) => ctx.loaders.user.load(f.agentId),
    }),
    author: t.field({
      type: User,
      nullable: true,
      resolve: (f, _a, ctx) => (f.authorId ? ctx.loaders.user.load(f.authorId) : null),
    }),
    issue: t.field({
      type: Issue,
      nullable: true,
      resolve: (f, _a, ctx) => (f.issueId ? ctx.loaders.issue.load(f.issueId) : null),
    }),
    runId: t.exposeString("runId", { nullable: true }),
    requestId: t.exposeString("requestId", { nullable: true }),
    addressedAt: t.field({ type: "DateTime", nullable: true, resolve: (f) => f.addressedAt }),
    addressedBy: t.field({
      type: User,
      nullable: true,
      resolve: (f, _a, ctx) => (f.addressedById ? ctx.loaders.user.load(f.addressedById) : null),
    }),
    addressedNote: t.exposeString("addressedNote", { nullable: true }),
    createdAt: t.field({ type: "DateTime", resolve: (f) => f.createdAt }),
  }),
});

Revision.implement({
  description: "A past version of a charter, an agent's lessons or the handbook.",
  fields: (t) => ({
    id: t.exposeID("id"),
    subject: t.exposeString("subject"),
    content: t.exposeString("content"),
    author: t.field({
      type: User,
      nullable: true,
      resolve: (r, _a, ctx) => (r.authorId ? ctx.loaders.user.load(r.authorId) : null),
    }),
    reason: t.exposeString("reason", { nullable: true }),
    runId: t.exposeString("runId", { nullable: true }),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
  }),
});

builder.queryFields((t) => ({
  feedbacks: t.field({
    type: [Feedback],
    description: "Feedback for agents, newest first.",
    args: {
      agentId: t.arg.string({ required: false }),
      open: t.arg.boolean({ required: false, description: "Only feedback not yet addressed." }),
      first: t.arg.int({ required: false }),
    },
    resolve: (_root, args, ctx) => {
      requireViewer(ctx);
      return listFeedback(db(ctx), args, args.first ?? 50);
    },
  }),
  revisions: t.field({
    type: [Revision],
    description: "Versions of a charter or lessons (entityId: the agent) or the handbook.",
    args: {
      subject: t.arg.string({ required: true }),
      entityId: t.arg.string({ required: false }),
      first: t.arg.int({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const subject = args.subject as RevisionSubject;
      if (!REVISION_SUBJECTS.includes(subject))
        throw createGraphQLError(`Subject is one of ${REVISION_SUBJECTS.join(", ")}`, {
          extensions: { code: "BAD_REQUEST" },
        });
      const entityId =
        subject === "handbook"
          ? ((await db(ctx).select().from(workspaces).get())?.id ?? "")
          : args.entityId;
      if (!entityId)
        throw createGraphQLError("Say whose charter or lessons", {
          extensions: { code: "BAD_REQUEST" },
        });
      return listRevisions(db(ctx), subject, entityId, args.first ?? 20);
    },
  }),
}));

const FeedbackPayload = payload("FeedbackPayload", "feedback", Feedback);

async function requireFeedback(ctx: Parameters<typeof db>[0], id: string) {
  const row = await db(ctx).select().from(feedback).where(eq(feedback.id, id)).get();
  if (!row) throw notFoundError("Feedback");
  return row;
}

const FeedbackCreateInput = builder.inputType("FeedbackCreateInput", {
  fields: (t) => ({
    agentId: t.string({ required: true }),
    body: t.string({ required: true }),
    issueId: t.string({ required: false }),
  }),
});

builder.mutationFields((t) => ({
  feedbackCreate: t.field({
    type: FeedbackPayload,
    description: "Leaves an agent a note to learn from. The owner and its manager can.",
    args: { input: t.arg({ type: FeedbackCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => ({
      entity: await requireFeedback(ctx, await act(ctx, (s) => createFeedback(s, args.input))),
    }),
  }),
  feedbackAddress: t.field({
    type: FeedbackPayload,
    description: "Marks feedback as acted on, saying what changed.",
    args: { id: t.arg.string({ required: true }), note: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({
      entity: await requireFeedback(
        ctx,
        await act(ctx, (s) => addressFeedback(s, args.id, args.note)),
      ),
    }),
  }),
}));
