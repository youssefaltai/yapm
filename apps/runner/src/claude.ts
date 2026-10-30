import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The Claude Code binary the Agent SDK ships for this platform, so signing in needs nothing
 * else installed. Falls back to a `claude` on PATH.
 */
export function claudeBinary(): string {
  try {
    const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const require = createRequire(sdk);
    const ext = process.platform === "win32" ? ".exe" : "";
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    for (const name of [base, `${base}-musl`]) {
      try {
        const path = require.resolve(`${name}/claude${ext}`);
        if (existsSync(path)) return path;
      } catch {}
    }
  } catch {}
  return "claude";
}

/** Whether this machine's Claude sign-in is there, as `claude auth status` reports it. */
export function claudeSignedIn(binary = claudeBinary()): boolean {
  const result = spawnSync(binary, ["auth", "status"], { encoding: "utf8" });
  try {
    return (JSON.parse(result.stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

/** Agents can run: an API key is saved, or Claude is signed in. */
export function claudeReady(apiKey: string | undefined, binary = claudeBinary()): boolean {
  return Boolean(apiKey) || claudeSignedIn(binary);
}

export const apiKeyLooksRight = (key: string) => key.startsWith("sk-ant-");

/** Signs in to Claude in the browser unless already signed in. */
export function claudeLogin(log: (line: string) => void): boolean {
  const binary = claudeBinary();
  if (claudeSignedIn(binary)) {
    log("Claude: signed in.");
    return true;
  }
  log("Sign in to Claude with the plan your agents should use (a browser opens)…");
  spawnSync(binary, ["auth", "login"], { stdio: "inherit" });
  const ok = claudeSignedIn(binary);
  log(
    ok
      ? "Claude: signed in."
      : "Claude isn't signed in yet; agents can't run until it is. Run: yapm-runner login",
  );
  return ok;
}
