# rescade

Cascades of restic commands on a schedule, described in YAML. The daemon `rescaded` runs them by
schedule, keeps the history in SQLite and serves an HTTP API; the `rescade` command talks to it, and
can also validate a config or run a cascade on its own. A web interface comes later.

Requires Node >= 22.13 (for the built-in `node:sqlite`) and restic >= 0.17.

## Try it

    pnpm install
    pnpm test                # unit tests, with a fake restic
    pnpm test:integration    # with real restic ($RESCADE_RESTIC or from PATH), ~30 s
    pnpm validate:example    # validates examples/config, unset ${VAR} as warnings
    pnpm build && node packages/cli/dist/index.js run --local <cascade> --config-dir <dir>

`run --local` runs one cascade in the foreground, without the daemon. The first Ctrl+C stops the
current step (SIGTERM, then SIGKILL), the second exits at once.

## The daemon

    (umask 077; openssl rand -hex 32 > /etc/rescade/token)
    rescaded --config-dir /etc/rescade/config      # API on 127.0.0.1:8765, history in /var/lib/rescade

At start it checks every repo (initializing missing ones) and refuses to start on config errors or on
a reachable repo it cannot use (wrong password, failed init); unreachable repos only show in the state.
SIGHUP rereads the config (a broken one is reported and the old one kept), SIGTERM stops: runs in
progress end as `interrupted`. Logs are JSON lines on stdout.

Settings come from flags or the environment, never from the YAML: `--addr` / `RESCADE_ADDR`,
`--config-dir` / `RESCADE_CONFIG_DIR`, `--data-dir` / `RESCADE_DATA_DIR`, `--restic` / `RESCADE_RESTIC`,
`--token-file` / `RESCADE_TOKEN_FILE` (or the token itself in `RESCADE_TOKEN`), `--log-level` /
`RESCADE_LOG_LEVEL`, `RESCADE_REPO_CHECK_TIMEOUT` (default `2m`), `RESCADE_ALLOWED_HOSTS` (Host header
values to accept when listening on a public address), `RESCADE_CORS_ORIGINS`. See `rescaded --help`.

The API lives under `/api` and needs `Authorization: Bearer <token>` on every request:
`GET /api/status`, `GET /api/cascades`, `GET /api/runs?cascade=&limit=&before=`, `GET /api/runs/:id`,
`GET /api/runs/:id/log?step=&after=`, `POST /api/cascades/:name/run`, `POST /api/runs/:id/cancel`,
`GET /api/repos`, `GET /api/events?run=|cascade=` (server-sent events). The OpenAPI document is at
`/api/openapi.json` and Swagger UI at `/api/docs`, both without the token.

## The web interface

The daemon serves it on its own address (`http://127.0.0.1:8765/` by default) when `packages/web` is built
(`pnpm build`). It asks for the API token once per tab ("Remember" keeps it in the browser) and shows
cascades, runs with live logs, repos and their locks, and a warning when a config reload failed.
To work on it, `pnpm --filter @rescade/web dev` serves it with Vite and proxies `/api` to `$RESCADE_URL`.

## The client

    rescade run <cascade> [--detach]    # start and follow; Ctrl+C cancels the run
    rescade status                      # the daemon, its config, cascades with their last and next runs
    rescade runs [--cascade <name>] [--limit <n>]
    rescade show <run>
    rescade log <run> [--step <n>]
    rescade cancel <run>
    rescade repos

All of them take `--json`, `--url` (default `$RESCADE_URL`, then `http://127.0.0.1:8765`) and
`--token-file` (default `$RESCADE_TOKEN`, `$RESCADE_TOKEN_FILE`, then `~/.config/rescade/token`).

Exit codes:

- `validate`: 0 valid, 1 errors in the config, 2 bad usage.
- `run`: 0 success, 3 warning, 1 failed, interrupted or config errors, 130 cancelled,
  75 skipped (repos busy or the cascade already running), 2 bad usage.
- the others: 0 done, 1 error from the daemon or no connection, 2 bad usage.

## Config

A directory of `*.yaml` / `*.yml` files (or a single file), set with `--config-dir` or
`RESCADE_CONFIG_DIR`. Each file is parsed on its own and the entries of `repos`, `sets` and `cascades`
are merged by name. The same name in two files is an error, and so is an unknown key.

- `${VAR}` and `${VAR:-default}` are expanded in values (not keys); `$$` is a literal `$`.
  Unset variables are errors. Inside `{}` or `[]` the reference must be quoted: `{ password: "${PW}" }`.
- Glob patterns that start with `*` must be quoted: `"**/node_modules"`.
- Steps: `backup`, `retain`, `prune`, `check`, `copy`, `run`. `retain` applies the repo's `retention`.
- `from:` on a repo says which repo it is created from (`restic init --from-repo --copy-chunker-params`).
- Any restic backend works (local, sftp, rest, s3, swift, b2, azure, gs, rclone): credentials go into the
  repo's `env` (taken from the daemon's environment with `${VAR}`), backend options into `options`
  (`-o key=value`). Details and caveats, in Russian: `docs/backends.md`.
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
    packages/daemon the `rescaded` daemon: HTTP API (Fastify), signals, startup checks
    packages/cli    the `rescade` command
    examples/config a complete example config
