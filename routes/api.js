'use strict';

/**
 * routes/api.js
 * REST API endpoints consumed by the HUD frontend.
 * Supports both JSON bodies and multipart/form-data (for media uploads).
 */

const express  = require('express');
const path     = require('path');
const { URL }  = require('url');
const fse      = require('fs-extra');
const multer   = require('multer');
const qrcode   = require('qrcode');
const approval = require('../core/approvalAuth');

const router = express.Router();
const { getDb, getTargetGroups, COUNTDOWN_DEFAULTS } = require('../core/db');
const {
  getClient,
  logoutClient,
  isReady,
  getLastQr,
  getGroups,
  findGroupByName,
  sendMessage,
  broadcast,
} = require('../core/whatsappClient');
const { runCountdownCheck } = require('../core/countdown');
const { tick } = require('../core/taskWorker');
const logger = require('../core/logger');

// ─── Media upload storage ─────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const POSTERS_DIR = path.join(process.cwd(), 'posters');
fse.ensureDirSync(UPLOADS_DIR);
fse.ensureDirSync(POSTERS_DIR);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    cb(null, safeName);
  },
});

/** Accept single file uploads up to 64 MB */
const upload = multer({
  storage,
  limits: { fileSize: 64 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(video|image|audio)\//;
    if (allowed.test(file.mimetype) || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendState(res, extra = {}) {
  const db = getDb();
  res.json({ ok: true, ...extra, state: db.getState(), targetGroups: getTargetGroups() });
}

function randomId() {
  try {
    const { randomUUID } = require('crypto');
    return randomUUID();
  } catch {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}

function resolveMedia(req) {
  if (req.file) {
    return {
      mediaPath: req.file.path,
      mediaUrl: `/uploads/${req.file.filename}`,
      mediaName: req.file.originalname,
    };
  }
  const rawUrl = req.body.mediaUrl || req.body.posterUrl;
  if (rawUrl && typeof rawUrl === 'string') {
    const baseName = path.basename(rawUrl.trim());
    const candidateUploads = path.join(UPLOADS_DIR, baseName);
    const candidatePosters = path.join(POSTERS_DIR, baseName);
    if (fse.existsSync(candidateUploads)) {
      return {
        mediaPath: candidateUploads,
        mediaUrl: `/uploads/${baseName}`,
        mediaName: req.body.mediaName || baseName,
      };
    }
    if (fse.existsSync(candidatePosters)) {
      return {
        mediaPath: candidatePosters,
        mediaUrl: `/posters/${baseName}`,
        mediaName: req.body.mediaName || baseName,
      };
    }
  }
  return { mediaPath: null, mediaUrl: null, mediaName: null };
}

function resolveMediaPath(file) {
  if (!file) return null;
  return file.path;
}

/**
 * Delete an uploaded file once nothing refers to it any more. Library posters
 * and files shared with other countdowns or posts are kept.
 */
async function removeUnusedUpload(filePath) {
  if (!filePath || !path.resolve(filePath).startsWith(UPLOADS_DIR + path.sep)) return;
  const db = getDb();
  const name = path.basename(filePath);
  const used = (db.get('savedPosters').value() || []).some((p) => p.filename === name) ||
    (db.get('scheduledPosts').value() || []).some((p) => p.mediaPath === filePath) ||
    (db.get('countdowns').value() || []).some((c) => c.mediaPath === filePath ||
      Object.values(c.dailyContent || {}).some((day) => day.mediaPath === filePath));
  if (!used) await fse.remove(filePath).catch(() => {});
}

// ─── GET /api/state ───────────────────────────────────────────────────────────
router.get('/state', (req, res) => {
  try {
    sendState(res);
  } catch (err) {
    logger.error('[API] GET /state error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/status ──────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ ok: true, ready: isReady(), hasQr: !!getLastQr() });
});

router.get('/approval/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, enabled: approval.isConfigured(), ready: isReady() });
});

// Initial enrollment is only available on the computer running the bot.
function localEnrollment(req, res, next) {
  const remote = req.socket.remoteAddress;
  let localOrigin = true;
  if (req.get('origin')) {
    try { localOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.get('origin')).hostname); }
    catch (_) { localOrigin = false; }
  }
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || !localOrigin) {
    return res.status(403).json({ ok: false, error: 'Set up the authenticator from the bot computer using localhost.' });
  }
  if (!isReady()) return res.status(400).json({ ok: false, error: 'Connect WhatsApp before setting up approval.' });
  res.set('Cache-Control', 'no-store');
  next();
}

router.post('/approval/setup', localEnrollment, async (_req, res) => {
  try {
    const setup = approval.beginSetup();
    res.json({ ok: true, token: setup.token, key: setup.key, qrImage: await qrcode.toDataURL(setup.uri) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.post('/approval/confirm', localEnrollment, (req, res) => {
  try {
    approval.confirmSetup(req.body.token, req.body.code);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── GET /api/groups ──────────────────────────────────────────────────────────
/** Return list of all groups detected on WhatsApp, optionally filtered by admin role */
router.get('/groups', async (req, res) => {
  try {
    if (!isReady()) return res.json({ ok: false, error: 'Client not ready' });
    const adminOnly = req.query.adminOnly === 'true';
    const groups = await getGroups({ adminOnly });
    res.json({ ok: true, groups });
  } catch (err) {
    logger.error('[API] GET /groups error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/groups/target ───────────────────────────────────────────────────
/** Return configured target groups */
router.get('/groups/target', (req, res) => {
  try {
    res.json({ ok: true, targetGroups: getTargetGroups() });
  } catch (err) {
    logger.error('[API] GET /groups/target error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/groups/target ──────────────────────────────────────────────────
/** Add a target group */
router.post('/groups/target', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ ok: false, error: 'Group name is required' });
    }
    const clean = name.trim();
    const db = getDb();
    const current = getTargetGroups();
    if (!current.includes(clean)) {
      current.push(clean);
      db.set('targetGroups', current).set('groupTarget.name', clean).write();
      broadcast('config:updated', db.getState());
    }
    sendState(res);
  } catch (err) {
    logger.error('[API] POST /groups/target error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /api/groups/target ────────────────────────────────────────────────
/** Remove a target group */
router.delete('/groups/target', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'Name is required' });
    const clean = name.trim();
    const db = getDb();
    const current = getTargetGroups().filter((g) => g !== clean);
    db.set('targetGroups', current).set('groupTarget.name', current[0] || '').write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] DELETE /groups/target error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/group (Legacy support) ─────────────────────────────────────────
router.post('/group', (req, res) => {
  try {
    const { name } = req.body;
    if (typeof name !== 'string') {
      return res.status(400).json({ ok: false, error: 'name must be a string.' });
    }
    const clean = name.trim();
    const db = getDb();
    const current = getTargetGroups();
    if (clean && !current.includes(clean)) {
      current.push(clean);
    }
    db.set('targetGroups', current).set('groupTarget.name', clean).write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] POST /group error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/send-test ──────────────────────────────────────────────────────
/** Instant test message dispatch to specific or all target groups */
router.post('/send-test', upload.single('media'), async (req, res) => {
  try {
    const { target, message } = req.body;
    const media = resolveMedia(req);
    const mediaPath = media.mediaPath;
    if (!message && !mediaPath) {
      return res.status(400).json({ ok: false, error: 'Message text or media is required' });
    }
    if (!isReady()) {
      return res.status(400).json({ ok: false, error: 'WhatsApp client is not ready. Please verify connection.' });
    }

    let targets = [];

    if (!target || target === '__ALL__' || target === 'ALL') {
      targets = getTargetGroups();
      if (targets.length === 0) {
        return res.status(400).json({ ok: false, error: 'No configured target groups to send to.' });
      }
    } else {
      targets = [target.trim()];
    }

    let sentCount = 0;
    const errors = [];

    for (const groupName of targets) {
      const group = await findGroupByName(groupName);
      if (!group) {
        errors.push(`Group not found on WhatsApp: "${groupName}"`);
        continue;
      }

      const ok = await sendMessage(group.id._serialized, message || '', mediaPath);
      if (ok) {
        sentCount++;
      } else {
        errors.push(`Failed to send to: "${groupName}"`);
      }
    }

    if (sentCount > 0) {
      broadcast('log:event', {
        type: 'test_message',
        message: `${message || '[Media File]'} [Delivered to ${sentCount} group(s)]`,
        sentAt: new Date().toISOString(),
      });
      res.json({ ok: true, sentCount, errors });
    } else {
      res.status(400).json({ ok: false, error: errors.join(', ') || 'Failed to dispatch test message' });
    }
  } catch (err) {
    logger.error('[API] POST /send-test error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Countdowns ──────────────────────────────────────────────────────────────
/** Create a countdown (no id) or update an existing one from the request body. */
async function saveCountdownConfig(req, id) {
  const { enabled, eventTitle, startDate, targetDate, messageTemplate, intervalHours, dailyTime, clearMedia } = req.body;
  const db = getDb();
  const existing = id ? db.get('countdowns').find({ id }).value() : null;
  if (id && !existing) throw Object.assign(new Error('Countdown not found'), { status: 404 });
  const currentCfg = existing || {};
  const patch = {};

  for (const [field, value] of Object.entries({ startDate, targetDate })) {
    if (value && isNaN(new Date(value).getTime())) throw new Error(`Invalid ${field}`);
  }
  if (!existing && !targetDate) throw new Error('Set a target date for the new countdown');
  // A start after the target would keep the countdown from ever sending.
  const effectiveStart = typeof startDate === 'string' ? startDate : currentCfg.startDate;
  const effectiveTarget = typeof targetDate === 'string' ? targetDate : currentCfg.targetDate;
  if (effectiveStart && effectiveTarget && new Date(effectiveStart) >= new Date(effectiveTarget)) {
    throw Object.assign(new Error('The start date must be before the target date'), { status: 400 });
  }

  if (typeof eventTitle === 'string')      patch.eventTitle      = eventTitle.trim();
  if (typeof enabled === 'boolean')        patch.enabled         = enabled;
  if (typeof enabled === 'string')         patch.enabled         = enabled === 'true';
  if (typeof startDate === 'string')       patch.startDate       = startDate;
  if (typeof targetDate === 'string')      patch.targetDate      = targetDate;
  if (typeof messageTemplate === 'string') patch.messageTemplate = messageTemplate;
  if (intervalHours !== undefined)         patch.intervalHours   = parseFloat(intervalHours) || 24;
  if (dailyTime !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) throw new Error('Choose a valid daily publish time');
    patch.dailyTime = dailyTime;
  }
  const willBeEnabled = patch.enabled === undefined ? currentCfg.enabled : patch.enabled;
  if (willBeEnabled && !patch.dailyTime && !currentCfg.dailyTime) throw new Error('Choose a daily publish time');
  if (willBeEnabled && (!currentCfg.enabled || (patch.dailyTime && patch.dailyTime !== currentCfg.dailyTime) ||
    (patch.startDate !== undefined && patch.startDate !== currentCfg.startDate) ||
    (patch.targetDate !== undefined && patch.targetDate !== currentCfg.targetDate))) {
    patch.scheduleFrom = new Date().toISOString();
  }

  // Handle poster file upload, library selection, or removal
  const media = resolveMedia(req);
  let removedMedia = null;
  if (media.mediaPath) {
    patch.mediaPath = media.mediaPath;
    patch.mediaUrl  = media.mediaUrl;
    patch.mediaName = media.mediaName;
  } else if (clearMedia === 'true' || clearMedia === true) {
    removedMedia = currentCfg.mediaPath;
    patch.mediaPath = null;
    patch.mediaUrl  = null;
    patch.mediaName = null;
  }

  // If starting date or target date changed, reset lastSentAt so the new countdown cycle starts cleanly
  if (
    (patch.startDate !== undefined && patch.startDate !== currentCfg.startDate) ||
    (patch.targetDate !== undefined && patch.targetDate !== currentCfg.targetDate)
  ) {
    patch.lastSentAt = null;
  }

  if (existing) {
    db.get('countdowns').find({ id }).assign(patch).write();
  } else {
    id = `countdown-${randomId()}`;
    db.get('countdowns').push({ ...COUNTDOWN_DEFAULTS, dailyContent: {}, ...patch, id, createdAt: new Date().toISOString() }).write();
  }
  await removeUnusedUpload(removedMedia);
  broadcast('config:updated', db.getState());
  return db.get('countdowns').find({ id }).value();
}

function countdownError(res, label, err) {
  logger.error(`[API] ${label} error:`, err.message);
  res.status(err.status || 500).json({ ok: false, error: err.message });
}

// ─── POST /api/countdowns ────────────────────────────────────────────────────
router.post('/countdowns', upload.single('media'), async (req, res) => {
  try {
    const cfg = await saveCountdownConfig(req);
    sendState(res, { countdownId: cfg.id });
  } catch (err) {
    countdownError(res, 'POST /countdowns', err);
  }
});

// ─── POST /api/countdowns[/:id]/broadcast ────────────────────────────────────
/** Save the form (creating the countdown if it is new) and broadcast it immediately */
router.post(['/countdowns/broadcast', '/countdowns/:id/broadcast'], upload.single('media'), async (req, res) => {
  try {
    if (!isReady()) {
      return res.status(400).json({ ok: false, error: 'WhatsApp client is not ready' });
    }
    // Save the current form (including its new poster) without starting a
    // separate automatic broadcast before the requested immediate broadcast.
    const cfg = await saveCountdownConfig(req, req.params.id);
    const result = await runCountdownCheck({ force: true, id: cfg.id });
    if (result.sentCount > 0) {
      res.json({ ok: true, countdownId: cfg.id, sentCount: result.sentCount, message: `Countdown sent to ${result.sentCount} group(s).`, state: getDb().getState() });
    } else {
      res.status(400).json({ ok: false, countdownId: cfg.id, error: result.error || 'No groups reached' });
    }
  } catch (err) {
    countdownError(res, 'POST /countdowns/broadcast', err);
  }
});

// ─── POST /api/countdowns/:id ────────────────────────────────────────────────
router.post('/countdowns/:id', upload.single('media'), async (req, res) => {
  try {
    const cfg = await saveCountdownConfig(req, req.params.id);
    sendState(res, { countdownId: cfg.id });
  } catch (err) {
    countdownError(res, 'POST /countdowns/:id', err);
  }
});

// ─── DELETE /api/countdowns/:id ──────────────────────────────────────────────
router.delete('/countdowns/:id', async (req, res) => {
  try {
    const db = getDb();
    const cfg = db.get('countdowns').find({ id: req.params.id }).value();
    if (!cfg) return res.status(404).json({ ok: false, error: 'Countdown not found' });
    db.get('countdowns').remove({ id: cfg.id }).write();
    for (const filePath of [cfg.mediaPath, ...Object.values(cfg.dailyContent || {}).map((day) => day.mediaPath)]) {
      await removeUnusedUpload(filePath);
    }
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    countdownError(res, 'DELETE /countdowns/:id', err);
  }
});

// Each day's override is saved independently from the main countdown form.
router.post('/countdowns/:id/days/:date', upload.single('media'), async (req, res) => {
  const { id, date } = req.params;
  const dateMs = Date.parse(`${date}T00:00:00+05:30`);
  const db = getDb();
  const cfg = db.get('countdowns').find({ id }).value();
  if (!cfg) {
    if (req.file) await fse.remove(req.file.path).catch(() => {});
    return res.status(404).json({ ok: false, error: 'Countdown not found' });
  }
  const localDay = (value) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 10) : '';
  };
  // Without a start date the countdown runs from today.
  const firstDay = localDay(cfg.startDate) || localDay(new Date().toISOString());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateMs) || localDay(new Date(dateMs).toISOString()) !== date ||
      !localDay(cfg.targetDate) || date < firstDay || date > localDay(cfg.targetDate)) {
    if (req.file) await fse.remove(req.file.path).catch(() => {});
    return res.status(400).json({ ok: false, error: 'Save a valid target date first, then choose a date between the start and target dates.' });
  }
  const all = { ...(cfg.dailyContent || {}) };
  const old = all[date] || {};
  const entry = {
    eventTitle: typeof req.body.eventTitle === 'string' ? req.body.eventTitle.trim() : '',
    messageTemplate: typeof req.body.messageTemplate === 'string' ? req.body.messageTemplate.trim() : '',
    mediaPath: old.mediaPath || null, mediaUrl: old.mediaUrl || null, mediaName: old.mediaName || null,
  };
  const media = resolveMedia(req);
  if (media.mediaPath) {
    entry.mediaPath = media.mediaPath;
    entry.mediaUrl = media.mediaUrl;
    entry.mediaName = media.mediaName;
  } else if (req.body.clearMedia === 'true') {
    entry.mediaPath = entry.mediaUrl = entry.mediaName = null;
  }
  if (entry.eventTitle || entry.messageTemplate || entry.mediaPath) all[date] = entry;
  else delete all[date];
  db.get('countdowns').find({ id }).assign({ dailyContent: all }).write();
  if (old.mediaPath && old.mediaPath !== entry.mediaPath) await removeUnusedUpload(old.mediaPath);
  broadcast('config:updated', db.getState());
  sendState(res);
});

// ─── POST /api/posts ──────────────────────────────────────────────────────────
router.post('/posts', upload.single('media'), (req, res) => {
  try {
    const { scheduledAt, message = '' } = req.body;
    const media = resolveMedia(req);
    if (!scheduledAt || (!message.trim() && !media.mediaPath)) {
      return res.status(400).json({ ok: false, error: 'A scheduled time and message or attachment are required.' });
    }
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ ok: false, error: 'Invalid scheduled time.' });
    }

    const mediaPath = media.mediaPath;
    const mediaUrl  = media.mediaUrl;
    const mediaName = media.mediaName;

    const db   = getDb();
    const post = {
      id:          randomId(),
      scheduledAt: scheduledDate.toISOString(),
      message: message.trim(),
      mediaPath,
      mediaUrl,
      mediaName:   mediaName || (req.file ? req.file.originalname : null),
      sent:        false,
      sentAt:      null,
      createdAt:   new Date().toISOString(),
    };

    db.get('scheduledPosts').push(post).write();
    broadcast('config:updated', db.getState());
    sendState(res);
    // Due posts can run now instead of waiting for the next polling interval.
    setImmediate(() => tick().catch((err) => logger.warn('[API] Scheduled post check failed:', err.message)));
  } catch (err) {
    logger.error('[API] POST /posts error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /api/posts/:id ────────────────────────────────────────────────────
router.delete('/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db   = getDb();
    const post = db.get('scheduledPosts').find({ id }).value();

    db.get('scheduledPosts').remove({ id }).write();
    await removeUnusedUpload(post?.mediaPath);
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] DELETE /posts/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Bot Commands Endpoints ──────────────────────────────────────────────────

// GET /api/commands
router.get('/commands', (req, res) => {
  try {
    const db = getDb();
    const botCommands = db.get('botCommands').value() || {};
    res.json({ ok: true, botCommands });
  } catch (err) {
    logger.error('[API] GET /commands error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/commands/settings
router.post('/commands/settings', (req, res) => {
  try {
    const {
      enabled,
      prefix,
      allowedInTargetGroupsOnly,
      cooldownSeconds,
      strictCommandMode,
      strictIgnoreAdmins,
      warnSender,
      warningTemplate,
      warningAutoDeleteSeconds,
    } = req.body;
    const db = getDb();
    const patch = {};

    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (typeof enabled === 'string') patch.enabled = enabled === 'true';

    if (typeof prefix === 'string' && prefix.trim()) {
      patch.prefix = prefix.trim();
    }

    if (typeof allowedInTargetGroupsOnly === 'boolean') {
      patch.allowedInTargetGroupsOnly = allowedInTargetGroupsOnly;
    } else if (typeof allowedInTargetGroupsOnly === 'string') {
      patch.allowedInTargetGroupsOnly = allowedInTargetGroupsOnly === 'true';
    }

    if (cooldownSeconds !== undefined) {
      patch.cooldownSeconds = Math.max(0, parseInt(cooldownSeconds, 10) || 0);
    }

    if (typeof strictCommandMode === 'boolean') {
      patch.strictCommandMode = strictCommandMode;
    } else if (typeof strictCommandMode === 'string') {
      patch.strictCommandMode = strictCommandMode === 'true';
    }

    if (typeof strictIgnoreAdmins === 'boolean') {
      patch.strictIgnoreAdmins = strictIgnoreAdmins;
    } else if (typeof strictIgnoreAdmins === 'string') {
      patch.strictIgnoreAdmins = strictIgnoreAdmins === 'true';
    }

    if (typeof warnSender === 'boolean') {
      patch.warnSender = warnSender;
    } else if (typeof warnSender === 'string') {
      patch.warnSender = warnSender === 'true';
    }

    if (typeof warningTemplate === 'string') {
      patch.warningTemplate = warningTemplate;
    }

    if (warningAutoDeleteSeconds !== undefined) {
      patch.warningAutoDeleteSeconds = Math.max(0, parseInt(warningAutoDeleteSeconds, 10) || 0);
    }

    db.get('botCommands').assign(patch).write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] POST /commands/settings error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/commands/items
router.post('/commands/items', (req, res) => {
  try {
    const { id, trigger, description, response, action, enabled } = req.body;
    if (!trigger || typeof trigger !== 'string') {
      return res.status(400).json({ ok: false, error: 'trigger is required.' });
    }

    const cleanTrigger = trigger.trim().toLowerCase().replace(/^[!/#.]+/, '');
    if (!cleanTrigger) {
      return res.status(400).json({ ok: false, error: 'Valid trigger keyword is required.' });
    }

    const db = getDb();
    const list = db.get('botCommands.commands').value() || [];

    if (id) {
      // Update existing
      db.get('botCommands.commands')
        .find({ id })
        .assign({
          trigger: cleanTrigger,
          description: description || '',
          response: response || '',
          enabled: enabled !== undefined ? Boolean(enabled) : true,
        })
        .write();
    } else {
      // Check duplicate trigger
      const exists = list.some((c) => c.trigger.toLowerCase() === cleanTrigger);
      if (exists) {
        return res.status(400).json({ ok: false, error: `Command trigger "${cleanTrigger}" already exists.` });
      }

      const newCmd = {
        id: `cmd-${randomId()}`,
        trigger: cleanTrigger,
        description: description || '',
        action: action || 'custom',
        response: response || '',
        enabled: enabled !== undefined ? Boolean(enabled) : true,
      };

      db.get('botCommands.commands').push(newCmd).write();
    }

    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] POST /commands/items error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/commands/toggle/:id
router.post('/commands/toggle/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();
    const cmd = db.get('botCommands.commands').find({ id }).value();
    if (!cmd) {
      return res.status(404).json({ ok: false, error: 'Command not found' });
    }

    db.get('botCommands.commands')
      .find({ id })
      .assign({ enabled: !cmd.enabled })
      .write();

    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] POST /commands/toggle/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/commands/items/:id
router.delete('/commands/items/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();
    const cmd = db.get('botCommands.commands').find({ id }).value();
    if (!cmd) {
      return res.status(404).json({ ok: false, error: 'Command not found' });
    }

    db.get('botCommands.commands').remove({ id }).write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] DELETE /commands/items/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/logout ────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    await logoutClient();
    res.json({ ok: true, message: 'Session revoked and auth cache wiped. Generating a fresh QR code...' });
  } catch (err) {
    logger.error('[API] POST /logout error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/session/reset ─────────────────────────────────────────────────
router.post('/session/reset', async (req, res) => {
  try {
    await logoutClient();
    res.json({ ok: true, message: 'Auth session reset and cache purged.' });
  } catch (err) {
    logger.error('[API] POST /session/reset error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/worker/tick ────────────────────────────────────────────────────
router.post('/worker/tick', async (req, res) => {
  try {
    await tick();
    res.json({ ok: true, message: 'Worker tick executed.' });
  } catch (err) {
    logger.error('[API] POST /worker/tick error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Poster Library Endpoints ───────────────────────────────────────────────

/**
 * GET /api/posters/templates
 * Returns list of SVG templates available in the /posters folder.
 */
router.get('/posters/templates', async (_req, res) => {
  try {
    fse.ensureDirSync(POSTERS_DIR);
    const files = await fse.readdir(POSTERS_DIR);
    const templates = [];
    for (const file of files) {
      if (file.toLowerCase().endsWith('.svg')) {
        const filePath = path.join(POSTERS_DIR, file);
        const content = await fse.readFile(filePath, 'utf8');
        const displayName = file
          .replace(/\.svg$/i, '')
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        templates.push({
          id: `tpl-${file}`,
          filename: file,
          name: displayName,
          url: `/posters/${file}`,
          content,
        });
      }
    }
    res.json({ ok: true, templates });
  } catch (err) {
    logger.error('[API] GET /posters/templates error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/posters/library
 * Returns all saved PNG/image posters from the database and uploads directory.
 */
router.get('/posters/library', async (_req, res) => {
  try {
    const db = getDb();
    const saved = db.get('savedPosters').value() || [];
    const postersMap = new Map();

    // 1. Add tracked saved posters
    for (const p of saved) {
      if (p.filename && (await fse.pathExists(path.join(UPLOADS_DIR, p.filename)))) {
        postersMap.set(p.filename, {
          id: p.id || `poster-${p.filename}`,
          name: p.name || p.filename,
          filename: p.filename,
          mediaUrl: p.mediaUrl || `/uploads/${p.filename}`,
          createdAt: p.createdAt || new Date().toISOString(),
        });
      }
    }

    // 2. Scan uploads directory for any generated posters / images
    fse.ensureDirSync(UPLOADS_DIR);
    const uploadFiles = await fse.readdir(UPLOADS_DIR);
    for (const f of uploadFiles) {
      if (/\.(png|jpe?g|webp)$/i.test(f) && !postersMap.has(f)) {
        const cleanName = f
          .replace(/^\d+-/, '')
          .replace(/\.[^.]+$/, '')
          .replace(/[-_]/g, ' ');
        postersMap.set(f, {
          id: `upload-${f}`,
          name: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
          filename: f,
          mediaUrl: `/uploads/${f}`,
          createdAt: new Date().toISOString(),
        });
      }
    }

    res.json({ ok: true, posters: Array.from(postersMap.values()) });
  } catch (err) {
    logger.error('[API] GET /posters/library error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/posters/save
 * Saves a rendered PNG poster to the library.
 */
router.post('/posters/save', upload.single('media'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Poster image file is required.' });
    }
    const name = (req.body.name && req.body.name.trim()) || req.file.originalname.replace(/\.[^.]+$/, '');
    const poster = {
      id: `poster-${randomId()}`,
      name,
      filename: req.file.filename,
      mediaPath: req.file.path,
      mediaUrl: `/uploads/${req.file.filename}`,
      createdAt: new Date().toISOString(),
    };

    const db = getDb();
    if (!db.has('savedPosters').value()) {
      db.set('savedPosters', []).write();
    }
    db.get('savedPosters').push(poster).write();
    broadcast('config:updated', db.getState());

    res.json({ ok: true, poster });
  } catch (err) {
    logger.error('[API] POST /posters/save error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Multer error handler ────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.startsWith('Unsupported')) {
    logger.warn('[API] Upload error:', err.message);
    return res.status(400).json({ ok: false, error: err.message });
  }
  next(err);
});

module.exports = router;
