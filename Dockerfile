# Build the @brikell/report-worker service from the monorepo root.
#
# The worker imports `@brikell/shared` as a workspace package, so we must
# install pnpm at repo root, copy the relevant workspace packages, and run
# the worker entry point via pnpm filter.
#
# Build context (Railway): set this service's "Root Directory" to the repo
# root and `dockerfilePath` to `brikell-report-worker/Dockerfile`.

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

# Copy workspace manifest + lockfile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy only the packages this service needs to install.
COPY brikell-shared/package.json ./brikell-shared/
COPY brikell-report-worker/package.json ./brikell-report-worker/

RUN pnpm install \
    --frozen-lockfile \
    --filter "@brikell/shared..." \
    --filter "@brikell/report-worker..."

# Copy source AFTER install so dependency cache survives source changes.
COPY brikell-shared ./brikell-shared
COPY brikell-report-worker ./brikell-report-worker

# Pre-build the shared TypeScript package so tsx can resolve compiled types.
RUN pnpm --filter "@brikell/shared" run prepare || pnpm --filter "@brikell/shared" run build || true

CMD ["pnpm", "--filter", "@brikell/report-worker", "start"]
