import { createYoga } from "graphql-yoga";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRoutes, relyingParty, resolveViewer } from "./auth.js";
import type { HubDeps, HubEnv } from "./context.js";
import { type GraphQLContext, schema } from "./graphql/schema.js";
import { createLoaders } from "./loaders.js";
import { mcpHandler } from "./mcp/index.js";
import { waitUntilOf } from "./push.js";
import { CLIENT_ID_HEADER } from "./realtime.js";
import { runnerRoutes } from "./runs/routes.js";

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

  // Runners authenticate as machines, not members (see runs/routes.ts).
  app.use("/api/*", (c, next) =>
    c.req.path.startsWith("/api/runner/") ? next() : resolveViewer(c, next),
  );
  app.use("/graphql", resolveViewer);
  app.use("/mcp", resolveViewer);

  app.route("/api/runner", runnerRoutes);
  app.route("/api", authRoutes);

  /** Live updates: a WebSocket that says "something changed" after every mutation. */
  app.get("/api/live", (c) => {
    const viewer = c.var.viewer;
    if (!viewer) throw new HTTPException(401, { message: "Not signed in" });
    // Browsers send cookies on WebSocket handshakes, so check the origin like any cookie write.
    const origin = c.req.header("origin");
    if (viewer.via === "session" && origin && origin !== relyingParty(c).origin) {
      throw new HTTPException(403, { message: "Cross-origin request refused" });
    }
    if (!deps.realtime) throw new HTTPException(501, { message: "Live updates are not available" });
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new HTTPException(426, { message: "Expected a WebSocket upgrade" });
    }
    return deps.realtime.connect(c);
  });

  app.on(["GET", "POST"], "/graphql", (c) =>
    yoga.fetch(c.req.raw, {
      deps,
      viewer: c.var.viewer,
      loaders: createLoaders(deps.db),
      clientId: c.req.header(CLIENT_ID_HEADER) ?? null,
      origin: relyingParty(c).origin,
      waitUntil: waitUntilOf(c),
    }),
  );

  /** MCP over Streamable HTTP, stateless: tools named after Linear's MCP server. */
  app.post("/mcp", mcpHandler);
  app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { Allow: "POST" }));

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
