'use strict';

/**
 * core/countdown.js
 * Countdown broadcast module.
 * Checks if the countdown is active and broadcasts to all configured target groups.
 */

const { getDb, getTargetGroups } = require('./db');
const { findGroupByName, sendMessage, broadcast } = require('./whatsappClient');
const logger = require('./logger');

let _isSending = false;

function formatCountdownMessage(cfg, targetDate = new Date(cfg.targetDate)) {
  const title = (cfg.eventTitle || '').trim() || 'Event Countdown';
  const template = cfg.messageTemplate || 'Time remaining: {days} days, {hours} hours and {minutes} minutes.';
  return `${title}\n${resolveTemplate(template, targetDate)}`;
}

/**
 * Resolve countdown tokens in a template string.
 * Supported tokens: {days}, {hours}, {minutes}, {seconds}
 *
 * @param {string} template
 * @param {Date}   targetDate
 * @returns {string}
 */
function resolveTemplate(template, targetDate) {
  const now = Date.now();
  const diffMs = targetDate.getTime() - now;

  if (diffMs <= 0) {
    return template
      .replace(/\{days\}/gi, '0')
      .replace(/\{hours\}/gi, '0')
      .replace(/\{minutes\}/gi, '0')
      .replace(/\{seconds\}/gi, '0');
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return template
    .replace(/\{days\}/gi,    String(days))
    .replace(/\{hours\}/gi,   String(hours))
    .replace(/\{minutes\}/gi, String(minutes))
    .replace(/\{seconds\}/gi, String(seconds));
}

/**
 * Run one cycle of the countdown checker.
 * @param {Object}  [options]
 * @param {boolean} [options.force=false] - If true, bypass interval check and broadcast immediately.
 * @returns {Promise<{ sentCount: number, error?: string }>}
 */
async function runCountdownCheck({ force = false } = {}) {
  if (_isSending) return { sentCount: 0, error: 'A countdown broadcast is already in progress' };
  _isSending = true;
  try {
    return await sendCountdown({ force });
  } finally {
    _isSending = false;
  }
}

async function sendCountdown({ force }) {
  const db = getDb();
  const cfg = db.get('countdown').value();

  if (!cfg.enabled && !force) return { sentCount: 0 };
  if (!cfg.targetDate) return { sentCount: 0, error: 'Target date is not set' };

  const targetGroups = getTargetGroups();
  if (!targetGroups || targetGroups.length === 0) {
    logger.warn('[Countdown] No target groups configured.');
    return { sentCount: 0, error: 'No target groups configured' };
  }

  const now = Date.now();
  const targetDate = new Date(cfg.targetDate);
  if (isNaN(targetDate.getTime())) {
    logger.warn('[Countdown] Invalid targetDate in config:', cfg.targetDate);
    return { sentCount: 0, error: 'Invalid target date' };
  }

  // Target date reached — disable countdown automatically
  if (now >= targetDate.getTime()) {
    logger.info('[Countdown] Target date reached. Disabling countdown.');
    db.set('countdown.enabled', false).write();
    broadcast('config:updated', db.getState());
    return { sentCount: 0, error: 'Target date reached' };
  }

  // Check start date (if configured)
  let startMs = 0;
  if (cfg.startDate) {
    const startDate = new Date(cfg.startDate);
    if (!isNaN(startDate.getTime())) {
      startMs = startDate.getTime();
      if (now < startMs && !force) {
        // Countdown start date has not arrived yet
        return { sentCount: 0 };
      }
    }
  }

  // Send at most once for today's Sri Lanka time slot. A slot before the
  // schedule was activated or before the start date is never caught up.
  if (!force) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.dailyTime || '')) return { sentCount: 0 };
    const [hours, minutes] = cfg.dailyTime.split(':').map(Number);
    const offset = 330 * 60000;
    const dayStart = Math.floor((now + offset) / 86400000) * 86400000 - offset;
    const slot = dayStart + (hours * 60 + minutes) * 60000;
    const activatedAt = new Date(cfg.scheduleFrom || 0).getTime() || 0;
    const lastSentMs = new Date(cfg.lastSentAt || 0).getTime() || 0;
    if (now < slot || slot < startMs || slot < activatedAt || lastSentMs >= slot) return { sentCount: 0 };
  }

  const day = new Date(now + 330 * 60000).toISOString().slice(0, 10);
  const override = (cfg.dailyContent || {})[day] || {};
  const content = {
    ...cfg,
    eventTitle: override.eventTitle || cfg.eventTitle,
    messageTemplate: override.messageTemplate || cfg.messageTemplate,
    mediaPath: override.mediaPath || cfg.mediaPath,
  };
  const message = formatCountdownMessage(content, targetDate);
  let sentCount = 0;

  for (const groupName of targetGroups) {
    try {
      const group = await findGroupByName(groupName);
      if (!group) {
        logger.warn(`[Countdown] Target group not found on WhatsApp: "${groupName}"`);
        continue;
      }

      const ok = await sendMessage(group.id._serialized, message, content.mediaPath || null);
      if (ok) {
        sentCount++;
        logger.info(`[Countdown] Broadcast delivered to "${groupName}" (${group.id._serialized})`);
      }
    } catch (err) {
      logger.error(`[Countdown] Failed to send to "${groupName}":`, err.message);
    }
  }

  if (sentCount > 0) {
    const nowIso = new Date().toISOString();
    db.set('countdown.lastSentAt', nowIso).write();
    broadcast('log:event', {
      type: 'countdown',
      message: `${message} [Delivered to ${sentCount} group(s)]`,
      sentAt: nowIso,
    });
    broadcast('config:updated', db.getState());
  }

  return { sentCount, ...(sentCount === 0 ? { error: 'Countdown could not be delivered. Check the WhatsApp connection, target groups and attachment in the activity log.' } : {}) };
}

module.exports = { runCountdownCheck, resolveTemplate, formatCountdownMessage };
