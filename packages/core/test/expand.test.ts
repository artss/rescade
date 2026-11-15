import { describe, expect, it } from "vitest";
import { expandString } from "../src/config/expand.js";

describe("expandString", () => {
  it("expands set variables", () => {
    const r = expandString("sftp:${HOST}:backups/${NAME}", { HOST: "i1", NAME: "home" });
    expect(r.value).toBe("sftp:i1:backups/home");
    expect(r.referenced).toEqual(["HOST", "NAME"]);
    expect(r.missing).toEqual([]);
  });

  it("reports unset variables and expands them to nothing", () => {
    const r = expandString("pw-${SECRET}", {});
    expect(r.value).toBe("pw-");
    expect(r.missing).toEqual(["SECRET"]);
  });

  it("uses a default when the variable is unset or empty", () => {
    expect(expandString("${A:-x}", {}).value).toBe("x");
    expect(expandString("${A:-x}", { A: "" }).value).toBe("x");
    expect(expandString("${A:-x}", { A: "y" }).value).toBe("y");
    expect(expandString("${A:-x}", {}).missing).toEqual([]);
  });

  it("keeps an empty variable that has no default", () => {
    const r = expandString("${A}", { A: "" });
    expect(r.value).toBe("");
    expect(r.missing).toEqual([]);
  });

  it("treats $$ as a literal dollar and leaves a lone $ alone", () => {
    expect(expandString("cost $$5 and $HOME", { HOME: "no" }).value).toBe("cost $5 and $HOME");
  });

  it("does not expand values that came from the environment", () => {
    expect(expandString("${A}", { A: "${B}", B: "boom" }).value).toBe("${B}");
  });

  it("reports malformed references", () => {
    expect(expandString("${}", {}).errors).toHaveLength(1);
    expect(expandString("${1BAD}", {}).errors).toHaveLength(1);
    expect(expandString("${OPEN", {}).errors).toEqual(['unterminated "${" reference']);
  });

  it("can substitute a placeholder for missing variables", () => {
    expect(expandString("${A}", {}, (n) => `<${n}>`).value).toBe("<A>");
  });
});
