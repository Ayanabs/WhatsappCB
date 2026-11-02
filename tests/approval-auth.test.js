'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./automation-helpers.cjs');

test('approval requires a fresh authenticator code for mutations', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = load('core/approvalAuth.js', {}, { Buffer, process: { ...process, cwd: () => dir } });
  const secret = Buffer.from('12345678901234567890');
  assert.equal(auth.totp(secret, 1), '287082'); // RFC 6238 vector, six digits
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(auth.configPath, JSON.stringify({ secret: secret.toString('hex') }));
  function request(method, code) {
    let status = 200, next = false;
    const headers = { 'X-Approval-Code': code };
    const req = { method, get: (key) => headers[key] };
    const res = { status(value) { status = value; return this; }, json(value) { return value; } };
    auth.middleware(req, res, () => { next = true; });
    return { status, next };
  }
  assert.equal(request('GET').next, true);
  assert.equal(request('POST').status, 401);
  assert.equal(request('POST', 'not-a-code').status, 401);
  const code = auth.totp(secret);
  assert.equal(request('POST', code).next, true);
  assert.equal(request('POST', code).status, 401);
});
