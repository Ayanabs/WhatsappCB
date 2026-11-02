'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { load, logger, fixture } = require('./automation-helpers.cjs');

test('daily countdown follows the Sri Lanka publish time and does not catch up a slot before activation', async () => {
  const h = fixture();
  let now = Date.parse('2026-10-29T01:19:00Z'); // 06:49 in Sri Lanka
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  h.db.set('countdowns[0]', { id: 'cd-1', enabled: true, eventTitle: 'Event', targetDate: '2026-10-31T00:00:00Z',
    startDate: '2026-10-28T00:00:00Z', dailyTime: '06:50', scheduleFrom: '2026-10-29T01:19:00Z', mediaPath: 'poster.png' }).write();
  const countdown = load('core/countdown.js', h.mocks, { Date: FakeDate });
  await countdown.runCountdownCheck();
  assert.equal(h.sends.length, 0);
  now = Date.parse('2026-10-29T01:20:00Z');
  await countdown.runCountdownCheck();
  await countdown.runCountdownCheck();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0][2], 'poster.png');
  now = Date.parse('2026-10-30T01:19:00Z');
  await countdown.runCountdownCheck();
  assert.equal(h.sends.length, 1);
  now = Date.parse('2026-10-30T01:20:00Z');
  await countdown.runCountdownCheck();
  assert.equal(h.sends.length, 2);
  h.db.set('countdowns[0].lastSentAt', null).set('countdowns[0].scheduleFrom', '2026-10-30T02:00:00Z').write();
  now = Date.parse('2026-10-30T02:01:00Z');
  await countdown.runCountdownCheck();
  assert.equal(h.sends.length, 2);
});

test('countdown selects optional content by Sri Lanka calendar date', async () => {
  const h = fixture();
  let now = Date.parse('2026-10-29T19:00:00Z'); // 30 October in Sri Lanka
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  h.db.set('countdowns[0]', { id: 'cd-1', enabled: true, eventTitle: 'Main title', messageTemplate: 'Main {days}',
    targetDate: '2026-11-02T00:00:00Z', startDate: '2026-10-28T00:00:00Z', dailyTime: '00:30',
    mediaPath: 'default.png', dailyContent: { '2026-10-30': { eventTitle: 'Special', messageTemplate: 'Only {days} left', mediaPath: 'special.png' },
      '2026-10-31': { eventTitle: 'Tomorrow' } } }).write();
  const countdown = load('core/countdown.js', h.mocks, { Date: FakeDate });
  await countdown.runCountdownCheck();
  assert.match(h.sends[0][1], /^Special\nOnly \d+ left$/);
  assert.equal(h.sends[0][2], 'special.png');
  now = Date.parse('2026-10-30T19:00:00Z');
  await countdown.runCountdownCheck();
  assert.match(h.sends[1][1], /^Tomorrow\nMain \d+$/);
  assert.equal(h.sends[1][2], 'default.png');
});

test('countdown sends the event title and poster together', async () => {
  const h = fixture();
  h.db.set('countdowns[0].mediaPath', 'poster.png').write();
  const result = await h.countdown.runCountdownCheck({ force: true });
  assert.equal(result.sentCount, 1);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0][1], /^Science Exhibition\nTime remaining:/);
  assert.doesNotMatch(h.sends[0][1], /\[COUNTDOWN|\{days\}/);
  assert.equal(h.sends[0][2], 'poster.png');
});

test('overlapping countdown requests do not duplicate broadcasts', async () => {
  const h = fixture();
  await Promise.all([h.countdown.runCountdownCheck({ force: true }), h.countdown.runCountdownCheck({ force: true })]);
  assert.equal(h.sends.length, 1);
});

test('the countdown command uses the event title without status labels', async () => {
  const h = fixture();
  h.db.set('countdowns[0].enabled', true).set('botCommands', {
    enabled: true, prefix: '!', allowedInTargetGroupsOnly: false,
    commands: [{ trigger: 'countdown', enabled: true, action: 'countdown' }],
  }).write();
  const replies = [];
  const plugin = load('plugins/botCommands.js', {
    '../core/db': h.database, '../core/countdown': h.countdown,
    '../core/whatsappClient': h.wa, '../core/logger': logger,
  });
  await plugin.run({
    message: { from: 'group@g.us', body: '!countdown', id: { _serialized: 'command' }, _data: { notifyName: 'Member' } },
    client: { sendMessage: async (...args) => { replies.push(args); return { id: { _serialized: 'reply' } }; } },
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0][1], /^Science Exhibition\nTime remaining:/);
  assert.doesNotMatch(replies[0][1], /\[COUNTDOWN|\[TARGET DATE\]/);
});

test('several countdowns for the same groups each send at their own daily time', async () => {
  const h = fixture();
  let now = Date.parse('2026-10-29T03:30:00Z'); // 09:00 in Sri Lanka
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const base = { enabled: true, startDate: '2026-10-28T00:00:00Z', targetDate: '2026-11-05T00:00:00Z',
    scheduleFrom: '2026-10-28T00:00:00Z', messageTemplate: '{days} days' };
  h.db.set('countdowns', [
    { ...base, id: 'morning', eventTitle: 'Exhibition', dailyTime: '09:00', mediaPath: 'exhibition.png' },
    { ...base, id: 'evening', eventTitle: 'Symposium', dailyTime: '18:00', mediaPath: 'symposium.png' },
    { ...base, id: 'paused', eventTitle: 'Paused', dailyTime: '09:00', enabled: false },
  ]).write();
  const countdown = load('core/countdown.js', h.mocks, { Date: FakeDate });
  await countdown.runCountdownCheck();
  await countdown.runCountdownCheck();
  assert.deepEqual(h.sends.map((send) => send[2]), ['exhibition.png']);
  now = Date.parse('2026-10-29T12:30:00Z'); // 18:00 in Sri Lanka
  await countdown.runCountdownCheck();
  assert.deepEqual(h.sends.map((send) => send[2]), ['exhibition.png', 'symposium.png']);
  assert.match(h.sends[1][1], /^Symposium\n/);
  assert.ok(h.db.get('countdowns').find({ id: 'evening' }).value().lastSentAt);
  assert.equal(h.db.get('countdowns').find({ id: 'paused' }).value().lastSentAt, undefined);
});

test('an immediate broadcast sends only the requested countdown', async () => {
  const h = fixture();
  h.db.get('countdowns').push({ ...h.db.get('countdowns[0]').value(), id: 'cd-2', eventTitle: 'Second event' }).write();
  const result = await h.countdown.runCountdownCheck({ force: true, id: 'cd-2' });
  assert.equal(result.sentCount, 1);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0][1], /^Second event\n/);
  assert.equal((await h.countdown.runCountdownCheck({ force: true, id: 'missing' })).error, 'Countdown not found');
});

test('the countdown command replies once for every active countdown', async () => {
  const h = fixture();
  h.db.set('countdowns[0].enabled', true)
    .set('botCommands', { enabled: true, prefix: '!', allowedInTargetGroupsOnly: false,
      commands: [{ trigger: 'countdown', enabled: true, action: 'countdown' }] }).write();
  h.db.get('countdowns').push({ ...h.db.get('countdowns[0]').value(), id: 'cd-2', eventTitle: 'Sooner event',
    targetDate: new Date(Date.now() + 86400000).toISOString() }).write();
  h.db.get('countdowns').push({ ...h.db.get('countdowns[0]').value(), id: 'cd-3', eventTitle: 'Paused event', enabled: false }).write();
  const replies = [];
  const plugin = load('plugins/botCommands.js', {
    '../core/db': h.database, '../core/countdown': h.countdown,
    '../core/whatsappClient': h.wa, '../core/logger': logger,
  });
  await plugin.run({
    message: { from: 'group@g.us', body: '!countdown', id: { _serialized: 'command' }, _data: { notifyName: 'Member' } },
    client: { sendMessage: async (...args) => { replies.push(args); return { id: { _serialized: 'reply' } }; } },
  });
  assert.deepEqual(replies.map((reply) => reply[1].split('\n')[0]), ['Sooner event', 'Science Exhibition']);
});

test('a saved single countdown and daily alarms are migrated on startup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'countdown-migrate-'));
  try {
    await fs.mkdir(path.join(directory, 'data'));
    await fs.mkdir(path.join(directory, 'uploads'));
    await fs.writeFile(path.join(directory, 'uploads', 'poster.png'), 'png');
    await fs.writeFile(path.join(directory, 'data', 'config.json'), JSON.stringify({
      targetGroups: ['Group A'],
      countdown: { enabled: true, eventTitle: 'Legacy event', targetDate: '2026-12-01T00:00:00Z', dailyTime: '08:00',
        mediaPath: 'D:\\Work\\WhatsappCountdownBot\\uploads\\poster.png' },
      scheduledPosts: [{ id: 'post-1', mediaPath: 'D:\\Old\\uploads\\missing.png' }],
      dailyAlarms: [{ id: 'alarm-1', time: '09:00', message: 'Reminder', enabled: true }],
    }));
    const db = load('core/db.js', {}, { process: { ...process, cwd: () => directory } }).getDb();
    const state = db.getState();
    assert.equal(state.countdown, undefined);
    assert.equal(state.dailyAlarms, undefined);
    assert.equal(state.countdowns.length, 1);
    assert.equal(state.countdowns[0].id, 'countdown-1');
    assert.equal(state.countdowns[0].eventTitle, 'Legacy event');
    assert.equal(state.countdowns[0].dailyTime, '08:00');
    assert.equal(Object.keys(state.countdowns[0].dailyContent).length, 0);
    // A Windows poster path copied to another machine points at the local uploads folder.
    assert.equal(state.countdowns[0].mediaPath, path.join(directory, 'uploads', 'poster.png'));
    assert.equal(state.scheduledPosts[0].mediaPath, 'D:\\Old\\uploads\\missing.png');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('due scheduled posts include their attachment and send only once', async () => {
  const h = fixture();
  h.db.get('scheduledPosts').push(h.duePost()).write();
  await h.posts.runScheduledPostsCheck();
  await h.posts.runScheduledPostsCheck();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0][2], 'poster.png');
  assert.equal(h.db.get('scheduledPosts[0].sent').value(), true);
});

test('future and already-sent posts are preserved', async () => {
  const h = fixture();
  h.db.set('scheduledPosts', [h.duePost({ sent: true }), h.duePost({ id: 'future', scheduledAt: new Date(Date.now() + 86400000).toISOString() })]).write();
  await h.posts.runScheduledPostsCheck();
  assert.equal(h.sends.length, 0);
});

test('failed groups retry without duplicating successful group deliveries', async () => {
  const h = fixture();
  h.db.set('targetGroups', ['Group A', 'Group B']).write();
  h.db.get('scheduledPosts').push(h.duePost()).write();
  h.wa.sendMessage = async (id) => { h.sends.push(id); if (id.startsWith('Group B')) throw new Error('Upload failed'); return true; };
  // Modules capture the function at load time, so load with the configured transport.
  const posts = load('core/scheduledPosts.js', h.mocks);
  await posts.runScheduledPostsCheck();
  assert.equal(h.db.get('scheduledPosts[0].sent').value(), false);
  assert.match(h.db.get('scheduledPosts[0].lastError').value(), /Upload failed/);
  h.wa.sendMessage = async (id) => { h.sends.push(id); return true; };
  const retry = load('core/scheduledPosts.js', h.mocks);
  await retry.runScheduledPostsCheck();
  assert.deepEqual(h.sends, ['Group A@g.us', 'Group B@g.us', 'Group B@g.us']);
  assert.equal(h.db.get('scheduledPosts[0].sent').value(), true);
  assert.equal(h.db.get('scheduledPosts[0].lastError').value(), null);
});

test('overlapping schedule checks send each post once', async () => {
  const h = fixture();
  h.db.get('scheduledPosts').push(h.duePost()).write();
  await Promise.all([h.posts.runScheduledPostsCheck(), h.posts.runScheduledPostsCheck()]);
  assert.equal(h.sends.length, 1);
});

test('offline scheduled posts remain queued until WhatsApp reconnects', async () => {
  const h = fixture();
  let ready = false;
  h.wa.isReady = () => ready;
  const posts = load('core/scheduledPosts.js', h.mocks);
  h.db.get('scheduledPosts').push(h.duePost()).write();
  await posts.runScheduledPostsCheck();
  assert.equal(h.sends.length, 0);
  ready = true;
  await posts.runScheduledPostsCheck();
  assert.equal(h.sends.length, 1);
});

test('worker keeps running other tasks when a module fails', async () => {
  const calls = [];
  const worker = load('core/taskWorker.js', {
    './logger': logger,
    './countdown': { runCountdownCheck: async () => { calls.push('countdown'); throw new Error('Bad countdown'); } },
    './scheduledPosts': { runScheduledPostsCheck: async () => { calls.push('posts'); } },
    '../plugins': { getWorkerPlugins: () => [{ name: 'sample', run: async () => calls.push('plugin') }] },
  });
  await worker.tick();
  assert.deepEqual(calls, ['posts', 'countdown', 'plugin']);
});

test('a detached WhatsApp Web page restarts the client with the saved session', async () => {
  const created = [];
  class Client extends EventEmitter {
    constructor() {
      super();
      created.push(this);
      this.info = { wid: { user: 'bot' } };
      this.pupPage = { evaluate: async () => { throw new Error("Attempted to use detached Frame 'ABC'."); } };
    }
    async initialize() { this.initialized = true; }
    async destroy() { this.destroyed = true; }
  }
  const wa = load('core/whatsappClient.js', {
    './logger': logger,
    'whatsapp-web.js': { Client, LocalAuth: class {}, MessageMedia: {} },
  }, { process: { ...process, platform: 'test' } });
  wa.getClient();
  assert.equal(wa.isReady(), true);
  assert.equal(await wa.findGroupByName('Group A'), null);
  assert.equal(wa.isReady(), false);
  for (let i = 0; i < 50 && !created[1]?.initialized; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(created.length, 2);
  assert.equal(created[0].destroyed, true);
  assert.equal(created[1].initialized, true);
  assert.equal(wa.isReady(), true);
});

test('transport sends a single image with caption and rejects unconfirmed sends', async () => {
  const sent = [];
  let confirmed = true;
  class Client extends EventEmitter {
    info = { wid: { user: 'bot' } };
    async sendMessage(...args) { sent.push(args); return confirmed ? { id: { _serialized: 'sent' } } : undefined; }
  }
  const media = { mimetype: 'image/png', data: 'base64' };
  const wa = load('core/whatsappClient.js', {
    './logger': logger,
    'whatsapp-web.js': { Client, LocalAuth: class {}, MessageMedia: { fromFilePath: () => media } },
  });
  wa.getClient();
  assert.equal(await wa.sendMessage('group@g.us', 'Exhibition\n2 days remaining', 'poster.png'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], media);
  assert.equal(sent[0][2].caption, 'Exhibition\n2 days remaining');
  assert.equal(sent[0][2].sendSeen, false);
  confirmed = false;
  assert.equal(await wa.sendMessage('group@g.us', 'Text'), false);
  await assert.rejects(wa.sendMessage('group@g.us', 'Text', null, { throwOnError: true }), /did not confirm/);
});
