# rescade

Cascades of restic commands on a schedule, described in YAML. Done so far: the config loader,
`rescade validate`, the executor with `rescade run --local`, and the core of the future daemon
(repo mutexes, `on-busy`, scheduler, run history in SQLite). The daemon, its API and the CLI client come next.

Requires Node >= 22.13 (for the built-in `node:sqlite`) and restic >= 0.17.

## Try it

    pnpm install
    pnpm test                # unit tests, with a fake restic
    pnpm test:integration    # with real restic ($RESCADE_RESTIC or from PATH), ~30 s
    pnpm validate:example    # validates examples/config, unset ${VAR} as warnings
    pnpm build && node packages/cli/dist/index.js run --local <cascade> --config-dir <dir>

`run --local` runs one cascade in the foreground, without the daemon. The first Ctrl+C stops the
current step (SIGTERM, then SIGKILL), the second exits at once.

Exit codes:

- `validate`: 0 valid, 1 errors in the config, 2 bad usage.
- `run`: 0 success, 3 warning, 1 failed or config errors, 130 cancelled, 75 skipped (repos busy; only under the daemon), 2 bad usage.

Environment: `RESCADE_CONFIG_DIR` (default `./config`), `RESCADE_RESTIC` (default `restic`),
`RESCADE_REPO_CHECK_TIMEOUT` (how long a repo may take to answer before a step, default `2m`).

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
  The command gets only the step's `env`, not the daemon's environment.
- `schedule` is a cron expression or a list of them (optionally with `timezone`); without it the cascade
  only runs on demand. Missed times are not caught up.

See `examples/config` for a complete example.

## How runs behave

- Before each step its repos are checked with `restic cat config`; a repo that does not exist is
  initialized. An unreachable repo is never initialized.
- A step that fails stops the cascade; the rest are skipped. `backup` exit code 3 (some files
  unreadable) is a warning and the cascade goes on.
- Each step holds a mutex on the repos it touches (both for `copy`, `lock:` for `run`), so cascades on
  different repos run in parallel. When a step finds a repo busy, `on-busy: skip` (the default) skips
  the rest of the run, and `on-busy: wait` waits, for up to `wait-timeout` if one is set.
- A cascade never runs twice at once: a run triggered while the previous one is in progress is
  recorded as skipped.

The design and all decisions are in `docs/DESIGN.md`; `CLAUDE.md` carries the context for Claude Code.

## Layout

    packages/core   config loader, restic adapter, executor, repo mutexes, runner, scheduler, SQLite store
    packages/cli    the `rescade` command
    examples/config a complete example config
