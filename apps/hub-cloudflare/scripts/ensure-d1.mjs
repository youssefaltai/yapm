// Makes sure the D1 database exists in the Cloudflare account and points
// wrangler.jsonc at it, so a fresh account can deploy with no manual steps.
// Uses the account wrangler is authenticated against (CLOUDFLARE_API_TOKEN in CI).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const name = process.env.D1_DATABASE_NAME ?? "life-os";
const configPath = new URL("../wrangler.jsonc", import.meta.url);

function wrangler(...args) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function findDatabase() {
  const list = JSON.parse(wrangler("d1", "list", "--json"));
  return list.find((db) => db.name === name);
}

let database = findDatabase();
if (database) {
  console.log(`Using existing D1 database "${name}" (${database.uuid})`);
} else {
  console.log(`Creating D1 database "${name}"`);
  wrangler("d1", "create", name);
  database = findDatabase();
  if (!database) throw new Error(`D1 database "${name}" was not found after creating it`);
}

const config = readFileSync(configPath, "utf8");
const updated = config.replace(/("database_id":\s*")[^"]*(")/, `$1${database.uuid}$2`);
writeFileSync(configPath, updated);
console.log("wrangler.jsonc now points at the database");
