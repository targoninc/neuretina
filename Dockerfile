# syntax=docker/dockerfile:1

FROM oven/bun:1-slim AS build
WORKDIR /app

# Dependencies change rarely but are expensive: install them before any source
# is copied so edits never invalidate them. The cache mount keeps Bun's
# package cache warm across builds, so even a lockfile change does not
# re-fetch everything.
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/bun-cache,sharing=locked \
    BUN_INSTALL_CACHE_DIR=/bun-cache bun install --frozen-lockfile

COPY tsconfig.json ./
# The web build imports shared code from src/ (e.g. the markdown renderer).
COPY src ./src
COPY web ./web
RUN bun run build:web

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/bun-cache,sharing=locked \
    BUN_INSTALL_CACHE_DIR=/bun-cache bun install --frozen-lockfile --production

# Heaviest, most stable layers first; src changes most often, so it goes last
# and only rebuilds the final (cheap) layer.
COPY tsconfig.json ./
COPY --from=build /app/web/dist ./web/dist
COPY src ./src

ENV PORT=8080 \
    DB_PATH=/app/data/app.db \
    WEB_DIST=/app/web/dist

VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/webhook').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/index.ts"]
