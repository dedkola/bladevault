# syntax=docker/dockerfile:1

# The Playwright 1.64.1 image ships Node 26.x, matching .nvmrc. Fail the build
# if the image moves to a different Node major so the mismatch is deliberate.
FROM mcr.microsoft.com/playwright:v1.65.0-noble AS base

RUN node --version && npm --version && \
  node -e "const major = process.versions.node.split('.')[0]; if (major !== '26') process.exit(1)"

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

# Sentry source map upload runs only in release CI. The auth token arrives as a
# BuildKit secret so it never lands in an image layer; without it the build is
# unchanged. SENTRY_UPLOAD_REF differs per release so a cached build from main
# cannot skip the upload.
ARG SENTRY_ORG=
ARG SENTRY_PROJECT=
ARG SENTRY_UPLOAD_REF=

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  SENTRY_ORG="$SENTRY_ORG" SENTRY_PROJECT="$SENTRY_PROJECT" \
  SENTRY_UPLOAD_REF="$SENTRY_UPLOAD_REF" npm run build

FROM base AS runner

LABEL org.opencontainers.image.title="BladeVault"
LABEL org.opencontainers.image.description="A sharp, local-first knife collection manager."

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV BLADEVAULT_DATA_DIR=/app/data
ENV BLADEVAULT_DOCKER_RUNTIME=1
# Official images built in release CI carry the BladeVault Sentry DSN as a
# default. Nothing is sent until someone answers "Send Reports" in the app;
# local and fork builds leave it empty. Operators can set
# BLADEVAULT_ERROR_REPORTING=off or their own SENTRY_DSN.
ARG BLADEVAULT_DEFAULT_SENTRY_DSN=
ENV BLADEVAULT_DEFAULT_SENTRY_DSN=${BLADEVAULT_DEFAULT_SENTRY_DSN}
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
RUN rm -rf /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx

RUN mkdir -p /app/data
RUN mkdir -p /app/.next/cache/images

EXPOSE 3000

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & node server.js"]
