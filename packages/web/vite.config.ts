import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` proxies the API to a running daemon (its Host check accepts the rewritten Host)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": { target: process.env.RESCADE_URL || "http://127.0.0.1:8765", changeOrigin: true } },
  },
});
