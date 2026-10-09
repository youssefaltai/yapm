import { hubContract } from "@life-os/core/testing";
import { createNodeApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createNodeRealtime } from "../src/realtime.js";

// Every live event the hub publishes, to check open apps hear about each change.
const liveLog: unknown[] = [];

// Push services are the outside world: record what the hub would send them. Other calls
// (MCP providers) go to the global fetch, which the contract fakes.
const pushOutbox: Request[] = [];
const recordPush: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== "push.example.com") return fetch(request);
  pushOutbox.push(request);
  return new Response(null, { status: 201 });
};

hubContract(
  "node",
  async () => {
    const { db } = await openDatabase(":memory:");
    const realtime = createNodeRealtime();
    const app = createNodeApp({
      db,
      config: { platform: "node", version: "test", secret: "test secret" },
      realtime: {
        connect: (c) => realtime.connect(c),
        publish: (event) => {
          liveLog.push(event);
          return realtime.publish(event);
        },
      },
      fetch: recordPush,
    });
    return async (request) => app.fetch(request);
  },
  { pushOutbox, liveLog },
);
