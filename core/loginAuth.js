'use strict';

const crypto = require('crypto');

// Dashboard credentials come from the environment (.env locally, docker-compose
// on the server) so they never live in the repository. Without both, sign-in is refused.
const USERNAME = process.env.DASHBOARD_USERNAME || '';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const CONFIGURED = Boolean(USERNAME && PASSWORD);
if (!CONFIGURED) console.warn('[Auth] DASHBOARD_USERNAME and DASHBOARD_PASSWORD are not set; dashboard sign-in is disabled.');
// Sessions end after 5 minutes without dashboard activity. The dashboard
// renews its token while in use; scheduled bot work never depends on it.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// Tokens are signed with a key derived from the credentials, so they survive
// restarts and are invalidated automatically if the credentials change.
const signingKey = crypto.createHash('sha256').update(`relay-login:${USERNAME}:${PASSWORD}`).digest();

function safeEqual(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(payload) {
  return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function issueToken(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: USERNAME, exp: now + IDLE_TIMEOUT_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token, now = Date.now()) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return false;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return CONFIGURED && u === USERNAME && Number(exp) > now;
  } catch (_) { return false; }
}

let failures = 0;
let blockedUntil = 0;

function login(req, res) {
  if (!CONFIGURED) return res.status(503).json({ ok: false, error: 'Sign-in is not configured. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD on the server.' });
  if (Date.now() < blockedUntil) return res.status(429).json({ ok: false, error: 'Too many login attempts. Try again in a minute.' });
  const { username, password } = req.body || {};
  // Evaluate both comparisons so timing doesn't reveal which field was wrong.
  const userOk = safeEqual(username || '', USERNAME);
  const passOk = safeEqual(password || '', PASSWORD);
  if (userOk && passOk) {
    failures = 0;
    return res.json({ ok: true, token: issueToken() });
  }
  if (++failures >= 5) { blockedUntil = Date.now() + 60000; failures = 0; }
  return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
}

// Returns a fresh token; mount behind middleware so only valid sessions renew.
function session(_req, res) {
  res.json({ ok: true, token: issueToken() });
}

function tokenFromRequest(req) {
  const header = req.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function middleware(req, res, next) {
  if (req.method === 'OPTIONS' || verifyToken(tokenFromRequest(req))) return next();
  return res.status(401).json({ ok: false, authRequired: true, error: 'Sign in required.' });
}

function socketMiddleware(socket, next) {
  if (verifyToken(socket.handshake.auth?.token)) return next();
  return next(new Error('auth_required'));
}

module.exports = { IDLE_TIMEOUT_MS, login, session, middleware, socketMiddleware, issueToken, verifyToken };
