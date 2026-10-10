import { createApiToken } from "@yapm/core";
import { comments, notifications, projectUpdates, requests, users } from "@yapm/schema";
import { describe, expect, it } from "vitest";
import { createNodeApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";

describe("the Inbox", () => {
  // D1 on the free plan allows 50 queries per request; the web Inbox asks for 100 rows.
  it("loads 100 notifications in a handful of queries", async () => {
    const { db, client } = await openDatabase(":memory:");
    await db.insert(users).values({
      id: "u",
      kind: "owner",
      name: "o",
      displayName: "O",
      createdAt: 0,
      updatedAt: 0,
    });
    const { token } = await createApiToken(db, { userId: "u", name: "t", actorId: "u" }, 0);
    const app = createNodeApp({ db, config: { platform: "node", version: "test" } });

    let next = 0;
    async function addNotifications(n: number) {
      for (let i = 0; i < n; i++, next++) {
        const id = `x${next}`;
        const at = { createdAt: next, updatedAt: next };
        await db.insert(comments).values({ id, issueId: "i", userId: "u", body: "b", ...at });
        await db.insert(requests).values({
          id,
          requesterId: "u",
          title: "t",
          action: "a",
          reason: "r",
          ...at,
        });
        await db
          .insert(projectUpdates)
          .values({ id, projectId: "p", userId: "u", body: "b", health: "onTrack", ...at });
        await db.insert(notifications).values({
          id,
          userId: "u",
          type: "issueMention",
          commentId: id,
          requestId: id,
          projectUpdateId: id,
          ...at,
        });
      }
    }

    async function queriesForInbox() {
      let count = 0;
      const execute = client.execute.bind(client);
      client.execute = ((...args: Parameters<typeof execute>) => {
        count++;
        return execute(...args);
      }) as typeof client.execute;
      const response = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            query:
              "{ notifications(first: 100) { nodes { comment { id } request { id } projectUpdate { id } } } }",
          }),
        }),
      );
      client.execute = execute;
      const { data } = (await response.json()) as {
        data: { notifications: { nodes: Record<string, { id: string } | null>[] } };
      };
      return { count, rows: data.notifications.nodes };
    }

    await addNotifications(100);
    const { count, rows } = await queriesForInbox();
    expect(rows).toHaveLength(100);
    expect(rows.every((n) => n.comment && n.request && n.projectUpdate)).toBe(true);
    expect(count).toBeLessThan(10);
  });
});
