import type { ObjectRef } from "@pothos/core";
import { comments, issueRelations, issues, reactions, teams } from "@yapm/schema";
import { eq, inArray } from "drizzle-orm";
import { createApiToken } from "../auth.js";
import {
  createComment,
  createReaction,
  deleteComment,
  deleteReaction,
  updateComment,
} from "../services/comments.js";
import {
  createIssue,
  createRelation,
  deleteRelation,
  setIssueArchived,
  updateIssue,
  updateIssues,
} from "../services/issues.js";
import { createLabel, deleteLabel, updateLabel } from "../services/labels.js";
import { archiveState, createState, updateState } from "../services/states.js";
import { createTeam, setTeamMembership, updateTeam } from "../services/teams.js";
import { hireAgent, retireAgent, revokeApiToken, updateUser } from "../services/users.js";
import { act, builder, db, notFoundError, requireOwner, type Types } from "./builder.js";
import {
  Comment,
  Issue,
  IssueLabel,
  IssueRelation,
  IssueRelationType,
  Reaction,
  Team,
  User,
  type UserRow,
  WorkflowState,
  WorkflowStateType,
} from "./types.js";

/** Linear's mutation payloads: `{ success, <entity> }`. */
export function payload<T>(name: string, field: string, type: ObjectRef<Types, T>) {
  return builder.objectRef<{ entity: T }>(name).implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      // Pothos can't resolve its result type for a generic T; the ref above pins it.
      [field]: t.field({ type, resolve: (p) => p.entity as never }),
    }),
  });
}

const TeamPayload = payload("TeamPayload", "team", Team);
export const IssuePayload = payload("IssuePayload", "issue", Issue);
const IssueLabelPayload = payload("IssueLabelPayload", "issueLabel", IssueLabel);
const WorkflowStatePayload = payload("WorkflowStatePayload", "workflowState", WorkflowState);
const CommentPayload = payload("CommentPayload", "comment", Comment);
const ReactionPayload = payload("ReactionPayload", "reaction", Reaction);
const IssueRelationPayload = payload("IssueRelationPayload", "issueRelation", IssueRelation);
const UserPayload = payload("UserPayload", "user", User);

const IssueBatchPayload = builder
  .objectRef<{ issues: (typeof issues.$inferSelect)[] }>("IssueBatchPayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      issues: t.field({ type: [Issue], resolve: (p) => p.issues }),
    }),
  });

const IssueArchivePayload = builder
  .objectRef<{ entity: typeof issues.$inferSelect }>("IssueArchivePayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      entity: t.field({ type: Issue, resolve: (p) => p.entity }),
    }),
  });

export const DeletePayload = builder.objectRef<{ entityId: string }>("DeletePayload").implement({
  fields: (t) => ({
    success: t.boolean({ resolve: () => true }),
    entityId: t.exposeString("entityId"),
  }),
});

const ApiTokenPayload = builder
  .objectRef<{ id: string; token: string; user: UserRow }>("ApiTokenPayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      id: t.exposeID("id"),
      token: t.exposeString("token", { description: "Shown once. Store it securely." }),
      user: t.field({ type: User, resolve: (p) => p.user }),
    }),
  });

const TeamCreateInput = builder.inputType("TeamCreateInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    key: t.string({ required: false, description: "Defaults to the name's initials." }),
    description: t.string({ required: false }),
    icon: t.string({ required: false }),
    color: t.string({ required: false }),
    leadId: t.string({ required: false }),
  }),
});

const TeamMembershipCreateInput = builder.inputType("TeamMembershipCreateInput", {
  fields: (t) => ({
    teamId: t.string({ required: true }),
    userId: t.string({ required: true }),
  }),
});

const TeamUpdateInput = builder.inputType("TeamUpdateInput", {
  fields: (t) => ({
    name: t.string({ required: false }),
    key: t.string({ required: false }),
    description: t.string({ required: false }),
    icon: t.string({ required: false }),
    color: t.string({ required: false }),
    leadId: t.string({ required: false }),
    triageEnabled: t.boolean({
      required: false,
      description: "New issues from agents wait in Triage for the owner.",
    }),
    cyclesEnabled: t.boolean({ required: false }),
    cycleDuration: t.int({ required: false, description: "Weeks per cycle, 1–8." }),
    cycleStartDay: t.int({ required: false, description: "0 Sunday … 6 Saturday." }),
    cycleCooldown: t.int({ required: false, description: "Weeks between cycles, 0–4." }),
    upcomingCycleCount: t.int({ required: false, description: "Future cycles to keep, 1–10." }),
    slaHours: t.field({
      type: "JSONObject",
      required: false,
      description:
        'Hours to finish an issue by priority, e.g. { "1": 24, "2": 72 }; null turns SLAs off.',
    }),
    autoArchivePeriod: t.int({ required: false, description: "Months, 0–24; 0 never." }),
  }),
});

const IssueCreateInput = builder.inputType("IssueCreateInput", {
  fields: (t) => ({
    teamId: t.string({ required: true }),
    title: t.string({ required: true }),
    description: t.string({ required: false, description: "Markdown." }),
    stateId: t.string({ required: false, description: "Defaults to the team's Backlog." }),
    priority: t.int({ required: false }),
    estimate: t.int({ required: false }),
    assigneeId: t.string({ required: false }),
    parentId: t.string({ required: false }),
    dueDate: t.field({ type: "TimelessDate", required: false }),
    labelIds: t.stringList({ required: false }),
    sortOrder: t.float({ required: false }),
    projectId: t.string({ required: false }),
    projectMilestoneId: t.string({ required: false }),
    cycleId: t.string({ required: false }),
  }),
});

const IssueUpdateInput = builder.inputType("IssueUpdateInput", {
  fields: (t) => ({
    title: t.string({ required: false }),
    description: t.string({ required: false }),
    stateId: t.string({ required: false }),
    priority: t.int({ required: false }),
    estimate: t.int({ required: false }),
    assigneeId: t.string({ required: false }),
    parentId: t.string({ required: false }),
    dueDate: t.field({ type: "TimelessDate", required: false }),
    sortOrder: t.float({ required: false }),
    labelIds: t.stringList({ required: false, description: "Replaces all labels." }),
    addedLabelIds: t.stringList({ required: false }),
    removedLabelIds: t.stringList({ required: false }),
    projectId: t.string({
      required: false,
      description: "Null removes the issue from its project.",
    }),
    projectMilestoneId: t.string({ required: false, description: "Also sets the project." }),
    cycleId: t.string({ required: false }),
  }),
});

const IssueLabelCreateInput = builder.inputType("IssueLabelCreateInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    color: t.string({ required: false }),
    description: t.string({ required: false }),
    teamId: t.string({ required: false, description: "Leave out for a workspace-wide label." }),
  }),
});

const IssueLabelUpdateInput = builder.inputType("IssueLabelUpdateInput", {
  fields: (t) => ({
    name: t.string({ required: false }),
    color: t.string({ required: false }),
    description: t.string({ required: false }),
  }),
});

const WorkflowStateCreateInput = builder.inputType("WorkflowStateCreateInput", {
  fields: (t) => ({
    teamId: t.string({ required: true }),
    name: t.string({ required: true }),
    type: t.field({ type: WorkflowStateType, required: true }),
    color: t.string({ required: false }),
    description: t.string({ required: false }),
    position: t.int({
      required: false,
      description: "Place in the team's list, from 0. Defaults to after the others of its type.",
    }),
  }),
});

const WorkflowStateUpdateInput = builder.inputType("WorkflowStateUpdateInput", {
  fields: (t) => ({
    name: t.string({ required: false }),
    color: t.string({ required: false }),
    description: t.string({ required: false }),
    position: t.int({ required: false, description: "Place in the team's list, from 0." }),
  }),
});

const CommentCreateInput = builder.inputType("CommentCreateInput", {
  fields: (t) => ({
    issueId: t.string({ required: true }),
    body: t.string({ required: true, description: "Markdown." }),
    parentId: t.string({ required: false, description: "The comment this replies to." }),
  }),
});

const CommentUpdateInput = builder.inputType("CommentUpdateInput", {
  fields: (t) => ({ body: t.string({ required: true }) }),
});

const ReactionCreateInput = builder.inputType("ReactionCreateInput", {
  fields: (t) => ({
    emoji: t.string({ required: true }),
    commentId: t.string({ required: false }),
    issueId: t.string({ required: false }),
  }),
});

const IssueRelationCreateInput = builder.inputType("IssueRelationCreateInput", {
  fields: (t) => ({
    issueId: t.string({ required: true }),
    relatedIssueId: t.string({ required: true }),
    type: t.field({ type: IssueRelationType, required: true }),
  }),
});

const AgentHireInput = builder.inputType("AgentHireInput", {
  fields: (t) => ({
    name: t.string({
      required: true,
      description: "How others address the agent, e.g. Finance Lead.",
    }),
    title: t.string({ required: false }),
    charter: t.string({
      required: false,
      description: "The job: responsibilities, ownership, when to escalate.",
    }),
    managerId: t.string({ required: false, description: "Defaults to the owner." }),
  }),
});

const UserUpdateInput = builder.inputType("UserUpdateInput", {
  fields: (t) => ({
    name: t.string({ required: false }),
    title: t.string({ required: false }),
    charter: t.string({ required: false }),
    lessons: t.string({ required: false }),
    managerId: t.string({ required: false }),
    runnerTags: t.stringList({
      required: false,
      description: "Owner only: machines need all these tags to run this agent.",
    }),
    models: t.field({
      type: "JSONObject",
      required: false,
      description:
        "An agent's own `{ provider, model, effort }` per tier (small, standard, top), from `Organization.aiProviders`; tiers left out keep theirs. Null goes back to the company's. Needs agent.models.",
    }),
    topRunsPerWeek: t.int({
      required: false,
      description: "Owner only: top-tier work runs allowed in any 7 days; more drop to standard.",
    }),
  }),
});

async function loadUser(ctx: Parameters<typeof db>[0], id: string) {
  ctx.loaders.user.clear(id);
  const row = await ctx.loaders.user.load(id);
  if (!row) throw notFoundError("User");
  return row;
}

async function loadIssue(ctx: Parameters<typeof db>[0], id: string) {
  const row = await db(ctx).select().from(issues).where(eq(issues.id, id)).get();
  if (!row) throw notFoundError("Issue");
  return row;
}

builder.mutationType({
  fields: (t) => ({
    teamCreate: t.field({
      type: TeamPayload,
      description:
        "Creates a team with the default workflow, from Triage and Backlog through Done and Canceled.",
      args: { input: t.arg({ type: TeamCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => createTeam(s, args.input));
        const team = await db(ctx).select().from(teams).where(eq(teams.id, id)).get();
        if (!team) throw notFoundError("Team");
        return { entity: team };
      },
    }),
    teamUpdate: t.field({
      type: TeamPayload,
      args: {
        id: t.arg.string({ required: true }),
        input: t.arg({ type: TeamUpdateInput, required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => updateTeam(s, args.id, args.input));
        const team = await db(ctx).select().from(teams).where(eq(teams.id, id)).get();
        if (!team) throw notFoundError("Team");
        return { entity: team };
      },
    }),
    teamMembershipCreate: t.field({
      type: TeamPayload,
      description: "Adds a member to a team. Owner only.",
      args: { input: t.arg({ type: TeamMembershipCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const { teamId, userId } = args.input;
        const id = await act(ctx, (s) => setTeamMembership(s, teamId, userId));
        const team = await db(ctx).select().from(teams).where(eq(teams.id, id)).get();
        if (!team) throw notFoundError("Team");
        return { entity: team };
      },
    }),
    teamMembershipDelete: t.field({
      type: TeamPayload,
      description: "Takes a member off a team. Owner only.",
      args: {
        teamId: t.arg.string({ required: true }),
        userId: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => setTeamMembership(s, args.teamId, args.userId, true));
        const team = await db(ctx).select().from(teams).where(eq(teams.id, id)).get();
        if (!team) throw notFoundError("Team");
        return { entity: team };
      },
    }),

    issueCreate: t.field({
      type: IssuePayload,
      args: { input: t.arg({ type: IssueCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => createIssue(s, args.input));
        return { entity: await loadIssue(ctx, id) };
      },
    }),
    issueUpdate: t.field({
      type: IssuePayload,
      description: "Updates an issue by id or identifier (e.g. `FIN-42`).",
      args: {
        id: t.arg.string({ required: true }),
        input: t.arg({ type: IssueUpdateInput, required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => updateIssue(s, args.id, args.input));
        return { entity: await loadIssue(ctx, id) };
      },
    }),
    issueBatchUpdate: t.field({
      type: IssueBatchPayload,
      description: "Applies the same update to up to 50 issues.",
      args: {
        ids: t.arg.stringList({ required: true }),
        input: t.arg({ type: IssueUpdateInput, required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const ids = await act(ctx, (s) => updateIssues(s, args.ids, args.input));
        const rows = ids.length
          ? await db(ctx).select().from(issues).where(inArray(issues.id, ids)).all()
          : [];
        const byId = new Map(rows.map((r) => [r.id, r]));
        return { issues: ids.flatMap((id) => byId.get(id) ?? []) };
      },
    }),
    issueArchive: t.field({
      type: IssueArchivePayload,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => setIssueArchived(s, args.id, true));
        return { entity: await loadIssue(ctx, id) };
      },
    }),
    issueUnarchive: t.field({
      type: IssueArchivePayload,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => setIssueArchived(s, args.id, false));
        return { entity: await loadIssue(ctx, id) };
      },
    }),

    issueLabelCreate: t.field({
      type: IssueLabelPayload,
      args: { input: t.arg({ type: IssueLabelCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => createLabel(s, args.input));
        const label = await ctx.loaders.label.load(id);
        if (!label) throw notFoundError("Label");
        return { entity: label };
      },
    }),
    issueLabelUpdate: t.field({
      type: IssueLabelPayload,
      args: {
        id: t.arg.string({ required: true }),
        input: t.arg({ type: IssueLabelUpdateInput, required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => updateLabel(s, args.id, args.input));
        ctx.loaders.label.clear(id);
        const label = await ctx.loaders.label.load(id);
        if (!label) throw notFoundError("Label");
        return { entity: label };
      },
    }),
    issueLabelDelete: t.field({
      type: DeletePayload,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await act(ctx, (s) => deleteLabel(s, args.id));
        return { entityId: args.id };
      },
    }),

    workflowStateCreate: t.field({
      type: WorkflowStatePayload,
      args: { input: t.arg({ type: WorkflowStateCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => createState(s, args.input));
        const state = await ctx.loaders.state.load(id);
        if (!state) throw notFoundError("Status");
        return { entity: state };
      },
    }),
    workflowStateUpdate: t.field({
      type: WorkflowStatePayload,
      args: {
        id: t.arg.string({ required: true }),
        input: t.arg({ type: WorkflowStateUpdateInput, required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => updateState(s, args.id, args.input));
        ctx.loaders.state.clear(id);
        const state = await ctx.loaders.state.load(id);
        if (!state) throw notFoundError("Status");
        return { entity: state };
      },
    }),
    workflowStateArchive: t.field({
      type: DeletePayload,
      description: "Removes a status no issue uses. Each team keeps at least one of every type.",
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await act(ctx, (s) => archiveState(s, args.id));
        return { entityId: args.id };
      },
    }),

    commentCreate: t.field({
      type: CommentPayload,
      args: { input: t.arg({ type: CommentCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => createComment(s, args.input));
        const comment = await db(ctx).select().from(comments).where(eq(comments.id, id)).get();
        if (!comment) throw notFoundError("Comment");
        return { entity: comment };
      },
    }),
    commentUpdate: t.field({
      type: CommentPayload,
      args: {
        id: t.arg.string({ required: true }),
        input: t.arg({ type: CommentUpdateInput, required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => updateComment(s, args.id, args.input));
        const comment = await db(ctx).select().from(comments).where(eq(comments.id, id)).get();
        if (!comment) throw notFoundError("Comment");
        return { entity: comment };
      },
    }),
    commentDelete: t.field({
      type: DeletePayload,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await act(ctx, (s) => deleteComment(s, args.id));
        return { entityId: args.id };
      },
    }),

    reactionCreate: t.field({
      type: ReactionPayload,
      args: { input: t.arg({ type: ReactionCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => createReaction(s, args.input));
        const reaction = await db(ctx).select().from(reactions).where(eq(reactions.id, id)).get();
        if (!reaction) throw notFoundError("Reaction");
        return { entity: reaction };
      },
    }),
    reactionDelete: t.field({
      type: DeletePayload,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await act(ctx, (s) => deleteReaction(s, args.id));
        return { entityId: args.id };
      },
    }),

    issueRelationCreate: t.field({
      type: IssueRelationPayload,
      args: { input: t.arg({ type: IssueRelationCreateInput, required: true }) },
      resolve: async (_root, args, ctx) => {
        const id = await act(ctx, (s) => createRelation(s, args.input));
        const relation = await db(ctx)
          .select()
          .from(issueRelations)
          .where(eq(issueRelations.id, id))
          .get();
        if (!relation) throw notFoundError("Relation");
        return { entity: relation };
      },
    }),
    issueRelationDelete: t.field({
      type: DeletePayload,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await act(ctx, (s) => deleteRelation(s, args.id));
        return { entityId: args.id };
      },
    }),

    agentHire: t.field({
      type: UserPayload,
      description: "Hires an AI agent employee with a charter.",
      args: { input: t.arg({ type: AgentHireInput, required: true }) },
      resolve: async (_root, args, ctx) => ({
        entity: await loadUser(ctx, await act(ctx, (s) => hireAgent(s, args.input))),
      }),
    }),
    userUpdate: t.field({
      type: UserPayload,
      description: "Renames a member or changes their title, manager or (for agents) charter.",
      args: {
        id: t.arg.string({ required: true }),
        input: t.arg({ type: UserUpdateInput, required: true }),
      },
      resolve: async (_root, args, ctx) => ({
        entity: await loadUser(ctx, await act(ctx, (s) => updateUser(s, args.id, args.input))),
      }),
    }),
    agentRetire: t.field({
      type: UserPayload,
      description: "Retires an agent: its tokens stop working and its reports move to its manager.",
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => ({
        entity: await loadUser(ctx, await act(ctx, (s) => retireAgent(s, args.id))),
      }),
    }),
    apiTokenRevoke: t.field({
      type: DeletePayload,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await act(ctx, (s) => revokeApiToken(s, args.id));
        return { entityId: args.id };
      },
    }),

    apiTokenCreate: t.field({
      type: ApiTokenPayload,
      description: "Owner only: issues an API token for yourself or an agent.",
      args: {
        name: t.arg.string({ required: true }),
        userId: t.arg.string({ required: false, description: "Defaults to you." }),
      },
      resolve: async (_root, args, ctx) => {
        const viewer = requireOwner(ctx);
        const userId = args.userId ?? viewer.user.id;
        const user = await ctx.loaders.user.load(userId);
        if (!user?.active) throw notFoundError("User");
        const created = await act(ctx, (s) =>
          createApiToken(s.db, { userId, name: args.name, actorId: s.actorId }, s.now),
        );
        return { ...created, user };
      },
    }),
  }),
});
