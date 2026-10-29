'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const low = require('lowdb');
const Memory = require('lowdb/adapters/Memory');

const root = path.resolve(__dirname, '..');
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function load(file, mocks = {}, globals = {}) {
  const filename = path.join(root, file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name),
    process, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    ...globals,
  }, { filename });
  return module.exports;
}

function fixture() {
  const db = low(new Memory()).setState({
    targetGroups: ['Group A'], groupTarget: { name: '' },
    countdown: {
      enabled: false, eventTitle: 'Science Exhibition',
      targetDate: new Date(Date.now() + 2 * 86400000).toISOString(),
      startDate: '', messageTemplate: 'Time remaining: {days} days, {hours} hours and {minutes} minutes.',
      intervalHours: 24,
    },
    scheduledPosts: [], dailyAlarms: [], botCommands: { enabled: false, commands: [] },
  });
  const sends = [];
  const events = [];
  const database = { getDb: () => db, getTargetGroups: () => db.get('targetGroups').value() };
  const wa = {
    isReady: () => true, getLastQr: () => null,
    getGroups: async () => [{ name: 'Group A', id: 'a@g.us', isAdmin: true }],
    findGroupByName: async (name) => ({ id: { _serialized: `${name}@g.us` } }),
    sendMessage: async (...args) => { sends.push(args); return true; },
    broadcast: (...args) => events.push(args),
  };
  const mocks = { './db': database, './whatsappClient': wa, './logger': logger };
  const countdown = load('core/countdown.js', mocks);
  const posts = load('core/scheduledPosts.js', mocks);
  const duePost = (patch = {}) => ({
    id: 'post-1', scheduledAt: new Date(Date.now() - 1000).toISOString(),
    message: 'Exhibition opens today', mediaPath: 'poster.png', sent: false, ...patch,
  });
  return { db, database, wa, sends, events, mocks, countdown, posts, duePost };
}

module.exports = { root, logger, load, fixture };
