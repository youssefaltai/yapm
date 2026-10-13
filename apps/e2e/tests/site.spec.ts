import { expect, type Locator, type Page, test } from "@playwright/test";

// The landing page, served by wrangler as Cloudflare serves it (see playwright.config.ts).
test.use({ baseURL: "http://localhost:8791" });

const pages = ["/", "/how-it-works", "/vs-linear", "/self-host"];
// The narrowest screen WCAG asks pages to reflow for.
const phone = { width: 320, height: 640 };
const desktop = { width: 1440, height: 900 };

/** How many lines an element's text runs over. */
function lines(element: Locator) {
  return element.evaluate((root) => {
    const tops: number[] = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walk.currentNode);
      for (const rect of Array.from(range.getClientRects())) if (rect.width) tops.push(rect.top);
    }
    tops.sort((a, b) => a - b);
    return tops.filter((top, i) => i === 0 || top - (tops[i - 1] ?? 0) > 8).length;
  });
}

async function eachLinkOnOneLine(page: Page) {
  for (const link of await page.locator("a:visible").all())
    expect(await lines(link), await link.innerText()).toBe(1);
}

for (const path of pages) {
  test(`${path} shows every nav link on a phone`, async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(path);
    for (const link of await page.locator(".nav a").all())
      await expect(link).toBeInViewport({ ratio: 1 });
  });

  test(`${path} ends at its footer`, async ({ page }) => {
    for (const size of [desktop, phone]) {
      await page.setViewportSize(size);
      await page.goto(path);
      const gap = await page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (document.querySelector(".foot")?.getBoundingClientRect().bottom ?? 0) -
          scrollY,
      );
      expect(Math.abs(gap)).toBeLessThan(1);
    }
  });

  test(`${path} keeps every link on one line`, async ({ page }) => {
    for (const size of [desktop, phone]) {
      await page.setViewportSize(size);
      await page.goto(path);
      await eachLinkOnOneLine(page);
    }
  });
}

test("the demo keeps agents' names on one line on a phone", async ({ page }) => {
  await page.setViewportSize(phone);
  await page.goto("/");
  await page.getByRole("button", { name: "Renew my passport" }).click();
  const name = page.locator(".rn").first();
  await name.waitFor();
  expect(await lines(name)).toBe(1);
});

test("the steps under the demo line up on a phone", async ({ page }) => {
  await page.setViewportSize(phone);
  await page.goto("/");
  const tops = await page
    .locator(".rail span")
    .evaluateAll((spans) => spans.map((span) => Math.round(span.getBoundingClientRect().top)));
  expect(tops[0]).toBe(tops[1]);
  expect(tops[2]).toBe(tops[3]);
});

test("an unknown page is a 404 with the site's nav", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("link", { name: "yapm home" })).toBeVisible();
});

test("pages are served over HTTPS only and can't be framed", async ({ request }) => {
  const headers = (await request.get("/")).headers();
  expect(headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
});

test("the classic favicon path serves an icon", async ({ request }) => {
  const response = await request.get("/favicon.ico");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^image\//);
});
