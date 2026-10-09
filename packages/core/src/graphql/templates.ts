import { templates } from "@life-os/schema";
import { asc, eq } from "drizzle-orm";
import {
  createTemplate,
  deleteTemplate,
  requireTemplate,
  updateTemplate,
} from "../services/templates.js";
import { describeSchedule, type ScheduleShape } from "../time.js";
import { act, builder, db, requireViewer } from "./builder.js";
import { DeletePayload, payload } from "./mutations.js";
import { Team, User } from "./types.js";

type TemplateRow = typeof templates.$inferSelect;

const Schedule = builder.objectRef<ScheduleShape>("Schedule").implement({
  description: "When something repeats, in the company's time zone.",
  fields: (t) => ({
    frequency: t.exposeString("frequency", {
      description: "daily, weekdays, weekly or monthly.",
    }),
    time: t.exposeString("time", { description: "Local time, HH:MM." }),
    weekday: t.int({ nullable: true, resolve: (s) => s.weekday ?? null }),
    monthDay: t.int({ nullable: true, resolve: (s) => s.monthDay ?? null }),
    description: t.string({ resolve: (s) => describeSchedule(s) }),
  }),
});

const ScheduleInput = builder.inputType("ScheduleInput", {
  fields: (t) => ({
    frequency: t.string({ required: true, description: "daily, weekdays, weekly or monthly." }),
    time: t.string({ required: true, description: "Local time, HH:MM." }),
    weekday: t.int({ required: false, description: "For weekly: 0 Sunday … 6 Saturday." }),
    monthDay: t.int({ required: false, description: "For monthly: 1–31." }),
  }),
});

export const Template = builder.objectRef<TemplateRow>("Template");

Template.implement({
  description: "An issue template. With a schedule it creates a recurring issue.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    type: t.exposeString("type"),
    templateData: t.field({
      type: "JSONObject",
      description: "Issue fields: title, description, priority, estimate, assigneeId, labelIds…",
      resolve: (tpl) => tpl.templateData,
    }),
    schedule: t.field({ type: Schedule, nullable: true, resolve: (tpl) => tpl.schedule }),
    nextRunAt: t.field({ type: "DateTime", nullable: true, resolve: (tpl) => tpl.nextRunAt }),
    lastRunAt: t.field({ type: "DateTime", nullable: true, resolve: (tpl) => tpl.lastRunAt }),
    createdAt: t.field({ type: "DateTime", resolve: (tpl) => tpl.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (tpl) => tpl.updatedAt }),
    team: t.field({
      type: Team,
      nullable: true,
      resolve: (tpl, _a, ctx) => ctx.loaders.team.load(tpl.teamId),
    }),
    creator: t.field({
      type: User,
      nullable: true,
      resolve: (tpl, _a, ctx) => (tpl.creatorId ? ctx.loaders.user.load(tpl.creatorId) : null),
    }),
  }),
});

builder.objectField(Team, "templates", (t) =>
  t.field({
    type: [Template],
    resolve: (team, _args, ctx) =>
      db(ctx)
        .select()
        .from(templates)
        .where(eq(templates.teamId, team.id))
        .orderBy(asc(templates.name))
        .all(),
  }),
);

builder.queryFields((t) => ({
  templates: t.field({
    type: [Template],
    description: "Every issue template.",
    resolve: (_root, _args, ctx) => {
      requireViewer(ctx);
      return db(ctx).select().from(templates).orderBy(asc(templates.name)).all();
    },
  }),
}));

const TemplatePayload = payload("TemplatePayload", "template", Template);

const TemplateCreateInput = builder.inputType("TemplateCreateInput", {
  fields: (t) => ({
    name: t.string({ required: false, description: "Defaults to the issue title." }),
    description: t.string({ required: false }),
    type: t.string({ required: false, description: "Only issue templates for now." }),
    teamId: t.string({ required: true }),
    templateData: t.field({ type: "JSONObject", required: true }),
    schedule: t.field({
      type: ScheduleInput,
      required: false,
      description: "Makes it a recurring issue.",
    }),
  }),
});

const TemplateUpdateInput = builder.inputType("TemplateUpdateInput", {
  fields: (t) => ({
    name: t.string({ required: false }),
    description: t.string({ required: false }),
    templateData: t.field({ type: "JSONObject", required: false }),
    schedule: t.field({ type: ScheduleInput, required: false, description: "Null stops it." }),
  }),
});

builder.mutationFields((t) => ({
  templateCreate: t.field({
    type: TemplatePayload,
    args: { input: t.arg({ type: TemplateCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createTemplate(s, args.input));
      return { entity: await requireTemplate(db(ctx), id) };
    },
  }),
  templateUpdate: t.field({
    type: TemplatePayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: TemplateUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateTemplate(s, args.id, args.input));
      return { entity: await requireTemplate(db(ctx), id) };
    },
  }),
  templateDelete: t.field({
    type: DeletePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await act(ctx, (s) => deleteTemplate(s, args.id));
      return { entityId: args.id };
    },
  }),
}));
