# syntax=docker/dockerfile:1.7
# The api service (api.skovern.com). Build from the REPO ROOT so pnpm sees the
# workspace lockfile:  docker build -f apps/site/Dockerfile -t skovern-api .
# Only the root manifests and apps/site are copied in, so desktop code, local
# node_modules, and .env files never enter the build context's layers.

FROM node:24-bookworm-slim AS build
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/site/package.json apps/site/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @skovern/site
COPY apps/site apps/site
# A self-contained copy with real (not symlinked) prod dependencies. Native
# modules (@resvg/resvg-js, esbuild for tsx) resolve to their linux-x64-gnu
# builds here, matching the runtime image below.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @skovern/site deploy --prod /app \
 && find /app/src -name "*.test.ts" -delete \
 && rm -rf /app/scripts /app/docker-compose.yml /app/Dockerfile* /app/vitest.config.ts

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
# Railway's health check hits /healthz; this one covers plain `docker run`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM directly, so the drain runs.
CMD ["node", "--import", "tsx", "src/server/main.ts"]
