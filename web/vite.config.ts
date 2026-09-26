// The page builds to web/dist, which the API serves (no second server). In
// development, `npm run dev:web` proxies API calls to the API on :8080.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = "http://localhost:8080";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // Shared pure modules (tree validation, digits) come from ../src.
    fs: { allow: [".."] },
    proxy: {
      "/v1": api,
      "/api": api,
      "/page": api,
      "/local-storage": api,
    },
  },
});
