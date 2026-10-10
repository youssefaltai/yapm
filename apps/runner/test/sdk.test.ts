import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { EngineRun } from "../src/engine.js";

const calls: Options[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Options }) => {
    calls.push(options);
    return (async function* () {})();
  },
}));

const { sdkEngine } = await import("../src/sdk.js");

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

  it("keeps the owner's claude.ai connectors out of agent sessions", async () => {
    calls.length = 0;
    await sdkEngine(run());
    expect(calls[0]?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(calls[0]?.env?.PATH).toBe(process.env.PATH);
  });
});
