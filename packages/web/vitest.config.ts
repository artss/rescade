import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { coreAlias } from "../../vitest.config.js";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: coreAlias },
  test: {
    name: "web",
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    // a real daemon with the fake restic, shared by the test files
    globalSetup: ["test/daemon.setup.ts"],
    setupFiles: ["test/dom.setup.ts"],
  },
});
