'use strict';

/**
 * core/logger.js
 * Thin structured logging wrapper around the built-in console.
 * Produces timestamped, levelled log lines throughout the application.
 * Info, warning and error lines are also appended to logs/bot.log so failed
 * deliveries can be investigated after the fact.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const LOG_FILE = path.join(process.cwd(), 'logs', 'bot.log');

let _file = null;
function fileStream() {
  if (_file === null) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      _file = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      _file.on('error', () => { _file = false; });
    } catch {
      _file = false;
    }
  }
  return _file;
}

function _format(level, args) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  return [prefix, ...args];
}

function write(level, args) {
  const line = _format(level, args);
  console[level](...line);
  const stream = level === 'debug' ? null : fileStream();
  if (stream) stream.write(`${util.format(...line)}\n`);
}

const logger = {
  debug: (...args) => write('debug', args),
  info:  (...args) => write('info',  args),
  warn:  (...args) => write('warn',  args),
  error: (...args) => write('error', args),
};

module.exports = logger;
