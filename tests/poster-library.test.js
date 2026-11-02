'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { root, logger, load, fixture } = require('./automation-helpers.cjs');

test('poster templates, library registration and multi-service media attachment', async (t) => {
  const h = fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'poster-test-'));
  const uploadsDir = path.join(directory, 'uploads');
  const postersDir = path.join(directory, 'posters');
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(postersDir, { recursive: true });

  // Create sample SVG template and sample PNG in posters/ and uploads/
  const sampleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><text id="title">Sample Template</text></svg>';
  await fs.writeFile(path.join(postersDir, 'sample-poster.svg'), sampleSvg, 'utf8');

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const waBroadcasts = [];
  h.wa.broadcast = (...args) => { waBroadcasts.push(args); return 1; };

  const mocks = { ...h.mocks, './whatsappClient': h.wa };
  const countdown = load('core/countdown.js', mocks);
  const posts = load('core/scheduledPosts.js', mocks);
  const approval = load('core/approvalAuth.js', {}, { Buffer, process: { ...process, cwd: () => directory } });
  const api = load('routes/api.js', {
    '../core/db': h.database,
    '../core/whatsappClient': { ...h.wa, isReady: () => h.wa.isReady() },
    '../core/countdown': countdown,
    '../core/taskWorker': { tick: () => posts.runScheduledPostsCheck() },
    '../core/logger': logger,
    '../core/approvalAuth': approval,
  }, { process: { ...process, cwd: () => directory } });

  app.use(express.json());
  app.use('/api', approval.middleware, api);
  app.use('/uploads', express.static(uploadsDir));
  app.use('/posters', express.static(postersDir));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => io.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  await t.test('GET /api/posters/templates discovers available SVG templates', async () => {
    const res = await fetch(`${origin}/api/posters/templates`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.templates.length, 1);
    assert.equal(data.templates[0].filename, 'sample-poster.svg');
    assert.equal(data.templates[0].name, 'Sample Poster');
    assert.match(data.templates[0].content, /Sample Template/);
  });

  let savedPosterUrl = '';
  await t.test('POST /api/posters/save registers rendered PNG poster into uploads and library', async () => {
    const form = new FormData();
    form.append('name', 'Symposium Banner');
    form.append('media', new Blob(['fake-png-binary-content'], { type: 'image/png' }), 'symposium.png');

    const res = await fetch(`${origin}/api/posters/save`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.poster.name, 'Symposium Banner');
    assert.match(data.poster.mediaUrl, /^\/uploads\//);
    savedPosterUrl = data.poster.mediaUrl;

    const savedList = h.db.get('savedPosters').value();
    assert.equal(savedList.length, 1);
    assert.equal(savedList[0].name, 'Symposium Banner');
  });

  await t.test('GET /api/posters/library returns tracked and scanned posters', async () => {
    const res = await fetch(`${origin}/api/posters/library`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.posters.length, 1);
    assert.equal(data.posters[0].name, 'Symposium Banner');
    assert.equal(data.posters[0].mediaUrl, savedPosterUrl);
  });

  await t.test('POST /api/send-test accepts saved poster mediaUrl and delivers attachment', async () => {
    const form = new FormData();
    form.append('target', '__ALL__');
    form.append('message', 'Test broadcast with poster');
    form.append('mediaUrl', savedPosterUrl);
    form.append('mediaName', 'Symposium Banner');

    const res = await fetch(`${origin}/api/send-test`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(h.sends.length >= 1, true);
    const lastSend = h.sends[h.sends.length - 1];
    assert.equal(lastSend[0], 'Group A@g.us');
    assert.equal(lastSend[1], 'Test broadcast with poster');
    assert.match(lastSend[2], /uploads/);
  });

  await t.test('POST /api/countdowns creates another countdown with the chosen poster', async () => {
    const form = new FormData();
    form.append('enabled', 'true');
    form.append('eventTitle', 'Countdown Event');
    form.append('targetDate', new Date(Date.now() + 86400000).toISOString());
    form.append('dailyTime', '09:00');
    form.append('mediaUrl', savedPosterUrl);
    form.append('mediaName', 'Symposium Banner');

    const res = await fetch(`${origin}/api/countdowns`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(h.db.get('countdowns').size().value(), 2);
    const state = h.db.get('countdowns').find({ id: data.countdownId }).value();
    assert.equal(state.eventTitle, 'Countdown Event');
    assert.equal(state.enabled, true);
    assert.ok(state.scheduleFrom);
    assert.equal(state.mediaUrl, savedPosterUrl);
    assert.equal(state.mediaName, 'Symposium Banner');
    assert.match(state.mediaPath, /uploads/);
  });

  await t.test('POST /api/posts attaches chosen poster by mediaUrl', async () => {
    const form = new FormData();
    form.append('scheduledAt', new Date(Date.now() + 3600000).toISOString());
    form.append('message', 'Scheduled announcement with poster');
    form.append('mediaUrl', savedPosterUrl);
    form.append('mediaName', 'Symposium Banner');

    const res = await fetch(`${origin}/api/posts`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const post = h.db.get('scheduledPosts').first().value();
    assert.equal(post.mediaUrl, savedPosterUrl);
    assert.equal(post.mediaName, 'Symposium Banner');
    assert.match(post.mediaPath, /uploads/);
  });

  await t.test('countdowns can be updated and deleted by id without touching the others', async () => {
    const id = h.db.get('countdowns[1].id').value();
    const form = new FormData();
    form.append('eventTitle', 'Renamed Event');
    let res = await fetch(`${origin}/api/countdowns/${id}`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    assert.equal(h.db.get('countdowns').find({ id }).value().eventTitle, 'Renamed Event');
    assert.equal(h.db.get('countdowns[0].eventTitle').value(), 'Science Exhibition');

    res = await fetch(`${origin}/api/countdowns/missing`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 404);

    // A start date after the target date would never send, so it is rejected.
    const backwards = new FormData();
    backwards.append('startDate', new Date(Date.now() + 30 * 86400000).toISOString());
    res = await fetch(`${origin}/api/countdowns/${id}`, { method: 'POST', body: backwards });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /start date must be before the target date/);
    assert.ok(!h.db.get('countdowns').find({ id }).value().startDate);

    res = await fetch(`${origin}/api/countdowns/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(h.db.get('countdowns').map('id').value(), ['cd-1']);
  });

  await t.test('deleting a post or countdown keeps the shared library poster file', async () => {
    const posterFile = path.join(uploadsDir, path.basename(savedPosterUrl));
    const post = h.db.get('scheduledPosts').first().value();
    const res = await fetch(`${origin}/api/posts/${post.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    await fs.access(posterFile);
  });

  await t.test('SVG templates can be added from the dashboard and deleted again', async () => {
    const form = new FormData();
    // Same name as the bundled template: the added one is renamed instead of replacing it.
    form.append('media', new Blob([sampleSvg], { type: 'image/svg+xml' }), 'sample-poster.svg');
    let res = await fetch(`${origin}/api/posters/templates`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).template.filename, 'sample-poster-2.svg');
    await fs.access(path.join(uploadsDir, 'templates', 'sample-poster-2.svg'));

    res = await fetch(`${origin}/api/posters/templates`);
    const { templates } = await res.json();
    assert.deepEqual(templates.map((t) => [t.filename, t.custom, t.url]), [
      ['sample-poster.svg', false, '/posters/sample-poster.svg'],
      ['sample-poster-2.svg', true, '/uploads/templates/sample-poster-2.svg'],
    ]);

    const notSvg = new FormData();
    notSvg.append('media', new Blob(['png'], { type: 'image/png' }), 'photo.png');
    res = await fetch(`${origin}/api/posters/templates`, { method: 'POST', body: notSvg });
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/posters/templates/sample-poster.svg`, { method: 'DELETE' });
    assert.equal(res.status, 404, 'bundled templates are kept');
    res = await fetch(`${origin}/api/posters/templates/sample-poster-2.svg`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    await assert.rejects(fs.access(path.join(uploadsDir, 'templates', 'sample-poster-2.svg')));
  });

  await t.test('library posters are deleted unless a countdown still uses them', async () => {
    const filename = path.basename(savedPosterUrl);
    h.db.set('countdowns[0].mediaPath', path.join(uploadsDir, filename)).write();
    let res = await fetch(`${origin}/api/posters/library/${filename}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /countdown "Science Exhibition"/);
    await fs.access(path.join(uploadsDir, filename));

    h.db.set('countdowns[0].mediaPath', null).write();
    res = await fetch(`${origin}/api/posters/library/${filename}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    await assert.rejects(fs.access(path.join(uploadsDir, filename)));
    assert.equal(h.db.get('savedPosters').size().value(), 0);
  });

  await t.test('daily alarm routes are gone', async () => {
    const res = await fetch(`${origin}/api/alarms`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 404);
  });
});
