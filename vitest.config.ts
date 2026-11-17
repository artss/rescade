import path from "node:path";
import { defineConfig } from "vitest/config";

// tests of the daemon, the CLI and the web UI use the core sources, not its build
export const coreAlias = { "@rescade/core": path.join(import.meta.dirname, "packages/core/src/index.ts") };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias: coreAlias }, test: { name: "node", include: ["packages/{core,daemon,cli}/test/**/*.test.ts", "scripts/**/*.test.ts"] } },
      "packages/web",
    ],
  },
});
