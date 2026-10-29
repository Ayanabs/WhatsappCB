# ══════════════════════════════════════════════════════════════════════════════
# Stage 1 — deps
# Install production node_modules only (no devDependencies)
# ══════════════════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim AS deps

WORKDIR /app

COPY package*.json ./
COPY scripts/patch-whatsapp-media.cjs ./scripts/patch-whatsapp-media.cjs
RUN npm ci --omit=dev

# ══════════════════════════════════════════════════════════════════════════════
# Stage 2 — runtime
# Install Chromium system libraries required by Puppeteer, then copy app source
# ══════════════════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim AS runtime

# ── Chromium / Puppeteer system dependencies ──────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
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
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      wget \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Non-root user for security ────────────────────────────────────────────────
RUN groupadd -r botuser && useradd -r -g botuser -m botuser

WORKDIR /app

# Copy production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY --chown=botuser:botuser . .

# ── Persistent volume mount-points ────────────────────────────────────────────
# These directories are mounted as Docker volumes so data survives container restarts.
RUN mkdir -p .wwebjs_auth data uploads \
    && chown -R botuser:botuser .wwebjs_auth data uploads

# ── Runtime environment defaults ──────────────────────────────────────────────
ENV NODE_ENV=production \
    API_PORT=5150 \
    FRONTEND_PORT=5151 \
    WORKER_INTERVAL_MS=5000

EXPOSE 5150 5151

USER botuser

# Health-check: verify the API server is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:5150/api/status || exit 1

CMD ["node", "server.js"]
