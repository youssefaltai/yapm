import type { createOpencodeClient } from "@opencode-ai/sdk/v2";

type Client = Pick<ReturnType<typeof createOpencodeClient>, "provider" | "auth">;
type Say = (line: string) => void;
interface Io {
  say: Say;
  ask: (question: string, hidden?: boolean) => Promise<string>;
}

export const CHOICE = `Which AI should agents on this machine use? (pick any; add more later)
  1) Claude subscription      4) GitHub Copilot
  2) Anthropic API key        5) API key for another provider (OpenRouter, DeepSeek, …)
  3) ChatGPT plan
Agents use your own plan or key, and their usage counts against it.
> `;

const CHOICES = {
  "1": "account",
  "2": "key",
  "3": "chatgpt",
  "4": "copilot",
  "5": "provider",
} as const;
export type Choice = (typeof CHOICES)[keyof typeof CHOICES] | "opencode";

/** The owner's answer to which AI agents should use. */
export function authChoice(answer: string): Choice | null {
  return CHOICES[answer.trim() as keyof typeof CHOICES] ?? null;
}

/** The choice `login`'s flags make; an API key without `--provider` is Anthropic's. */
export function loginChoice(flags: {
  claude?: boolean;
  chatgpt?: boolean;
  copilot?: boolean;
  provider?: string;
  opencode?: boolean;
  "api-key"?: string;
}): Choice | null {
  if (flags.claude) return "account";
  if (flags.chatgpt) return "chatgpt";
  if (flags.copilot) return "copilot";
  if (flags.provider !== undefined) return "provider";
  if (flags["api-key"] !== undefined) return "key";
  if (flags.opencode) return "opencode";
  return null;
}

const OAUTH = {
  // Its device code works with or without a browser on this machine.
  chatgpt: { id: "openai", name: "ChatGPT", method: /headless/i, inputs: undefined },
  copilot: {
    id: "github-copilot",
    name: "Copilot",
    method: /./,
    inputs: { deploymentType: "github.com" },
  },
};

/** Signs in to ChatGPT or Copilot; returns the provider's id, or null if it didn't work. */
export async function oauthSignIn(client: Client, which: keyof typeof OAUTH, say: Say) {
  const { id, name, method: label, inputs } = OAUTH[which];
  const methods = (await client.provider.auth()).data?.[id] ?? [];
  const method = methods.findIndex((m) => m.type === "oauth" && label.test(m.label));
  const { data } = await client.provider.oauth.authorize({
    providerID: id,
    method,
    ...(inputs ? { inputs } : {}),
  });
  const code = /code:\s*(\S+)/i.exec(data?.instructions ?? "")?.[1];
  if (data)
    say(
      code
        ? `To sign in with ${name}, open ${data.url} and enter ${code}`
        : `To sign in with ${name}, open ${data.url}`,
    );
  // The wait outlasts one request's time limit; the code stays good, so wait again.
  for (let tries = 0; data && tries < 3; tries++) {
    try {
      const done = await client.provider.oauth.callback({ providerID: id, method });
      if (done.data) {
        say(`${name}: signed in.`);
        return id;
      }
      break;
    } catch {}
  }
  say(`${name} isn't signed in yet. Run: yapm-runner login`);
  return null;
}

/** Stores another provider's API key, asking for what the flags left out; returns its id. */
export async function keySignIn(client: Client, io: Io, providerFlag?: string, key?: string) {
  const all = (await client.provider.list()).data?.all ?? [];
  let provider: (typeof all)[number] | undefined;
  while (!provider) {
    const answer = (providerFlag ?? (await io.ask("Which provider? "))).trim().toLowerCase();
    const matches = all.filter(
      (p) => p.id.includes(answer) || p.name.toLowerCase().includes(answer),
    );
    provider =
      all.find((p) => p.id === answer || p.name.toLowerCase() === answer) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (provider) break;
    if (providerFlag) throw new Error(`There's no provider "${providerFlag}".`);
    io.say(
      matches.length && answer
        ? `Did you mean: ${matches
            .slice(0, 8)
            .map((p) => p.name)
            .join(", ")}?`
        : "Type its name, e.g. OpenRouter, DeepSeek or Mistral.",
    );
  }
  const secret = key ?? (await io.ask(`${provider.name} API key (hidden): `, true));
  await client.auth.set({ providerID: provider.id, auth: { type: "api", key: secret } });
  io.say(`${provider.name}: agents use your API key.`);
  return provider.id;
}
