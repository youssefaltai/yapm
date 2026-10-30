import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { hubContract } from "@yapm/core/testing";
import worker from "../src/worker.js";

hubContract("cloudflare", async () => (request) => exports.default.fetch(request), {
  liveSocket: (response) => {
    const socket = response.webSocket;
    socket?.accept();
    return socket;
  },
  tick: async (at) => {
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: at }), env, ctx);
    await waitOnExecutionContext(ctx);
  },
});
