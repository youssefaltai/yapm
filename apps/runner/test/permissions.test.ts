import { describe, expect, it } from "vitest";
import { describeRequest } from "../src/permissions.js";

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
});
