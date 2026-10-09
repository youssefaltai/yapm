import {
  type Options,
  type Query,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Engine, EngineResult, PlanProbe } from "./engine.js";
import { HUB_MCP } from "./permissions.js";
import { accountFrom, type PlanUpdate, usageFrom } from "./plan.js";

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
  const session = query({ prompt: run.input.prompt, options });
  let accountRead = false;
  try {
    for await (const message of session) {
      if (run.onPlan && !accountRead && message.type === "system") {
        accountRead = true;
        const onPlan = run.onPlan;
        void readAccount(session).then((update) => update && onPlan(update));
      }
      if (message.type === "rate_limit_event") run.onPlan?.({ rateLimit: message.rate_limit_info });
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
        result.usage = sessionUsage(message);
        // The session is still open here, so it can answer /usage without a model call.
        if (run.readUsage && run.onPlan) {
          const reading = await readUsage(session);
          if (reading) run.onPlan(reading);
        }
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

/**
 * Token totals across every model the session used, subagents included; the result's own
 * `usage` counts only the main loop.
 */
export function sessionUsage(message: SDKResultMessage) {
  const models = Object.values(message.modelUsage ?? {});
  const tokens = models.length
    ? {
        inputTokens: models.reduce(
          (sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens,
          0,
        ),
        outputTokens: models.reduce((sum, m) => sum + m.outputTokens, 0),
      }
    : {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      };
  return { ...tokens, numTurns: message.num_turns, costUsd: message.total_cost_usd };
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Claude Code didn't answer")), ms).unref?.(),
    ),
  ]);

async function readAccount(session: Query): Promise<PlanUpdate | null> {
  try {
    return { account: accountFrom(await within(session.accountInfo(), 10_000)) };
  } catch {
    return null;
  }
}

/**
 * Claude Code's /usage: how full each of the plan's windows is and when it resets. The SDK
 * marks this call experimental, so any failure just means no reading this time.
 */
async function readUsage(session: Query): Promise<PlanUpdate | null> {
  const read = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof read !== "function") return null;
  try {
    const response = await within(read.call(session, { skipBehaviors: true }), 15_000);
    return { usage: usageFrom(response, Date.now()) };
  } catch {
    return null;
  }
}

/**
 * Opens Claude Code without a prompt, reads the login and /usage, and closes it. No model is
 * called, so it costs nothing against the plan.
 */
export const probePlan: PlanProbe = async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A prompt stream that never sends anything keeps the session open for control requests.
  const silence: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => held.then(() => ({ done: true as const, value: undefined })),
    }),
  };
  const session = query({
    prompt: silence,
    options: { settingSources: [], tools: [], persistSession: false },
  });
  try {
    const [account, usage] = await Promise.all([readAccount(session), readUsage(session)]);
    return [account, usage].filter((u): u is PlanUpdate => u !== null);
  } finally {
    release();
    session.close();
  }
};
