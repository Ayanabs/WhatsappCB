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
  const api = load('routes/api.js', {
    '../core/db': h.database, '../core/whatsappClient': h.wa,
    '../core/countdown': countdown,
    '../core/taskWorker': { tick: () => posts.runScheduledPostsCheck() },
    '../core/logger': logger,
  }, { process: { ...process, cwd: () => directory } });
  app.use(express.json());
  const approval = load('core/approvalAuth.js', {}, { Buffer, process: { ...process, cwd: () => directory } });
  app.use('/api', approval.middleware, api);
  app.get('/config.js', (_req, res) => res.type('js').send('window.WABOT_API = "";'));
  app.use('/uploads', express.static(path.join(directory, 'uploads')));
  app.use(express.static(path.join(root, 'public')));
  io.on('connection', (socket) => socket.emit('config:updated', h.db.getState()));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise((resolve) => io.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  await t.test('API rejects invalid scheduled dates instead of queuing unusable posts', async () => {
    const result = await fetch(`${origin}/api/posts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: 'invalid', message: 'Hello' }),
    });
    assert.equal(result.status, 400);
    assert.equal(h.db.get('scheduledPosts').size().value(), 0);
  });

  await t.test('daily countdown content is stored per date and can fall back to defaults', async () => {
    h.db.set('countdown.startDate', '2026-10-28T01:00:00Z').set('countdown.targetDate', '2026-10-31T01:00:00Z').write();
    const form = new FormData();
    form.append('eventTitle', 'Day two');
    form.append('messageTemplate', 'Only {days} days');
    form.append('media', new Blob(['image'], { type: 'image/png' }), 'day.png');
    let response = await fetch(`${origin}/api/countdown/days/2026-10-29`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    const entry = h.db.get('countdown.dailyContent.2026-10-29').value();
    assert.equal(entry.eventTitle, 'Day two');
    assert.equal(entry.mediaName, 'day.png');
    response = await fetch(`${origin}/api/countdown/days/2026-11-01`, { method: 'POST', body: new FormData() });
    assert.equal(response.status, 400);
    const clear = new FormData();
    clear.append('clearMedia', 'true');
    response = await fetch(`${origin}/api/countdown/days/2026-10-29`, { method: 'POST', body: clear });
    assert.equal(response.status, 200);
    assert.equal(h.db.get('countdown.dailyContent.2026-10-29').value(), undefined);
    h.db.set('countdown.startDate', '').set('countdown.targetDate', new Date(Date.now() + 2 * 86400000).toISOString()).write();
  });

  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.emulateTimezone('Asia/Colombo');
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(origin, { waitUntil: 'networkidle0' });
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
    h.db.set('countdown.startDate', start).set('countdown.targetDate', end).write();
    await page.waitForFunction(() => socket.connected);
    io.emit('config:updated', h.db.getState());
    await page.waitForFunction((iso) => document.querySelector('#countdown-day-date').min === new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10), {}, start);
    const selectedDay = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    await page.$eval('#countdown-day-date', (el, day) => { el.value = day; el.dispatchEvent(new Event('change', { bubbles: true })); }, selectedDay);
    await page.type('#countdown-day-title', 'Daily title');
    await page.type('#countdown-day-message', 'Daily {days}');
    await (await page.$('#countdown-day-media')).uploadFile(filename);
    const response = page.waitForResponse((res) => res.url().includes('/api/countdown/days/') && res.request().method() === 'POST');
    await page.click('#countdown-day-save');
    assert.equal((await response).status(), 200);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('.group-tile-card');
    await page.click('[data-service="countdown"]');
    await page.$eval('#countdown-day-date', (el, day) => { el.value = day; el.dispatchEvent(new Event('change', { bubbles: true })); }, selectedDay);
    assert.equal(await page.$eval('#countdown-day-title', (el) => el.value), 'Daily title');
    assert.equal(await page.$eval('#countdown-day-message', (el) => el.value), 'Daily {days}');
    assert.match(await page.$eval('#countdown-day-media-name', (el) => el.textContent), /event-poster.png/);
    h.db.set('countdown.dailyContent', {}).write();
    io.emit('config:updated', h.db.getState());
  });

  await t.test('protected changes require password and authenticator approval in the dashboard', async () => {
    const secret = crypto.randomBytes(20);
    const salt = crypto.randomBytes(16);
    await fs.mkdir(path.join(directory, 'data'), { recursive: true });
    await fs.writeFile(approval.configPath, JSON.stringify({ secret: secret.toString('hex'), salt: salt.toString('hex'),
      passwordHash: crypto.scryptSync('test approval password', salt, 32).toString('hex') }));
    try {
      await page.$eval('#countdown-day-title', (el) => { el.value = ''; });
      await page.$eval('#countdown-day-message', (el) => { el.value = ''; });
      await page.click('#countdown-day-save');
      await page.waitForSelector('#approval-dialog[open]');
      await page.type('#approval-password', 'test approval password');
      await page.type('#approval-code', approval.totp(secret));
      const response = page.waitForResponse((res) => res.url().includes('/api/countdown/days/') && res.status() === 200);
      await page.click('#approval-form button[type="submit"]');
      assert.equal((await response).status(), 200);
      await page.waitForFunction(() => !document.querySelector('#approval-dialog').open);
    } finally { await fs.rm(approval.configPath, { force: true }); h.db.set('countdown.dailyContent', {}).write(); }
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
    const response = page.waitForResponse((res) => res.url().endsWith('/api/countdown/broadcast') && res.request().method() === 'POST');
    await page.click('#btn-broadcast-countdown');
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#btn-broadcast-countdown').disabled);
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0][1], /^Annual Science Exhibition\nTime remaining:/);
    assert.equal(h.sends[0][2], h.db.get('countdown.mediaPath').value());
    assert.ok((await fs.stat(h.sends[0][2])).size > 0);
    assert.match(h.db.get('countdown.targetDate').value(), /Z$/);
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
    const response = page.waitForResponse((res) => res.url().endsWith('/api/countdown/broadcast') && res.request().method() === 'POST');
    await page.click('#btn-broadcast-countdown');
    assert.equal((await response).status(), 200);
    assert.equal(h.sends.length, 2);
    assert.equal(h.sends[1][2], null);
    assert.equal(h.db.get('countdown.mediaPath').value(), null);
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
    const response = page.waitForResponse((res) => res.url().endsWith('/api/countdown/broadcast') && res.request().method() === 'POST');
    await page.click('#btn-broadcast-countdown');
    assert.equal((await response).status(), 200);
    assert.match(h.db.get('countdown.mediaName').value(), /dropped.png/);
    assert.equal(h.sends.length, 4);
  });

  await t.test('dashboard counts pending work and explains expired events', async () => {
    const state = structuredClone(h.db.getState());
    state.countdown.targetDate = new Date(Date.now() - 86400000).toISOString();
    state.countdown.enabled = true;
    state.scheduledPosts = [
      h.duePost({ id: 'queued-1', sent: false }), h.duePost({ id: 'queued-2', sent: false }), h.duePost({ id: 'sent-1', sent: true }),
    ];
    state.dailyAlarms = [{ id: 'alarm-1', time: '09:00', message: 'Daily reminder', enabled: true }, { id: 'alarm-2', time: '12:00', message: 'Paused reminder', enabled: false }];
    await page.waitForFunction(() => socket.connected);
    io.emit('config:updated', state);
    await page.waitForFunction(() => document.querySelector('#overview-countdown-status').textContent === 'Event ended');
    assert.equal(await page.$eval('#metric-posts', (el) => el.textContent), '2');
    assert.equal(await page.$eval('#metric-alarms', (el) => el.textContent), '1');
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
      for (const service of ['countdown', 'posts', 'alarms', 'commands', 'dispatch']) {
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
