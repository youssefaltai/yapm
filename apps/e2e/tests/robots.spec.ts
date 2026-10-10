import { expect, test } from "@playwright/test";

test("a private hub asks search engines not to index it", async ({ request }) => {
  const response = await request.get("/robots.txt");
  expect(await response.text()).toContain("Disallow: /");
});
