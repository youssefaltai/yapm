import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { EngineRun } from "../src/engine.js";

const calls: Options[] = [];
let messages: unknown[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Options }) => {
    calls.push(options);
    return Object.assign(
      (async function* () {
        yield* messages;
      })(),
      {
        close: () => {},
        accountInfo: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { email: "owner@example.com", subscriptionType: "max" };
        },
        supportedModels: async () => [
          {
            value: "default",
            resolvedModel: "claude-opus-5-5",
            displayName: "Default (recommended)",
            supportedEffortLevels: ["low", "high"],
          },
          {
            value: "opus",
            resolvedModel: "claude-opus-5-5",
            displayName: "Opus 5.5",
            supportedEffortLevels: ["low", "high"],
          },
          { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
        ],
        mcpServerStatus: async () => [
          {
            name: "slack",
            status: "connected",
            tools: [
              { name: "slack_read_channel", annotations: { readOnly: true } },
              { name: "slack_send_message", annotations: {} },
            ],
          },
        ],
      },
    );
  },
}));

const { claudeModels, sdkEngine, transcriptEvents } = await import("../src/sdk.js");

describe("Claude's models", () => {
  it("lists each model once by its id, with the efforts it supports", async () => {
    expect(await claudeModels()).toEqual({
      id: "anthropic",
      name: "Claude",
      models: [
        { id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "high"] },
        { id: "claude-haiku-4-5", name: "Haiku 4.5", efforts: [] },
      ],
    });
  });
});

const run = (extra: Partial<EngineRun> = {}) =>
  ({
    input: { systemPrompt: "", prompt: "", outputSchema: {}, tools: true, maxTurns: 5 },
    model: "claude-haiku-5-5",
    hubMcp: { url: "http://localhost/mcp", token: "los_test" },
    resume: null,
    cwd: "/tmp",
    signal: new AbortController().signal,
    canUseTool: async () => ({ behavior: "allow" }),
    onEvent: () => {},
    onSession: () => {},
    ...extra,
  }) as EngineRun;

describe("sdk engine", () => {
  it("gives agents the machine's own MCP servers next to the hub's", async () => {
    calls.length = 0;
    await sdkEngine(
      run({
        mcpServers: {
          github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
          yapm: { type: "http", url: "https://elsewhere.example/mcp" },
        },
      }),
    );
    const servers = calls[0]?.mcpServers as Record<string, { url: string }>;
    expect(servers.github?.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(servers["yapm"]?.url).toBe("http://localhost/mcp");
  });

  it("reports the model the session ran on and the effort it asked for", async () => {
    messages = [{ type: "system", subtype: "init", model: "claude-opus-5-5" }];
    const ran = await sdkEngine(run({ effort: "high" }));
    const unset = await sdkEngine(run());
    messages = [];
    expect(ran).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(unset.effort).toBeNull();
  });

  it("puts a session's rate-limit events down to its login, read first", async () => {
    messages = [
      { type: "system", subtype: "init", model: "claude-opus-5-5" },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    ];
    const updates: string[] = [];
    await sdkEngine(run({ onPlan: (update) => updates.push(Object.keys(update)[0] ?? "") }));
    messages = [];
    await vi.waitFor(() => expect(updates).toEqual(["account", "rateLimit"]));
  });

  it("keeps the owner's claude.ai connectors out of agent sessions", async () => {
    calls.length = 0;
    await sdkEngine(run());
    expect(calls[0]?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(calls[0]?.env?.PATH).toBe(process.env.PATH);
  });

  it("runs agents on the machine's API key when one is saved", async () => {
    calls.length = 0;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-abc");
    await sdkEngine(run());
    vi.unstubAllEnvs();
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBe("sk-ant-api03-abc");
  });

  it("logs the tools a ToolSearch found, which come as references rather than text", () => {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "tool_reference", tool_name: "mcp__yapm__get_issue" },
              { type: "tool_reference", tool_name: "mcp__yapm__create_comment" },
            ],
          },
        ],
      },
    } as unknown as Parameters<typeof transcriptEvents>[0];
    expect(transcriptEvents(message)).toEqual([
      {
        type: "tool_result",
        id: "toolu_1",
        error: false,
        text: "mcp__yapm__get_issue, mcp__yapm__create_comment",
      },
    ]);
  });

  it("tells which MCP tools only read, from their annotations", async () => {
    calls.length = 0;
    const seen: [string, boolean | undefined][] = [];
    await sdkEngine(
      run({
        canUseTool: async (tool, _input, readOnly) => {
          seen.push([tool, readOnly]);
          return { behavior: "allow" };
        },
      }),
    );
    const canUseTool = calls[0]?.canUseTool;
    const options = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
    await canUseTool?.("mcp__slack__slack_read_channel", {}, options);
    await canUseTool?.("mcp__slack__slack_send_message", {}, options);
    await canUseTool?.("Bash", { command: "ls" }, options);
    expect(seen).toEqual([
      ["mcp__slack__slack_read_channel", true],
      ["mcp__slack__slack_send_message", false],
      ["Bash", false],
    ]);
  });
});
