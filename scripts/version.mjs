#!/usr/bin/env node
// The version of rescade lives in git tags (vX.Y.Z), not in the repo: package.json files hold 0.0.0-dev.
//   node scripts/version.mjs next      prints the version for HEAD: the latest tag bumped by the commits since it
//   node scripts/version.mjs set <v>   writes <v> into the root and every packages/*/package.json (for a build)
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The next version after `last` (X.Y.Z, or undefined before the first release) for the given commit messages,
 * by conventional commits: a breaking change bumps the major (the minor before 1.0), feat the minor, the rest the patch.
 */
export function nextVersion(last, messages) {
  if (last === undefined) return "0.1.0";
  const m = SEMVER.exec(last);
  if (!m) throw new Error(`not a version: ${last}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  const breaking = messages.some((msg) => /^\w+(\([^)]*\))?!:/.test(msg) || /^BREAKING[ -]CHANGE:/m.test(msg));
  const feat = messages.some((msg) => /^feat(\([^)]*\))?!?:/.test(msg));
  if (breaking && major > 0) return `${major + 1}.0.0`;
  if (breaking || feat) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function next() {
  const last = git("tag", "--list", "v*", "--sort=-v:refname")
    .split("\n")
    .map((t) => t.slice(1))
    .find((v) => SEMVER.test(v));
  // \x1e separates whole messages, which span lines
  const log = git("log", "--format=%B%x1e", ...(last === undefined ? [] : [`v${last}..HEAD`]));
  const messages = log.split("\x1e").map((s) => s.trim()).filter((s) => s !== "");
  return nextVersion(last, messages);
}

function set(version) {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`);
  const root = path.join(import.meta.dirname, "..");
  const files = ["package.json", ...readdirSync(path.join(root, "packages")).map((p) => `packages/${p}/package.json`)];
  for (const file of files) {
    const full = path.join(root, file);
    const pkg = JSON.parse(readFileSync(full, "utf8"));
    pkg.version = version;
    writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2);
  if (command === "next") console.log(next());
  else if (command === "set" && arg !== undefined) set(arg);
  else {
    console.error("usage: version.mjs next | set <X.Y.Z>");
    process.exit(2);
  }
}
