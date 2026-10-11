import { describe, expect, it } from "vitest";
import type { HubClient } from "../src/hub.js";
import { decideTool, describeRequest } from "../src/permissions.js";

describe("permission request titles", () => {
  it("puts a short command in the title and the description as the reason", () => {
    expect(describeRequest("Coach", "Bash", "ls", "See my files", "PF-1")).toEqual({
      title: "Coach wants to use Bash: ls",
      reason: "See my files",
    });
  });

  it("names a long command by its description, not a cut-off command", () => {
    const command = `cat ~/.claude/plugins/marketplaces/cloudflare/.mcp.json | python3 -I -c 'import json,sys;print(json.load(sys.stdin))'`;
    const { title, reason } = describeRequest(
      "CEO",
      "Bash",
      command,
      "Read the MCP config",
      "TES-2",
    );
    expect(title).toBe("CEO wants to use Bash: Read the MCP config");
    expect(reason).toContain("TES-2");
  });

  it("clips a long command with an ellipsis when there is no description", () => {
    const { title } = describeRequest("CEO", "Bash", `echo ${"x".repeat(100)}`, "", null);
    expect(title).toMatch(/^CEO wants to use Bash: echo x+…$/);
    expect(title.length).toBeLessThan(90);
  });

  it("names an MCP tool by its server and the tool, not its arguments", () => {
    expect(describeRequest("CEO", "mcp__slack__slack_read_channel", null, "", null).title).toBe(
      "CEO wants to use Slack: read_channel",
    );
    expect(
      describeRequest("CEO", "mcp__linear__create_issue", null, "Fix the tap", null).title,
    ).toBe("CEO wants to use Linear: create_issue");
  });
});

describe("deciding a tool call", () => {
  it("asks for a read-only tool with the readOnly marker as its resource", async () => {
    const asked: Record<string, unknown>[] = [];
    const hub = {
      graphql: async (_token: string, _query: string, variables: Record<string, unknown>) => {
        asked.push(variables);
        return { permissionUse: { allowed: true, pendingRequestId: null } };
      },
    } as unknown as HubClient;
    const ctx = {
      hub,
      token: "t",
      agent: "CEO",
      issueId: null,
      issue: null,
      pollMs: 1,
      signal: new AbortController().signal,
      onEvent: () => {},
    };
    await decideTool(ctx, "mcp__slack__slack_read_channel", {}, true);
    await decideTool(ctx, "mcp__slack__slack_send_message", {});
    expect(asked).toEqual([
      { action: "tool:slack__slack_read_channel", resource: "readOnly" },
      { action: "tool:slack__slack_send_message", resource: null },
    ]);
  });

  it("lets plain read-only commands run unasked, as the Claude SDK does, and asks for the rest", async () => {
    const asked: unknown[] = [];
    const hub = {
      graphql: async (_token: string, _query: string, variables: unknown) => {
        asked.push(variables);
        return { permissionUse: { allowed: true, pendingRequestId: null } };
      },
    } as unknown as HubClient;
    const ctx = {
      hub,
      token: "t",
      agent: "CEO",
      issueId: null,
      issue: null,
      pollMs: 1,
      signal: new AbortController().signal,
      onEvent: () => {},
    };
    for (const command of ["ls", "ls -la src", "date", "pwd", "cat a.txt", "wc -l a.txt"])
      expect(await decideTool(ctx, "Bash", { command })).toEqual({ behavior: "allow" });
    expect(asked).toEqual([]);
    for (const command of [
      "touch x",
      "ls > x",
      "ls; rm x",
      "cat $(rm x)",
      "ls && rm x",
      "ls\nrm x",
    ])
      await decideTool(ctx, "Bash", { command });
    expect(asked).toHaveLength(6);
  });
});
