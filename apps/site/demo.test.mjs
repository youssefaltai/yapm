import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const site = readFileSync(new URL("./public/site.js", import.meta.url), "utf8");

test("the demo has no moonlighting scenario", () => {
  assert.doesNotMatch(site, /moonlight|parsnip|okay labs/i);
});
