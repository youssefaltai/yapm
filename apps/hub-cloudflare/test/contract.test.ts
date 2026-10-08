import { exports } from "cloudflare:workers";
import { hubContract } from "@life-os/core/testing";

hubContract("cloudflare", async () => (request) => exports.default.fetch(request));
