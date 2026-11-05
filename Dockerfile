# The Playwright 1.64 image ships Node 26. The project targets Node 24 LTS
# (keep this version in sync with .nvmrc), so install that runtime over the
# image's base OS.
FROM node:24.21.0-bookworm-slim AS node24

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS base

COPY --from=node24 /usr/local/bin/node /usr/local/bin/node
COPY --from=node24 /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
  ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
  node --version && npm --version

# Development container target. The dev container mounts the checkout and runs
# npm ci itself, so this stage only provides the shared runtime.
FROM base AS dev

FROM base AS deps

WORKDIR /app

# better-sqlite3 falls back to node-gyp when no prebuilt binary matches the
# current Node.js runtime. Keep the compiler toolchain in this build-only stage.
RUN apt-get update && \
  apt-get install -y --no-install-recommends build-essential && \
  rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

FROM base AS builder

WORKDIR /app

ENV BLADEVAULT_DOCKER_RUNTIME=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner

LABEL org.opencontainers.image.title="BladeVault"
LABEL org.opencontainers.image.description="A sharp, local-first knife collection manager."

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV BLADEVAULT_DATA_DIR=/app/data
ENV BLADEVAULT_DOCKER_RUNTIME=1
# Tell Playwright's interactive scraper to use a virtual display when no real
# X server is available (e.g. inside Docker).
ENV DISPLAY=:99

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Next.js standalone's dependency tracing strips files that Playwright loads
# dynamically at runtime (notably browsers.json). Copy the full package so
# Chromium can launch in the runner image.
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core

# xvfb provides a virtual framebuffer so the interactive headed browser can run
# in a container without a real display.
RUN apt-get update && \
  apt-get upgrade -y && \
  apt-get install -y --no-install-recommends xvfb && \
  rm -rf /var/lib/apt/lists/*

# npm is needed only in the build stages; the runtime starts directly with node.
RUN rm -rf /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx \
  /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN mkdir -p /app/data
RUN mkdir -p /app/.next/cache/images

EXPOSE 3000

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & node server.js"]
