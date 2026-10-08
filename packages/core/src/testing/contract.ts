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
export function hubContract(platform: string, makeFetch: () => Promise<FetchLike>) {
  describe(`hub contract (${platform})`, () => {
    let client: TestClient;
    const authenticator = new SoftwareAuthenticator();
    // Shared across the issue tests, which build on each other like a real session.
    let ceoToken = "";
    let teamId = "";
    let labelId = "";
    let issueId = "";
    let childId = "";

    beforeAll(async () => {
      client = new TestClient(await makeFetch());
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

    it("archives issues out of lists and back", async () => {
      const archive = await client.graphql<{
        issueArchive: { entity: { archivedAt: string | null } };
      }>('mutation { issueArchive(id: "PF-2") { entity { archivedAt } } }');
      expect(archive.data?.issueArchive.entity.archivedAt).not.toBeNull();
      const list = await client.graphql<{ team: { issues: { nodes: { identifier: string }[] } } }>(
        '{ team(id: "PF") { issues { nodes { identifier } } } }',
      );
      expect(list.data?.team.issues.nodes.map((n) => n.identifier)).toEqual(["PF-1"]);
      const all = await client.graphql<{ issues: { nodes: unknown[] } }>(
        "{ issues(includeArchived: true) { nodes { id } } }",
      );
      expect(all.data?.issues.nodes).toHaveLength(2);
      await client.graphql('mutation { issueUnarchive(id: "PF-2") { success } }');
      const mine = await client.graphql<{ viewer: { createdIssues: { nodes: unknown[] } } }>(
        "{ viewer { createdIssues { nodes { id } } } }",
      );
      expect(mine.data?.viewer.createdIssues.nodes).toHaveLength(1);
    });
  });
}
