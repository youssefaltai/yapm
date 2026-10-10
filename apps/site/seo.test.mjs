import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`./public/${file}`, import.meta.url), "utf8");
const html = read("index.html");

test("robots.txt allows crawling and points to the sitemap", () => {
  assert.match(read("robots.txt"), /Allow: \/[\s\S]*Sitemap: https:\/\/yapm\.app\/sitemap\.xml/);
});

test("the sitemap lists the home page", () => {
  assert.match(read("sitemap.xml"), /<loc>https:\/\/yapm\.app\/<\/loc>/);
});

test("llms.txt describes the product for AI search", () => {
  assert.match(read("llms.txt"), /^# yapm\n\n> /);
});

test("the title leads with what people search for", () => {
  assert.match(html, /<title>[^<]*open-source Linear alternative[^<]*<\/title>/i);
});

test("structured data describes the app and answers the FAQ on the page", () => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const graph = blocks.flatMap(([, json]) => JSON.parse(json)["@graph"] ?? []);
  const app = graph.find((node) => node["@type"] === "SoftwareApplication");
  assert.equal(app.offers.price, "0");
  const faq = graph.find((node) => node["@type"] === "FAQPage");
  for (const { name } of faq.mainEntity) assert.ok(html.includes(`>${name}</`), name);
});
