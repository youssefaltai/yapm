import SchemaBuilder, { type ObjectRef } from "@pothos/core";
import { createGraphQLError } from "graphql-yoga";
import type { HubDeps, Viewer } from "../context.js";
import { ServiceError } from "../errors.js";
import type { Loaders } from "../loaders.js";
import type { Ctx } from "../services/common.js";

export interface GraphQLContext {
  deps: HubDeps;
  viewer: Viewer | null;
  loaders: Loaders;
  /** The calling tab or runner, echoed in live-update events. */
  clientId?: string | null;
}

interface GraphQLTypes {
  Context: GraphQLContext;
  Scalars: {
    DateTime: { Input: Date; Output: Date | number };
    TimelessDate: { Input: string; Output: string };
    JSONObject: { Input: Record<string, unknown>; Output: Record<string, unknown> };
  };
}

export const builder = new SchemaBuilder<GraphQLTypes>({});

export type Types = PothosSchemaTypes.ExtendDefaultTypes<GraphQLTypes>;

builder.scalarType("DateTime", {
  description: "ISO-8601 timestamp.",
  serialize: (value) => new Date(value).toISOString(),
  parseValue: (value) => new Date(String(value)),
});

builder.scalarType("TimelessDate", {
  description: "A date without a time, e.g. 2026-10-31.",
  serialize: (value) => value,
  parseValue: (value) => String(value),
});

builder.scalarType("JSONObject", {
  serialize: (value) => value,
  parseValue: (value) => value as Record<string, unknown>,
});

export function requireViewer(ctx: GraphQLContext): Viewer {
  if (!ctx.viewer) {
    throw createGraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return ctx.viewer;
}

export function requireOwner(ctx: GraphQLContext): Viewer {
  const viewer = requireViewer(ctx);
  if (viewer.user.kind !== "owner") {
    throw createGraphQLError("Only the owner can do this", { extensions: { code: "FORBIDDEN" } });
  }
  return viewer;
}

export function db(ctx: GraphQLContext) {
  return ctx.deps.db;
}

export function now(ctx: GraphQLContext): number {
  return ctx.deps.now?.() ?? Date.now();
}

/** Runs a service call as the viewer, turning rejections into GraphQL errors with codes. */
export async function act<T>(ctx: GraphQLContext, fn: (service: Ctx) => Promise<T>): Promise<T> {
  const viewer = requireViewer(ctx);
  try {
    const at = now(ctx);
    const result = await fn({ db: ctx.deps.db, actorId: viewer.user.id, now: at });
    await announce(ctx, viewer.user.id, at);
    return result;
  } catch (error) {
    if (error instanceof ServiceError) {
      throw createGraphQLError(error.message, { extensions: { code: error.code } });
    }
    throw error;
  }
}

/** Tells live clients something changed. A failed broadcast never fails the mutation. */
async function announce(ctx: GraphQLContext, actorId: string, at: number) {
  try {
    await ctx.deps.realtime?.publish({
      type: "change",
      actorId,
      clientId: ctx.clientId ?? null,
      at,
    });
  } catch (error) {
    console.error("Live update failed", error);
  }
}

export function notFoundError(what: string) {
  return createGraphQLError(`${what} not found`, { extensions: { code: "NOT_FOUND" } });
}

// Linear-style connections: `{ nodes, pageInfo }` with `first`/`after` arguments.
export const PageInfo = builder
  .objectRef<{ hasNextPage: boolean; endCursor: string | null }>("PageInfo")
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });

export type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export function connection<T>(name: string, node: ObjectRef<Types, T>) {
  return builder.objectRef<Page<T>>(`${name}Connection`).implement({
    fields: (t) => ({
      nodes: t.field({ type: [node], resolve: (page) => page.nodes }),
      pageInfo: t.field({ type: PageInfo, resolve: (page) => page.pageInfo }),
    }),
  });
}

export function pageSize(first: number | null | undefined, fallback = 50): number {
  return Math.min(Math.max(first ?? fallback, 1), 250);
}

/** Pages a small, already ordered list in memory. Large lists (issues) page in SQL instead. */
export function paginate<T extends { id: string }>(
  rows: T[],
  args: { first?: number | null; after?: string | null },
): Page<T> {
  const start = args.after ? rows.findIndex((row) => row.id === args.after) + 1 : 0;
  const first = pageSize(args.first);
  const nodes = rows.slice(start, start + first);
  return {
    nodes,
    pageInfo: { hasNextPage: start + first < rows.length, endCursor: nodes.at(-1)?.id ?? null },
  };
}

export const pageArgs = builder.args((t) => ({
  first: t.int({ required: false }),
  after: t.string({ required: false }),
}));
