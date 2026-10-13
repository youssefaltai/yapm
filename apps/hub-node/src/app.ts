import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHub, type HubDeps } from "@yapm/core";

/** The hub plus, when a built web app is available, the single-page app with history fallback. */
export function createNodeApp(deps: HubDeps, webDir?: string) {
  const app = createHub(deps);
  if (webDir && existsSync(join(webDir, "index.html"))) {
    const index = readFileSync(join(webDir, "index.html"), "utf8");
    app.use("/*", serveStatic({ root: relative(process.cwd(), webDir) }));
    app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(index)));
  }
  return app;
}

/** Settings the Docker setup can leave empty, which the hub runs without but shouldn't. */
export function configWarnings(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  if (!env.YAPM_SECRET)
    warnings.push("YAPM_SECRET is not set: saving MCP server sign-ins will fail.");
  if (!env.ORIGIN)
    warnings.push("ORIGIN is not set: the hub trusts request headers for its origin.");
  return warnings;
}
