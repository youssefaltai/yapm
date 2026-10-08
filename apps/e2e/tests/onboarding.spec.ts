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

    test("runs an agent on a machine, follows the transcript and stops it", async () => {
      const runner = async (path: string, token: string, data: unknown) => {
        const response = await page.request.post(`/api/runner${path}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          data,
        });
        return response.status() === 204 ? null : await response.json();
      };
      const machine = await runner("/enrol", "", { name: "MacBook", tags: [], capacity: 2 });
      await page.getByRole("link", { name: "Runs" }).click();
      await page.getByRole("link", { name: "Machines" }).click();
      await expect(page.getByText("Waiting for approval")).toBeVisible();
      await page.getByLabel("Pairing code").fill(machine.pairingCode);
      await page.getByRole("button", { name: "Approve" }).click();
      await expect(page.getByText("Online · 0/2 running")).toBeVisible();

      await page.goto("/company");
      await page.getByRole("button", { name: /Ada/ }).first().click();
      await page.getByRole("button", { name: "Give Ada work" }).click();
      await page.getByLabel("Goal").fill("Reconcile last month's statements");
      await page.getByRole("textbox", { name: "On issue" }).fill("PF-1");
      await page.getByRole("button", { name: "Start" }).click();
      await expect(
        page.getByRole("heading", { name: "Reconcile last month's statements" }),
      ).toBeVisible();
      await expect(page.getByText("Queued", { exact: true })).toBeVisible();
      const runId = new URL(page.url()).pathname.split("/").pop();

      // Earlier tests woke Ada too; the machine finishes those first.
      let claim = await runner("/claim", machine.token, {});
      while (claim && claim.run.id !== runId) {
        await runner(`/runs/${claim.run.id}/complete`, machine.token, {
          status: "failed",
          error: "Skipped in the test",
        });
        claim = await runner("/claim", machine.token, {});
      }
      expect(claim?.input.prompt).toContain("Reconcile last month's statements");
      await runner(`/runs/${runId}/logs`, machine.token, {
        seq: 0,
        events: [
          { type: "text", text: "Pulling the statements from the bank export." },
          { type: "tool", name: "mcp__life-os__get_issue", input: '{"id":"PF-1"}' },
        ],
      });
      await expect(page.getByText("Pulling the statements from the bank export.")).toBeVisible();
      await expect(page.getByText("get_issue", { exact: true })).toBeVisible();
      await expect(page.getByText("Running", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await page.getByLabel("Reason").fill("Wait until payday");
      await page.getByRole("button", { name: "Stop run" }).click();
      const beat = await runner("/heartbeat", machine.token, { runIds: [runId] });
      expect(beat.stop).toEqual([{ id: runId, reason: "Wait until payday" }]);
      await runner(`/runs/${runId}/complete`, machine.token, { status: "stopped" });
      await expect(page.getByText("Stopped by Youssef: Wait until payday")).toBeVisible();
    });

    test("plans a project with milestones, updates and a document", async () => {
      await page.getByRole("link", { name: "Projects" }).click();
      await page.getByRole("button", { name: "New project" }).click();
      const dialog = page.getByRole("dialog", { name: "New project" });
      await dialog.getByLabel("Name").fill("Pay off the car");
      await dialog.getByLabel("Summary").fill("Owe nothing on the car by spring");
      await dialog.getByLabel("Lead").selectOption({ label: "Ada" });
      await dialog.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByLabel("Project name")).toHaveValue("Pay off the car");

      await page.getByLabel("New milestone").fill("Half paid");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByText("Half paid")).toBeVisible();

      // Ada reports on it over MCP; the owner sees it in the Inbox and on the project.
      const update = await mcp("create_project_update", {
        project: "Pay off the car",
        body: "Two extra payments **sent**.",
        health: "atRisk",
      });
      expect(update.project).toBe("Pay off the car");
      await expect(page.getByText("Two extra payments sent.").first()).toBeVisible();
      await expect(page.getByText("At risk").first()).toBeVisible();

      await page.getByRole("button", { name: "+ New document" }).click();
      await page.getByLabel("Document title").fill("Payment plan");
      await page.getByLabel("Content").fill("# Plan\n- Pay **200** extra a month");
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
      await expect(page.locator(".markdown strong")).toHaveText("200");
      await page.waitForTimeout(1000);
      const doc = await mcp("list_documents", { query: "payment" });
      expect(doc.documents[0]).toMatchObject({ title: "Payment plan", project: "Pay off the car" });

      await page.getByRole("link", { name: /Inbox/ }).click();
      await expect(
        page.getByRole("button", { name: /Pay off the car.*Ada posted an update/ }),
      ).toBeVisible();
    });

    test("runs the team in cycles, triages agents' issues and saves a view", async () => {
      await page.getByRole("link", { name: /Personal Finance/ }).click();
      await page.getByRole("link", { name: "Settings" }).click();
      await page.getByRole("switch", { name: "Triage" }).click();
      await expect(page.getByRole("switch", { name: "Triage" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.getByRole("switch", { name: "Cycles" }).click();
      await page.getByLabel("Cycle length").selectOption({ label: "2 weeks" });

      await page.getByRole("link", { name: "Cycles", exact: true }).click();
      await expect(page.getByRole("button", { name: /Cycle 1.*Current/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /Cycle 3.*Upcoming/ })).toBeVisible();

      // Ada files an issue: it waits in Triage, already in the current cycle.
      const filed = await mcp("create_issue", {
        team: "PF",
        title: "Cancel the unused gym membership",
        cycle: "current",
      });
      expect(filed).toMatchObject({ status: "Triage", cycle: 1 });
      await page.getByRole("button", { name: /Cycle 1.*Current/ }).click();
      await expect(page.getByRole("img", { name: "Cycle progress" })).toBeVisible();
      const row = page.getByRole("button", { name: /Cancel the unused gym membership/ });
      await expect(row).toBeVisible();

      await page.getByRole("link", { name: /Personal Finance/ }).click();
      await page.getByRole("link", { name: "Triage" }).first().click();
      await row.getByRole("button", { name: "Accept" }).click();
      await expect(row).toBeHidden();

      // Shift+C moves an issue into a cycle; a filter becomes a saved view.
      await page.getByRole("link", { name: "Personal Finance" }).first().click();
      await page.getByRole("button", { name: /cheaper tariff/ }).hover();
      await page.keyboard.press("Shift+C");
      await page.getByRole("option", { name: /Cycle 2/ }).click();
      await page.getByRole("button", { name: "Filter" }).click();
      await page.getByRole("option", { name: "Status" }).click();
      await page.getByRole("option", { name: "Todo" }).click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      page.once("dialog", (prompt) => prompt.accept("Ready to start"));
      await page.getByRole("button", { name: "Save view" }).click();
      await expect(page).toHaveURL(/\/view\//);
      await expect(page.getByRole("link", { name: "Ready to start" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Cancel the unused gym membership/ }),
      ).toBeVisible();
    });

    test("sets up a recurring issue and files issues from a template", async () => {
      await page.getByRole("link", { name: /Personal Finance/ }).click();
      await page.getByRole("link", { name: "Settings" }).click();
      await page.getByRole("button", { name: "New recurring issue" }).click();
      const editor = page.getByRole("dialog", { name: "Recurring issue" });
      await editor.getByLabel("Issue title").fill("Review the budget {date}");
      await editor.getByLabel("Repeats").selectOption({ label: "Weekly" });
      await editor.getByLabel("On day").selectOption({ label: "Mon" });
      await editor.getByLabel("Time of day").fill("18:30");
      await editor.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Mondays at 18:30")).toBeVisible();

      await page.getByRole("button", { name: "New template" }).click();
      const template = page.getByRole("dialog", { name: "Template" });
      await template.getByLabel("Template name").fill("Bill to pay");
      await template.getByLabel("Issue title").fill("Pay the ___ bill");
      await template.getByLabel("Issue description").fill("Amount:\nDue:");
      await template.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: /Bill to pay/ })).toBeVisible();

      await page.keyboard.press("c");
      await page.getByRole("button", { name: "Use template" }).click();
      await page.getByRole("option", { name: "Bill to pay" }).click();
      await expect(page.getByLabel("Issue title")).toHaveValue("Pay the ___ bill");
      await expect(page.getByLabel("Issue description")).toHaveValue("Amount:\nDue:");
      await page.keyboard.press("Escape");
    });

    test("installs as an app and shows pushed notifications", async () => {
      const manifest = await page.request.get("/manifest.webmanifest");
      expect(manifest.ok()).toBe(true);
      expect(await manifest.json()).toMatchObject({ display: "standalone", start_url: "/inbox" });
      const worker = await page.request.get("/sw.js");
      expect(worker.headers()["content-type"]).toContain("javascript");

      await page.goto("/inbox");
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
      expect(new URL(scope).pathname).toBe("/");

      // Headless Chromium can't show notifications, so run the worker's handlers against a
      // stand-in for its global scope and check what it would show and open.
      const source = await worker.text();
      const result = await page.evaluate(async (code) => {
        const handlers: Record<string, (event: unknown) => void> = {};
        const shown: { title: string; options: { body: string; data: { url: string } } }[] = [];
        const opened: string[] = [];
        const waits: Promise<unknown>[] = [];
        const self = {
          location: { origin: location.origin },
          addEventListener: (type: string, fn: (event: unknown) => void) => {
            handlers[type] = fn;
          },
          skipWaiting: () => {},
          registration: {
            showNotification: async (title: string, options: (typeof shown)[number]["options"]) => {
              shown.push({ title, options });
            },
          },
          clients: {
            claim: async () => {},
            matchAll: async () => [],
            openWindow: async (url: string) => {
              opened.push(url);
            },
          },
        };
        new Function("self", code)(self);
        handlers.push?.({
          data: {
            json: () => ({
              title: "Ada asks for approval",
              body: "Push the budget sheet",
              url: "/request/r1",
              tag: "r1",
            }),
          },
          waitUntil: (p: Promise<unknown>) => waits.push(p),
        });
        await Promise.all(waits);
        handlers.notificationclick?.({
          notification: { close: () => {}, data: shown[0]?.options.data },
          waitUntil: (p: Promise<unknown>) => waits.push(p),
        });
        await Promise.all(waits);
        return { shown, opened };
      }, source);
      expect(result.shown[0]).toMatchObject({
        title: "Ada asks for approval",
        options: { body: "Push the budget sheet" },
      });
      expect(result.opened).toEqual([`${new URL(scope).origin}/request/r1`]);
    });
  });
