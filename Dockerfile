# Build the @brikell/report-worker service.
#
# brikell-shared is a pnpm workspace package and a git submodule of this repo.
# Railway snapshots do not always materialize the submodule into the build
# context, so we clone brikell-shared in-image at the SHA recorded in the
# parent repo's submodule pin. Keep BRIKELL_SHARED_REF in sync with whatever
# `git ls-tree HEAD brikell-shared` reports in this repo.

FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

ARG BRIKELL_SHARED_REPO=https://github.com/weilueluo/brikell-shared.git
ARG BRIKELL_SHARED_REF=ab93cfac188a7c2f283e434536804f0799a12345

RUN git clone "$BRIKELL_SHARED_REPO" brikell-shared \
    && git -C brikell-shared checkout "$BRIKELL_SHARED_REF" \
    && rm -rf brikell-shared/.git

# Copy workspace manifest + lockfile + root package.json first for cache.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Skip lifecycle scripts: brikell-shared's `prepare` runs `tsc`, but its
# sources aren't installed where pnpm expects them yet.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy the rest of the worker's sources. `brikell-shared` is excluded from the
# build context via .dockerignore so this step does not clobber the clone.
COPY . .

# Build the shared package's dist so consumers resolve compiled JS at runtime.
RUN pnpm --filter "@brikell/shared" run build

ENV NODE_ENV=production

CMD ["pnpm", "start"]
