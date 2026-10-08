import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Engine, EngineResult } from "./engine.js";
import { HUB_MCP } from "./permissions.js";

const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}…` : text);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("");
  return "";
}

/** Turns SDK messages into the small transcript events the hub stores and the app shows. */
export function transcriptEvents(message: SDKMessage): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim())
        events.push({ type: "text", text: clip(block.text) });
      else if (block.type === "tool_use")
        events.push({
          type: "tool",
          id: block.id,
          name: block.name,
          input: clip(JSON.stringify(block.input), 2000),
        });
    }
  } else if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result")
        events.push({
          type: "tool_result",
          id: block.tool_use_id,
          error: block.is_error === true,
          text: clip(textOf(block.content), 2000),
        });
    }
  } else if (message.type === "result") {
    events.push({
      type: "result",
      subtype: message.subtype,
      turns: message.num_turns,
      costUsd: message.total_cost_usd,
    });
  }
  return events;
}

/** Runs a session on the Claude Agent SDK, signed in with the machine's Claude subscription. */
export const sdkEngine: Engine = async (run) => {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  run.signal.addEventListener("abort", abort);
  const options: Options = {
    systemPrompt: run.input.systemPrompt,
    model: run.model,
    ...(run.effort ? { effort: run.effort } : {}),
    // A decision answers in one go; the structured output may take a turn of its own.
    maxTurns: run.input.tools ? run.input.maxTurns : 3,
    outputFormat: { type: "json_schema", schema: run.input.outputSchema },
    abortController,
    cwd: run.cwd,
    // Agents don't read the machine owner's own Claude settings or memory.
    settingSources: [],
    ...(run.input.tools
      ? {
          mcpServers: {
            ...(run.mcpServers as Options["mcpServers"]),
            [HUB_MCP]: {
              type: "http",
              url: run.hubMcp.url,
              headers: { authorization: `Bearer ${run.hubMcp.token}` },
            },
          },
          canUseTool: async (tool, input) => {
            const decision = await run.canUseTool(tool, input);
            return decision.behavior === "allow"
              ? { behavior: "allow", updatedInput: input }
              : decision;
          },
        }
      : { tools: [] }),
    ...(run.resume ? { resume: run.resume } : {}),
  };
  const result: EngineResult = { output: null, sessionId: run.resume, usage: {} };
  try {
    for await (const message of query({ prompt: run.input.prompt, options })) {
      if (
        "session_id" in message &&
        message.session_id &&
        message.session_id !== result.sessionId
      ) {
        result.sessionId = message.session_id;
        run.onSession(message.session_id);
      }
      for (const event of transcriptEvents(message)) run.onEvent(event);
      if (message.type === "result") {
        result.usage = {
          inputTokens:
            message.usage.input_tokens +
            (message.usage.cache_read_input_tokens ?? 0) +
            (message.usage.cache_creation_input_tokens ?? 0),
          outputTokens: message.usage.output_tokens,
          numTurns: message.num_turns,
          costUsd: message.total_cost_usd,
        };
        if (message.subtype === "success") result.output = message.structured_output ?? null;
        else result.error = `The session ended early (${message.subtype.replace(/_/g, " ")})`;
      }
    }
  } catch (error) {
    if (!run.signal.aborted) result.error = error instanceof Error ? error.message : String(error);
  } finally {
    run.signal.removeEventListener("abort", abort);
  }
  return result;
};
