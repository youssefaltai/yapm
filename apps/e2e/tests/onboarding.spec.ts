import { expect, type Page, test } from "@playwright/test";

/** Gives the page a platform passkey, like Touch ID, that approves every request. */
async function addPasskeyAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test("owner starts a company with a passkey, signs out and back in", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Start your company" })).toBeVisible();
  await page.getByLabel("Company name").fill("Youssef Inc");
  await page.getByLabel("Your name").fill("Youssef");
  await page.getByRole("button", { name: "Create passkey and start" }).click();

  await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();
  await expect(page.getByText("2 AI employees across 7 teams.")).toBeVisible();
  await expect(page.getByText("Chief Executive Officer")).toBeVisible();
  await expect(page.getByText("Runs the company: triage, routing")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();

  // The session survives a reload.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();
});
