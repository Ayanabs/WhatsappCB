'use strict';

/**
 * core/db.js
 * Lightweight local JSON persistence layer using lowdb v1 (synchronous).
 * Provides a single shared database instance for all core modules.
 */

const path = require('path');
const fse = require('fs-extra');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'config.json');

/** Default database schema — all fields are runtime-configurable via HUD */
const DEFAULT_STATE = {
  // Configured WhatsApp target groups
  targetGroups: [],

  // Legacy single group fallback
  groupTarget: {
    name: '',
  },

  // Countdown module
  countdown: {
    enabled: false,
    eventTitle: 'Event Countdown',
    startDate: '',        // ISO string or "YYYY-MM-DDTHH:mm" for starting broadcast cycle anchor
    targetDate: '',       // ISO string or "YYYY-MM-DDTHH:mm" for target deadline
    messageTemplate: 'Only {days} days and {hours} hours left.',
    intervalHours: 24,    // how often to broadcast the countdown (hours)
    dailyTime: '',        // HH:MM in Sri Lanka time
    scheduleFrom: null,   // Ignore slots before this schedule was activated
    dailyContent: {},     // Optional content overrides by Sri Lanka calendar date
    lastSentAt: null,
    mediaPath: null,      // Absolute path to poster file
    mediaUrl: null,       // Web HUD URL to preview poster
    mediaName: null,      // Original filename of poster
  },

  // One-time scheduled posts (array of post objects)
  scheduledPosts: [],
  /* Post schema:
    {
      id: string (uuid-like),
      scheduledAt: string (ISO "YYYY-MM-DD HH:MM"),
      message: string,
      sent: boolean
    }
  */

  // Daily repeating alarms (array)
  dailyAlarms: [],
  /* Alarm schema:
    {
      id: string,
      time: string ("HH:MM"),
      message: string,
      enabled: boolean,
      lastFiredDate: string | null  // "YYYY-MM-DD" of last fire
    }
  */

  // Interactive in-group bot commands
  botCommands: {
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
  },
};

let _db = null;

/**
 * Initialise the database. Creates the data directory and file if missing.
 * Safe to call multiple times (returns cached instance).
 * @returns {import('lowdb').LowdbSync}
 */
function getDb() {
  if (_db) return _db;

  fse.ensureDirSync(DATA_DIR);

  const adapter = new FileSync(DB_FILE);
  _db = low(adapter);

  // Merge defaults — preserves existing values
  _db.defaultsDeep(DEFAULT_STATE).write();

  return _db;
}

/**
 * Retrieve the active target group names.
 * Consolidates 'targetGroups' array and legacy 'groupTarget.name'.
 * @returns {string[]}
 */
function getTargetGroups() {
  const db = getDb();
  const list = db.get('targetGroups').value();
  const legacy = db.get('groupTarget.name').value();

  const results = new Set();
  if (Array.isArray(list)) {
    list.forEach((g) => {
      const trimmed = String(g || '').trim();
      if (trimmed) results.add(trimmed);
    });
  }
  if (legacy && String(legacy).trim()) {
    results.add(String(legacy).trim());
  }

  return Array.from(results);
}

module.exports = { getDb, getTargetGroups };
