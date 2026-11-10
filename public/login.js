'use strict';

/**
 * login.js
 * Dashboard sign-in gate. Shows the login screen until the API accepts a
 * token, then loads the Socket.IO client and app.js. Exposes window.relayAuth
 * so app.js can attach the token to requests and sign out.
 *
 * Sessions end after 5 minutes without user activity; while the user is
 * active the token is renewed in the background.
 */
(() => {
  const STORAGE_KEY = 'relay.authToken';
  const NOTICE_KEY = 'relay.signOutNotice';
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const RENEW_EVERY_MS = 60 * 1000;
  const CHECK_EVERY_MS = 10 * 1000;
  const API_ORIGIN = window.WABOT_API || '';
  let memoryToken = '';

  const readToken = () => { try { return localStorage.getItem(STORAGE_KEY) || memoryToken; } catch (_) { return memoryToken; } };
  const writeToken = (token) => {
    memoryToken = token;
    try { token ? localStorage.setItem(STORAGE_KEY, token) : localStorage.removeItem(STORAGE_KEY); } catch (_) { /* memory only */ }
  };

  window.relayAuth = {
    token: readToken,
    headers(extra = {}) {
      const token = readToken();
      return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
    },
    signOut(notice = '') {
      writeToken('');
      try { notice ? sessionStorage.setItem(NOTICE_KEY, notice) : sessionStorage.removeItem(NOTICE_KEY); } catch (_) { /* no notice */ }
      location.reload();
    },
  };

  // ── Idle timeout ────────────────────────────────────────────────────────────
  let lastActivity = Date.now();
  let lastRenewal = Date.now();
  let renewing = false;

  async function renewToken() {
    const res = await fetch(`${API_ORIGIN}/api/auth/session`, { headers: window.relayAuth.headers() });
    if (!res.ok) return false;
    writeToken((await res.json()).token);
    lastRenewal = Date.now();
    return true;
  }

  async function checkSession() {
    if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
      return window.relayAuth.signOut('You were signed out after 5 minutes of inactivity.');
    }
    if (renewing || lastActivity <= lastRenewal || Date.now() - lastRenewal < RENEW_EVERY_MS) return;
    renewing = true;
    try {
      if (!(await renewToken())) window.relayAuth.signOut('Your session expired. Sign in again.');
    } catch (_) { /* server unreachable; retry on the next check */ }
    finally { renewing = false; }
  }

  function startIdleTimer() {
    const markActive = () => { lastActivity = Date.now(); };
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      window.addEventListener(type, markActive, { passive: true, capture: true });
    }
    // Background tabs throttle timers, so also check as soon as the tab returns.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
    setInterval(checkSession, CHECK_EVERY_MS);
  }

  const screen = document.getElementById('login-screen');
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.body.appendChild(el);
    });
  }

  async function startApp() {
    screen.hidden = true;
    document.body.classList.remove('auth-locked');
    lastActivity = Date.now();
    startIdleTimer();
    await loadScript('/socket.io/socket.io.js');
    await loadScript('app.js');
  }

  function showLogin(message = '') {
    screen.hidden = false;
    errorEl.textContent = message;
    document.getElementById('login-username').focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) return showLogin('Enter your username and password.');
    submit.disabled = true;
    errorEl.textContent = '';
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || 'Sign in failed.');
      writeToken(data.token);
      form.reset();
      await startApp();
    } catch (err) {
      form.password.value = '';
      showLogin(err.message === 'Failed to fetch' ? 'Cannot reach the server.' : err.message);
    } finally {
      submit.disabled = false;
    }
  });

  (async () => {
    let notice = '';
    try { notice = sessionStorage.getItem(NOTICE_KEY) || ''; sessionStorage.removeItem(NOTICE_KEY); } catch (_) { /* no notice */ }
    if (!readToken()) return showLogin(notice);
    try {
      if (await renewToken()) return startApp();
      writeToken('');
      showLogin(notice);
    } catch (_) {
      showLogin('Cannot reach the server.');
    }
  })();
})();
