import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tests of the daemon and the CLI use the core sources, not its build
  resolve: { alias: { "@rescade/core": path.join(import.meta.dirname, "packages/core/src/index.ts") } },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
