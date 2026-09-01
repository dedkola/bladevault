FROM mcr.microsoft.com/playwright:v1.62.1-noble AS deps

WORKDIR /app

# better-sqlite3 falls back to node-gyp when no prebuilt binary matches the
# current Node.js runtime. Keep the compiler toolchain in this build-only stage.
RUN apt-get update && \
  apt-get install -y --no-install-recommends build-essential && \
  rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runner

LABEL org.opencontainers.image.title="BladeVault"
LABEL org.opencontainers.image.description="A sharp, local-first knife collection manager."

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV BLADEVAULT_DATA_DIR=/app/data
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
  apt-get install -y --no-install-recommends xvfb && \
  rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & node server.js"]
