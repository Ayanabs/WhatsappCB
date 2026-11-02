# ══════════════════════════════════════════════════════════════════════════════
# Stage 1 — deps
# Install production node_modules only (no devDependencies). Puppeteer downloads
# its Chrome during `npm ci`; PUPPETEER_CACHE_DIR keeps it inside /app so the
# runtime stage can copy it (the default ~/.cache would be left behind).
# ══════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS deps

WORKDIR /app
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package*.json ./
COPY scripts/patch-whatsapp-media.cjs ./scripts/patch-whatsapp-media.cjs
RUN npm ci --omit=dev && npm cache clean --force

# ══════════════════════════════════════════════════════════════════════════════
# Stage 2 — runtime
# Install Chromium system libraries required by Puppeteer, then copy app source
# ══════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS runtime

# ── Chromium / Puppeteer system dependencies (+ tzdata for local time) ────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxshmfence1 \
      libxss1 \
      libxtst6 \
      tzdata \
      wget \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Non-root user for security ────────────────────────────────────────────────
RUN groupadd -r botuser && useradd -r -g botuser -m botuser

WORKDIR /app

# Copy production node_modules and Puppeteer's Chrome from the deps stage
COPY --from=deps --chown=botuser:botuser /app/node_modules ./node_modules
COPY --from=deps --chown=botuser:botuser /app/.cache ./.cache

# Copy application source
COPY --chown=botuser:botuser . .

# ── Persistent volume mount-points ────────────────────────────────────────────
# These directories are mounted as Docker volumes so data survives container restarts.
# Creating them here, owned by botuser, gives new named volumes the same owner.
RUN mkdir -p .wwebjs_auth .wwebjs_cache data uploads logs \
    && chown -R botuser:botuser .wwebjs_auth .wwebjs_cache data uploads logs

# ── Runtime environment defaults ──────────────────────────────────────────────
ENV NODE_ENV=production \
    API_PORT=5150 \
    FRONTEND_PORT=5151 \
    WORKER_INTERVAL_MS=5000 \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    TZ=Asia/Colombo

EXPOSE 5150 5151

USER botuser

# Health-check: verify the API server is responding (shell form so API_PORT expands)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- "http://localhost:${API_PORT}/api/status" || exit 1

CMD ["node", "server.js"]
