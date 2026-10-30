import { describe, expect, it } from "vitest";
import { apiKeyLooksRight, claudeReady } from "../src/claude.js";

describe("Claude setup", () => {
  it("takes only what looks like an Anthropic API key", () => {
    expect(apiKeyLooksRight("sk-ant-api03-abc")).toBe(true);
    expect(apiKeyLooksRight("sk-proj-abc")).toBe(false);
    expect(apiKeyLooksRight("")).toBe(false);
  });

  it("counts a saved API key as ready without a Claude sign-in", () => {
    expect(claudeReady("sk-ant-api03-abc", "/nonexistent/claude")).toBe(true);
    expect(claudeReady(undefined, "/nonexistent/claude")).toBe(false);
  });
});
