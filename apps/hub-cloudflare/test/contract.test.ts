import { exports } from "cloudflare:workers";
import { hubContract } from "@yapm/core/testing";

hubContract("cloudflare", async () => (request) => exports.default.fetch(request), {
  liveSocket: (response) => {
    const socket = response.webSocket;
    socket?.accept();
    return socket;
  },
});
