# rescade

Cascades of restic commands on a schedule, described in YAML. The daemon `rescaded` runs them by
schedule, keeps the history in SQLite and serves an HTTP API; the `rescade` command talks to it, and
can also validate a config or run a cascade on its own. A web interface comes later.

Requires Node >= 26 (the current LTS, for the built-in `node:sqlite`) and restic >= 0.17 (`rescaded` and `rescade run --local`
warn about an older one: it does not report a missing repo or a wrong password with their own exit codes).

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
`--restore-dir` / `RESCADE_RESTORE_DIR` (the directory to restore into, created if missing; unset = restore is off), `--token-file` / `RESCADE_TOKEN_FILE` (or the token itself in `RESCADE_TOKEN`), `--log-level` /
`RESCADE_LOG_LEVEL`, `RESCADE_REPO_CHECK_TIMEOUT` (default `2m`), `RESCADE_ALLOWED_HOSTS` (Host header
values to accept: `host:port` on that port, `host` on any; unset = any host), `RESCADE_CORS_ORIGINS`. See `rescaded --help`.

The API lives under `/api` and needs `Authorization: Bearer <token>` on every request:
`GET /api/status`, `GET /api/cascades`, `GET /api/runs?cascade=&limit=&before=`, `GET /api/runs/:id`,
`GET /api/runs/:id/log?step=&after=`, `POST /api/cascades/:name/run`, `POST /api/runs/:id/cancel`,
`GET /api/repos`, `GET /api/repos/:name/snapshots`, `GET /api/repos/:name/snapshots/:id/ls?path=`,
`POST /api/repos/:name/snapshots/:id/restore` (body `{ "paths": [...] }`, optional), `GET /api/summary` (flat counts for dashboards), `GET /api/events?run=|cascade=` (server-sent events). The OpenAPI document is at
`/api/openapi.json`, Swagger UI at `/api/docs` and the health check at `/api/health`, all without the token.

## Homepage widget

[homepage](https://gethomepage.dev) shows rescade through its `customapi` widget. `GET /api/summary` gives flat
fields made for it: `cascades`, `running`, `queued`, `success`, `warning`, `failed` (cascades by their latest
finished run; `failed` includes `interrupted`), `lastRunAt`, `nextRunAt` (epoch ms, `null` when there is none),
`repos` and `repoProblems` (repos whose last check failed). A block shows up to four of them:

```yaml
# services.yaml
- Backups:
    - rescade:
        href: http://backup.lan:8765/
        description: restic cascades
        widget:
          type: customapi
          url: http://rescade:8765/api/summary
          refreshInterval: 60000
          headers:
            Authorization: Bearer {{HOMEPAGE_VAR_RESCADE_TOKEN}}
          mappings:
            - field: running
              label: Running
            - field: failed
              label: Failed
            - field: repoProblems
              label: Repo problems
            - field: nextRunAt
              label: Next
              format: relativeDate
              style: short
              numeric: auto
```

The latest outcome of each cascade fits a `dynamic-list` over `GET /api/cascades`:

```yaml
        widget:
          type: customapi
          url: http://rescade:8765/api/cascades
          headers:
            Authorization: Bearer {{HOMEPAGE_VAR_RESCADE_TOKEN}}
          display: dynamic-list
          mappings:
            name: name
            label: lastRun.status
            target: http://backup.lan:8765/runs?cascade={name}
```

Give homepage the token as `HOMEPAGE_VAR_RESCADE_TOKEN`, or as a file through `HOMEPAGE_FILE_RESCADE_TOKEN` (then
`{{HOMEPAGE_FILE_RESCADE_TOKEN}}` in the YAML) to reuse the Docker secret. homepage queries the daemon from its own
server, so the daemon must be reachable from there (a shared Docker network, not just the port on `127.0.0.1`), and
with `RESCADE_ALLOWED_HOSTS` set, the name in `url` (`rescade` above) must be in it.

## The web interface

The daemon serves it on its own address (`http://127.0.0.1:8765/` by default) when `packages/web` is built
(`pnpm build`). It asks for the API token once per tab ("Remember" keeps it in the browser) and shows
cascades, runs with live logs, repos and their locks, and a warning when a config reload failed.
To work on it, `pnpm --filter @rescade/web dev` serves it with Vite and proxies `/api` to `$RESCADE_URL`.

## Docker

`ghcr.io/artss/rescade` (`linux/amd64`, `linux/arm64`) holds the daemon, the CLI, the web UI and restic. A complete
example is in `examples/docker`: the API token as a Docker secret, repo passwords in an env file, the config
mounted read-only, history and restic's cache in a volume.

- Set `hostname:` for the container. restic records it in each snapshot and finds the parent snapshot by host and
  paths; without it every recreated container is a new host and each backup reads all files again.
  Do not use `RESTIC_HOST` for this: restic also takes it as the default `--host` filter of `forget`, `copy` and `check`.
- Mount the backup sources read-only at paths that do not collide with the image's own (`/etc`, `/usr`,
  `/var/lib/rescade`, ...) and do not change later. A `/host` prefix is a safe choice (`/home:/host/home:ro`, then
  `/host/home` in `sets`). `rescade restore` keeps the prefix: files land in
  `<restore dir>/<short id>/host/home/...`; to put them back in place, `restic restore <id>:/host/home --target /home`.
- For `rescade restore`, mount a writable directory and point `RESCADE_RESTORE_DIR` at it.
- The daemon runs as root so that restic can read any source file.
- Docker Desktop on macOS cannot back up bind-mounted host directories: restic sets `O_NOATIME` on each file it
  reads, and Docker Desktop's file sharing then fails every read with `input/output error`. Named volumes work
  there; on Linux hosts bind mounts are plain mounts and are not affected.
- `docker compose kill -s HUP rescade` rereads the config, `docker compose exec rescade rescade status` uses the CLI.
- `GET /api/health` answers without the token for the image's health check.

## The client

    rescade run <cascade> [--detach]    # start and follow; Ctrl+C cancels the run
    rescade status                      # the daemon, its config, cascades with their last and next runs
    rescade runs [--cascade <name>] [--limit <n>]
    rescade show <run>
    rescade log <run> [--step <n>]
    rescade cancel <run>
    rescade rerun <run> [--detach]      # start the cascade of a failed run again from its failed step
    rescade repos
    rescade snapshots <repo>
    rescade ls <repo> <snapshot> [path]
    rescade restore <repo> <snapshot> [path...] [--detach]   # into <restore dir>/<short id>/<full path>

All of them take `--json`, `--url` (default `$RESCADE_URL`, then `http://127.0.0.1:8765`) and
`--token-file` (default `$RESCADE_TOKEN`, `$RESCADE_TOKEN_FILE`, then `~/.config/rescade/token`).

Exit codes:

- `validate`: 0 valid, 1 errors in the config, 2 bad usage.
- `run`: 0 success, 3 warning, 1 failed, interrupted or config errors, 130 cancelled,
  75 skipped (repos busy or the cascade already running), 2 bad usage.
- `restore`: 0 success, 1 failed or interrupted, 130 cancelled, 2 bad usage.
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
- `group` on a repo or a cascade puts it under a collapsible heading in the web interface; entries
  without it are listed on their own.
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
