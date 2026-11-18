#!/usr/bin/env node
// A stand-in for restic in tests. It keeps repos as JSON files and logs every call.
//
// State in $FAKE_RESTIC_STATE:
//   repos/<encoded path>.json   { id, chunker_polynomial, password }
//   locks/<encoded path>.json   [{ id, time, exclusive, hostname, username, pid }], lock files left in the repo
//   snapshots/<encoded path>.json  { snapshots: [as restic snapshots --json], nodes: { <snapshot id>: [ls nodes] } };
//                                backup adds a snapshot without nodes; restore writes the file nodes it
//                                restores into --target as files holding their path
//   calls.jsonl                 one line per call: { cmd, args, options, repo, from, ... }
//   sigterm                     created when a hanging call receives SIGTERM
//
// Switches (environment):
//   FAKE_RESTIC_EXIT_<CMD>=n     fail <CMD> (BACKUP, INIT, CAT, COPY, CHECK, FORGET, PRUNE, LIST, SNAPSHOTS, LS, RESTORE)
//                                with exit code n;
//                                backup still prints its summary, as real restic does for code 3
//   FAKE_RESTIC_UNREACHABLE=a,b  repository paths that fail like an unreachable host (exit 1)
//   FAKE_RESTIC_HOSTKEY=a,b      repository paths that fail like sftp to a host missing from known_hosts (exit 1)
//   FAKE_RESTIC_HANG=<cmd>       hang in <cmd> until signalled; SIGTERM exits with 130
//   FAKE_RESTIC_IGNORE_TERM=1    ignore SIGTERM while hanging (only SIGKILL helps)
//   FAKE_RESTIC_VERSION=x.y.z    version `restic version` reports (default 0.18.0)
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

// not logged: rescaded and run --local ask for the version before anything else
if (cmd === "version") {
  console.log(`restic ${env.FAKE_RESTIC_VERSION ?? "0.18.0"} compiled with go1.24.0 on linux/amd64 (fake)`);
  process.exit(0);
}

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
const unknownHostKey = (env.FAKE_RESTIC_HOSTKEY ?? "").split(",").filter(Boolean);

function open(p, password) {
  if (unreachable.includes(p)) fatal(1, `unable to open repository at ${p}: dial tcp: connect: no route to host`);
  if (unknownHostKey.includes(p)) {
    process.stderr.write("subprocess ssh: Host key verification failed.\n");
    fatal(1, `unable to open repository at ${p}: unable to start the sftp session, error: error receiving version packet from server: server unexpectedly closed connection: unexpected EOF`);
  }
  if (!fs.existsSync(file(p))) {
    fatal(10, `repository does not exist: unable to open config file: stat ${p}/config: no such file or directory`);
  }
  const repo = JSON.parse(fs.readFileSync(file(p), "utf8"));
  if (repo.password !== password) fatal(12, "wrong password or no key found");
  return repo;
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

function locks() {
  const f = path.join(state, "locks", encodeURIComponent(repoPath) + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
}

function snapshotsFile() {
  return path.join(state, "snapshots", encodeURIComponent(repoPath) + ".json");
}

function readSnapshots() {
  const f = snapshotsFile();
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { snapshots: [], nodes: {} };
}

function run() {
  switch (cmd) {
    case "snapshots":
      console.log(JSON.stringify(readSnapshots().snapshots));
      return;
    case "ls": {
      const [id, dir] = args.slice(args.indexOf("--") + 1);
      const data = readSnapshots();
      const snap = data.snapshots.find((s) => s.id.startsWith(id)) ?? fatal(1, `no matching ID found for prefix "${id}"`);
      console.log(JSON.stringify({ ...snap, message_type: "snapshot", struct_type: "snapshot" }));
      for (const node of data.nodes[snap.id] ?? []) {
        if (node.path === dir || path.posix.dirname(node.path) === dir) {
          console.log(JSON.stringify({ ...node, message_type: "node", struct_type: "node" }));
        }
      }
      return;
    }
    case "restore": {
      const target = args[args.indexOf("--target") + 1];
      const [id] = args.slice(args.indexOf("--") + 1);
      // --include patterns of literal paths: drop the escapes
      const includes = args.flatMap((a, i) => (args[i - 1] === "--include" ? [a.replace(/\\(.)/g, "$1")] : []));
      const data = readSnapshots();
      const snap = data.snapshots.find((s) => s.id.startsWith(id)) ?? fatal(1, `failed to find snapshot: no matching ID found for prefix "${id}"`);
      const wanted = (data.nodes[snap.id] ?? []).filter(
        (n) => includes.length === 0 || includes.some((p) => n.path === p || n.path.startsWith(`${p}/`)),
      );
      console.log(JSON.stringify({ message_type: "status", percent_done: 0.5 }));
      let bytes = 0;
      for (const n of wanted) {
        const to = path.join(target, n.path);
        if (n.type === "dir") {
          fs.mkdirSync(to, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.writeFileSync(to, n.path);
          bytes += n.path.length;
        }
      }
      console.log(JSON.stringify({ message_type: "summary", total_files: wanted.length, files_restored: wanted.length, bytes_restored: bytes }));
      return;
    }
    case "list": {
      for (const lock of locks()) console.log(lock.id);
      return;
    }
    case "cat": {
      if (args[0] === "lock") {
        const id = args.find((a) => /^[0-9a-f]{64}$/.test(a));
        const { id: _, ...lock } = locks().find((l) => l.id === id) ?? fatal(1, `no lock ${id}`);
        console.log(JSON.stringify(lock, null, 2));
        return;
      }
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
      const snapshotId = crypto.randomBytes(32).toString("hex");
      console.log(
        JSON.stringify({
          message_type: "summary",
          files_new: 2,
          files_changed: 1,
          files_unmodified: 10,
          data_added: 2048,
          snapshot_id: snapshotId,
        }),
      );
      const data = readSnapshots();
      data.snapshots.push({
        time: new Date().toISOString(),
        paths: args.slice(args.indexOf("--") + 1),
        hostname: "fake",
        username: "root",
        tags: args.flatMap((a, i) => (args[i - 1] === "--tag" ? [a] : [])),
        summary: { data_added: 2048, total_files_processed: 13, total_bytes_processed: 4096 },
        id: snapshotId,
        short_id: snapshotId.slice(0, 8),
      });
      fs.mkdirSync(path.dirname(snapshotsFile()), { recursive: true });
      fs.writeFileSync(snapshotsFile(), JSON.stringify(data));
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
