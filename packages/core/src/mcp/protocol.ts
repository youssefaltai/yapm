// A small, stateless MCP server over Streamable HTTP: each POST carries one JSON-RPC message
// and gets a JSON answer. No sessions or server-sent streams, so it runs the same on Node and
// on Workers within the free plan's CPU budget.

import { ServiceError } from "../errors.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Tool<Ctx> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Read-only tools are marked so clients can auto-approve them. */
  readOnly?: boolean;
  run(args: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}

/** A tool failure the model should see and can correct, rather than a protocol error. */
export class ToolError extends Error {}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export interface ServerInfo {
  name: string;
  version: string;
  instructions: string;
}

function checkArgs(schema: JsonSchema, args: Record<string, unknown>) {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      throw new ToolError(`Missing required argument: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key] as
      | { type?: string | string[]; enum?: unknown[]; maxItems?: number }
      | undefined;
    if (!spec) throw new ToolError(`Unknown argument: ${key}`);
    if (!spec.type) continue;
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    const actual =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) throw new ToolError(`Argument ${key} must be ${types.join(" or ")}`);
    if (value !== null && spec.enum && !spec.enum.includes(value))
      throw new ToolError(`Argument ${key} must be one of ${spec.enum.join(", ")}`);
    if (Array.isArray(value) && value.length > (spec.maxItems ?? Infinity))
      throw new ToolError(`Argument ${key} takes at most ${spec.maxItems} items`);
  }
}

/** Handles one JSON-RPC message. Returns null for notifications, which get no answer. */
export async function handleMessage<Ctx>(
  message: JsonRpcRequest,
  tools: Tool<Ctx>[],
  info: ServerInfo,
  ctx: Ctx,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || !message || Array.isArray(message) || !message.method)
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const id = message.id ?? null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: msg },
  });
  if (message.id === undefined) return null;

  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.find((v) => v === requested) ?? PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { title: tool.title, readOnlyHint: tool.readOnly ?? false },
        })),
      });
    case "tools/call": {
      const name = message.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        checkArgs(tool.inputSchema, args);
        const result = await tool.run(args, ctx);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        if (error instanceof ToolError || error instanceof ServiceError) {
          return ok({ content: [{ type: "text", text: error.message }], isError: true });
        }
        throw error;
      }
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}
