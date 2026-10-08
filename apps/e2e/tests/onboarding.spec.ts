import { type Browser, expect, type Page, test } from "@playwright/test";

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

// One owner, one passkey, one browser session: the tests build on each other like a real day.
test.describe
  .serial("the owner's day", () => {
    let page: Page;
    let agentToken = "";

    /** Calls a tool on the hub's MCP server as the agent, like Claude Code would. */
    async function mcp(name: string, args: Record<string, unknown>) {
      const response = await page.request.post("/mcp", {
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      });
      const body = await response.json();
      return JSON.parse(body.result.content[0].text);
    }

    test.beforeAll(async ({ browser }: { browser: Browser }) => {
      page = await (await browser.newContext()).newPage();
      await addPasskeyAuthenticator(page);
    });

    test.afterAll(async () => {
      await page.context().close();
    });

    test("starts a company with a passkey, signs out and back in", async () => {
      await page.goto("/");

      await expect(page.getByRole("heading", { name: "Start your company" })).toBeVisible();
      await page.getByLabel("Company name").fill("Youssef Inc");
      await page.getByLabel("Your name").fill("Youssef");
      await page.getByRole("button", { name: "Create passkey and start" }).click();

      await expect(page.getByText("You're all caught up.")).toBeVisible();
      await page.getByRole("link", { name: "Company" }).click();
      await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();
      await expect(page.getByText("1 AI employee, no teams yet.")).toBeVisible();
      await expect(page.getByText("Chief Executive Officer")).toBeVisible();
      await expect(page.getByText("No teams yet. Your CEO creates them")).toBeVisible();

      await page.getByRole("button", { name: "Sign out" }).first().click();
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
      await page.getByRole("button", { name: "Sign in with passkey" }).click();
      await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();

      // The session and the route survive a reload.
      await page.reload();
      await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();
    });

    test("creates a team and files issues from the keyboard", async () => {
      await page.getByRole("button", { name: "Create team" }).click();
      await page.getByLabel("Name").fill("Personal Finance");
      await expect(page.getByLabel("Identifier")).toHaveValue("PF");
      await page.getByRole("button", { name: "Create team" }).last().click();
      await expect(page).toHaveURL(/\/team\/PF$/);
      await expect(page.getByText("No issues here yet.")).toBeVisible();

      await page.keyboard.press("c");
      await page.getByLabel("Issue title").fill("Pay the electricity bill");
      await page.getByRole("button", { name: "No priority" }).click();
      await page.getByRole("option", { name: "High" }).click();
      await page.getByRole("button", { name: "Create issue", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Created PF-1");

      await page.keyboard.press("c");
      await page.getByLabel("Issue title").fill("Find a cheaper tariff");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status")).toContainText("Created PF-2");

      const backlog = page.getByRole("region", { name: "Backlog" });
      await expect(backlog.getByRole("button", { name: /Pay the electricity bill/ })).toBeVisible();
      await expect(backlog.getByRole("button", { name: /Find a cheaper tariff/ })).toBeVisible();
    });

    test("changes status with shortcuts and bulk edits a selection", async () => {
      // Hover focuses a row; S opens the status menu for it.
      await page.getByRole("button", { name: /Pay the electricity bill/ }).hover();
      await page.keyboard.press("s");
      await page.getByRole("option", { name: "In Progress" }).click();
      const started = page.getByRole("region", { name: "In Progress" });
      await expect(started.getByRole("button", { name: /Pay the electricity bill/ })).toBeVisible();

      await page.keyboard.press("Control+a");
      await expect(page.getByText("2 selected")).toBeVisible();
      await page.keyboard.press("p");
      await page.getByRole("option", { name: "Urgent" }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByText("2 selected")).toBeHidden();

      await page.getByRole("button", { name: "Filter" }).click();
      await page.getByRole("option", { name: "Status" }).click();
      await page.getByRole("option", { name: "In Progress" }).click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: /Find a cheaper tariff/ })).toBeHidden();
      await page.getByRole("button", { name: "Remove Status filter" }).click();
      await expect(page.getByRole("button", { name: /Find a cheaper tariff/ })).toBeVisible();
    });

    test("opens an issue, comments, and sees its history", async () => {
      await page.getByRole("button", { name: /Pay the electricity bill/ }).click();
      await expect(page).toHaveURL(/\/issue\/PF-1$/);
      await expect(page.getByLabel("Issue title")).toHaveValue("Pay the electricity bill");
      await expect(page.getByText("created the issue")).toBeVisible();
      await expect(page.getByText("changed status from Backlog to In Progress")).toBeVisible();

      await page.getByLabel("Leave a comment").fill("Paid through the bank app.");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(page.getByText("Paid through the bank app.")).toBeVisible();

      await page.getByRole("button", { name: "+ Add sub-issue" }).click();
      await page
        .getByRole("dialog", { name: "New issue" })
        .getByLabel("Issue title")
        .fill("Set up autopay");
      await page.getByRole("button", { name: "Create issue", exact: true }).click();
      await expect(page.getByRole("button", { name: /PF-3.*Set up autopay/ })).toBeVisible();
    });

    test("finds issues with Cmd+K and switches to the board", async () => {
      await page.keyboard.press("Control+k");
      await page.getByPlaceholder("Type a command or search issues…").fill("tariff");
      await page.getByRole("option", { name: /Find a cheaper tariff/ }).click();
      await expect(page).toHaveURL(/\/issue\/PF-2$/);

      await page.getByRole("link", { name: /Personal Finance/ }).click();
      await page.getByRole("button", { name: "board" }).click();
      await expect(page.getByText("Todo", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /PF-3/ })).toBeVisible();
    });

    test("shows changes from another tab live, without a reload", async () => {
      const other = await page.context().newPage();
      await other.goto("/team/PF");
      await other.getByRole("button", { name: "list" }).click();
      await expect(other.getByRole("button", { name: /Find a cheaper tariff/ })).toBeVisible();

      await page.goto("/issue/PF-2");
      const title = page.getByLabel("Issue title");
      await title.fill("Switch to a cheaper tariff");
      await title.press("Enter");

      await expect(other.getByRole("button", { name: /Switch to a cheaper tariff/ })).toBeVisible();
      await other.close();
    });

    test("hires an agent and connects it to Claude Code with a token", async () => {
      await page.getByRole("link", { name: "Company" }).click();
      await page.getByRole("button", { name: "+ Hire agent" }).click();
      const dialog = page.getByRole("dialog", { name: "Hire agent" });
      await dialog.getByLabel("Name").fill("Ada");
      await dialog.getByLabel("Title").fill("Head of Finance");
      await dialog.getByLabel("Charter").fill("Owns the household budget and the bills.");
      await dialog.getByRole("button", { name: "Hire" }).click();

      await expect(page.getByLabel("Name")).toHaveValue("Ada");
      await expect(page.getByLabel("Charter")).toHaveValue(
        "Owns the household budget and the bills.",
      );

      page.once("dialog", (prompt) => prompt.accept("Laptop"));
      await page.getByRole("button", { name: "+ New token" }).click();
      await expect(page.getByText("Copy this token now.")).toBeVisible();
      await expect(page.getByText(/claude mcp add --transport http life-os/)).toBeVisible();
      agentToken = (await page.locator("code").first().textContent()) ?? "";
      expect(await mcp("get_user", { query: "me" })).toMatchObject({
        name: "Ada",
        title: "Head of Finance",
      });
    });

    test("approves an agent's request from the phone", async () => {
      const asked = await mcp("create_request", {
        title: "Push the budget sheet to the shared drive",
        action: "tool:Bash",
        resource: "rclone copy budget.xlsx drive:",
        reason: "The monthly budget is ready and you asked for it in the drive.",
        issue: "PF-1",
      });
      expect(asked.status).toBe("pending");
      await expect(page.getByRole("link", { name: /Approvals\s*1/ })).toBeVisible();

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(new URL(asked.url).pathname);
      await expect(page.getByRole("heading", { name: asked.title })).toBeVisible();
      await expect(page.getByText("rclone copy budget.xlsx drive:")).toBeVisible();
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByText("Approved once by Youssef")).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 720 });

      expect(await mcp("get_request", { id: asked.id })).toMatchObject({ status: "approved" });
      expect(
        await mcp("check_permission", {
          action: "tool:Bash",
          resource: "rclone copy budget.xlsx drive:",
        }),
      ).toMatchObject({ allowed: true, via: "approval" });
    });

    test("hears from agents in the Inbox", async () => {
      await mcp("create_comment", {
        issueId: "PF-1",
        body: "@Youssef the bill is paid, receipt attached.",
      });
      await page.getByRole("link", { name: /Inbox/ }).click();
      const list = page.getByRole("list", { name: "Notifications" });
      const mention = list.getByRole("button", {
        name: /Pay the electricity bill.*Ada mentioned you/,
      });
      await expect(mention).toBeVisible();
      await expect(list.getByRole("button", { name: /Ada asks for your approval/ })).toBeVisible();

      await mention.click();
      await expect(page.getByLabel("Issue title")).toHaveValue("Pay the electricity bill");
      await expect(page.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
      await expect(
        page.getByText("@Youssef the bill is paid, receipt attached.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Mark all read" }).click();
      await expect(list.getByRole("img", { name: "Unread" })).toHaveCount(0);
    });
  });
