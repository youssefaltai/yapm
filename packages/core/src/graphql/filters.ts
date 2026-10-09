import { cycles, issueLabels, issues, labels, teams, workflowStates } from "@life-os/schema";
import {
  and,
  type Column,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { HubDb } from "../db.js";
import { builder, type Page, pageSize } from "./builder.js";

// Linear's filter shapes, a subset: comparators per field, nested filters for relations, and/or.

interface IDComparatorShape {
  eq?: string | null;
  neq?: string | null;
  in?: string[] | null;
  nin?: string[] | null;
}
interface StringComparatorShape extends IDComparatorShape {
  containsIgnoreCase?: string | null;
}
interface NumberComparatorShape {
  eq?: number | null;
  neq?: number | null;
  in?: number[] | null;
  nin?: number[] | null;
  lt?: number | null;
  lte?: number | null;
  gt?: number | null;
  gte?: number | null;
  null?: boolean | null;
}
interface DateComparatorShape {
  eq?: string | null;
  lt?: string | null;
  lte?: string | null;
  gt?: string | null;
  gte?: string | null;
  null?: boolean | null;
}

export const IDComparator = builder.inputRef<IDComparatorShape>("IDComparator").implement({
  fields: (t) => ({
    eq: t.id({ required: false }),
    neq: t.id({ required: false }),
    in: t.idList({ required: false }),
    nin: t.idList({ required: false }),
  }),
});

export const StringComparator = builder
  .inputRef<StringComparatorShape>("StringComparator")
  .implement({
    fields: (t) => ({
      eq: t.string({ required: false }),
      neq: t.string({ required: false }),
      in: t.stringList({ required: false }),
      nin: t.stringList({ required: false }),
      containsIgnoreCase: t.string({ required: false }),
    }),
  });

export const NullableNumberComparator = builder
  .inputRef<NumberComparatorShape>("NullableNumberComparator")
  .implement({
    fields: (t) => ({
      eq: t.float({ required: false }),
      neq: t.float({ required: false }),
      in: t.floatList({ required: false }),
      nin: t.floatList({ required: false }),
      lt: t.float({ required: false }),
      lte: t.float({ required: false }),
      gt: t.float({ required: false }),
      gte: t.float({ required: false }),
      null: t.boolean({ required: false }),
    }),
  });

export const NullableTimelessDateComparator = builder
  .inputRef<DateComparatorShape>("NullableTimelessDateComparator")
  .implement({
    fields: (t) => ({
      eq: t.string({ required: false }),
      lt: t.string({ required: false }),
      lte: t.string({ required: false }),
      gt: t.string({ required: false }),
      gte: t.string({ required: false }),
      null: t.boolean({ required: false }),
    }),
  });

const BooleanComparator = builder.inputRef<{ eq?: boolean | null }>("BooleanComparator").implement({
  fields: (t) => ({ eq: t.boolean({ required: false }) }),
});

interface TeamFilterShape {
  id?: IDComparatorShape | null;
  key?: StringComparatorShape | null;
}
const TeamFilter = builder.inputRef<TeamFilterShape>("TeamFilter").implement({
  fields: (t) => ({
    id: t.field({ type: IDComparator, required: false }),
    key: t.field({ type: StringComparator, required: false }),
  }),
});

interface StateFilterShape {
  id?: IDComparatorShape | null;
  name?: StringComparatorShape | null;
  type?: StringComparatorShape | null;
}
const WorkflowStateFilter = builder.inputRef<StateFilterShape>("WorkflowStateFilter").implement({
  fields: (t) => ({
    id: t.field({ type: IDComparator, required: false }),
    name: t.field({ type: StringComparator, required: false }),
    type: t.field({ type: StringComparator, required: false }),
  }),
});

interface UserFilterShape {
  id?: IDComparatorShape | null;
  isMe?: { eq?: boolean | null } | null;
  null?: boolean | null;
}
const NullableUserFilter = builder.inputRef<UserFilterShape>("NullableUserFilter").implement({
  fields: (t) => ({
    id: t.field({ type: IDComparator, required: false }),
    isMe: t.field({ type: BooleanComparator, required: false }),
    null: t.boolean({ required: false }),
  }),
});

interface LabelFilterShape {
  id?: IDComparatorShape | null;
  name?: StringComparatorShape | null;
}
const IssueLabelFilter = builder.inputRef<LabelFilterShape>("IssueLabelFilter").implement({
  fields: (t) => ({
    id: t.field({ type: IDComparator, required: false }),
    name: t.field({ type: StringComparator, required: false }),
  }),
});
const IssueLabelCollectionFilter = builder
  .inputRef<{ some?: LabelFilterShape | null; every?: LabelFilterShape | null }>(
    "IssueLabelCollectionFilter",
  )
  .implement({
    description:
      "`some`: at least one label matches. `every`: no label fails to match (issues with no labels pass).",
    fields: (t) => ({
      some: t.field({ type: IssueLabelFilter, required: false }),
      every: t.field({ type: IssueLabelFilter, required: false }),
    }),
  });

const NullableIssueFilter = builder
  .inputRef<{ id?: IDComparatorShape | null; null?: boolean | null }>("NullableIssueFilter")
  .implement({
    fields: (t) => ({
      id: t.field({ type: IDComparator, required: false }),
      null: t.boolean({ required: false }),
    }),
  });

const NullableProjectFilter = builder
  .inputRef<{ id?: IDComparatorShape | null; null?: boolean | null }>("NullableProjectFilter")
  .implement({
    fields: (t) => ({
      id: t.field({ type: IDComparator, required: false }),
      null: t.boolean({ required: false }),
    }),
  });

interface CycleFilterShape {
  id?: IDComparatorShape | null;
  number?: NumberComparatorShape | null;
  isActive?: { eq?: boolean | null } | null;
  null?: boolean | null;
}

const NullableCycleFilter = builder.inputRef<CycleFilterShape>("NullableCycleFilter").implement({
  fields: (t) => ({
    id: t.field({ type: IDComparator, required: false }),
    number: t.field({ type: NullableNumberComparator, required: false }),
    isActive: t.field({
      type: BooleanComparator,
      required: false,
      description: "The cycle running now.",
    }),
    null: t.boolean({ required: false }),
  }),
});

export interface IssueFilterShape {
  id?: IDComparatorShape | null;
  number?: NumberComparatorShape | null;
  title?: StringComparatorShape | null;
  priority?: NumberComparatorShape | null;
  estimate?: NumberComparatorShape | null;
  dueDate?: DateComparatorShape | null;
  team?: TeamFilterShape | null;
  state?: StateFilterShape | null;
  assignee?: UserFilterShape | null;
  creator?: UserFilterShape | null;
  labels?: { some?: LabelFilterShape | null; every?: LabelFilterShape | null } | null;
  parent?: { id?: IDComparatorShape | null; null?: boolean | null } | null;
  project?: { id?: IDComparatorShape | null; null?: boolean | null } | null;
  projectMilestone?: { id?: IDComparatorShape | null; null?: boolean | null } | null;
  cycle?: CycleFilterShape | null;
  and?: IssueFilterShape[] | null;
  or?: IssueFilterShape[] | null;
}

export const IssueFilter = builder.inputRef<IssueFilterShape>("IssueFilter").implement({
  description: "Filters issues; all given fields must match.",
  fields: (t) => ({
    id: t.field({ type: IDComparator, required: false }),
    number: t.field({ type: NullableNumberComparator, required: false }),
    title: t.field({ type: StringComparator, required: false }),
    priority: t.field({ type: NullableNumberComparator, required: false }),
    estimate: t.field({ type: NullableNumberComparator, required: false }),
    dueDate: t.field({ type: NullableTimelessDateComparator, required: false }),
    team: t.field({ type: TeamFilter, required: false }),
    state: t.field({ type: WorkflowStateFilter, required: false }),
    assignee: t.field({ type: NullableUserFilter, required: false }),
    creator: t.field({ type: NullableUserFilter, required: false }),
    labels: t.field({ type: IssueLabelCollectionFilter, required: false }),
    parent: t.field({ type: NullableIssueFilter, required: false }),
    project: t.field({ type: NullableProjectFilter, required: false }),
    projectMilestone: t.field({ type: NullableProjectFilter, required: false }),
    cycle: t.field({ type: NullableCycleFilter, required: false }),
    and: t.field({ type: [IssueFilter], required: false }),
    or: t.field({ type: [IssueFilter], required: false }),
  }),
});

function compare(column: Column, c: StringComparatorShape | null | undefined): SQL | undefined {
  if (!c) return undefined;
  return and(
    c.eq != null ? eq(column, c.eq) : undefined,
    c.neq != null ? ne(column, c.neq) : undefined,
    c.in ? (c.in.length ? inArray(column, c.in) : sql`0`) : undefined,
    c.nin?.length ? notInArray(column, c.nin) : undefined,
    c.containsIgnoreCase != null
      ? sql`lower(${column}) like ${`%${c.containsIgnoreCase.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`} escape '\\'`
      : undefined,
  );
}

function compareNumber(
  column: Column,
  c: NumberComparatorShape | null | undefined,
): SQL | undefined {
  if (!c) return undefined;
  return and(
    c.eq != null ? eq(column, c.eq) : undefined,
    c.neq != null ? ne(column, c.neq) : undefined,
    c.in ? (c.in.length ? inArray(column, c.in) : sql`0`) : undefined,
    c.nin?.length ? notInArray(column, c.nin) : undefined,
    c.lt != null ? lt(column, c.lt) : undefined,
    c.lte != null ? lte(column, c.lte) : undefined,
    c.gt != null ? gt(column, c.gt) : undefined,
    c.gte != null ? gte(column, c.gte) : undefined,
    c.null === true ? isNull(column) : c.null === false ? isNotNull(column) : undefined,
  );
}

function compareDate(column: Column, c: DateComparatorShape | null | undefined): SQL | undefined {
  if (!c) return undefined;
  return and(
    c.eq != null ? eq(column, c.eq) : undefined,
    c.lt != null ? lt(column, c.lt) : undefined,
    c.lte != null ? lte(column, c.lte) : undefined,
    c.gt != null ? gt(column, c.gt) : undefined,
    c.gte != null ? gte(column, c.gte) : undefined,
    c.null === true ? isNull(column) : c.null === false ? isNotNull(column) : undefined,
  );
}

function userCondition(column: Column, f: UserFilterShape | null | undefined, viewerId: string) {
  if (!f) return undefined;
  return and(
    compare(column, f.id),
    f.isMe?.eq === true
      ? eq(column, viewerId)
      : f.isMe?.eq === false
        ? or(isNull(column), ne(column, viewerId))
        : undefined,
    f.null === true ? isNull(column) : f.null === false ? isNotNull(column) : undefined,
  );
}

function labelCondition(f: LabelFilterShape) {
  return and(compare(labels.id, f.id), compare(labels.name, f.name));
}

/** Translates an IssueFilter into SQL over the `issues` table. */
export function issueWhere(
  db: HubDb,
  filter: IssueFilterShape | null | undefined,
  viewerId: string,
): SQL | undefined {
  if (!filter) return undefined;
  const parts: (SQL | undefined)[] = [
    compare(issues.id, filter.id),
    compareNumber(issues.number, filter.number),
    compare(issues.title, filter.title),
    compareNumber(issues.priority, filter.priority),
    compareNumber(issues.estimate, filter.estimate),
    compareDate(issues.dueDate, filter.dueDate),
    userCondition(issues.assigneeId, filter.assignee, viewerId),
    userCondition(issues.creatorId, filter.creator, viewerId),
  ];
  if (filter.team) {
    const cond = and(compare(teams.id, filter.team.id), compare(teams.key, filter.team.key));
    if (cond)
      parts.push(inArray(issues.teamId, db.select({ id: teams.id }).from(teams).where(cond)));
  }
  if (filter.state) {
    const cond = and(
      compare(workflowStates.id, filter.state.id),
      compare(workflowStates.name, filter.state.name),
      compare(workflowStates.type, filter.state.type),
    );
    if (cond) {
      parts.push(
        inArray(
          issues.stateId,
          db.select({ id: workflowStates.id }).from(workflowStates).where(cond),
        ),
      );
    }
  }
  if (filter.labels?.some) {
    const cond = labelCondition(filter.labels.some);
    parts.push(
      inArray(
        issues.id,
        db
          .select({ id: issueLabels.issueId })
          .from(issueLabels)
          .innerJoin(labels, eq(labels.id, issueLabels.labelId))
          .where(cond),
      ),
    );
  }
  if (filter.labels?.every) {
    const cond = labelCondition(filter.labels.every);
    parts.push(
      notInArray(
        issues.id,
        db
          .select({ id: issueLabels.issueId })
          .from(issueLabels)
          .innerJoin(labels, eq(labels.id, issueLabels.labelId))
          .where(cond ? sql`not (${cond})` : sql`0`),
      ),
    );
  }
  if (filter.parent) {
    parts.push(
      compare(issues.parentId, filter.parent.id),
      filter.parent.null === true
        ? isNull(issues.parentId)
        : filter.parent.null === false
          ? isNotNull(issues.parentId)
          : undefined,
    );
  }
  for (const [f, column] of [
    [filter.project, issues.projectId],
    [filter.projectMilestone, issues.projectMilestoneId],
  ] as const) {
    if (!f) continue;
    parts.push(
      compare(column, f.id),
      f.null === true ? isNull(column) : f.null === false ? isNotNull(column) : undefined,
    );
  }
  if (filter.cycle) {
    const f = filter.cycle;
    const at = Date.now();
    const active =
      f.isActive?.eq == null
        ? undefined
        : f.isActive.eq
          ? and(isNull(cycles.completedAt), lte(cycles.startsAt, at), gt(cycles.endsAt, at))
          : or(isNotNull(cycles.completedAt), gt(cycles.startsAt, at), lte(cycles.endsAt, at));
    const cond = and(compareNumber(cycles.number, f.number), active);
    parts.push(
      compare(issues.cycleId, f.id),
      cond
        ? inArray(issues.cycleId, db.select({ id: cycles.id }).from(cycles).where(cond))
        : undefined,
      f.null === true
        ? isNull(issues.cycleId)
        : f.null === false
          ? isNotNull(issues.cycleId)
          : undefined,
    );
  }
  if (filter.and?.length) parts.push(...filter.and.map((f) => issueWhere(db, f, viewerId)));
  if (filter.or?.length)
    parts.push(or(...filter.or.map((f) => issueWhere(db, f, viewerId) ?? sql`1`)));
  return and(...parts);
}

export const PaginationOrderBy = builder.enumType("PaginationOrderBy", {
  values: ["createdAt", "updatedAt"] as const,
});

export interface IssueQueryArgs {
  filter?: IssueFilterShape | null;
  first?: number | null;
  after?: string | null;
  orderBy?: "createdAt" | "updatedAt" | null;
  includeArchived?: boolean | null;
}

/** Issues matching a filter, newest first, with keyset pagination on (orderBy, id). */
export async function queryIssues(
  db: HubDb,
  args: IssueQueryArgs,
  viewerId: string,
  scope?: SQL,
): Promise<Page<typeof issues.$inferSelect>> {
  const column = args.orderBy === "updatedAt" ? issues.updatedAt : issues.createdAt;
  const first = pageSize(args.first);
  let cursor: SQL | undefined;
  if (args.after) {
    const [value, id] = args.after.split(":");
    if (value && id)
      cursor = or(lt(column, Number(value)), and(eq(column, Number(value)), lt(issues.id, id)));
  }
  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        scope,
        args.includeArchived ? undefined : isNull(issues.archivedAt),
        issueWhere(db, args.filter, viewerId),
        cursor,
      ),
    )
    .orderBy(desc(column), desc(issues.id))
    .limit(first + 1)
    .all();
  const nodes = rows.slice(0, first);
  const last = nodes.at(-1);
  return {
    nodes,
    pageInfo: {
      hasNextPage: rows.length > first,
      endCursor: last
        ? `${args.orderBy === "updatedAt" ? last.updatedAt : last.createdAt}:${last.id}`
        : null,
    },
  };
}

export const issueArgs = builder.args((t) => ({
  filter: t.field({ type: IssueFilter, required: false }),
  first: t.int({ required: false }),
  after: t.string({ required: false }),
  orderBy: t.field({ type: PaginationOrderBy, required: false }),
  includeArchived: t.boolean({ required: false }),
}));
