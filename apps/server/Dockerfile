# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────────
# Sanctum on-device inference server (apps/server).
#
# Build from the REPO ROOT so apps/server is in the build context:
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

# ── deps: install ONLY the server's own dependency closure ──
# apps/server is installed as a STANDALONE package here (its package.json becomes the
# image root), so npm never resolves the mobile workspace's React Native / Metro / Babel
# tree into the server image. @qvac/sdk is pinned exactly (0.12.2) so inference is
# reproducible; the dev dep `tsx` is kept because it runs the TypeScript directly at runtime.
FROM base AS deps
COPY apps/server/package.json ./package.json
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund

# ── runtime ──
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    QVAC_DEVICE=cpu \
    QVAC_GPU_LAYERS=0
# Server-only node_modules from the deps stage (resolved from /app/node_modules at runtime).
COPY --from=deps /app/node_modules ./node_modules
COPY apps/server ./apps/server
# Mount points for large weights + the writable forensic perf-log (compose binds host dirs here).
RUN mkdir -p apps/server/models apps/server/artifacts
WORKDIR /app/apps/server
EXPOSE 8787
# The model is loaded once at boot; GET /health serves only after it is ready.
CMD ["npm", "start"]
