'use strict';

/**
 * server.js
 * Application entry point.
 *
 * Two HTTP servers:
 *  • API server   (API_PORT,      default 3000) — Express API + Socket.IO
 *  • Frontend server (FRONTEND_PORT, default 8080) — Static HUD files only
 *
 * The frontend learns the API origin via GET /config.js served by the
 * frontend server, so no hardcoded ports appear in the static assets.
 */

require('dotenv').config();

const path    = require('path');
const express = require('express');
const http    = require('http');
const fse     = require('fs-extra');
const { Server: SocketIOServer } = require('socket.io');
const cors    = require('cors');

const logger         = require('./core/logger');
const { getDb }      = require('./core/db');
const waClient       = require('./core/whatsappClient');
const taskWorker     = require('./core/taskWorker');
const pluginRegistry = require('./plugins');
const apiRouter      = require('./routes/api');
const approvalAuth   = require('./core/approvalAuth');

// ─── Port configuration ───────────────────────────────────────────────────────

const API_PORT      = parseInt(process.env.API_PORT || process.env.PORT, 10) || 5150;
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT, 10) || 5151;

// ─── Uploads directory ────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, 'uploads');
fse.ensureDirSync(UPLOADS_DIR);

// ══════════════════════════════════════════════════════════════════════════════
// API SERVER  (API_PORT)
// Handles: REST API, Socket.IO, uploaded-file serving, CORS
// ══════════════════════════════════════════════════════════════════════════════

const apiApp    = express();
const apiServer = http.createServer(apiApp);
const io        = new SocketIOServer(apiServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

apiApp.use(cors());
apiApp.use(express.json());
apiApp.use(express.urlencoded({ extended: false }));

// Serve uploaded media so the HUD can preview them
apiApp.use('/uploads', express.static(UPLOADS_DIR));

// REST API
apiApp.use('/api', approvalAuth.middleware, apiRouter);

// 404 fallback for the API server (don't serve HTML here)
apiApp.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ══════════════════════════════════════════════════════════════════════════════
// FRONTEND SERVER  (FRONTEND_PORT)
// Handles: static HUD assets + runtime config endpoint + Socket.IO client bundle
// ══════════════════════════════════════════════════════════════════════════════

const frontendApp    = express();
const frontendServer = http.createServer(frontendApp);

/**
 * GET /socket.io/socket.io.js
 * Serves the Socket.IO client library directly so the browser can load it
 * synchronously and reliably without depending on external CDNs.
 */
frontendApp.get('/socket.io/socket.io.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'));
});

/**
 * GET /config.js
 * Returns a runtime JS snippet exposing the API origin to the HUD.
 * Loaded in index.html to decouple client-side code from hardcoded endpoints.
 */
frontendApp.get('/config.js', (req, res) => {
  const protocol = req.protocol || 'http';
  const host = req.hostname;
  const apiOrigin = process.env.PUBLIC_API_URL || `${protocol}://${host}:${API_PORT}`;
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`/* Dynamic runtime configuration */\nwindow.WABOT_API = ${JSON.stringify(apiOrigin)};\n`);
});

// Serve uploaded media directly on the frontend port as well
frontendApp.use('/uploads', express.static(UPLOADS_DIR));

// Serve static HUD files from /public
frontendApp.use(express.static(path.join(__dirname, 'public')));

// SPA catch-all
frontendApp.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  logger.info(`[Socket.IO] HUD client connected: ${socket.id}`);

  // Push full current state immediately on connect
  try {
    socket.emit('config:updated', getDb().getState());
  } catch (err) {
    logger.error('[Socket.IO] Error sending initial state:', err.message);
  }

  // If WA is already ready, inform the newly connected client
  if (waClient.isReady()) {
    const client = waClient.getClient();
    socket.emit('wa:ready', {
      name:   client?.info?.pushname,
      number: client?.info?.wid?.user,
    });
  } else if (waClient.getLastQr()) {
    // If client is waiting for QR scan, stream the existing QR code immediately
    socket.emit('wa:qr', { qrImageUrl: waClient.getLastQr() });
  }

  socket.on('disconnect', () => {
    logger.info(`[Socket.IO] HUD client disconnected: ${socket.id}`);
  });
});

// ─── WhatsApp message → plugin pipeline ──────────────────────────────────────

waClient.setMessageListener(async (message) => {
  const client = waClient.getClient();
  for (const plugin of pluginRegistry.getMessagePlugins()) {
    try {
      await plugin.run({ message, client });
    } catch (err) {
      logger.error(`[Server] Message plugin "${plugin.name}" error:`, err.message);
    }
  }
});

// ─── Startup sequence ─────────────────────────────────────────────────────────

async function main() {
  // 1. Initialise DB
  getDb();
  logger.info('[Server] Database initialised.');

  // 2. Load plugins
  pluginRegistry.loadPlugins();

  // 3. Inject Socket.IO into the WA client for event broadcasting
  waClient.setSocketServer(io);

  // 4. Start API server
  await new Promise((resolve) => apiServer.listen(API_PORT, resolve));
  logger.info(`[Server] API server        → http://localhost:${API_PORT}`);

  // 5. Start frontend server
  await new Promise((resolve) => frontendServer.listen(FRONTEND_PORT, resolve));
  logger.info(`[Server] HUD dashboard     → http://localhost:${FRONTEND_PORT}`);

  // 6. Start WhatsApp client
  waClient.startClient().catch((err) => {
    logger.error('[Server] WhatsApp client startup failed:', err.message);
  });

  // 7. Start background task worker
  taskWorker.start();
  logger.info('[Server] Task worker started.');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`[Server] Received ${signal} — shutting down gracefully.`);
  taskWorker.stop();
  try { await waClient.getClient()?.destroy(); } catch (_) { /* best-effort */ }

  await Promise.allSettled([
    new Promise((r) => apiServer.close(r)),
    new Promise((r) => frontendServer.close(r)),
  ]);
  logger.info('[Server] All servers closed.');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (err) => logger.error('[Server] Uncaught exception:', err));
process.on('unhandledRejection', (err) => logger.error('[Server] Unhandled rejection:', err));

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
