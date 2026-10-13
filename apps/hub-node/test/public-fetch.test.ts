import { describe, expect, it } from "vitest";
import { publicFetch } from "../src/public-fetch.js";

describe("publicFetch", () => {
  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost:8787/",
  ])("refuses %s", async (url) => {
    await expect(publicFetch(url)).rejects.toThrow(/private address/);
  });
});
