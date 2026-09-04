# Aurora control plane image (Task 8).
#
# Builds the commercial control plane into a self-contained node_modules via
# `pnpm deploy` and runs the compiled `dist/start.js` entry, which loads
# AURORA_* configuration from the environment, applies pending SQL migrations
# from AURORA_MIGRATIONS_DIR at boot, and starts the gateway.
#
# The control plane's only workspace dependency is @open-design/aurora-contracts;
# the build stage installs with just that manifest present, so the lockfile
# workspace is resolved without copying the whole repository.

ARG NODE_IMAGE=docker.io/library/node:24-alpine

FROM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY packages/aurora-contracts/package.json ./packages/aurora-contracts/package.json
COPY apps/aurora-control-plane/package.json ./apps/aurora-control-plane/package.json
RUN corepack enable && \
    corepack prepare pnpm@10.33.2 --activate && \
    pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps/aurora-control-plane ./apps/aurora-control-plane
RUN pnpm --filter @open-design/aurora-control-plane build && \
    pnpm --filter @open-design/aurora-control-plane deploy --legacy --prod /app/deploy/control-plane && \
    pnpm store prune

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/deploy/control-plane ./
# tsc does not emit .sql; the boot entry applies these pending migrations.
COPY --from=build /app/apps/aurora-control-plane/src/migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/start.js"]
