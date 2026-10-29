'use strict';

/**
 * core/whatsappClient.js
 * Singleton WhatsApp client manager.
 * Handles QR code streaming, authentication events, session persistence via LocalAuth,
 * and forceful cache purging upon session logout or invalidation.
 */

const path = require('path');
const { execSync } = require('child_process');
const fse = require('fs-extra');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const logger = require('./logger');

const AUTH_DATA_PATH = path.join(process.cwd(), '.wwebjs_auth');

let _client = null;
let _clientReady = false;
let _lastQrImageUrl = null;
let _io = null;                  // Socket.IO server reference (injected after init)
let _messageListener = null;     // Registered incoming message handler
let _isLoggingOut = false;       // Guard against concurrent logout/re-init calls

function getLastQr() {
  return _lastQrImageUrl;
}

/**
 * Terminate any lingering Puppeteer Chromium processes locking the session directory.
 * @param {import('whatsapp-web.js').Client} [client]
 */
function killPuppeteerProcesses(client) {
  try {
    const browser = client?.pupBrowser || _client?.pupBrowser;
    if (browser) {
      const proc = browser.process();
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }
  } catch (_) {}

  // On Windows, ensure any detached chrome processes holding locks on .wwebjs_auth are terminated
  if (process.platform === 'win32') {
    try {
      const escapedPath = AUTH_DATA_PATH.replace(/'/g, "''");
      const psCommand = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escapedPath}*' -and ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'chromium.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execSync(`powershell -NoProfile -NonInteractive -Command "${psCommand}"`, { stdio: 'ignore', timeout: 4000 });
    } catch (_) {}
  }
}

/**
 * Inject the Socket.IO server so the WA client can push events to the HUD.
 * @param {import('socket.io').Server} io
 */
function setSocketServer(io) {
  _io = io;
}

/**
 * Register a listener for incoming messages so it survives client reinstantiations.
 * @param {Function} handler
 */
function setMessageListener(handler) {
  _messageListener = handler;
  if (_client) {
    _client.on('message', _messageListener);
  }
}

/**
 * Emit an event to all connected HUD clients (if Socket.IO is available).
 * @param {string} event
 * @param {*} payload
 */
function broadcast(event, payload) {
  if (_io) {
    _io.emit(event, payload);
  }
}

/**
 * Forcefully wipes the .wwebjs_auth directory from the filesystem.
 * Handles temporary Windows file locks with process termination and retries.
 * @param {import('whatsapp-web.js').Client} [clientToKill]
 */
async function wipeSessionCache(clientToKill = null) {
  killPuppeteerProcesses(clientToKill);

  const maxRetries = 6;
  const retryDelayMs = 400;

  logger.info(`[WhatsApp] Purging auth cache directory: ${AUTH_DATA_PATH}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (await fse.pathExists(AUTH_DATA_PATH)) {
        await fse.remove(AUTH_DATA_PATH);
      }
      logger.info('[WhatsApp] Session cache (.wwebjs_auth) wiped completely from disk.');
      return true;
    } catch (err) {
      logger.warn(`[WhatsApp] Cache removal attempt ${attempt}/${maxRetries} (${err.message}). Retrying...`);
      killPuppeteerProcesses(clientToKill);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  // Fallback: if removal fails due to persistent lock, attempt to empty the contents
  try {
    if (await fse.pathExists(AUTH_DATA_PATH)) {
      await fse.emptyDir(AUTH_DATA_PATH);
      logger.info('[WhatsApp] Session cache directory emptied as fallback.');
      return true;
    }
  } catch (finalErr) {
    logger.error('[WhatsApp] Final attempt to empty auth directory failed:', finalErr.message);
  }

  return false;
}

/**
 * Build and return the WhatsApp client instance.
 * @returns {import('whatsapp-web.js').Client}
 */
function getClient() {
  if (_client) return _client;

  _client = new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_DATA_PATH,
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
      ],
    },
  });

  // Attach message pipeline handler if registered
  if (_messageListener) {
    _client.on('message', _messageListener);
  }

  // ── QR Code Event ────────────────────────────────────────────────────────
  _client.on('qr', async (qrData) => {
    logger.info('[WhatsApp] New QR code generated — scan to authenticate.');

    // 1. Print to terminal
    qrcodeTerminal.generate(qrData, { small: true });

    // 2. Encode as base64 PNG for the HUD
    try {
      const qrImageUrl = await qrcode.toDataURL(qrData);
      _lastQrImageUrl = qrImageUrl;
      broadcast('wa:qr', { qrImageUrl });
      logger.info('[WhatsApp] Fresh QR code broadcast to HUD.');
    } catch (err) {
      logger.error('[WhatsApp] Failed to encode QR for HUD:', err.message);
    }
  });

  // ── Authentication Success ────────────────────────────────────────────────
  _client.on('authenticated', () => {
    _lastQrImageUrl = null;
    logger.info('[WhatsApp] Session authenticated successfully.');
    broadcast('wa:authenticated', {});
  });

  // ── Client Ready ─────────────────────────────────────────────────────────
  _client.on('ready', () => {
    _clientReady = true;
    _lastQrImageUrl = null;
    _isLoggingOut = false;
    const info = _client.info;
    logger.info(`[WhatsApp] Client ready — logged in as ${info?.pushname} (${info?.wid?.user})`);
    broadcast('wa:ready', {
      name: info?.pushname,
      number: info?.wid?.user,
    });
  });

  // ── Disconnected ──────────────────────────────────────────────────────────
  _client.on('disconnected', async (reason) => {
    _clientReady = false;
    logger.warn(`[WhatsApp] Client disconnected: ${reason}`);
    broadcast('wa:disconnected', { reason });

    // If logged out from phone or session invalid, purge cache and restart
    if (!_isLoggingOut && (reason === 'LOGOUT' || reason === 'NAVIGATION')) {
      logger.info('[WhatsApp] Session revoked by device/server. Purging cache and requesting fresh login...');
      await logoutClient();
    }
  });

  // ── Auth Failure ──────────────────────────────────────────────────────────
  _client.on('auth_failure', async (msg) => {
    _clientReady = false;
    logger.error(`[WhatsApp] Auth failure: ${msg}. Stored session is invalid — purging...`);
    broadcast('wa:auth_failure', { message: msg });

    if (!_isLoggingOut) {
      await logoutClient();
    }
  });

  return _client;
}

/**
 * Start (initialise) the WhatsApp client.
 */
async function startClient() {
  const client = getClient();
  try {
    await client.initialize();
  } catch (err) {
    logger.error('[WhatsApp] Client initialisation error:', err.message);
    broadcast('wa:error', { message: err.message });
  }
}

/**
 * Fully revokes the WhatsApp session, closes puppeteer, wipes the .wwebjs_auth cache,
 * and immediately boots a brand new clean client to stream a new QR code.
 */
async function logoutClient() {
  if (_isLoggingOut) {
    logger.warn('[WhatsApp] Logout already in progress.');
    return;
  }
  _isLoggingOut = true;
  _clientReady = false;

  logger.info('[WhatsApp] Initiating full session revocation and cache purge...');
  broadcast('wa:logged_out', { message: 'Revoking session and purging cache...' });

  const currentClient = _client;
  _client = null;

  if (currentClient) {
    // 1. Attempt graceful WhatsApp Web logout
    try {
      await Promise.race([
        currentClient.logout(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Logout timed out')), 3000)),
      ]);
      logger.info('[WhatsApp] Logged out from WhatsApp Web page.');
    } catch (err) {
      logger.warn('[WhatsApp] Web logout notice:', err.message);
    }

    // 2. Destroy Puppeteer browser
    try {
      await Promise.race([
        currentClient.destroy(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timed out')), 3000)),
      ]);
      logger.info('[WhatsApp] Puppeteer browser destroyed.');
    } catch (err) {
      logger.warn('[WhatsApp] Browser destroy notice:', err.message);
    }
  }

  // 3. Kill lingering process locks and wipe cache
  await wipeSessionCache(currentClient);

  _isLoggingOut = false;

  // 4. Automatically initialise a clean client to generate a new QR code right away
  logger.info('[WhatsApp] Starting new unauthenticated client to stream fresh QR code...');
  startClient().catch((err) => {
    logger.error('[WhatsApp] Error starting fresh client after logout:', err.message);
  });
}

/**
 * Returns true when the WA client is fully initialised and ready.
 */
function isReady() {
  if (_clientReady && _client !== null) return true;
  if (_client && _client.info && _client.info.wid) {
    _clientReady = true;
    return true;
  }
  return false;
}

/**
 * Returns a list of all group chats the client belongs to.
 * Uses direct page model inspection to bypass whatsapp-web.js getChats() groupMetadata serialization bugs.
 * @param {Object} [options]
 * @param {boolean} [options.adminOnly=false]
 * @returns {Promise<Array<{ id: string, name: string, isAdmin: boolean }>>}
 */
async function getGroups(options = {}) {
  const { adminOnly = false } = options;
  if (!isReady()) return [];
  try {
    if (_client.pupPage) {
      const groups = await _client.pupPage.evaluate(() => {
        try {
          const ChatCollection = window.require('WAWebCollections')?.Chat;
          if (!ChatCollection) return [];

          let myWid = '';
          let myLid = '';
          try {
            const userModule = window.require('WAWebUser');
            myWid = userModule?.getMaybeMeUser()?.id?._serialized || userModule?.getMeUser()?.id?._serialized || '';
            myLid = userModule?.getMaybeMeLidUser()?.id?._serialized || '';
          } catch (_) {}

          return ChatCollection.getModelsArray()
            .filter((c) => c.isGroup || (c.id?._serialized && c.id._serialized.endsWith('@g.us')))
            .map((c) => {
              let isAdmin = false;

              // 1. Check native iAmAdmin()
              if (typeof c.iAmAdmin === 'function') {
                try {
                  isAdmin = Boolean(c.iAmAdmin());
                } catch (_) {}
              }

              // 2. Check groupMetadata participants if iAmAdmin was false or missing
              if (!isAdmin && c.groupMetadata) {
                try {
                  let parts = [];
                  if (c.groupMetadata.participants) {
                    if (typeof c.groupMetadata.participants.serialize === 'function') {
                      parts = c.groupMetadata.participants.serialize();
                    } else if (typeof c.groupMetadata.participants.getModelsArray === 'function') {
                      parts = c.groupMetadata.participants.getModelsArray();
                    } else if (Array.isArray(c.groupMetadata.participants)) {
                      parts = c.groupMetadata.participants;
                    }
                  }

                  const meParticipant = parts.find((p) => {
                    const pid = p?.id?._serialized || p?.id || '';
                    if (!pid) return false;
                    return (
                      (myWid && pid === myWid) ||
                      (myLid && pid === myLid) ||
                      (myWid && pid.replace(/@.*$/, '') === myWid.replace(/@.*$/, ''))
                    );
                  });

                  if (meParticipant && (meParticipant.isAdmin || meParticipant.isSuperAdmin)) {
                    isAdmin = true;
                  }
                } catch (_) {}
              }

              // 3. Fallback: check canEditTitle / canEditDescription
              if (!isAdmin && c.groupMetadata) {
                try {
                  if (typeof c.canEditTitle === 'function' && c.canEditTitle()) {
                    isAdmin = true;
                  }
                } catch (_) {}
              }

              return {
                id: c.id?._serialized,
                name: c.name || c.formattedTitle || '',
                isAdmin: Boolean(isAdmin),
              };
            });
        } catch (_) {
          return [];
        }
      });

      if (groups && groups.length > 0) {
        return adminOnly ? groups.filter((g) => g.isAdmin) : groups;
      }
    }

    const chats = await _client.getChats();
    const groupChats = chats
      .filter((c) => c.isGroup)
      .map((c) => {
        let isAdmin = false;
        try {
          if (c.groupMetadata?.participants && _client.info?.wid) {
            const myWid = _client.info.wid._serialized;
            const me = c.groupMetadata.participants.find(
              (p) => p.id?._serialized === myWid || p.id === myWid
            );
            isAdmin = Boolean(me && (me.isAdmin || me.isSuperAdmin));
          }
        } catch (_) {}
        return {
          id: c.id._serialized,
          name: c.name,
          isAdmin,
        };
      });

    return adminOnly ? groupChats.filter((g) => g.isAdmin) : groupChats;
  } catch (err) {
    logger.error('[WhatsApp] Error getting groups:', err.message);
    return [];
  }
}

/**
 * Find a WhatsApp group chat by display name.
 * Returns an object with { id: { _serialized: string }, name: string }, or null.
 * @param {string} groupName
 * @returns {Promise<{ id: { _serialized: string }, name: string }|null>}
 */
async function findGroupByName(groupName) {
  if (!isReady()) return null;
  const cleanQuery = (groupName || '').trim().toLowerCase();
  if (!cleanQuery) return null;

  try {
    if (_client.pupPage) {
      const targetId = await _client.pupPage.evaluate((query) => {
        try {
          const ChatCollection = window.require('WAWebCollections')?.Chat;
          if (!ChatCollection) return null;
          const found = ChatCollection.getModelsArray().find((c) => {
            const isGrp = c.isGroup || (c.id?._serialized && c.id._serialized.endsWith('@g.us'));
            if (!isGrp) return false;
            const title = (c.name || c.formattedTitle || '').trim().toLowerCase();
            return title === query;
          });
          return found?.id?._serialized || null;
        } catch (_) {
          return null;
        }
      }, cleanQuery);

      if (targetId) {
        return {
          id: { _serialized: targetId },
          name: groupName,
        };
      }
    }

    const chats = await _client.getChats();
    const target = chats.find(
      (c) => c.isGroup && (c.name || '').trim().toLowerCase() === cleanQuery
    );
    return target || null;
  } catch (err) {
    logger.error('[WhatsApp] Error finding group by name:', err.message);
    return null;
  }
}

/**
 * Send a text message (with optional media attachment) to a specific chat ID.
 * @param {string}      chatId    - WA chat ID (e.g. "12345678901234@g.us")
 * @param {string}      message   - Message / caption body
 * @param {string|null} mediaPath - Absolute or relative path to a media file (optional)
 * @param {{ throwOnError?: boolean }} options - Preserve send errors for retry reporting.
 */
async function sendMessage(chatId, message, mediaPath = null, { throwOnError = false } = {}) {
  if (!isReady()) {
    logger.warn('[WhatsApp] Cannot send — client not ready.');
    if (throwOnError) throw new Error('WhatsApp client is not ready');
    return false;
  }
  try {
    let sent;
    if (mediaPath) {
      const media = MessageMedia.fromFilePath(path.resolve(mediaPath));
      sent = await _client.sendMessage(chatId, media, { caption: message || '', sendSeen: false });
    } else {
      sent = await _client.sendMessage(chatId, message, { sendSeen: false });
    }
    if (!sent?.id) throw new Error('WhatsApp did not confirm creation of the message');
    logger.info(`[WhatsApp] ${mediaPath ? 'Media' : 'Text'} message sent to ${chatId}`);
    return true;
  } catch (err) {
    logger.error(`[WhatsApp] Failed to send message to ${chatId}:`, err.message);
    if (throwOnError) throw err;
    return false;
  }
}

module.exports = {
  getClient,
  startClient,
  logoutClient,
  wipeSessionCache,
  killPuppeteerProcesses,
  setMessageListener,
  setSocketServer,
  broadcast,
  isReady,
  getLastQr,
  getGroups,
  findGroupByName,
  sendMessage,
};
