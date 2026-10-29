'use strict';

/**
 * core/dailyAlarms.js
 * Daily repeating alarm engine.
 * Fires at a configured HH:MM time every day to all configured target groups.
 */

const { getDb, getTargetGroups } = require('./db');
const { findGroupByName, sendMessage, broadcast } = require('./whatsappClient');
const logger = require('./logger');

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function currentHHMM() {
  const d = new Date();
  return { h: d.getHours(), m: d.getMinutes() };
}

/**
 * Run one cycle of the daily alarms checker.
 * Called by the task worker on every tick.
 */
async function runDailyAlarmsCheck() {
  const db = getDb();
  const alarms = db.get('dailyAlarms').value();
  const targetGroups = getTargetGroups();

  if (!targetGroups || targetGroups.length === 0) return;
  if (!alarms || alarms.length === 0) return;

  const today = todayStr();
  const { h: nowH, m: nowM } = currentHHMM();

  const toFire = alarms.filter((alarm) => {
    if (!alarm.enabled) return false;
    if (alarm.lastFiredDate === today) return false;

    const [alarmH, alarmM] = (alarm.time || '').split(':').map(Number);
    if (isNaN(alarmH) || isNaN(alarmM)) return false;

    const alarmMinutes = alarmH * 60 + alarmM;
    const nowMinutes   = nowH   * 60 + nowM;
    return nowMinutes >= alarmMinutes;
  });

  if (toFire.length === 0) return;

  for (const alarm of toFire) {
    let sentCount = 0;

    for (const groupName of targetGroups) {
      try {
        const group = await findGroupByName(groupName);
        if (!group) {
          logger.warn(`[DailyAlarms] Group not found: "${groupName}"`);
          continue;
        }

        const sent = await sendMessage(group.id._serialized, alarm.message, alarm.mediaPath || null);
        if (sent) {
          sentCount++;
          logger.info(`[DailyAlarms] Alarm "${alarm.id}" delivered to "${groupName}"`);
        }
      } catch (err) {
        logger.error(`[DailyAlarms] Error firing alarm "${alarm.id}" to "${groupName}":`, err.message);
      }
    }

    if (sentCount > 0) {
      db.get('dailyAlarms')
        .find({ id: alarm.id })
        .assign({ lastFiredDate: today })
        .write();

      logger.info(`[DailyAlarms] Alarm "${alarm.id}" fired for ${today} (${sentCount} group(s)).`);
      broadcast('log:event', {
        type: 'daily_alarm',
        alarmId: alarm.id,
        time: alarm.time,
        message: `${alarm.message} [Sent to ${sentCount} group(s)]`,
        firedAt: new Date().toISOString(),
      });
      broadcast('config:updated', db.getState());
    }
  }
}

module.exports = { runDailyAlarmsCheck };
