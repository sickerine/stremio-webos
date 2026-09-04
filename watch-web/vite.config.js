import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  publicDir: "public",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", sourcemap: true },
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: { "/ws": { target: "ws://127.0.0.1:3211", ws: true }, "/status": "http://127.0.0.1:3211", "/health": "http://127.0.0.1:3211" },
  },
});
