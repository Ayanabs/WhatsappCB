'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Client } = require('whatsapp-web.js');
const { fixture, load, logger } = require('./automation-helpers.cjs');

// Exercise the installed SDK's sendMessage implementation and its browser callback.
// Only the WhatsApp service is replaced; no real chats or saved sessions are used.
async function setup(t, { rejectQuote = false, unconfirmed = false, missingPoster = false, textOnly = false, brokenSeen = false } = {}) {
  const h = fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'countdown-reply-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const poster = path.join(directory, 'poster.png');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  if (!missingPoster) await fs.writeFile(poster, image);
  h.db.set('countdown.enabled', true).set('countdown.mediaPath', textOnly ? null : poster).set('botCommands', {
    enabled: true, prefix: '!', allowedInTargetGroupsOnly: false,
    commands: [{ trigger: 'countdown', enabled: true, action: 'countdown' }],
  }).write();
  const attempts = [];
  const delivered = [];
  let seenCalls = 0;
  const browser = { WWebJS: {
    getChat: async () => ({ id: 'group@g.us' }),
    sendSeen: async () => {
      seenCalls++;
      if (brokenSeen) throw new Error('WhatsApp unread-chat action unavailable');
    },
    sendMessage: async (_chat, content, options) => {
      attempts.push({ content, options });
      if (rejectQuote && options.quotedMessageId) throw new Error('Quoted message is unavailable');
      if (unconfirmed) return undefined;
      delivered.push({ content, options });
      return { id: { _serialized: 'sent-message', id: 'sent-message', fromMe: true } };
    },
    getMessageModel: (message) => message,
  } };
  const client = {
    sendMessage: Client.prototype.sendMessage,
    pupPage: { evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, { window: browser, args }) },
  };
  const plugin = load('plugins/botCommands.js', {
    '../core/db': h.database, '../core/countdown': h.countdown,
    '../core/whatsappClient': h.wa, '../core/logger': logger,
  });
  const run = () => plugin.run({ client, message: {
    from: 'group@g.us', body: '!countdown', id: { _serialized: 'command-message' }, _data: { notifyName: 'Member' },
  } });
  return { ...h, run, image, attempts, delivered, seenCalls: () => seenCalls };
}

test('!countdown delivers the poster and live caption even when marking a chat seen is broken', async (t) => {
  const h = await setup(t, { brokenSeen: true });
  await h.run();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.seenCalls(), 0);
  const { content, options } = h.delivered[0];
  assert.equal(content, '');
  assert.equal(options.media.mimetype, 'image/png');
  assert.equal(options.media.data, h.image.toString('base64'));
  assert.match(options.caption, /^Science Exhibition\nTime remaining: \d+ days/);
  assert.doesNotMatch(options.caption, /\{days\}/);
  assert.equal(options.quotedMessageId, 'command-message');
  assert.ok(h.events.some(([, event]) => event.type === 'bot_command'));
});

test('a failed quoted poster reply retries the same image and caption without the quote', async (t) => {
  const h = await setup(t, { rejectQuote: true });
  await h.run();
  assert.equal(h.attempts.length, 2);
  assert.equal(h.delivered.length, 1);
  const retry = h.delivered[0];
  assert.equal(retry.options.quotedMessageId, undefined);
  assert.equal(retry.options.media.data, h.image.toString('base64'));
  assert.equal(retry.options.caption, h.attempts[0].options.caption);
  assert.equal(retry.content, '');
});

test('an unconfirmed poster reply is not reported as a successful command', async (t) => {
  const h = await setup(t, { unconfirmed: true });
  await h.run();
  assert.equal(h.delivered.length, 0);
  assert.equal(h.events.some(([, event]) => event.type === 'bot_command'), false);
});

test('a missing poster is reported instead of silently sending only text', async (t) => {
  const h = await setup(t, { missingPoster: true });
  await h.run();
  assert.equal(h.delivered.length, 0);
  assert.equal(h.seenCalls(), 0);
  assert.equal(h.events.some(([, event]) => event.type === 'bot_command'), false);
});

test('text-only countdown replies also bypass the unread-chat action', async (t) => {
  const h = await setup(t, { textOnly: true, brokenSeen: true });
  await h.run();
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0].content, /^Science Exhibition\nTime remaining:/);
  assert.equal(h.delivered[0].options.media, undefined);
  assert.equal(h.seenCalls(), 0);
});
