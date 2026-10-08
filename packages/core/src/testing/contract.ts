import { beforeAll, describe, expect, it } from "vitest";
import { SoftwareAuthenticator } from "./authenticator.js";

export type FetchLike = (request: Request) => Promise<Response>;

/** A tiny HTTP client with a cookie jar, so tests behave like a browser session. */
export class TestClient {
  private cookies = new Map<string, string>();

  constructor(
    private readonly send: FetchLike,
    readonly origin = "http://localhost",
  ) {}

  async request(path: string, init: RequestInit & { json?: unknown; token?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    else if (this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    if (!headers.has("origin")) headers.set("origin", this.origin);
    const response = await this.send(
      new Request(new URL(path, this.origin), {
        ...init,
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = "", ...attrs] = cookie.split(";");
      const [name = "", value = ""] = pair.split("=");
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    return response;
  }

  async json<T = Record<string, unknown>>(
    path: string,
    init?: Parameters<TestClient["request"]>[1],
  ) {
    const response = await this.request(path, init);
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as T };
    } catch {
      throw new Error(
        `${path} returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
      );
    }
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    token?: string,
  ) {
    const response = await this.request("/graphql", {
      method: "POST",
      json: { query, variables },
      ...(token ? { token } : {}),
    });
    return (await response.json()) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
    };
  }

  clearCookies() {
    this.cookies.clear();
  }
}

/**
 * Behaviour every hub deployment must have, whatever platform runs it.
 * Each adapter runs this suite against a fresh, migrated, empty database.
 */
export interface ContractOptions {
  /**
   * Takes the hub's answer to a WebSocket upgrade and returns the accepted client socket,
   * where the platform's fetch can do that (Workers can; Node's is covered end to end).
   */
  liveSocket?: (response: Response) => WebSocket | null;
}

export function hubContract(
  platform: string,
  makeFetch: () => Promise<FetchLike>,
  options: ContractOptions = {},
) {
  describe(`hub contract (${platform})`, () => {
    let client: TestClient;
    let send: FetchLike;
    const authenticator = new SoftwareAuthenticator();
    // Shared across the issue tests, which build on each other like a real session.
    let ceoToken = "";
    let teamId = "";
    let labelId = "";
    let issueId = "";
    let childId = "";

    beforeAll(async () => {
      send = await makeFetch();
      client = new TestClient(send);
    });

    it("reports health and platform", async () => {
      const { status, body } = await client.json("/api/health");
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, platform });
    });

    it("starts empty and needs setup", async () => {
      expect((await client.json("/api/setup")).body).toEqual({ needsSetup: true });
      const result = await client.graphql("{ viewer { id } }");
      expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
      expect((await client.json("/api/auth/me")).status).toBe(401);
      expect((await client.json("/api/live")).status).toBe(401);
    });

    it("validates setup input", async () => {
      const { status } = await client.json("/api/setup/options", {
        method: "POST",
        json: { companyName: " " },
      });
      expect(status).toBe(400);
    });

    it("sets up the company with the owner's passkey", async () => {
      const options = await client.json<{ challengeId: string; options: never }>(
        "/api/setup/options",
        {
          method: "POST",
          json: { companyName: "Youssef Inc", ownerName: "Youssef" },
        },
      );
      expect(options.status).toBe(200);
      const credential = await authenticator.register(options.body.options, client.origin);
      const verify = await client.json<{ viewer: { kind: string; name: string } }>(
        "/api/setup/verify",
        {
          method: "POST",
          json: { challengeId: options.body.challengeId, response: credential },
        },
      );
      expect(verify.status).toBe(200);
      expect(verify.body.viewer).toMatchObject({ kind: "owner", name: "Youssef" });

      const me = await client.json<{ viewer: { kind: string } }>("/api/auth/me");
      expect(me.body.viewer.kind).toBe("owner");
      expect((await client.json("/api/setup")).body).toEqual({ needsSetup: false });
    });

    it("refuses a second setup", async () => {
      const { status } = await client.json("/api/setup/options", {
        method: "POST",
        json: { companyName: "Other", ownerName: "Someone" },
      });
      expect(status).toBe(409);
    });

    it("starts blank: just the owner and the CEO, no teams or labels", async () => {
      const result = await client.graphql<{
        organization: { name: string; urlKey: string };
        viewer: { kind: string; isMe: boolean; directReports: { nodes: { name: string }[] } };
        teams: { nodes: unknown[] };
        issueLabels: { nodes: unknown[] };
        users: {
          nodes: {
            name: string;
            kind: string;
            manager: { name: string } | null;
            charter: string | null;
          }[];
        };
      }>(`{
        organization { name urlKey }
        viewer { kind isMe directReports { nodes { name } } }
        teams { nodes { id } }
        issueLabels { nodes { id } }
        users { nodes { name kind manager { name } charter } }
      }`);
      expect(result.errors).toBeUndefined();
      const data = result.data;
      if (!data) throw new Error("no data");
      expect(data.organization).toEqual({ name: "Youssef Inc", urlKey: "youssef-inc" });
      expect(data.viewer).toMatchObject({
        kind: "owner",
        isMe: true,
        directReports: { nodes: [{ name: "CEO" }] },
      });
      expect(data.teams.nodes).toEqual([]);
      expect(data.issueLabels.nodes).toEqual([]);
      expect(data.users.nodes.map((u) => u.name).sort()).toEqual(["CEO", "Youssef"]);
      const ceo = data.users.nodes.find((u) => u.name === "CEO");
      expect(ceo).toMatchObject({ kind: "agent", manager: { name: "Youssef" } });
      expect(ceo?.charter).toContain("starts empty");
    });

    it("records every founding change in the audit log", async () => {
      const result = await client.graphql<{
        auditEntries: { nodes: { action: string; actor: { name: string } }[] };
      }>("{ auditEntries(first: 100) { nodes { action actor { name } } } }");
      const actions = result.data?.auditEntries.nodes.map((n) => n.action) ?? [];
      expect(actions.filter((a) => a === "user.create")).toHaveLength(2);
      expect(actions).toContain("workspace.create");
      expect(result.data?.auditEntries.nodes.every((n) => n.actor.name === "Youssef")).toBe(true);
    });

    it("signs out and back in with the passkey", async () => {
      await client.request("/api/auth/logout", { method: "POST" });
      expect((await client.json("/api/auth/me")).status).toBe(401);

      const options = await client.json<{ challengeId: string; options: never }>(
        "/api/auth/login/options",
        {
          method: "POST",
        },
      );
      const assertion = await authenticator.authenticate(options.body.options, client.origin);
      const verify = await client.json("/api/auth/login/verify", {
        method: "POST",
        json: { challengeId: options.body.challengeId, response: assertion },
      });
      expect(verify.status).toBe(200);
      expect((await client.json("/api/auth/me")).status).toBe(200);

      // Challenges are single use.
      const replay = await client.json("/api/auth/login/verify", {
        method: "POST",
        json: { challengeId: options.body.challengeId, response: assertion },
      });
      expect(replay.status).toBe(400);
    });

    it("refuses cookie-authenticated writes from another origin", async () => {
      const response = await client.request("/graphql", {
        method: "POST",
        json: { query: "{ viewer { id } }" },
        headers: { origin: "https://evil.example" },
      });
      expect(response.status).toBe(403);
    });

    it("issues agent API tokens that act as that agent", async () => {
      const users = await client.graphql<{ users: { nodes: { id: string; name: string }[] } }>(
        "{ users { nodes { id name } } }",
      );
      const ceoId = users.data?.users.nodes.find((u) => u.name === "CEO")?.id;
      const created = await client.graphql<{
        apiTokenCreate: { token: string; user: { name: string } };
      }>(
        'mutation($userId: String) { apiTokenCreate(name: "CEO runner", userId: $userId) { token user { name } } }',
        { userId: ceoId },
      );
      expect(created.errors).toBeUndefined();
      const token = created.data?.apiTokenCreate.token ?? "";
      expect(token).toMatch(/^los_/);

      const asCeo = await client.graphql<{ viewer: { name: string; kind: string } }>(
        "{ viewer { name kind } }",
        undefined,
        token,
      );
      expect(asCeo.data?.viewer).toEqual({ name: "CEO", kind: "agent" });

      const forbidden = await client.graphql(
        'mutation { apiTokenCreate(name: "escalate") { token } }',
        undefined,
        token,
      );
      expect(forbidden.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      const bad = await client.request("/graphql", {
        method: "POST",
        json: { query: "{ viewer { id } }" },
        token: "los_not-a-real-token",
      });
      expect(bad.status).toBe(401);
      ceoToken = token;
    });

    it("creates a team with Linear's default workflow", async () => {
      const result = await client.graphql<{
        teamCreate: {
          success: boolean;
          team: { id: string; key: string; states: { nodes: { name: string; type: string }[] } };
        };
      }>(
        `mutation { teamCreate(input: { name: "Personal Finance" }) {
          success team { id key states { nodes { name type } } }
        } }`,
      );
      expect(result.errors).toBeUndefined();
      const team = result.data?.teamCreate.team;
      teamId = team?.id ?? "";
      expect(team?.key).toBe("PF");
      expect(team?.states.nodes.map((s) => s.name)).toEqual([
        "Triage",
        "Backlog",
        "Todo",
        "In Progress",
        "In Review",
        "Done",
        "Canceled",
        "Duplicate",
      ]);

      const clash = await client.graphql(
        'mutation { teamCreate(input: { name: "Other", key: "pf" }) { success } }',
      );
      expect(clash.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    });

    it("creates issues with team identifiers, labels and sub-issues", async () => {
      const label = await client.graphql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        'mutation($teamId: String) { issueLabelCreate(input: { name: "Bills", color: "#eb5757", teamId: $teamId }) { issueLabel { id } } }',
        { teamId },
      );
      expect(label.errors).toBeUndefined();
      labelId = label.data?.issueLabelCreate.issueLabel.id ?? "";

      const create = (input: Record<string, unknown>, token?: string) =>
        client.graphql<{
          issueCreate: {
            issue: {
              id: string;
              identifier: string;
              priorityLabel: string;
              state: { name: string };
              creator: { name: string };
              labels: { nodes: { name: string }[] };
              parent: { identifier: string } | null;
            };
          };
        }>(
          `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue {
            id identifier priorityLabel state { name } creator { name } labels { nodes { name } } parent { identifier }
          } } }`,
          { input: { teamId, ...input } },
          token,
        );

      const first = await create({
        title: "Pay the electricity bill",
        priority: 2,
        labelIds: [labelId],
      });
      expect(first.errors).toBeUndefined();
      expect(first.data?.issueCreate.issue).toMatchObject({
        identifier: "PF-1",
        priorityLabel: "High",
        state: { name: "Backlog" },
        creator: { name: "Youssef" },
        labels: { nodes: [{ name: "Bills" }] },
        parent: null,
      });
      issueId = first.data?.issueCreate.issue.id ?? "";

      // Agents act with their own token, and the history says so.
      const second = await create({ title: "Find a cheaper tariff", parentId: issueId }, ceoToken);
      expect(second.data?.issueCreate.issue).toMatchObject({
        identifier: "PF-2",
        creator: { name: "CEO" },
        parent: { identifier: "PF-1" },
      });
      childId = second.data?.issueCreate.issue.id ?? "";

      const empty = await create({ title: "  " });
      expect(empty.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
    });

    it("updates issues by identifier and records their history", async () => {
      const users = await client.graphql<{ users: { nodes: { id: string; name: string }[] } }>(
        "{ users { nodes { id name } } }",
      );
      const ceoId = users.data?.users.nodes.find((u) => u.name === "CEO")?.id;
      const states = await client.graphql<{
        team: { states: { nodes: { id: string; type: string }[] } };
      }>("query($id: String!) { team(id: $id) { states { nodes { id type } } } }", { id: "PF" });
      const started = states.data?.team.states.nodes.find((s) => s.type === "started")?.id;
      const completed = states.data?.team.states.nodes.find((s) => s.type === "completed")?.id;

      const update = await client.graphql<{
        issueUpdate: {
          issue: { assignee: { name: string }; state: { type: string }; startedAt: string | null };
        };
      }>(
        `mutation($input: IssueUpdateInput!) { issueUpdate(id: "pf-1", input: $input) {
          issue { assignee { name } state { type } startedAt }
        } }`,
        { input: { assigneeId: ceoId, stateId: started } },
      );
      expect(update.errors).toBeUndefined();
      expect(update.data?.issueUpdate.issue).toMatchObject({
        assignee: { name: "CEO" },
        state: { type: "started" },
      });
      expect(update.data?.issueUpdate.issue.startedAt).not.toBeNull();

      const batch = await client.graphql<{
        issueBatchUpdate: {
          issues: { identifier: string; state: { type: string }; completedAt: string | null }[];
        };
      }>(
        `mutation($ids: [String!]!, $stateId: String) { issueBatchUpdate(ids: $ids, input: { stateId: $stateId, priority: 1 }) {
          issues { identifier state { type } completedAt }
        } }`,
        { ids: [issueId, childId], stateId: completed },
      );
      expect(batch.errors).toBeUndefined();
      expect(batch.data?.issueBatchUpdate.issues.map((i) => i.state.type)).toEqual([
        "completed",
        "completed",
      ]);
      expect(batch.data?.issueBatchUpdate.issues.every((i) => i.completedAt)).toBe(true);

      const history = await client.graphql<{
        issue: {
          history: {
            nodes: { action: string; actor: { name: string }; data: Record<string, unknown> }[];
          };
        };
      }>('{ issue(id: "PF-1") { history { nodes { action actor { name } data } } } }');
      const actions = history.data?.issue.history.nodes.map((n) => n.action);
      expect(actions).toEqual(["issue.create", "issue.update", "issue.update"]);
      expect(history.data?.issue.history.nodes[1]?.data).toMatchObject({
        assigneeId: { from: null, to: ceoId },
      });
    });

    it("filters, searches and pages issues like Linear", async () => {
      const query = async (filter: unknown) => {
        const result = await client.graphql<{ issues: { nodes: { identifier: string }[] } }>(
          "query($filter: IssueFilter) { issues(filter: $filter) { nodes { identifier } } }",
          { filter },
        );
        expect(result.errors).toBeUndefined();
        return result.data?.issues.nodes.map((n) => n.identifier).sort();
      };
      expect(await query({ labels: { some: { name: { eq: "Bills" } } } })).toEqual(["PF-1"]);
      expect(await query({ parent: { null: true } })).toEqual(["PF-1"]);
      expect(await query({ creator: { isMe: { eq: true } } })).toEqual(["PF-1"]);
      expect(
        await query({ team: { key: { eq: "PF" } }, state: { type: { eq: "completed" } } }),
      ).toEqual(["PF-1", "PF-2"]);
      expect(
        await query({ or: [{ title: { containsIgnoreCase: "TARIFF" } }, { number: { eq: 1 } }] }),
      ).toEqual(["PF-1", "PF-2"]);
      expect(await query({ priority: { lte: 1 }, assignee: { null: true } })).toEqual(["PF-2"]);

      const page = await client.graphql<{
        issues: {
          nodes: { identifier: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      }>("{ issues(first: 1) { nodes { identifier } pageInfo { hasNextPage endCursor } } }");
      expect(page.data?.issues.pageInfo.hasNextPage).toBe(true);
      const next = await client.graphql<{
        issues: { nodes: { identifier: string }[]; pageInfo: { hasNextPage: boolean } };
      }>(
        "query($after: String) { issues(first: 1, after: $after) { nodes { identifier } pageInfo { hasNextPage } } }",
        { after: page.data?.issues.pageInfo.endCursor },
      );
      expect(next.data?.issues.pageInfo.hasNextPage).toBe(false);
      expect(
        [page.data?.issues.nodes[0]?.identifier, next.data?.issues.nodes[0]?.identifier].sort(),
      ).toEqual(["PF-1", "PF-2"]);

      const search = await client.graphql<{ searchIssues: { nodes: { identifier: string }[] } }>(
        '{ searchIssues(term: "electricity") { nodes { identifier } } }',
      );
      expect(search.data?.searchIssues.nodes.map((n) => n.identifier)).toEqual(["PF-1"]);
      const byId = await client.graphql<{ searchIssues: { nodes: { identifier: string }[] } }>(
        '{ searchIssues(term: "pf-2") { nodes { identifier } } }',
      );
      expect(byId.data?.searchIssues.nodes.map((n) => n.identifier)).toEqual(["PF-2"]);
    });

    it("threads comments with reactions, and only authors edit them", async () => {
      const top = await client.graphql<{ commentCreate: { comment: { id: string } } }>(
        'mutation($issueId: String!) { commentCreate(input: { issueId: $issueId, body: "Paid via the app." }) { comment { id } } }',
        { issueId },
      );
      const commentId = top.data?.commentCreate.comment.id ?? "";
      const reply = await client.graphql(
        'mutation($issueId: String!, $parentId: String) { commentCreate(input: { issueId: $issueId, body: "Noted.", parentId: $parentId }) { success } }',
        { issueId, parentId: commentId },
        ceoToken,
      );
      expect(reply.errors).toBeUndefined();
      const react = await client.graphql<{
        reactionCreate: { reaction: { id: string; emoji: string } };
      }>(
        'mutation($commentId: String) { reactionCreate(input: { emoji: "👍", commentId: $commentId }) { reaction { id emoji } } }',
        { commentId },
        ceoToken,
      );
      expect(react.data?.reactionCreate.reaction.emoji).toBe("👍");

      const forbidden = await client.graphql(
        'mutation($id: String!) { commentUpdate(id: $id, input: { body: "hijacked" }) { success } }',
        { id: commentId },
        ceoToken,
      );
      expect(forbidden.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      const thread = await client.graphql<{
        issue: {
          comments: {
            nodes: {
              body: string;
              user: { name: string };
              parent: { id: string } | null;
              children: { nodes: { body: string }[] };
              reactions: { emoji: string; user: { name: string } }[];
            }[];
          };
        };
      }>(
        `query($id: String!) { issue(id: $id) { comments { nodes {
        body user { name } parent { id } children { nodes { body } } reactions { emoji user { name } }
      } } } }`,
        { id: issueId },
      );
      const [first, second] = thread.data?.issue.comments.nodes ?? [];
      expect(first).toMatchObject({
        body: "Paid via the app.",
        user: { name: "Youssef" },
        parent: null,
        children: { nodes: [{ body: "Noted." }] },
        reactions: [{ emoji: "👍", user: { name: "CEO" } }],
      });
      expect(second).toMatchObject({ user: { name: "CEO" }, parent: { id: commentId } });

      const deleted = await client.graphql<{ commentDelete: { success: boolean } }>(
        "mutation($id: String!) { commentDelete(id: $id) { success } }",
        { id: commentId },
      );
      expect(deleted.data?.commentDelete.success).toBe(true);
      const after = await client.graphql<{ issue: { comments: { nodes: unknown[] } } }>(
        "query($id: String!) { issue(id: $id) { comments { nodes { id } } } }",
        { id: issueId },
      );
      expect(after.data?.issue.comments.nodes).toEqual([]);
    });

    it("relates issues and refuses sub-issue cycles", async () => {
      const relation = await client.graphql<{
        issueRelationCreate: { issueRelation: { id: string; type: string } };
      }>(
        "mutation($a: String!, $b: String!) { issueRelationCreate(input: { issueId: $a, relatedIssueId: $b, type: blocks }) { issueRelation { id type } } }",
        { a: childId, b: issueId },
      );
      expect(relation.errors).toBeUndefined();
      const view = await client.graphql<{
        issue: { inverseRelations: { nodes: { type: string; issue: { identifier: string } }[] } };
      }>('{ issue(id: "PF-1") { inverseRelations { nodes { type issue { identifier } } } } }');
      expect(view.data?.issue.inverseRelations.nodes).toEqual([
        { type: "blocks", issue: { identifier: "PF-2" } },
      ]);

      const cycle = await client.graphql(
        'mutation($parentId: String) { issueUpdate(id: "PF-1", input: { parentId: $parentId }) { success } }',
        { parentId: childId },
      );
      expect(cycle.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");

      const removed = await client.graphql<{ issueRelationDelete: { success: boolean } }>(
        "mutation($id: String!) { issueRelationDelete(id: $id) { success } }",
        { id: relation.data?.issueRelationCreate.issueRelation.id },
      );
      expect(removed.data?.issueRelationDelete.success).toBe(true);
    });

    it("offers live updates to signed-in members only, over WebSockets", async () => {
      expect((await client.json("/api/live")).status).toBe(426);
      const crossSite = await client.request("/api/live", {
        headers: { upgrade: "websocket", origin: "https://evil.example" },
      });
      expect(crossSite.status).toBe(403);
      if (!options.liveSocket) return;

      const response = await client.request("/api/live", {
        headers: { upgrade: "websocket" },
        token: ceoToken,
      });
      expect(response.status).toBe(101);
      const socket = options.liveSocket(response);
      if (!socket) throw new Error("no socket");
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no live event")), 5000);
        socket.addEventListener("message", (event) => {
          if (event.data === "pong") return;
          clearTimeout(timer);
          resolve(JSON.parse(String(event.data)));
        });
      });
      await client.request("/graphql", {
        method: "POST",
        json: { query: 'mutation { issueUpdate(id: "PF-1", input: { estimate: 3 }) { success } }' },
        headers: { "x-life-os-client": "tab-1" },
      });
      expect(await received).toMatchObject({ type: "change", clientId: "tab-1" });
      socket.close();
    });

    it("hires, re-charters and retires agents; agents need a grant", async () => {
      const hire = await client.graphql<{
        agentHire: { user: { id: string; name: string; kind: string; manager: { name: string } } };
      }>(
        'mutation { agentHire(input: { name: "Finance Lead", title: "Head of Finance", charter: "Own the bills." }) { user { id name kind manager { name } } } }',
      );
      expect(hire.errors).toBeUndefined();
      expect(hire.data?.agentHire.user).toMatchObject({
        name: "Finance Lead",
        kind: "agent",
        manager: { name: "Youssef" },
      });
      const agentId = hire.data?.agentHire.user.id ?? "";

      const dup = await client.graphql(
        'mutation { agentHire(input: { name: "finance lead" }) { success } }',
      );
      expect(dup.errors?.[0]?.extensions?.code).toBe("CONFLICT");
      const byAgent = await client.graphql(
        'mutation { agentHire(input: { name: "Rogue" }) { success } }',
        undefined,
        ceoToken,
      );
      expect(byAgent.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      const recharter = await client.graphql(
        'mutation($id: String!) { userUpdate(id: $id, input: { charter: "Own the bills and the budget." }) { success } }',
        { id: agentId },
      );
      expect(recharter.errors).toBeUndefined();
      const history = await client.graphql<{
        auditEntries: { nodes: { action: string; data: { to: string } }[] };
      }>("query($id: String) { auditEntries(entityId: $id) { nodes { action data } } }", {
        id: agentId,
      });
      expect(history.data?.auditEntries.nodes[0]).toMatchObject({
        action: "charter.update",
        data: { to: "Own the bills and the budget." },
      });

      const token = await client.graphql<{ apiTokenCreate: { token: string } }>(
        'mutation($userId: String) { apiTokenCreate(name: "runner", userId: $userId) { token } }',
        { userId: agentId },
      );
      const agentToken = token.data?.apiTokenCreate.token ?? "";
      expect(
        (await client.graphql("{ viewer { id } }", undefined, agentToken)).errors,
      ).toBeUndefined();

      const retire = await client.graphql<{ agentRetire: { user: { active: boolean } } }>(
        "mutation($id: String!) { agentRetire(id: $id) { user { active } } }",
        { id: agentId },
      );
      expect(retire.data?.agentRetire.user.active).toBe(false);
      const after = await client.request("/graphql", {
        method: "POST",
        json: { query: "{ viewer { id } }" },
        token: agentToken,
      });
      expect(after.status).toBe(401);
    });

    it("serves Linear's MCP tools to agents with a token", async () => {
      const rpc = async (method: string, params?: Record<string, unknown>) => {
        const response = await client.request("/mcp", {
          method: "POST",
          json: { jsonrpc: "2.0", id: 1, method, params },
          token: ceoToken,
          headers: { accept: "application/json, text/event-stream" },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as {
          result?: Record<string, unknown>;
          error?: { message: string };
        };
      };
      const call = async (name: string, args: Record<string, unknown>) => {
        const { result } = await rpc("tools/call", { name, arguments: args });
        const text = (result?.content as { text: string }[] | undefined)?.[0]?.text ?? "";
        return { isError: result?.isError === true, text, json: () => JSON.parse(text) };
      };

      const init = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(init.result).toMatchObject({
        protocolVersion: "2025-06-18",
        serverInfo: { name: "life-os" },
      });
      const note = await client.request("/mcp", {
        method: "POST",
        json: { jsonrpc: "2.0", method: "notifications/initialized" },
        token: ceoToken,
      });
      expect(note.status).toBe(202);
      const list = await rpc("tools/list");
      const names = ((list.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_issues",
          "get_issue",
          "create_issue",
          "update_issue",
          "create_comment",
          "list_teams",
        ]),
      );

      const created = (
        await call("create_issue", {
          title: "Compare insurance quotes",
          team: "Personal Finance",
          assignee: "me",
          priority: "High",
        })
      ).json();
      expect(created).toMatchObject({
        identifier: "PF-3",
        assignee: "CEO",
        priority: "High",
        status: "Backlog",
      });
      const updated = (
        await call("update_issue", { id: "PF-3", state: "In Progress", labels: ["Bills"] })
      ).json();
      expect(updated).toMatchObject({ status: "In Progress", labels: ["Bills"] });
      expect(
        (
          await call("create_comment", {
            issueId: "PF-3",
            body: "Two quotes in, waiting on a third.",
          })
        ).isError,
      ).toBe(false);

      const mine = (await call("list_my_issues", {})).json() as { identifier: string }[];
      expect(mine.map((i) => i.identifier)).toEqual(["PF-3"]);
      const detail = (await call("get_issue", { id: "PF-3" })).json();
      expect(detail).toMatchObject({
        creator: "CEO",
        commentCount: 1,
        url: expect.stringContaining("/issue/PF-3"),
      });
      const comments = (await call("list_comments", { issueId: "PF-3" })).json();
      expect(comments[0]).toMatchObject({
        author: "CEO",
        body: "Two quotes in, waiting on a third.",
      });

      const bad = await call("update_issue", { id: "PF-3", state: "Nowhere" });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("Options:");
      const unknown = await rpc("tools/call", { name: "nope", arguments: {} });
      expect(unknown.error?.message).toContain("Unknown tool");

      const anonymous = await new TestClient(send).request("/mcp", {
        method: "POST",
        json: { jsonrpc: "2.0", id: 1, method: "ping" },
      });
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    });

    it("lets agents ask, and the owner approve once, always allow or reject", async () => {
      const asCeo = <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
      ) => client.graphql<T>(query, variables, ceoToken);
      const permission = (action: string) =>
        asCeo<{
          permission: { allowed: boolean; via: string | null; pendingRequestId: string | null };
        }>("query($a: String!) { permission(action: $a) { allowed via pendingRequestId } }", {
          a: action,
        }).then((r) => r.data?.permission);
      const createTeam = () =>
        asCeo('mutation { teamCreate(input: { name: "Health" }) { team { key } } }');

      expect(await permission("team.create")).toEqual({
        allowed: false,
        via: null,
        pendingRequestId: null,
      });
      const refused = await createTeam();
      expect(refused.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      expect(refused.errors?.[0]?.message).toContain("requestCreate");

      const ask = () =>
        asCeo<{
          requestCreate: { request: { id: string; status: string; requester: { name: string } } };
        }>(
          'mutation { requestCreate(input: { title: "Start a Health team", action: "team.create", reason: "Your sleep and training need an owner." }) { request { id status requester { name } } } }',
        );
      const first = await ask();
      expect(first.data?.requestCreate.request).toMatchObject({
        status: "pending",
        requester: { name: "CEO" },
      });
      const requestId = first.data?.requestCreate.request.id ?? "";
      expect((await ask()).data?.requestCreate.request.id).toBe(requestId);
      expect((await permission("team.create"))?.pendingRequestId).toBe(requestId);

      const selfApprove = await asCeo(
        "mutation($id: String!) { requestApprove(id: $id) { success } }",
        {
          id: requestId,
        },
      );
      expect(selfApprove.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      const pending = await client.graphql<{ requests: { nodes: { id: string }[] } }>(
        "{ requests(filter: { status: [pending] }) { nodes { id } } }",
      );
      expect(pending.data?.requests.nodes.map((r) => r.id)).toEqual([requestId]);

      // Approve once: the agent may do it one time.
      const approved = await client.graphql<{ requestApprove: { request: { status: string } } }>(
        'mutation($id: String!) { requestApprove(id: $id, note: "Go ahead") { request { status } } }',
        { id: requestId },
      );
      expect(approved.data?.requestApprove.request.status).toBe("approved");
      expect(await permission("team.create")).toMatchObject({ allowed: true, via: "approval" });
      expect((await createTeam()).errors).toBeUndefined();
      expect((await permission("team.create"))?.allowed).toBe(false);
      const used = await client.graphql<{ request: { used: boolean; answer: string } }>(
        "query($id: String!) { request(id: $id) { used answer } }",
        { id: requestId },
      );
      expect(used.data?.request).toEqual({ used: true, answer: "Go ahead" });

      // Over MCP: ask, get rejected with a reason, ask again, get a standing grant.
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.request("/mcp", {
          method: "POST",
          json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
          token: ceoToken,
        });
        const { result } = (await response.json()) as {
          result: { isError?: boolean; content: { text: string }[] };
        };
        const text = result.content[0]?.text ?? "";
        return { isError: result.isError === true, text, json: () => JSON.parse(text) };
      };
      const hireAsk = {
        title: "Hire a coach",
        action: "agent.hire",
        reason: "Training plans need an owner.",
      };
      const asked = (await call("create_request", hireAsk)).json();
      expect(asked).toMatchObject({
        status: "pending",
        requester: "CEO",
        url: expect.stringContaining("/request/"),
      });
      const noReason = await client.graphql(
        'mutation($id: String!) { requestReject(id: $id, reason: " ") { success } }',
        { id: asked.id },
      );
      expect(noReason.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      await client.graphql(
        'mutation($id: String!) { requestReject(id: $id, reason: "Not this month.") { success } }',
        {
          id: asked.id,
        },
      );
      expect((await call("get_request", { id: asked.id })).json()).toMatchObject({
        status: "rejected",
        answer: "Not this month.",
      });

      const again = (await call("create_request", hireAsk)).json();
      expect(again.id).not.toBe(asked.id);
      const always = await client.graphql<{
        requestApprove: { request: { grant: { scope: string; user: { name: string } } } };
      }>(
        "mutation($id: String!) { requestApprove(id: $id, alwaysAllow: { scope: user }) { request { grant { scope user { name } } } } }",
        { id: again.id },
      );
      expect(always.data?.requestApprove.request.grant).toEqual({
        scope: "user",
        user: { name: "CEO" },
      });
      for (const name of ["Coach", "Chef"]) {
        const hired = await call("hire_agent", { name, charter: `${name} things.`, manager: "me" });
        expect(hired.isError).toBe(false);
      }
      const grantList = await client.graphql<{
        grants: { nodes: { id: string; action: string; useCount: number }[] };
      }>("{ grants { nodes { id action useCount } } }");
      const grant = grantList.data?.grants.nodes[0];
      expect(grant).toMatchObject({ action: "agent.hire", useCount: 2 });
      expect((await call("list_grants", {})).json().grants[0]).toMatchObject({
        for: "CEO",
        useCount: 2,
      });

      await client.graphql("mutation($id: String!) { grantRevoke(id: $id) { success } }", {
        id: grant?.id,
      });
      const afterRevoke = await call("hire_agent", { name: "Tutor", charter: "Lessons." });
      expect(afterRevoke.isError).toBe(true);
      expect(afterRevoke.text).toContain("needs approval");

      const history = await client.graphql<{ auditEntries: { nodes: { action: string }[] } }>(
        "{ auditEntries(first: 20) { nodes { action } } }",
      );
      expect(history.data?.auditEntries.nodes.map((e) => e.action)).toEqual(
        expect.arrayContaining([
          "request.create",
          "request.approve",
          "request.reject",
          "grant.create",
          "grant.revoke",
        ]),
      );
    });

    it("archives issues out of lists and back", async () => {
      const archive = await client.graphql<{
        issueArchive: { entity: { archivedAt: string | null } };
      }>('mutation { issueArchive(id: "PF-2") { entity { archivedAt } } }');
      expect(archive.data?.issueArchive.entity.archivedAt).not.toBeNull();
      const list = await client.graphql<{ team: { issues: { nodes: { identifier: string }[] } } }>(
        '{ team(id: "PF") { issues { nodes { identifier } } } }',
      );
      expect(list.data?.team.issues.nodes.map((n) => n.identifier)).toEqual(["PF-3", "PF-1"]);
      const all = await client.graphql<{ issues: { nodes: unknown[] } }>(
        "{ issues(includeArchived: true) { nodes { id } } }",
      );
      expect(all.data?.issues.nodes).toHaveLength(3);
      await client.graphql('mutation { issueUnarchive(id: "PF-2") { success } }');
      const mine = await client.graphql<{ viewer: { createdIssues: { nodes: unknown[] } } }>(
        "{ viewer { createdIssues { nodes { id } } } }",
      );
      expect(mine.data?.viewer.createdIssues.nodes).toHaveLength(1);
    });
  });
}
