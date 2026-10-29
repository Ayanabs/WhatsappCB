'use strict';

/**
 * plugins/welcomeMessage.js
 * Message plugin — sends a welcome message when a new participant joins a
 * group that matches the configured target group name.
 *
 * Configuration is read dynamically from the DB key "plugins.welcomeMessage".
 * Schema:
 *   {
 *     enabled: boolean,
 *     template: string   // supports token: {name}
 *   }
 */

const { getDb, getTargetGroups } = require('../core/db');
const logger = require('../core/logger');

/** Ensure the plugin's config node exists in the DB. */
function ensureConfig() {
  const db = getDb();
  if (!db.has('plugins.welcomeMessage').value()) {
    db.set('plugins.welcomeMessage', {
      enabled: false,
      template: 'Welcome to the group, {name}.',
    }).write();
  }
}

/**
 * Handle an incoming WhatsApp message / notification.
 * @param {{ message: import('whatsapp-web.js').Message, client: import('whatsapp-web.js').Client }} context
 */
async function run({ message, client }) {
  ensureConfig();

  // group_participant_add is a notification type, not a regular message
  if (message.type !== 'gp2' && !message.body?.includes('added')) return;

  const db = getDb();
  const cfg = db.get('plugins.welcomeMessage').value();
  if (!cfg.enabled) return;

  const targetGroups = getTargetGroups();
  if (!targetGroups || targetGroups.length === 0) return;

  try {
    const chat = await message.getChat();
    if (!chat.isGroup) return;

    const chatTitle = (chat.name || '').trim().toLowerCase();
    const isTarget = targetGroups.some((g) => g.trim().toLowerCase() === chatTitle);
    if (!isTarget) return;

    const contact = await message.getContact();
    const name = contact.pushname || contact.name || 'there';
    const welcomeText = cfg.template.replace(/\{name\}/gi, name);

    await client.sendMessage(chat.id._serialized, welcomeText);
    logger.info(`[WelcomeMessage] Welcomed "${name}" in "${chat.name}".`);
  } catch (err) {
    logger.error('[WelcomeMessage] Error sending welcome:', err.message);
  }
}

module.exports = {
  name: 'welcomeMessage',
  type: 'message',
  run,
};
