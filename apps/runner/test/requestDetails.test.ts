import { describe, expect, it } from "vitest";
import { requestDetails } from "../src/permissions.js";

describe("permission request details", () => {
  it("shows a Bash command as itself, unescaped, in a shell block", () => {
    const command = `python3 -c 'print("hi")'`;
    expect(requestDetails("Bash", { command, description: "Say hi" })).toBe(
      "```sh\npython3 -c 'print(\"hi\")'\n```",
    );
  });

  it("fences a command with backticks so they can't close the block", () => {
    expect(requestDetails("Bash", { command: "echo ```" })).toBe("````sh\necho ```\n````");
  });

  it("shows other tools' input as JSON", () => {
    expect(requestDetails("WebFetch", { url: "https://example.com" })).toBe(
      '```json\n{\n  "url": "https://example.com"\n}\n```',
    );
  });
});
