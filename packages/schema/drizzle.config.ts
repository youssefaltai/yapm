import { defineConfig } from "drizzle-kit";

// Migrations are plain SQLite SQL, applied by drizzle's migrator on Node
// and by `wrangler d1 migrations apply` on Cloudflare.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/tables.ts",
  out: "./migrations",
});
