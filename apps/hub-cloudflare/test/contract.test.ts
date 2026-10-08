import { exports } from "cloudflare:workers";
import { hubContract } from "@life-os/core/testing";

hubContract("cloudflare", async () => (request) => exports.default.fetch(request), {
  liveSocket: (response) => {
    const socket = response.webSocket;
    socket?.accept();
    return socket;
  },
});
