# rescade

Cascades of restic commands on a schedule, described in YAML. This is the first slice: the
config loader and `rescade validate`. The daemon, API and executor come next.

## Try it

    pnpm install
    pnpm test
    pnpm validate:example    # validates examples/config, unset ${VAR} as warnings
    pnpm build && node packages/cli/dist/index.js validate --config-dir examples/config

Exit codes of `validate`: 0 valid, 1 errors in the config, 2 bad usage.

## Config

A directory of `*.yaml` / `*.yml` files (or a single file), set with `--config-dir` or
`RESCADE_CONFIG_DIR`. Each file is parsed on its own and the entries of `repos`, `sets` and `cascades`
are merged by name. The same name in two files is an error, and so is an unknown key.

- `${VAR}` and `${VAR:-default}` are expanded in values (not keys); `$$` is a literal `$`.
  Unset variables are errors. Inside `{}` or `[]` the reference must be quoted: `{ password: "${PW}" }`.
- Glob patterns that start with `*` must be quoted: `"**/node_modules"`.
- Steps: `backup`, `retain`, `prune`, `check`, `copy`, `run`. `retain` applies the repo's `retention`.
- `from:` on a repo says which repo it is created from (`restic init --from-repo --copy-chunker-params`).
- `run` takes `command` as a list of arguments; `shell: true` takes a string. Default timeout 1h.

See `examples/config` for a complete example. The design and all decisions are in `docs/DESIGN.md`; `CLAUDE.md` carries the context for Claude Code.

## Layout

    packages/core   config loader and schema (no I/O besides reading files)
    packages/cli    the `rescade` command
