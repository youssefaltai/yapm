import { hubContract } from "@life-os/core/testing";
import { createNodeApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createNodeRealtime } from "../src/realtime.js";

hubContract("node", async () => {
  const { db } = await openDatabase(":memory:");
  const app = createNodeApp({
    db,
    config: { platform: "node", version: "test" },
    realtime: createNodeRealtime(),
  });
  return async (request) => app.fetch(request);
});
