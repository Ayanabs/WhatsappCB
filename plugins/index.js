'use strict';

/**
 * plugins/index.js
 * Plugin registry and loader.
 *
 * HOW TO ADD A NEW PLUGIN:
 * 1. Create a new file in this /plugins directory (e.g., myPlugin.js).
 * 2. Export an object with the following shape:
 *
 *    module.exports = {
 *      name: 'myPlugin',           // unique identifier
 *      type: 'worker' | 'message', // 'worker' hooks into the task loop;
 *                                  // 'message' hooks into incoming WA messages
 *      run: async (context) => {}, // worker plugins receive no arg;
 *                                  // message plugins receive { message, client }
 *    };
 *
 * 3. Register it below in PLUGIN_FILES.
 *
 * No server restart is required — plugins are loaded once at startup.
 */

const path = require('path');
const logger = require('../core/logger');

/** Add the filename of each plugin you want to activate. */
const PLUGIN_FILES = [
  'autoReply.js',
  'welcomeMessage.js',
  'botCommands.js',
];

const _workerPlugins  = [];
const _messagePlugins = [];

/**
 * Load all plugins listed in PLUGIN_FILES.
 * Called once during server startup.
 */
function loadPlugins() {
  for (const file of PLUGIN_FILES) {
    const fullPath = path.join(__dirname, file);
    try {
      const plugin = require(fullPath);

      if (typeof plugin.run !== 'function') {
        logger.warn(`[Plugins] "${file}" has no run() function — skipping.`);
        continue;
      }

      if (plugin.type === 'worker') {
        _workerPlugins.push(plugin);
        logger.info(`[Plugins] Loaded worker plugin: ${plugin.name}`);
      } else if (plugin.type === 'message') {
        _messagePlugins.push(plugin);
        logger.info(`[Plugins] Loaded message plugin: ${plugin.name}`);
      } else {
        logger.warn(`[Plugins] "${file}" has unknown type "${plugin.type}" — skipping.`);
      }
    } catch (err) {
      logger.error(`[Plugins] Failed to load "${file}":`, err.message);
    }
  }
}

/** @returns {Array} All registered worker-tick plugins. */
function getWorkerPlugins() {
  return _workerPlugins;
}

/** @returns {Array} All registered incoming-message plugins. */
function getMessagePlugins() {
  return _messagePlugins;
}

module.exports = { loadPlugins, getWorkerPlugins, getMessagePlugins };
