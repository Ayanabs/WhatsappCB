'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const { root, logger, load, fixture } = require('./automation-helpers.cjs');

test('countdown preview, immediate image broadcast and scheduled image delivery', { timeout: 60000 }, async (t) => {
  const h = fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'countdown-ui-'));
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const events = [];
  h.wa.broadcast = (...args) => { events.push(args); io.emit(...args); };
  // Reload the engines so they share the test Socket.IO broadcaster.
  const mocks = { ...h.mocks, './whatsappClient': h.wa };
  const countdown = load('core/countdown.js', mocks);
  const posts = load('core/scheduledPosts.js', mocks);
  const approval = load('core/approvalAuth.js', {}, { Buffer, process: { ...process, cwd: () => directory } });
  const api = load('routes/api.js', {
    '../core/db': h.database, '../core/whatsappClient': { ...h.wa, isReady: () => h.wa.isReady() },
    '../core/countdown': countdown,
    '../core/taskWorker': { tick: () => posts.runScheduledPostsCheck() },
    '../core/logger': logger,
    '../core/approvalAuth': approval,
  }, { process: { ...process, cwd: () => directory } });
  process.env.DASHBOARD_USERNAME = 'test-user';
  process.env.DASHBOARD_PASSWORD = 'test-password';
  const loginAuth = require('../core/loginAuth');
  app.use(express.json());
  app.post('/api/auth/login', loginAuth.login);
  app.get('/api/auth/session', loginAuth.middleware, loginAuth.session);
  app.use('/api', approval.middleware, api);
  app.get('/config.js', (_req, res) => res.type('js').send('window.WABOT_API = "";'));
  app.use('/uploads', express.static(path.join(directory, 'uploads')));
  app.use(express.static(path.join(root, 'public')));
  io.use(loginAuth.socketMiddleware);
  io.on('connection', (socket) => socket.emit('config:updated', h.db.getState()));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise((resolve) => io.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  await t.test('dashboard sign-in accepts only the configured credentials', async () => {
    const login = (body) => fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await login({ username: 'test-user', password: 'wrong' })).status, 401);
    const response = await login({ username: 'test-user', password: 'test-password' });
    assert.equal(response.status, 200);
    const { token } = await response.json();
    assert.equal((await fetch(`${origin}/api/auth/session`)).status, 401);
    const renewed = await fetch(`${origin}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(renewed.status, 200);
    assert.ok(loginAuth.verifyToken((await renewed.json()).token));
    const idleToken = loginAuth.issueToken(Date.now() - loginAuth.IDLE_TIMEOUT_MS - 1000);
    assert.equal((await fetch(`${origin}/api/auth/session`, { headers: { Authorization: `Bearer ${idleToken}` } })).status, 401);
  });

  await t.test('API rejects invalid scheduled dates instead of queuing unusable posts', async () => {
    const result = await fetch(`${origin}/api/posts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: 'invalid', message: 'Hello' }),
    });
    assert.equal(result.status, 400);
    assert.equal(h.db.get('scheduledPosts').size().value(), 0);
  });

  await t.test('authenticator enrollment rejects remote origins and disconnected WhatsApp', async () => {
    let response = await fetch(`${origin}/api/approval/setup`, { method: 'POST', headers: { Origin: 'https://example.com' } });
    assert.equal(response.status, 403);
    const originalReady = h.wa.isReady;
    h.wa.isReady = () => false;
    try {
      response = await fetch(`${origin}/api/approval/setup`, { method: 'POST' });
      assert.equal(response.status, 400);
    } finally { h.wa.isReady = originalReady; }
  });

  await t.test('daily countdown content is stored per date and can fall back to defaults', async () => {
    h.db.set('countdowns[0].startDate', '2026-10-28T01:00:00Z').set('countdowns[0].targetDate', '2026-10-31T01:00:00Z').write();
    const form = new FormData();
    form.append('eventTitle', 'Day two');
    form.append('messageTemplate', 'Only {days} days');
    form.append('media', new Blob(['image'], { type: 'image/png' }), 'day.png');
    let response = await fetch(`${origin}/api/countdowns/cd-1/days/2026-10-29`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    const entry = h.db.get('countdowns[0].dailyContent.2026-10-29').value();
    assert.equal(entry.eventTitle, 'Day two');
    assert.equal(entry.mediaName, 'day.png');
    response = await fetch(`${origin}/api/countdowns/cd-1/days/2026-11-01`, { method: 'POST', body: new FormData() });
    assert.equal(response.status, 400);
    const clear = new FormData();
    clear.append('clearMedia', 'true');
    response = await fetch(`${origin}/api/countdowns/cd-1/days/2026-10-29`, { method: 'POST', body: clear });
    assert.equal(response.status, 200);
    assert.equal(h.db.get('countdowns[0].dailyContent.2026-10-29').value(), undefined);
    h.db.set('countdowns[0].startDate', '').set('countdowns[0].targetDate', new Date(Date.now() + 2 * 86400000).toISOString()).write();
  });

  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.emulateTimezone('Asia/Colombo');
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-form');
  await page.type('#login-username', 'test-user');
  await page.type('#login-password', 'test-password');
  await page.click('#login-submit');
  await page.waitForSelector('.group-tile-card');
  const verificationDir = path.join(root, 'scratch/verification');
  await fs.mkdir(verificationDir, { recursive: true });

  await t.test('overview shows saved data and navigation opens the matching service', async () => {
    assert.equal(await page.$eval('#metric-groups', (el) => el.textContent), '1');
    assert.equal(await page.$eval('#metric-posts', (el) => el.textContent), '0');
    assert.equal(await page.$eval('#overview-event-title', (el) => el.textContent), 'Science Exhibition');
    assert.equal(await page.$eval('#overview-countdown-status', (el) => el.textContent), 'Paused');
    await page.screenshot({ path: path.join(verificationDir, 'dashboard-desktop.png'), fullPage: true });
    await page.click('.sidebar__nav [data-nav-service="countdown"]');
    assert.equal(await page.$eval('#service-tab-countdown', (el) => el.getAttribute('aria-selected')), 'true');
    assert.equal(await page.$eval('#breadcrumb-current', (el) => el.textContent), 'Countdown');
    // Sidebar tabs show only the chosen service.
    for (const hidden of ['.service-cards-row-wrapper', '#group-workspace-view > .card__header', '#activity-section', '#service-view-posts']) {
      assert.equal(await page.$eval(hidden, (el) => getComputedStyle(el).display), 'none', `${hidden} is visible`);
    }
    await page.click('.sidebar__nav [data-overview]');
    await page.click('.group-tile-card');
    assert.notEqual(await page.$eval('.service-cards-row-wrapper', (el) => getComputedStyle(el).display), 'none');
    await page.click('[data-service="countdown"]');
    await page.focus('#service-tab-countdown');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.$eval('#service-tab-posts', (el) => el.getAttribute('aria-selected')), 'true');
    assert.equal(await page.$eval('#service-view-posts', (el) => el.classList.contains('is-active')), true);
    await page.click('.sidebar__nav [data-overview]');
    assert.equal(await page.$eval('body', (el) => el.classList.contains('workspace-open')), false);
  });

  await page.click('.group-tile-card');
  await page.click('[data-service="countdown"]');

  const filename = path.join(directory, 'event-poster.png');
  // A real PNG generated by Chromium keeps this test independent of user uploads.
  const imagePage = await browser.newPage();
  await imagePage.setViewport({ width: 480, height: 240 });
  await imagePage.setContent('<body style="margin:0;background:#163e63;color:white;font:28px sans-serif;display:grid;place-content:center;height:100vh">SCIENCE EXHIBITION</body>');
  await imagePage.screenshot({ path: filename });
  await imagePage.close();

  await t.test('the day editor saves and reloads a title, message and image', async () => {
    const start = new Date(Date.now() - 86400000).toISOString();
    const end = new Date(Date.now() + 2 * 86400000).toISOString();
    h.db.set('countdowns[0].startDate', start).set('countdowns[0].targetDate', end).write();
    await page.waitForFunction(() => socket.connected);
    io.emit('config:updated', h.db.getState());
    await page.waitForFunction((iso) => document.querySelector('#countdown-day-date').min === new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10), {}, start);
    const selectedDay = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    // Every day from start to target has a card; the editor opens from a card.
    await page.waitForFunction(() => document.querySelectorAll('#countdown-day-cards .day-card').length === 4);
    assert.equal(await page.$eval('#countdown-day-editor', (el) => el.classList.contains('hidden')), true);
    assert.match(await page.$eval(`.day-card[data-day="${selectedDay}"]`, (el) => el.textContent), /Today[\s\S]*Science Exhibition[\s\S]*Time remaining: \d+ days/);
    await page.click(`.day-card[data-day="${selectedDay}"]`);
    assert.equal(await page.$eval('#countdown-day-editor', (el) => el.classList.contains('hidden')), false);
    assert.equal(await page.$eval('#countdown-day-date', (el) => el.value), selectedDay);
    // A day without its own content opens on "Use main content" with its fields hidden.
    assert.equal(await page.$eval('input[name="countdown-day-mode"][value="main"]', (el) => el.checked), true);
    assert.equal(await page.$eval('#countdown-day-fields', (el) => el.classList.contains('hidden')), true);
    assert.match(await page.$eval('#countdown-preview-source', (el) => el.textContent), /Today[\s\S]*Main content/);
    await page.click('input[name="countdown-day-mode"][value="custom"] + span');
    assert.equal(await page.$eval('#countdown-day-fields', (el) => el.classList.contains('hidden')), false);
    await page.type('#countdown-day-title', 'Daily title');
    await page.type('#countdown-day-message', 'Daily {days}');
    await (await page.$('#countdown-day-media')).uploadFile(filename);
    const response = page.waitForResponse((res) => res.url().includes('/api/countdowns/cd-1/days/') && res.request().method() === 'POST');
    await page.click('#countdown-day-save');
    assert.equal((await response).status(), 200);
    await page.waitForFunction((day) => document.querySelector(`.day-card[data-day="${day}"]`)?.classList.contains('day-card--custom'), {}, selectedDay);
    assert.match(await page.$eval(`.day-card[data-day="${selectedDay}"]`, (el) => el.textContent), /Custom[\s\S]*Daily title[\s\S]*Daily \d+/);
    assert.equal(await page.$eval(`.day-card[data-day="${selectedDay}"] img`, (el) => el.getAttribute('src').includes('event-poster.png')), true);
    assert.match(await page.$eval('#countdown-day-summary', (el) => el.textContent), /4 days · 1 customised/);
    // The preview shows today's final message: the day's title, message and poster.
    assert.match(await page.$eval('#countdown-preview-text', (el) => el.textContent), /^Daily title\nDaily \d+$/);
    assert.equal(await page.$eval('#countdown-preview-media img', (el) => el.getAttribute('src').includes('event-poster.png')), true);
    assert.match(await page.$eval('#countdown-preview-source', (el) => el.textContent), /Today[\s\S]*Custom for this day[\s\S]*Image: event-poster\.png \(saved for this day\)[\s\S]*Title: this day · Message: this day/);
    assert.equal(await page.$eval('input[name="countdown-day-mode"][value="custom"]', (el) => el.checked), true);
    await page.type('#countdown-day-title', '!');
    assert.match(await page.$eval('#countdown-preview-source', (el) => el.textContent), /Unsaved changes for this day are not included/);
    await page.$eval('#countdown-day-title', (el) => { el.value = 'Daily title'; });
    await page.screenshot({ path: path.join(verificationDir, 'countdown-days.png'), fullPage: true });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('.group-tile-card');
    await page.click('[data-service="countdown"]');
    await page.$eval('#countdown-day-date', (el, day) => { el.value = day; el.dispatchEvent(new Event('change', { bubbles: true })); }, selectedDay);
    assert.equal(await page.$eval('#countdown-day-title', (el) => el.value), 'Daily title');
    assert.equal(await page.$eval('#countdown-day-message', (el) => el.value), 'Daily {days}');
    assert.match(await page.$eval('#countdown-day-media-name', (el) => el.textContent), /event-poster.png/);
    assert.equal(await page.$eval('input[name="countdown-day-mode"][value="custom"]', (el) => el.checked), true);
    // Saving "Use main content" removes the day's own title, message and poster.
    await page.click('input[name="countdown-day-mode"][value="main"] + span');
    const reset = page.waitForResponse((res) => res.url().includes('/api/countdowns/cd-1/days/') && res.request().method() === 'POST');
    await page.click('#countdown-day-save');
    assert.equal((await reset).status(), 200);
    assert.equal(h.db.get(['countdowns', 0, 'dailyContent', selectedDay]).value(), undefined);
    await page.waitForFunction(() => /Main content/.test(document.querySelector('#countdown-preview-source').textContent));
    h.db.set('countdowns[0].dailyContent', {}).write();
    io.emit('config:updated', h.db.getState());
  });

  await t.test('authenticator can be paired from the connected dashboard', async () => {
    await page.waitForFunction(() => socket.connected);
    io.emit('wa:ready', { name: 'Test' });
    await page.waitForSelector('#approval-setup-start:not(.hidden)');
    await page.click('#approval-setup-start');
    await page.waitForSelector('#approval-setup-details:not(.hidden)');
    const key = await page.$eval('#approval-setup-key', (el) => el.textContent);
    let value = 0, bits = 0; const bytes = [];
    for (const char of key) {
      value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5;
      if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    await page.type('#approval-setup-code', approval.totp(Buffer.from(bytes)));
    const response = page.waitForResponse((res) => res.url().endsWith('/api/approval/confirm'));
    await page.click('#approval-setup-confirm');
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.querySelector('#approval-setup-status').textContent.includes('enabled'));
    assert.equal(await page.$eval('#approval-setup-details', (el) => el.classList.contains('hidden')), true);
    const replace = await fetch(`${origin}/api/approval/setup`, { method: 'POST' });
    assert.equal(replace.status, 401);
    await fs.rm(approval.configPath);
  });

  await t.test('protected changes require authenticator approval in the dashboard', async () => {
    const secret = crypto.randomBytes(20);
    await fs.mkdir(path.join(directory, 'data'), { recursive: true });
    await fs.writeFile(approval.configPath, JSON.stringify({ secret: secret.toString('hex') }));
    try {
      await page.$eval('#countdown-day-title', (el) => { el.value = ''; });
      await page.$eval('#countdown-day-message', (el) => { el.value = ''; });
      await page.click('#countdown-day-save');
      await page.waitForSelector('#approval-dialog[open]');
      await page.type('#approval-code', approval.totp(secret));
      const response = page.waitForResponse((res) => res.url().includes('/api/countdowns/cd-1/days/') && res.status() === 200);
      await page.click('#approval-form button[type="submit"]');
      assert.equal((await response).status(), 200);
      await page.waitForFunction(() => !document.querySelector('#approval-dialog').open);
    } finally { await fs.rm(approval.configPath, { force: true }); h.db.set('countdowns[0].dailyContent', {}).write(); }
  });

  await t.test('a selected image appears in the picker and output preview', async () => {
    await page.$eval('#countdown-title', (el) => { el.value = 'Annual Science Exhibition'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await (await page.$('#countdown-media')).uploadFile(filename);
    await page.waitForFunction(() => document.querySelector('#countdown-media-preview img')?.naturalWidth > 0);
    await page.click('#btn-preview-countdown');
    await page.waitForFunction(() => document.querySelector('#countdown-preview-media img')?.naturalWidth > 0);
    assert.match(await page.$eval('#countdown-preview-text', (el) => el.textContent), /^Annual Science Exhibition\nTime remaining:/);
    assert.equal(await page.$eval('#countdown-preview', (el) => el.classList.contains('hidden')), false);
  });

  await t.test('background state updates preserve the selected poster and unsaved title', async () => {
    io.emit('config:updated', h.db.getState());
    await page.waitForNetworkIdle({ idleTime: 100 });
    assert.equal(await page.$eval('#countdown-title', (el) => el.value), 'Annual Science Exhibition');
    assert.equal(await page.$eval('#countdown-media', (el) => el.files.length), 1);
    assert.equal(await page.$eval('#countdown-media-preview img', (el) => el.naturalWidth), 480);
  });

  await t.test('Broadcast Now uploads the unsaved image and sends one combined message', async () => {
    const response = page.waitForResponse((res) => res.url().endsWith('/api/countdowns/cd-1/broadcast') && res.request().method() === 'POST');
    await page.click('#btn-broadcast-countdown');
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#btn-broadcast-countdown').disabled);
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0][1], /^Annual Science Exhibition\nTime remaining:/);
    assert.equal(h.sends[0][2], h.db.get('countdowns[0].mediaPath').value());
    assert.ok((await fs.stat(h.sends[0][2])).size > 0);
    assert.match(h.db.get('countdowns[0].targetDate').value(), /Z$/);
  });

  await t.test('the saved image appears after reload', async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('.group-tile-card');
    await page.click('[data-service="countdown"]');
    await page.waitForFunction(() => document.querySelector('#countdown-media-preview img')?.naturalWidth === 480);
    await page.click('#btn-preview-countdown');
    await page.waitForFunction(() => document.querySelector('#countdown-preview-media img')?.naturalWidth === 480);
    const screenshot = path.join(root, 'scratch/verification/countdown-preview.png');
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: screenshot, fullPage: true });
  });

  await t.test('removing the saved image previews and broadcasts text only', async () => {
    await page.click('#countdown-media-clear');
    assert.equal(await page.$eval('#countdown-preview-media', (el) => el.classList.contains('hidden')), true);
    const response = page.waitForResponse((res) => res.url().endsWith('/api/countdowns/cd-1/broadcast') && res.request().method() === 'POST');
    await page.click('#btn-broadcast-countdown');
    assert.equal((await response).status(), 200);
    assert.equal(h.sends.length, 2);
    assert.equal(h.sends[1][2], null);
    assert.equal(h.db.get('countdowns[0].mediaPath').value(), null);
  });

  await t.test('a scheduled image-only post uses the chosen timezone and runs when due', async () => {
    await page.click('[data-service="posts"]');
    const localDate = await page.$eval('#post-date', (el) => {
      const d = new Date(Date.now() - 120000);
      const pad = (n) => String(n).padStart(2, '0');
      el.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return el.value;
    });
    await (await page.$('#post-media')).uploadFile(filename);
    const response = page.waitForResponse((res) => res.url().endsWith('/api/posts') && res.request().method() === 'POST');
    await page.click('#btn-add-post');
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.querySelector('#posts-list').textContent.includes('Sent'));
    const post = h.db.get('scheduledPosts[0]').value();
    assert.equal(post.scheduledAt, new Date(`${localDate}+05:30`).toISOString());
    assert.equal(post.message, '');
    assert.equal(post.sent, true);
    assert.equal(h.sends.length, 3);
    assert.equal(h.sends[2][2], post.mediaPath);
    await posts.runScheduledPostsCheck();
    assert.equal(h.sends.length, 3);
  });

  await t.test('a dropped image refreshes both previews after removing a saved poster', async () => {
    await page.click('[data-service="countdown"]');
    await page.$eval('#countdown-media-area', (el) => {
      const dt = new DataTransfer();
      const canvas = document.createElement('canvas');
      canvas.width = 20;
      canvas.height = 10;
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#countdown-media-preview img')?.naturalWidth === 20);
    await page.click('#btn-preview-countdown');
    await page.waitForFunction(() => document.querySelector('#countdown-preview-media img')?.naturalWidth === 20);
    const response = page.waitForResponse((res) => res.url().endsWith('/api/countdowns/cd-1/broadcast') && res.request().method() === 'POST');
    await page.click('#btn-broadcast-countdown');
    assert.equal((await response).status(), 200);
    assert.match(h.db.get('countdowns[0].mediaName').value(), /dropped.png/);
    assert.equal(h.sends.length, 4);
  });

  await t.test('a second countdown is created from the list and edited separately', async () => {
    await page.click('.sidebar__nav [data-nav-service="countdown"]');
    await page.click('#btn-new-countdown');
    assert.equal(await page.$eval('#countdown-editing-label', (el) => el.textContent), 'New countdown');
    assert.equal(await page.$eval('#countdown-title', (el) => el.value), '');
    assert.match(await page.$eval('#countdown-day-cards', (el) => el.textContent), /Choose the start and target dates/);
    await page.type('#countdown-title', 'Symposium');
    const target = new Date(Date.now() + 5 * 86400000 + 330 * 60000).toISOString().slice(0, 16);
    await page.$eval('#countdown-date', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, target);
    // Times use 24-hour hour and minute selects.
    assert.deepEqual(await page.$$eval('#countdown-daily-time-picker option', (options) => [options[1].value, options[24].value]), ['00', '23']);
    await page.select('#countdown-daily-time-picker', '18');
    await page.select('#countdown-daily-time-picker ~ .time24__part', '30');
    assert.equal(await page.$eval('#countdown-daily-time', (el) => el.value), '18:30');
    // Cards follow the unsaved dates: today through the target day.
    assert.equal(await page.$$eval('#countdown-day-cards .day-card', (cards) => cards.length), 6);
    assert.match(await page.$eval('#countdown-day-cards .day-card', (el) => el.textContent), /Symposium/);
    const response = page.waitForResponse((res) => res.url().endsWith('/api/countdowns') && res.request().method() === 'POST');
    await page.click('#btn-save-countdown');
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.querySelectorAll('.countdown-item').length === 2);
    const created = h.db.get('countdowns').find({ eventTitle: 'Symposium' }).value();
    assert.equal(created.targetDate, new Date(`${target}+05:30`).toISOString());
    assert.equal(created.dailyTime, '18:30');
    assert.match(await page.$eval('#countdown-editing-label', (el) => el.textContent), /Symposium/);
    assert.match(await page.$eval('.countdown-item.is-selected', (el) => el.textContent), /Symposium/);
    await page.screenshot({ path: path.join(verificationDir, 'countdown-list.png'), fullPage: true });

    await page.click('.countdown-item:not(.is-selected)');
    assert.equal(await page.$eval('#countdown-title', (el) => el.value), h.db.get('countdowns[0].eventTitle').value());
    assert.equal(h.db.get('countdowns[0].eventTitle').value() !== 'Symposium', true);

    h.db.get('countdowns').remove({ id: created.id }).write();
    io.emit('config:updated', h.db.getState());
    await page.waitForFunction(() => document.querySelectorAll('.countdown-item').length === 1);
  });

  await t.test('saving a day on a new countdown saves the countdown first', async () => {
    await page.click('#btn-new-countdown');
    await page.type('#countdown-title', 'Robotics Week');
    const start = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16);
    const target = new Date(Date.now() + 13 * 86400000 + 330 * 60000).toISOString().slice(0, 16);
    await page.$eval('#countdown-start-date', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, start);
    await page.$eval('#countdown-date', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, target);
    assert.equal(await page.$$eval('#countdown-day-cards .day-card', (cards) => cards.length), 14);
    const day = target.slice(0, 10);
    await page.click(`.day-card[data-day="${day}"]`);
    await page.type('#countdown-day-title', 'Final day');
    const saved = page.waitForResponse((res) => res.url().endsWith('/api/countdowns') && res.request().method() === 'POST');
    const daySaved = page.waitForResponse((res) => /\/api\/countdowns\/[^/]+\/days\//.test(res.url()));
    await page.click('#countdown-day-save');
    assert.equal((await saved).status(), 200);
    assert.equal((await daySaved).status(), 200);
    const created = h.db.get('countdowns').find({ eventTitle: 'Robotics Week' }).value();
    assert.equal(created.dailyContent[day].eventTitle, 'Final day');
    await page.waitForFunction((d) => document.querySelector(`.day-card[data-day="${d}"]`)?.classList.contains('day-card--custom'), {}, day);
    assert.match(await page.$eval('#countdown-editing-label', (el) => el.textContent), /Robotics Week/);
    await page.screenshot({ path: path.join(verificationDir, 'countdown-days-new.png'), fullPage: true });

    await page.click('#countdown-day-close');
    h.db.get('countdowns').remove({ id: created.id }).write();
    io.emit('config:updated', h.db.getState());
    await page.waitForFunction(() => document.querySelectorAll('.countdown-item').length === 1);
  });

  await t.test('posters and SVG templates can be added from the Posters page', async () => {
    await page.click('.sidebar__nav [data-nav-service="svg-editor"]');
    assert.equal(await page.$eval('#breadcrumb-current', (el) => el.textContent), 'Posters');
    const svgFile = path.join(directory, 'banner.svg');
    await fs.writeFile(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#163e63"/><text x="20" y="60" fill="#fff">Banner</text></svg>');
    await (await page.$('#poster-upload-input')).uploadFile(filename, svgFile);
    await page.click('#btn-poster-upload');
    await page.waitForFunction(() => /Added 2 files/.test(document.querySelector('#poster-upload-status').textContent));
    assert.deepEqual(h.db.get('savedPosters').map('name').value(), ['event-poster', 'banner']);
    // The SVG becomes an editable template and a PNG poster.
    await fs.access(path.join(directory, 'uploads', 'templates', 'banner.svg'));
    assert.match(h.db.get('savedPosters[1].filename').value(), /banner\.png$/);
    await page.waitForFunction(() => [...document.querySelectorAll('#svg-template-select option')].some((o) => o.value === 'banner.svg'));
    await page.waitForFunction(() => [...document.querySelectorAll('#poster-library-grid .poster-tile__name')].map((el) => el.textContent).includes('banner'));
    assert.match(await page.$eval('#svg-custom-templates-list', (el) => el.textContent), /banner\.svg/);
    assert.equal(await page.$eval('#countdown-poster-select', (el) => [...el.options].some((o) => o.textContent.startsWith('banner'))), true);
    await page.screenshot({ path: path.join(verificationDir, 'posters.png'), fullPage: true });
    await page.click('.sidebar__nav [data-overview]');
  });

  await t.test('dashboard counts pending work and explains expired events', async () => {
    const state = structuredClone(h.db.getState());
    state.countdowns[0].targetDate = new Date(Date.now() - 86400000).toISOString();
    state.countdowns[0].enabled = true;
    state.scheduledPosts = [
      h.duePost({ id: 'queued-1', sent: false }), h.duePost({ id: 'queued-2', sent: false }), h.duePost({ id: 'sent-1', sent: true }),
    ];
    await page.waitForFunction(() => socket.connected);
    io.emit('config:updated', state);
    await page.waitForFunction(() => document.querySelector('#overview-countdown-status').textContent === 'Event ended');
    assert.equal(await page.$eval('#metric-posts', (el) => el.textContent), '2');
    assert.equal(await page.$eval('#metric-countdowns', (el) => el.textContent), '0');
    assert.match(await page.$eval('#overview-countdown-note', (el) => el.textContent), /date has passed/);
    assert.equal(await page.$eval('#overview-days', (el) => el.textContent), '00');
    io.emit('config:updated', h.db.getState());
    await page.waitForFunction(() => document.querySelector('#metric-posts').textContent === '0');
  });

  await t.test('overview and every service fit mobile, tablet, and desktop widths', async () => {
    await page.waitForFunction(() => document.querySelector('#toast-container').children.length === 0);
    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewport({ width, height: 950 });
      await page.click('.sidebar__nav [data-overview]');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `Overview overflows at ${width}px`);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: path.join(verificationDir, `dashboard-${width === 390 ? 'mobile' : 'desktop'}.png`), fullPage: true });
      }
      for (const service of ['countdown', 'posts', 'commands', 'dispatch']) {
        await page.click(`.sidebar__nav [data-nav-service="${service}"]`);
        assert.equal(await page.$eval(`#service-view-${service}`, (el) => el.classList.contains('is-active')), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${service} overflows at ${width}px`);
        if (service === 'countdown' && (width === 390 || width === 1440)) {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
          await page.screenshot({ path: path.join(verificationDir, `countdown-${width === 390 ? 'mobile' : 'desktop'}.png`), fullPage: true });
        }
      }
    }
  });

  await t.test('adding a group is reachable and empty workspaces explain the next step', async () => {
    await page.click('[data-add-group]');
    assert.equal(await page.$eval('#group-configuration', (el) => el.open), true);
    assert.equal(await page.$eval('#group-name-input', (el) => el === document.activeElement), true);
    io.emit('config:updated', { ...h.db.getState(), targetGroups: [], groupTarget: { name: '' } });
    await page.waitForSelector('#no-groups-hint');
    await page.click('.sidebar__nav [data-nav-service="countdown"]');
    assert.equal(await page.$eval('body', (el) => el.classList.contains('workspace-open')), false);
    assert.equal(await page.$eval('#group-configuration', (el) => el.open), true);
    assert.equal(await page.$eval('#group-name-input', (el) => el === document.activeElement), true);
  });
  assert.deepEqual(errors, []);
});
