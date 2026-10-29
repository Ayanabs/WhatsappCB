'use strict';

/**
 * core/taskWorker.js
 * Background worker loop.
 * Reads configuration dynamically from the DB on every tick — no restarts needed.
 * Coordinates all core feature modules and loaded plugins.
 */

const logger = require('./logger');
const { runCountdownCheck } = require('./countdown');
const { runScheduledPostsCheck } = require('./scheduledPosts');
const { runDailyAlarmsCheck } = require('./dailyAlarms');
const pluginRegistry = require('../plugins');

const DEFAULT_INTERVAL_MS = parseInt(process.env.WORKER_INTERVAL_MS, 10) || 5_000;

let _intervalHandle = null;
let _isRunning = false;

/**
 * Execute one full worker tick — runs all registered task modules.
 */
async function tick() {
  if (_isRunning) {
    logger.debug('[TaskWorker] Tick skipped — previous tick still running.');
    return;
  }
  _isRunning = true;
  logger.debug('[TaskWorker] Tick started.');

  try {
    // Core modules
    for (const [name, run] of [
      ['ScheduledPosts', runScheduledPostsCheck],
      ['Countdown', runCountdownCheck],
      ['DailyAlarms', runDailyAlarmsCheck],
    ]) {
      try {
        await run();
      } catch (err) {
        logger.error(`[TaskWorker] ${name} check failed:`, err.message);
      }
    }

    // Plugin hooks registered as { name, run: async fn }
    const plugins = pluginRegistry.getWorkerPlugins();
    for (const plugin of plugins) {
      try {
        await plugin.run();
      } catch (pluginErr) {
        logger.error(`[TaskWorker] Plugin "${plugin.name}" error:`, pluginErr.message);
      }
    }
  } catch (err) {
    logger.error('[TaskWorker] Unexpected error in tick:', err.message);
  } finally {
    _isRunning = false;
    logger.debug('[TaskWorker] Tick complete.');
  }
}

/**
 * Start the background worker.
 * @param {number} [intervalMs] - Override the tick interval.
 */
function start(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_intervalHandle) {
    logger.warn('[TaskWorker] Already started — ignoring duplicate start call.');
    return;
  }
  logger.info(`[TaskWorker] Starting with interval ${intervalMs}ms.`);
  _intervalHandle = setInterval(tick, intervalMs);

  // Run the first tick immediately without waiting for the first interval
  tick();
}

/**
 * Stop the background worker (clears the interval).
 */
function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info('[TaskWorker] Stopped.');
  }
}

module.exports = { start, stop, tick };
