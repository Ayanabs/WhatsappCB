'use strict';

/**
 * routes/api.js
 * REST API endpoints consumed by the HUD frontend.
 * Supports both JSON bodies and multipart/form-data (for media uploads).
 */

const express  = require('express');
const path     = require('path');
const fse      = require('fs-extra');
const multer   = require('multer');

const router = express.Router();
const { getDb, getTargetGroups } = require('../core/db');
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
fse.ensureDirSync(UPLOADS_DIR);

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

function sendState(res) {
  const db = getDb();
  res.json({ ok: true, state: db.getState(), targetGroups: getTargetGroups() });
}

function randomId() {
  try {
    const { randomUUID } = require('crypto');
    return randomUUID();
  } catch {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}

function resolveMediaPath(file) {
  if (!file) return null;
  return file.path;
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
    if (!message && !req.file) {
      return res.status(400).json({ ok: false, error: 'Message text or media is required' });
    }
    if (!isReady()) {
      return res.status(400).json({ ok: false, error: 'WhatsApp client is not ready. Please verify connection.' });
    }

    const mediaPath = resolveMediaPath(req.file);
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

// ─── POST /api/countdown ─────────────────────────────────────────────────────
async function saveCountdownConfig(req) {
  const { enabled, eventTitle, startDate, targetDate, messageTemplate, intervalHours, dailyTime, clearMedia } = req.body;
  const db = getDb();
  const currentCfg = db.get('countdown').value() || {};
  const patch = {};

  for (const [field, value] of Object.entries({ startDate, targetDate })) {
    if (value && isNaN(new Date(value).getTime())) throw new Error(`Invalid ${field}`);
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

  // Handle poster file upload or removal
  if (req.file) {
    patch.mediaPath = req.file.path;
    patch.mediaUrl  = `/uploads/${req.file.filename}`;
    patch.mediaName = req.file.originalname;
  } else if (clearMedia === 'true' || clearMedia === true) {
    if (currentCfg.mediaPath && await fse.pathExists(currentCfg.mediaPath)) {
      await fse.remove(currentCfg.mediaPath).catch(() => {});
    }
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

  db.get('countdown').assign(patch).write();
  broadcast('config:updated', db.getState());
  return db.get('countdown').value();
}

router.post('/countdown', upload.single('media'), async (req, res) => {
  try {
    const cfg = await saveCountdownConfig(req);
    sendState(res);
  } catch (err) {
    logger.error('[API] POST /countdown error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Each day's override is saved independently from the main countdown form.
router.post('/countdown/days/:date', upload.single('media'), async (req, res) => {
  const date = req.params.date;
  const dateMs = Date.parse(`${date}T00:00:00+05:30`);
  const cfg = getDb().get('countdown').value() || {};
  const localDay = (value) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 10) : '';
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateMs) || localDay(new Date(dateMs).toISOString()) !== date ||
      !localDay(cfg.startDate) || !localDay(cfg.targetDate) || date < localDay(cfg.startDate) || date > localDay(cfg.targetDate)) {
    if (req.file) await fse.remove(req.file.path).catch(() => {});
    return res.status(400).json({ ok: false, error: 'Save valid start and target dates first, then choose a date within that range.' });
  }
  const all = { ...(cfg.dailyContent || {}) };
  const old = all[date] || {};
  const entry = {
    eventTitle: typeof req.body.eventTitle === 'string' ? req.body.eventTitle.trim() : '',
    messageTemplate: typeof req.body.messageTemplate === 'string' ? req.body.messageTemplate.trim() : '',
    mediaPath: old.mediaPath || null, mediaUrl: old.mediaUrl || null, mediaName: old.mediaName || null,
  };
  if (req.file) {
    entry.mediaPath = req.file.path;
    entry.mediaUrl = `/uploads/${req.file.filename}`;
    entry.mediaName = req.file.originalname;
  } else if (req.body.clearMedia === 'true') {
    entry.mediaPath = entry.mediaUrl = entry.mediaName = null;
  }
  if (entry.eventTitle || entry.messageTemplate || entry.mediaPath) all[date] = entry;
  else delete all[date];
  const db = getDb();
  db.set('countdown.dailyContent', all).write();
  broadcast('config:updated', db.getState());
  sendState(res);
});

// ─── POST /api/countdown/broadcast ───────────────────────────────────────────
/** Force an immediate broadcast of the countdown message */
router.post('/countdown/broadcast', upload.single('media'), async (req, res) => {
  try {
    if (!isReady()) {
      return res.status(400).json({ ok: false, error: 'WhatsApp client is not ready' });
    }
    // Save the current form (including its new poster) without starting a
    // separate automatic broadcast before the requested immediate broadcast.
    await saveCountdownConfig(req);
    const result = await runCountdownCheck({ force: true });
    if (result.sentCount > 0) {
      res.json({ ok: true, sentCount: result.sentCount, message: `Countdown sent to ${result.sentCount} group(s).`, state: getDb().getState() });
    } else {
      res.status(400).json({ ok: false, error: result.error || 'No groups reached' });
    }
  } catch (err) {
    logger.error('[API] POST /countdown/broadcast error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/posts ──────────────────────────────────────────────────────────
router.post('/posts', upload.single('media'), (req, res) => {
  try {
    const { scheduledAt, message = '' } = req.body;
    if (!scheduledAt || (!message.trim() && !req.file)) {
      return res.status(400).json({ ok: false, error: 'A scheduled time and message or attachment are required.' });
    }
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ ok: false, error: 'Invalid scheduled time.' });
    }

    const mediaPath = resolveMediaPath(req.file);
    const mediaUrl  = req.file ? `/uploads/${req.file.filename}` : null;

    const db   = getDb();
    const post = {
      id:          randomId(),
      scheduledAt: scheduledDate.toISOString(),
      message: message.trim(),
      mediaPath,
      mediaUrl,
      mediaName:   req.file ? req.file.originalname : null,
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

    if (post?.mediaPath && await fse.pathExists(post.mediaPath)) {
      await fse.remove(post.mediaPath);
    }

    db.get('scheduledPosts').remove({ id }).write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] DELETE /posts/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/alarms ─────────────────────────────────────────────────────────
router.post('/alarms', upload.single('media'), (req, res) => {
  try {
    const { time, message, enabled } = req.body;
    if (!time || !message) {
      return res.status(400).json({ ok: false, error: 'time and message are required.' });
    }

    const mediaPath = resolveMediaPath(req.file);
    const mediaUrl  = req.file ? `/uploads/${req.file.filename}` : null;

    const db    = getDb();
    const alarm = {
      id:            randomId(),
      time,
      message,
      mediaPath,
      mediaUrl,
      mediaName:     req.file ? req.file.originalname : null,
      enabled:       enabled === undefined ? true : (enabled === 'true' || enabled === true),
      lastFiredDate: null,
      createdAt:     new Date().toISOString(),
    };

    db.get('dailyAlarms').push(alarm).write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] POST /alarms error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PATCH /api/alarms/:id ────────────────────────────────────────────────────
router.patch('/alarms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { enabled, time, message } = req.body;
    const db    = getDb();
    const patch = {};
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (typeof time    === 'string')  patch.time    = time;
    if (typeof message === 'string')  patch.message = message;

    db.get('dailyAlarms').find({ id }).assign(patch).write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] PATCH /alarms/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /api/alarms/:id ───────────────────────────────────────────────────
router.delete('/alarms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db    = getDb();
    const alarm = db.get('dailyAlarms').find({ id }).value();

    if (alarm?.mediaPath && await fse.pathExists(alarm.mediaPath)) {
      await fse.remove(alarm.mediaPath);
    }

    db.get('dailyAlarms').remove({ id }).write();
    broadcast('config:updated', db.getState());
    sendState(res);
  } catch (err) {
    logger.error('[API] DELETE /alarms/:id error:', err.message);
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

// ─── Multer error handler ────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.startsWith('Unsupported')) {
    logger.warn('[API] Upload error:', err.message);
    return res.status(400).json({ ok: false, error: err.message });
  }
  next(err);
});

module.exports = router;
