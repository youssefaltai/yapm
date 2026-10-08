// Puts the runner's npm package in the web app's build, so every hub serves the runner that
// matches it at /downloads/life-os-runner.tgz, for its install command (see core install.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../../runner", import.meta.url));
const downloads = fileURLToPath(new URL("../dist/downloads", import.meta.url));
const pnpm = (args) =>
  execFileSync("pnpm", args, { cwd: runner, stdio: ["ignore", "ignore", "inherit"] });

pnpm(["run", "build"]);
const out = mkdtempSync(join(tmpdir(), "life-os-runner-"));
pnpm(["pack", "--pack-destination", out]);
const [file] = readdirSync(out).filter((name) => name.endsWith(".tgz"));
if (!file) throw new Error("pnpm pack made no package");
mkdirSync(downloads, { recursive: true });
renameSync(join(out, file), join(downloads, "life-os-runner.tgz"));
rmSync(out, { recursive: true, force: true });
console.log(`Bundled ${file} as downloads/life-os-runner.tgz`);
