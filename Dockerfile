# rescade: the daemon (entrypoint), the CLI, the web UI and restic in one image.

# the build gives plain JS (no native modules), so it runs on the build machine's platform, not emulated
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
# Node 26 no longer bundles corepack; it installs the pnpm from packageManager
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /src
# manifests first: the install layer is reused while only sources change
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/daemon/package.json packages/daemon/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.base.json ./
COPY packages packages
COPY scripts scripts
# the version comes from CI (the next git tag); local builds stay 0.0.0-dev
ARG VERSION
RUN if [ -n "$VERSION" ]; then node scripts/version.mjs set "$VERSION"; fi \
 && pnpm build \
 && pnpm --filter @rescade/daemon deploy --prod /out/daemon \
 && pnpm --filter @rescade/cli deploy --prod /out/cli

# restic from its release, checked against the published sums (distribution packages can be older than 0.17)
FROM --platform=$BUILDPLATFORM alpine:3.22 AS restic
ARG RESTIC_VERSION=0.19.1
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) sum=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c ;; \
      arm64) sum=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465 ;; \
      *) echo "no restic checksum for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && wget -qO /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2" \
 && echo "$sum  /tmp/restic.bz2" | sha256sum -c - \
 && bunzip2 /tmp/restic.bz2 \
 && install -m 755 /tmp/restic /usr/local/bin/restic

FROM node:26-alpine
# tini reaps orphaned grandchildren of steps; openssh-client for sftp; tzdata for cascade time zones
RUN apk add --no-cache tini openssh-client ca-certificates tzdata
COPY --from=restic /usr/local/bin/restic /usr/local/bin/restic
COPY --from=build /out/daemon /opt/rescade/daemon
COPY --from=build /out/cli /opt/rescade/cli
# tsc does not set the exec bit on dist/*.js, so both get a wrapper
RUN printf '#!/bin/sh\nexec node /opt/rescade/daemon/dist/index.js "$@"\n' \
      > /usr/local/bin/rescaded \
 && printf '#!/bin/sh\nexec node /opt/rescade/cli/dist/index.js "$@"\n' > /usr/local/bin/rescade \
 && chmod +x /usr/local/bin/rescaded /usr/local/bin/rescade \
 && mkdir -p /etc/rescade/config /var/lib/rescade
# restic runs ssh without a terminal, so nobody can confirm an unknown host key: the first one is remembered
# (a changed key still fails), in the data volume so that recreating the container does not forget it;
# a ~/.ssh/config of its own takes precedence
RUN printf '%s\n' 'Host *' '    StrictHostKeyChecking accept-new' \
      '    UserKnownHostsFile /var/lib/rescade/known_hosts ~/.ssh/known_hosts' > /etc/ssh/ssh_config.d/rescade.conf

ENV RESCADE_ADDR=0.0.0.0:8765 \
    RESCADE_URL=http://127.0.0.1:8765 \
    RESCADE_CONFIG_DIR=/etc/rescade/config \
    RESCADE_DATA_DIR=/var/lib/rescade \
    RESCADE_TOKEN_FILE=/run/secrets/rescade_token \
    RESTIC_CACHE_DIR=/var/lib/rescade/cache
VOLUME /var/lib/rescade
EXPOSE 8765
# the warm-up checks every repo before the API listens; an unreachable one can take RESCADE_REPO_CHECK_TIMEOUT
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m \
  CMD wget -qO /dev/null http://127.0.0.1:8765/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--", "rescaded"]
