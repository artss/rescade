import { defineConfig } from "vitest/config";

/** Runs against a real restic ($RESCADE_RESTIC or restic on PATH) on repos in temporary directories. */
export default defineConfig({
  test: { include: ["packages/*/test/**/*.integration.ts"], testTimeout: 60_000 },
});
