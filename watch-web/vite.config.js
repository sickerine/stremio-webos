import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  publicDir: "public",
  build: {
    outDir: "../dist", emptyOutDir: true, target: "es2022", sourcemap: true,
    rolldownOptions: { input: {
      index: fileURLToPath(new URL("./web/index.html", import.meta.url)),
      comparison: fileURLToPath(new URL("./web/comparison.html", import.meta.url)),
    } },
  },
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: { "/ws": { target: "ws://127.0.0.1:3211", ws: true }, "/status": "http://127.0.0.1:3211", "/health": "http://127.0.0.1:3211", "/comparison/media": "http://127.0.0.1:3211" },
  },
});
