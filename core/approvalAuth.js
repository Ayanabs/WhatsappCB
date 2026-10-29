'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const configPath = path.join(process.cwd(), 'data', 'approval-auth.json');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function totp(secret, counter = Math.floor(Date.now() / 30000)) {
  const block = Buffer.alloc(8);
  block.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(block).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function matchingCounter(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(code || '')) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, counter)), Buffer.from(code))) return counter;
  }
  return null;
}

let failures = 0;
let blockedUntil = 0;
let lastCounter = -1;
function middleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') return next();
    return res.status(503).json({ ok: false, error: 'Approval configuration could not be read.' });
  }
  if (Date.now() < blockedUntil) return res.status(429).json({ ok: false, error: 'Too many approval attempts. Try again later.' });
  let password;
  try { password = decodeURIComponent(req.get('X-Approval-Password') || ''); } catch (_) { password = ''; }
  const code = req.get('X-Approval-Code') || '';
  if (!password || !code) return res.status(401).json({ ok: false, approvalRequired: true, error: 'Approval required.' });
  try {
    if (password.length > 256) throw new Error('Invalid password');
    const expected = Buffer.from(config.passwordHash, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(config.salt, 'hex'), 32);
    const counter = matchingCounter(Buffer.from(config.secret, 'hex'), code);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual) && counter !== null && counter > lastCounter) {
      lastCounter = counter; failures = 0; return next();
    }
  } catch (_) { /* Treat invalid credentials and malformed configuration as failure. */ }
  if (++failures >= 5) { blockedUntil = Date.now() + 60000; failures = 0; }
  return res.status(401).json({ ok: false, approvalRequired: true, error: 'Invalid password or code, or code already used. Try a fresh code.' });
}

module.exports = { middleware, encodeBase32, matchingCounter, totp, configPath };
