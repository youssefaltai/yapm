import { createYoga } from "graphql-yoga";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRoutes, relyingParty, resolveViewer } from "./auth.js";
import type { HubDeps, HubEnv } from "./context.js";
import { type GraphQLContext, schema } from "./graphql/schema.js";
import { installScript } from "./install.js";
import { createLoaders } from "./loaders.js";
import { mcpHandler } from "./mcp/index.js";
import { waitUntilOf } from "./push.js";
import { announce, CLIENT_ID_HEADER } from "./realtime.js";
import { runnerRoutes } from "./runs/routes.js";
import { clientMetadata, finishOAuth } from "./services/mcpServers.js";

/** Error messages along an error's cause chain (Drizzle wraps the driver's error). */
function messagesOf(error: unknown) {
  const messages: string[] = [];
  for (let e = error, depth = 0; e && depth < 5; depth++) {
    messages.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return messages.join("\n");
}

/**
 * Says plainly when the database is the problem, so the owner knows what to fix: it was
 * never migrated, or it is gone (e.g. a D1 database deleted while the Worker still points at it).
 */
export function databaseProblem(error: unknown): string | null {
  const text = messagesOf(error);
  if (/no such table/i.test(text))
    return "The database isn't set up: its migrations haven't been applied. Run the deploy again, or apply the migrations.";
  if (
    /D1_ERROR|D1 database|database.*(not found|does not exist|deleted)|SQLITE_CANTOPEN/i.test(text)
  )
    return "The hub can't open its database. If it was deleted, run the deploy again to create a new one.";
  return null;
}

/**
 * The hub's HTTP surface, independent of where it runs. Platform adapters
 * (Node, Cloudflare Workers) supply the database and config, and serve the web app.
 */
export function createHub(deps: HubDeps) {
  const yoga = createYoga<GraphQLContext>({
    schema,
    graphqlEndpoint: "/graphql",
    landingPage: false,
    graphiql: { title: "yapm API" },
  });

  const app = new Hono<HubEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, platform: deps.config.platform, version: deps.config.version }),
  );

  /** The one-line runner installer, pointed at this hub (see install.ts). */
  app.get("/install.sh", (c) =>
    c.body(installScript(relyingParty(c).origin), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  // Runners authenticate as machines, not members (see runs/routes.ts).
  app.use("/api/*", (c, next) =>
    c.req.path.startsWith("/api/runner/") ? next() : resolveViewer(c, next),
  );
  app.use("/graphql", resolveViewer);
  app.use("/mcp", resolveViewer);

  app.route("/api/runner", runnerRoutes);

  /** The hub as an OAuth client of MCP providers that read client ID metadata documents. */
  app.get("/api/mcp/oauth/client.json", (c) => c.json(clientMetadata(relyingParty(c).origin)));

  /** Where providers send the owner back after signing in: back to the request, or why not. */
  app.get("/api/mcp/oauth/callback", async (c) => {
    const at = deps.now?.() ?? Date.now();
    const { requestId, error } = await finishOAuth(deps, c.req.query(), at);
    if (!error) await announce(deps.realtime, { type: "change", actorId: "", clientId: null, at });
    const back = new URL(
      requestId ? `/request/${requestId}` : "/approvals",
      relyingParty(c).origin,
    );
    if (error) back.searchParams.set("error", error);
    return c.redirect(back.href);
  });

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
    const problem = databaseProblem(error);
    if (problem) return c.json({ error: problem }, 503);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}

export type Hub = ReturnType<typeof createHub>;
