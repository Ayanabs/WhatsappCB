'use strict';

/**
 * core/scheduledPosts.js
 * One-time scheduled post engine.
 * Iterates all unsent posts, checks if their scheduled time has arrived,
 * sends to all configured target groups, and marks them as sent (idempotent).
 */

const { getDb, getTargetGroups } = require('./db');
const { findGroupByName, sendMessage, broadcast, isReady } = require('./whatsappClient');
const logger = require('./logger');

const _sending = new Set();

/**
 * Run one cycle of the scheduled posts checker.
 * Called by the task worker on every tick.
 */
async function runScheduledPostsCheck() {
  if (!isReady()) return;
  const db = getDb();
  const posts = db.get('scheduledPosts').value();
  const targetGroups = getTargetGroups();

  if (!targetGroups || targetGroups.length === 0) return;
  if (!posts || posts.length === 0) return;

  const now = Date.now();
  const unsentDue = posts.filter((p) => {
    if (p.sent) return false;
    const scheduled = new Date(p.scheduledAt).getTime();
    return !isNaN(scheduled) && now >= scheduled;
  });

  if (unsentDue.length === 0) return;

  for (const post of unsentDue) {
    if (post.sent || _sending.has(post.id)) continue;
    _sending.add(post.id);
    try {
      const delivered = new Set(post.deliveredGroupIds || []);
      const errors = [];
      let allDelivered = true;

      for (const groupName of targetGroups) {
        try {
          const group = await findGroupByName(groupName);
          if (!group) {
            logger.warn(`[ScheduledPosts] Group not found: "${groupName}"`);
            allDelivered = false;
            errors.push(`Group not found: ${groupName}`);
            continue;
          }

          const groupId = group.id._serialized;
          if (delivered.has(groupId)) continue;
          const sent = await sendMessage(groupId, post.message, post.mediaPath || null, { throwOnError: true });
          if (sent) {
            delivered.add(groupId);
            db.get('scheduledPosts').find({ id: post.id })
              .assign({ deliveredGroupIds: [...delivered] }).write();
            logger.info(`[ScheduledPosts] Post "${post.id}" delivered to "${groupName}"`);
          } else {
            throw new Error('WhatsApp did not confirm delivery');
          }
        } catch (err) {
          allDelivered = false;
          errors.push(`${groupName}: ${err.message}`);
          logger.error(`[ScheduledPosts] Error sending post "${post.id}" to "${groupName}":`, err.message);
        }
      }

      const sentAt = new Date().toISOString();
      db.get('scheduledPosts').find({ id: post.id })
        .assign({ lastAttemptAt: sentAt, lastError: errors.join('; ') || null }).write();

      if (allDelivered) {
        // Mark as sent in the DB
        db.get('scheduledPosts')
          .find({ id: post.id })
          .assign({ sent: true, sentAt })
          .write();

        logger.info(`[ScheduledPosts] Post "${post.id}" completed (${delivered.size} group(s)).`);
        broadcast('log:event', {
          type: 'scheduled_post',
          postId: post.id,
          message: `${post.message} [Sent to ${delivered.size} group(s)]`,
          sentAt: new Date().toISOString(),
        });
      }
      broadcast('config:updated', db.getState());
    } finally {
      _sending.delete(post.id);
    }
  }
}

module.exports = { runScheduledPostsCheck };
