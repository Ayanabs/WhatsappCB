'use strict';

/**
 * plugins/autoReply.js
 * Message plugin — auto-reply to incoming messages that match configured keywords.
 *
 * Configuration is read dynamically from the DB key "plugins.autoReply".
 * Schema:
 *   {
 *     enabled: boolean,
 *     rules: [
 *       { keyword: string, reply: string, caseSensitive: boolean }
 *     ]
 *   }
 *
 * The DB key is set to a safe default if missing, so no manual setup is needed.
 */

const { getDb } = require('../core/db');
const logger = require('../core/logger');

/** Ensure the plugin's config node exists in the DB. */
function ensureConfig() {
  const db = getDb();
  if (!db.has('plugins.autoReply').value()) {
    db.set('plugins.autoReply', {
      enabled: false,
      rules: [],
    }).write();
  }
}

/**
 * Handle an incoming WhatsApp message.
 * @param {{ message: import('whatsapp-web.js').Message, client: import('whatsapp-web.js').Client }} context
 */
async function run({ message, client }) {
  ensureConfig();
  const db = getDb();
  const cfg = db.get('plugins.autoReply').value();

  if (!cfg.enabled || !cfg.rules || cfg.rules.length === 0) return;

  const body = message.body || '';

  for (const rule of cfg.rules) {
    const haystack = rule.caseSensitive ? body : body.toLowerCase();
    const needle   = rule.caseSensitive ? rule.keyword : rule.keyword.toLowerCase();

    if (haystack.includes(needle)) {
      try {
        await message.reply(rule.reply);
        logger.info(`[AutoReply] Replied to keyword "${rule.keyword}".`);
      } catch (err) {
        logger.error(`[AutoReply] Failed to reply to keyword "${rule.keyword}":`, err.message);
      }
      break; // first matching rule wins
    }
  }
}

module.exports = {
  name: 'autoReply',
  type: 'message',
  run,
};
