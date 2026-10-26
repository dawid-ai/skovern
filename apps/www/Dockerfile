# syntax=docker/dockerfile:1.7
# The www service (skovern.com). Build from the REPO ROOT:
#   docker build -f apps/www/Dockerfile -t skovern-www .
# Stage 1 builds the static site; stage 2 serves it with Caddy on $PORT (8080).

FROM node:24-bookworm-slim AS build
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/www/package.json apps/www/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @skovern/www
COPY apps/www apps/www
# The api the waitlist form posts to. Baked into the static pages at build time.
ARG PUBLIC_API_URL=https://api.skovern.com
ENV PUBLIC_API_URL=$PUBLIC_API_URL
RUN pnpm --filter @skovern/www build

FROM caddy:2.10.2-alpine
ARG PUBLIC_API_URL=https://api.skovern.com
ENV PORT=8080 API_ORIGIN=$PUBLIC_API_URL XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
RUN adduser -D -H -u 10001 web
COPY apps/www/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/www/dist /srv
USER web
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
