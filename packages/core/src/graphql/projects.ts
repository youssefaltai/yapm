import {
  documents,
  INITIATIVE_STATUSES,
  initiatives,
  issues,
  PROJECT_HEALTHS,
  PROJECT_STATES,
  projectMilestones,
  projects,
  projectTeams,
  projectUpdates,
  teams,
} from "@life-os/schema";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import {
  createDocument,
  createInitiative,
  createMilestone,
  createProject,
  createProjectUpdate,
  deleteMilestone,
  deleteProjectUpdate,
  requireDocument,
  requireProject,
  setDocumentArchived,
  setInitiativeArchived,
  setProjectArchived,
  updateDocument,
  updateInitiative,
  updateMilestone,
  updateProject,
  updateProjectUpdate,
} from "../services/projects.js";
import {
  act,
  builder,
  connection,
  db,
  notFoundError,
  pageArgs,
  paginate,
  requireViewer,
} from "./builder.js";
import { issueArgs, queryIssues } from "./filters.js";
import { Notification } from "./inbox.js";
import { DeletePayload, payload } from "./mutations.js";
import { Issue, IssueConnection, Team, TeamConnection, User } from "./types.js";

type ProjectRow = typeof projects.$inferSelect;
type MilestoneRow = typeof projectMilestones.$inferSelect;
type UpdateRow = typeof projectUpdates.$inferSelect;
type InitiativeRow = typeof initiatives.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;

const ProjectState = builder.enumType("ProjectState", { values: PROJECT_STATES });
const ProjectUpdateHealthType = builder.enumType("ProjectUpdateHealthType", {
  values: PROJECT_HEALTHS,
});
const InitiativeStatus = builder.enumType("InitiativeStatus", { values: INITIATIVE_STATUSES });

export const Project = builder.objectRef<ProjectRow>("Project");
export const ProjectMilestone = builder.objectRef<MilestoneRow>("ProjectMilestone");
export const ProjectUpdate = builder.objectRef<UpdateRow>("ProjectUpdate");
export const Initiative = builder.objectRef<InitiativeRow>("Initiative");
export const Document = builder.objectRef<DocumentRow>("Document");

const ProjectConnection = connection<ProjectRow>("Project", Project);
const ProjectMilestoneConnection = connection<MilestoneRow>("ProjectMilestone", ProjectMilestone);
const ProjectUpdateConnection = connection<UpdateRow>("ProjectUpdate", ProjectUpdate);
const InitiativeConnection = connection<InitiativeRow>("Initiative", Initiative);
const DocumentConnection = connection<DocumentRow>("Document", Document);

/** Issue counts for progress: Linear counts scope without canceled issues. */
async function issueCounts(ctx: Parameters<typeof db>[0], where: SQL) {
  const rows = await db(ctx)
    .select({
      total: count(),
      completed: count(issues.completedAt),
      canceled: count(issues.canceledAt),
      started: count(issues.startedAt),
    })
    .from(issues)
    .where(and(where, isNull(issues.archivedAt)))
    .get();
  const total = (rows?.total ?? 0) - (rows?.canceled ?? 0);
  return {
    scope: total,
    completed: rows?.completed ?? 0,
    started: (rows?.started ?? 0) - (rows?.completed ?? 0),
    progress: total > 0 ? (rows?.completed ?? 0) / total : 0,
  };
}

const ProjectProgress = builder
  .objectRef<Awaited<ReturnType<typeof issueCounts>>>("ProjectProgress")
  .implement({
    description: "Issue counts behind a progress bar; canceled issues don't count.",
    fields: (t) => ({
      scope: t.exposeInt("scope"),
      completed: t.exposeInt("completed"),
      started: t.exposeInt("started"),
      progress: t.exposeFloat("progress", { description: "From 0 to 1." }),
    }),
  });

Project.implement({
  description: "A body of work with a goal and a target date, across teams.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    summary: t.exposeString("summary", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    icon: t.exposeString("icon", { nullable: true }),
    color: t.exposeString("color"),
    state: t.field({ type: ProjectState, resolve: (p) => p.state }),
    startDate: t.field({ type: "TimelessDate", nullable: true, resolve: (p) => p.startDate }),
    targetDate: t.field({ type: "TimelessDate", nullable: true, resolve: (p) => p.targetDate }),
    sortOrder: t.exposeFloat("sortOrder"),
    url: t.string({ resolve: (p) => `/project/${p.id}` }),
    createdAt: t.field({ type: "DateTime", resolve: (p) => p.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (p) => p.updatedAt }),
    startedAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.startedAt }),
    completedAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.completedAt }),
    canceledAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.canceledAt }),
    archivedAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.archivedAt }),
    lead: t.field({
      type: User,
      nullable: true,
      resolve: (p, _args, ctx) => (p.leadId ? ctx.loaders.user.load(p.leadId) : null),
    }),
    creator: t.field({
      type: User,
      nullable: true,
      resolve: (p, _args, ctx) => (p.creatorId ? ctx.loaders.user.load(p.creatorId) : null),
    }),
    initiative: t.field({
      type: Initiative,
      nullable: true,
      resolve: async (p, _args, ctx) =>
        p.initiativeId
          ? ((await db(ctx)
              .select()
              .from(initiatives)
              .where(eq(initiatives.id, p.initiativeId))
              .get()) ?? null)
          : null,
    }),
    teams: t.field({
      type: TeamConnection,
      args: pageArgs,
      resolve: async (p, args, ctx) =>
        paginate(
          await db(ctx)
            .select({ team: teams })
            .from(projectTeams)
            .innerJoin(teams, eq(teams.id, projectTeams.teamId))
            .where(eq(projectTeams.projectId, p.id))
            .orderBy(asc(teams.name))
            .all()
            .then((rows) => rows.map((r) => r.team)),
          args,
        ),
    }),
    issues: t.field({
      type: IssueConnection,
      args: issueArgs,
      resolve: (p, args, ctx) =>
        queryIssues(db(ctx), args, requireViewer(ctx).user.id, eq(issues.projectId, p.id)),
    }),
    projectMilestones: t.field({
      type: ProjectMilestoneConnection,
      args: pageArgs,
      resolve: async (p, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(projectMilestones)
            .where(eq(projectMilestones.projectId, p.id))
            .orderBy(asc(projectMilestones.sortOrder), asc(projectMilestones.createdAt))
            .all(),
          args,
        ),
    }),
    projectUpdates: t.field({
      type: ProjectUpdateConnection,
      description: "Status updates, newest first.",
      args: pageArgs,
      resolve: async (p, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(projectUpdates)
            .where(eq(projectUpdates.projectId, p.id))
            .orderBy(desc(projectUpdates.createdAt))
            .all(),
          args,
        ),
    }),
    lastUpdate: t.field({
      type: ProjectUpdate,
      nullable: true,
      resolve: async (p, _args, ctx) =>
        (await db(ctx)
          .select()
          .from(projectUpdates)
          .where(eq(projectUpdates.projectId, p.id))
          .orderBy(desc(projectUpdates.createdAt))
          .limit(1)
          .get()) ?? null,
    }),
    health: t.field({
      type: ProjectUpdateHealthType,
      nullable: true,
      description: "From the latest update; null until the first one.",
      resolve: async (p, _args, ctx) =>
        (
          await db(ctx)
            .select({ health: projectUpdates.health })
            .from(projectUpdates)
            .where(eq(projectUpdates.projectId, p.id))
            .orderBy(desc(projectUpdates.createdAt))
            .limit(1)
            .get()
        )?.health ?? null,
    }),
    documents: t.field({
      type: DocumentConnection,
      args: pageArgs,
      resolve: async (p, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(documents)
            .where(and(eq(documents.projectId, p.id), isNull(documents.archivedAt)))
            .orderBy(desc(documents.updatedAt))
            .all(),
          args,
        ),
    }),
    progress: t.field({
      type: ProjectProgress,
      resolve: (p, _args, ctx) => issueCounts(ctx, eq(issues.projectId, p.id)),
    }),
  }),
});

ProjectMilestone.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    targetDate: t.field({ type: "TimelessDate", nullable: true, resolve: (m) => m.targetDate }),
    sortOrder: t.exposeFloat("sortOrder"),
    createdAt: t.field({ type: "DateTime", resolve: (m) => m.createdAt }),
    project: t.field({
      type: Project,
      resolve: async (m, _args, ctx) => {
        const row = await ctx.loaders.project.load(m.projectId);
        if (!row) throw notFoundError("Project");
        return row;
      },
    }),
    issues: t.field({
      type: IssueConnection,
      args: issueArgs,
      resolve: (m, args, ctx) =>
        queryIssues(db(ctx), args, requireViewer(ctx).user.id, eq(issues.projectMilestoneId, m.id)),
    }),
    progress: t.field({
      type: ProjectProgress,
      resolve: (m, _args, ctx) => issueCounts(ctx, eq(issues.projectMilestoneId, m.id)),
    }),
  }),
});

ProjectUpdate.implement({
  description: "A status post on a project.",
  fields: (t) => ({
    id: t.exposeID("id"),
    body: t.exposeString("body"),
    health: t.field({ type: ProjectUpdateHealthType, resolve: (u) => u.health }),
    createdAt: t.field({ type: "DateTime", resolve: (u) => u.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (u) => u.updatedAt }),
    editedAt: t.field({ type: "DateTime", nullable: true, resolve: (u) => u.editedAt }),
    user: t.field({
      type: User,
      resolve: async (u, _args, ctx) => {
        const row = await ctx.loaders.user.load(u.userId);
        if (!row) throw notFoundError("User");
        return row;
      },
    }),
    project: t.field({
      type: Project,
      resolve: async (u, _args, ctx) => {
        const row = await ctx.loaders.project.load(u.projectId);
        if (!row) throw notFoundError("Project");
        return row;
      },
    }),
  }),
});

Initiative.implement({
  description: "A company-level goal made of projects.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    status: t.field({ type: InitiativeStatus, resolve: (i) => i.status }),
    targetDate: t.field({ type: "TimelessDate", nullable: true, resolve: (i) => i.targetDate }),
    sortOrder: t.exposeFloat("sortOrder"),
    createdAt: t.field({ type: "DateTime", resolve: (i) => i.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (i) => i.updatedAt }),
    archivedAt: t.field({ type: "DateTime", nullable: true, resolve: (i) => i.archivedAt }),
    owner: t.field({
      type: User,
      nullable: true,
      resolve: (i, _args, ctx) => (i.ownerId ? ctx.loaders.user.load(i.ownerId) : null),
    }),
    projects: t.field({
      type: ProjectConnection,
      args: pageArgs,
      resolve: async (i, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(projects)
            .where(and(eq(projects.initiativeId, i.id), isNull(projects.archivedAt)))
            .orderBy(asc(projects.sortOrder))
            .all(),
          args,
        ),
    }),
  }),
});

Document.implement({
  description: "A Markdown page: a spec, a plan, a brief.",
  fields: (t) => ({
    id: t.exposeID("id"),
    title: t.exposeString("title"),
    content: t.exposeString("content", { description: "Markdown." }),
    icon: t.exposeString("icon", { nullable: true }),
    url: t.string({ resolve: (d) => `/document/${d.id}` }),
    createdAt: t.field({ type: "DateTime", resolve: (d) => d.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (d) => d.updatedAt }),
    archivedAt: t.field({ type: "DateTime", nullable: true, resolve: (d) => d.archivedAt }),
    creator: t.field({
      type: User,
      nullable: true,
      resolve: (d, _args, ctx) => (d.creatorId ? ctx.loaders.user.load(d.creatorId) : null),
    }),
    updatedBy: t.field({
      type: User,
      nullable: true,
      resolve: (d, _args, ctx) => (d.updatedById ? ctx.loaders.user.load(d.updatedById) : null),
    }),
    project: t.field({
      type: Project,
      nullable: true,
      resolve: (d, _args, ctx) => (d.projectId ? ctx.loaders.project.load(d.projectId) : null),
    }),
    initiative: t.field({
      type: Initiative,
      nullable: true,
      resolve: async (d, _args, ctx) =>
        d.initiativeId
          ? ((await db(ctx)
              .select()
              .from(initiatives)
              .where(eq(initiatives.id, d.initiativeId))
              .get()) ?? null)
          : null,
    }),
  }),
});

builder.objectFields(Issue, (t) => ({
  project: t.field({
    type: Project,
    nullable: true,
    resolve: (issue, _args, ctx) =>
      issue.projectId ? ctx.loaders.project.load(issue.projectId) : null,
  }),
  projectMilestone: t.field({
    type: ProjectMilestone,
    nullable: true,
    resolve: (issue, _args, ctx) =>
      issue.projectMilestoneId ? ctx.loaders.projectMilestone.load(issue.projectMilestoneId) : null,
  }),
}));

builder.objectFields(Notification, (t) => ({
  project: t.field({
    type: Project,
    nullable: true,
    resolve: (n, _args, ctx) => (n.projectId ? ctx.loaders.project.load(n.projectId) : null),
  }),
  projectUpdate: t.field({
    type: ProjectUpdate,
    nullable: true,
    resolve: async (n, _args, ctx) =>
      n.projectUpdateId
        ? ((await db(ctx)
            .select()
            .from(projectUpdates)
            .where(eq(projectUpdates.id, n.projectUpdateId))
            .get()) ?? null)
        : null,
  }),
}));

builder.objectField(Team, "projects", (t) =>
  t.field({
    type: ProjectConnection,
    args: pageArgs,
    resolve: async (team, args, ctx) =>
      paginate(
        await db(ctx)
          .select({ project: projects })
          .from(projectTeams)
          .innerJoin(projects, eq(projects.id, projectTeams.projectId))
          .where(and(eq(projectTeams.teamId, team.id), isNull(projects.archivedAt)))
          .orderBy(asc(projects.sortOrder))
          .all()
          .then((rows) => rows.map((r) => r.project)),
        args,
      ),
  }),
);

const ProjectFilter = builder.inputType("ProjectFilter", {
  fields: (t) => ({
    state: t.field({ type: [ProjectState], required: false }),
    teamId: t.string({ required: false }),
    leadId: t.string({ required: false }),
    initiativeId: t.string({ required: false }),
  }),
});

builder.queryFields((t) => ({
  projects: t.field({
    type: ProjectConnection,
    description: "Projects in their manual order.",
    args: {
      ...pageArgs,
      filter: t.arg({ type: ProjectFilter, required: false }),
      includeArchived: t.arg.boolean({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const f = args.filter;
      const rows = await db(ctx)
        .select()
        .from(projects)
        .where(
          and(
            args.includeArchived ? undefined : isNull(projects.archivedAt),
            f?.state?.length ? inArray(projects.state, f.state) : undefined,
            f?.leadId ? eq(projects.leadId, f.leadId) : undefined,
            f?.initiativeId ? eq(projects.initiativeId, f.initiativeId) : undefined,
            f?.teamId
              ? inArray(
                  projects.id,
                  db(ctx)
                    .select({ id: projectTeams.projectId })
                    .from(projectTeams)
                    .where(eq(projectTeams.teamId, f.teamId)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(projects.sortOrder), asc(projects.createdAt))
        .all();
      return paginate(rows, args);
    },
  }),
  project: t.field({
    type: Project,
    args: { id: t.arg.string({ required: true }) },
    resolve: (_root, args, ctx) => {
      requireViewer(ctx);
      return requireProject(db(ctx), args.id).catch(() => {
        throw notFoundError("Project");
      });
    },
  }),
  projectUpdates: t.field({
    type: ProjectUpdateConnection,
    description: "Status updates across projects, newest first.",
    args: pageArgs,
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      return paginate(
        await db(ctx)
          .select()
          .from(projectUpdates)
          .orderBy(desc(projectUpdates.createdAt))
          .limit(250)
          .all(),
        args,
      );
    },
  }),
  initiatives: t.field({
    type: InitiativeConnection,
    args: { ...pageArgs, includeArchived: t.arg.boolean({ required: false }) },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      return paginate(
        await db(ctx)
          .select()
          .from(initiatives)
          .where(args.includeArchived ? undefined : isNull(initiatives.archivedAt))
          .orderBy(asc(initiatives.sortOrder))
          .all(),
        args,
      );
    },
  }),
  initiative: t.field({
    type: Initiative,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const row = await db(ctx).select().from(initiatives).where(eq(initiatives.id, args.id)).get();
      if (!row) throw notFoundError("Initiative");
      return row;
    },
  }),
  documents: t.field({
    type: DocumentConnection,
    description: "Documents, most recently edited first.",
    args: {
      ...pageArgs,
      projectId: t.arg.string({ required: false }),
      query: t.arg.string({ required: false, description: "Matches the title." }),
      includeArchived: t.arg.boolean({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const rows = await db(ctx)
        .select()
        .from(documents)
        .where(
          and(
            args.includeArchived ? isNotNull(documents.id) : isNull(documents.archivedAt),
            args.projectId ? eq(documents.projectId, args.projectId) : undefined,
          ),
        )
        .orderBy(desc(documents.updatedAt))
        .all();
      const q = args.query?.trim().toLowerCase();
      return paginate(q ? rows.filter((d) => d.title.toLowerCase().includes(q)) : rows, args);
    },
  }),
  document: t.field({
    type: Document,
    args: { id: t.arg.string({ required: true }) },
    resolve: (_root, args, ctx) => {
      requireViewer(ctx);
      return requireDocument(db(ctx), args.id).catch(() => {
        throw notFoundError("Document");
      });
    },
  }),
}));

const ProjectPayload = payload("ProjectPayload", "project", Project);
const ProjectMilestonePayload = payload(
  "ProjectMilestonePayload",
  "projectMilestone",
  ProjectMilestone,
);
const ProjectUpdatePayload = payload("ProjectUpdatePayload", "projectUpdate", ProjectUpdate);
const InitiativePayload = payload("InitiativePayload", "initiative", Initiative);
const DocumentPayload = payload("DocumentPayload", "document", Document);
const ProjectArchivePayload = payload("ProjectArchivePayload", "entity", Project);

const projectFields = (required: boolean) =>
  builder.inputType(required ? "ProjectCreateInput" : "ProjectUpdateInput", {
    fields: (t) => ({
      name: t.string({ required }),
      summary: t.string({ required: false, description: "One line: what the project achieves." }),
      description: t.string({ required: false, description: "Markdown." }),
      icon: t.string({ required: false }),
      color: t.string({ required: false }),
      state: t.field({ type: ProjectState, required: false }),
      leadId: t.string({ required: false }),
      initiativeId: t.string({ required: false }),
      teamIds: t.stringList({ required: false }),
      startDate: t.field({ type: "TimelessDate", required: false }),
      targetDate: t.field({ type: "TimelessDate", required: false }),
      sortOrder: t.float({ required: false }),
    }),
  });
const ProjectCreateInput = projectFields(true);
const ProjectUpdateInput = projectFields(false);

const milestoneFields = (required: boolean) =>
  builder.inputType(required ? "ProjectMilestoneCreateInput" : "ProjectMilestoneUpdateInput", {
    fields: (t) => ({
      ...(required ? { projectId: t.string({ required: true }) } : {}),
      name: t.string({ required }),
      description: t.string({ required: false }),
      targetDate: t.field({ type: "TimelessDate", required: false }),
      sortOrder: t.float({ required: false }),
    }),
  });
const ProjectMilestoneCreateInput = milestoneFields(true);
const ProjectMilestoneUpdateInput = milestoneFields(false);

const ProjectUpdateCreateInput = builder.inputType("ProjectUpdateCreateInput", {
  fields: (t) => ({
    projectId: t.string({ required: true }),
    body: t.string({ required: true, description: "Markdown." }),
    health: t.field({ type: ProjectUpdateHealthType, required: false }),
  }),
});
const ProjectUpdateUpdateInput = builder.inputType("ProjectUpdateUpdateInput", {
  fields: (t) => ({
    body: t.string({ required: false }),
    health: t.field({ type: ProjectUpdateHealthType, required: false }),
  }),
});

const initiativeFields = (required: boolean) =>
  builder.inputType(required ? "InitiativeCreateInput" : "InitiativeUpdateInput", {
    fields: (t) => ({
      name: t.string({ required }),
      description: t.string({ required: false }),
      status: t.field({ type: InitiativeStatus, required: false }),
      ownerId: t.string({ required: false }),
      targetDate: t.field({ type: "TimelessDate", required: false }),
      sortOrder: t.float({ required: false }),
    }),
  });
const InitiativeCreateInput = initiativeFields(true);
const InitiativeUpdateInput = initiativeFields(false);

const documentFields = (required: boolean) =>
  builder.inputType(required ? "DocumentCreateInput" : "DocumentUpdateInput", {
    fields: (t) => ({
      title: t.string({ required }),
      content: t.string({ required: false, description: "Markdown." }),
      icon: t.string({ required: false }),
      projectId: t.string({ required: false }),
      initiativeId: t.string({ required: false }),
    }),
  });
const DocumentCreateInput = documentFields(true);
const DocumentUpdateInput = documentFields(false);

async function loadProject(ctx: Parameters<typeof db>[0], id: string) {
  return { entity: await requireProject(db(ctx), id) };
}
async function loadOne<T>(rows: Promise<T | undefined>, what: string) {
  const row = await rows;
  if (!row) throw notFoundError(what);
  return { entity: row };
}

builder.mutationFields((t) => ({
  projectCreate: t.field({
    type: ProjectPayload,
    args: { input: t.arg({ type: ProjectCreateInput, required: true }) },
    resolve: async (_root, args, ctx) =>
      loadProject(ctx, await act(ctx, (s) => createProject(s, args.input as never))),
  }),
  projectUpdate: t.field({
    type: ProjectPayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: ProjectUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) =>
      loadProject(ctx, await act(ctx, (s) => updateProject(s, args.id, args.input))),
  }),
  projectArchive: t.field({
    type: ProjectArchivePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) =>
      loadProject(ctx, await act(ctx, (s) => setProjectArchived(s, args.id, true))),
  }),
  projectUnarchive: t.field({
    type: ProjectArchivePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) =>
      loadProject(ctx, await act(ctx, (s) => setProjectArchived(s, args.id, false))),
  }),
  projectMilestoneCreate: t.field({
    type: ProjectMilestonePayload,
    args: { input: t.arg({ type: ProjectMilestoneCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createMilestone(s, args.input as never));
      return loadOne(
        db(ctx).select().from(projectMilestones).where(eq(projectMilestones.id, id)).get(),
        "Milestone",
      );
    },
  }),
  projectMilestoneUpdate: t.field({
    type: ProjectMilestonePayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: ProjectMilestoneUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateMilestone(s, args.id, args.input));
      return loadOne(
        db(ctx).select().from(projectMilestones).where(eq(projectMilestones.id, id)).get(),
        "Milestone",
      );
    },
  }),
  projectMilestoneDelete: t.field({
    type: DeletePayload,
    description: "Deletes a milestone; its issues stay in the project.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await act(ctx, (s) => deleteMilestone(s, args.id));
      return { entityId: args.id };
    },
  }),
  projectUpdateCreate: t.field({
    type: ProjectUpdatePayload,
    description: "Posts a status update on a project; its lead and the owner are notified.",
    args: { input: t.arg({ type: ProjectUpdateCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createProjectUpdate(s, args.input));
      return loadOne(
        db(ctx).select().from(projectUpdates).where(eq(projectUpdates.id, id)).get(),
        "Project update",
      );
    },
  }),
  projectUpdateUpdate: t.field({
    type: ProjectUpdatePayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: ProjectUpdateUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateProjectUpdate(s, args.id, args.input));
      return loadOne(
        db(ctx).select().from(projectUpdates).where(eq(projectUpdates.id, id)).get(),
        "Project update",
      );
    },
  }),
  projectUpdateDelete: t.field({
    type: DeletePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await act(ctx, (s) => deleteProjectUpdate(s, args.id));
      return { entityId: args.id };
    },
  }),
  initiativeCreate: t.field({
    type: InitiativePayload,
    args: { input: t.arg({ type: InitiativeCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createInitiative(s, args.input as never));
      return loadOne(
        db(ctx).select().from(initiatives).where(eq(initiatives.id, id)).get(),
        "Initiative",
      );
    },
  }),
  initiativeUpdate: t.field({
    type: InitiativePayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: InitiativeUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateInitiative(s, args.id, args.input));
      return loadOne(
        db(ctx).select().from(initiatives).where(eq(initiatives.id, id)).get(),
        "Initiative",
      );
    },
  }),
  initiativeArchive: t.field({
    type: InitiativePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => setInitiativeArchived(s, args.id, true));
      return loadOne(
        db(ctx).select().from(initiatives).where(eq(initiatives.id, id)).get(),
        "Initiative",
      );
    },
  }),
  documentCreate: t.field({
    type: DocumentPayload,
    args: { input: t.arg({ type: DocumentCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createDocument(s, args.input as never));
      return { entity: await requireDocument(db(ctx), id) };
    },
  }),
  documentUpdate: t.field({
    type: DocumentPayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: DocumentUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateDocument(s, args.id, args.input));
      return { entity: await requireDocument(db(ctx), id) };
    },
  }),
  documentDelete: t.field({
    type: DocumentPayload,
    description: "Archives a document; documentUnarchive brings it back.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => setDocumentArchived(s, args.id, true));
      return { entity: await requireDocument(db(ctx), id) };
    },
  }),
  documentUnarchive: t.field({
    type: DocumentPayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => setDocumentArchived(s, args.id, false));
      return { entity: await requireDocument(db(ctx), id) };
    },
  }),
}));
