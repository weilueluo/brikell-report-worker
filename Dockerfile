# Build the @brikell/report-worker service.
#
# The worker repo (github.com/weilueluo/brikell-report-worker) is itself the
# build context. brikell-shared/ is a git submodule and a workspace package
# declared in pnpm-workspace.yaml.
#
# Railway: ensure submodules are checked out before build (set
# RAILWAY_GIT_SUBMODULES=true on the service, or configure submodule support
# in the service's source settings).

FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable

# Copy workspace manifest + lockfile + root package.json first for cache.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy the submodule's package.json so pnpm can resolve workspace links.
COPY brikell-shared/package.json ./brikell-shared/

# Install full deps (incl. dev) so we can run tsc; skip lifecycle scripts
# because the brikell-shared `prepare` needs source that hasn't been copied yet.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy the rest of the sources (worker + submodule contents).
COPY . .

# Build the shared package's dist so the worker imports compiled JS at runtime.
RUN pnpm --filter "@brikell/shared" run build

ENV NODE_ENV=production

CMD ["pnpm", "start"]
