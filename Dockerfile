# One image, two entry points: the API (default) and the worker
# (`node src/worker/main.ts`). Node 24 runs the TypeScript sources directly.

# Engines' page, built to static files the API serves.
FROM node:24-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY src ./src
COPY assets ./assets
RUN npm run build:web

FROM node:24-slim

# poppler renders PDF pages (E-05); Chromium prints PDF worksheets (E-19). Both
# run as separate processes, never linked. DejaVu covers Latin text; the Arabic
# font is embedded in every export from assets/fonts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils chromium fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY migrations ./migrations
COPY assets ./assets
COPY --from=web /build/web/dist ./web/dist

# Local blob storage (STORAGE=local), owned by the runtime user so a compose
# volume mounted here is writable.
RUN mkdir -p /data/storage && chown node:node /data/storage

USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/api/main.ts"]
