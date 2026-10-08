import { createYoga } from "graphql-yoga";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRoutes, resolveViewer } from "./auth.js";
import type { HubDeps, HubEnv } from "./context.js";
import { type GraphQLContext, schema } from "./graphql/schema.js";

/**
 * The hub's HTTP surface, independent of where it runs. Platform adapters
 * (Node, Cloudflare Workers) supply the database and config, and serve the web app.
 */
export function createHub(deps: HubDeps) {
  const yoga = createYoga<GraphQLContext>({
    schema,
    graphqlEndpoint: "/graphql",
    landingPage: false,
    graphiql: { title: "Life OS API" },
  });

  const app = new Hono<HubEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, platform: deps.config.platform, version: deps.config.version }),
  );

  app.use("/api/*", resolveViewer);
  app.use("/graphql", resolveViewer);

  app.route("/api", authRoutes);

  app.on(["GET", "POST"], "/graphql", (c) => yoga.fetch(c.req.raw, { deps, viewer: c.var.viewer }));

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}

export type Hub = ReturnType<typeof createHub>;
