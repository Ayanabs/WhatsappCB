'use strict';

/**
 * plugins/botCommands.js
 * Interactive in-group & private DM bot commands & moderation plugin.
 *
 * Features:
 *  1. Bot Commands: Listens to incoming group messages (and private DMs), detects command prefixes (e.g. !),
 *     and dispatches actions (e.g. !countdown, !time, !help, custom commands).
 *     If a poster is configured for the countdown, it sends the poster + caption as ONE unified message.
 *  2. Strict Command Mode (Auto-Moderation): Automatically deletes non-command messages from
 *     the group (requires the bot to be a Group Admin), keeping the chat strictly command-only.
 *
 * All commands, triggers, descriptions, and custom replies are configured dynamically
 * via the database / HUD without hardcoded keyword lists.
 * Strictly ZERO emojis across responses, notices, logs, and default templates.
 */

const path = require('path');
const fse = require('fs-extra');
const { MessageMedia } = require('whatsapp-web.js');
const { getDb, getTargetGroups } = require('../core/db');
const { formatCountdownMessage } = require('../core/countdown');
const { broadcast, findGroupByName } = require('../core/whatsappClient');
const logger = require('../core/logger');

/** In-memory cooldown tracking: key = `${chatId}:${trigger}`, val = timestamp */
const _cooldownCache = new Map();

/** Ensure botCommands configuration node exists in the DB */
function ensureConfig() {
  const db = getDb();
  if (!db.has('botCommands').value()) {
    db.set('botCommands', {
      enabled: true,
      prefix: '!',
      allowedInTargetGroupsOnly: true,
      cooldownSeconds: 3,
      strictCommandMode: false,
      strictIgnoreAdmins: true,
      warnSender: true,
      warningTemplate: '[NOTICE] Only bot commands (starting with {prefix}) are allowed in this group.',
      warningAutoDeleteSeconds: 10,
      commands: [
        {
          id: 'cmd-countdown',
          trigger: 'countdown',
          description: 'Show remaining time until countdown target date',
          action: 'countdown',
          response: '',
          enabled: true,
        },
        {
          id: 'cmd-time',
          trigger: 'time',
          description: 'Show current server date and time',
          action: 'time',
          response: '',
          enabled: true,
        },
        {
          id: 'cmd-help',
          trigger: 'help',
          description: 'List all available interactive bot commands',
          action: 'help',
          response: '',
          enabled: true,
        },
      ],
    }).write();
  } else {
    const current = db.get('botCommands').value();
    const patch = {};
    if (current.strictCommandMode === undefined) patch.strictCommandMode = false;
    if (current.strictIgnoreAdmins === undefined) patch.strictIgnoreAdmins = true;
    if (current.warnSender === undefined) patch.warnSender = true;
    if (!current.warningTemplate || /[\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u26FF\u2700-\u27BF]/.test(current.warningTemplate)) {
      patch.warningTemplate = '[NOTICE] Only bot commands (starting with {prefix}) are allowed in this group.';
    }
    if (current.warningAutoDeleteSeconds === undefined) patch.warningAutoDeleteSeconds = 10;
    if (Object.keys(patch).length > 0) {
      db.get('botCommands').assign(patch).write();
    }
  }
}

/**
 * Safely resolves the sender display name without calling message.getContact()
 * (which relies on getContactById and can fail in recent WhatsApp Web builds).
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 * @returns {Promise<string>}
 */
async function getSenderDisplayName(client, message) {
  if (message._data?.notifyName) {
    return message._data.notifyName;
  }
  const senderId = message.author || message.from;
  if (!senderId) return 'Member';

  try {
    if (client && client.pupPage) {
      const name = await client.pupPage.evaluate((sId) => {
        try {
          const contact = window.require('WAWebCollections')?.Contact?.get(sId);
          return contact?.pushname || contact?.name || contact?.formattedName || '';
        } catch (_) {
          return '';
        }
      }, senderId);
      if (name) return name;
    }
  } catch (_) {}

  const cleanNumber = senderId.replace(/@.*$/, '');
  return cleanNumber ? `+${cleanNumber}` : 'Member';
}

/**
 * Safely resolves the chat / group title without calling message.getChat()
 * (which invokes groupMetadata.update and crashes in current WhatsApp Web builds).
 * @param {import('whatsapp-web.js').Client} client
 * @param {string} chatId
 * @returns {Promise<string>}
 */
async function getChatName(client, chatId) {
  if (!chatId) return '';
  if (!chatId.endsWith('@g.us')) return 'Private Chat';

  try {
    if (client && client.pupPage) {
      const name = await client.pupPage.evaluate((cId) => {
        try {
          const chat = window.require('WAWebCollections')?.Chat?.get(cId);
          return chat?.name || chat?.formattedTitle || '';
        } catch (_) {
          return '';
        }
      }, chatId);
      if (name) return name;
    }
  } catch (_) {}

  return '';
}

/**
 * Checks whether the sender is an admin in the group without calling message.getChat().
 * Supports both standard phone-number JIDs (@c.us) and Linked Identity device JIDs (@lid).
 * @param {import('whatsapp-web.js').Client} client
 * @param {string} chatId
 * @param {string} senderId
 * @returns {Promise<boolean>}
 */
async function isSenderAdmin(client, chatId, senderId) {
  try {
    if (client && client.pupPage) {
      return await client.pupPage.evaluate(({ cId, sId }) => {
        try {
          const chat = window.require('WAWebCollections')?.Chat?.get(cId);
          if (!chat || !chat.groupMetadata) return false;
          let parts = [];
          if (chat.groupMetadata.participants) {
            if (typeof chat.groupMetadata.participants.serialize === 'function') {
              parts = chat.groupMetadata.participants.serialize();
            } else if (typeof chat.groupMetadata.participants.getModelsArray === 'function') {
              parts = chat.groupMetadata.participants.getModelsArray();
            } else if (Array.isArray(chat.groupMetadata.participants)) {
              parts = chat.groupMetadata.participants;
            }
          }

          const cleanSid = (sId || '').replace(/@.*$/, '');
          const ContactCol = window.require('WAWebCollections')?.Contact;

          const participant = parts.find((p) => {
            const pid = p?.id?._serialized || p?.id || '';
            if (!pid) return false;
            if (pid === sId) return true;
            if (cleanSid && pid.replace(/@.*$/, '') === cleanSid) return true;

            // Check linked contact phone number when participants are keyed by LID
            try {
              const contact = ContactCol?.get(pid);
              const contactId = contact?.id?._serialized || '';
              const phone = contact?.phoneNumber || '';
              if (contactId && (contactId === sId || contactId.replace(/@.*$/, '') === cleanSid)) return true;
              if (phone && (phone === cleanSid || `${phone}@c.us` === sId)) return true;
            } catch (_) {}

            return false;
          });

          return Boolean(participant && (participant.isAdmin || participant.isSuperAdmin));
        } catch (_) {
          return false;
        }
      }, { cId: chatId, sId: senderId });
    }
  } catch (_) {}
  return false;
}

/**
 * Delete for everyone using the same revocation API as whatsapp-web.js.
 * Keep native message IDs intact and fail explicitly when revocation is unavailable.
 * message.delete(true) can silently delete only the local copy without permission.
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 * @returns {Promise<boolean>}
 */
async function deleteMessageForEveryone(client, message) {
  const msgId = message?.id?._serialized || message?.id?.$1 || message?.id;
  if (!client?.pupPage || typeof msgId !== 'string' || !msgId) {
    throw new Error('WhatsApp client or message ID is unavailable');
  }

  const result = await client.pupPage.evaluate(async (mId) => {
    try {
      const { Msg: MsgCol, Chat: ChatCol } = window.require('WAWebCollections');
      let msg = MsgCol?.get(mId);
      if (!msg) {
        const res = await MsgCol?.getMessagesById([mId]);
        msg = res?.messages?.[0];
      }
      if (!msg) {
        return { ok: false, error: 'Message not found in collections' };
      }

      const remoteId = msg.id?.remote;
      const chat = remoteId ? (ChatCol?.get(remoteId) || (await ChatCol?.find(remoteId))) : null;
      if (!chat) {
        return { ok: false, error: 'Group chat not found in collections' };
      }

      const capabilities = window.require('WAWebMsgActionCapability');
      const canRevoke = msg.id?.fromMe
        ? capabilities.canSenderRevokeMsg(msg)
        : capabilities.canAdminRevokeMsg(msg);
      if (!canRevoke) {
        return {
          ok: false,
          error: 'Delete for everyone is unavailable. The bot must be a group admin and the message must be eligible for deletion',
        };
      }

      const { Cmd } = window.require('WAWebCmd');
      if (window.WWebJS.compareWwebVersions(window.Debug.VERSION, '>=', '2.3000.0')) {
        await Cmd.sendRevokeMsgs(chat, { list: [msg], type: 'message' }, { clearMedia: true });
      } else {
        await Cmd.sendRevokeMsgs(chat, [msg], {
          clearMedia: true,
          type: msg.id?.fromMe ? 'Sender' : 'Admin',
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }, msgId);

  if (!result?.ok) {
    throw new Error(result?.error || 'Delete for everyone failed');
  }
  return true;
}

/**
 * Checks if a group chat matches the configured target groups (by name or ID).
 * @param {import('whatsapp-web.js').Client} client
 * @param {string} chatId
 * @param {string[]} targetGroups
 * @param {string} chatName
 * @returns {Promise<boolean>}
 */
async function isChatInTargetGroups(client, chatId, targetGroups, chatName) {
  if (!targetGroups || targetGroups.length === 0) return true;

  if (chatName) {
    const lowerName = chatName.trim().toLowerCase();
    const matched = targetGroups.some((tg) => tg.trim().toLowerCase() === lowerName);
    if (matched) return true;
  }

  for (const tgName of targetGroups) {
    try {
      const grp = await findGroupByName(tgName);
      if (grp?.id?._serialized === chatId) {
        return true;
      }
    } catch (_) {}
  }

  return false;
}

/**
 * Formats the countdown response dynamically based on current countdown state.
 * Strictly ZERO emojis.
 * @param {import('lowdb').LowdbSync} db
 * @param {string} senderName
 * @returns {string}
 */
function handleCountdownCommand(db, senderName) {
  const countdown = db.get('countdown').value() || {};
  if (!countdown.enabled || !countdown.targetDate) {
    return `Hi ${senderName}, no event countdown is currently active.`;
  }

  const targetDate = new Date(countdown.targetDate);
  if (isNaN(targetDate.getTime())) {
    return 'Please set a valid date for the event countdown.';
  }

  const now = Date.now();
  if (now >= targetDate.getTime()) {
    return `${(countdown.eventTitle || '').trim() || 'Event Countdown'}\nThe event has started!`;
  }

  return formatCountdownMessage(countdown, targetDate);
}

/**
 * Formats the server date and time response.
 * Strictly ZERO emojis.
 * @param {string} senderName
 * @returns {string}
 */
function handleTimeCommand(senderName) {
  const now = new Date();
  const formattedDate = now.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const formattedTime = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `[SERVER TIME]\nDate: ${formattedDate}\nTime: ${formattedTime}`;
}

/**
 * Dynamically builds a help menu listing all enabled commands.
 * Strictly ZERO emojis.
 * @param {Object} cfg
 * @param {string} prefix
 * @param {string} senderName
 * @returns {string}
 */
function handleHelpCommand(cfg, prefix, senderName) {
  const activeCommands = (cfg.commands || []).filter((c) => c.enabled);
  if (activeCommands.length === 0) {
    return `[BOT COMMANDS]\nHi ${senderName}, no interactive commands are active at the moment.`;
  }

  let text = `[INTERACTIVE BOT COMMANDS MENU]\nHello ${senderName}, here are the available commands:\n\n`;
  for (const c of activeCommands) {
    text += `* ${prefix}${c.trigger} - ${c.description || 'Command'}\n`;
  }
  text += `\nType any command with the prefix "${prefix}" directly in this chat.`;
  return text;
}

/**
 * Formats a custom command response with dynamic placeholder replacements.
 * @param {Object} cmd
 * @param {string} senderName
 * @param {string} groupName
 * @returns {string}
 */
function handleCustomCommand(cmd, senderName, groupName) {
  const template = cmd.response || '';
  if (!template) return '';
  const now = new Date();
  return template
    .replace(/\{name\}/gi, senderName)
    .replace(/\{group\}/gi, groupName || '')
    .replace(/\{time\}/gi, now.toLocaleTimeString())
    .replace(/\{date\}/gi, now.toLocaleDateString());
}

/**
 * Sends a message reply safely using client.sendMessage directly.
 * Attempts quoted reply first, then falls back to unquoted if quoting fails.
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 * @param {string} replyText
 * @param {string|null} mediaPath
 */
async function safeReply(client, message, replyText, mediaPath = null) {
  const chatId = message.from;
  const quotedMessageId = message.id?._serialized;
  let content = replyText;
  // Match the broadcast transport: a failing read receipt must not block delivery.
  const options = { sendSeen: false };
  if (mediaPath) {
    const resolvedPath = path.resolve(mediaPath);
    if (!(await fse.pathExists(resolvedPath))) {
      throw new Error('Countdown poster is missing. Please upload the poster again.');
    }
    content = MessageMedia.fromFilePath(resolvedPath);
    options.caption = replyText;
  }

  let sent;
  try {
    sent = await client.sendMessage(chatId, content, { ...options, quotedMessageId });
  } catch (quoteErr) {
    if (!quotedMessageId) throw quoteErr;
    logger.warn('[BotCommands] Quoted reply failed, sending unquoted:', quoteErr.message);
    // Keep the same poster and caption when WhatsApp cannot quote the command.
    sent = await client.sendMessage(chatId, content, options);
  }
  if (!sent?.id) throw new Error('WhatsApp did not confirm creation of the reply');
}

/**
 * Handles auto-moderation under Strict Command Mode:
 * Deletes non-command messages from the group and optionally sends a transient warning.
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 * @param {string} chatId
 * @param {string} senderName
 * @param {Object} cfg
 * @param {string} prefix
 * @param {string} groupTitle
 */
async function handleStrictCommandModeModeration(client, message, chatId, senderName, cfg, prefix, groupTitle) {
  try {
    const senderId = message.author || message.from;

    // Check if sender is a group admin and if admins are exempted
    if (cfg.strictIgnoreAdmins) {
      const isAdmin = await isSenderAdmin(client, chatId, senderId);
      if (isAdmin) {
        logger.debug(`[BotCommands] Strict mode: Allowed non-command message from admin "${senderId}" in "${groupTitle || chatId}"`);
        return;
      }
    }

    // Delete the message for everyone
    try {
      await deleteMessageForEveryone(client, message);
      logger.info(`[BotCommands] Strict Mode: Deleted non-command message from "${senderName}" in "${groupTitle || chatId}"`);
      broadcast('log:event', {
        type: 'moderation',
        message: `Strict Mode: Deleted non-command message from ${senderName} in "${groupTitle || chatId}"`,
        sentAt: new Date().toISOString(),
      });
    } catch (delErr) {
      logger.warn(`[BotCommands] Strict Mode: Could not delete message from "${senderName}" in "${groupTitle || chatId}". Error: ${delErr.message}`);
      broadcast('log:event', {
        type: 'moderation',
        message: `Strict Mode: Could not delete message from ${senderName} in "${groupTitle || chatId}" (${delErr.message})`,
        sentAt: new Date().toISOString(),
      });
      return;
    }

    // Send transient warning notice if configured
    if (cfg.warnSender) {
      const warningTemplate = cfg.warningTemplate || '[NOTICE] Only bot commands (starting with {prefix}) are allowed in this group.';
      const warningText = warningTemplate
        .replace(/\{name\}/gi, senderName)
        .replace(/\{prefix\}/gi, prefix)
        .replace(/\{group\}/gi, groupTitle || '');

      try {
        const sentWarning = await client.sendMessage(chatId, warningText);
        const autoDeleteSec = parseInt(cfg.warningAutoDeleteSeconds, 10);
        if (autoDeleteSec > 0 && sentWarning?.id) {
          setTimeout(async () => {
            try {
              await deleteMessageForEveryone(client, sentWarning);
              logger.debug(`[BotCommands] Auto-deleted transient warning in "${groupTitle || chatId}"`);
            } catch (err) {
              logger.warn(`[BotCommands] Could not auto-delete warning: ${err.message}`);
            }
          }, autoDeleteSec * 1000);
        }
      } catch (warnErr) {
        logger.warn(`[BotCommands] Failed to send transient warning: ${warnErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[BotCommands] Strict Mode moderation error in "${groupTitle || chatId}":`, err.message);
  }
}

/**
 * Main message handler for the botCommands plugin.
 * @param {{ message: import('whatsapp-web.js').Message, client: import('whatsapp-web.js').Client }} context
 */
async function run({ message, client }) {
  if (!message) return;
  if (message.fromMe) return; // Prevent bot from triggering/moderating its own messages

  ensureConfig();
  const db = getDb();
  const cfg = db.get('botCommands').value();
  if (!cfg || !cfg.enabled) return;

  try {
    const chatId = message.from;
    if (!chatId) return;

    const isGroup = chatId.endsWith('@g.us');
    const groupName = isGroup ? await getChatName(client, chatId) : '';

    // Validate group restriction (only applies to group chats)
    if (isGroup && cfg.allowedInTargetGroupsOnly) {
      const targetGroups = getTargetGroups();
      const isAllowed = await isChatInTargetGroups(client, chatId, targetGroups, groupName);
      if (!isAllowed) {
        logger.debug(`[BotCommands] Ignoring message from non-target group: ${groupName || chatId}`);
        return;
      }
    }

    const prefix = (cfg.prefix || '!').trim();
    const rawBody = (message.body || '').trim();
    const senderName = await getSenderDisplayName(client, message);

    logger.info(`[BotCommands] Message received from "${senderName}" in "${groupName || 'Private Chat'}": "${rawBody}"`);

    const isPrefixMatch = prefix && rawBody.startsWith(prefix);
    let matchedCmd = null;

    if (isPrefixMatch) {
      const afterPrefix = rawBody.slice(prefix.length).trim();
      const parts = afterPrefix.split(/\s+/);
      const inputTrigger = (parts[0] || '').toLowerCase();

      if (inputTrigger) {
        const commandList = cfg.commands || [];
        matchedCmd = commandList.find(
          (c) => c.enabled && (c.trigger || '').trim().toLowerCase() === inputTrigger
        );
      }
    }

    // ─── Case 1: Valid Recognized Command (Groups & Private DMs) ────────────
    if (matchedCmd) {
      // Anti-spam cooldown check per chat + trigger
      const cooldownMs = Math.max(0, (cfg.cooldownSeconds || 3) * 1000);
      const cooldownKey = `${chatId}:${matchedCmd.trigger.toLowerCase()}`;
      const now = Date.now();
      if (cooldownMs > 0 && _cooldownCache.has(cooldownKey)) {
        const lastFired = _cooldownCache.get(cooldownKey);
        if (now - lastFired < cooldownMs) {
          logger.debug(`[BotCommands] Cooldown active for "${prefix}${matchedCmd.trigger}" in "${groupName || 'Private Chat'}"`);
          return;
        }
      }
      _cooldownCache.set(cooldownKey, now);

      // Execute matching action
      let replyMessage = '';
      if (matchedCmd.action === 'countdown') {
        replyMessage = handleCountdownCommand(db, senderName);
      } else if (matchedCmd.action === 'time') {
        replyMessage = handleTimeCommand(senderName);
      } else if (matchedCmd.action === 'help') {
        replyMessage = handleHelpCommand(cfg, prefix, senderName);
      } else {
        replyMessage = handleCustomCommand(matchedCmd, senderName, groupName);
      }

      if (replyMessage) {
        // If countdown has a poster attachment, send the poster + caption as ONE unified message
        const countdownCfg = db.get('countdown').value() || {};
        const mediaPath =
          matchedCmd.action === 'countdown' && countdownCfg.mediaPath
            ? countdownCfg.mediaPath
            : null;

        await safeReply(client, message, replyMessage, mediaPath);

        const chatLabel = groupName || senderName || 'Private Chat';
        logger.info(`[BotCommands] Executed "${prefix}${matchedCmd.trigger}" for "${senderName}" in "${chatLabel}"`);

        broadcast('log:event', {
          type: 'bot_command',
          message: `Command ${prefix}${matchedCmd.trigger} executed for ${senderName} in "${chatLabel}"`,
          sentAt: new Date().toISOString(),
        });
      }
      return;
    }

    // ─── Case 2: Non-Command Message Under Strict Command Mode (Groups Only) ─
    if (isGroup && cfg.strictCommandMode) {
      await handleStrictCommandModeModeration(client, message, chatId, senderName, cfg, prefix, groupName);
    }
  } catch (err) {
    logger.error('[BotCommands] Error in message handler:', err.message);
  }
}

module.exports = {
  name: 'botCommands',
  type: 'message',
  run,
};
