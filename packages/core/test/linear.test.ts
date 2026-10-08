import { createClient } from "@libsql/client";
import * as schema from "@life-os/schema";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { describe, expect, it } from "vitest";
import { commit, type HubDb } from "../src/db.js";
import { seedCompany } from "../src/seed.js";
import { exportCompany, exportIssuesCsv } from "../src/services/export.js";
import { fetchLinear, importLinear } from "../src/services/linear.js";

const migrationsFolder = decodeURIComponent(
  new URL("../../schema/migrations", import.meta.url).pathname,
);

const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: !!endCursor, endCursor },
});

const issue = (n: number, extra: Record<string, unknown>) => ({
  id: `i${n}`,
  number: n,
  title: `Issue ${n}`,
  description: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  team: { id: "t1" },
  state: { id: "s-todo" },
  assignee: null,
  project: null,
  parent: null,
  labels: page([]),
  comments: page([]),
  ...extra,
});

/** Linear's GraphQL API, answering the queries the importer sends. */
const sent: { auth: string | null; query: string; after: unknown }[] = [];
async function linear(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const { query, variables } = (await request.json()) as {
    query: string;
    variables?: { after?: string | null };
  };
  sent.push({ auth: request.headers.get("authorization"), query, after: variables?.after });
  if (request.headers.get("authorization") !== "lin_api_good")
    return Response.json({ errors: [{ message: "Authentication required" }] }, { status: 401 });
  const data = query.includes("viewer")
    ? {
        viewer: { id: "me" },
        teams: page([
          {
            id: "t1",
            key: "FIN",
            name: "Finance",
            description: "Money",
            color: "#00aa00",
            states: page([
              { id: "s-done", name: "Done", type: "completed", color: "#0f0", position: 3 },
              { id: "s-todo", name: "Todo", type: "unstarted", color: "#ccc", position: 1 },
              { id: "s-back", name: "Backlog", type: "backlog", color: "#999", position: 0 },
            ]),
          },
        ]),
      }
    : query.includes("issueLabels")
      ? {
          issueLabels: page([
            { id: "l1", name: "Bills", color: "#f00", description: null, team: { id: "t1" } },
            { id: "l2", name: "Urgent", color: "#f80", description: null, team: null },
          ]),
        }
      : query.includes("projects(")
        ? {
            projects: page([
              {
                id: "p1",
                name: "Pay off the car",
                description: null,
                color: "#00f",
                state: "started",
                startDate: "2026-09-01",
                targetDate: "2026-12-31",
                teams: page([{ id: "t1" }]),
              },
            ]),
          }
        : variables?.after
          ? {
              issues: page([
                issue(42, {
                  title: "Pay the car loan",
                  parent: { id: "i7" },
                  assignee: { id: "someone-else" },
                  labels: page([{ id: "l2" }]),
                }),
              ]),
            }
          : {
              issues: page(
                [
                  issue(7, {
                    title: "Set up autopay",
                    state: { id: "s-done" },
                    completedAt: "2026-09-03T10:00:00.000Z",
                    assignee: { id: "me" },
                    project: { id: "p1" },
                    priority: 2,
                    labels: page([{ id: "l1" }, { id: "l2" }]),
                    comments: page([
                      {
                        id: "c1",
                        body: "Done with the bank.",
                        createdAt: "2026-09-03T09:00:00.000Z",
                        user: { id: "me", name: "Youssef" },
                        parent: null,
                      },
                      {
                        id: "c2",
                        body: "Thanks!",
                        createdAt: "2026-09-03T09:30:00.000Z",
                        user: { id: "someone-else", name: "Sam" },
                        parent: { id: "c1" },
                      },
                    ]),
                  }),
                ],
                "cursor-1",
              ),
            };
  return Response.json({ data });
}

async function company(now: number) {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  const hub = db as unknown as HubDb;
  await commit(
    hub,
    seedCompany(hub, { ownerId: "owner", ownerName: "Youssef", companyName: "Co", now }),
  );
  return hub;
}

describe("moving in from Linear", () => {
  it("keeps keys, numbers, workflows, labels, projects and comments", async () => {
    const now = Date.parse("2026-10-08T10:00:00Z");
    const db = await company(now);
    await expect(fetchLinear("lin_api_bad", linear)).rejects.toThrow("didn't accept");
    const data = await fetchLinear("lin_api_good", linear);
    expect(sent.filter((s) => s.query.includes("issues(")).map((s) => s.after)).toEqual([
      null,
      "cursor-1",
    ]);
    await expect(importLinear({ db, actorId: "ceo", now }, data)).rejects.toThrow();
    const counts = await importLinear({ db, actorId: "owner", now }, data);
    expect(counts).toEqual({ teams: 1, labels: 2, projects: 1, issues: 2, comments: 2 });

    const [team] = await db.select().from(schema.teams).all();
    expect(team).toMatchObject({ key: "FIN", name: "Finance", issueCount: 42 });
    const states = await db.select().from(schema.workflowStates).all();
    expect(states.sort((a, b) => a.position - b.position).map((s) => s.name)).toEqual([
      "Backlog",
      "Todo",
      "Done",
    ]);
    const rows = await db.select().from(schema.issues).all();
    const autopay = rows.find((i) => i.number === 7);
    const loan = rows.find((i) => i.number === 42);
    expect(autopay).toMatchObject({
      title: "Set up autopay",
      assigneeId: "owner",
      priority: 2,
      completedAt: Date.parse("2026-09-03T10:00:00.000Z"),
    });
    expect(autopay?.projectId).not.toBeNull();
    expect(loan).toMatchObject({ parentId: autopay?.id, assigneeId: null });
    const notes = await db.select().from(schema.comments).all();
    const reply = notes.find((c) => c.body.includes("Thanks!"));
    expect(reply?.body).toBe("**Sam** wrote in Linear:\n\nThanks!");
    expect(reply?.parentId).toBe(notes.find((c) => c.body === "Done with the bank.")?.id);
    expect((await db.select().from(schema.issueLabels).all()).length).toBe(3);

    await expect(importLinear({ db, actorId: "owner", now }, data)).rejects.toThrow(
      "Teams already use FIN",
    );

    const csv = await exportIssuesCsv(db, "owner");
    expect(csv.split("\r\n")[0]).toContain("ID,Team,Title");
    expect(csv).toContain("FIN-7,Finance,Set up autopay");
    expect(csv).toContain('"Bills, Urgent"');
    const dump = await exportCompany(db, "owner", now);
    expect(dump).toMatchObject({ format: "life-os-export", version: 1 });
    expect((dump as unknown as { issues: unknown[] }).issues).toHaveLength(2);
    expect(JSON.stringify(dump)).not.toContain("tokenHash");
  });
});
