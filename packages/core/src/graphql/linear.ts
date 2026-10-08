import { fetchLinear, importLinear } from "../services/linear.js";
import { act, builder, requireOwner } from "./builder.js";

const LinearImportPayload = builder
  .objectRef<{
    teams: number;
    labels: number;
    projects: number;
    issues: number;
    comments: number;
  }>("LinearImportPayload")
  .implement({
    description: "What came over from Linear.",
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      teams: t.exposeInt("teams"),
      labels: t.exposeInt("labels"),
      projects: t.exposeInt("projects"),
      issues: t.exposeInt("issues"),
      comments: t.exposeInt("comments"),
    }),
  });

builder.mutationField("linearImport", (t) =>
  t.field({
    type: LinearImportPayload,
    description:
      "Moves a Linear workspace in: teams (keeping their keys), workflows, labels, projects, issues (keeping their numbers) and comments. Owner only; the key is used once and not kept.",
    args: { apiKey: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      requireOwner(ctx);
      return act(ctx, async (s) =>
        importLinear(s, await fetchLinear(args.apiKey, ctx.deps.fetch ?? fetch)),
      );
    },
  }),
);
