import { describe, expect, it } from "vitest";
import { badRequest } from "../src/errors.js";
import { handleMessage, type Tool, ToolError } from "../src/mcp/protocol.js";

const info = { name: "test", version: "0", instructions: "" };
const failing = (error: Error): Tool<null> => ({
  name: "fail",
  title: "Fail",
  description: "",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    throw error;
  },
});
const call = (tool: Tool<null>) =>
  handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name } },
    [tool],
    info,
    null,
  );

describe("tools/call", () => {
  it("shows the agent a ToolError's message", async () => {
    expect(await call(failing(new ToolError("Try another name")))).toMatchObject({
      result: { content: [{ text: "Try another name" }], isError: true },
    });
  });

  it("shows the agent a service rejection's message", async () => {
    expect(await call(failing(badRequest("That name is taken")))).toMatchObject({
      result: { content: [{ text: "That name is taken" }], isError: true },
    });
  });

  it("keeps other errors, like SQL, from the agent", async () => {
    const sql = Object.assign(new Error("SQLITE_CONSTRAINT: UNIQUE failed: users.email"), {
      code: "SQLITE_CONSTRAINT",
    });
    await expect(call(failing(sql))).rejects.toBe(sql);
  });
});
