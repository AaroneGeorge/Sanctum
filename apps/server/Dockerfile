# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────────
# Sanctum on-device inference server (apps/server).
#
# Build from the REPO ROOT so the monorepo manifests + lockfile are in context:
#   docker build -f apps/server/Dockerfile -t sanctum-server .
# or simply:  docker compose up --build
#
# Notes:
#  • glibc (bookworm), NOT alpine/musl — @qvac/sdk ships prebuilt native runtimes.
#  • Default device is CPU (QVAC_DEVICE=cpu). Vulkan GPU passthrough is host-specific
#    and intentionally out of scope for the portable image (see README → Run with Docker).
#  • GGUF weights are large + gitignored: they are mounted at runtime (compose binds
#    ./apps/server/models), never baked into the image.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
WORKDIR /app
# Runtime libs the native QVAC backend (OpenMP) + TLS web-search need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# ── deps: install ONLY the @sanctum/server workspace (skip the RN/Expo app) ──
FROM base AS deps
# Copy manifests first for layer caching. The mobile manifest is copied so npm can
# parse the workspace graph; --workspace scopes the install to the server only.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/mobile/package.json apps/mobile/package.json
# tsx runs the TypeScript directly at runtime, so dev deps are intentionally included.
RUN --mount=type=cache,target=/root/.npm \
    npm install --workspace @sanctum/server --include-workspace-root

# ── runtime ──
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    QVAC_DEVICE=cpu \
    QVAC_GPU_LAYERS=0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/server ./apps/server
# Mount points for large weights + the writable forensic perf-log (compose binds host dirs here).
RUN mkdir -p apps/server/models apps/server/artifacts
WORKDIR /app/apps/server
EXPOSE 8787
# The model is loaded once at boot; GET /health serves only after it is ready.
CMD ["npm", "start"]
