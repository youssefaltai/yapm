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

/** Picks an option from one of the app's dropdowns, which replace native selects. */
async function choose(page: Page, trigger: ReturnType<Page["getByLabel"]>, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

// One owner, one passkey, one browser session: the tests build on each other like a real day.
test.describe
  .serial("the owner's day", () => {
    let page: Page;
    let agentToken = "";
    let machineToken = "";

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

      // The app opens on asking the CEO.
      await expect(page.getByRole("link", { name: "Ask CEO", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.getByRole("link", { name: "Company" }).click();
      await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();
      await expect(page.getByText("1 AI employee across 1 team.")).toBeVisible();
      await expect(page.getByText("Chief Executive Officer")).toBeVisible();

      await page.getByRole("button", { name: "Sign out" }).first().click();
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
      await page.getByRole("button", { name: "Sign in with passkey" }).click();
      await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();

      // The session and the route survive a reload.
      await page.reload();
      await expect(page.getByRole("heading", { name: "Youssef Inc" })).toBeVisible();
    });

    test("asks the CEO, who takes it on as an issue, once a machine can run it", async () => {
      await page.getByRole("link", { name: "Ask CEO", exact: true }).click();
      // No machine yet: the page offers to add the first one.
      await expect(page.getByText("Add your first machine")).toBeVisible();
      await page.getByRole("button", { name: "Add machine" }).click();
      const command = page.getByText(/^curl -fsSL .*\/install\.sh \| sh -s -- --token lms_/);
      const token = ((await command.textContent()) ?? "").split("--token ")[1]?.trim();
      await page.request.post("/api/runner/enrol", {
        data: { name: "Home Mac", tags: [], capacity: 1, setupToken: token },
      });

      // It connects, and the CEO is ready.
      await expect(
        page.getByRole("heading", { name: "What can I take off your plate?" }),
      ).toBeVisible();
      await expect(page.getByText("I'll make it an issue and get to work")).toBeVisible();
      // The composer is ready to type in; a suggestion fills it, ready to edit or send.
      const composer = page.getByLabel("Ask CEO");
      await expect(composer).toBeFocused();
      await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Plan my week" }).click();
      await expect(composer).toHaveValue("Plan my week");
      await expect(composer).toBeFocused();
      // Enter sends and Shift+Enter starts a new line.
      await composer.fill("Set up a team for the household bills.");
      await composer.press("Shift+Enter");
      await composer.pressSequentially("Electricity and water, mostly.");
      // While it's on its way the composer becomes the CEO at work; a failure gives the text back.
      let fail = true;
      await page.route("**/graphql", async (route) => {
        if (!(route.request().postData() ?? "").includes("issueCreate")) return route.fallback();
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!fail) return route.fallback();
        fail = false;
        await route.fulfill({ json: { errors: [{ message: "The hub is unreachable" }] } });
      });
      await composer.press("Enter");
      await expect(page.getByRole("status", { name: "CEO is taking it on" })).toBeVisible();
      await expect(page.getByRole("alert")).toContainText("The hub is unreachable");
      await expect(composer).toHaveValue(
        "Set up a team for the household bills.\nElectricity and water, mostly.",
      );
      await composer.press("Enter");

      // It becomes an issue for the CEO, in the company's first team, where the reply lands.
      await expect(page).toHaveURL(/\/issue\/YI-1$/);
      await expect(page.getByLabel("Issue title")).toHaveValue(
        "Set up a team for the household bills.",
      );
      await expect(page.getByText("Electricity and water, mostly.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
    });

    test("creates a team and files issues from the keyboard", async () => {
      await page.getByRole("button", { name: "Create team" }).click();
      await page.getByLabel("Name").fill("Personal Finance");
      await expect(page.getByLabel("Identifier")).toHaveValue("PF");
      await page.getByRole("button", { name: "Create team" }).last().click();
      await expect(page).toHaveURL(/\/team\/PF$/);
      await expect(page.getByText("No issues in Personal Finance yet")).toBeVisible();

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

      // Archiving a selection, and undoing it, takes one request each.
      const sent: string[] = [];
      const track = (r: { postData: () => string | null }) => {
        if (/issue(Un)?archive/i.test(r.postData() ?? "")) sent.push(r.postData() ?? "");
      };
      page.on("request", track);
      await page.keyboard.press("Control+a");
      await page.getByRole("button", { name: /Find a cheaper tariff/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive" }).click();
      await expect(page.getByRole("status")).toContainText("Archived 2 issues");
      await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
      await expect(page.getByRole("button", { name: /Find a cheaper tariff/ })).toBeVisible();
      page.off("request", track);
      expect(sent).toHaveLength(2);
    });

    test("suggests what to ask the CEO from the work at hand", async () => {
      await page.reload();
      await page.getByRole("link", { name: "Ask CEO", exact: true }).click();
      // The urgent issue already in progress comes first.
      await page.getByRole("button", { name: /Pay the electricity bill/ }).click();
      await expect(page.getByLabel("Ask CEO")).toHaveValue(/Pay the electricity bill/);
      await page.goBack();
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
      await page.getByPlaceholder("Type a command or search…").fill("tariff");
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

    test("a hidden tab skips live refreshes and catches up when shown", async () => {
      const other = await page.context().newPage();
      await other.goto("/team/PF");
      await other.getByRole("button", { name: "list" }).click();
      await expect(other.getByRole("button", { name: /Switch to a cheaper tariff/ })).toBeVisible();
      const setHidden = (hidden: boolean) =>
        other.evaluate((hidden) => {
          Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
          Object.defineProperty(document, "visibilityState", {
            value: hidden ? "hidden" : "visible",
            configurable: true,
          });
          if (!hidden) document.dispatchEvent(new Event("visibilitychange"));
        }, hidden);
      await setHidden(true);
      await other.waitForTimeout(500); // let refreshes already queued land
      let requests = 0;
      other.on("request", (request) => {
        if (request.url().endsWith("/graphql")) requests++;
      });

      await page.goto("/issue/PF-2");
      const title = page.getByLabel("Issue title");
      await title.fill("Switch to a cheaper tariff today");
      await title.press("Enter");
      await page.waitForTimeout(1000);
      expect(requests).toBe(0);

      await setHidden(false);
      await expect(
        other.getByRole("button", { name: /Switch to a cheaper tariff today/ }),
      ).toBeVisible();
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
      await expect(page.getByLabel("Charter")).toHaveText(
        "Owns the household budget and the bills.",
      );

      await page.getByRole("button", { name: "+ New token" }).click();
      const tokenDialog = page.getByRole("dialog", { name: "New API token" });
      await tokenDialog.getByLabel("Token name").fill("Laptop");
      await tokenDialog.getByRole("button", { name: "Create token" }).click();
      await expect(page.getByText("Copy this token now.")).toBeVisible();
      await expect(page.getByText(/claude mcp add --transport http yapm/)).toBeVisible();
      agentToken = (await page.locator("code").first().textContent()) ?? "";
      // New hires report to the CEO unless you pick someone else.
      expect(await mcp("get_user", { query: "me" })).toMatchObject({
        name: "Ada",
        title: "Head of Finance",
        manager: "CEO",
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
      await page.getByRole("button", { name: "Approve once" }).click();
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

      // Like Linear, an issue is one row however much happens on it, showing the latest.
      await mcp("create_comment", { issueId: "PF-1", body: "Filed it under bills too." });
      const latest = list.getByRole("button", { name: /Ada commented: Filed it under bills/ });
      await expect(latest).toBeVisible();
      await expect(list.getByRole("button", { name: /Pay the electricity bill/ })).toHaveCount(1);

      await latest.click();
      await expect(page.getByLabel("Issue title")).toHaveValue("Pay the electricity bill");
      // The issue gets the pane's width, with its properties below rather than squeezed beside.
      const title = await page.getByLabel("Issue title").boundingBox();
      expect(title?.width).toBeGreaterThan(500);
      await expect(page.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
      // The agent's `@Youssef` shows as a mention chip, as in Linear.
      const agentComment = page.locator(".rich", {
        hasText: "the bill is paid, receipt attached.",
      });
      await expect(agentComment.locator("[data-mention=user]")).toHaveText(/Youssef/);
      await page.getByRole("button", { name: "Mark all read" }).click();
      await expect(list.getByRole("img", { name: "Unread" })).toHaveCount(0);

      // A row's notifications change together, in one request.
      const sent: string[] = [];
      const track = (r: { postData: () => string | null }) => {
        const body = r.postData() ?? "";
        if (/notification(Update|Archive)/.test(body)) sent.push(body);
      };
      page.on("request", track);
      await latest.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mark as unread" }).click();
      await expect(list.getByRole("img", { name: "Unread" })).toHaveCount(1);
      await latest.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive" }).click();
      await expect(latest).toBeHidden();
      page.off("request", track);
      expect(sent).toHaveLength(2);
      await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
      await expect(latest).toBeVisible();
    });

    test("always allows a server's read-only tools, and manages access per agent and team", async () => {
      const asked = await mcp("create_request", {
        title: "Ada wants to use Slack: read_channel",
        action: "tool:slack__slack_read_channel",
        resource: "readOnly",
        reason: "To read the budget channel.",
      });
      await page.goto(`/request/${asked.id}`);
      await page.getByRole("button", { name: "Always allow" }).click();
      await expect(page.getByLabel("This tool")).toBeVisible();
      await expect(page.getByLabel("All Slack tools")).toBeVisible();
      await page.getByLabel("Read-only Slack tools").check();
      await page.getByRole("button", { name: "Always allow" }).click();
      await expect(page.getByText("Always allowed").first()).toBeVisible();
      expect(
        await mcp("check_permission", { action: "tool:slack__slack_search", resource: "readOnly" }),
      ).toMatchObject({ allowed: true, via: "grant" });

      // The agent's page shows what it may do, grouped by server, and the owner edits it there.
      await page.getByRole("button", { name: "Ada", exact: true }).click();
      const access = page.getByRole("region", { name: "Access" });
      await expect(access.getByText("Slack", { exact: true })).toBeVisible();
      await expect(access.getByText("Read-only tools")).toBeVisible();
      await access.getByRole("button", { name: "Add access" }).click();
      await access.getByLabel("Action").fill("budget.spend");
      await access.getByLabel("Note").fill("Up to the monthly budget");
      await access.getByRole("button", { name: "Add", exact: true }).click();
      const spend = access.getByRole("listitem").filter({ hasText: "Up to the monthly budget" });
      await spend.getByRole("button", { name: "Edit" }).click();
      await access.getByLabel("Note").fill("Up to £500");
      await access.getByRole("button", { name: "Save" }).click();
      const edited = access.getByRole("listitem").filter({ hasText: "Up to £500" });
      await edited.getByRole("button", { name: "Revoke" }).click();
      await expect(edited).toBeHidden();
      await access.getByLabel("Show revoked").check();
      await expect(edited.getByText(/Revoked/)).toBeVisible();

      // A team's settings add and remove its agents, and show the team's access.
      await page.goto("/team/PF/settings");
      const members = page.getByRole("region", { name: "Members" });
      await members.getByRole("button", { name: "Add member" }).click();
      await page.getByRole("option", { name: /Ada/ }).click();
      const ada = members.getByRole("listitem").filter({ hasText: "Ada" });
      await expect(ada).toBeVisible();
      const teamAccess = page.getByRole("region", { name: "Access" });
      await teamAccess.getByRole("button", { name: "Add access" }).click();
      await teamAccess.getByLabel("Action").fill("doc.write");
      await teamAccess.getByRole("button", { name: "Add", exact: true }).click();
      await expect(teamAccess.getByText("doc.write")).toBeVisible();
      await ada.getByRole("button", { name: "Remove" }).click();
      await expect(ada).toBeHidden();
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
      machineToken = machine.token;
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
          { type: "tool", id: "t1", name: "mcp__yapm__get_issue", input: '{"id":"PF-1"}' },
          { type: "tool_result", id: "t1", error: false, text: '{"title":"Statements"}' },
          { type: "tool", id: "t2", name: "Bash", input: '{"command":"ls exports"}' },
          {
            type: "permission",
            tool: "WebFetch",
            resource: "https://bank.example.com",
            requestId: "r1",
            state: "waiting",
          },
          { type: "permission", tool: "WebFetch", requestId: "r1", state: "rejected" },
        ],
      });
      await expect(page.getByText("Pulling the statements from the bank export.")).toBeVisible();
      // Tool calls read as what they did, paired with their result and closed until opened.
      const getIssue = page.getByRole("button", { name: /Get issue PF-1/ });
      await expect(getIssue).toHaveAttribute("aria-expanded", "false");
      await getIssue.click();
      await expect(page.getByText('"title": "Statements"')).toBeVisible();
      const ls = page.getByRole("button", { name: /Run command ls exports/ });
      await expect(ls.getByText("Running")).toBeVisible();
      await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
      // The run itself, besides the call still waiting on its result.
      await expect(page.getByText("Running", { exact: true })).toHaveCount(2);
      // A long run keeps showing its newest output, past the hub's 200 batches a request.
      for (let seq = 1; seq <= 200; seq++)
        await runner(`/runs/${runId}/logs`, machine.token, {
          seq,
          events: [{ type: "text", text: `Checked statement ${seq}.` }],
        });
      await expect(page.getByText("Checked statement 200.")).toBeVisible();

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
      await page.getByRole("button", { name: "New project" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New project" });
      await dialog.getByLabel("Name").fill("Pay off the car");
      await dialog.getByLabel("Summary").fill("Owe nothing on the car by spring");
      await choose(page, dialog.getByLabel("Lead"), "Ada");
      await dialog.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByLabel("Project name")).toHaveValue("Pay off the car");

      await page.getByLabel("New milestone").fill("Half paid");
      await page.getByLabel("Milestone date").click();
      await page.getByLabel("Type a date").fill("2030-01-15");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Milestone date")).toHaveText(/Jan 15, 2030/);
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
      // Markdown shortcuts turn into formatting as you type, like Linear.
      await page.getByLabel("Content").click();
      await page.keyboard.type("# Plan");
      await page.keyboard.press("Enter");
      await page.keyboard.type("- Pay **200** extra a month");
      await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
      await expect(page.getByLabel("Content").locator("li strong")).toHaveText("200");
      await page.waitForTimeout(1000);
      const doc = await mcp("list_documents", { query: "payment" });
      expect(doc.documents[0]).toMatchObject({ title: "Payment plan", project: "Pay off the car" });

      await page.getByRole("link", { name: /Inbox/ }).click();
      await expect(
        page.getByRole("button", { name: /Pay off the car.*Ada posted an update/ }),
      ).toBeVisible();
    });

    test("colours statuses, labels, projects and agents, like Linear", async () => {
      /** Whether a computed CSS colour has a visible hue rather than being a grey. */
      const hued = async (locator: ReturnType<Page["locator"]>, property: string) => {
        const css = await locator.evaluate(
          (el, p) => getComputedStyle(el).getPropertyValue(p),
          property,
        );
        const [r = 0, g = 0, b = 0] = (css.match(/\d+/g) ?? []).map(Number);
        return Math.max(r, g, b) - Math.min(r, g, b) > 12;
      };

      // Ada makes a label without picking a colour and puts it on the bill.
      await mcp("create_issue_label", { name: "Bills", team: "PF" });
      await mcp("update_issue", { id: "PF-1", labels: ["Bills"] });

      await page.goto("/team/PF");
      const row = page.getByRole("button", { name: /PF-1 Pay the electricity bill/ });
      await expect(row.getByText("Bills")).toBeVisible();
      expect(await hued(row.locator("svg circle").first(), "stroke")).toBe(true);
      expect(
        await hued(
          row.getByText("Bills").locator("xpath=preceding-sibling::span"),
          "background-color",
        ),
      ).toBe(true);

      await page.getByRole("link", { name: "Projects" }).click();
      const project = page.getByRole("button", { name: /Pay off the car/ });
      expect(await hued(project.locator("span").first(), "background-color")).toBe(true);
      expect(await hued(project.getByTitle("Ada"), "color")).toBe(true);
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
      await choose(page, page.getByLabel("Cycle length"), "2 weeks");

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
      await page.getByRole("button", { name: "Save view" }).click();
      const viewDialog = page.getByRole("dialog", { name: "Save as view" });
      await viewDialog.getByLabel("View name").fill("Ready to start");
      await viewDialog.getByRole("button", { name: "Save view" }).click();
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
      await choose(page, editor.getByLabel("Repeats"), "Weekly");
      await choose(page, editor.getByLabel("On day"), "Mon");
      await editor.getByLabel("Time of day").click();
      await page.getByLabel("Filter", { exact: true }).fill("18:30");
      await page.keyboard.press("Enter");
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
      await expect(page.getByLabel("Issue description")).toHaveText(/Amount:\s*Due:/);
      await page.keyboard.press("Escape");
    });

    test("holds urgent issues to an SLA, searches everything and shows the roadmap", async () => {
      await page.getByRole("link", { name: /Personal Finance/ }).click();
      await page.getByRole("link", { name: "Settings" }).click();
      await choose(page, page.getByLabel("Urgent SLA"), "1 day");
      await expect(page.getByRole("status")).toContainText("Team settings saved");

      await page.getByRole("link", { name: "Personal Finance" }).first().click();
      await page.keyboard.press("c");
      await page.getByLabel("Issue title").fill("Report the stolen card");
      await page.getByRole("button", { name: "No priority" }).click();
      await page.getByRole("option", { name: "Urgent" }).click();
      await page.getByRole("button", { name: "Create issue", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /Report the stolen card/ }).getByText(/SLA 2[34]h/),
      ).toBeVisible();

      await page.keyboard.press("Control+k");
      await page.getByPlaceholder("Type a command or search…").fill("payment");
      await page.getByRole("option", { name: "Payment plan" }).click();
      await expect(page.getByLabel("Document title")).toHaveValue("Payment plan");

      await page.getByRole("link", { name: "Projects" }).click();
      await page.getByRole("link", { name: "Roadmap" }).click();
      await expect(page.getByRole("button", { name: "Pay off the car" })).toBeVisible();
    });

    test("adds, renames and removes the team's statuses", async () => {
      await page.getByRole("link", { name: /Personal Finance/ }).click();
      await page.getByRole("link", { name: "Settings" }).click();
      await page.getByRole("button", { name: "Add started status" }).click();
      await page.getByLabel("Status name").fill("Waiting");
      await page.keyboard.press("Enter");
      await expect(page.getByText("Waiting", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Rename Waiting" }).click();
      await page.getByLabel("Status name").fill("On hold");
      await page.keyboard.press("Enter");
      await expect(page.getByText("On hold", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Remove On hold" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
      await expect(page.getByText("On hold", { exact: true })).toBeHidden();
    });

    test("coaches an agent with feedback, lessons and the handbook", async () => {
      // Feedback on the issue where the work happened, from Ada's comment.
      await page.goto("/issue/PF-1");
      // Matches the comment both as plain text and once the editor renders the mention.
      const comment = page.getByText("the bill is paid, receipt attached.");
      await comment.hover();
      await page.getByRole("button", { name: "Give feedback" }).first().click();
      await page
        .getByLabel("Feedback for Ada")
        .fill("Link the receipt, don't just say it's attached");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("Youssef gave feedback to Ada")).toBeVisible();
      await expect(page.getByText("Link the receipt, don't just say it's attached")).toBeVisible();
      const aboutIssue = await mcp("list_feedback", { issue: "PF-1" });
      expect(aboutIssue.map((f: { body: string }) => f.body)).toContain(
        "Link the receipt, don't just say it's attached",
      );

      await page.goto("/company");
      await page.getByRole("button", { name: /Ada/ }).first().click();
      await expect(page.getByText("Wait until payday")).toBeVisible();
      await page.getByLabel("Feedback").fill("Attach the receipt before closing a bill");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("Attach the receipt before closing a bill")).toBeVisible();

      // Ada reads it, rewrites her lessons and says what changed.
      const open = await mcp("list_feedback", { agent: "me", open: true });
      const note = open.find((f: { body: string }) => f.body.startsWith("Attach the receipt"));
      await mcp("update_user", { user: "me", lessons: "- Attach receipts to bills." });
      await mcp("address_feedback", { id: note.id, note: "Added a lesson about receipts" });
      await expect(page.getByLabel("Lessons").locator("li")).toHaveText(
        "Attach receipts to bills.",
      );
      await expect(page.getByText("✓ Added a lesson about receipts")).toBeVisible();

      await page.getByRole("button", { name: "Company" }).click();
      await page.getByRole("button", { name: "Handbook" }).click();
      await page.getByLabel("Handbook").fill("Money moves only with a receipt on the issue.");
      await page.getByText(/conventions, preferences and rules/).click();
      await expect(page.getByText("History (1 version)")).toBeVisible();
      expect(await mcp("get_handbook", {})).toEqual({
        handbook: "Money moves only with a receipt on the issue.",
      });
    });

    test("shows how the company is working in Insights", async () => {
      await page.getByRole("link", { name: "Insights" }).click();
      await expect(page.getByRole("region", { name: "Runs stopped" })).not.toContainText("–");
      const ada = page.getByRole("row", { name: /Ada/ });
      await expect(ada).toBeVisible();
      await page.getByRole("tab", { name: "30 days" }).click();
      await expect(page.getByRole("tab", { name: "30 days" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("row", { name: /Personal Finance/ })).toBeVisible();
      await ada.click();
      await expect(page.getByLabel("Lessons")).toBeVisible();
      expect((await mcp("get_metrics", { member: "me" })).current.runs).toBeGreaterThan(0);
    });

    test("watches the Claude plan's limits and what agents used", async () => {
      const resetsAt = Date.now() + 2 * 3_600_000;
      await page.request.post("/api/runner/heartbeat", {
        headers: { authorization: `Bearer ${machineToken}` },
        data: {
          runIds: [],
          claudeAccount: { email: "owner@example.com", subscriptionType: "max" },
          planUsage: {
            observedAt: Date.now(),
            source: "usage",
            available: true,
            limits: [
              { kind: "five_hour", label: "Current session (5 hours)", utilization: 42, resetsAt },
              { kind: "seven_day", label: "This week, all models", utilization: 85, resetsAt },
            ],
          },
        },
      });
      await page.getByRole("link", { name: "Usage" }).click();
      const plan = page.getByRole("region", { name: "owner@example.com" });
      await expect(plan.getByText("Max plan")).toBeVisible();
      await expect(plan.getByRole("meter", { name: "Current session (5 hours)" })).toHaveAttribute(
        "aria-valuenow",
        "42",
      );
      await expect(plan.getByText("Near the limit")).toBeVisible();
      await expect(plan.getByText("Used by MacBook")).toBeVisible();
      await page.getByRole("tab", { name: "Runs" }).click();
      await expect(page.getByRole("row", { name: /Ada/ })).toBeVisible();
      await page.getByRole("tab", { name: "Machine" }).click();
      await expect(page.getByRole("row", { name: /MacBook/ })).toBeVisible();
      await page.goto("/machines");
      await page.getByRole("button", { name: /MacBook/ }).click();
      const claude = page.getByRole("region", { name: "Claude" });
      await expect(claude.getByText("owner@example.com")).toBeVisible();
      await expect(claude.getByText("Max plan")).toBeVisible();
      await expect(claude.getByRole("meter", { name: "This week, all models" })).toHaveAttribute(
        "aria-valuenow",
        "85",
      );
    });

    test("adds a machine by pasting one command", async () => {
      await page.goto("/machines");
      await page.getByRole("button", { name: "Add machine" }).click();
      const command = page.getByText(/^curl -fsSL .*\/install\.sh \| sh -s -- --token lms_/);
      await expect(command).toBeVisible();
      const text = (await command.textContent()) ?? "";
      const origin = new URL(page.url()).origin;
      expect(text.startsWith(`curl -fsSL ${origin}/install.sh`)).toBe(true);

      // The hub serves the installer and the runner package the command fetches.
      const script = await page.request.get("/install.sh");
      expect(await script.text()).toContain(`${origin}/downloads/yapm-runner.tgz`);
      const tarball = await page.request.get("/downloads/yapm-runner.tgz");
      expect(tarball.ok()).toBe(true);
      expect((await tarball.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

      // What the installer does on the machine: enrol with the token, approved at once.
      const token = text.split("--token ")[1]?.trim();
      const enrolled = await page.request.post("/api/runner/enrol", {
        data: { name: "Studio Mac", tags: [], capacity: 1, setupToken: token },
      });
      expect((await enrolled.json()).status).toBe("active");
      await expect(page.getByText("Studio Mac is connected.")).toBeVisible();
      await page.getByRole("button", { name: "Open Studio Mac" }).click();

      // Renamed, it keeps the name it enrolled with, and goes back to it when cleared.
      const name = page.getByLabel("Name for Studio Mac");
      await expect(name).toHaveAttribute("placeholder", "Studio Mac");
      await name.fill("Music room");
      await name.press("Enter");
      await expect(page.getByText("Music room", { exact: true })).toBeVisible();
      await expect(page.getByText("Enrolled as Studio Mac")).toBeVisible();
      await page.reload();
      await expect(name).toHaveValue("Music room");
      await name.fill("");
      await name.press("Enter");
      await expect(page.getByText("Music room", { exact: true })).toBeHidden();
      await expect(name).toHaveValue("");

      // Tags being typed survive the page refreshing underneath them.
      const tags = page.getByLabel("Tags for Studio Mac");
      await tags.fill("studio");
      await page.waitForResponse((r) => !!r.request().postData()?.includes("machines {"), {
        timeout: 20_000,
      });
      await expect(tags).toHaveValue("studio");

      // Removed, links to it still open its page, now read-only.
      await page.getByRole("button", { name: "Remove" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
      await expect(page).toHaveURL(/\/machines$/);
      await page.goBack();
      await expect(page.getByText("Removed", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove" })).toBeHidden();
      await expect(name).toBeDisabled();
    });

    test("switches between light and dark themes from the command menu", async () => {
      await page.goto("/my-issues");
      await page.getByRole("button", { name: "Search and commands" }).click();
      await page.getByPlaceholder("Type a command or search…").fill("theme light");
      await page.getByRole("option", { name: "Change theme: light" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      if (process.env.SCREENSHOTS)
        await page.screenshot({ path: `${process.env.SCREENSHOTS}/light.png` });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.getByRole("button", { name: "Search and commands" }).click();
      await page.getByPlaceholder("Type a command or search…").fill("theme dark");
      await page.getByRole("option", { name: "Change theme: dark" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      await page.locator("main").click();
      await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await expect(help.getByText("Move to cycle")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(help).toBeHidden();
    });

    test("installs as an app and shows pushed notifications", async () => {
      const manifest = await page.request.get("/manifest.webmanifest");
      expect(manifest.ok()).toBe(true);
      expect(await manifest.json()).toMatchObject({ display: "standalone", start_url: "/" });
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
    test("writes like Linear: shortcuts, slash commands, mentions, checklists and code", async () => {
      await page.goto("/issue/PF-2");
      const description = page.getByLabel("Issue description");
      await description.click();
      await page.keyboard.type("## Options");
      await page.keyboard.press("Enter");

      // `/` opens the block menu.
      await page.keyboard.type("/check");
      await expect(page.getByRole("option", { name: "Checklist" })).toBeVisible();
      if (process.env.SCREENSHOTS)
        await page.screenshot({ path: `${process.env.SCREENSHOTS}/editor-slash.png` });
      await page.getByRole("option", { name: "Checklist" }).click();
      await page.keyboard.type("Call the bank");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Compare tariffs");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");

      // `@` mentions people and issues, shown as chips.
      await page.keyboard.type("Ask @Yous");
      await expect(page.getByRole("option", { name: "Youssef" })).toBeVisible();
      if (process.env.SCREENSHOTS)
        await page.screenshot({ path: `${process.env.SCREENSHOTS}/editor-mention.png` });
      await page.getByRole("option", { name: "Youssef" }).click();
      await page.keyboard.type("about @electricity");
      await page.getByRole("option", { name: /PF-1 Pay the electricity bill/ }).click();
      await expect(description.locator("[data-mention=user]")).toHaveText(/Youssef/);
      await expect(description.locator("[data-mention=issue]")).toContainText("PF-1");

      // Checklist boxes tick in place.
      await description.locator('li[data-type="taskItem"] input').first().check();

      // Selecting text shows the formatting toolbar, in a window short enough to scroll.
      await page.setViewportSize({ width: 1280, height: 400 });
      // The click lands after the text. Not `End`: on macOS that scrolls to the bottom.
      await description.getByText("Compare tariffs", { exact: true }).click();
      for (let i = 0; i < "tariffs".length; i++) await page.keyboard.press("Shift+ArrowLeft");
      const toolbar = page.getByRole("toolbar", { name: "Formatting" });
      await expect(toolbar).toBeVisible();
      if (process.env.SCREENSHOTS)
        await page.screenshot({ path: `${process.env.SCREENSHOTS}/editor-toolbar.png` });
      await toolbar.getByLabel("Bold").click();
      await expect(description.locator("strong")).toHaveText("tariffs");
      await page.setViewportSize({ width: 1280, height: 720 });

      await page.getByLabel("Issue title").click();
      await expect
        .poll(async () => (await mcp("get_issue", { id: "PF-2" })).description as string)
        .toContain("- [x] Call the bank");
      const saved = (await mcp("get_issue", { id: "PF-2" })).description as string;
      expect(saved).toContain("## Options");
      expect(saved).toContain("- [ ] Compare **tariffs**");
      expect(saved).toContain("Ask @Youssef about PF-1");

      // A fenced code block in a comment, highlighted once posted.
      await page.getByLabel("Leave a comment").click();
      await page.keyboard.type("```ts");
      await page.keyboard.press("Enter");
      await page.keyboard.type("const total = 42;");
      await page.keyboard.press("ControlOrMeta+Enter");
      const posted = page.locator("li .rich pre").last();
      await expect(posted).toHaveText("const total = 42;");
      await expect(posted.locator(".hljs-keyword")).toHaveText("const");
      if (process.env.SCREENSHOTS)
        await page.screenshot({ path: `${process.env.SCREENSHOTS}/editor-code.png` });
      // Agents write Markdown through MCP; it reads like Linear's: tables, collapsible sections.
      await mcp("create_comment", {
        issueId: "PF-2",
        body: "| Tariff | Price |\n| --- | --- |\n| Green | 31p |\n\n+++ Workings\nUnit rate *times* usage.\n+++",
      });
      const agentReply = page.locator("li .rich", { hasText: "Workings" });
      await expect(agentReply.locator("td").first()).toHaveText("Green");
      await expect(agentReply.getByText("Unit rate")).toBeHidden();
      await agentReply.getByRole("button", { name: "Expand section" }).click();
      await expect(agentReply.locator("em")).toHaveText("times");
      const comments = await mcp("list_comments", { issueId: "PF-2" });
      expect(JSON.stringify(comments)).toContain("```ts\\nconst total = 42;\\n```");
    });
    test("right-clicks issues and comments for Linear's context menus", async () => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/team/PF");
      await page.getByRole("button", { name: "list" }).click();
      const row = page.getByRole("button", { name: /PF-2.*cheaper tariff/ });

      // The menu's shortcuts work inside it: S opens Status, already focused for the keyboard.
      await row.click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: /Status/ })).toBeVisible();
      if (process.env.SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.SCREENSHOTS}/context-menu.png`,
          animations: "disabled",
        });
      await page.keyboard.press("s");
      if (process.env.SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.SCREENSHOTS}/context-submenu.png`,
          animations: "disabled",
        });
      await page.getByRole("menuitem", { name: "Todo" }).click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      const todo = page.getByRole("region", { name: "Todo" });
      await expect(todo.getByRole("button", { name: /PF-2/ })).toBeVisible();

      // Submenus open on hover, beside the entry.
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: /Copy/ }).hover();
      await page.getByRole("menuitem", { name: /Copy ID/ }).click();
      await expect(page.getByRole("status")).toContainText("Copied PF-2 to clipboard");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("PF-2");

      // Typed dates work in the due date submenu.
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: /Due date/ }).hover();
      await page.getByRole("textbox", { name: /Due date/ }).fill("tomorrow");
      await page.keyboard.press("Enter");
      await expect(row).toContainText("Tomorrow");

      // Archive, then undo it from the toast.
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive" }).click();
      await expect(page.getByRole("status")).toContainText("Archived PF-2");
      await expect(row).toBeHidden();
      await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
      await expect(row).toBeVisible();

      // Escape closes it without doing anything.
      await row.click({ button: "right" });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);

      // On a phone, where Safari never sends a right-click, a long press opens it instead.
      const box = await row.boundingBox();
      const touch = { identifier: 1, clientX: (box?.x ?? 0) + 20, clientY: (box?.y ?? 0) + 10 };
      await row.dispatchEvent("touchstart", { touches: [touch], changedTouches: [touch] });
      await page.waitForTimeout(600);
      await row.dispatchEvent("touchend", { touches: [], changedTouches: [touch] });
      await row.dispatchEvent("click");
      await expect(page.getByRole("menuitem", { name: /Status/ })).toBeVisible();
      await expect(page).toHaveURL(/\/team\/PF/);
      await page.keyboard.press("Escape");

      // Projects, documents and teams share Linear's Copy submenu.
      await page.goto("/projects");
      await page
        .getByRole("button", { name: /Pay off the car/ })
        .first()
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: /Copy/ }).hover();
      await page.getByRole("menuitem", { name: "Copy as Markdown link" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
        /^\[Pay off the car\]\(http.*\/project\/.+\)$/,
      );
      await page.getByRole("link", { name: /Personal Finance/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: /Copy/ }).hover();
      await page.getByRole("menuitem", { name: "Copy ID" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("PF");

      // Comments: react from the menu.
      await page.goto("/issue/PF-1");
      const comment = page.getByText("Paid through the bank app.");
      await comment.click({ button: "right" });
      await page.getByRole("menuitem", { name: /Add reaction/ }).hover();
      await page.getByRole("menuitem", { name: /Party Popper/ }).click();
      await expect(page.getByRole("button", { name: /🎉 1/ })).toBeVisible();

      // Or search the full picker, and pick with the keyboard.
      await page.getByRole("button", { name: "Add reaction" }).last().click();
      await page.getByPlaceholder("Search emoji…").fill("rocket");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: /🚀 1/ })).toBeVisible();
    });

    test("connects an agent's MCP server with a pasted token, then approves it", async () => {
      const asked = await mcp("create_mcp_server", {
        name: "notion",
        url: "https://mcp.example.com/mcp",
        auth: "token",
        howToConnect: "Create an integration token in Notion settings.",
        reason: "I need to read the team wiki.",
      });
      await page.goto(`/request/${asked.id}`);
      await expect(page.getByText("Create an integration token in Notion settings.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Approve once" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Always allow" })).toBeDisabled();

      await page.getByLabel("Token").fill("secret-token");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
      await page.getByRole("button", { name: "Approve once" }).click();
      await expect(page.getByText("Approved once by Youssef")).toBeVisible();
      expect(await mcp("get_request", { id: asked.id })).toMatchObject({
        status: "approved",
      });
    });

    test("sends the owner to the provider to sign in to an OAuth server", async () => {
      // The hub can't reach a provider from here, so the server is a token one that the page is
      // told signs in with OAuth, and the hub's answer to connecting is a fixed URL.
      const asked = await mcp("create_mcp_server", {
        name: "linear",
        url: "https://mcp.example.com/linear",
        auth: "token",
        reason: "I need to read tickets.",
      });
      await page.route("**/graphql", async (route) => {
        const query: string = route.request().postDataJSON().query;
        if (query.includes("mcpServerConnect"))
          return route.fulfill({
            json: { data: { mcpServerConnect: { authorizationUrl: "/signed-in-elsewhere" } } },
          });
        const response = await route.fetch();
        const body = await response.json();
        if (body.data?.request?.mcpServer) body.data.request.mcpServer.auth = "oauth";
        return route.fulfill({ response, json: body });
      });
      await page.goto(`/request/${asked.id}`);
      await expect(page.getByRole("button", { name: "Approve once" })).toBeDisabled();
      await page.getByRole("button", { name: "Sign in to linear" }).click();
      await page.waitForURL("**/signed-in-elsewhere");
      await page.unroute("**/graphql");
    });

    test("signs in on another tab and connects with the pasted address", async () => {
      // As above, the page is told the sign-in ends on localhost, and connecting answers a URL.
      const asked = await mcp("create_mcp_server", {
        name: "slack",
        url: "https://mcp.example.com/slack",
        auth: "token",
        reason: "I need to read the team channel.",
      });
      let pasted: unknown = null;
      await page.route("**/graphql", async (route) => {
        const body = route.request().postDataJSON();
        if (body.query.includes("mcpServerConnect")) {
          if (!body.variables.callbackUrl)
            return route.fulfill({
              json: { data: { mcpServerConnect: { authorizationUrl: "/signed-in-elsewhere" } } },
            });
          pasted = body.variables.callbackUrl;
          return route.fulfill({
            json: { errors: [{ message: "That address is from another sign-in." }] },
          });
        }
        const response = await route.fetch();
        const json = await response.json();
        if (json.data?.request?.mcpServer)
          Object.assign(json.data.request.mcpServer, { auth: "oauth", pastesCallback: true });
        return route.fulfill({ response, json });
      });
      await page.goto(`/request/${asked.id}`);
      const [tab] = await Promise.all([
        page.waitForEvent("popup"),
        page.getByRole("button", { name: "Sign in to slack" }).click(),
      ]);
      await tab.waitForURL("**/signed-in-elsewhere");
      await tab.close();
      const landed = "http://localhost:3118/callback?code=c&state=s";
      await page.getByLabel("Paste the address you land on").fill(landed);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByText("That address is from another sign-in.")).toBeVisible();
      expect(pasted).toBe(landed);
      await page.unroute("**/graphql");
    });

    test("asks only for approval when an OAuth server is already signed in to", async () => {
      const asked = await mcp("create_mcp_server", {
        name: "calendar",
        url: "https://mcp.example.com/calendar",
        auth: "token",
        reason: "I need the team's calendar.",
      });
      await page.route("**/graphql", async (route) => {
        if (!route.request().postDataJSON().query.includes("mcpServer {")) return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        Object.assign(body.data.request.mcpServer, { auth: "oauth", status: "ready" });
        return route.fulfill({ response, json: body });
      });
      await page.goto(`/request/${asked.id}`);
      await expect(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
      await expect(page.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
      // The page's live refetches may still be in flight.
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });

    test("changes show at once on a slow network, and a failed one rolls back", async () => {
      await page.goto("/team/PF");
      await page.getByRole("button", { name: "list" }).click();
      await page.keyboard.press("c");
      await page.getByLabel("Issue title").fill("Renew the passport");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status")).toContainText("Created");
      const row = page.getByRole("button", { name: /Renew the passport/ });

      // The hub answers changes only when released: the list must not wait for it.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let fail = false;
      await page.route("**/graphql", async (route) => {
        if (!route.request().postDataJSON().query.includes("issueBatchUpdate"))
          return route.fallback();
        if (fail) return route.fulfill({ json: { errors: [{ message: "The hub said no." }] } });
        await held;
        return route.fallback();
      });
      await row.hover();
      await page.keyboard.press("s");
      await page.getByRole("option", { name: "Todo" }).click();
      const todo = page.getByRole("region", { name: "Todo" });
      await expect(todo.getByRole("button", { name: /Renew the passport/ })).toBeVisible({
        timeout: 1000,
      });
      release();

      fail = true;
      await row.hover();
      await page.keyboard.press("s");
      await page.getByRole("option", { name: "Done" }).click();
      await expect(page.getByRole("status")).toContainText("The hub said no.");
      await expect(todo.getByRole("button", { name: /Renew the passport/ })).toBeVisible();
      await page.unroute("**/graphql");
    });

    test("shows a loading bar while waiting on the hub", async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/graphql", async (route) => {
        if (route.request().postDataJSON().query.includes("projects(")) await held;
        return route.fallback();
      });
      await page.getByRole("button", { name: /Renew the passport/ }).hover();
      await page.keyboard.press("Shift+P");
      await expect(page.getByRole("progressbar", { name: "Loading" })).toBeVisible();
      release();
      await expect(page.getByRole("progressbar", { name: "Loading" })).toBeHidden();
      await page.keyboard.press("Escape");
      await page.unroute("**/graphql");
    });
  });
