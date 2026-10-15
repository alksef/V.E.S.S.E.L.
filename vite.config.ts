import { defineConfig } from "vite";

export default defineConfig({
  // Relative base keeps the bundle portable when it is served from the Tauri shell (task 003).
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
  },
});
