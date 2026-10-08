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

    it("seeds the company: leadership, teams, workflow states and labels", async () => {
      const result = await client.graphql<{
        organization: { name: string; urlKey: string };
        viewer: { kind: string; isMe: boolean; directReports: { nodes: { name: string }[] } };
        teams: {
          nodes: {
            key: string;
            lead: { name: string };
            states: { nodes: { name: string; type: string }[] };
            labels: { nodes: { name: string }[] };
          }[];
        };
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
        teams { nodes { key lead { name } states { nodes { name type } } labels { nodes { name } } } }
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
      expect(data.teams.nodes.map((t) => t.key).sort()).toEqual([
        "CAR",
        "FIN",
        "HLT",
        "HOM",
        "LRN",
        "OPS",
        "REL",
      ]);
      const ops = data.teams.nodes.find((t) => t.key === "OPS");
      expect(ops?.lead.name).toBe("Chief of Staff");
      expect(ops?.states.nodes.map((s) => s.name)).toEqual([
        "Triage",
        "Backlog",
        "Todo",
        "In Progress",
        "In Review",
        "Done",
        "Canceled",
        "Duplicate",
      ]);
      expect(ops?.labels.nodes).toHaveLength(5);
      const ceo = data.users.nodes.find((u) => u.name === "CEO");
      expect(ceo).toMatchObject({ kind: "agent", manager: { name: "Youssef" } });
      expect(ceo?.charter).toContain("morning brief");
    });

    it("records every founding change in the audit log", async () => {
      const result = await client.graphql<{
        auditEntries: { nodes: { action: string; actor: { name: string } }[] };
      }>("{ auditEntries(first: 100) { nodes { action actor { name } } } }");
      const actions = result.data?.auditEntries.nodes.map((n) => n.action) ?? [];
      expect(actions.filter((a) => a === "team.create")).toHaveLength(7);
      expect(actions.filter((a) => a === "user.create")).toHaveLength(3);
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
    });
  });
}
