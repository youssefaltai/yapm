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

describe("sdk engine", () => {
  it("keeps the owner's claude.ai connectors out of agent sessions", async () => {
    await sdkEngine({
      input: { systemPrompt: "", prompt: "", outputSchema: {}, tools: true, maxTurns: 5 },
      model: "claude-haiku-5-5",
      hubMcp: { url: "http://localhost/mcp", token: "los_test" },
      resume: null,
      cwd: "/tmp",
      signal: new AbortController().signal,
      canUseTool: async () => ({ behavior: "allow" }),
      onEvent: () => {},
      onSession: () => {},
    } as EngineRun);
    expect(calls[0]?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(calls[0]?.env?.PATH).toBe(process.env.PATH);
  });
});
