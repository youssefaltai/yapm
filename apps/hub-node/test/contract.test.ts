import { hubContract } from "@life-os/core/testing";
import { createNodeApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createNodeRealtime } from "../src/realtime.js";

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
    const app = createNodeApp({
      db,
      config: { platform: "node", version: "test" },
      realtime: createNodeRealtime(),
      fetch: recordPush,
    });
    return async (request) => app.fetch(request);
  },
  { pushOutbox },
);
