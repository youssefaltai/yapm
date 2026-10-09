import { hubContract } from "@life-os/core/testing";
import { createNodeApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createNodeRealtime } from "../src/realtime.js";

// Every live event the hub publishes, to check open apps hear about each change.
const liveLog: unknown[] = [];

// Push services are the outside world: record what the hub would send them.
const pushOutbox: Request[] = [];
const recordPush: typeof fetch = async (input, init) => {
  pushOutbox.push(new Request(input, init));
  return new Response(null, { status: 201 });
};

hubContract(
  "node",
  async () => {
    const { db } = await openDatabase(":memory:");
    const realtime = createNodeRealtime();
    const app = createNodeApp({
      db,
      config: { platform: "node", version: "test" },
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
