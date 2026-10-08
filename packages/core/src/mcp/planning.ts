import {
  documents,
  initiatives,
  issues,
  projectMilestones,
  projects,
  projectTeams,
  projectUpdates,
  teams,
} from "@life-os/schema";
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  createDocument,
  createMilestone,
  createProject,
  createProjectUpdate,
  requireDocument,
  updateDocument,
  updateMilestone,
  updateProject,
} from "../services/projects.js";
import { type Tool, ToolError } from "./protocol.js";
import {
  type Args,
  issueSummary,
  limitArg,
  type McpContext,
  resolveMilestone,
  resolveProject,
  resolveTeam,
  resolveUser,
  str,
} from "./tools.js";

type ProjectRow = typeof projects.$inferSelect;

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const limit = (v: unknown) => Math.min(Math.max(Number(v) || 50, 1), 250);

async function projectSummary(c: McpContext, p: ProjectRow) {
  const [lead, teamRows, counts, last] = await Promise.all([
    p.leadId ? c.loaders.user.load(p.leadId) : null,
    c.db
      .select({ name: teams.name })
      .from(projectTeams)
      .innerJoin(teams, eq(teams.id, projectTeams.teamId))
      .where(eq(projectTeams.projectId, p.id))
      .all(),
    c.db
      .select({
        total: count(),
        completed: count(issues.completedAt),
        canceled: count(issues.canceledAt),
      })
      .from(issues)
      .where(and(eq(issues.projectId, p.id), isNull(issues.archivedAt)))
      .get(),
    c.db
      .select({ health: projectUpdates.health })
      .from(projectUpdates)
      .where(eq(projectUpdates.projectId, p.id))
      .orderBy(desc(projectUpdates.createdAt))
      .limit(1)
      .get(),
  ]);
  const scope = (counts?.total ?? 0) - (counts?.canceled ?? 0);
  return {
    id: p.id,
    name: p.name,
    summary: p.summary,
    url: `${c.appUrl}/project/${p.id}`,
    state: p.state,
    health: last?.health ?? null,
    lead: lead?.name ?? null,
    teams: teamRows.map((t) => t.name),
    startDate: p.startDate,
    targetDate: p.targetDate,
    progress: { completed: counts?.completed ?? 0, scope },
    archivedAt: iso(p.archivedAt),
  };
}

const projectFields = {
  name: { type: "string" },
  summary: { type: ["string", "null"], description: "One line: what the project achieves" },
  description: { type: ["string", "null"], description: "Markdown" },
  state: {
    type: "string",
    enum: ["backlog", "planned", "started", "paused", "completed", "canceled"],
  },
  lead: { type: ["string", "null"], description: 'Member name, id or "me"' },
  teams: { type: "array", items: { type: "string" }, description: "Team names, keys or ids" },
  startDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
  targetDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
  initiative: { type: ["string", "null"], description: "Initiative name or id" },
} as const;

async function projectInput(c: McpContext, args: Args) {
  const input: Record<string, unknown> = {};
  for (const key of ["name", "summary", "description", "state", "startDate", "targetDate"]) {
    if (args[key] !== undefined) input[key] = str(args[key]) ?? null;
  }
  if (args.lead !== undefined)
    input.leadId = args.lead ? (await resolveUser(c, String(args.lead))).id : null;
  if (Array.isArray(args.teams))
    input.teamIds = await Promise.all(
      args.teams.map(async (t) => (await resolveTeam(c, String(t))).id),
    );
  if (args.initiative !== undefined) {
    if (!args.initiative) input.initiativeId = null;
    else {
      const ref = String(args.initiative);
      const row = await c.db
        .select()
        .from(initiatives)
        .where(or(eq(initiatives.id, ref), sql`lower(${initiatives.name}) = ${ref.toLowerCase()}`))
        .get();
      if (!row) throw new ToolError(`No initiative matches "${ref}". Use list_initiatives.`);
      input.initiativeId = row.id;
    }
  }
  return input;
}

async function documentSummary(c: McpContext, d: typeof documents.$inferSelect, full: boolean) {
  const [project, updatedBy] = await Promise.all([
    d.projectId ? c.loaders.project.load(d.projectId) : null,
    d.updatedById ? c.loaders.user.load(d.updatedById) : null,
  ]);
  return {
    id: d.id,
    title: d.title,
    url: `${c.appUrl}/document/${d.id}`,
    project: project?.name ?? null,
    updatedBy: updatedBy?.name ?? null,
    updatedAt: iso(d.updatedAt),
    ...(full ? { content: d.content } : {}),
  };
}

/** Planning tools named like Linear's MCP server: projects, milestones, updates and documents. */
export const planningTools: Tool<McpContext>[] = [
  {
    name: "list_projects",
    title: "List projects",
    description: "List projects with their state, health, lead, dates and progress.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Only projects in this state" },
        team: { type: "string", description: "Only projects of this team" },
        includeArchived: { type: "boolean" },
        limit: limitArg,
      },
    },
    async run(args, c) {
      const team = args.team ? await resolveTeam(c, String(args.team)) : null;
      const rows = await c.db
        .select()
        .from(projects)
        .where(
          and(
            args.includeArchived ? undefined : isNull(projects.archivedAt),
            args.state ? eq(projects.state, String(args.state) as ProjectRow["state"]) : undefined,
            team
              ? inArray(
                  projects.id,
                  c.db
                    .select({ id: projectTeams.projectId })
                    .from(projectTeams)
                    .where(eq(projectTeams.teamId, team.id)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(projects.sortOrder))
        .limit(limit(args.limit))
        .all();
      return { projects: await Promise.all(rows.map((p) => projectSummary(c, p))) };
    },
  },
  {
    name: "get_project",
    title: "Get project",
    description:
      "Get a project by name or id: description, milestones, latest updates, documents and issues.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Project name or id" } },
      required: ["query"],
    },
    async run(args, c) {
      const p = await resolveProject(c, String(args.query));
      const [summary, milestones, updates, docs, projectIssues] = await Promise.all([
        projectSummary(c, p),
        c.db
          .select()
          .from(projectMilestones)
          .where(eq(projectMilestones.projectId, p.id))
          .orderBy(asc(projectMilestones.sortOrder))
          .all(),
        c.db
          .select()
          .from(projectUpdates)
          .where(eq(projectUpdates.projectId, p.id))
          .orderBy(desc(projectUpdates.createdAt))
          .limit(3)
          .all(),
        c.db
          .select()
          .from(documents)
          .where(and(eq(documents.projectId, p.id), isNull(documents.archivedAt)))
          .all(),
        c.db
          .select()
          .from(issues)
          .where(and(eq(issues.projectId, p.id), isNull(issues.archivedAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(100)
          .all(),
      ]);
      return {
        ...summary,
        description: p.description,
        milestones: milestones.map((m) => ({ id: m.id, name: m.name, targetDate: m.targetDate })),
        latestUpdates: await Promise.all(
          updates.map(async (u) => ({
            id: u.id,
            health: u.health,
            author: (await c.loaders.user.load(u.userId))?.name ?? null,
            createdAt: iso(u.createdAt),
            body: u.body,
          })),
        ),
        documents: docs.map((d) => ({ id: d.id, title: d.title })),
        issues: await Promise.all(projectIssues.map((i) => issueSummary(c, i))),
      };
    },
  },
  {
    name: "create_project",
    title: "Create project",
    description: "Create a project.",
    inputSchema: { type: "object", properties: projectFields, required: ["name"] },
    async run(args, c) {
      const input = await projectInput(c, args);
      const id = await c.act((s) =>
        createProject(s, { ...input, name: String(args.name) } as Parameters<
          typeof createProject
        >[1]),
      );
      c.loaders.project.clear(id);
      return projectSummary(c, await resolveProject(c, id));
    },
  },
  {
    name: "update_project",
    title: "Update project",
    description: "Update a project's name, summary, description, state, lead, teams or dates.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Project name or id" }, ...projectFields },
      required: ["id"],
    },
    async run(args, c) {
      const p = await resolveProject(c, String(args.id));
      const { id: _id, ...rest } = args;
      await c.act(async (s) => updateProject(s, p.id, await projectInput(c, rest)));
      c.loaders.project.clear(p.id);
      return projectSummary(c, await resolveProject(c, p.id));
    },
  },
  {
    name: "create_project_update",
    title: "Post project update",
    description:
      "Post a status update on a project: what moved, what's next, risks. Its lead and the owner are notified.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id" },
        body: { type: "string", description: "Markdown" },
        health: { type: "string", enum: ["onTrack", "atRisk", "offTrack"] },
      },
      required: ["project", "body"],
    },
    async run(args, c) {
      const p = await resolveProject(c, String(args.project));
      const id = await c.act((s) =>
        createProjectUpdate(s, {
          projectId: p.id,
          body: String(args.body),
          health: str(args.health) ?? null,
        }),
      );
      return { id, project: p.name, url: `${c.appUrl}/project/${p.id}` };
    },
  },
  {
    name: "save_milestone",
    title: "Create or update milestone",
    description: "Create a milestone in a project, or update one by id.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id (to create)" },
        id: { type: "string", description: "Milestone name or id (to update)" },
        name: { type: "string" },
        description: { type: ["string", "null"] },
        targetDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
    },
    async run(args, c) {
      const input = {
        ...(args.name !== undefined ? { name: str(args.name) ?? null } : {}),
        ...(args.description !== undefined ? { description: str(args.description) ?? null } : {}),
        ...(args.targetDate !== undefined ? { targetDate: str(args.targetDate) ?? null } : {}),
      };
      if (args.id) {
        const p = args.project ? await resolveProject(c, String(args.project)) : null;
        const m = await resolveMilestone(c, String(args.id), p?.id ?? null);
        await c.act((s) => updateMilestone(s, m.id, input));
        return { id: m.id };
      }
      if (!args.project || !args.name)
        throw new ToolError("Give a project and a name to create one");
      const p = await resolveProject(c, String(args.project));
      const id = await c.act((s) =>
        createMilestone(s, { ...input, projectId: p.id, name: String(args.name) }),
      );
      return { id, project: p.name };
    },
  },
  {
    name: "list_initiatives",
    title: "List initiatives",
    description: "List the company's initiatives and their projects.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async run(_args, c) {
      const rows = await c.db
        .select()
        .from(initiatives)
        .where(isNull(initiatives.archivedAt))
        .orderBy(asc(initiatives.sortOrder))
        .all();
      return {
        initiatives: await Promise.all(
          rows.map(async (i) => ({
            id: i.id,
            name: i.name,
            status: i.status,
            targetDate: i.targetDate,
            owner: i.ownerId ? ((await c.loaders.user.load(i.ownerId))?.name ?? null) : null,
            projects: (
              await c.db
                .select({ name: projects.name })
                .from(projects)
                .where(and(eq(projects.initiativeId, i.id), isNull(projects.archivedAt)))
                .all()
            ).map((p) => p.name),
          })),
        ),
      };
    },
  },
  {
    name: "list_documents",
    title: "List documents",
    description: "List documents, most recently edited first.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words in the title" },
        project: { type: "string", description: "Project name or id" },
        limit: limitArg,
      },
    },
    async run(args, c) {
      const project = args.project ? await resolveProject(c, String(args.project)) : null;
      const q = str(args.query)?.toLowerCase();
      const rows = await c.db
        .select()
        .from(documents)
        .where(
          and(
            isNull(documents.archivedAt),
            project ? eq(documents.projectId, project.id) : undefined,
            q
              ? sql`lower(${documents.title}) like ${`%${q.replace(/[%_\\]/g, "\\$&")}%`} escape '\\'`
              : undefined,
          ),
        )
        .orderBy(desc(documents.updatedAt))
        .limit(limit(args.limit))
        .all();
      return { documents: await Promise.all(rows.map((d) => documentSummary(c, d, false))) };
    },
  },
  {
    name: "get_document",
    title: "Get document",
    description: "Get a document's content by id.",
    readOnly: true,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(args, c) {
      const doc = await requireDocument(c.db, String(args.id)).catch(() => {
        throw new ToolError(`No document ${args.id}`);
      });
      return documentSummary(c, doc, true);
    },
  },
  {
    name: "create_document",
    title: "Create document",
    description: "Create a Markdown document, optionally in a project.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "Markdown" },
        project: { type: "string", description: "Project name or id" },
      },
      required: ["title"],
    },
    async run(args, c) {
      const project = args.project ? await resolveProject(c, String(args.project)) : null;
      const id = await c.act((s) =>
        createDocument(s, {
          title: String(args.title),
          content: str(args.content) ?? "",
          projectId: project?.id ?? null,
        }),
      );
      return documentSummary(c, await requireDocument(c.db, id), false);
    },
  },
  {
    name: "update_document",
    title: "Update document",
    description: "Update a document's title or content (the content is replaced).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string", description: "Markdown; replaces the content" },
      },
      required: ["id"],
    },
    async run(args, c) {
      const id = String(args.id);
      await c.act((s) =>
        updateDocument(s, id, {
          ...(args.title !== undefined ? { title: str(args.title) ?? null } : {}),
          ...(args.content !== undefined ? { content: str(args.content) ?? "" } : {}),
        }),
      );
      return documentSummary(c, await requireDocument(c.db, id), false);
    },
  },
];
