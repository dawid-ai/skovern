# syntax=docker/dockerfile:1.7
# The www service (skovern.com). Build from the REPO ROOT:
#   docker build -f apps/www/Dockerfile -t skovern-www .
# Stage 1 builds the static site; stage 2 serves it with Caddy on $PORT (8080).

# Base images are pinned by digest (tag kept for reading); bump both together.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH ASTRO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/www/package.json apps/www/package.json
RUN pnpm install --frozen-lockfile --filter @skovern/www
COPY apps/www apps/www
# The api the waitlist form posts to. Baked into the static pages at build time.
ARG PUBLIC_API_URL=https://api.skovern.com
ENV PUBLIC_API_URL=$PUBLIC_API_URL
RUN pnpm --filter @skovern/www build

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
ARG PUBLIC_API_URL=https://api.skovern.com
ENV PORT=8080 API_ORIGIN=$PUBLIC_API_URL XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
RUN adduser -D -H -u 10001 web
COPY apps/www/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/www/dist /srv
USER web
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
