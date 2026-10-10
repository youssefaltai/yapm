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

test("the h1 says what people search for", () => {
  assert.match(html.match(/<h1[\s\S]*?<\/h1>/)[0], /Linear alternative/i);
});

test("the demo's sample issue is not a heading", () => {
  assert.doesNotMatch(html, /<h2 data-title/);
});

const pages = [...read("sitemap.xml").matchAll(/<loc>https:\/\/yapm\.app\/([^<]*)<\/loc>/g)].map(
  ([, path]) => path,
);

test("the sitemap lists a page for each search people make", () => {
  assert.deepEqual(pages, ["", "vs-linear", "self-host", "how-it-works"]);
});

for (const path of pages.filter(Boolean)) {
  test(`/${path} stands on its own and is linked from the home page`, () => {
    const page = read(`${path}.html`);
    assert.match(page, new RegExp(`<link rel="canonical" href="https://yapm\\.app/${path}" />`));
    assert.match(page, /<title>[^<]+<\/title>/);
    assert.match(page, /<meta\s+name="description"\s+content="[^"]{50,160}"/);
    assert.match(
      page,
      new RegExp(`<meta property="og:url" content="https://yapm\\.app/${path}" />`),
    );
    assert.equal(page.match(/<h1/g).length, 1);
    assert.ok(html.includes(`href="/${path}"`), `home links to /${path}`);
  });
}

const nav = (page) => page.match(/<header class="nav[\s\S]*?<\/header>/)[0];

for (const path of pages.filter(Boolean)) {
  test(`/${path} has the home page's nav, and it turns to glass on scroll`, () => {
    const page = read(`${path}.html`);
    assert.equal(nav(page), nav(html).replaceAll('href="#', 'href="/#'));
    assert.match(page, /<script src="\/nav\.js" defer><\/script>/);
  });
}

test("the home page loads the nav script too", () => {
  assert.match(html, /<script src="\/nav\.js" defer><\/script>/);
});

test("no page offers a chat: you ask the CEO, and it files an issue", () => {
  const files = [
    "index.html",
    "site.js",
    "llms.txt",
    ...pages.filter(Boolean).map((p) => `${p}.html`),
  ];
  for (const file of files) assert.doesNotMatch(read(file), /\bchat/i, file);
  assert.match(html, /What can I take off your plate\?/);
});
