import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.YAPM_RUNNER_HOME = await mkdtemp(join(tmpdir(), "yapm-runner-"));
const { configPath, loadConfig, saveConfig } = await import("../src/config.js");

describe("runner config", () => {
  it("keeps the API key in a file only the owner can read", async () => {
    const config = { hub: "http://hub", token: "t", machineId: "m", name: "n", capacity: 2 };
    await saveConfig({ ...config, apiKey: "sk-ant-api03-abc" });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await loadConfig()).apiKey).toBe("sk-ant-api03-abc");
  });
});
