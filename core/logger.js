'use strict';

/**
 * core/logger.js
 * Thin structured logging wrapper around the built-in console.
 * Produces timestamped, levelled log lines throughout the application.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'];

function _format(level, args) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  return [prefix, ...args];
}

const logger = {
  debug: (...args) => console.debug(..._format('debug', args)),
  info:  (...args) => console.info(..._format('info',  args)),
  warn:  (...args) => console.warn(..._format('warn',  args)),
  error: (...args) => console.error(..._format('error', args)),
};

module.exports = logger;
