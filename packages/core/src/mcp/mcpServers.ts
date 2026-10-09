import { createMcpServer } from "../services/mcpServers.js";
import type { Tool } from "./protocol.js";
import { type McpContext, requestSummary, requireIssue, str } from "./tools.js";

// Outside MCP servers: agents ask for the tools they need; the owner connects and approves.

export const mcpServerTools: Tool<McpContext>[] = [
  {
    name: "create_mcp_server",
    title: "Connect an MCP server",
    description:
      "Ask to connect an outside service's MCP server so you can use its tools. First research its official remote MCP URL (preferred) or its official package and command, e.g. with WebSearch and WebFetch; don't guess. The hub works out how a url signs in. Ask for the fewest OAuth scopes the work needs. In howToConnect, tell the owner what to set up at the provider: where to create a token and its scopes, or, when the provider needs the owner's own OAuth app, how to create it (e.g. Slack: create an app at api.slack.com/apps, add the redirect URL and the user token scopes, turn on Agents & AI Apps → Model Context Protocol, copy the Client ID and Secret). The hub adds the exact redirect URL itself. This files a request: the owner connects the server and approves. Finish with needs_input while you wait; its tools appear as mcp__<name>__<tool> in your next run. If the name is taken, this asks to use that server.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short and plain, e.g. notion or slack-acme" },
        url: { type: "string", description: "The remote server's MCP endpoint (https)" },
        command: { type: "string", description: "Or the command that starts it, e.g. npx" },
        args: { type: "array", items: { type: "string" }, description: "The command's arguments" },
        auth: {
          type: "string",
          enum: ["none", "oauth", "token"],
          description: "Leave it out for a url: the hub finds out",
        },
        secretEnv: {
          type: "string",
          description: "For a command: the env var its token goes in, e.g. GITHUB_TOKEN",
        },
        howToConnect: {
          type: "string",
          description: "Markdown for the owner: where to get the token and which scopes",
        },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "OAuth scopes you need, as few as will do; defaults to the server's",
        },
        reason: { type: "string", description: "What you need it for" },
        issue: { type: "string", description: "The issue you are working on, e.g. PF-3" },
      },
      required: ["name", "reason"],
    },
    async run(args, c) {
      const issue = str(args.issue) ? await requireIssue(c, String(args.issue)) : null;
      const { requestId } = await c.act((s) =>
        createMcpServer(
          s,
          c.deps,
          {
            name: String(args.name),
            url: str(args.url) ?? null,
            command: str(args.command) ?? null,
            args: Array.isArray(args.args) ? args.args.map(String) : null,
            auth: (str(args.auth) as "none" | "oauth" | "token" | undefined) ?? null,
            secretEnv: str(args.secretEnv) ?? null,
            howToConnect: str(args.howToConnect) ?? null,
            scopes: Array.isArray(args.scopes) ? args.scopes.map(String) : null,
            reason: String(args.reason),
            issueId: issue?.id ?? null,
          },
          c.appUrl,
        ),
      );
      if (!requestId)
        return {
          message: `${String(args.name).trim().toLowerCase()} is already yours: its tools come with your runs.`,
        };
      return requestSummary(c, requestId);
    },
  },
];
