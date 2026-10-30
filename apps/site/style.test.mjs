import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("./public/", import.meta.url);
const read = (file) => readFileSync(new URL(file, dir), "utf8");
const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");

const tokens = Object.fromEntries(
  [...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map(([, name, hex]) => [name, hex]),
);

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("every text colour reads at 4.5:1 on every surface", () => {
  const texts = Object.keys(tokens).filter((name) => /^fg(-\d)?$/.test(name));
  const surfaces = Object.keys(tokens).filter((name) => /^bg(-\d)?$/.test(name));
  assert.ok(texts.length >= 4 && surfaces.length >= 3);
  for (const fg of texts)
    for (const bg of surfaces) {
      const [hi, lo] = [luminance(tokens[fg]), luminance(tokens[bg])].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      assert.ok(ratio >= 4.5, `--${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
});

test("every class the stylesheet styles is used", () => {
  const sources = readdirSync(dir)
    .filter((file) => /\.(html|js)$/.test(file))
    .map(read);
  const used = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/class="([^"]*)"|"([^"<>]*)"/g)].flatMap(([, cls, str]) =>
        (cls ?? str).split(/[\s.]+/),
      ),
    ),
  );
  const styled = new Set(
    [...css.replace(/url\([^)]*\)/g, "").matchAll(/\.(-?[a-z][\w-]*)/gi)].map(([, cls]) => cls),
  );
  for (const cls of styled) assert.ok(used.has(cls), `.${cls} is styled but never used`);
});
