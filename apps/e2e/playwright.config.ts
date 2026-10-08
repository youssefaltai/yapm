import { defineConfig, devices } from "@playwright/test";

const port = 8790;
const dataDir = new URL("./.data/", import.meta.url).pathname;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Start from an empty database every run.
    command: `rm -rf ${dataDir} && node ../hub-node/dist/main.js`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(port), DATABASE_URL: `file:${dataDir}life-os.db` },
  },
});
