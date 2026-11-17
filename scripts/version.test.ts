import { describe, expect, it } from "vitest";
// @ts-expect-error a plain JS script without types
import { nextVersion } from "./version.mjs";

describe("nextVersion", () => {
  it("starts at 0.1.0", () => {
    expect(nextVersion(undefined, ["feat: first"])).toBe("0.1.0");
  });

  it("bumps the patch for anything but feat and breaking changes", () => {
    expect(nextVersion("0.3.4", ["fix(web): a", "Merge pull request #20 from x/y", "docs: b", "chore: c"])).toBe("0.3.5");
    expect(nextVersion("0.3.4", [])).toBe("0.3.5");
  });

  it("bumps the minor for feat", () => {
    expect(nextVersion("0.3.4", ["fix: a", "feat(cli): b\n\nbody"])).toBe("0.4.0");
    expect(nextVersion("1.3.4", ["feat: b"])).toBe("1.4.0");
    expect(nextVersion("1.3.4", ["fix: featured"])).toBe("1.3.5");
  });

  it("bumps the major for a breaking change, the minor before 1.0", () => {
    expect(nextVersion("1.3.4", ["refactor(core)!: a"])).toBe("2.0.0");
    expect(nextVersion("1.3.4", ["fix: a\n\nBREAKING CHANGE: the API moved"])).toBe("2.0.0");
    expect(nextVersion("0.3.4", ["feat!: a"])).toBe("0.4.0");
  });

  it("rejects a tag that is not X.Y.Z", () => {
    expect(() => nextVersion("1.2", [])).toThrow("not a version");
  });
});
