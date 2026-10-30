import { defineConfig } from "vitest/config";

// graphql ships CommonJS and ESM builds. Pothos and Yoga load the CommonJS one through Node, so
// the hub's own imports must too, or their schema types come from two realms.
export default defineConfig({
  resolve: { alias: [{ find: /^graphql$/, replacement: "graphql/index.js" }] },
});
