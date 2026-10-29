'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../plugins/botCommands.js'), 'utf8');

// Execute the actual browser callback against WhatsApp module doubles, rather
// than mocking evaluate's result, so API arguments and native IDs are checked.
function setup(options = {}) {
  const chatId = '123@g.us';
  const serializedId = `false_${chatId}_ABC_456@lid`;
  const nativeId = Object.freeze({ remote: { _serialized: chatId }, fromMe: false, $1: serializedId });
  const nativeMessage = { id: nativeId };
  const warningMessage = { id: Object.freeze({ remote: nativeId.remote, fromMe: true, $1: 'true_123@g.us_WARNING' }) };
  const chat = {
    name: 'Test Group',
    groupMetadata: { participants: [{ id: { _serialized: '456@lid' }, isAdmin: !!options.senderAdmin }] },
  };
  const revoked = [];
  const sent = [];
  const events = [];
  const warnings = [];
  const timers = [];
  const cfg = {
    enabled: true, prefix: '!', allowedInTargetGroupsOnly: true,
    strictCommandMode: true, strictIgnoreAdmins: false, warnSender: false,
    warningAutoDeleteSeconds: 10, warningTemplate: 'Only {prefix} commands, {name}.',
    commands: [{ trigger: 'help', enabled: true, action: 'help' }],
    ...options.cfg,
  };
  const db = {
    has: () => ({ value: () => true }),
    get: (key) => ({ value: () => key === 'botCommands' ? cfg : {} }),
  };
  const modules = {
    WAWebCollections: {
      Msg: {
        get: (id) => id === warningMessage.id.$1 ? warningMessage : options.missingMessage || options.loadMessage ? undefined : nativeMessage,
        getMessagesById: async () => ({ messages: options.missingMessage ? [] : [nativeMessage] }),
      },
      Chat: {
        get: () => options.missingChat || options.loadChat ? undefined : chat,
        find: async () => options.missingChat ? undefined : chat,
      },
    },
    WAWebMsgActionCapability: {
      canSenderRevokeMsg: () => true,
      canAdminRevokeMsg: (msg) => {
        assert.equal(msg.id.fromMe, false, 'Own warnings must use sender revocation');
        return !options.noPermission;
      },
    },
    WAWebCmd: { Cmd: {
      sendRevokeMsgs: async (...args) => {
        if (options.revokeError) throw new Error('Revocation rejected');
        revoked.push(args);
      },
      sendDeleteMsgs: () => assert.fail('Must never delete only the local copy'),
    } },
  };
  const browser = {
    require: (name) => {
      assert.ok(modules[name], `Unexpected internal module: ${name}`);
      return modules[name];
    },
    WWebJS: { compareWwebVersions: () => !options.legacy },
    Debug: { VERSION: options.legacy ? '2.2999.1' : '2.3000.1' },
  };
  const client = {
    pupPage: { evaluate: async (fn, argument) => vm.runInNewContext(`(${fn.toString()})(argument)`, { window: browser, argument }) },
    sendMessage: async (...args) => {
      sent.push(args);
      return { id: { _serialized: 'true_123@g.us_WARNING' }, delete: () => assert.fail('Unsafe library fallback') };
    },
  };
  if (options.noPage) delete client.pupPage;
  const dependencies = {
    path, 'fs-extra': {}, 'whatsapp-web.js': {},
    '../core/db': { getDb: () => db, getTargetGroups: () => options.targetGroups || ['Test Group'] },
    '../core/countdown': {},
    '../core/whatsappClient': {
      broadcast: (...args) => events.push(args),
      findGroupByName: async (name) => name === 'Test Group' ? { id: { _serialized: chatId } } : null,
    },
    '../core/logger': { info() {}, debug() {}, warn: (...args) => warnings.push(args.join(' ')), error: (...args) => warnings.push(args.join(' ')) },
  };
  const sandbox = {
    module: { exports: {} },
    require: (name) => {
      assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    setTimeout: (callback) => timers.push(callback),
  };
  vm.runInNewContext(source, sandbox, { filename: 'botCommands.js' });
  const message = {
    id: { _serialized: serializedId }, from: chatId, author: '456@lid',
    body: 'ordinary chatter', _data: { notifyName: 'Member' },
    ...options.message,
  };
  return { run: () => sandbox.module.exports.run({ message, client }), revoked, sent, events, warnings, timers, nativeId, nativeMessage, chat };
}

test('non-command group messages are revoked for everyone without changing native IDs', async () => {
  const h = setup();
  await h.run();
  assert.equal(h.revoked.length, 1);
  const [chat, selection, options] = h.revoked[0];
  assert.equal(chat, h.chat);
  assert.equal(selection.list[0], h.nativeMessage);
  assert.equal(selection.type, 'message');
  assert.equal(options.clearMedia, true);
  assert.equal(h.nativeId.$1, 'false_123@g.us_ABC_456@lid');
  assert.ok(h.events.some(([, event]) => event.message.startsWith('Strict Mode: Deleted')));
});

test('valid commands get a reply and are preserved, including during cooldown', async () => {
  const h = setup({ message: { body: '!help' } });
  await h.run();
  await h.run();
  assert.equal(h.revoked.length, 0);
  assert.equal(h.sent.length, 1);
});

for (const message of [{ body: '!unknown' }, { body: '' }, { body: '', hasMedia: true }, { body: '!help', fromMe: true }]) {
  test(`moderation handles ${JSON.stringify(message)}`, async () => {
    const h = setup({ message });
    await h.run();
    assert.equal(h.revoked.length, message.fromMe ? 0 : 1);
  });
}

for (const options of [
  { message: { from: '456@c.us' } },
  { message: { fromMe: true } },
  { cfg: { strictCommandMode: false } },
  { cfg: { enabled: false } },
  { targetGroups: ['Other Group'] },
  { senderAdmin: true, cfg: { strictIgnoreAdmins: true } },
]) {
  test(`preserves messages outside moderation: ${JSON.stringify(options)}`, async () => {
    const h = setup(options);
    await h.run();
    assert.equal(h.revoked.length, 0);
  });
}

test('admins are moderated when the exemption is disabled', async () => {
  const h = setup({ senderAdmin: true });
  await h.run();
  assert.equal(h.revoked.length, 1);
});

for (const failure of ['noPermission', 'missingMessage', 'missingChat', 'revokeError', 'noPage']) {
  test(`${failure} reports failure without claiming deletion or sending a warning`, async () => {
    const h = setup({ [failure]: true, cfg: { warnSender: true } });
    await h.run();
    assert.equal(h.revoked.length, 0);
    assert.equal(h.sent.length, 0);
    assert.ok(h.warnings.some((line) => line.includes('Could not delete message')));
    assert.ok(!h.events.some(([, event]) => event.message.startsWith('Strict Mode: Deleted')));
  });
}

test('loads uncached messages and chats before revoking', async () => {
  const h = setup({ loadMessage: true, loadChat: true });
  await h.run();
  assert.equal(h.revoked.length, 1);
});

test('uses the legacy revocation arguments for older WhatsApp Web versions', async () => {
  const h = setup({ legacy: true });
  await h.run();
  assert.equal(h.revoked.length, 1);
  assert.ok(Array.isArray(h.revoked[0][1]));
  assert.equal(h.revoked[0][2].type, 'Admin');
});

test('accepts the alternate serialized ID field', async () => {
  const h = setup({ message: { id: { $1: 'false_123@g.us_ABC_456@lid' } } });
  await h.run();
  assert.equal(h.revoked.length, 1);
});

test('warning auto-deletion uses the same revocation path', async () => {
  const h = setup({ cfg: { warnSender: true } });
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.length, 1);
  await h.timers[0]();
  assert.equal(h.revoked.length, 2);
});
