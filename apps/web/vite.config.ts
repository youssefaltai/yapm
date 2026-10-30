import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hub = process.env.HUB_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The hub serves the app in production; in development Vite proxies to it.
    proxy: { "/api": { target: hub, ws: true }, "/graphql": hub },
  },
});
