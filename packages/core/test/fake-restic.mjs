#!/usr/bin/env node
// A stand-in for restic in tests. It keeps repos as JSON files and logs every call.
//
// State in $FAKE_RESTIC_STATE:
//   repos/<encoded path>.json   { id, chunker_polynomial, password }
//   calls.jsonl                 one line per call: { cmd, args, options, repo, from, ... }
//   sigterm                     created when a hanging call receives SIGTERM
//
// Switches (environment):
//   FAKE_RESTIC_EXIT_<CMD>=n     fail <CMD> (BACKUP, INIT, CAT, COPY, CHECK, FORGET, PRUNE) with exit code n;
//                                backup still prints its summary, as real restic does for code 3
//   FAKE_RESTIC_UNREACHABLE=a,b  repository paths that fail like an unreachable host (exit 1)
//   FAKE_RESTIC_HANG=<cmd>       hang in <cmd> until signalled; SIGTERM exits with 130
//   FAKE_RESTIC_IGNORE_TERM=1    ignore SIGTERM while hanging (only SIGKILL helps)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const env = process.env;
const state = env.FAKE_RESTIC_STATE;
if (!state) {
  process.stderr.write("fake-restic: FAKE_RESTIC_STATE is not set\n");
  process.exit(2);
}
fs.mkdirSync(path.join(state, "repos"), { recursive: true });

const options = [];
const rest = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-o") options.push(argv[++i]);
  else rest.push(argv[i]);
}
const [cmd, ...args] = rest;
const repoPath = env.RESTIC_REPOSITORY;
const fromPath = env.RESTIC_FROM_REPOSITORY;

fs.appendFileSync(
  path.join(state, "calls.jsonl"),
  JSON.stringify({
    cmd,
    args,
    options,
    repo: repoPath,
    from: fromPath,
    hasPassword: env.RESTIC_PASSWORD !== undefined,
    hasFromPassword: env.RESTIC_FROM_PASSWORD !== undefined,
    envKeys: Object.keys(env).sort(),
  }) + "\n",
);

const fatal = (code, message) => {
  process.stderr.write(`Fatal: ${message}\n`);
  process.exit(code);
};
const file = (p) => path.join(state, "repos", encodeURIComponent(p) + ".json");
const unreachable = (env.FAKE_RESTIC_UNREACHABLE ?? "").split(",").filter(Boolean);

function open(p, password) {
  if (unreachable.includes(p)) fatal(1, `unable to open repository at ${p}: dial tcp: connect: no route to host`);
  if (!fs.existsSync(file(p))) {
    fatal(10, `repository does not exist: unable to open config file: stat ${p}/config: no such file or directory`);
  }
  const repo = JSON.parse(fs.readFileSync(file(p), "utf8"));
  if (repo.password !== password) fatal(12, "wrong password or no key found");
  return repo;
}

if (cmd === "version") {
  console.log("restic 0.18.0 (fake)");
  process.exit(0);
}
if (!repoPath) fatal(1, "Please specify repository location (-r or --repository-file)");

// opening errors come first, like in real restic
if (cmd === "init") {
  if (unreachable.includes(repoPath)) fatal(1, `create repository at ${repoPath} failed: dial tcp: no route to host`);
  if (fs.existsSync(file(repoPath))) fatal(1, `create repository at ${repoPath} failed: config file already exists`);
} else {
  open(repoPath, env.RESTIC_PASSWORD);
}
if (cmd === "copy") open(fromPath, env.RESTIC_FROM_PASSWORD);

const forced = env[`FAKE_RESTIC_EXIT_${String(cmd).toUpperCase()}`];
if (forced !== undefined && cmd !== "backup") fatal(Number(forced), `fake failure in ${cmd}`);

if (env.FAKE_RESTIC_HANG === cmd) {
  process.on("SIGTERM", () => {
    fs.writeFileSync(path.join(state, "sigterm"), "");
    if (env.FAKE_RESTIC_IGNORE_TERM !== "1") {
      process.stderr.write("signal terminated received, cleaning up\n");
      process.exit(130);
    }
  });
  console.log("working...");
  setInterval(() => {}, 1000);
} else {
  run();
}

function run() {
  switch (cmd) {
    case "cat": {
      const repo = open(repoPath, env.RESTIC_PASSWORD);
      console.log(JSON.stringify({ version: 2, id: repo.id, chunker_polynomial: repo.chunker_polynomial }, null, 2));
      return;
    }
    case "init": {
      let polynomial = crypto.randomBytes(7).toString("hex");
      if (args.includes("--copy-chunker-params")) {
        if (!fromPath) fatal(1, "Please specify the source repository location (--from-repo or --from-repository-file)");
        polynomial = open(fromPath, env.RESTIC_FROM_PASSWORD).chunker_polynomial;
      }
      const id = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(file(repoPath), JSON.stringify({ id, chunker_polynomial: polynomial, password: env.RESTIC_PASSWORD }));
      console.log(`created restic repository ${id.slice(0, 10)} at ${repoPath}`);
      return;
    }
    case "backup": {
      console.log(JSON.stringify({ message_type: "status", percent_done: 0.5 }));
      if (forced === "3") {
        process.stderr.write(
          JSON.stringify({ message_type: "error", error: { message: "permission denied" }, during: "archival", item: "/secret" }) + "\n",
        );
      }
      console.log(
        JSON.stringify({
          message_type: "summary",
          files_new: 2,
          files_changed: 1,
          files_unmodified: 10,
          data_added: 2048,
          snapshot_id: crypto.randomBytes(32).toString("hex"),
        }),
      );
      if (forced !== undefined) {
        const message = forced === "3" ? "Warning: at least one source file could not be read" : "Fatal: fake failure in backup";
        process.stderr.write(JSON.stringify({ message_type: "exit_error", code: Number(forced), message }) + "\n");
        process.exit(Number(forced));
      }
      return;
    }
    case "forget":
      console.log("Applying Policy: keep 7 daily snapshots");
      return;
    case "prune":
      console.log("done");
      return;
    case "check":
      console.log("no errors were found");
      return;
    case "copy":
      console.log("snapshot 1234abcd saved");
      return;
    default:
      fatal(1, `unknown command "${cmd}"`);
  }
}
