# syntax=docker/dockerfile:1
# node:20-bookworm-slim (glibc), not node:20-alpine (musl): tree-sitter,
# tree-sitter-typescript, and tree-sitter-python ship prebuilt native
# bindings only for glibc linux-x64, with no musl variant,
# and alpine's base image has no python3/make/g++ for a node-gyp
# source-compile fallback either — npm ci would fail installing them on
# alpine.
#
# Pinned to a digest (Deferred User Verification item 3, resolved
# 2026-09-11): the tag `node:20-bookworm-slim` is floating, but resolving
# it to a digest only needs the Docker Registry API (registry-1.docker.io
# + auth.docker.io for an anonymous pull token) — reachable even in
# environments whose network policy blocks Docker Hub's CDN (which serves
# the actual image layer blobs, needed for a real `docker pull`/`docker
# build`, and was blocked here). Verified via `curl` against the live
# registry API, not assumed: the `docker-content-digest` response header
# on a GET to `/v2/library/node/manifests/20-bookworm-slim` returned this
# exact digest, and the manifest body's own
# `org.opencontainers.image.version`/`image.url` annotations confirm it's
# genuinely `node:20-bookworm-slim`, not a mismatched image. This pins
# the multi-platform manifest LIST digest (not a single-arch manifest),
# so `docker build` still resolves the correct platform automatically.
# Re-pinning periodically for security patches is a real, accepted
# tradeoff of digest pinning — not automated here.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3000
CMD ["npm", "start"]
