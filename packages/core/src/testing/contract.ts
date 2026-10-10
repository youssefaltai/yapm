import { beforeAll, describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url } from "../crypto.js";
import { encryptPayload } from "../push.js";
import { SoftwareAuthenticator } from "./authenticator.js";
import { TestPushReceiver, verifyVapid } from "./webpush.js";

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
        redirect: "manual",
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
  /**
   * Requests the hub sent to push services, where the adapter could swap in a recording
   * fetch (Node can; the Workers test runs the real worker).
   */
  pushOutbox?: Request[];
  /** Every live event the hub published, where the adapter can record them (Node can). */
  liveLog?: unknown[];
  /** Database statements run so far, where the adapter can count them (Node can). */
  queryCount?: () => number;
}

/** A hex colour with no visible hue. */
export const neutral = (hex: string) => {
  const [r = 0, g = 0, b = 0] = (hex.match(/[0-9a-f]{2}/gi) ?? []).map((c) => parseInt(c, 16));
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12;
};

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

    /** Runs `action` and checks open apps hear about it, by whichever means the platform has. */
    async function expectAnnounced<T>(action: () => Promise<T>): Promise<T> {
      if (options.liveLog) {
        const before = options.liveLog.length;
        const result = await action();
        expect(options.liveLog.length).toBeGreaterThan(before);
        return result;
      }
      if (!options.liveSocket) return action();
      const response = await client.request("/api/live", { headers: { upgrade: "websocket" } });
      const socket = options.liveSocket(response);
      if (!socket) throw new Error("no socket");
      const heard = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no live event")), 5000);
        socket.addEventListener("message", (event) => {
          if (event.data === "pong") return;
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        const result = await action();
        await heard;
        return result;
      } finally {
        socket.close();
      }
    }

    /** Checks that `action` publishes nothing, where the platform records events. */
    async function expectQuiet<T>(action: () => Promise<T>): Promise<T> {
      if (!options.liveLog) return action();
      const before = options.liveLog.length;
      const result = await action();
      expect(options.liveLog.length).toBe(before);
      return result;
    }

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
      // A label made without a colour still gets one, so it stands out from the rest.
      const uncoloured = await client.graphql<{
        issueLabelCreate: { issueLabel: { color: string } };
      }>(
        'mutation($teamId: String) { issueLabelCreate(input: { name: "Rent", teamId: $teamId }) { issueLabel { color } } }',
        { teamId },
      );
      expect(uncoloured.data?.issueLabelCreate.issueLabel.color).not.toSatisfy(neutral);

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

      // Shortcodes become the emoji, so `+1` from an agent groups with 👍 instead of showing as text.
      const shortcode = await client.graphql<{
        reactionCreate: { reaction: { id: string; emoji: string } };
      }>(
        'mutation($commentId: String) { reactionCreate(input: { emoji: ":+1:", commentId: $commentId }) { reaction { id emoji } } }',
        { commentId },
        ceoToken,
      );
      expect(shortcode.data?.reactionCreate.reaction).toEqual(react.data?.reactionCreate.reaction);
      const tada = await client.graphql<{ reactionCreate: { reaction: { emoji: string } } }>(
        'mutation($issueId: String) { reactionCreate(input: { emoji: "tada", issueId: $issueId }) { reaction { emoji } } }',
        { issueId },
      );
      expect(tada.data?.reactionCreate.reaction.emoji).toBe("🎉");
      const heart = await client.graphql<{ reactionCreate: { reaction: { emoji: string } } }>(
        'mutation($issueId: String) { reactionCreate(input: { emoji: "\u2764", issueId: $issueId }) { reaction { emoji } } }',
        { issueId },
      );
      expect(heart.data?.reactionCreate.reaction.emoji).toBe("❤️");
      for (const emoji of [":not_an_emoji:", "hello"]) {
        const bad = await client.graphql(
          "mutation($issueId: String, $emoji: String!) { reactionCreate(input: { emoji: $emoji, issueId: $issueId }) { success } }",
          { issueId, emoji },
        );
        expect(bad.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      }

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
        headers: { "x-yapm-client": "tab-1" },
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

    it("serves MCP tools to agents with a token", async () => {
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
        serverInfo: { name: "yapm" },
      });
      // Agents must not mistake it for the owner's Linear, so nothing they read names Linear.
      expect(init.result?.instructions).not.toContain("Linear");
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
      expect(JSON.stringify(list.result)).not.toContain("Linear");
      const schema = await client.graphql<{
        __schema: { types: { name: string; description: string | null; fields: unknown }[] };
      }>("{ __schema { types { name description fields { name description } } } }");
      expect(JSON.stringify(schema.data?.__schema.types)).not.toContain("Linear");

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

    it("fills each member's Inbox from assignments, mentions, comments and requests", async () => {
      type Note = {
        id: string;
        type: string;
        actor: { name: string } | null;
        issue: { identifier: string } | null;
        data: Record<string, unknown> | null;
      };
      const people = await client.graphql<{ users: { nodes: { id: string; name: string }[] } }>(
        "{ users { nodes { id name } } }",
      );
      const idOf = (name: string) =>
        people.data?.users.nodes.find((u) => u.name === name)?.id ?? "";
      const tokenFor = async (name: string) =>
        (
          await client.graphql<{ apiTokenCreate: { token: string } }>(
            'mutation($u: String) { apiTokenCreate(name: "inbox", userId: $u) { token } }',
            { u: idOf(name) },
          )
        ).data?.apiTokenCreate.token ?? "";
      const coach = await tokenFor("Coach");
      const chef = await tokenFor("Chef");
      const inbox = async (token?: string) => {
        const result = await client.graphql<{
          notifications: { nodes: Note[] };
          notificationsUnreadCount: number;
        }>(
          "{ notifications { nodes { id type actor { name } issue { identifier } data } } notificationsUnreadCount }",
          undefined,
          token,
        );
        expect(result.errors).toBeUndefined();
        return {
          notes: result.data?.notifications.nodes ?? [],
          unread: result.data?.notificationsUnreadCount ?? 0,
        };
      };

      expect((await inbox()).notes.map((n) => n.type)).toContain("requestCreated");
      expect((await inbox(ceoToken)).notes[0]).toMatchObject({
        type: "requestAnswered",
        actor: { name: "Youssef" },
      });

      const created = await client.graphql<{
        issueCreate: {
          issue: { id: string; identifier: string; subscribers: { nodes: { name: string }[] } };
        };
      }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier subscribers { nodes { name } } } } }",
        {
          input: {
            teamId,
            title: "Plan the spring half marathon",
            description: "@Chef can you plan meals around it?",
            assigneeId: idOf("Coach"),
          },
        },
      );
      const issue = created.data?.issueCreate.issue;
      expect(issue?.subscribers.nodes.map((u) => u.name).sort()).toEqual([
        "Chef",
        "Coach",
        "Youssef",
      ]);
      expect((await inbox(coach)).notes[0]).toMatchObject({
        type: "issueAssignedToYou",
        actor: { name: "Youssef" },
        issue: { identifier: issue?.identifier },
      });
      expect((await inbox(chef)).notes[0]?.type).toBe("issueMention");

      // A comment: the mentioned hear about the mention, other followers about the comment.
      await client.graphql(
        'mutation($id: String!) { commentCreate(input: { issueId: $id, body: "On it. @CEO, a grocery budget?" }) { success } }',
        { id: issue?.id },
        chef,
      );
      expect((await inbox(ceoToken)).notes[0]?.type).toBe("issueCommentMention");
      expect((await inbox()).notes[0]).toMatchObject({
        type: "issueNewComment",
        actor: { name: "Chef" },
      });
      expect((await inbox(coach)).notes[0]?.type).toBe("issueNewComment");
      expect((await inbox(chef)).notes[0]?.type).toBe("issueMention");

      const states = await client.graphql<{
        team: { states: { nodes: { id: string; name: string }[] } };
      }>('{ team(id: "PF") { states { nodes { id name } } } }');
      const stateId = (name: string) =>
        states.data?.team.states.nodes.find((st) => st.name === name)?.id;
      await client.graphql(
        "mutation($id: String!) { issueUnsubscribe(id: $id) { success } }",
        { id: issue?.id },
        ceoToken,
      );
      await client.graphql(
        "mutation($id: String!, $s: String) { issueUpdate(id: $id, input: { stateId: $s }) { success } }",
        { id: issue?.id, s: stateId("In Progress") },
        coach,
      );
      expect((await inbox()).notes[0]).toMatchObject({
        type: "issueStatusChanged",
        actor: { name: "Coach" },
        data: { to: "In Progress" },
      });
      expect((await inbox(ceoToken)).notes[0]?.type).toBe("issueCommentMention");

      // Filing: read, snooze, archive, only your own.
      const before = await inbox();
      expect(before.unread).toBeGreaterThan(0);
      await client.graphql("mutation { notificationMarkReadAll { success } }");
      expect((await inbox()).unread).toBe(0);
      const first = before.notes[0]?.id;
      const someoneElses = await client.graphql(
        "mutation($id: String!) { notificationArchive(id: $id) { success } }",
        { id: first },
        coach,
      );
      expect(someoneElses.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      await client.graphql("mutation($id: String!) { notificationArchive(id: $id) { success } }", {
        id: first,
      });
      expect((await inbox()).notes.map((n) => n.id)).not.toContain(first);
      const coachFirst = (await inbox(coach)).notes[0]?.id;
      await client.graphql(
        "mutation($id: String!, $until: DateTime) { notificationUpdate(id: $id, input: { snoozedUntilAt: $until }) { success } }",
        { id: coachFirst, until: new Date(Date.now() + 86_400_000).toISOString() },
        coach,
      );
      expect((await inbox(coach)).notes.map((n) => n.id)).not.toContain(coachFirst);

      const viaMcp = await client.request("/mcp", {
        method: "POST",
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_notifications", arguments: {} },
        },
        token: chef,
      });
      const listed = JSON.parse(
        ((await viaMcp.json()) as { result: { content: { text: string }[] } }).result.content[0]
          ?.text ?? "{}",
      );
      expect(listed.notifications.map((n: { type: string }) => n.type)).toEqual([
        "issueStatusChanged",
        "issueMention",
      ]);
      expect(listed.notifications[1]).toMatchObject({ actor: "Youssef", issue: issue?.identifier });
    });

    it("sends notifications as encrypted Web Push to the owner's devices", async () => {
      const receiver = await TestPushReceiver.create("https://push.example.com/send/abc");
      const { p256dh, auth } = receiver.toJSON().keys;
      const sealed = await encryptPayload(p256dh, auth, new TextEncoder().encode('{"hi":1}'));
      expect(await receiver.decrypt(sealed)).toEqual({ hi: 1 });

      const key = await client.graphql<{ pushVapidPublicKey: string }>("{ pushVapidPublicKey }");
      const publicKey = key.data?.pushVapidPublicKey ?? "";
      expect(fromBase64Url(publicKey)).toHaveLength(65);
      expect(
        (await client.graphql<{ pushVapidPublicKey: string }>("{ pushVapidPublicKey }")).data
          ?.pushVapidPublicKey,
      ).toBe(publicKey);

      const subscribe = (data: unknown) =>
        client.graphql<{ pushSubscriptionCreate: { pushSubscription: { id: string } } }>(
          'mutation($data: String!) { pushSubscriptionCreate(input: { data: $data, userAgent: "iPhone" }) { pushSubscription { id } } }',
          { data: JSON.stringify(data) },
        );
      const insecure = await subscribe({
        ...receiver.toJSON(),
        endpoint: "http://push.example.com/x",
      });
      expect(insecure.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      const first = await subscribe(receiver);
      expect(first.errors).toBeUndefined();
      const again = await subscribe(receiver);
      expect(again.data?.pushSubscriptionCreate.pushSubscription.id).toBe(
        first.data?.pushSubscriptionCreate.pushSubscription.id,
      );

      const outbox = options.pushOutbox;
      if (outbox) {
        outbox.length = 0;
        await client.graphql(
          'mutation { requestCreate(input: { title: "Buy running shoes", action: "spend", resource: "120 EUR", reason: "The old pair is done." }) { success } }',
          undefined,
          ceoToken,
        );
        for (let i = 0; i < 100 && !outbox.length; i++) await new Promise((r) => setTimeout(r, 20));
        const sent = outbox[0];
        expect(sent?.url).toBe(receiver.endpoint);
        expect(sent?.headers.get("content-encoding")).toBe("aes128gcm");
        expect(sent?.headers.get("urgency")).toBe("high");
        const vapid = await verifyVapid(sent?.headers.get("authorization") ?? "");
        expect(vapid).toMatchObject({
          valid: true,
          publicKey,
          claims: { aud: "https://push.example.com" },
        });
        const payload = await receiver.decrypt(
          new Uint8Array(await (sent as Request).arrayBuffer()),
        );
        expect(payload).toMatchObject({
          title: "CEO asks for approval",
          body: "Buy running shoes",
          url: expect.stringMatching(/^http:\/\/localhost\/request\//),
        });

        const test = await client.graphql<{ pushSubscriptionTest: number }>(
          "mutation { pushSubscriptionTest }",
        );
        expect(test.data?.pushSubscriptionTest).toBe(1);
      }

      await client.graphql(
        "mutation($e: String) { pushSubscriptionDelete(endpoint: $e) { success } }",
        {
          e: receiver.endpoint,
        },
      );
      const devices = await client.graphql<{ pushSubscriptions: unknown[] }>(
        "{ pushSubscriptions { id } }",
      );
      expect(devices.data?.pushSubscriptions).toEqual([]);
    });

    it("runs agents on enrolled machines: decide, work, pause for input, resume, stop", async () => {
      const runner = async <T = Record<string, unknown>>(
        path: string,
        token: string,
        json?: unknown,
      ) => {
        const response = await client.request(`/api/runner${path}`, {
          method: json === undefined && path === "/me" ? "GET" : "POST",
          ...(json !== undefined ? { json } : {}),
          token,
        });
        const text = await response.text();
        return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
      };
      const gql = <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
        token?: string,
      ) => client.graphql<T>(query, variables, token);

      // Enrolment: the machine shows a code; the owner types it in to approve.
      // It shows up on Machines for approval without a reload.
      const enrol = await expectAnnounced(() =>
        runner<{ id: string; token: string; pairingCode: string }>("/enrol", "", {
          name: "Youssef's MacBook",
          tags: ["personal"],
          capacity: 2,
        }),
      );
      expect(enrol.status).toBe(201);
      const machine = enrol.body;
      expect(machine.pairingCode).toMatch(/^\d{6}$/);
      expect((await runner("/claim", machine.token, {})).status).toBe(403);
      const listed = await gql<{ machines: { id: string; status: string; tags: string[] }[] }>(
        "{ machines { id status tags } }",
      );
      expect(listed.data?.machines).toEqual([
        { id: machine.id, status: "pending", tags: ["personal"] },
      ]);
      const wrong = await gql(
        'mutation($id: String!) { machineApprove(id: $id, pairingCode: "000000x") { success } }',
        {
          id: machine.id,
        },
      );
      expect(wrong.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      const approved = await gql<{
        machineApprove: { machine: { status: string; online: boolean } };
      }>(
        "mutation($id: String!, $code: String!) { machineApprove(id: $id, pairingCode: $code) { machine { status online } } }",
        { id: machine.id, code: machine.pairingCode },
      );
      expect(approved.data?.machineApprove.machine).toEqual({ status: "active", online: true });
      // Earlier tests woke agents with mentions and assignments; clear that queue first.
      const queued = await gql<{ runs: { nodes: { id: string; agent: { name: string } }[] } }>(
        "{ runs(filter: { status: [queued] }) { nodes { id agent { name } } } }",
      );
      expect(queued.data?.runs.nodes.length).toBeGreaterThan(0);
      for (const run of queued.data?.runs.nodes ?? []) {
        await gql(
          'mutation($id: String!) { runStop(id: $id, reason: "Clearing the test queue") { success } }',
          {
            id: run.id,
          },
        );
      }
      expect((await expectQuiet(() => runner("/claim", machine.token, {}))).status).toBe(204);

      // Assigning an issue to an agent wakes it with a decision run.
      const people = await gql<{ users: { nodes: { id: string; name: string }[] } }>(
        "{ users { nodes { id name } } }",
      );
      const coachId = people.data?.users.nodes.find((u) => u.name === "Coach")?.id ?? "";
      const created = await gql<{ issueCreate: { issue: { id: string; identifier: string } } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }",
        { input: { teamId, title: "Build a 12-week training plan", assigneeId: coachId } },
      );
      const issue = created.data?.issueCreate.issue;
      type Claim = {
        run: {
          id: string;
          kind: string;
          modelTier: string;
          model: string;
          effort: string;
          sessionId: string | null;
          issue: string;
        };
        agent: { name: string };
        token: string;
        mcpUrl: string;
        input: {
          systemPrompt: string;
          prompt: string;
          tools: boolean;
          outputSchema: { properties: Record<string, unknown> };
        };
      };
      // The run starting shows on the issue and in Runs.
      const decision = await expectAnnounced(() => runner<Claim>("/claim", machine.token, {}));
      expect(decision.status).toBe(200);
      expect(decision.body).toMatchObject({
        // The hub picks the model: decisions run on the small tier's pinned model.
        run: {
          kind: "decision",
          modelTier: "small",
          model: "claude-sonnet-5-5",
          effort: "medium",
          issue: issue?.identifier,
        },
        agent: { name: "Coach" },
        mcpUrl: "http://localhost/mcp",
        input: { tools: false },
      });
      expect(decision.body.input.systemPrompt).toContain("Coach things.");
      expect(decision.body.input.systemPrompt).not.toContain("Linear");
      // Every agent writes briefly, without dropping what the next reader needs.
      expect(decision.body.input.systemPrompt).toContain("Lead with the outcome");
      expect(decision.body.input.prompt).toContain("Youssef assigned the issue to you");
      expect(decision.body.input.prompt).toContain("Build a 12-week training plan");
      expect(decision.body.input.outputSchema.properties).toHaveProperty("action");
      // The run's token acts as the agent, for this run only.
      const asRun = await gql<{ viewer: { name: string } }>(
        "{ viewer { name } }",
        undefined,
        decision.body.token,
      );
      expect(asRun.data?.viewer.name).toBe("Coach");

      const logged = await runner<{ stop: boolean }>(
        `/runs/${decision.body.run.id}/logs`,
        machine.token,
        {
          seq: 0,
          events: [{ type: "assistant", text: "Thinking about the plan" }],
          usage: { inputTokens: 900, outputTokens: 40, numTurns: 1, costUsd: 0.0021 },
        },
      );
      expect(logged.body.stop).toBe(false);
      const bogus = await runner(`/runs/${decision.body.run.id}/complete`, machine.token, {
        status: "completed",
        result: { action: "teleport", reason: "?" },
      });
      expect(bogus.body).toEqual({ status: "failed" });

      // Try again with a valid decision: the hub queues a work session.
      await gql(
        'mutation($id: String!) { commentCreate(input: { issueId: $id, body: "@Coach what\'s the plan?" }) { success } }',
        { id: issue?.id },
      );
      const second = await runner<Claim>("/claim", machine.token, {});
      expect(second.body.run.kind).toBe("decision");
      expect(second.body.input.prompt).toContain("what's the plan?");
      // Finishing a run drops it from the sidebar's running count without a poll.
      const decided = await expectAnnounced(() =>
        runner(`/runs/${second.body.run.id}/complete`, machine.token, {
          status: "completed",
          result: {
            action: "work",
            reason: "Assigned and clear",
            goal: "Draft the 12-week plan",
            modelTier: "standard",
          },
        }),
      );
      expect(decided.body).toEqual({ status: "completed" });

      const work = await runner<Claim>("/claim", machine.token, {});
      expect(work.body).toMatchObject({
        run: { kind: "work", modelTier: "standard", model: "claude-opus-5-5", effort: "medium" },
        input: { tools: true },
      });
      expect(work.body.input.prompt).toContain("Your goal: Draft the 12-week plan");
      // A machine's page lists the runs it picked up.
      const onMachine = await gql<{ runs: { nodes: { id: string }[] } }>(
        "query($m: String) { runs(filter: { machineId: $m }) { nodes { id } } }",
        { m: machine.id },
      );
      expect(onMachine.data?.runs.nodes.map((r) => r.id)).toContain(work.body.run.id);
      const elsewhere = await gql<{ runs: { nodes: { id: string }[] } }>(
        'query { runs(filter: { machineId: "nope" }) { nodes { id } } }',
      );
      expect(elsewhere.data?.runs.nodes).toEqual([]);
      // The agent works through the hub's MCP server with the run's token; history names the run.
      await client.request("/mcp", {
        method: "POST",
        token: work.body.token,
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_comment",
            arguments: { issueId: issue?.identifier, body: "Drafting weeks 1-4 now." },
          },
        },
      });
      const history = await gql<{
        auditEntries: { nodes: { action: string; runId: string | null }[] };
      }>(
        "query($id: String) { auditEntries(entityId: $id, first: 1) { nodes { action runId } } }",
        { id: issue?.id },
      );
      expect(history.data?.auditEntries.nodes[0]).toEqual({
        action: "comment.create",
        runId: work.body.run.id,
      });
      await runner(`/runs/${work.body.run.id}/logs`, machine.token, {
        seq: 0,
        events: [{ type: "tool_use", name: "create_comment" }],
        sessionId: "session-abc",
      });
      // A manager is woken to screen its reports' requests; these steps follow the agent's run instead.
      const skipScreening = async () => {
        const queued = await gql<{ runs: { nodes: { id: string }[] } }>(
          "{ runs(filter: { status: [queued] }) { nodes { id } } }",
        );
        for (const run of queued.data?.runs.nodes ?? [])
          await gql(
            'mutation($id: String!) { runStop(id: $id, reason: "Not needed") { success } }',
            { id: run.id },
          );
      };
      // A tool that needs permission: the run asks, waits, and uses the one-time approval once.
      const use = () =>
        gql<{ permissionUse: { allowed: boolean; via: string | null } }>(
          'mutation { permissionUse(action: "tool:Bash", resource: "npm test") { allowed via } }',
          undefined,
          work.body.token,
        ).then((r) => r.data?.permissionUse);
      expect(await use()).toEqual({ allowed: false, via: null });
      const asked = await gql<{ requestCreate: { request: { id: string } } }>(
        'mutation { requestCreate(input: { title: "Run the tests", action: "tool:Bash", resource: "npm test", reason: "Check the plan generator" }) { request { id } } }',
        undefined,
        work.body.token,
      );
      const askedId = asked.data?.requestCreate.request.id;
      await skipScreening();
      const waiting = await gql<{ run: { waitingOnRequest: { id: string } | null } }>(
        "query($id: String!) { run(id: $id) { waitingOnRequest { id } } }",
        { id: work.body.run.id },
      );
      expect(waiting.data?.run.waitingOnRequest?.id).toBe(askedId);
      await gql("mutation($id: String!) { requestApprove(id: $id) { success } }", { id: askedId });
      expect(await use()).toEqual({ allowed: true, via: "approval" });
      expect(await use()).toEqual({ allowed: false, via: null });
      const paused = await runner(`/runs/${work.body.run.id}/complete`, machine.token, {
        status: "completed",
        usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 },
        result: {
          outcome: "needs_input",
          summary: "Weeks 1-4 drafted",
          question: "Which race date are you targeting?",
        },
      });
      expect(paused.body).toEqual({ status: "needs_input" });
      const afterPause = await gql<{
        issue: { comments: { nodes: { body: string; user: { name: string } }[] } };
      }>("query($id: String!) { issue(id: $id) { comments { nodes { body user { name } } } } }", {
        id: issue?.id,
      });
      expect(afterPause.data?.issue.comments.nodes.at(-1)).toEqual({
        body: "Which race date are you targeting?",
        user: { name: "Coach" },
      });
      // The run's token died with it.
      const expired = await client.request("/graphql", {
        method: "POST",
        json: { query: "{ viewer { id } }" },
        token: work.body.token,
      });
      expect(expired.status).toBe(401);

      // Answering resumes the same session, on the same machine.
      await gql(
        'mutation($id: String!) { commentCreate(input: { issueId: $id, body: "April 12th." }) { success } }',
        {
          id: issue?.id,
        },
      );
      const resumed = await runner<Claim>("/claim", machine.token, {});
      expect(resumed.body.run).toMatchObject({ kind: "work", sessionId: "session-abc" });
      expect(resumed.body.input.prompt).toContain("April 12th.");
      // The resumed session's totals carry on from the paused run; the run keeps only its own.
      await runner(`/runs/${resumed.body.run.id}/logs`, machine.token, {
        seq: 0,
        events: [],
        sessionId: "session-abc",
        usage: { inputTokens: 1600, outputTokens: 130, costUsd: 0.75 },
      });
      const ownUsage = await gql<{
        run: { inputTokens: number; outputTokens: number; costUsd: number };
      }>("query($id: String!) { run(id: $id) { inputTokens outputTokens costUsd } }", {
        id: resumed.body.run.id,
      });
      expect(ownUsage.data?.run).toEqual({ inputTokens: 600, outputTokens: 30, costUsd: 0.25 });

      // Stopping: the owner gives a reason, the machine hears it on its next check-in.
      const noReason = await gql(
        'mutation($id: String!) { runStop(id: $id, reason: "") { success } }',
        {
          id: resumed.body.run.id,
        },
      );
      expect(noReason.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      await gql(
        'mutation($id: String!) { runStop(id: $id, reason: "Wrong race, pause this") { success } }',
        {
          id: resumed.body.run.id,
        },
      );
      const beat = await runner<{ stop: { id: string; reason: string }[] }>(
        "/heartbeat",
        machine.token,
        {
          runIds: [resumed.body.run.id],
        },
      );
      expect(beat.body.stop).toEqual([
        { id: resumed.body.run.id, reason: "Wrong race, pause this" },
      ]);
      await runner(`/runs/${resumed.body.run.id}/complete`, machine.token, { status: "stopped" });

      const runsOnIssue = await gql<{
        issue: {
          runs: {
            nodes: { kind: string; status: string; stopReason: string | null; logCount: number }[];
          };
        };
      }>(
        "query($id: String!) { issue(id: $id) { runs { nodes { kind status stopReason logCount } } } }",
        {
          id: issue?.id,
        },
      );
      expect(runsOnIssue.data?.issue.runs.nodes).toEqual([
        { kind: "work", status: "stopped", stopReason: "Wrong race, pause this", logCount: 0 },
        { kind: "work", status: "completed", stopReason: null, logCount: 1 },
        { kind: "decision", status: "completed", stopReason: null, logCount: 0 },
        { kind: "decision", status: "failed", stopReason: null, logCount: 1 },
      ]);
      const transcript = await gql<{
        run: {
          logs: { seq: number; events: { text?: string }[] }[];
          inputTokens: number;
          costUsd: number;
          routeRule: string;
        };
      }>(
        "query($id: String!) { run(id: $id) { inputTokens costUsd routeRule logs { seq events } } }",
        { id: decision.body.run.id },
      );
      expect(transcript.data?.run).toEqual({
        inputTokens: 900,
        costUsd: 0.0021,
        routeRule: "decision",
        logs: [{ seq: 0, events: [{ type: "assistant", text: "Thinking about the plan" }] }],
      });

      // Routing: an agent tagged for another machine waits for one that has the tag.
      await gql(
        'mutation($id: String!) { userUpdate(id: $id, input: { runnerTags: ["gym"] }) { success } }',
        { id: coachId },
      );
      await gql(
        'mutation($a: String!) { runCreate(input: { agentId: $a, goal: "Check the gym schedule" }) { success } }',
        {
          a: coachId,
        },
      );
      expect((await runner("/claim", machine.token, {})).status).toBe(204);
      await gql(
        'mutation($id: String!) { machineUpdate(id: $id, input: { tags: ["personal", "gym"] }) { success } }',
        {
          id: machine.id,
        },
      );
      const tagged = await runner<Claim>("/claim", machine.token, {});
      expect(tagged.body.run.kind).toBe("work");
      await runner(`/runs/${tagged.body.run.id}/complete`, machine.token, {
        status: "completed",
        result: { outcome: "done", summary: "Gym is open 6-22." },
      });

      // A run that pauses on its own request resumes when the owner answers it, on its own issue
      // whichever issue the request is filed on.
      const race = await gql<{ issueCreate: { issue: { id: string; identifier: string } } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }",
        { input: { teamId, title: "Enter the spring race" } },
      );
      const raceId = race.data?.issueCreate.issue.id;
      const raceKey = race.data?.issueCreate.issue.identifier;
      await gql("mutation($input: RunCreateInput!) { runCreate(input: $input) { success } }", {
        input: { agentId: coachId, issueId: raceId, goal: "Enter the race" },
      });
      const entering = await runner<Claim>("/claim", machine.token, {});
      await client.request("/mcp", {
        method: "POST",
        token: entering.body.token,
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_comment",
            arguments: { issueId: raceId, body: "Found the race; the fee needs your approval." },
          },
        },
      });
      const fee = await gql<{ requestCreate: { request: { id: string } } }>(
        'mutation($issue: String!) { requestCreate(input: { title: "Pay the race fee", action: "spend", reason: "Entry fee", issueId: $issue }) { request { id } } }',
        { issue: issue?.id },
        entering.body.token,
      );
      await skipScreening();
      await runner(`/runs/${entering.body.run.id}/logs`, machine.token, {
        seq: 0,
        events: [],
        sessionId: "session-race",
      });
      await runner(`/runs/${entering.body.run.id}/complete`, machine.token, {
        status: "completed",
        result: { outcome: "needs_input", summary: "Asked to pay the fee." },
      });
      // The agent already said so; its summary isn't posted again.
      const raceComments = await gql<{ issue: { comments: { nodes: { body: string }[] } } }>(
        "query($id: String!) { issue(id: $id) { comments { nodes { body } } } }",
        { id: raceId },
      );
      expect(raceComments.data?.issue.comments.nodes.map((c) => c.body)).toEqual([
        "Found the race; the fee needs your approval.",
      ]);
      await gql("mutation($id: String!) { requestApprove(id: $id) { success } }", {
        id: fee.data?.requestCreate.request.id,
      });
      const paid = await runner<Claim>("/claim", machine.token, {});
      expect(paid.body.run).toMatchObject({
        kind: "work",
        sessionId: "session-race",
        issue: raceKey,
      });
      expect(paid.body.input.prompt).toContain('approved your request "Pay the race fee"');

      // A session that ended without pausing picks up again with the answer to its request.
      const shoes = await gql<{ requestCreate: { request: { id: string } } }>(
        'mutation($issue: String!) { requestCreate(input: { title: "Email the shoe shop", action: "contact", reason: "Ask about race shoes", issueId: $issue }) { request { id } } }',
        { issue: raceId },
        paid.body.token,
      );
      await skipScreening();
      await runner(`/runs/${paid.body.run.id}/complete`, machine.token, {
        status: "completed",
        result: { outcome: "blocked", summary: "Entered; the shop email waits on approval." },
      });
      await gql(
        'mutation($id: String!) { requestReject(id: $id, reason: "Keep the old shoes") { success } }',
        { id: shoes.data?.requestCreate.request.id },
      );
      const heard = await runner<Claim>("/claim", machine.token, {});
      expect(heard.body.run).toMatchObject({ kind: "work", sessionId: "session-race" });
      expect(heard.body.input.prompt).toContain('rejected your request "Email the shoe shop"');
      await runner(`/runs/${heard.body.run.id}/complete`, machine.token, {
        status: "completed",
        result: { outcome: "done", summary: "Keeping the old shoes." },
      });
      // The agent decides what deserves a reaction, so every mention reaches it, however busy.
      for (const n of [1, 2, 3, 4]) {
        await gql(
          "mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }",
          { id: raceId, body: `@Coach check-in ${n}` },
        );
        const checkIn = await runner<Claim>("/claim", machine.token, {});
        expect(checkIn.body.input.prompt).toContain(`check-in ${n}`);
        await runner(`/runs/${checkIn.body.run.id}/complete`, machine.token, {
          status: "completed",
          result: { action: "ignore", reason: "Just checking in" },
        });
      }
      // Looking again later replaces an earlier plan to, rather than adding another.
      for (const until of ["2099-01-01T09:00:00.000Z", "2099-01-02T09:00:00.000Z"]) {
        await gql(
          'mutation($id: String!) { commentCreate(input: { issueId: $id, body: "@Coach race day?" }) { success } }',
          { id: raceId },
        );
        const asked = await runner<Claim>("/claim", machine.token, {});
        await runner(`/runs/${asked.body.run.id}/complete`, machine.token, {
          status: "completed",
          result: { action: "wait_until", until, reason: "Ask nearer the day" },
        });
      }
      const later = await gql<{ runs: { nodes: { notBefore: string }[] } }>(
        "query($id: String!) { runs(filter: { issueId: $id, status: [queued] }) { nodes { notBefore } } }",
        { id: raceId },
      );
      expect(later.data?.runs.nodes).toEqual([{ notBefore: "2099-01-02T09:00:00.000Z" }]);

      // Model routing: the owner pins each tier's model and routes labels; rules decide the rest.
      const routing = await gql<{
        organizationUpdate: { organization: { modelRouting: Record<string, unknown> } };
      }>(
        "mutation($r: JSONObject!) { organizationUpdate(input: { modelRouting: $r }) { organization { modelRouting } } }",
        {
          r: {
            tiers: { standard: { model: "claude-sonnet-5-5", effort: "high" } },
            labels: { Bills: "top" },
          },
        },
      );
      expect(routing.data?.organizationUpdate.organization.modelRouting).toEqual({
        tiers: {
          small: { model: "claude-sonnet-5-5", effort: "medium" },
          standard: { model: "claude-sonnet-5-5", effort: "high" },
          top: { model: "claude-opus-5-5", effort: "high" },
        },
        labels: { bills: "top" },
      });
      const badRouting = await gql(
        "mutation($r: JSONObject!) { organizationUpdate(input: { modelRouting: $r }) { success } }",
        { r: { tiers: { top: { model: "claude-opus-5-5", effort: "enormous" } } } },
      );
      expect(badRouting.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      const inverted = await gql(
        'mutation($id: String!) { userUpdate(id: $id, input: { modelFloor: "top", modelCeiling: "standard" }) { success } }',
        { id: coachId },
      );
      expect(inverted.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      const limited = await gql<{
        userUpdate: { user: { modelFloor: string; modelCeiling: string; topRunsPerWeek: number } };
      }>(
        'mutation($id: String!) { userUpdate(id: $id, input: { modelCeiling: "standard", topRunsPerWeek: 1 }) { user { modelFloor modelCeiling topRunsPerWeek } } }',
        { id: coachId },
      );
      expect(limited.data?.userUpdate.user).toEqual({
        modelFloor: "small",
        modelCeiling: "standard",
        topRunsPerWeek: 1,
      });
      const billIssue = await gql<{ issueCreate: { issue: { id: string } } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }",
        { input: { teamId, title: "Check the gym invoice", labelIds: [labelId] } },
      );
      const billId = billIssue.data?.issueCreate.issue.id;
      const startOn = (modelTier?: string) =>
        gql<{ runCreate: { run: { model: string; effort: string; routeRule: string } } }>(
          "mutation($input: RunCreateInput!) { runCreate(input: $input) { run { model effort routeRule } } }",
          { input: { agentId: coachId, issueId: billId, goal: "Check the invoice", modelTier } },
        ).then((r) => r.data?.runCreate.run);
      const finish = async (costUsd: number) => {
        const claimed = await runner<Claim>("/claim", machine.token, {});
        await runner(`/runs/${claimed.body.run.id}/complete`, machine.token, {
          status: "completed",
          result: { outcome: "done", summary: "Checked." },
          usage: { inputTokens: 100, outputTokens: 10, costUsd },
        });
        return claimed.body.run;
      };
      // The Bills label asks for top; the agent's ceiling caps it at standard.
      expect(await startOn()).toEqual({
        model: "claude-sonnet-5-5",
        effort: "high",
        routeRule: "label:bills+ceiling",
      });
      expect(await finish(0.5)).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
      // The owner may overrule the agent's limits.
      expect(await startOn("top")).toEqual({
        model: "claude-opus-5-5",
        effort: "high",
        routeRule: "owner",
      });
      await finish(1.25);
      // With the ceiling raised, the week's one top run is already spent.
      await gql(
        'mutation($id: String!) { userUpdate(id: $id, input: { modelCeiling: "top" }) { success } }',
        { id: coachId },
      );
      expect(await startOn()).toEqual({
        model: "claude-sonnet-5-5",
        effort: "high",
        routeRule: "label:bills+budget",
      });
      await finish(0.25);
      const routes = await gql<{
        insights: {
          company: { costUsd: number };
          routes: { model: string; routeRule: string; runs: number; costPerCompletedRun: number }[];
        };
      }>(
        "{ insights(days: 1) { company { costUsd } routes { model routeRule runs costPerCompletedRun } } }",
      );
      expect(routes.data?.insights.company.costUsd).toBeGreaterThanOrEqual(2);
      expect(routes.data?.insights.routes).toContainEqual({
        model: "claude-opus-5-5",
        routeRule: "owner",
        runs: 1,
        costPerCompletedRun: 1.25,
      });
      await gql(
        "mutation($r: JSONObject!) { organizationUpdate(input: { modelRouting: $r }) { success } }",
        { r: { tiers: {}, labels: {} } },
      );

      await gql("mutation($id: String!) { machineRevoke(id: $id) { success } }", {
        id: machine.id,
      });
      expect((await runner("/me", machine.token)).status).toBe(401);
    });
    it("plans with projects, milestones, updates, initiatives and documents", async () => {
      const gql = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
        token?: string,
      ) => {
        const result = await client.graphql<T>(query, variables, token);
        if (result.errors) throw new Error(result.errors[0]?.message);
        return result.data as T;
      };
      const mcp = async (name: string, args: Record<string, unknown>) => {
        const response = await client.request("/mcp", {
          method: "POST",
          json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
          token: ceoToken,
        });
        const body = (await response.json()) as {
          result: { content: { text: string }[]; isError?: boolean };
        };
        const text = body.result.content[0]?.text ?? "";
        if (body.result.isError) throw new Error(text);
        return JSON.parse(text);
      };

      const { initiativeCreate } = await gql<{ initiativeCreate: { initiative: { id: string } } }>(
        'mutation { initiativeCreate(input: { name: "Get fit", status: active }) { initiative { id } } }',
      );
      const created = await gql<{
        projectCreate: { project: { id: string; state: string; color: string; url: string } };
      }>(
        "mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id state color url } } }",
        {
          input: {
            name: "Marathon",
            summary: "Run a marathon in under four hours",
            teamIds: [teamId],
            targetDate: "2027-04-12",
            initiativeId: initiativeCreate.initiative.id,
          },
        },
      );
      const project = created.projectCreate.project;
      expect(project).toMatchObject({ state: "planned", url: `/project/${project.id}` });
      expect(project.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(project.color).not.toSatisfy(neutral);
      const bad = await client.graphql(
        'mutation($id: String!) { projectUpdate(id: $id, input: { targetDate: "soon" }) { success } }',
        { id: project.id },
      );
      expect(bad.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");

      const { projectMilestoneCreate } = await gql<{
        projectMilestoneCreate: { projectMilestone: { id: string } };
      }>(
        'mutation($p: String!) { projectMilestoneCreate(input: { projectId: $p, name: "Half marathon", targetDate: "2027-01-10" }) { projectMilestone { id } } }',
        { p: project.id },
      );
      const milestoneId = projectMilestoneCreate.projectMilestone.id;

      // Issues join a project directly or through one of its milestones.
      const issue = await gql<{
        issueCreate: { issue: { id: string; project: { name: string } | null } };
      }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id project { name } } } }",
        { input: { teamId, title: "Run 21 km", projectMilestoneId: milestoneId } },
      );
      expect(issue.issueCreate.issue.project?.name).toBe("Marathon");
      const second = await gql<{ issueCreate: { issue: { id: string } } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }",
        { input: { teamId, title: "Buy running shoes", projectId: project.id } },
      );
      const done = await gql<{ team: { states: { nodes: { id: string; type: string }[] } } }>(
        "query($id: String!) { team(id: $id) { states { nodes { id type } } } }",
        { id: teamId },
      );
      const completedState = done.team.states.nodes.find((s) => s.type === "completed")?.id;
      await gql(
        "mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }",
        { id: second.issueCreate.issue.id, s: completedState },
      );
      const filtered = await gql<{ issues: { nodes: { title: string }[] } }>(
        "query($p: ID!) { issues(filter: { project: { id: { eq: $p } } }) { nodes { title } } }",
        { p: project.id },
      );
      expect(filtered.issues.nodes.map((i) => i.title).sort()).toEqual([
        "Buy running shoes",
        "Run 21 km",
      ]);

      // The CEO posts an update over MCP; the owner hears about it.
      const listed = await mcp("list_projects", {});
      expect(listed.projects).toEqual([
        expect.objectContaining({
          name: "Marathon",
          progress: { completed: 1, scope: 2 },
          health: null,
        }),
      ]);
      await mcp("create_project_update", {
        project: "marathon",
        body: "Base mileage is up; long runs start next week.",
        health: "atRisk",
      });
      await mcp("update_issue", { id: issue.issueCreate.issue.id, milestone: null });
      const doc = await mcp("create_document", {
        title: "Training plan",
        content: "# Weeks 1-4\nEasy runs.",
        project: "Marathon",
      });
      await mcp("update_document", {
        id: doc.id,
        content: "# Weeks 1-4\nEasy runs, one long run.",
      });
      expect((await mcp("get_document", { id: doc.id })).content).toContain("one long run");
      const detail = await mcp("get_project", { query: "Marathon" });
      expect(detail).toMatchObject({
        health: "atRisk",
        milestones: [{ name: "Half marathon" }],
        documents: [{ title: "Training plan" }],
      });
      expect(detail.issues.find((i: { title: string }) => i.title === "Run 21 km").milestone).toBe(
        null,
      );

      const view = await gql<{
        project: {
          health: string;
          progress: { scope: number; completed: number; progress: number };
          initiative: { name: string };
          teams: { nodes: { id: string }[] };
          projectUpdates: { nodes: { body: string; user: { name: string } }[] };
          projectMilestones: { nodes: { name: string; progress: { scope: number } }[] };
          documents: { nodes: { title: string; updatedBy: { name: string } }[] };
        };
        notifications: { nodes: { type: string; project: { name: string } | null }[] };
      }>(
        `query($id: String!) {
          project(id: $id) {
            health progress { scope completed progress } initiative { name } teams { nodes { id } }
            projectUpdates { nodes { body user { name } } }
            projectMilestones { nodes { name progress { scope } } }
            documents { nodes { title updatedBy { name } } }
          }
          notifications(first: 1) { nodes { type project { name } } }
        }`,
        { id: project.id },
      );
      expect(view.project).toMatchObject({
        health: "atRisk",
        progress: { scope: 2, completed: 1, progress: 0.5 },
        initiative: { name: "Get fit" },
        teams: { nodes: [{ id: teamId }] },
        projectUpdates: { nodes: [{ user: { name: "CEO" } }] },
        projectMilestones: { nodes: [{ name: "Half marathon", progress: { scope: 0 } }] },
        documents: { nodes: [{ title: "Training plan", updatedBy: { name: "CEO" } }] },
      });
      expect(view.notifications.nodes[0]).toEqual({
        type: "projectUpdateCreated",
        project: { name: "Marathon" },
      });

      await gql("mutation($id: String!) { projectArchive(id: $id) { success } }", {
        id: project.id,
      });
      expect(
        (await gql<{ projects: { nodes: unknown[] } }>("{ projects { nodes { id } } }")).projects
          .nodes,
      ).toEqual([]);
    });
    it.runIf(options.queryCount)(
      "lists projects in queries that don't grow with them",
      async () => {
        const gql = async <T = Record<string, unknown>>(
          query: string,
          variables?: Record<string, unknown>,
        ) => {
          const result = await client.graphql<T>(query, variables);
          if (result.errors) throw new Error(result.errors[0]?.message);
          return result.data as T;
        };
        const { initiativeCreate } = await gql<{
          initiativeCreate: { initiative: { id: string } };
        }>('mutation { initiativeCreate(input: { name: "Grow" }) { initiative { id } } }');
        const addProjects = async (n: number) => {
          for (let i = 0; i < n; i++) {
            const { projectCreate } = await gql<{ projectCreate: { project: { id: string } } }>(
              "mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }",
              { input: { name: `Project ${i}`, initiativeId: initiativeCreate.initiative.id } },
            );
            const p = projectCreate.project.id;
            await gql(
              'mutation($p: String!) { projectMilestoneCreate(input: { projectId: $p, name: "M" }) { success } }',
              { p },
            );
            await gql(
              'mutation($p: String!) { projectUpdateCreate(input: { projectId: $p, body: "Going", health: onTrack }) { success } }',
              { p },
            );
            await gql(
              "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success } }",
              { input: { teamId, title: "Step", projectId: p } },
            );
          }
        };
        // What the Projects and Roadmap pages ask for.
        const list = async () => {
          const count = options.queryCount ?? (() => 0);
          const before = count();
          const { projects } = await gql<{
            projects: {
              nodes: {
                health: string;
                progress: { scope: number };
                initiative: { id: string };
                projectMilestones: { nodes: { name: string }[] };
              }[];
            };
          }>(`{ projects(first: 200) { nodes {
          id name state health targetDate lead { id name } progress { progress scope }
          initiative { id name } projectMilestones { nodes { id name targetDate } }
        } } }`);
          for (const p of projects.nodes) {
            expect(p).toMatchObject({
              health: "onTrack",
              progress: { scope: 1 },
              initiative: { id: initiativeCreate.initiative.id },
              projectMilestones: { nodes: [{ name: "M" }] },
            });
          }
          return count() - before;
        };
        await addProjects(2);
        const few = await list();
        await addProjects(5);
        expect(await list()).toBe(few);
      },
    );
    it("runs cycles, triage and saved views", async () => {
      const gql = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
        token?: string,
      ) => {
        const result = await client.graphql<T>(query, variables, token);
        if (result.errors) throw new Error(result.errors[0]?.message);
        return result.data as T;
      };
      const mcp = async (name: string, args: Record<string, unknown>) => {
        const response = await client.request("/mcp", {
          method: "POST",
          json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
          token: ceoToken,
        });
        const body = (await response.json()) as {
          result: { content: { text: string }[]; isError?: boolean };
        };
        const text = body.result.content[0]?.text ?? "";
        if (body.result.isError) throw new Error(text);
        return JSON.parse(text);
      };

      // Agents need a grant to set the company's time zone, and only to a real one.
      const { organizationUpdate } = await gql<{
        organizationUpdate: { organization: { timezone: string } };
      }>(
        'mutation { organizationUpdate(input: { timezone: "Europe/Berlin" }) { organization { timezone } } }',
      );
      expect(organizationUpdate.organization.timezone).toBe("Europe/Berlin");
      const badZone = await client.graphql(
        'mutation { organizationUpdate(input: { timezone: "Mars/Olympus" }) { success } }',
      );
      expect(badZone.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      const asAgent = await client.graphql(
        'mutation { organizationUpdate(input: { timezone: "UTC" }) { success } }',
        undefined,
        ceoToken,
      );
      expect(asAgent.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      // Turning cycles on opens the current cycle and the upcoming ones straight away.
      const { teamUpdate } = await gql<{
        teamUpdate: {
          team: {
            cyclesEnabled: boolean;
            activeCycle: { id: string; number: number; isActive: boolean } | null;
            cycles: { nodes: { id: string; number: number; isFuture: boolean }[] };
          };
        };
      }>(
        `mutation($id: String!) {
          teamUpdate(id: $id, input: { cyclesEnabled: true, cycleDuration: 2, triageEnabled: true }) {
            team { cyclesEnabled activeCycle { id number isActive } cycles { nodes { id number isFuture } } }
          }
        }`,
        { id: teamId },
      );
      expect(teamUpdate.team.cyclesEnabled).toBe(true);
      expect(teamUpdate.team.activeCycle).toMatchObject({ number: 1, isActive: true });
      expect(teamUpdate.team.cycles.nodes.map((c) => c.number)).toEqual([3, 2, 1]);
      const current = teamUpdate.team.activeCycle?.id ?? "";
      const badLength = await client.graphql(
        "mutation($id: String!) { teamUpdate(id: $id, input: { cycleDuration: 20 }) { success } }",
        { id: teamId },
      );
      expect(badLength.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");

      // An agent's new issue waits in Triage; the CEO can put it in the current cycle.
      const triaged = await mcp("create_issue", {
        team: teamId,
        title: "Renew passport",
        cycle: "current",
      });
      expect(triaged).toMatchObject({ status: "Triage", cycle: 1 });
      const ownIssue = await gql<{
        issueCreate: { issue: { id: string; state: { type: string }; cycle: { number: number } } };
      }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id state { type } cycle { number } } } }",
        { input: { teamId, title: "Plan the week", cycleId: current } },
      );
      expect(ownIssue.issueCreate.issue).toMatchObject({
        state: { type: "backlog" },
        cycle: { number: 1 },
      });
      const listed = await mcp("list_cycles", { team: teamId });
      expect(listed.cycles.at(-1)).toMatchObject({
        number: 1,
        status: "current",
        progress: { scope: 2, completed: 0 },
      });

      const inCycle = await gql<{
        cycle: { issues: { nodes: { title: string }[] }; progress: number };
        issues: { nodes: { title: string }[] };
      }>(
        `query($id: String!) {
          cycle(id: $id) { issues { nodes { title } } progress }
          issues(filter: { cycle: { isActive: { eq: true } }, state: { type: { eq: "triage" } } }) { nodes { title } }
        }`,
        { id: current },
      );
      expect(inCycle.cycle.issues.nodes.map((i) => i.title).sort()).toEqual([
        "Plan the week",
        "Renew passport",
      ]);
      expect(inCycle.issues.nodes.map((i) => i.title)).toEqual(["Renew passport"]);

      // A saved view keeps a filter; private views stay with their creator.
      const { customViewCreate } = await gql<{
        customViewCreate: { customView: { id: string; issues: { nodes: { title: string }[] } } };
      }>(
        `mutation($input: CustomViewCreateInput!) {
          customViewCreate(input: $input) { customView { id issues { nodes { title } } } }
        }`,
        {
          input: {
            name: "Needs triage",
            shared: false,
            filterData: { state: { type: { eq: "triage" } } },
          },
        },
      );
      const viewId = customViewCreate.customView.id;
      expect(customViewCreate.customView.issues.nodes.map((i) => i.title)).toContain(
        "Renew passport",
      );
      const hidden = await client.graphql(
        "query($id: String!) { customView(id: $id) { id } }",
        { id: viewId },
        ceoToken,
      );
      expect(hidden.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
      await gql(
        'mutation($id: String!) { customViewUpdate(id: $id, input: { name: "Triage", shared: true }) { success } }',
        { id: viewId },
      );
      const seen = await gql<{ customViews: { nodes: { name: string }[] } }>(
        "{ customViews { nodes { name } } }",
        undefined,
        ceoToken,
      );
      expect(seen.customViews.nodes.map((v) => v.name)).toEqual(["Triage"]);
      await gql("mutation($id: String!) { customViewDelete(id: $id) { success } }", { id: viewId });

      await gql(
        "mutation($id: String!) { teamUpdate(id: $id, input: { triageEnabled: false }) { success } }",
        { id: teamId },
      );
    });
    it("keeps issue templates and recurring issues", async () => {
      const gql = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
      ) => {
        const result = await client.graphql<T>(query, variables);
        if (result.errors) throw new Error(result.errors[0]?.message);
        return result.data as T;
      };
      const mcp = async (name: string, args: Record<string, unknown>) => {
        const response = await client.request("/mcp", {
          method: "POST",
          json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
          token: ceoToken,
        });
        const body = (await response.json()) as {
          result: { content: { text: string }[]; isError?: boolean };
        };
        const text = body.result.content[0]?.text ?? "";
        if (body.result.isError) throw new Error(text);
        return JSON.parse(text);
      };

      const { templateCreate } = await gql<{
        templateCreate: { template: { id: string; name: string; schedule: null } };
      }>(
        `mutation($input: TemplateCreateInput!) {
          templateCreate(input: $input) { template { id name schedule { description } } }
        }`,
        {
          input: {
            teamId,
            templateData: { title: "Bug report", description: "## Steps\n1.", priority: 2 },
          },
        },
      );
      expect(templateCreate.template).toMatchObject({ name: "Bug report", schedule: null });
      const bad = await client.graphql(
        `mutation($id: String!) {
          templateUpdate(id: $id, input: { schedule: { frequency: "hourly", time: "09:00" } }) { success }
        }`,
        { id: templateCreate.template.id },
      );
      expect(bad.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");

      // The CEO sets up its own recurring issue over MCP.
      const saved = await mcp("save_template", {
        team: teamId,
        title: "Weekly review {date}",
        assignee: "me",
        schedule: { frequency: "weekly", time: "17:00", weekday: 5 },
      });
      expect(saved).toMatchObject({ name: "Weekly review {date}", schedule: "Fridays at 17:00" });
      expect(Date.parse(saved.nextRunAt)).toBeGreaterThan(Date.now());
      const listed = await mcp("list_templates", { team: teamId });
      expect(listed.templates.map((t: { name: string }) => t.name).sort()).toEqual([
        "Bug report",
        "Weekly review {date}",
      ]);

      const team = await gql<{
        team: { templates: { name: string; schedule: { frequency: string } | null }[] };
      }>("query($id: String!) { team(id: $id) { templates { name schedule { frequency } } } }", {
        id: teamId,
      });
      expect(team.team.templates).toContainEqual({
        name: "Weekly review {date}",
        schedule: { frequency: "weekly" },
      });
      await gql(
        "mutation($id: String!) { templateUpdate(id: $id, input: { schedule: null }) { success } }",
        { id: saved.id },
      );
      await gql("mutation($id: String!) { templateDelete(id: $id) { success } }", {
        id: templateCreate.template.id,
      });
      const left = await gql<{ templates: { name: string; nextRunAt: string | null }[] }>(
        "{ templates { name nextRunAt } }",
      );
      expect(left.templates).toEqual([{ name: "Weekly review {date}", nextRunAt: null }]);
    });
    it("tracks SLAs and searches projects, documents and comments", async () => {
      const gql = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
      ) => {
        const result = await client.graphql<T>(query, variables);
        if (result.errors) throw new Error(result.errors[0]?.message);
        return result.data as T;
      };
      const bad = await client.graphql(
        "mutation($id: String!, $sla: JSONObject) { teamUpdate(id: $id, input: { slaHours: $sla }) { success } }",
        { id: teamId, sla: { "9": 5 } },
      );
      expect(bad.errors?.[0]?.extensions?.code).toBe("BAD_REQUEST");
      const { teamUpdate } = await gql<{
        teamUpdate: { team: { slaHours: Record<string, number>; autoArchivePeriod: number } };
      }>(
        `mutation($id: String!, $sla: JSONObject) {
          teamUpdate(id: $id, input: { slaHours: $sla, autoArchivePeriod: 3 }) {
            team { slaHours autoArchivePeriod }
          }
        }`,
        { id: teamId, sla: { "1": 24, "2": 72 } },
      );
      expect(teamUpdate.team).toEqual({ slaHours: { "1": 24, "2": 72 }, autoArchivePeriod: 3 });

      const before = Date.now();
      const created = await gql<{
        issueCreate: { issue: { id: string; slaStartedAt: string; slaBreachesAt: string } };
      }>(
        `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { issue { id slaStartedAt slaBreachesAt } }
        }`,
        { input: { teamId, title: "Dispute the double charge", priority: 1 } },
      );
      const sla = created.issueCreate.issue;
      const hours = (Date.parse(sla.slaBreachesAt) - Date.parse(sla.slaStartedAt)) / 3_600_000;
      expect(hours).toBe(24);
      expect(Date.parse(sla.slaStartedAt)).toBeGreaterThanOrEqual(before - 1000);
      const high = await gql<{ issueUpdate: { issue: { slaBreachesAt: string } } }>(
        "mutation($id: String!) { issueUpdate(id: $id, input: { priority: 2 }) { issue { slaBreachesAt } } }",
        { id: sla.id },
      );
      expect(Date.parse(high.issueUpdate.issue.slaBreachesAt)).toBe(
        Date.parse(sla.slaStartedAt) + 72 * 3_600_000,
      );
      const low = await gql<{ issueUpdate: { issue: { slaBreachesAt: string | null } } }>(
        "mutation($id: String!) { issueUpdate(id: $id, input: { priority: 4 }) { issue { slaBreachesAt } } }",
        { id: sla.id },
      );
      expect(low.issueUpdate.issue.slaBreachesAt).toBeNull();

      await gql(
        'mutation($id: String!) { commentCreate(input: { issueId: $id, body: "The bank reference is ZX-4471." }) { success } }',
        { id: sla.id },
      );
      const found = await gql<{
        searchIssues: { nodes: { title: string }[] };
        searchProjects: { nodes: unknown[] };
        searchDocuments: { nodes: { title: string }[] };
      }>(
        `{
          searchIssues(term: "zx-4471") { nodes { title } }
          searchProjects(term: "zzz-no-such-project") { nodes { id } }
          searchDocuments(term: "long run") { nodes { title } }
        }`,
      );
      expect(found.searchIssues.nodes.map((i) => i.title)).toEqual(["Dispute the double charge"]);
      expect(found.searchProjects.nodes).toEqual([]);
      expect(found.searchDocuments.nodes.map((d) => d.title)).toEqual(["Training plan"]);
      await gql(
        "mutation($id: String!) { teamUpdate(id: $id, input: { slaHours: null }) { success } }",
        { id: teamId },
      );
    });
    it("learns from feedback, keeps lessons and a handbook, and versions them", async () => {
      const gql = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
        token?: string,
      ) => {
        const result = await client.graphql<T>(query, variables, token);
        if (result.errors) throw new Error(result.errors[0]?.message);
        return result.data as T;
      };
      const { users } = await gql<{ users: { nodes: { id: string; name: string }[] } }>(
        "{ users { nodes { id name } } }",
      );
      const ceoId = users.nodes.find((u) => u.name === "CEO")?.id ?? "";

      // Stopping a run and rejecting an agent's request became feedback on their own.
      const automatic = await gql<{
        feedbacks: { kind: string; body: string; agent: { id: string } }[];
      }>("{ feedbacks(first: 100) { kind body agent { id } } }");
      expect(
        automatic.feedbacks.some((f) => f.kind === "stop" && f.body === "Wrong race, pause this"),
      ).toBe(true);
      expect(automatic.feedbacks.some((f) => f.kind === "rejection" && f.agent.id === ceoId)).toBe(
        true,
      );

      const note = await gql<{
        feedbackCreate: { feedback: { id: string; kind: string; author: { name: string } } };
      }>(
        'mutation($id: String!) { feedbackCreate(input: { agentId: $id, body: "Say the total first in money updates." }) { feedback { id kind author { name } } } }',
        { id: ceoId },
      );
      expect(note.feedbackCreate.feedback.kind).toBe("note");
      const self = await client.graphql(
        'mutation($id: String!) { feedbackCreate(input: { agentId: $id, body: "I am great" }) { success } }',
        { id: ceoId },
        ceoToken,
      );
      expect(self.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      // Feedback can be about an issue: it is listed there, by id or identifier.
      const onIssue = await gql<{
        feedbackCreate: { feedback: { id: string; issue: { identifier: string } } };
      }>(
        'mutation($id: String!, $issue: String!) { feedbackCreate(input: { agentId: $id, issueId: $issue, body: "Check the due date first." }) { feedback { id issue { identifier } } } }',
        { id: ceoId, issue: issueId },
      );
      const about = await gql<{ feedbacks: { id: string; body: string }[] }>(
        "query($issue: String) { feedbacks(issueId: $issue) { id body } }",
        { issue: onIssue.feedbackCreate.feedback.issue.identifier },
      );
      expect(about.feedbacks.map((f) => f.id)).toContain(onIssue.feedbackCreate.feedback.id);
      expect(about.feedbacks.map((f) => f.id)).not.toContain(note.feedbackCreate.feedback.id);
      const nowhere = await client.graphql(
        'mutation($id: String!) { feedbackCreate(input: { agentId: $id, issueId: "NOPE-999", body: "Hi" }) { success } }',
        { id: ceoId },
      );
      expect(nowhere.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

      // The agent rewrites its own lessons without asking, then marks the note addressed.
      await gql(
        'mutation($id: String!) { userUpdate(id: $id, input: { lessons: "- Lead money updates with the total." }) { success } }',
        { id: ceoId },
        ceoToken,
      );
      await gql(
        'mutation($id: String!) { feedbackAddress(id: $id, note: "Added a lesson") { success } }',
        { id: note.feedbackCreate.feedback.id },
        ceoToken,
      );
      const open = await gql<{ feedbacks: { id: string }[] }>(
        "query($id: String) { feedbacks(agentId: $id, open: true) { id } }",
        { id: ceoId },
      );
      expect(open.feedbacks.map((f) => f.id)).not.toContain(note.feedbackCreate.feedback.id);

      const handbook = await client.graphql(
        'mutation { organizationUpdate(input: { handbook: "Agents never pay without a receipt." }) { success } }',
        undefined,
        ceoToken,
      );
      expect(handbook.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      const org = await gql<{ organizationUpdate: { organization: { handbook: string } } }>(
        'mutation { organizationUpdate(input: { handbook: "Agents never pay without a receipt." }) { organization { handbook } } }',
      );
      expect(org.organizationUpdate.organization.handbook).toBe(
        "Agents never pay without a receipt.",
      );

      const versions = await gql<{
        lessons: { content: string; author: { name: string } }[];
        handbook: { content: string }[];
        user: { lessons: string };
      }>(
        `query($id: String!) {
          lessons: revisions(subject: "lessons", entityId: $id) { content author { name } }
          handbook: revisions(subject: "handbook") { content }
          user(id: $id) { lessons }
        }`,
        { id: ceoId },
      );
      expect(versions.lessons[0]).toEqual({
        content: "- Lead money updates with the total.",
        author: { name: "CEO" },
      });
      expect(versions.handbook[0]?.content).toBe("Agents never pay without a receipt.");
      expect(versions.user.lessons).toBe("- Lead money updates with the total.");
    });
    it("measures the company's work for insights and retros", async () => {
      const result = await client.graphql<{
        insights: {
          company: { created: number; completed: number; runs: number; stopRate: number | null };
          users: {
            user: { name: string };
            metrics: { requestsAnswered: number; rejectionRate: number | null };
          }[];
          teams: { team: { id: string }; metrics: { created: number } }[];
        };
        metricHistory: unknown[];
      }>(
        `{
          insights(days: 7) {
            company { created completed runs stopRate }
            users { user { name } metrics { requestsAnswered rejectionRate } }
            teams { team { id } metrics { created } }
          }
          metricHistory(days: 30) { date }
        }`,
      );
      expect(result.errors).toBeUndefined();
      const insights = result.data?.insights;
      expect(insights?.company.created).toBeGreaterThan(0);
      expect(insights?.company.runs).toBeGreaterThan(0);
      expect(insights?.company.stopRate).toBeGreaterThan(0);
      const ceo = insights?.users.find((u) => u.user.name === "CEO");
      expect(ceo?.metrics.requestsAnswered).toBeGreaterThan(0);
      expect(ceo?.metrics.rejectionRate).toBeGreaterThan(0);
      expect(insights?.teams.find((t) => t.team.id === teamId)?.metrics.created).toBeGreaterThan(0);
      expect(result.data?.metricHistory).toEqual([]);

      const response = await client.request("/mcp", {
        method: "POST",
        json: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_metrics", arguments: { member: "me", days: 7 } },
        },
        token: ceoToken,
        headers: { accept: "application/json, text/event-stream" },
      });
      const body = (await response.json()) as { result: { content: { text: string }[] } };
      const metrics = JSON.parse(body.result.content[0]?.text ?? "{}");
      expect(metrics.scope).toBe("CEO");
      expect(metrics.current.requestsAnswered).toBeGreaterThan(0);
      expect(metrics.previous.requestsAnswered).toBe(0);
    });
    it("adds a machine with a one-time setup command, approved without a pairing code", async () => {
      const enrol = (json: Record<string, unknown>) =>
        client.json<{ id: string; token: string; status: string; error?: string }>(
          "/api/runner/enrol",
          { method: "POST", json },
        );
      const create = "mutation { machineSetupTokenCreate { token expiresAt } }";

      // Only the owner makes setup tokens.
      const byAgent = await client.graphql(create, undefined, ceoToken);
      expect(byAgent.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      const made = await client.graphql<{
        machineSetupTokenCreate: { token: string; expiresAt: string };
      }>(create);
      const setup = made.data?.machineSetupTokenCreate;
      expect(setup?.token).toMatch(/^lms_/);
      expect(Date.parse(setup?.expiresAt ?? "")).toBeGreaterThan(Date.now());

      const joined = await enrol({
        name: "Studio Mac",
        tags: ["personal"],
        setupToken: setup?.token,
      });
      expect(joined.status).toBe(201);
      expect(joined.body.status).toBe("active");
      const me = await client.json<{ status: string; name: string }>("/api/runner/me", {
        token: joined.body.token,
      });
      expect(me.body).toMatchObject({ status: "active", name: "Studio Mac" });

      // A token adds one machine; made-up and reused tokens are refused.
      const again = await enrol({ name: "Another", setupToken: setup?.token });
      expect(again.status).toBe(400);
      expect(again.body.error).toMatch(/expired or was already used/);
      expect((await enrol({ name: "Another", setupToken: "lms_nope" })).status).toBe(400);
      expect((await enrol({ name: "Another", setupToken: "nope" })).status).toBe(400);

      // The audit log says who added it: the owner who made the command.
      const log = await client.graphql<{
        auditEntries: { nodes: { action: string; actor: { kind: string } | null }[] };
      }>("query($id: String) { auditEntries(entityId: $id) { nodes { action actor { kind } } } }", {
        id: joined.body.id,
      });
      expect(log.data?.auditEntries.nodes).toEqual([
        { action: "machine.enrol", actor: { kind: "owner" } },
      ]);

      // The installer is served by the hub, pointed at itself.
      const script = await client.request("/install.sh");
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("shellscript");
      const text = await script.text();
      expect(text.startsWith("#!/bin/sh")).toBe(true);
      expect(text).toContain(`HUB="${client.origin}"`);
      expect(text).toContain(`${client.origin}/downloads/yapm-runner.tgz`);
      expect(text).not.toContain("__HUB__");
      // macOS sh reads non-ASCII bytes after a variable as part of its name.
      expect(text).not.toMatch(/[^\t\n -~]/);
      // Claude Code (built on Bun) crashes with "EINVAL ... kqueue" reading /dev/tty on macOS;
      // the sign-in reads the terminal's own device instead.
      expect(text).not.toContain("</dev/tty");

      await client.graphql("mutation($id: String!) { machineRevoke(id: $id) { success } }", {
        id: joined.body.id,
      });
    });

    it("renames a machine, keeping the name it enrolled with to fall back to", async () => {
      const gql = async <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
        token?: string,
      ) => client.graphql<T>(query, variables, token);
      const rename = (id: string, name: string, token?: string) =>
        gql(
          "mutation($id: String!, $name: String!) { machineUpdate(id: $id, input: { name: $name }) { machine { name originalName } } }",
          { id, name },
          token,
        );
      const made = await gql<{ machineSetupTokenCreate: { token: string } }>(
        "mutation { machineSetupTokenCreate { token } }",
      );
      const joined = await client.json<{ id: string; token: string }>("/api/runner/enrol", {
        method: "POST",
        json: {
          name: "Youssefs-MacBook-Pro",
          setupToken: made.data?.machineSetupTokenCreate.token,
        },
      });
      const id = joined.body.id;
      const listed = async () => {
        const response = await client.request("/mcp", {
          method: "POST",
          json: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_machines", arguments: {} },
          },
          token: ceoToken,
        });
        const body = (await response.json()) as { result: { content: { text: string }[] } };
        const machines = JSON.parse(body.result.content[0]?.text ?? "[]") as {
          id: string;
          name: string;
          originalName?: string;
        }[];
        return machines.find((m) => m.id === id);
      };

      // Only the owner renames machines.
      const byAgent = await rename(id, "Work laptop", ceoToken);
      expect(byAgent.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      const renamed = await rename(id, "  Work laptop ");
      expect(renamed.data).toEqual({
        machineUpdate: { machine: { name: "Work laptop", originalName: "Youssefs-MacBook-Pro" } },
      });
      // Agents see the new name, and can still find it by either.
      expect(await listed()).toMatchObject({
        name: "Work laptop",
        originalName: "Youssefs-MacBook-Pro",
      });
      const me = await client.json<{ name: string }>("/api/runner/me", {
        token: joined.body.token,
      });
      expect(me.body.name).toBe("Work laptop");

      // Clearing the name, or giving back the original, falls back to what it enrolled with.
      expect((await rename(id, "")).data).toEqual({
        machineUpdate: {
          machine: { name: "Youssefs-MacBook-Pro", originalName: "Youssefs-MacBook-Pro" },
        },
      });
      expect((await listed())?.originalName).toBeUndefined();
      await rename(id, "Work laptop");
      await rename(id, "Youssefs-MacBook-Pro");
      expect((await listed())?.originalName).toBeUndefined();
      expect((await rename(id, "x".repeat(61))).errors?.[0]?.message).toMatch(/at most 60/);

      const log = await gql<{
        auditEntries: { nodes: { action: string; data: { to?: { name?: string } } }[] };
      }>("query($id: String) { auditEntries(entityId: $id) { nodes { action data } } }", { id });
      expect(
        log.data?.auditEntries.nodes
          .filter((e) => e.action === "machine.update")
          .map((e) => e.data.to?.name),
      ).toEqual(expect.arrayContaining(["Work laptop", "Youssefs-MacBook-Pro"]));

      await gql("mutation($id: String!) { machineRevoke(id: $id) { success } }", { id });
    });

    it("upgrades a machine's runner from the app on its next check-in", async () => {
      const made = await client.graphql<{ machineSetupTokenCreate: { token: string } }>(
        "mutation { machineSetupTokenCreate { token } }",
      );
      const joined = await client.json<{ id: string; token: string }>("/api/runner/enrol", {
        method: "POST",
        json: { name: "Mac", setupToken: made.data?.machineSetupTokenCreate.token },
      });
      const { id, token } = joined.body;
      const upgrade = (as?: string) =>
        client.graphql(
          "mutation($id: String!) { machineUpgrade(id: $id) { success } }",
          { id },
          as,
        );
      const beat = async () =>
        (
          await client.json<{ upgrade?: boolean }>("/api/runner/heartbeat", {
            method: "POST",
            json: { version: "0.3.0" },
            token,
          })
        ).body.upgrade;

      expect(await beat()).toBeFalsy();
      expect((await upgrade(ceoToken)).errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      expect((await upgrade()).data).toEqual({ machineUpgrade: { success: true } });
      // The machine hears it once.
      expect(await beat()).toBe(true);
      expect(await beat()).toBeFalsy();

      await client.graphql("mutation($id: String!) { machineRevoke(id: $id) { success } }", { id });
    });

    it("shows each Claude login's plan limits and what runs used, per day", async () => {
      const gql = <T = Record<string, unknown>>(
        query: string,
        variables?: Record<string, unknown>,
      ) => client.graphql<T>(query, variables);
      const runner = async <T = Record<string, unknown>>(
        path: string,
        token: string,
        json: unknown,
      ) => client.json<T>(`/api/runner${path}`, { method: "POST", json, token });
      const addMachine = async (name: string) => {
        const made = await gql<{ machineSetupTokenCreate: { token: string } }>(
          "mutation { machineSetupTokenCreate { token } }",
        );
        const joined = await client.json<{ id: string; token: string }>("/api/runner/enrol", {
          method: "POST",
          json: {
            name,
            tags: ["personal", "gym"],
            setupToken: made.data?.machineSetupTokenCreate.token,
          },
        });
        return joined.body;
      };
      const laptop = await addMachine("Laptop");
      const desktop = await addMachine("Desktop");
      const now = Date.now();
      const resets = new Date(now + 3 * 3_600_000).toISOString();
      await runner("/heartbeat", laptop.token, {
        claudeAccount: {
          email: "Owner@Example.com",
          subscriptionType: "max",
          apiProvider: "firstParty",
        },
        planUsage: {
          observedAt: now - 60_000,
          source: "usage",
          available: true,
          limits: [
            { kind: "five_hour", label: "Current session", utilization: 42, resetsAt: resets },
            // Out-of-range numbers are clamped; entries without a kind are dropped.
            { kind: "seven_day", label: "This week", utilization: 250, resetsAt: "not a date" },
            { label: "No kind" },
          ],
          extraUsage: { enabled: false, monthlyLimit: null, usedCredits: null, utilization: null },
        },
      });
      // The second machine uses the same login, and read the limits earlier.
      await runner("/heartbeat", desktop.token, {
        claudeAccount: { email: "owner@example.com", subscriptionType: "max" },
        planUsage: { observedAt: now - 600_000, source: "rate_limit", limits: [] },
      });
      // An older reading arriving late doesn't replace a newer one.
      await runner("/heartbeat", laptop.token, {
        planUsage: { observedAt: now - 3_600_000, source: "usage", limits: [] },
      });
      const subscriptions = await gql<{
        claudeSubscriptions: {
          id: string;
          account: { subscriptionType: string } | null;
          machines: { name: string }[];
          reportedBy: { name: string } | null;
          planUsage: {
            source: string;
            available: boolean;
            limits: { kind: string; label: string; utilization: number; resetsAt: string | null }[];
          } | null;
        }[];
      }>(
        "{ claudeSubscriptions { id account { subscriptionType } machines { name } reportedBy { name } planUsage { source available limits { kind label utilization resetsAt } } } }",
      );
      const mine = subscriptions.data?.claudeSubscriptions.find(
        (s) => s.id === "owner@example.com",
      );
      expect(mine).toMatchObject({
        account: { subscriptionType: "max" },
        reportedBy: { name: "Laptop" },
        planUsage: {
          source: "usage",
          available: true,
          limits: [
            { kind: "five_hour", label: "Current session", utilization: 42, resetsAt: resets },
            { kind: "seven_day", label: "This week", utilization: 100, resetsAt: null },
          ],
        },
      });
      expect(mine?.machines.map((m) => m.name).sort()).toEqual(["Desktop", "Laptop"]);
      const machineUsage = await gql<{
        machines: { name: string; planUsage: { source: string } | null }[];
      }>("{ machines { name planUsage { source } } }");
      expect(machineUsage.data?.machines).toContainEqual({
        name: "Desktop",
        planUsage: { source: "rate_limit" },
      });

      // A run's usage is summed per day, by machine, agent and model.
      const queued = await gql<{ runs: { nodes: { id: string }[] } }>(
        "{ runs(filter: { status: [queued] }) { nodes { id } } }",
      );
      for (const run of queued.data?.runs.nodes ?? [])
        await gql('mutation($id: String!) { runStop(id: $id, reason: "Clearing") { success } }', {
          id: run.id,
        });
      const people = await gql<{ users: { nodes: { id: string; name: string }[] } }>(
        "{ users { nodes { id name } } }",
      );
      const coachId = people.data?.users.nodes.find((u) => u.name === "Coach")?.id ?? "";
      const started = await gql(
        "mutation($input: RunCreateInput!) { runCreate(input: $input) { success } }",
        {
          input: { agentId: coachId, goal: "Plan the week" },
        },
      );
      expect(started.errors).toBeUndefined();
      const claimed = await runner<{ run: { id: string; model: string } }>(
        "/claim",
        laptop.token,
        {},
      );
      await runner(`/runs/${claimed.body.run.id}/complete`, laptop.token, {
        status: "completed",
        result: { outcome: "done", summary: "Planned." },
        usage: { inputTokens: 1200, outputTokens: 80, numTurns: 3, costUsd: 0.75 },
      });
      const history = async (groupBy: string) =>
        (
          await gql<{
            usageHistory: {
              key: string;
              label: string;
              runs: number;
              inputTokens: number;
              outputTokens: number;
              costUsd: number;
            }[];
          }>(
            "query($g: UsageGroupBy!) { usageHistory(groupBy: $g, days: 1) { key label runs inputTokens outputTokens costUsd } }",
            { g: groupBy },
          )
        ).data?.usageHistory ?? [];
      expect((await history("machine")).find((p) => p.key === laptop.id)).toEqual({
        key: laptop.id,
        label: "Laptop",
        runs: 1,
        inputTokens: 1200,
        outputTokens: 80,
        costUsd: 0.75,
      });
      expect((await history("agent")).find((p) => p.key === coachId)?.label).toBe("Coach");
      expect((await history("model")).map((p) => p.key)).toContain(claimed.body.run.model);

      for (const machine of [laptop, desktop])
        await gql("mutation($id: String!) { machineRevoke(id: $id) { success } }", {
          id: machine.id,
        });
    });

    /** Pretend MCP providers, reached through the hub's outgoing fetch. */
    const tokenForms: URLSearchParams[] = [];
    function fakeProviders(): typeof fetch {
      return async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        switch (`${request.method} ${url.origin}${url.pathname}`) {
          // Signs in with OAuth, and accepts the hub's client ID metadata document.
          case "POST https://mcp.example.com/mcp":
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate":
                  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:read"',
              },
            });
          case "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp":
            return Response.json({
              resource: "https://mcp.example.com/mcp",
              authorization_servers: ["https://auth.example.com"],
            });
          case "GET https://auth.example.com/.well-known/oauth-authorization-server":
            return Response.json({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              client_id_metadata_document_supported: true,
            });
          case "POST https://auth.example.com/token": {
            const form = new URLSearchParams(await request.text());
            tokenForms.push(form);
            if (form.get("grant_type") === "refresh_token")
              return Response.json({ access_token: "drive-2", expires_in: 3600 });
            if (form.get("code") !== "good-code")
              return Response.json({ error: "invalid_grant" }, { status: 400 });
            // Expires soon, so the next claim refreshes it.
            return Response.json({
              access_token: "drive-1",
              refresh_token: "drive-refresh",
              expires_in: 60,
            });
          }
          // Needs a token, with no OAuth to get one.
          case "POST https://tokens.example.com/mcp":
            return new Response(null, { status: 401 });
          case "POST https://open.example.com/mcp":
            return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
          // Like Slack: OAuth with the owner's own app, and errors as HTTP 200 with ok: false.
          case "POST https://chat.example.com/mcp":
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate":
                  'Bearer resource_metadata="https://chat.example.com/.well-known/oauth-protected-resource"',
              },
            });
          case "GET https://chat.example.com/.well-known/oauth-protected-resource":
            return Response.json({
              resource: "https://chat.example.com",
              authorization_servers: ["https://chat.example.com"],
              scopes_supported: ["channels:history", "chat:write", "users:read"],
            });
          case "GET https://chat.example.com/.well-known/oauth-authorization-server":
            return Response.json({
              issuer: "https://chat.example.com",
              authorization_endpoint: "https://chat.example.com/oauth/authorize",
              token_endpoint: "https://chat.example.com/api/oauth.access",
            });
          case "POST https://chat.example.com/api/oauth.access": {
            const form = new URLSearchParams(await request.text());
            tokenForms.push(form);
            if (form.get("code") !== "good-code")
              return Response.json({ ok: false, error: "invalid_code" });
            return Response.json({ ok: true, access_token: "xoxp-1" });
          }
        }
        return new Response("Not found", { status: 404 });
      };
    }

    /** Calls a hub MCP tool as an agent. */
    async function callTool(token: string, name: string, args: Record<string, unknown>) {
      const response = await client.request("/mcp", {
        method: "POST",
        json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        token,
      });
      const { result } = (await response.json()) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
      const text = result.content[0]?.text ?? "";
      return { isError: result.isError === true, text, json: () => JSON.parse(text) };
    }

    async function agentToken(name: string) {
      const people = await client.graphql<{ users: { nodes: { id: string; name: string }[] } }>(
        "{ users { nodes { id name } } }",
      );
      const id = people.data?.users.nodes.find((u) => u.name === name)?.id ?? "";
      const made = await client.graphql<{ apiTokenCreate: { token: string } }>(
        "mutation($id: String!) { apiTokenCreate(name: $id, userId: $id) { token } }",
        { id },
      );
      return { id, token: made.data?.apiTokenCreate.token ?? "" };
    }

    /** Starts a work run for the agent on a fresh machine and claims it. */
    async function claimFor(agentId: string) {
      const queued = await client.graphql<{ runs: { nodes: { id: string }[] } }>(
        "{ runs(filter: { status: [queued, running] }) { nodes { id } } }",
      );
      for (const run of queued.data?.runs.nodes ?? [])
        await client.graphql(
          'mutation($id: String!) { runStop(id: $id, reason: "Clearing") { success } }',
          { id: run.id },
        );
      const made = await client.graphql<{ machineSetupTokenCreate: { token: string } }>(
        "mutation { machineSetupTokenCreate { token } }",
      );
      const machine = await client.json<{ token: string }>("/api/runner/enrol", {
        method: "POST",
        json: {
          name: "MCP box",
          tags: ["personal", "gym"],
          setupToken: made.data?.machineSetupTokenCreate.token,
        },
      });
      await client.graphql(
        "mutation($input: RunCreateInput!) { runCreate(input: $input) { success } }",
        { input: { agentId, goal: "Use the outside tools" } },
      );
      const claim = await client.json<{
        mcpServers: Record<string, unknown>;
        input: { systemPrompt: string };
      }>("/api/runner/claim", { method: "POST", json: {}, token: machine.body.token });
      return claim.body;
    }

    it("connects an outside MCP server an agent asks for, once the owner signs in and approves", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fakeProviders());
      try {
        const coach = await agentToken("Coach");
        const asked = await callTool(coach.token, "create_mcp_server", {
          name: "Drive",
          url: "https://mcp.example.com/mcp",
          reason: "The training logs live in Drive.",
        });
        expect(asked.isError).toBe(false);
        const requestId = asked.json().id as string;
        type Server = { id: string; name: string; auth: string; status: string; url: string };
        const request = async () =>
          (
            await client.graphql<{
              request: { action: string; resource: string; details: string; mcpServer: Server };
            }>(
              "query($id: String!) { request(id: $id) { action resource details mcpServer { id name auth status url } } }",
              { id: requestId },
            )
          ).data?.request;
        const filed = await request();
        expect(filed).toMatchObject({
          action: "mcp.use",
          resource: "drive",
          mcpServer: { name: "drive", auth: "oauth", status: "pending" },
        });
        expect(filed?.details).toContain("https://mcp.example.com/mcp");

        const approve = (alwaysAllow?: unknown) =>
          client.graphql(
            "mutation($id: String!, $a: AlwaysAllowInput) { requestApprove(id: $id, alwaysAllow: $a) { success } }",
            { id: requestId, a: alwaysAllow },
          );
        expect((await approve()).errors?.[0]?.message).toBe("Connect drive first");

        // The owner signs in with the provider, which accepts the hub's client metadata.
        const connected = await client.graphql<{ mcpServerConnect: { authorizationUrl: string } }>(
          "mutation($id: String!) { mcpServerConnect(id: $id) { authorizationUrl } }",
          { id: filed?.mcpServer.id },
        );
        const authorize = new URL(connected.data?.mcpServerConnect.authorizationUrl ?? "");
        const clientId = "http://localhost/api/mcp/oauth/client.json";
        expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
          response_type: "code",
          client_id: clientId,
          redirect_uri: "http://localhost/api/mcp/oauth/callback",
          code_challenge_method: "S256",
          resource: "https://mcp.example.com/mcp",
          scope: "files:read",
        });
        const metadata = await client.json("/api/mcp/oauth/client.json");
        expect(metadata.body).toMatchObject({
          client_id: clientId,
          redirect_uris: ["http://localhost/api/mcp/oauth/callback"],
          token_endpoint_auth_method: "none",
        });

        const back = await client.request(
          `/api/mcp/oauth/callback?code=good-code&state=${authorize.searchParams.get("state")}`,
        );
        expect(back.status).toBe(302);
        expect(back.headers.get("location")).toBe(`http://localhost/request/${requestId}`);
        const exchange = tokenForms.at(-1);
        expect(exchange?.get("client_id")).toBe(clientId);
        const challenge = toBase64Url(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(exchange?.get("code_verifier") ?? ""),
            ),
          ),
        );
        expect(challenge).toBe(authorize.searchParams.get("code_challenge"));
        expect((await request())?.mcpServer.status).toBe("ready");
        const stale = await client.request("/api/mcp/oauth/callback?code=x&state=nope");
        expect(stale.headers.get("location")).toMatch(/^http:\/\/localhost\/approvals\?error=/);

        expect((await approve({ scope: "user" })).errors).toBeUndefined();
        // Its claim carries the server with a freshly refreshed token; others' don't.
        const claim = await claimFor(coach.id);
        expect(claim.input.systemPrompt).toContain("create_mcp_server");
        // A status or project the issue names that isn't here may live in an outside app.
        expect(claim.input.systemPrompt).toContain("don't swap in a guess");
        expect(claim.input.systemPrompt).toContain("Lead with the outcome");
        expect(claim.input.systemPrompt).toContain("Comment at milestones");
        expect(claim.mcpServers).toEqual({
          drive: {
            type: "http",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer drive-2" },
          },
        });
        expect(tokenForms.at(-1)?.get("refresh_token")).toBe("drive-refresh");
        expect((await claimFor((await agentToken("Chef")).id)).mcpServers).toEqual({});
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("connects MCP servers with a pasted token, a local command, or no sign-in", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fakeProviders());
      try {
        const coach = await agentToken("Coach");
        const ask = async (args: Record<string, unknown>) =>
          (
            await callTool(coach.token, "create_mcp_server", { reason: "Need it.", ...args })
          ).json() as { id: string };
        const server = async (requestId: string) =>
          (
            await client.graphql<{
              request: { details: string; mcpServer: { id: string; auth: string; status: string } };
            }>(
              "query($id: String!) { request(id: $id) { details mcpServer { id auth status } } }",
              { id: requestId },
            )
          ).data?.request;
        const connect = (id: string | undefined, token: string) =>
          client.graphql<{ mcpServerConnect: { mcpServer: { status: string } } }>(
            "mutation($id: String!, $t: String) { mcpServerConnect(id: $id, token: $t) { mcpServer { status } } }",
            { id, t: token },
          );
        const approve = (id: string, always: boolean) =>
          client.graphql(
            "mutation($id: String!, $a: AlwaysAllowInput) { requestApprove(id: $id, alwaysAllow: $a) { success } }",
            { id, a: always ? { scope: "user" } : null },
          );

        const notion = await ask({
          name: "notion",
          url: "https://tokens.example.com/mcp",
          howToConnect: "Create an internal integration token at notion.so/my-integrations.",
        });
        expect((await server(notion.id))?.mcpServer).toMatchObject({ auth: "token" });
        const pasted = await connect((await server(notion.id))?.mcpServer.id, "notion-token");
        expect(pasted.data?.mcpServerConnect.mcpServer.status).toBe("ready");
        await approve(notion.id, false);

        const github = await ask({
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          secretEnv: "GITHUB_TOKEN",
        });
        const local = await server(github.id);
        expect(local?.mcpServer.auth).toBe("token");
        expect(local?.details).toContain("npx -y @modelcontextprotocol/server-github");
        await connect(local?.mcpServer.id, "ghp_123");
        await approve(github.id, true);

        const weather = await ask({ name: "weather", url: "https://open.example.com/mcp" });
        expect((await server(weather.id))?.mcpServer).toMatchObject({
          auth: "none",
          status: "ready",
        });
        await approve(weather.id, true);

        // A name already taken: others ask to use it; its user already has it.
        const chef = await agentToken("Chef");
        const shared = (
          await callTool(chef.token, "create_mcp_server", {
            name: "github",
            command: "uvx",
            reason: "Recipes repo.",
          })
        ).json();
        expect(shared).toMatchObject({ action: "mcp.use", resource: "github", requester: "Chef" });
        expect((await server(shared.id))?.mcpServer.id).toBe(local?.mcpServer.id);
        expect((await ask({ name: "github", command: "npx" })) as unknown).toMatchObject({
          message: expect.stringContaining("already yours"),
        });

        const servers = (await claimFor(coach.id)).mcpServers;
        expect(servers).toMatchObject({
          notion: {
            type: "http",
            url: "https://tokens.example.com/mcp",
            headers: { Authorization: "Bearer notion-token" },
          },
          github: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "ghp_123" },
          },
          weather: { type: "http", url: "https://open.example.com/mcp" },
        });
        expect(servers.weather).not.toHaveProperty("headers");
        // The one-time approval for notion was used up by that claim.
        expect(Object.keys((await claimFor(coach.id)).mcpServers).sort()).toEqual([
          "drive",
          "github",
          "weather",
        ]);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("signs in with a provider's published client, the owner pasting the address they land on", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fakeProviders());
      try {
        const coach = await agentToken("Coach");
        const ask = (args: Record<string, unknown>) =>
          callTool(coach.token, "create_mcp_server", {
            name: "chat",
            url: "https://chat.example.com/mcp",
            scopes: ["channels:history"],
            reason: "Read the team's channel.",
            ...args,
          });
        const unregistered = await ask({});
        expect(unregistered.isError).toBe(true);
        expect(unregistered.text).toContain("callbackPort");

        const asked = await ask({ oauth: { clientId: "app-1", callbackPort: 3118 } });
        const requestId = asked.json().id as string;
        const filed = await client.graphql<{
          request: { mcpServer: { id: string; auth: string; pastesCallback: boolean } };
        }>("query($id: String!) { request(id: $id) { mcpServer { id auth pastesCallback } } }", {
          id: requestId,
        });
        const server = filed.data?.request.mcpServer;
        expect(server).toMatchObject({ auth: "oauth", pastesCallback: true });

        const connect = (callbackUrl?: string) =>
          client.graphql<{
            mcpServerConnect: { authorizationUrl: string | null; mcpServer: { status: string } };
          }>(
            "mutation($id: String!, $url: String) { mcpServerConnect(id: $id, callbackUrl: $url) { authorizationUrl mcpServer { status } } }",
            { id: server?.id, url: callbackUrl },
          );
        const started = await connect();
        const authorize = new URL(started.data?.mcpServerConnect.authorizationUrl ?? "");
        const redirectUri = "http://localhost:3118/callback";
        expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
          client_id: "app-1",
          redirect_uri: redirectUri,
          scope: "channels:history",
          code_challenge_method: "S256",
        });

        const state = authorize.searchParams.get("state");
        const wrong = await connect(`${redirectUri}?code=good-code&state=other`);
        expect(wrong.errors?.[0]?.message).toContain("another sign-in");
        const refused = await connect(`${redirectUri}?code=bad&state=${state}`);
        expect(refused.errors?.[0]?.message).toContain("invalid_code");
        // Each sign-in is used once, so the owner signs in again.
        const retry = new URL((await connect()).data?.mcpServerConnect.authorizationUrl ?? "");
        const pasted = await connect(
          `${redirectUri}?code=good-code&state=${retry.searchParams.get("state")}`,
        );
        expect(pasted.data?.mcpServerConnect.mcpServer.status).toBe("ready");
        const exchange = tokenForms.at(-1);
        expect(exchange?.get("redirect_uri")).toBe(redirectUri);
        expect(exchange?.has("client_secret")).toBe(false);
        const challenge = toBase64Url(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(exchange?.get("code_verifier") ?? ""),
            ),
          ),
        );
        expect(challenge).toBe(retry.searchParams.get("code_challenge"));

        await client.graphql(
          "mutation($id: String!) { requestApprove(id: $id, alwaysAllow: { scope: user }) { success } }",
          { id: requestId },
        );
        expect((await claimFor(coach.id)).mcpServers.chat).toEqual({
          type: "http",
          url: "https://chat.example.com/mcp",
          headers: { Authorization: "Bearer xoxp-1" },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("uses each sign-in once, and signs in again when the agent asks again", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fakeProviders());
      try {
        // Drive is ready and always allowed; its tokens stopped working, so the agent asks again.
        const coach = await agentToken("Coach");
        const asked = await callTool(coach.token, "create_mcp_server", {
          name: "drive",
          reason: "Drive rejects my token.",
        });
        expect(asked.json()).toMatchObject({ title: "Sign in to drive again", status: "pending" });
        const filed = await client.graphql<{ request: { mcpServer: { id: string } } }>(
          "query($id: String!) { request(id: $id) { mcpServer { id } } }",
          { id: asked.json().id },
        );
        const connected = await client.graphql<{ mcpServerConnect: { authorizationUrl: string } }>(
          "mutation($id: String!) { mcpServerConnect(id: $id) { authorizationUrl } }",
          { id: filed.data?.request.mcpServer.id },
        );
        const state = new URL(
          connected.data?.mcpServerConnect.authorizationUrl ?? "",
        ).searchParams.get("state");

        // The browser sends the callback twice at once: only one exchanges the code.
        const exchanges = () =>
          tokenForms.filter((f) => f.get("grant_type") === "authorization_code").length;
        const before = exchanges();
        const back = await Promise.all(
          [1, 2].map(() => client.request(`/api/mcp/oauth/callback?code=good-code&state=${state}`)),
        );
        expect(exchanges()).toBe(before + 1);
        const errors = back.map((r) =>
          new URL(r.headers.get("location") ?? "").searchParams.get("error"),
        );
        expect(errors.sort()).toEqual([expect.stringContaining("already used"), null]);
        expect((await claimFor(coach.id)).mcpServers.drive).toMatchObject({
          headers: { Authorization: "Bearer drive-2" },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("lets managers answer their reports' requests and stop their runs, within their grants", async () => {
      const hire = async (name: string, managerId?: string) => {
        const made = await client.graphql<{ agentHire: { user: { id: string } } }>(
          "mutation($n: String!, $m: String) { agentHire(input: { name: $n, managerId: $m }) { user { id } } }",
          { n: name, m: managerId },
        );
        return made.data?.agentHire.user.id ?? "";
      };
      const leadId = await hire("Ops Lead");
      const internId = await hire("Ops Intern", await hire("Ops Analyst", leadId));
      await hire("Auditor");
      const [lead, intern, auditor] = await Promise.all(
        ["Ops Lead", "Ops Intern", "Auditor"].map(agentToken),
      );
      const grant = (action: string) =>
        client.graphql(
          "mutation($a: String!, $s: String) { grantCreate(input: { action: $a, scope: user, subjectId: $s }) { success } }",
          { a: action, s: leadId },
        );
      const ask = async (token: string, action: string) =>
        (await callTool(token, "create_request", { title: action, action, reason: "Work." })).json()
          .id as string;

      // Only someone above the requester answers, and an agent passes on only what its grants allow.
      const spend = await ask(intern?.token ?? "", "budget.spend");
      const byPeer = await callTool(auditor?.token ?? "", "reject_request", {
        id: spend,
        reason: "No.",
      });
      expect(byPeer.text).toContain("managers");
      const own = await callTool(intern?.token ?? "", "approve_request", { id: spend });
      expect(own.isError).toBe(true);
      expect((await callTool(lead?.token ?? "", "approve_request", { id: spend })).text).toContain(
        "grant",
      );
      await grant("budget.spend");
      const always = await client.graphql(
        "mutation($id: String!) { requestApprove(id: $id, alwaysAllow: { scope: user }) { success } }",
        { id: spend },
        lead?.token,
      );
      expect(always.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      expect(
        (await callTool(lead?.token ?? "", "approve_request", { id: spend })).json(),
      ).toMatchObject({ status: "approved", alwaysAllowed: false });
      expect(
        (
          await callTool(intern?.token ?? "", "check_permission", { action: "budget.spend" })
        ).json(),
      ).toMatchObject({ allowed: true, via: "approval" });

      // A one-time approval of its own isn't enough to pass on; rejecting needs a reason.
      const leadDeploy = await ask(lead?.token ?? "", "tool:Deploy");
      await client.graphql("mutation($id: String!) { requestApprove(id: $id) { success } }", {
        id: leadDeploy,
      });
      const deploy = await ask(intern?.token ?? "", "tool:Deploy");
      expect((await callTool(lead?.token ?? "", "approve_request", { id: deploy })).isError).toBe(
        true,
      );
      expect(
        (await callTool(lead?.token ?? "", "reject_request", { id: deploy, reason: " " })).isError,
      ).toBe(true);
      expect(
        (
          await callTool(lead?.token ?? "", "reject_request", { id: deploy, reason: "Not yet." })
        ).json(),
      ).toMatchObject({ status: "rejected", answer: "Not yet." });

      // Managers stop their reports' runs, with a reason.
      await client.graphql(
        "mutation($input: RunCreateInput!) { runCreate(input: $input) { success } }",
        { input: { agentId: internId, goal: "Tidy the shelves" } },
      );
      const queued: { id: string; agent: string; status: string; goal: string }[] = (
        await callTool(lead?.token ?? "", "list_runs", { agent: "Ops Intern", status: "queued" })
      ).json().runs;
      expect(queued.every((r) => r.agent === "Ops Intern" && r.status === "queued")).toBe(true);
      const runId = queued.find((r) => r.goal === "Tidy the shelves")?.id;
      expect(
        (await callTool(auditor?.token ?? "", "stop_run", { id: runId, reason: "Stop." })).isError,
      ).toBe(true);
      expect(
        (await callTool(lead?.token ?? "", "stop_run", { id: runId, reason: "" })).isError,
      ).toBe(true);
      expect(
        (await callTool(lead?.token ?? "", "stop_run", { id: runId, reason: "Not now." })).json(),
      ).toMatchObject({ id: runId, status: "canceled" });

      // Agents rename the company and set its time zone with a grant; model routing stays the owner's.
      const rename = { name: "Ops Co", timezone: "Europe/Paris" };
      expect((await callTool(lead?.token ?? "", "update_organization", rename)).text).toContain(
        "needs approval",
      );
      await grant("organization.update");
      expect((await callTool(lead?.token ?? "", "update_organization", rename)).json()).toEqual(
        rename,
      );
      const routing = await client.graphql(
        "mutation { organizationUpdate(input: { modelRouting: {} }) { success } }",
        undefined,
        lead?.token,
      );
      expect(routing.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    });

    it("lets agents edit, archive and delete what members can, through MCP", async () => {
      const mcp = async (name: string, args: Record<string, unknown>) => {
        const result = await callTool(ceoToken, name, args);
        if (result.isError) throw new Error(result.text);
        return result.json();
      };
      await client.graphql(
        'mutation { teamCreate(input: { name: "Travel", key: "TRV" }) { success } }',
      );

      // Teams and cycles: any member may change a team's settings.
      expect(
        await mcp("update_team", { id: "TRV", description: "Trips", cyclesEnabled: true }),
      ).toMatchObject({ key: "TRV", description: "Trips", cyclesEnabled: true });
      await mcp("update_cycle", { team: "TRV", cycle: "current", name: "Planning" });
      expect((await mcp("list_cycles", { team: "TRV" })).cycles).toContainEqual(
        expect.objectContaining({ name: "Planning", status: "current" }),
      );

      // Issues: relate and unrelate, archive and restore, unfollow and follow.
      const a = await mcp("create_issue", { title: "Renew passport", team: "TRV" });
      const b = await mcp("create_issue", { title: "Book flights", team: "TRV" });
      const relation = await mcp("create_issue_relation", {
        issueId: a.identifier,
        relatedIssueId: b.identifier,
        type: "blocks",
      });
      await mcp("delete_issue_relation", { id: relation.id });
      expect((await mcp("get_issue", { id: a.identifier })).relations).toEqual([]);
      expect((await mcp("update_issue", { id: b.identifier, archived: true })).archivedAt).toEqual(
        expect.any(String),
      );
      expect((await mcp("update_issue", { id: b.identifier, archived: false })).archivedAt).toBe(
        null,
      );
      const followers = async () =>
        (
          await client.graphql<{ issue: { subscribers: { nodes: { name: string }[] } } }>(
            "query($id: String!) { issue(id: $id) { subscribers { nodes { name } } } }",
            { id: a.identifier },
          )
        ).data?.issue.subscribers.nodes.map((u) => u.name);
      await mcp("update_issue", { id: a.identifier, subscribed: false });
      expect(await followers()).not.toContain("CEO");
      await mcp("update_issue", { id: a.identifier, subscribed: true });
      expect(await followers()).toContain("CEO");

      // Comments and reactions.
      const comment = await mcp("create_comment", { issueId: a.identifier, body: "Tpyo" });
      await mcp("update_comment", { id: comment.id, body: "Typo fixed" });
      expect((await mcp("list_comments", { issueId: a.identifier }))[0].body).toBe("Typo fixed");
      const reaction = await mcp("create_reaction", { emoji: "👍", commentId: comment.id });
      await mcp("delete_reaction", { id: reaction.id });
      await mcp("delete_comment", { id: comment.id });
      expect(await mcp("list_comments", { issueId: a.identifier })).toEqual([]);

      // Labels.
      const label = await mcp("create_issue_label", { name: "Visa", team: "TRV" });
      await mcp("update_issue_label", { id: label.id, name: "Visas" });
      const labelNames = async () =>
        (await mcp("list_issue_labels", { team: "TRV" })).map((l: { name: string }) => l.name);
      expect(await labelNames()).toContain("Visas");
      await mcp("delete_issue_label", { id: label.id });
      expect(await labelNames()).not.toContain("Visas");

      // Initiatives.
      const initiative = await mcp("save_initiative", { name: "See the world", status: "active" });
      await mcp("save_initiative", { id: "See the world", targetDate: "2027-06-01" });
      expect((await mcp("list_initiatives", {})).initiatives).toContainEqual(
        expect.objectContaining({ name: "See the world", targetDate: "2027-06-01" }),
      );
      await mcp("save_initiative", { id: initiative.id, archived: true });
      expect(JSON.stringify(await mcp("list_initiatives", {}))).not.toContain("See the world");

      // Projects: archive, updates and milestones.
      await mcp("create_project", { name: "Japan", teams: ["TRV"] });
      expect((await mcp("update_project", { id: "Japan", archived: true })).archivedAt).toEqual(
        expect.any(String),
      );
      await mcp("update_project", { id: "Japan", archived: false });
      const update = await mcp("create_project_update", { project: "Japan", body: "Booked" });
      await mcp("update_project_update", {
        id: update.id,
        body: "Flights booked",
        health: "atRisk",
      });
      expect((await mcp("get_project", { query: "Japan" })).latestUpdates).toEqual([
        expect.objectContaining({ body: "Flights booked", health: "atRisk" }),
      ]);
      await mcp("delete_project_update", { id: update.id });
      const milestone = await mcp("save_milestone", { project: "Japan", name: "Visa" });
      await mcp("delete_milestone", { id: milestone.id });
      expect(await mcp("get_project", { query: "Japan" })).toMatchObject({
        latestUpdates: [],
        milestones: [],
      });

      // Documents and templates.
      const doc = await mcp("create_document", { title: "Packing list", project: "Japan" });
      await mcp("update_document", { id: doc.id, archived: true });
      const titles = async () =>
        (await mcp("list_documents", { project: "Japan" })).documents.map(
          (d: { title: string }) => d.title,
        );
      expect(await titles()).toEqual([]);
      await mcp("update_document", { id: doc.id, archived: false });
      expect(await titles()).toEqual(["Packing list"]);
      const template = await mcp("save_template", { team: "TRV", name: "Trip", title: "Trip" });
      await mcp("delete_template", { id: template.id });
      expect((await mcp("list_templates", { team: "TRV" })).templates).toEqual([]);
    });

    it("tells a manager about its reports' requests and wakes it to screen them", async () => {
      const hire = async (name: string, managerId?: string) =>
        (
          await client.graphql<{ agentHire: { user: { id: string } } }>(
            "mutation($n: String!, $m: String) { agentHire(input: { name: $n, managerId: $m }) { user { id } } }",
            { n: name, m: managerId },
          )
        ).data?.agentHire.user.id ?? "";
      const bossId = await hire("Screen Boss");
      await hire("Screen Report", bossId);
      const [boss, report] = await Promise.all(["Screen Boss", "Screen Report"].map(agentToken));
      const inbox = async (token?: string) =>
        (
          await client.graphql<{ notifications: { nodes: { type: string; data: unknown }[] } }>(
            "{ notifications { nodes { type data } } }",
            undefined,
            token,
          )
        ).data?.notifications.nodes.filter((n) => n.type === "requestCreated") ?? [];
      const queuedFor = async (name: string) =>
        (
          await client.graphql<{ runs: { nodes: { agent: { name: string } }[] } }>(
            "{ runs(filter: { status: [queued] }) { nodes { agent { name } } } }",
          )
        ).data?.runs.nodes.filter((r) => r.agent.name === name).length;
      const ask = (token: string, action: string) =>
        callTool(token, "create_request", { title: action, action, reason: "Work." });
      const ownerBefore = (await inbox()).length;

      // The manager hears about it and wakes; the owner still does too, once.
      await ask(report?.token ?? "", "budget.spend");
      expect(await inbox(boss?.token)).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ title: "budget.spend" }) }),
      ]);
      expect(await queuedFor("Screen Boss")).toBe(1);
      expect((await inbox()).length).toBe(ownerBefore + 1);

      // A manager's own request goes to the owner only, and asking again files nothing new.
      await ask(boss?.token ?? "", "tool:Deploy");
      await ask(report?.token ?? "", "budget.spend");
      expect(await inbox(boss?.token)).toHaveLength(1);
      expect((await inbox()).length).toBe(ownerBefore + 2);
    });

    it("keeps metric definitions as data, counted from the audit log", async () => {
      await client.graphql('mutation { agentHire(input: { name: "Analyst" }) { success } }');
      const analyst = await agentToken("Analyst");
      const save = (args: Record<string, unknown>) => callTool(analyst.token, "save_metric", args);
      const created = { name: "Issues filed", numerator: { action: "issue.create" } };

      // Defining a metric needs metric.update; only structured filters over the log are accepted.
      expect((await save(created)).text).toContain("needs approval: metric.update");
      await client.graphql(
        'mutation($s: String) { grantCreate(input: { action: "metric.update", scope: user, subjectId: $s }) { success } }',
        { s: analyst.id },
      );
      expect((await save({ name: "Bad", numerator: { action: "x' or 1=1 --" } })).isError).toBe(
        true,
      );
      const metric = (await save({ ...created, direction: "up", target: 3 })).json();
      expect(metric).toMatchObject({ name: "Issues filed", direction: "up", target: 3 });
      expect((await save(created)).text).toContain("already");

      // The owner defines one too, a ratio; with nothing to divide by it is null.
      const ratio = await client.graphql<{ metricCreate: { metric: { id: string } } }>(
        `mutation { metricCreate(input: {
          name: "Comments per issue", unit: "comments",
          numerator: { action: "comment.create" },
          denominator: { action: "never.happens", entityType: "issue" }
        }) { metric { id } } }`,
      );
      expect(ratio.errors).toBeUndefined();

      for (const title of ["Q1 taxes", "Q2 taxes"])
        await callTool(analyst.token, "create_issue", { title, team: "TRV" });
      const mine = (await callTool(analyst.token, "get_metrics", { member: "me" })).json();
      expect(mine.custom).toContainEqual(
        expect.objectContaining({ name: "Issues filed", current: 2, previous: 0, target: 3 }),
      );
      expect(mine.custom).toContainEqual(
        expect.objectContaining({ name: "Comments per issue", current: null }),
      );

      // Changes and archiving are audited; archived metrics stop being measured.
      const update = await client.graphql(
        'mutation($id: String!) { metricUpdate(id: $id, input: { name: "Issues opened" }) { success } }',
        { id: metric.id },
        analyst.token,
      );
      expect(update.errors).toBeUndefined();
      const insights = await client.graphql<{
        insights: { metrics: { metric: { name: string }; value: number | null }[] };
      }>("{ insights(days: 7) { metrics { metric { name } value previousValue } } }");
      expect(insights.data?.insights.metrics).toContainEqual(
        expect.objectContaining({ metric: { name: "Issues opened" } }),
      );
      expect(
        insights.data?.insights.metrics.find((m) => m.metric.name === "Issues opened")?.value,
      ).toBeGreaterThanOrEqual(2);
      expect((await save({ id: metric.id, archived: true })).isError).toBe(false);
      const left = await client.graphql<{ metrics: { name: string }[] }>("{ metrics { name } }");
      expect(left.data?.metrics).toEqual([{ name: "Comments per issue" }]);
      const log = await client.graphql<{ auditEntries: { nodes: { action: string }[] } }>(
        "query($id: String) { auditEntries(entityId: $id) { nodes { action } } }",
        { id: metric.id },
      );
      expect(log.data?.auditEntries.nodes.map((n) => n.action).sort()).toEqual([
        "metric.archive",
        "metric.create",
        "metric.update",
      ]);
    });

    it("lets the owner and agents shape a team's statuses", async () => {
      const home = await client.graphql<{ teamCreate: { team: { id: string } } }>(
        'mutation { teamCreate(input: { name: "Home", key: "HOM" }) { team { id } } }',
      );
      const t = home.data?.teamCreate.team.id;
      const states = async () =>
        (
          await client.graphql<{ team: { states: { nodes: { id: string; name: string }[] } } }>(
            '{ team(id: "HOM") { states { nodes { id name } } } }',
          )
        ).data?.team.states.nodes ?? [];
      const id = async (name: string) => (await states()).find((s) => s.name === name)?.id;
      const names = async () => (await states()).map((s) => s.name);

      // The owner adds a status: it lands after the others of its type, in their color.
      const created = await client.graphql<{
        workflowStateCreate: { workflowState: { id: string; type: string; color: string } };
      }>(
        `mutation($t: String!) { workflowStateCreate(input: { teamId: $t, name: "Waiting", type: started }) {
          success workflowState { id type color }
        } }`,
        { t },
      );
      expect(created.errors).toBeUndefined();
      const waiting = created.data?.workflowStateCreate.workflowState;
      expect(waiting).toMatchObject({ type: "started", color: "#f2c94c" });
      expect(await names()).toEqual([
        "Triage",
        "Backlog",
        "Todo",
        "In Progress",
        "In Review",
        "Waiting",
        "Done",
        "Canceled",
        "Duplicate",
      ]);
      const clash = await client.graphql(
        'mutation($t: String!) { workflowStateCreate(input: { teamId: $t, name: "done", type: completed }) { success } }',
        { t },
      );
      expect(clash.errors?.[0]?.extensions?.code).toBe("CONFLICT");

      // Renames and moves it; the position is its place in the list.
      const moved = await client.graphql(
        'mutation($id: String!) { workflowStateUpdate(id: $id, input: { name: "On hold", position: 1 }) { success workflowState { name } } }',
        { id: waiting?.id },
      );
      expect(moved.errors).toBeUndefined();
      expect((await names()).slice(0, 3)).toEqual(["Triage", "On hold", "Backlog"]);

      // A status can go once no issue uses it, and each type keeps at least one.
      const archive = (stateId: string | undefined) =>
        client.graphql("mutation($id: String!) { workflowStateArchive(id: $id) { success } }", {
          id: stateId,
        });
      await client.graphql(
        'mutation($t: String!) { issueCreate(input: { teamId: $t, title: "Fix the tap" }) { success } }',
        { t },
      );
      expect((await archive(await id("Backlog"))).errors?.[0]?.message).toContain("issue");
      expect((await archive(await id("Todo"))).errors?.[0]?.message).toContain("last");
      expect((await archive(waiting?.id)).errors).toBeUndefined();
      expect(await names()).not.toContain("On hold");
      const log = await client.graphql<{ auditEntries: { nodes: { action: string }[] } }>(
        "query($id: String) { auditEntries(entityId: $id) { nodes { action } } }",
        { id: waiting?.id },
      );
      expect(log.data?.auditEntries.nodes.map((n) => n.action).sort()).toEqual([
        "workflowState.archive",
        "workflowState.create",
        "workflowState.update",
      ]);

      // Agents do the same through MCP.
      const mcp = async (name: string, args: Record<string, unknown>) => {
        const result = await callTool(ceoToken, name, args);
        if (result.isError) throw new Error(result.text);
        return result.json();
      };
      const errands = await mcp("create_issue_status", {
        team: "HOM",
        name: "Errands",
        type: "unstarted",
      });
      await mcp("update_issue_status", { id: errands.id, name: "Chores", position: 0 });
      expect((await mcp("list_issue_statuses", { team: "HOM" }))[0]).toMatchObject({
        name: "Chores",
        type: "unstarted",
      });
      await mcp("archive_issue_status", { id: errands.id });
      expect(await names()).not.toContain("Chores");
    });
  });
}
