'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('./automation-helpers.cjs');

test('approval requires password and fresh authenticator code for mutations', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = load('core/approvalAuth.js', {}, { Buffer, process: { ...process, cwd: () => dir } });
  const secret = Buffer.from('12345678901234567890');
  assert.equal(auth.totp(secret, 1), '287082'); // RFC 6238 vector, six digits
  const salt = crypto.randomBytes(16);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(auth.configPath, JSON.stringify({ secret: secret.toString('hex'), salt: salt.toString('hex'),
    passwordHash: crypto.scryptSync('a long password', salt, 32).toString('hex') }));
  function request(method, password, code) {
    let status = 200, next = false;
    const headers = { 'X-Approval-Password': password, 'X-Approval-Code': code };
    const req = { method, get: (key) => headers[key] };
    const res = { status(value) { status = value; return this; }, json(value) { return value; } };
    auth.middleware(req, res, () => { next = true; });
    return { status, next };
  }
  assert.equal(request('GET').next, true);
  assert.equal(request('POST').status, 401);
  assert.equal(request('POST', 'wrong', auth.totp(secret)).status, 401);
  assert.equal(request('POST', 'a long password', '000000').status, 401);
  const code = auth.totp(secret);
  assert.equal(request('POST', 'a long password', code).next, true);
  assert.equal(request('POST', 'a long password', code).status, 401);
});
