import { describe, expect, it } from "vitest";
import { authChoice, CHOICE, keySignIn, loginChoice, oauthSignIn } from "../src/providers.js";

// OpenCode's server, as the SDK's client answers; each test records what was asked of it.
function fakeClient(options: { callback?: () => Promise<unknown> } = {}) {
  const calls: Record<string, unknown[]> = {};
  const log =
    (name: string, answer: () => unknown = () => true) =>
    async (args?: unknown) => {
      calls[name] = [...(calls[name] ?? []), args];
      return { data: answer() };
    };
  const model = (id: string, release_date: string, output = 0) => ({
    id,
    release_date,
    status: "active",
    capabilities: { toolcall: true },
    cost: { input: 0, output },
  });
  const client = {
    provider: {
      auth: log("auth", () => ({
        openai: [
          { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
          { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
          { type: "api", label: "Manually enter API Key" },
        ],
        "github-copilot": [{ type: "oauth", label: "Login with GitHub Copilot" }],
      })),
      list: log("list", () => ({
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-6.1-sol": model("gpt-6.1-sol", "2026-09-29"),
              "gpt-6.1-sol-fast": model("gpt-6.1-sol-fast", "2026-09-29"),
              "gpt-6-luna": model("gpt-6-luna", "2026-09-22"),
              "gpt-6-sol": model("gpt-6-sol", "2026-09-22"),
              "gpt-6-astra": model("gpt-6-astra", "2026-09-04"),
            },
          },
          { id: "deepseek", name: "DeepSeek", models: {} },
          { id: "openrouter", name: "OpenRouter", models: {} },
          { id: "moonshotai", name: "Moonshot AI", models: {} },
          { id: "moonshotai-cn", name: "Moonshot AI (China)", models: {} },
        ],
      })),
      oauth: {
        authorize: log("authorize", () => ({
          url: "https://github.com/login/device",
          method: "auto",
          instructions: "Enter code: 283C-18C1",
        })),
        callback: async (args: unknown) => {
          calls.callback = [...(calls.callback ?? []), args];
          return options.callback ? options.callback() : { data: true };
        },
      },
    },
    auth: { set: log("set") },
  };
  // Only what setup uses.
  return { client: client as never, calls, model };
}

function io(answers: string[] = []) {
  const said: string[] = [];
  const asked: { question: string; hidden: boolean }[] = [];
  return {
    said,
    asked,
    say: (line: string) => said.push(line),
    ask: async (question: string, hidden = false) => {
      asked.push({ question, hidden });
      return answers.shift() ?? "";
    },
  };
}

describe("choosing the AI", () => {
  it("asks which AI by provider, and says whose plan pays", () => {
    expect(CHOICE).toContain("Which AI should agents on this machine use?");
    expect(CHOICE).toMatch(/1\) Claude subscription/);
    expect(CHOICE).toMatch(/3\) ChatGPT plan/);
    expect(CHOICE).toMatch(/4\) GitHub Copilot/);
    expect(CHOICE).toContain("usage counts against it");
    expect(CHOICE).not.toMatch(/OpenCode|Agent SDK/);
  });

  it("reads the owner's answer", () => {
    expect(authChoice("1")).toBe("account");
    expect(authChoice(" 2\n")).toBe("key");
    expect(authChoice("3")).toBe("chatgpt");
    expect(authChoice("4")).toBe("copilot");
    expect(authChoice("5")).toBe("provider");
    expect(authChoice("6")).toBeNull();
    expect(authChoice("")).toBeNull();
  });

  it("reads the choice from flags; an API key alone is Anthropic's", () => {
    expect(loginChoice({})).toBeNull();
    expect(loginChoice({ claude: true })).toBe("account");
    expect(loginChoice({ "api-key": "sk-ant-x" })).toBe("key");
    expect(loginChoice({ chatgpt: true })).toBe("chatgpt");
    expect(loginChoice({ copilot: true })).toBe("copilot");
    expect(loginChoice({ provider: "deepseek", "api-key": "sk-x" })).toBe("provider");
    expect(loginChoice({ opencode: true })).toBe("opencode");
  });
});

describe("signing in to ChatGPT and Copilot", () => {
  it("signs in to ChatGPT with a code, which works with or without a browser here", async () => {
    const { client, calls } = fakeClient();
    const out = io();
    expect(await oauthSignIn(client, "chatgpt", out.say)).toBe("openai");
    expect(calls.authorize).toEqual([{ providerID: "openai", method: 1 }]);
    expect(calls.callback).toEqual([{ providerID: "openai", method: 1 }]);
    expect(out.said.join("\n")).not.toMatch(/OpenCode/);
  });

  it("shows GitHub's code in its own words, for github.com", async () => {
    const { client, calls } = fakeClient();
    const out = io();
    expect(await oauthSignIn(client, "copilot", out.say)).toBe("github-copilot");
    expect(calls.authorize).toEqual([
      { providerID: "github-copilot", method: 0, inputs: { deploymentType: "github.com" } },
    ]);
    expect(out.said).toContain(
      "To sign in with Copilot, open https://github.com/login/device and enter 283C-18C1",
    );
    expect(out.said.at(-1)).toBe("Copilot: signed in.");
  });

  it("keeps waiting when one wait times out, and says when sign-in fails", async () => {
    let tries = 0;
    const flaky = fakeClient({
      callback: async () => {
        if (tries++ === 0) throw new TypeError("fetch failed");
        return { data: true };
      },
    });
    expect(await oauthSignIn(flaky.client, "copilot", () => {})).toBe("github-copilot");
    expect(flaky.calls.callback).toHaveLength(2);

    const refused = fakeClient({ callback: async () => ({ error: { name: "Failed" } }) });
    const out = io();
    expect(await oauthSignIn(refused.client, "chatgpt", out.say)).toBeNull();
    expect(out.said.at(-1)).toBe("ChatGPT isn't signed in yet. Run: yapm-runner login");
  });
});

describe("another provider's API key", () => {
  it("finds the provider by name, takes the key hidden and stores it", async () => {
    const { client, calls } = fakeClient();
    const out = io(["moonshot", "Moonshot AI", "sk-moon"]);
    expect(await keySignIn(client, out)).toBe("moonshotai");
    // "moonshot" matched two, so it asked again.
    expect(out.said).toContain("Did you mean: Moonshot AI, Moonshot AI (China)?");
    expect(out.asked.at(-1)).toEqual({ question: "Moonshot AI API key (hidden): ", hidden: true });
    expect(calls.set).toEqual([
      { providerID: "moonshotai", auth: { type: "api", key: "sk-moon" } },
    ]);
  });

  it("takes the provider and key from flags", async () => {
    const { client, calls } = fakeClient();
    const out = io();
    expect(await keySignIn(client, out, "deepseek", "sk-deep")).toBe("deepseek");
    expect(out.asked).toEqual([]);
    expect(calls.set).toEqual([{ providerID: "deepseek", auth: { type: "api", key: "sk-deep" } }]);
    await expect(keySignIn(client, out, "nope", "k")).rejects.toThrow(
      'There\'s no provider "nope".',
    );
  });
});
