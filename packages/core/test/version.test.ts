import { describe, expect, it } from "vitest";
import { checkResticVersion, parseResticVersion } from "../src/index.js";
import { FAKE_RESTIC, FakeState } from "./helpers/fake.js";

describe("parseResticVersion", () => {
  it("reads release and development builds", () => {
    expect(parseResticVersion("restic 0.19.1 compiled with go1.26.4 on linux/amd64\n")).toBe("0.19.1");
    expect(parseResticVersion("restic 0.18.0-dev (compiled manually) compiled with go1.24.0 on darwin/arm64")).toBe("0.18.0");
    expect(parseResticVersion("something else")).toBeUndefined();
  });
});

describe("checkResticVersion", () => {
  it("accepts 0.17 and newer", async () => {
    const fake = await FakeState.create();
    try {
      expect(await checkResticVersion(FAKE_RESTIC, fake.env())).toEqual({ version: "0.18.0" });
      expect(await checkResticVersion(FAKE_RESTIC, fake.env({ FAKE_RESTIC_VERSION: "0.17.0" }))).toEqual({ version: "0.17.0" });
      expect(fake.calls()).toEqual([]);
    } finally {
      await fake.remove();
    }
  });

  it("warns about an older restic and says what goes wrong", async () => {
    const fake = await FakeState.create();
    try {
      const r = await checkResticVersion(FAKE_RESTIC, fake.env({ FAKE_RESTIC_VERSION: "0.16.4" }));
      expect(r.version).toBe("0.16.4");
      expect(r.warning).toContain("restic 0.16.4");
      expect(r.warning).toContain("older than 0.17.0");
      expect(r.warning).toContain("missing repos will not be initialized");
    } finally {
      await fake.remove();
    }
  });

  it("warns when restic cannot be started or fails", async () => {
    const missing = await checkResticVersion("/nonexistent/restic", { PATH: "/usr/bin:/bin" });
    expect(missing.version).toBeUndefined();
    expect(missing.warning).toMatch(/^could not start restic "\/nonexistent\/restic": .*ENOENT/);

    // the fake without its state directory exits with 2
    const failed = await checkResticVersion(FAKE_RESTIC, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
    expect(failed.warning).toMatch(/version" failed with exit code 2: fake-restic: FAKE_RESTIC_STATE is not set$/);
  });
});
