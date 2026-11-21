import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDiagnostic, loadConfig, type LoadResult } from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rescade-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
}

const load = (env: Record<string, string | undefined> = { PW: "secret" }, extra = {}) =>
  loadConfig({ path: dir, env, ...extra });

/** Diagnostics as "file:line:col severity message" for easy matching. */
function lines(r: LoadResult): string[] {
  return r.diagnostics.map((d) => formatDiagnostic(d, dir));
}

const REPOS = `
repos:
  a:
    path: /backups/a
    password: \${PW}
    retention: { daily: 7 }
  b:
    group: offsite
    path: sftp:host:b
    password: \${PW}
    from: a
    retention: { weekly: 4 }
`;
const SETS = `
sets:
  s:
    include: [/etc]
`;
const CASCADE = `
cascades:
  c:
    group: nightly
    schedule: "0 */4 * * *"
    steps:
      - backup: { set: s, repo: a }
      - retain: { repo: a }
      - copy: { from: a, to: b }
`;

describe("loading", () => {
  it("loads and normalizes a valid config split over several files", async () => {
    await write({ "00-repos.yaml": REPOS, "01-sets.yml": SETS, "02-cascades.yaml": CASCADE });
    const r = await load();
    expect(lines(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => path.basename(f))).toEqual(["00-repos.yaml", "01-sets.yml", "02-cascades.yaml"]);
    const c = r.config!;
    expect(c.repos.a!.password).toBe("secret");
    expect(c.repos.b!.from).toBe("a");
    expect(c.repos.b!.group).toBe("offsite");
    expect(c.repos.a!.group).toBeUndefined();
    expect(c.sets.s).toMatchObject({ include: ["/etc"], exclude: [], oneFileSystem: false });
    expect(c.cascades.c).toMatchObject({ group: "nightly", schedule: ["0 */4 * * *"], onBusy: "skip" });
    expect(c.cascades.c!.steps.map((s) => s.type)).toEqual(["backup", "retain", "copy"]);
    expect(r.referencedEnv).toEqual(["PW"]);
    expect(r.origins["repos/a"]).toMatchObject({ line: 3, col: 3 });
  });

  it("allows a section to be split across files", async () => {
    await write({
      "a.yaml": "repos:\n  a: { path: /a, password: x, retention: { daily: 1 } }\n",
      "b.yaml": "repos:\n  b: { path: /b, password: x }\n",
      "c.yaml": SETS,
    });
    const r = await load();
    expect(r.ok).toBe(true);
    expect(Object.keys(r.config!.repos)).toEqual(["a", "b"]);
  });

  it("accepts a single file as the path", async () => {
    await write({ "only.yaml": REPOS + SETS + CASCADE });
    const r = await loadConfig({ path: path.join(dir, "only.yaml"), env: { PW: "x" } });
    expect(lines(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("ignores non-yaml, hidden and backup files", async () => {
    await write({
      "00.yaml": REPOS + SETS + CASCADE,
      "notes.txt": "not yaml: [",
      ".hidden.yaml": "garbage: [",
      "old.yaml~": "garbage: [",
    });
    const r = await load();
    expect(r.files).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  it("tolerates empty and comment-only files", async () => {
    await write({ "00.yaml": "", "01.yaml": "# nothing here\n", "02.yaml": REPOS + SETS + CASCADE });
    expect((await load()).ok).toBe(true);
  });

  it("reports a missing or empty config location", async () => {
    const missing = await loadConfig({ path: path.join(dir, "nope") });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics[0]!.message).toMatch(/not found/);
    const empty = await load();
    expect(empty.ok).toBe(false);
    expect(empty.diagnostics[0]!.message).toMatch(/no \.yaml or \.yml files/);
  });
});

describe("yaml problems", () => {
  it("reports syntax errors with file, line and column", async () => {
    await write({ "bad.yaml": "repos:\n  a:\n    path: [unclosed\n" });
    const r = await load();
    expect(r.ok).toBe(false);
    expect(lines(r)[0]).toMatch(/^bad\.yaml:\d+:\d+: error: /);
  });

  it("explains unquoted glob patterns", async () => {
    await write({ "bad.yaml": "sets:\n  p:\n    include: [/x]\n    exclude:\n      - **/venv\n" });
    const r = await load();
    expect(r.ok).toBe(false);
    expect(lines(r).join("\n")).toMatch(/bad\.yaml:5:9: error: .*wrap it in quotes/);
  });

  it("hints that ${VAR} needs quotes inside flow collections", async () => {
    await write({ "bad.yaml": "repos:\n  a: { path: /a, password: ${PW} }\n" });
    const r = await load();
    expect(r.ok).toBe(false);
    expect(lines(r).join("\n")).toMatch(/must be quoted/);
  });

  it("rejects tab indentation", async () => {
    await write({ "bad.yaml": "repos:\n\ta:\n\t\tpath: /x\n" });
    const r = await load();
    expect(r.ok).toBe(false);
    expect(lines(r)[0]).toMatch(/^bad\.yaml:2:/);
  });

  it("rejects duplicate keys inside one file", async () => {
    await write({ "bad.yaml": "cascades:\n  c: { steps: [] }\n  c: { steps: [] }\n" });
    const r = await load();
    expect(r.ok).toBe(false);
    expect(lines(r).join("\n")).toMatch(/bad\.yaml:3:3: error: /);
  });

  it("rejects an unknown top-level key and a non-mapping root", async () => {
    await write({ "a.yaml": "reops: {}\n", "b.yaml": "- just\n- a list\n" });
    const r = await load();
    expect(lines(r)).toEqual([
      'a.yaml:1:1: error: unknown top-level key "reops" (expected: repos, sets, cascades, notifications)',
      "b.yaml:1:1: error: top level must be a mapping with the sections: repos, sets, cascades, notifications",
    ]);
  });
});

describe("merging", () => {
  it("rejects the same name in two files and points at both", async () => {
    await write({
      "00.yaml": "repos:\n  a: { path: /a, password: x }\n",
      "01.yaml": "repos:\n  a: { path: /other, password: x }\n",
    });
    const r = await load();
    expect(r.ok).toBe(false);
    expect(lines(r)).toHaveLength(1);
    expect(lines(r)[0]).toMatch(/^01\.yaml:2:3: error: duplicate repo "a" \(already defined at .*00\.yaml:2:3\)$/);
  });

  it("allows the same name in different sections", async () => {
    await write({
      "00.yaml":
        "repos:\n  x: { path: /a, password: p }\nsets:\n  x: { include: [/e] }\ncascades:\n  x:\n    steps:\n      - backup: { set: x, repo: x }\n",
    });
    expect((await load()).ok).toBe(true);
  });

  it("rejects awkward entry names", async () => {
    await write({ "00.yaml": "repos:\n  'a b': { path: /a, password: x }\n" });
    const r = await load();
    expect(lines(r)[0]).toMatch(/^00\.yaml:2:3: error: invalid repo name "a b"/);
  });
});

describe("schema errors", () => {
  it("flags unknown keys at the key itself", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n    password: x\n    keey-yearly: 3\n" });
    const r = await load();
    expect(lines(r)).toEqual(['00.yaml:5:5: error: unknown key "keey-yearly"']);
  });

  it("flags unknown keys inside retention", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n    password: x\n    retention: { keey-yearly: 3 }\n" });
    const r = await load();
    expect(lines(r)[0]).toMatch(/^00\.yaml:5:18: error: unknown key "keey-yearly"/);
  });

  it("names missing required fields and points at the entry", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n" });
    const r = await load();
    expect(lines(r)).toEqual(['00.yaml:2:3: error: missing required field "password"']);
  });

  it("hints when a number was meant to be a string", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n    password: 12345\n" });
    const r = await load();
    expect(lines(r)[0]).toMatch(/^00\.yaml:4:15: error: .*quote the value/);
  });

  it("rejects empty values and empty retention", async () => {
    await write({
      "00.yaml": "repos:\n  a: { path: '', password: x }\n  b: { path: /b, password: x, retention: {} }\n",
    });
    const r = await load();
    expect(lines(r)[0]).toMatch(/^00\.yaml:2:\d+: error: must not be empty/);
    expect(lines(r)[1]).toMatch(/^00\.yaml:3:\d+: error: retention must set at least one/);
  });

  it("reports errors in several entries in one run", async () => {
    await write({
      "00.yaml": "repos:\n  a: { path: /a }\n  b: { password: x }\nsets:\n  s: { include: [] }\n",
    });
    const r = await load();
    expect(r.diagnostics.filter((d) => d.severity === "error")).toHaveLength(3);
  });
});

describe("environment variables", () => {
  it("fails on unset variables, pointing at the value", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n    password: ${PW}\n" });
    const r = await load({});
    expect(r.ok).toBe(false);
    expect(lines(r)).toEqual([
      "00.yaml:4:15: error: environment variable PW is not set (write ${PW:-default} to give it a default)",
    ]);
  });

  it("downgrades to warnings with missingEnv: warn, without extra errors", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n    password: ${PW}\n" });
    const r = await load({}, { missingEnv: "warn" });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
    expect(r.missingEnv).toEqual(["PW"]);
    expect(r.config!.repos.a!.password).toBe("<PW is unset>");
  });

  it("lists nothing as missing when everything is set", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n    password: ${PW}\n" });
    expect((await load()).missingEnv).toEqual([]);
  });

  it("honors defaults and escapes", async () => {
    await write({ "00.yaml": "repos:\n  a:\n    path: /a\n    password: ${PW:-fallback}$$x\n" });
    const r = await load({});
    expect(r.config!.repos.a!.password).toBe("fallback$x");
  });

  it("expands inside lists and nested maps, but not keys", async () => {
    await write({
      "00.yaml":
        "repos:\n  a:\n    path: /a\n    password: x\n    env: { '${KEY}': '${VAL}' }\nsets:\n  s: { include: ['${DIR}'] }\n",
    });
    const r = await load({ DIR: "/srv", VAL: "v" });
    expect(r.config!.sets.s!.include).toEqual(["/srv"]);
    expect(lines(r)).toEqual([]);
    expect(r.config!.repos.a!.env).toEqual({ "${KEY}": "v" });
  });

  it("reports malformed references", async () => {
    await write({ "00.yaml": "repos:\n  a: { path: /a, password: '${' }\n" });
    const r = await load();
    expect(lines(r)[0]).toMatch(/^00\.yaml:2:\d+: error: unterminated/);
  });
});

describe("cross-references", () => {
  const base = REPOS + SETS;

  it("flags unknown sets and repos in steps with their position", async () => {
    await write({
      "00.yaml":
        base +
        "cascades:\n  c:\n    steps:\n      - backup: { set: nope, repo: a }\n      - retain: { repo: zzz }\n",
    });
    const r = await load();
    expect(lines(r).map((l) => l.replace(/^00\.yaml:/, ""))).toEqual([
      expect.stringMatching(/^\d+:\d+: error: unknown set "nope"$/),
      expect.stringMatching(/^\d+:\d+: error: unknown repo "zzz"$/),
    ]);
  });

  it("allows a cascade to refer to repos defined in another file", async () => {
    await write({ "00.yaml": REPOS, "01.yaml": SETS, "02.yaml": CASCADE });
    expect((await load()).ok).toBe(true);
  });

  it("requires retention on repos used by retain", async () => {
    await write({
      "00.yaml":
        "repos:\n  a: { path: /a, password: x }\ncascades:\n  c:\n    steps:\n      - retain: { repo: a }\n",
    });
    const r = await load();
    expect(lines(r)[0]).toMatch(/^00\.yaml:6:.*error: repo "a" has no retention policy/);
  });

  it("flags unknown and self-referencing from", async () => {
    await write({
      "00.yaml": "repos:\n  a: { path: /a, password: x, from: ghost }\n  b: { path: /b, password: x, from: b }\n",
    });
    const r = await load();
    expect(lines(r)).toEqual([
      '00.yaml:2:37: error: unknown repo "ghost"',
      "00.yaml:3:37: error: a repo cannot be created from itself",
    ]);
  });

  it("reports a from cycle once", async () => {
    await write({
      "00.yaml":
        "repos:\n  a: { path: /a, password: x, from: c }\n  b: { path: /b, password: x, from: a }\n  c: { path: /c, password: x, from: b }\n",
    });
    const r = await load();
    expect(r.diagnostics.filter((d) => /cycle/.test(d.message))).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it("rejects copying a repo onto itself", async () => {
    await write({ "00.yaml": base + "cascades:\n  c:\n    steps:\n      - copy: { from: a, to: a }\n" });
    const r = await load();
    expect(lines(r)[0]).toMatch(/error: copy needs two different repos/);
  });

  it("warns, but does not fail, when copy links repos that are not related by from", async () => {
    await write({
      "00.yaml":
        "repos:\n  a: { path: /a, password: x }\n  b: { path: /b, password: x }\ncascades:\n  c:\n    steps:\n      - copy: { from: a, to: b }\n",
    });
    const r = await load();
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: "warning" });
    expect(r.diagnostics[0]!.message).toMatch(/not linked by "from"/);
  });

  it("does not warn when repos share a root through from", async () => {
    await write({
      "00.yaml":
        "repos:\n  a: { path: /a, password: x }\n  b: { path: /b, password: x, from: a }\n  c: { path: /c, password: x, from: b }\ncascades:\n  k:\n    steps:\n      - copy: { from: a, to: c }\n      - copy: { from: c, to: b }\n",
    });
    const r = await load();
    expect(lines(r)).toEqual([]);
  });

  it("checks lock lists on run steps", async () => {
    await write({
      "00.yaml": "repos:\n  a: { path: /a, password: x }\ncascades:\n  c:\n    steps:\n      - run: { command: [/bin/true], lock: [a, ghost] }\n",
    });
    const r = await load();
    expect(lines(r)).toHaveLength(1);
    expect(lines(r)[0]).toMatch(/error: unknown repo "ghost"/);
  });
});

describe("backends", () => {
  const repo = (body: string) => `repos:\n  a:\n    password: p\n${body}`;

  it("accepts every restic backend with its own options", async () => {
    await write({
      "00.yaml": [
        "repos:",
        "  local: { path: /srv/r, password: p, options: { local.connections: 4 } }",
        "  explicit: { path: 'local:dir:with:colons', password: p }",
        "  sftp: { path: 'sftp:user@host:/r', password: p, options: { sftp.args: '-i /etc/key' } }",
        "  sftp-url: { path: 'sftp://user@[::1]:2222//r', password: p }",
        "  rest: { path: 'rest:https://u:p@host:8000/r/', password: p }",
        "  s3: { path: 's3:s3.us-east-1.amazonaws.com/b', password: p, env: { AWS_ACCESS_KEY_ID: k }, options: { s3.storage-class: STANDARD_IA } }",
        "  swift: { path: 'swift:c:/p', password: p }",
        "  b2: { path: 'b2:bucket:path', password: p, options: { b2.connections: 10 } }",
        "  azure: { path: 'azure:c:/', password: p, options: { azure.access-tier: Cool } }",
        "  gs: { path: 'gs:b:/', password: p, options: { gs.region: eu } }",
        "  rclone: { path: 'rclone:remote:path', password: p, options: { rclone.program: /usr/bin/rclone } }",
        "",
      ].join("\n"),
    });
    const r = await load();
    expect(lines(r)).toEqual([]);
    expect(Object.keys(r.config!.repos)).toHaveLength(11);
  });

  it("rejects a prefix restic would read as a local directory", async () => {
    await write({ "00.yaml": repo("    path: i1.backups.lan:backups/system\n") + "  b: { path: 'S3:x/y', password: p }\n" });
    expect(lines(await load())).toEqual([
      '00.yaml:4:11: error: "i1.backups.lan:" is not a restic backend (local, sftp, rest, s3, swift, b2, azure, gs, rclone). Write "sftp:i1.backups.lan:backups/system" for SFTP, or "local:i1.backups.lan:backups/system" for a local directory with ":" in its name',
      '00.yaml:5:14: error: "S3:" is not a restic backend (local, sftp, rest, s3, swift, b2, azure, gs, rclone). Write "sftp:S3:x/y" for SFTP, or "local:S3:x/y" for a local directory with ":" in its name',
    ]);
  });

  it("checks option names against the repo's backend", async () => {
    await write({
      "00.yaml": repo("    path: sftp:host:r\n    options: { s3.region: x, sftp.argz: y, region: z, foo.bar: w }\n"),
    });
    const r = await load();
    expect(lines(r)).toEqual([
      '00.yaml:5:16: error: option "s3.region" is for the s3 backend, but this repo uses sftp; restic would ignore it',
      '00.yaml:5:30: warning: option "sftp.argz" is unknown to rescade (known sftp options: args, command, connections); restic fails on options it does not know',
      '00.yaml:5:44: error: unknown option "region": options look like "<backend>.<name>"',
      '00.yaml:5:55: error: unknown option "foo.bar": options look like "<backend>.<name>"',
    ]);
  });

  it("rejects variables that rescade sets itself", async () => {
    await write({ "00.yaml": repo("    path: /r\n    env: { RESTIC_PASSWORD: x, RESTIC_FROM_REPOSITORY: y }\n") });
    expect(lines(await load())).toEqual([
      '00.yaml:5:12: error: RESTIC_PASSWORD is set by rescade from "path" and "password"; remove it from env',
      '00.yaml:5:32: error: RESTIC_FROM_REPOSITORY is set by rescade from "path" and "password"; remove it from env',
    ]);
  });

  const S3_PAIR = (bEnv: string, bOptions = "") => `
repos:
  a:
    path: s3:host/a
    password: p
    env: { AWS_ACCESS_KEY_ID: ka, AWS_SECRET_ACCESS_KEY: sa }
  b:
    path: s3:host/b
    password: p
    from: a
    env: ${bEnv}
${bOptions}sets:
  s: { include: [/x] }
cascades:
  c:
    steps:
      - copy: { from: a, to: b }
`;

  it("rejects credentials that one restic process cannot hold for both repos", async () => {
    await write({ "00.yaml": S3_PAIR("{ AWS_ACCESS_KEY_ID: kb, AWS_SECRET_ACCESS_KEY: sb }") });
    const r = await load();
    expect(r.ok).toBe(false);
    const hint =
      "restic runs once for both repos; copy into both from a repo on another backend, put REST credentials into the URL and SFTP keys into ~/.ssh/config, or use the rclone backend with a remote per account (see docs/backends.md)";
    expect(lines(r)).toEqual([
      `00.yaml:10:11: error: init --from-repo: env AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY differ between "a" and "b", but restic would use the values of "b" for both; ${hint}`,
      `00.yaml:17:9: error: env AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY differ between "a" and "b", but restic would use the values of "b" for both; ${hint}`,
    ]);
  });

  it("accepts the same credentials and warns about ones set on one side only", async () => {
    await write({
      "00.yaml": S3_PAIR("{ AWS_ACCESS_KEY_ID: ka, AWS_SECRET_ACCESS_KEY: sa }", "    options: { s3.region: eu }\n"),
    });
    const r = await load();
    expect(r.ok).toBe(true);
    expect(lines(r).map((l) => l.replace(/;.*/, ""))).toEqual([
      '00.yaml:10:11: warning: init --from-repo: option s3.region set on only one of "a" and "b" also applies to the other',
      '00.yaml:18:9: warning: option s3.region set on only one of "a" and "b" also applies to the other',
    ]);
  });

  it("only warns about differing env when the backends differ", async () => {
    await write({
      "00.yaml":
        "repos:\n  a: { path: /a, password: p, env: { RESTIC_CACERT: /x }, options: { local.connections: 2 } }\n" +
        "  b: { path: 'rest:https://h/', password: p, from: a, env: { RESTIC_CACERT: /y }, options: { rest.connections: 9 } }\n",
    });
    const r = await load();
    expect(r.ok).toBe(true);
    expect(lines(r).map((l) => l.replace(/, but.*/, ""))).toEqual([
      '00.yaml:3:52: warning: init --from-repo: env RESTIC_CACERT differ between "a" and "b"',
    ]);
  });
});

describe("cascades", () => {
  const head = REPOS + SETS;

  it("rejects bad cron expressions and time zones", async () => {
    await write({
      "00.yaml":
        head +
        "cascades:\n  c:\n    schedule: ['0 */4 * * *', 'every day']\n    timezone: Mars/Base\n    steps:\n      - retain: { repo: a }\n",
    });
    const r = await load();
    expect(lines(r)).toHaveLength(2);
    expect(lines(r).join("\n")).toMatch(/invalid cron expression "every day"/);
    expect(lines(r).join("\n")).toMatch(/unknown time zone "Mars\/Base"/);
  });

  it("accepts a single cron string and a list", async () => {
    await write({
      "00.yaml":
        head +
        "cascades:\n  one:\n    schedule: '0 3 * * *'\n    steps:\n      - retain: { repo: a }\n  two:\n    schedule: ['0 3 * * *', '30 15 * * 1']\n    steps:\n      - retain: { repo: a }\n  none:\n    steps:\n      - retain: { repo: a }\n",
    });
    const r = await load();
    expect(r.ok).toBe(true);
    expect(r.config!.cascades.one!.schedule).toHaveLength(1);
    expect(r.config!.cascades.two!.schedule).toHaveLength(2);
    expect(r.config!.cascades.none!.schedule).toEqual([]);
  });

  it("handles on-busy and wait-timeout", async () => {
    await write({
      "00.yaml":
        head +
        "cascades:\n  w:\n    on-busy: wait\n    wait-timeout: 2h\n    steps:\n      - retain: { repo: a }\n  bad:\n    on-busy: skip\n    wait-timeout: 2h\n    steps:\n      - retain: { repo: a }\n",
    });
    const r = await load();
    expect(lines(r)).toHaveLength(1);
    expect(lines(r)[0]).toMatch(/error: wait-timeout only applies with on-busy: wait/);
  });

  it("rejects an invalid on-busy value and an empty steps list", async () => {
    await write({ "00.yaml": head + "cascades:\n  c:\n    on-busy: later\n    steps: []\n" });
    const r = await load();
    expect(r.diagnostics.filter((d) => d.severity === "error").length).toBeGreaterThanOrEqual(2);
    expect(lines(r).join("\n")).toMatch(/a cascade needs at least one step/);
  });

  it("still validates steps when the cascade header is broken", async () => {
    await write({
      "00.yaml": head + "cascades:\n  c:\n    on-busy: later\n    steps:\n      - nonsense: {}\n",
    });
    const r = await load();
    expect(lines(r).join("\n")).toMatch(/unknown step action "nonsense"/);
  });
});

describe("notifications", () => {
  const head = REPOS + SETS + CASCADE;
  const TOKEN = "123456:ABC-def_1";

  it("reads a telegram notification with defaults and merges notifications across files", async () => {
    await write({
      "00.yaml": head + `notifications:\n  ops:\n    type: telegram\n    token: \${TG}\n    chat: -1001234567890\n`,
      "01.yaml": `notifications:\n  nightly:\n    type: telegram\n    token: "${TOKEN}"\n    chat: "@backups"\n    thread: 7\n    events: [failed, success, failed]\n    cascades: [c]\n`,
    });
    const r = await load({ PW: "secret", TG: TOKEN });
    expect(lines(r)).toEqual([]);
    expect(r.config!.notifications).toEqual({
      ops: {
        type: "telegram",
        token: TOKEN,
        chat: "-1001234567890",
        events: ["failed", "interrupted", "warning", "recovered", "reload-failed", "repo-problem"],
      },
      nightly: { type: "telegram", token: TOKEN, chat: "@backups", thread: 7, events: ["failed", "success"], cascades: ["c"] },
    });
  });

  it("reports bad fields, unknown cascades and duplicates with positions", async () => {
    await write({
      "00.yaml":
        head +
        `notifications:\n  ops:\n    type: slack\n    token: "${TOKEN}"\n    chat: x\n    events: [failed, exploded]\n    cascades: [c, nope]\n  t:\n    type: telegram\n    token: "${TOKEN}"\n    chat: x\n    cascades: [nope]\n`,
      "01.yaml": `notifications:\n  t:\n    type: telegram\n    token: x\n    chat: x\n`,
    });
    const r = await load();
    expect(r.ok).toBe(false);
    const text = lines(r).join("\n");
    expect(text).toMatch(/00\.yaml:\d+:\d+: error: type must be "telegram"/);
    expect(text).toMatch(/00\.yaml:\d+:\d+: error: expected one of: failed, interrupted/);
    expect(text).toMatch(/00\.yaml:\d+:\d+: error: unknown cascade "nope"/);
    expect(text).toMatch(/01\.yaml:2:3: error: duplicate notification "t"/);
  });

  it("warns about a token that does not look like a bot token, but not about an unset one", async () => {
    await write({ "00.yaml": head + "notifications:\n  ops:\n    type: telegram\n    token: secret\n    chat: 1\n" });
    expect(lines(await load())).toEqual([
      expect.stringMatching(/00\.yaml:\d+:12: warning: this does not look like a Telegram bot token/),
    ]);
    await write({ "00.yaml": head + "notifications:\n  ops:\n    type: telegram\n    token: ${TG}\n    chat: 1\n" });
    expect(lines(await load({ PW: "x" }, { missingEnv: "warn" }))).toEqual([
      expect.stringMatching(/warning: environment variable TG is not set/),
    ]);
  });
});

describe("steps", () => {
  const head = REPOS + SETS;
  const cascade = (steps: string) => head + "cascades:\n  c:\n    steps:\n" + steps;

  it("requires exactly one action", async () => {
    await write({
      "00.yaml": cascade(
        "      - {}\n      - { backup: { set: s, repo: a }, retain: { repo: a } }\n      - just a string\n      - { name: lonely }\n",
      ),
    });
    const r = await load();
    const text = lines(r).join("\n");
    expect(text).toMatch(/step has no action/);
    expect(text).toMatch(/a step can have only one action, found: backup, retain/);
    expect(text).toMatch(/a step must be a mapping/);
  });

  it("reports typos in action names and fields", async () => {
    await write({
      "00.yaml": cascade("      - backups: { set: s, repo: a }\n      - backup: { set: s, repo: a, rpeo: a }\n"),
    });
    const r = await load();
    const text = lines(r).join("\n");
    expect(text).toMatch(/unknown step action "backups"/);
    expect(text).toMatch(/unknown key "rpeo"/);
  });

  it("requires the fields each action needs", async () => {
    await write({ "00.yaml": cascade("      - backup: { repo: a }\n      - copy: { from: a }\n      - retain: {}\n") });
    const r = await load();
    const text = lines(r).join("\n");
    expect(text).toMatch(/missing required field "set"/);
    expect(text).toMatch(/missing required field "to"/);
    expect(text).toMatch(/missing required field "repo"/);
  });

  it("parses every action with its options", async () => {
    await write({
      "00.yaml": cascade(
        [
          "      - backup: { set: s, repo: a, tags: [nightly] }",
          "      - { name: tidy, retain: { repo: a } }",
          "      - prune: { repo: a, max-unused: 5% }",
          "      - check: { repo: a, read-data-subset: 5% }",
          "      - copy: { from: a, to: b }",
          "",
        ].join("\n"),
      ),
    });
    const r = await load();
    expect(lines(r)).toEqual([]);
    expect(r.config!.cascades.c!.steps).toEqual([
      { type: "backup", name: undefined, set: "s", repo: "a", tags: ["nightly"] },
      { type: "retain", name: "tidy", repo: "a" },
      { type: "prune", name: undefined, repo: "a", maxUnused: "5%" },
      { type: "check", name: undefined, repo: "a", readDataSubset: "5%" },
      { type: "copy", name: undefined, from: "a", to: "b" },
    ]);
  });

  it("parses run steps: argv by default, shell on request, timeout default", async () => {
    await write({
      "00.yaml": cascade(
        [
          "      - run: { command: [/bin/dump, --all], timeout: 10m, env: { PGUSER: backup }, cwd: /tmp }",
          "      - run: { command: 'pg_dump | gzip > /x', shell: true }",
          "",
        ].join("\n"),
      ),
    });
    const r = await load();
    expect(lines(r)).toEqual([]);
    const [argv, sh] = r.config!.cascades.c!.steps;
    expect(argv).toMatchObject({
      type: "run",
      shell: false,
      command: ["/bin/dump", "--all"],
      timeoutMs: 600_000,
      env: { PGUSER: "backup" },
      cwd: "/tmp",
      lock: [],
    });
    expect(sh).toMatchObject({ type: "run", shell: true, command: "pg_dump | gzip > /x", timeoutMs: 3_600_000 });
  });

  it("rejects mismatched command forms and bad timeouts", async () => {
    await write({
      "00.yaml": cascade(
        [
          "      - run: { command: 'echo hi' }",
          "      - run: { command: [echo, hi], shell: true }",
          "      - run: { command: [] }",
          "      - run: { command: [/bin/true], timeout: soon }",
          "",
        ].join("\n"),
      ),
    });
    const r = await load();
    const text = lines(r).join("\n");
    expect(text).toMatch(/use shell: true to run a shell string/);
    expect(text).toMatch(/with shell: true, command must be a single string/);
    expect(text).toMatch(/command must not be empty/);
    expect(text).toMatch(/expected a duration/);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toHaveLength(4);
  });

  it("explains YAML scalars that were not meant to be arguments", async () => {
    await write({
      "00.yaml": cascade("      - run: { command: [systemctl, stop, 123, true] }\n"),
    });
    const r = await load();
    expect(lines(r)).toHaveLength(1);
    expect(lines(r)[0]).toMatch(/error: command arguments must be strings \(quote it: "123"\)/);
  });

  it("reports a missing command together with other problems in the same step", async () => {
    await write({ "00.yaml": cascade("      - run: { timeout: soon }\n") });
    const r = await load();
    const text = lines(r).join("\n");
    expect(text).toMatch(/missing required field "command"/);
    expect(text).toMatch(/expected a duration/);
  });
});

describe("misc", () => {
  it("parses extra repo and set options", async () => {
    await write({
      "00.yaml":
        "repos:\n  a:\n    path: s3:x/y\n    password: p\n    env: { AWS_ACCESS_KEY_ID: k, N: 5 }\n    options: { s3.region: eu-west-1 }\n    retention: { last: 3, within: 1y6m }\nsets:\n  s:\n    include: [/x]\n    tags: [t]\n    one-file-system: true\n    exclude-caches: true\n",
    });
    const r = await load();
    expect(lines(r)).toEqual([]);
    expect(r.config!.repos.a).toMatchObject({
      env: { AWS_ACCESS_KEY_ID: "k", N: "5" },
      options: { "s3.region": "eu-west-1" },
      retention: { last: 3, within: "1y6m" },
    });
    expect(r.config!.sets.s).toMatchObject({ tags: ["t"], oneFileSystem: true, excludeCaches: true });
  });

  it("does not return a config when there are errors", async () => {
    await write({ "00.yaml": "repos:\n  a: { path: /a }\n" });
    const r = await load();
    expect(r.ok).toBe(false);
    expect(r.config).toBeUndefined();
  });
});
