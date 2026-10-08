import { hubContract } from "@life-os/core/testing";
import { createNodeApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";

hubContract("node", async () => {
  const { db } = await openDatabase(":memory:");
  const app = createNodeApp({ db, config: { platform: "node", version: "test" } });
  return async (request) => app.fetch(request);
});
