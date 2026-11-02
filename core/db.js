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
const MEDIA_DIRS = [path.join(process.cwd(), 'uploads'), path.join(process.cwd(), 'posters')];

/** Fields of a single countdown */
const COUNTDOWN_DEFAULTS = {
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
};

/** Default database schema — all fields are runtime-configurable via HUD */
const DEFAULT_STATE = {
  // Configured WhatsApp target groups
  targetGroups: [],

  // Legacy single group fallback
  groupTarget: {
    name: '',
  },

  // Countdowns (array of countdown objects, each with an id and COUNTDOWN_DEFAULTS fields)
  countdowns: [],

  // Saved poster library (PNG/media generated from SVG or uploaded)
  savedPosters: [],

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

  // Earlier versions stored a single countdown object and daily alarms.
  const legacy = _db.get('countdown').value();
  if (legacy && !Array.isArray(_db.get('countdowns').value())) {
    _db.set('countdowns', legacy.targetDate ? [{ ...COUNTDOWN_DEFAULTS, ...legacy, id: 'countdown-1' }] : []).write();
  }
  _db.unset('countdown').write();
  _db.unset('dailyAlarms').write();

  // Merge defaults — preserves existing values
  _db.defaultsDeep(DEFAULT_STATE).write();
  repairMediaPaths(_db);

  return _db;
}

/**
 * Point stored media paths at this machine's uploads or posters folder when the
 * saved path no longer exists, for example a Windows path in a config.json that
 * was copied to a Linux server or into a Docker volume.
 * @param {import('lowdb').LowdbSync} db
 */
function repairMediaPaths(db) {
  let changed = false;
  const repair = (item) => {
    if (!item?.mediaPath || fse.existsSync(item.mediaPath)) return;
    // win32.basename understands both / and \ separators.
    const name = path.win32.basename(item.mediaPath);
    const local = MEDIA_DIRS.map((dir) => path.join(dir, name)).find((file) => fse.existsSync(file));
    if (local) {
      item.mediaPath = local;
      changed = true;
    }
  };
  const state = db.getState();
  for (const countdown of state.countdowns || []) {
    repair(countdown);
    Object.values(countdown.dailyContent || {}).forEach(repair);
  }
  (state.scheduledPosts || []).forEach(repair);
  if (changed) db.write();
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

module.exports = { getDb, getTargetGroups, COUNTDOWN_DEFAULTS };
