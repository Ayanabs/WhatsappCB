/**
 * public/app.js
 * HUD frontend controller.
 * Connects to the Socket.IO server, drives all UI panels, and communicates
 * with the REST API for all configuration mutations and test messages.
 */
'use strict';

let dashboardState = null;

// ═══════════════════════════════════════════════════════════ API BASE URL
const API_ORIGIN = (typeof window !== 'undefined' && window.WABOT_API)
  ? window.WABOT_API
  : '';

// ═══════════════════════════════════════════════════════════ SOCKET.IO
const socket = io(API_ORIGIN);

// ═══════════════════════════════════════════════════════════ TOAST
const toastContainer = (() => {
  const el = document.createElement('div');
  el.id = 'toast-container';
  document.body.appendChild(el);
  return el;
})();

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ═══════════════════════════════════════════════════════════ LOGGING
const activityLog = document.getElementById('activity-log');

function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-entry--${type}`;
  const ts = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-ts">[${ts}]</span> <span class="log-msg">${escHtml(String(message))}</span>`;
  activityLog.prepend(entry);
  while (activityLog.children.length > 200) activityLog.lastChild.remove();
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
  activityLog.innerHTML = '';
});

// ═══════════════════════════════════════════════════════════ SERVER CLOCK
const serverTimeEl = document.getElementById('server-time');
function updateClock() {
  serverTimeEl.textContent = new Date().toLocaleString();
  updateOverviewCountdown();
  if (dashboardState) updateCountdownPreviewText();
}
updateClock();
setInterval(updateClock, 1000);

// ═══════════════════════════════════════════════════════════ WHATSAPP STATUS

const waBadge     = document.getElementById('wa-status-badge');
const waText      = document.getElementById('wa-status-text');
const qrPanel     = document.getElementById('qr-panel');
const qrContainer = document.getElementById('qr-container');
const btnLogout   = document.getElementById('btn-logout');

function setWaStatus(status, label) {
  waBadge.className = `status-badge status-badge--${status}`;
  waText.textContent = label;
  document.getElementById('sidebar-status-text').textContent = label;
  document.getElementById('sidebar-status-dot').style.color = status === 'online' ? '#478662' : status === 'pending' ? '#b58a47' : '#9ca89e';
  document.getElementById('overview-connection-label').textContent = status === 'online' ? 'Connected' : status === 'pending' ? 'Connecting' : 'Not connected';
  document.getElementById('overview-connection-description').textContent = status === 'online'
    ? `${label}. Your account is linked and ready to send to your configured groups.`
    : status === 'pending' ? 'Follow the connection instructions below to finish linking your WhatsApp account.'
      : 'Link your account to start sending messages and running your automations.';
  document.querySelector('.connection-steps').classList.toggle('hidden', status === 'online');
}

socket.on('wa:qr', ({ qrImageUrl }) => {
  if (btnLogout) {
    btnLogout.disabled = false;
    btnLogout.textContent = 'Log Out';
  }
  qrPanel.classList.remove('hidden');
  qrContainer.innerHTML = `<img src="${qrImageUrl}" alt="WhatsApp QR Code" />`;
  setWaStatus('pending', 'Scan QR Code');
  addLog('QR code received. Scan in WhatsApp Linked Devices.', 'warn');
});

socket.on('wa:authenticated', () => {
  qrContainer.innerHTML = '<div class="qr-spinner">Authenticated. Connecting...</div>';
  setWaStatus('pending', 'Connecting...');
  addLog('Authenticated successfully. Establishing connection...', 'success');
});

socket.on('wa:ready', ({ name, number }) => {
  if (btnLogout) {
    btnLogout.disabled = false;
    btnLogout.textContent = 'Log Out';
  }
  qrPanel.classList.add('hidden');
  setWaStatus('online', `Connected: ${name || number || 'Active'}`);
  addLog(`WhatsApp client ready. Connected as ${name || 'User'} (${number || 'Active'})`, 'success');
  toast(`Connected as ${name || 'User'}`, 'success');
  fetchDetectedGroups();
});

socket.on('wa:disconnected', ({ reason }) => {
  setWaStatus('offline', 'Disconnected');
  addLog(`WhatsApp client disconnected: ${reason}`, 'warn');
  toast('WhatsApp disconnected', 'error');
});

socket.on('wa:auth_failure', ({ message }) => {
  setWaStatus('offline', 'Auth Failed');
  addLog(`Authentication failure: ${message}`, 'error');
  toast('Authentication failed', 'error');
});

socket.on('wa:logged_out', ({ message }) => {
  setWaStatus('offline', 'Logged Out');
  qrPanel.classList.remove('hidden');
  qrContainer.innerHTML = '<div class="qr-spinner">Session purged. Generating fresh QR code...</div>';
  addLog(message || 'Session revoked and cache purged. Awaiting fresh QR code...', 'warn');
  toast('Session revoked and cache purged', 'info');
});

socket.on('wa:error', ({ message }) => {
  addLog(`WhatsApp error: ${message}`, 'error');
});

// ═══════════════════════════════════════════════════════════ LIVE CONFIG SYNC

socket.on('config:updated', (state) => {
  syncStateToUI(state);
});

socket.on('log:event', (ev) => {
  const types = {
    countdown: 'success',
    scheduled_post: 'success',
    daily_alarm: 'success',
    test_message: 'success',
    bot_command: 'info',
    moderation: 'warn',
  };
  addLog(`[${(ev.type || 'EVENT').toUpperCase()}] ${ev.message || ''}`, types[ev.type] || 'info');
});

socket.on('connect', () => {
  addLog('Workspace connected. Listening for activity.', 'info');
});
socket.on('disconnect', () => {
  addLog('Connection to the server was lost. Reconnecting...', 'warn');
  setWaStatus('offline', 'Server Offline');
});

// ═══════════════════════════════════════════════════════════ API HELPERS

async function apiGet(path) {
  const res = await fetch(`${API_ORIGIN}/api${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let approvalQueue = Promise.resolve();
function requestApproval() {
  const request = approvalQueue.then(() => new Promise((resolve) => {
    const dialog = document.getElementById('approval-dialog');
    const form = document.getElementById('approval-form');
    const password = document.getElementById('approval-password');
    const code = document.getElementById('approval-code');
    const cancel = document.getElementById('approval-cancel');
    const finish = (credentials) => {
      form.removeEventListener('submit', submit);
      cancel.removeEventListener('click', abort);
      dialog.removeEventListener('cancel', abort);
      dialog.close(); password.value = ''; code.value = '';
      resolve(credentials);
    };
    const submit = (event) => { event.preventDefault(); finish({ password: password.value, code: code.value }); };
    const abort = (event) => { event.preventDefault(); finish(null); };
    form.addEventListener('submit', submit);
    cancel.addEventListener('click', abort);
    dialog.addEventListener('cancel', abort);
    dialog.showModal(); password.focus();
  }));
  approvalQueue = request.then(() => {});
  return request;
}

async function approvedFetch(url, options) {
  let res = await fetch(url, options);
  if (res.status !== 401) return res;
  const first = await res.clone().json().catch(() => ({}));
  if (!first.approvalRequired) return res;
  const credentials = await requestApproval();
  if (!credentials) throw new Error('Approval cancelled');
  res = await fetch(url, { ...options, headers: { ...(options.headers || {}),
    'X-Approval-Password': encodeURIComponent(credentials.password), 'X-Approval-Code': credentials.code } });
  return res;
}

async function apiPost(path, body) {
  const res = await approvedFetch(`${API_ORIGIN}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiPatch(path, body) {
  const res = await approvedFetch(`${API_ORIGIN}/api${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiDelete(path, body = null) {
  const options = { method: 'DELETE' };
  if (body) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await approvedFetch(`${API_ORIGIN}/api${path}`, options);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiPostForm(apiPath, formData) {
  const res  = await approvedFetch(`${API_ORIGIN}/api${apiPath}`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Upload request failed');
  return data;
}

// ═══════════════════════════════════════════════════════════ MULTI-GROUP TARGET MANAGEMENT

const groupInput         = document.getElementById('group-name-input');
const groupSelect        = document.getElementById('group-detected-select');
const btnAddGroup        = document.getElementById('btn-add-group');
const btnRefreshGroups   = document.getElementById('btn-refresh-groups');
const filterAdminOnlyEl  = document.getElementById('filter-admin-only');
const targetCardsContainer = document.getElementById('target-groups-cards-container');
const targetGroupsCountEl  = document.getElementById('target-groups-count');

const groupsListViewEl     = document.getElementById('groups-list-view');
const groupWorkspaceViewEl = document.getElementById('group-workspace-view');
const workspaceGroupNameEl = document.getElementById('workspace-group-name');
const btnBackToGroups      = document.getElementById('btn-back-to-groups');
const btnWorkspaceRemove   = document.getElementById('btn-workspace-remove-group');

const testTargetSelect     = document.getElementById('test-target-select');

let currentTargetGroups = [];
let activeTargetGroup   = null;
let activeServiceId     = 'dispatch';
const serviceLabels = { dispatch: 'Send a message', countdown: 'Countdown', posts: 'Scheduled posts', alarms: 'Daily alarms', commands: 'Bot commands' };

function selectService(serviceId) {
  activeServiceId = serviceId;

  // Update left-to-right service cards selection
  document.querySelectorAll('.service-card[data-service]').forEach((card) => {
    card.setAttribute('aria-selected', String(card.dataset.service === serviceId));
    card.tabIndex = card.dataset.service === serviceId ? 0 : -1;
    if (card.dataset.service === serviceId) {
      card.classList.add('is-selected');
    } else {
      card.classList.remove('is-selected');
    }
  });

  // Switch active configuration view
  document.querySelectorAll('.service-config-view').forEach((view) => {
    view.classList.remove('is-active');
  });

  const activeView = document.getElementById(`service-view-${serviceId}`);
  if (activeView) {
    activeView.classList.add('is-active');
  }
  if (activeTargetGroup) updateWorkspaceHeading(serviceLabels[serviceId]);
}

// Attach click listeners to all service cards
document.querySelectorAll('.service-card[data-service]').forEach((card) => {
  card.setAttribute('role', 'tab');
  card.id = `service-tab-${card.dataset.service}`;
  card.setAttribute('aria-controls', `service-view-${card.dataset.service}`);
  card.setAttribute('aria-selected', String(card.dataset.service === activeServiceId));
  card.tabIndex = card.dataset.service === activeServiceId ? 0 : -1;
  const panel = document.getElementById(`service-view-${card.dataset.service}`);
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', card.id);
  card.addEventListener('click', () => {
    selectService(card.dataset.service);
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectService(card.dataset.service);
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...document.querySelectorAll('.service-card[data-service]')];
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (tabs.indexOf(card) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectService(tabs[index].dataset.service);
      tabs[index].focus();
    }
  });
});

function openGroupWorkspace(groupName) {
  activeTargetGroup = groupName;
  document.body.classList.add('workspace-open');
  document.getElementById('group-configuration').open = false;
  if (workspaceGroupNameEl) {
    workspaceGroupNameEl.textContent = groupName;
  }

  // Pre-select this group in the Direct Message Dispatcher
  if (testTargetSelect) {
    const opt = Array.from(testTargetSelect.options).find((o) => o.value === groupName);
    if (opt) testTargetSelect.value = groupName;
  }

  if (groupsListViewEl) groupsListViewEl.classList.add('hidden');
  if (groupWorkspaceViewEl) groupWorkspaceViewEl.classList.remove('hidden');

  selectService(activeServiceId || 'dispatch');
}

function closeGroupWorkspace() {
  activeTargetGroup = null;
  document.body.classList.remove('workspace-open');
  if (groupWorkspaceViewEl) groupWorkspaceViewEl.classList.add('hidden');
  if (groupsListViewEl) groupsListViewEl.classList.remove('hidden');
  updateWorkspaceHeading();
}

function updateWorkspaceHeading(label = 'Overview') {
  document.getElementById('breadcrumb-current').textContent = label;
  document.getElementById('page-title').textContent = label === 'Overview' ? 'A little planning. A lot of connection.' : label;
  document.getElementById('page-description').textContent = label === 'Overview'
    ? 'Manage your groups and let your messages take care of themselves.'
    : `Workspace for ${activeTargetGroup}. Manage your messages and group automations here.`;
  document.querySelectorAll('.sidebar__nav .nav-link').forEach((link) => {
    const selected = label === 'Overview' ? link.hasAttribute('data-overview') : link.dataset.navService === activeServiceId;
    link.classList.toggle('is-active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function showAddGroup() {
  const section = document.getElementById('group-configuration');
  section.open = true;
  section.scrollIntoView({ block: 'center' });
  groupInput.focus({ preventScroll: true });
}

document.querySelectorAll('[data-add-group]').forEach((button) => button.addEventListener('click', showAddGroup));
document.querySelectorAll('[data-overview]').forEach((button) => button.addEventListener('click', (event) => {
  event.preventDefault();
  closeGroupWorkspace();
  window.scrollTo({ top: 0 });
}));
document.querySelectorAll('[data-nav-service]').forEach((button) => button.addEventListener('click', () => {
  if (!currentTargetGroups.length) {
    toast('Add a target group to set up your automations.', 'info');
    showAddGroup();
    return;
  }
  openGroupWorkspace(activeTargetGroup || currentTargetGroups[0]);
  selectService(button.dataset.navService);
  window.scrollTo({ top: 0 });
}));
document.getElementById('btn-connection').addEventListener('click', () => {
  if (waBadge.classList.contains('status-badge--online')) {
    toast(waText.textContent, 'success');
  } else {
    qrPanel.classList.remove('hidden');
    qrPanel.scrollIntoView({ block: 'center' });
    if (!qrContainer.querySelector('img')) {
      qrContainer.textContent = 'Waiting for the WhatsApp connection. A QR code will appear here when it is ready.';
    }
  }
});

if (btnBackToGroups) {
  btnBackToGroups.addEventListener('click', closeGroupWorkspace);
}

if (btnWorkspaceRemove) {
  btnWorkspaceRemove.addEventListener('click', async () => {
    if (!activeTargetGroup) return;
    const toRemove = activeTargetGroup;
    try {
      await apiDelete('/groups/target', { name: toRemove });
      toast(`Removed group: ${toRemove}`, 'info');
      addLog(`Removed target group: "${toRemove}"`, 'warn');
      closeGroupWorkspace();
    } catch (err) {
      toast(`Error removing group: ${err.message}`, 'error');
    }
  });
}

async function fetchDetectedGroups() {
  if (btnRefreshGroups) btnRefreshGroups.disabled = true;
  try {
    const adminOnly = filterAdminOnlyEl ? filterAdminOnlyEl.checked : false;
    const query = adminOnly ? '?adminOnly=true' : '';
    const data = await apiGet(`/groups${query}`);
    if (data.ok && Array.isArray(data.groups)) {
      groupSelect.innerHTML = '<option value="">-- Select Detected WhatsApp Group --</option>';
      data.groups.forEach((g) => {
        const opt = document.createElement('option');
        opt.value = g.name;
        const roleBadge = g.isAdmin ? '[ADMIN]' : '[MEMBER]';
        opt.textContent = `${g.name} ${roleBadge} (${g.id.split('@')[0]})`;
        groupSelect.appendChild(opt);
      });
      const filterLabel = adminOnly ? 'Admin Only' : 'All';
      addLog(`Discovered ${data.groups.length} active group chats on WhatsApp (Filter: ${filterLabel}).`, 'info');
    }
  } catch (err) {
    // Client may not be ready yet
  } finally {
    if (btnRefreshGroups) btnRefreshGroups.disabled = false;
  }
}

if (groupSelect) {
  groupSelect.addEventListener('change', () => {
    if (groupSelect.value) {
      groupInput.value = groupSelect.value;
    }
  });
}

if (btnRefreshGroups) {
  btnRefreshGroups.addEventListener('click', fetchDetectedGroups);
}

if (filterAdminOnlyEl) {
  filterAdminOnlyEl.addEventListener('change', fetchDetectedGroups);
}

if (btnAddGroup) {
  btnAddGroup.addEventListener('click', async () => {
    const name = groupInput.value.trim();
    if (!name) {
      toast('Please enter or select a group name', 'error');
      return;
    }
    try {
      await apiPost('/groups/target', { name });
      groupInput.value = '';
      if (groupSelect) groupSelect.value = '';
      toast(`Group added: ${name}`, 'success');
      addLog(`Added target group: "${name}"`, 'success');
      openGroupWorkspace(name);
    } catch (err) {
      toast(`Error adding group: ${err.message}`, 'error');
    }
  });
}

function renderTargetGroups(groups) {
  currentTargetGroups = Array.isArray(groups) ? groups : [];

  if (targetGroupsCountEl) {
    const count = currentTargetGroups.length;
    targetGroupsCountEl.textContent = `${count} Group${count === 1 ? '' : 's'} Configured`;
  }

  // Update Direct Message Dispatcher recipient target options
  if (testTargetSelect) {
    const prevVal = testTargetSelect.value;
    testTargetSelect.innerHTML = '<option value="__ALL__">All Configured Target Groups</option>';
    currentTargetGroups.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      testTargetSelect.appendChild(opt);
    });
    if (activeTargetGroup && Array.from(testTargetSelect.options).some((o) => o.value === activeTargetGroup)) {
      testTargetSelect.value = activeTargetGroup;
    } else if (prevVal && Array.from(testTargetSelect.options).some((o) => o.value === prevVal)) {
      testTargetSelect.value = prevVal;
    }
  }

  if (!targetCardsContainer) return;

  if (currentTargetGroups.length === 0) {
    closeGroupWorkspace();
    targetCardsContainer.innerHTML = `
      <div class="empty-group-prompt" id="no-groups-hint">
        <span class="card__tag">[STANDBY]</span>
        <h3>No Target Groups Configured</h3>
        <p>Add or select a WhatsApp group above to create its card.</p>
      </div>
    `;
    return;
  }

  targetCardsContainer.innerHTML = '';

  currentTargetGroups.forEach((groupName) => {
    const card = document.createElement('div');
    card.className = 'group-tile-card';
    card.dataset.group = groupName;

    card.innerHTML = `
      <div class="group-tile-card__top">
        <span class="group-avatar" aria-hidden="true">${escHtml(groupName.trim().slice(0, 2).toUpperCase())}</span>
        <span class="hud-status">Configured</span>
      </div>
      <h3 class="group-tile-card__name">${escHtml(groupName)}</h3>
      <p class="group-tile-card__desc">Messages, countdowns & scheduled reminders</p>
      <div class="group-tile-card__footer">
        <button class="btn btn--primary btn--sm btn-open-group" type="button" aria-label="Open workspace for ${escHtml(groupName)}">Open workspace &rarr;</button>
        <button class="btn btn--danger btn--sm btn-delete-group" type="button" title="Remove group">Remove</button>
      </div>
    `;

    // Clicking anywhere on card or "Open Services" button enters group workspace
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-group')) return;
      openGroupWorkspace(groupName);
    });

    // Remove group click
    const btnDel = card.querySelector('.btn-delete-group');
    if (btnDel) {
      btnDel.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await apiDelete('/groups/target', { name: groupName });
          if (activeTargetGroup === groupName) {
            closeGroupWorkspace();
          }
          toast(`Removed group: ${groupName}`, 'info');
          addLog(`Removed target group: "${groupName}"`, 'warn');
        } catch (err) {
          toast(`Error removing group: ${err.message}`, 'error');
        }
      });
    }

    targetCardsContainer.appendChild(card);
  });

  // If already inside workspace, update title or close if group removed
  if (activeTargetGroup) {
    if (currentTargetGroups.includes(activeTargetGroup)) {
      if (workspaceGroupNameEl) workspaceGroupNameEl.textContent = activeTargetGroup;
    } else {
      closeGroupWorkspace();
    }
  }
}

// ═══════════════════════════════════════════════════════════ DIRECT / TEST MESSAGE DISPATCHER

const testMessageInput  = document.getElementById('test-message');
const testMediaInput    = document.getElementById('test-media');
const testMediaName     = document.getElementById('test-media-name');
const testMediaPreview  = document.getElementById('test-media-preview');
const testMediaClear    = document.getElementById('test-media-clear');
const btnSendTest       = document.getElementById('btn-send-test');
const testSendStatus    = document.getElementById('test-send-status');

wireMediaPicker(testMediaInput, testMediaName, testMediaPreview, testMediaClear);

if (btnSendTest) {
  btnSendTest.addEventListener('click', async () => {
    const message = (testMessageInput?.value || '').trim();
    const hasFile = testMediaInput?.files && testMediaInput.files[0];

    if (!message && !hasFile) {
      toast('Please enter a message or attach a file', 'error');
      return;
    }

    const target = testTargetSelect ? testTargetSelect.value : '__ALL__';

    btnSendTest.disabled = true;
    btnSendTest.textContent = 'Sending...';
    if (testSendStatus) testSendStatus.textContent = 'Dispatching message to WhatsApp...';

    try {
      const fd = new FormData();
      fd.append('target', target);
      fd.append('message', message);
      if (hasFile) fd.append('media', testMediaInput.files[0]);

      const res = await apiPostForm('/send-test', fd);

      toast(`Test message delivered to ${res.sentCount} group(s)`, 'success');
      addLog(`Direct test message delivered to ${res.sentCount} group(s)`, 'success');

      if (testMessageInput) testMessageInput.value = '';
      clearMediaPicker(testMediaInput, testMediaName, testMediaPreview, testMediaClear);
      if (testSendStatus) testSendStatus.textContent = `Delivered successfully to ${res.sentCount} group(s).`;
    } catch (err) {
      toast(`Delivery failed: ${err.message}`, 'error');
      addLog(`Direct test dispatch failed: ${err.message}`, 'error');
      if (testSendStatus) testSendStatus.textContent = `Error: ${err.message}`;
    } finally {
      btnSendTest.disabled = false;
      btnSendTest.textContent = 'Send Test Message Now';
    }
  });
}

// ═══════════════════════════════════════════════════════════ COUNTDOWN MODULE

const countdownEnabled        = document.getElementById('countdown-enabled');
const countdownTitle          = document.getElementById('countdown-title');
const countdownStartDate      = document.getElementById('countdown-start-date');
const countdownDate           = document.getElementById('countdown-date');
const countdownTemplate       = document.getElementById('countdown-template');
const countdownDailyTime      = document.getElementById('countdown-daily-time');
const countdownMediaInput     = document.getElementById('countdown-media');
const countdownMediaName      = document.getElementById('countdown-media-name');
const countdownMediaPreview   = document.getElementById('countdown-media-preview');
const countdownMediaClear     = document.getElementById('countdown-media-clear');
const countdownPreview        = document.getElementById('countdown-preview');
const countdownPreviewText    = document.getElementById('countdown-preview-text');
const countdownPreviewMedia   = document.getElementById('countdown-preview-media');
const btnSaveCountdown        = document.getElementById('btn-save-countdown');
const btnPreviewCountdown     = document.getElementById('btn-preview-countdown');
const btnBroadcastCountdown   = document.getElementById('btn-broadcast-countdown');

let countdownMediaRemoved = false;
let countdownDirty = false;
let countdownSavedMedia = null;
let countdownDailyContent = {};
let dayDirty = false;
let dayMediaCleared = false;
const dayDate = document.getElementById('countdown-day-date');
const dayTitle = document.getElementById('countdown-day-title');
const dayMessage = document.getElementById('countdown-day-message');
const dayMedia = document.getElementById('countdown-day-media');
const dayMediaName = document.getElementById('countdown-day-media-name');
let displayedDay = '';

function showCountdownDay() {
  displayedDay = dayDate.value;
  const day = countdownDailyContent[displayedDay] || {};
  dayTitle.value = day.eventTitle || '';
  dayMessage.value = day.messageTemplate || '';
  dayMedia.value = '';
  dayMediaCleared = false;
  dayDirty = false;
  dayMediaName.textContent = day.mediaName ? `Saved: ${day.mediaName}` : 'Using main poster.';
}
dayDate.addEventListener('change', () => {
  if (dayDirty && !confirm('Discard unsaved changes for this day?')) { dayDate.value = displayedDay; return; }
  showCountdownDay();
});
for (const input of [dayTitle, dayMessage, dayMedia]) input.addEventListener('input', () => { dayDirty = true; });
dayMedia.addEventListener('change', () => {
  dayDirty = true;
  dayMediaCleared = false;
  dayMediaName.textContent = dayMedia.files[0] ? `Selected: ${dayMedia.files[0].name}` : 'Using saved image or main poster.';
});
document.getElementById('countdown-day-clear').addEventListener('click', () => {
  dayMedia.value = '';
  dayMediaCleared = true;
  dayDirty = true;
  dayMediaName.textContent = 'Using main poster after saving.';
});
document.getElementById('countdown-day-save').addEventListener('click', async () => {
  if (!dayDate.value) { toast('Choose a date first', 'error'); return; }
  const fd = new FormData();
  fd.append('eventTitle', dayTitle.value);
  fd.append('messageTemplate', dayMessage.value);
  if (dayMedia.files[0]) fd.append('media', dayMedia.files[0]);
  else if (dayMediaCleared) fd.append('clearMedia', 'true');
  try {
    const res = await apiPostForm(`/countdown/days/${dayDate.value}`, fd);
    countdownDailyContent = res.state.countdown.dailyContent || {};
    showCountdownDay();
    toast('Content for this day saved', 'success');
  } catch (err) { toast(`Could not save this day: ${err.message}`, 'error'); }
});
wireMediaPicker(countdownMediaInput, countdownMediaName, countdownMediaPreview, countdownMediaClear);

for (const input of [countdownEnabled, countdownTitle, countdownStartDate, countdownDate, countdownTemplate, countdownDailyTime, countdownMediaInput]) {
  input?.addEventListener('input', () => { countdownDirty = true; });
  input?.addEventListener('change', () => { countdownDirty = true; });
  input?.addEventListener('input', updateCountdownPreviewText);
  input?.addEventListener('change', updateCountdownPreviewText);
}

function updateCountdownPreviewText() {
  const target = new Date(countdownDate.value ? countdownDate.value + '+05:30' : '');
  countdownPreviewText.textContent = Number.isFinite(target.getTime())
    ? `${countdownTitle.value.trim() || 'Event Countdown'}\n${resolveCountdownTemplate(countdownTemplate.value || 'Only {days} days and {hours} hours left.', target)}`
    : 'Choose an event date to see your countdown message here.';
}

function countdownFormData() {
  const fd = new FormData();
  fd.append('enabled', countdownEnabled.checked);
  fd.append('eventTitle', countdownTitle.value.trim());
  fd.append('startDate', countdownStartDate.value ? new Date(countdownStartDate.value + '+05:30').toISOString() : '');
  if (!countdownDate.value || isNaN(new Date(countdownDate.value + '+05:30').getTime())) {
    throw new Error('Please set a valid event date first');
  }
  fd.append('targetDate', new Date(countdownDate.value + '+05:30').toISOString());
  fd.append('messageTemplate', countdownTemplate.value);
  if (!countdownDailyTime.value) throw new Error('Please choose a daily publish time');
  fd.append('dailyTime', countdownDailyTime.value);
  if (countdownMediaInput.files[0]) fd.append('media', countdownMediaInput.files[0]);
  else if (countdownMediaRemoved) fd.append('clearMedia', 'true');
  return fd;
}

function showCountdownMedia(previewEl) {
  if (!previewEl) return;
  const file = countdownMediaInput.files[0];
  if (file) {
    showLocalPreview(file, previewEl);
  } else if (!countdownMediaRemoved && countdownSavedMedia?.mediaUrl) {
    clearMediaPicker(null, null, previewEl, null);
    const url = countdownSavedMedia.mediaUrl;
    const fullUrl = url.startsWith('http') ? url : API_ORIGIN + url;
    const tag = /\.(mp4|mov|webm|mkv)$/i.test(url) ? 'video' : 'img';
    previewEl.innerHTML = `<${tag} src="${escAttr(fullUrl)}" ${tag === 'video' ? 'controls muted' : 'alt="Event poster"'} />`;
    previewEl.classList.remove('hidden');
  } else {
    clearMediaPicker(null, null, previewEl, null);
  }
}

function acceptCountdownState(state) {
  countdownDirty = false;
  countdownMediaRemoved = false;
  countdownMediaInput.value = '';
  if (state) syncStateToUI(state);
}

if (countdownMediaClear) {
  countdownMediaClear.addEventListener('click', () => {
    countdownMediaRemoved = true;
    countdownDirty = true;
    showCountdownMedia(countdownPreviewMedia);
  });
}
if (countdownMediaInput) {
  countdownMediaInput.addEventListener('change', () => {
    if (countdownMediaInput.files.length) countdownMediaRemoved = false;
    showCountdownMedia(countdownPreviewMedia);
  });
}

if (btnSaveCountdown) {
  btnSaveCountdown.addEventListener('click', async () => {
    try {
      const res = await apiPostForm('/countdown', countdownFormData());
      acceptCountdownState(res.state);
      toast('Countdown configuration & poster saved', 'success');
      addLog('Countdown configuration updated (with unified poster & message).', 'success');
    } catch (err) {
      toast(`Error saving countdown: ${err.message}`, 'error');
    }
  });
}

if (btnPreviewCountdown) {
  btnPreviewCountdown.addEventListener('click', () => {
    const targetDate = new Date(countdownDate.value ? countdownDate.value + '+05:30' : '');
    if (isNaN(targetDate.getTime())) {
      toast('Please set a valid target date first', 'error');
      return;
    }
    const template = countdownTemplate.value || 'Only {days} days and {hours} hours left.';
    const resolved = resolveCountdownTemplate(template, targetDate);
    countdownPreviewText.textContent = `${countdownTitle.value.trim() || 'Event Countdown'}\n${resolved}`;
    showCountdownMedia(countdownPreviewMedia);
    countdownPreview.classList.remove('hidden');
  });
}

if (btnBroadcastCountdown) {
  btnBroadcastCountdown.addEventListener('click', async () => {
    btnBroadcastCountdown.disabled = true;
    btnBroadcastCountdown.textContent = 'Broadcasting...';
    try {
      const res = await apiPostForm('/countdown/broadcast', countdownFormData());
      acceptCountdownState(res.state);
      toast(`Countdown broadcast sent to ${res.sentCount} group(s)`, 'success');
      addLog(`Manual countdown broadcast dispatched to ${res.sentCount} group(s)`, 'success');
    } catch (err) {
      toast(`Countdown broadcast failed: ${err.message}`, 'error');
      addLog(`Countdown broadcast failed: ${err.message}`, 'error');
    } finally {
      btnBroadcastCountdown.disabled = false;
      btnBroadcastCountdown.textContent = 'Broadcast Countdown Now';
    }
  });
}

function resolveCountdownTemplate(template, targetDate) {
  const diffMs = targetDate.getTime() - Date.now();
  if (diffMs <= 0) return template.replace(/\{days\}/gi,'0').replace(/\{hours\}/gi,'0').replace(/\{minutes\}/gi,'0').replace(/\{seconds\}/gi,'0');
  const totalSec = Math.floor(diffMs / 1000);
  const days    = Math.floor(totalSec / 86400);
  const hours   = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return template
    .replace(/\{days\}/gi,    String(days))
    .replace(/\{hours\}/gi,   String(hours))
    .replace(/\{minutes\}/gi, String(minutes))
    .replace(/\{seconds\}/gi, String(seconds));
}

// ═══════════════════════════════════════════════════════════ SCHEDULED POSTS

const postDateInput    = document.getElementById('post-date');
const postMessageInput = document.getElementById('post-message');
const postMediaInput   = document.getElementById('post-media');
const postMediaName    = document.getElementById('post-media-name');
const postMediaPreview = document.getElementById('post-media-preview');
const postMediaClear   = document.getElementById('post-media-clear');
const btnAddPost       = document.getElementById('btn-add-post');
const postsList        = document.getElementById('posts-list');

wireMediaPicker(postMediaInput, postMediaName, postMediaPreview, postMediaClear);

if (btnAddPost) {
  btnAddPost.addEventListener('click', async () => {
    const scheduledDate = new Date(postDateInput.value ? postDateInput.value + '+05:30' : '');
    const message     = postMessageInput.value.trim();
    if (isNaN(scheduledDate.getTime()) || (!message && !postMediaInput.files[0])) {
      toast('Please specify a valid date and a message or attachment', 'error');
      return;
    }
    try {
      const fd = new FormData();
      const scheduledAt = scheduledDate.toISOString();
      fd.append('scheduledAt', scheduledAt);
      fd.append('message',     message);
      if (postMediaInput.files[0]) fd.append('media', postMediaInput.files[0]);

      await apiPostForm('/posts', fd);

      postDateInput.value    = '';
      postMessageInput.value = '';
      clearMediaPicker(postMediaInput, postMediaName, postMediaPreview, postMediaClear);
      toast('Scheduled post registered', 'success');
      addLog(`Scheduled post queued for ${fmtSriLankaDate(scheduledAt)}`, 'success');
    } catch (err) {
      toast(`Error creating post: ${err.message}`, 'error');
    }
  });
}

function renderPosts(posts) {
  if (!postsList) return;
  if (!posts || posts.length === 0) {
    postsList.innerHTML = '<div class="item-list__empty">No scheduled posts queued.</div>';
    return;
  }
  postsList.innerHTML = '';
  [...posts]
    .sort((a, b) => {
      if (a.sent !== b.sent) return a.sent ? 1 : -1;
      return new Date(a.scheduledAt) - new Date(b.scheduledAt);
    })
    .forEach((post) => {
      const card = document.createElement('div');
      card.className = `item-card ${post.sent ? 'item-card--sent' : ''}`;
      const mediaBadge = post.mediaUrl
        ? `<a class="media-badge" href="${escAttr(post.mediaUrl.startsWith('http') ? post.mediaUrl : (API_ORIGIN + post.mediaUrl))}" target="_blank" rel="noopener">
             ${mediaIcon(post.mediaUrl)} ${escHtml(post.mediaName || 'Attachment')}
           </a>`
        : '';
      card.innerHTML = `
        <div class="item-card__header">
          <span class="item-card__time">Scheduled: ${fmtSriLankaDate(post.scheduledAt)}</span>
          <span class="item-card__badge ${post.sent ? 'badge--sent' : 'badge--pending'}">
            ${post.sent ? 'Sent' : 'Pending'}
          </span>
          ${post.sent ? '' : `<button class="btn btn--danger btn--sm ml-auto" data-delete-post="${escAttr(post.id)}" title="Delete post">Delete</button>`}
        </div>
        ${mediaBadge}
        <div class="item-card__message">${escHtml(post.message)}</div>
        ${post.lastError && !post.sent ? `<div class="field-hint">Delivery pending: ${escHtml(post.lastError)}. Will retry automatically.</div>` : ''}
        ${post.sentAt ? `<div class="field-hint">Delivered at: ${fmtSriLankaDate(post.sentAt)}</div>` : ''}
      `;
      postsList.appendChild(card);
    });

  postsList.querySelectorAll('[data-delete-post]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-post');
      try {
        await apiDelete(`/posts/${id}`);
        toast('Scheduled post deleted', 'info');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════ DAILY ALARMS

const alarmTimeInput    = document.getElementById('alarm-time');
const alarmMessageInput = document.getElementById('alarm-message');
const alarmMediaInput   = document.getElementById('alarm-media');
const alarmMediaName    = document.getElementById('alarm-media-name');
const alarmMediaPreview = document.getElementById('alarm-media-preview');
const alarmMediaClear   = document.getElementById('alarm-media-clear');
const btnAddAlarm       = document.getElementById('btn-add-alarm');
const alarmsList        = document.getElementById('alarms-list');

wireMediaPicker(alarmMediaInput, alarmMediaName, alarmMediaPreview, alarmMediaClear);

if (btnAddAlarm) {
  btnAddAlarm.addEventListener('click', async () => {
    const time    = alarmTimeInput.value;
    const message = alarmMessageInput.value.trim();
    if (!time || !message) {
      toast('Please specify daily alarm time and message', 'error');
      return;
    }
    try {
      const fd = new FormData();
      fd.append('time',    time);
      fd.append('message', message);
      fd.append('enabled', 'true');
      if (alarmMediaInput.files[0]) fd.append('media', alarmMediaInput.files[0]);

      await apiPostForm('/alarms', fd);

      alarmTimeInput.value    = '';
      alarmMessageInput.value = '';
      clearMediaPicker(alarmMediaInput, alarmMediaName, alarmMediaPreview, alarmMediaClear);
      toast('Daily alarm registered', 'success');
      addLog(`Daily alarm configured for ${time}`, 'success');
    } catch (err) {
      toast(`Error creating alarm: ${err.message}`, 'error');
    }
  });
}

function renderAlarms(alarms) {
  if (!alarmsList) return;
  if (!alarms || alarms.length === 0) {
    alarmsList.innerHTML = '<div class="item-list__empty">No daily alarms configured.</div>';
    return;
  }
  alarmsList.innerHTML = '';
  [...alarms]
    .sort((a, b) => a.time.localeCompare(b.time))
    .forEach((alarm) => {
      const card = document.createElement('div');
      card.className = 'item-card';
      const mediaBadge = alarm.mediaUrl
        ? `<a class="media-badge" href="${escAttr(alarm.mediaUrl.startsWith('http') ? alarm.mediaUrl : (API_ORIGIN + alarm.mediaUrl))}" target="_blank" rel="noopener">
             ${mediaIcon(alarm.mediaUrl)} ${escHtml(alarm.mediaName || 'Attachment')}
           </a>`
        : '';
      card.innerHTML = `
        <div class="item-card__header">
          <span class="item-card__time">Alarm: ${escHtml(alarm.time)}</span>
          <span class="item-card__badge ${alarm.enabled ? 'badge--enabled' : 'badge--disabled'}">
            ${alarm.enabled ? 'Active' : 'Paused'}
          </span>
          <div class="item-card__actions ml-auto">
            <button class="btn btn--secondary btn--sm" data-toggle-alarm="${escAttr(alarm.id)}" data-enabled="${alarm.enabled}">
              ${alarm.enabled ? 'Pause' : 'Activate'}
            </button>
            <button class="btn btn--danger btn--sm" data-delete-alarm="${escAttr(alarm.id)}" title="Delete alarm">Delete</button>
          </div>
        </div>
        ${mediaBadge}
        <div class="item-card__message">${escHtml(alarm.message)}</div>
        ${alarm.lastFiredDate ? `<div class="field-hint">Last fired on: ${escHtml(alarm.lastFiredDate)}</div>` : ''}
      `;
      alarmsList.appendChild(card);
    });

  alarmsList.querySelectorAll('[data-toggle-alarm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id      = btn.getAttribute('data-toggle-alarm');
      const enabled = btn.getAttribute('data-enabled') === 'true';
      try {
        await apiPatch(`/alarms/${id}`, { enabled: !enabled });
        toast(`Alarm ${!enabled ? 'activated' : 'paused'}`, 'info');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      }
    });
  });

  alarmsList.querySelectorAll('[data-delete-alarm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-alarm');
      try {
        await apiDelete(`/alarms/${id}`);
        toast('Daily alarm deleted', 'info');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════ BOT COMMANDS MODULE

const commandsEnabled         = document.getElementById('commands-enabled');
const commandPrefix           = document.getElementById('command-prefix');
const commandCooldown         = document.getElementById('command-cooldown');
const commandRestrictGroups   = document.getElementById('command-restrict-groups');
const commandStrictMode       = document.getElementById('command-strict-mode');
const commandStrictAdmins     = document.getElementById('command-strict-admins');
const commandStrictWarn       = document.getElementById('command-strict-warn');
const commandWarningTemplate  = document.getElementById('command-warning-template');
const commandWarningAutodel   = document.getElementById('command-warning-autodel');
const btnSaveCommandSettings  = document.getElementById('btn-save-command-settings');
const newCmdTrigger           = document.getElementById('new-cmd-trigger');
const newCmdDesc              = document.getElementById('new-cmd-desc');
const newCmdResponse          = document.getElementById('new-cmd-response');
const btnAddCommand           = document.getElementById('btn-add-command');
const commandsList            = document.getElementById('commands-list');

function renderCommands(commands, prefix = '!') {
  if (!commandsList) return;
  commandsList.innerHTML = '';

  if (!Array.isArray(commands) || commands.length === 0) {
    commandsList.innerHTML = '<div class="item-list__empty">No interactive commands registered.</div>';
    return;
  }

  commands.forEach((cmd) => {
    const card = document.createElement('div');
    card.className = `item-card ${!cmd.enabled ? 'item-card--sent' : ''}`;

    const isSystem = cmd.action && cmd.action !== 'custom';
    const actionLabel = isSystem ? `System (${cmd.action})` : 'Custom Reply';
    const badgeClass = cmd.enabled ? 'badge--enabled' : 'badge--disabled';
    const statusText = cmd.enabled ? 'Active' : 'Disabled';

    card.innerHTML = `
      <div class="item-card__header">
        <span class="item-card__time">${escHtml(prefix)}${escHtml(cmd.trigger)}</span>
        <span class="hud-header__tag" style="background: ${isSystem ? 'var(--color-blue)' : 'var(--color-purple)'}">${escHtml(actionLabel)}</span>
        <span class="item-card__badge ${badgeClass}">${statusText}</span>
        <div class="item-card__actions ml-auto">
          <button class="btn btn--ghost btn--sm" data-toggle-cmd="${escAttr(cmd.id)}" title="Toggle command active state">
            ${cmd.enabled ? 'Pause' : 'Activate'}
          </button>
          ${!isSystem ? `<button class="btn btn--danger btn--sm" data-delete-cmd="${escAttr(cmd.id)}" title="Delete custom command">Delete</button>` : ''}
        </div>
      </div>
      <div class="item-card__message">${escHtml(cmd.description || 'No description.')}</div>
      ${cmd.response ? `<div class="countdown-preview mt-sm"><span class="preview-label">Reply:</span><span class="preview-text">${escHtml(cmd.response)}</span></div>` : ''}
    `;
    commandsList.appendChild(card);
  });

  // Wire toggle and delete buttons
  commandsList.querySelectorAll('[data-toggle-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-toggle-cmd');
      try {
        await apiPost(`/commands/toggle/${id}`);
        toast('Command state updated', 'info');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      }
    });
  });

  commandsList.querySelectorAll('[data-delete-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-cmd');
      if (!confirm('Are you sure you want to delete this custom command?')) return;
      try {
        await apiDelete(`/commands/items/${id}`);
        toast('Custom command removed', 'info');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      }
    });
  });
}

// Master Toggle
if (commandsEnabled) {
  commandsEnabled.addEventListener('change', async () => {
    try {
      await apiPost('/commands/settings', { enabled: commandsEnabled.checked });
      toast(`Bot commands ${commandsEnabled.checked ? 'enabled' : 'disabled'}`, 'info');
    } catch (err) {
      toast(`Error: ${err.message}`, 'error');
    }
  });
}

// Save Settings Button
if (btnSaveCommandSettings) {
  btnSaveCommandSettings.addEventListener('click', async () => {
    const prefix = (commandPrefix?.value || '!').trim();
    const cooldownSeconds = parseInt(commandCooldown?.value || '3', 10);
    const allowedInTargetGroupsOnly = commandRestrictGroups ? commandRestrictGroups.checked : true;
    const strictCommandMode = commandStrictMode ? commandStrictMode.checked : false;
    const strictIgnoreAdmins = commandStrictAdmins ? commandStrictAdmins.checked : true;
    const warnSender = commandStrictWarn ? commandStrictWarn.checked : true;
    const warningTemplate = (commandWarningTemplate?.value || '').trim();
    const warningAutoDeleteSeconds = parseInt(commandWarningAutodel?.value || '10', 10);

    try {
      await apiPost('/commands/settings', {
        prefix,
        cooldownSeconds,
        allowedInTargetGroupsOnly,
        strictCommandMode,
        strictIgnoreAdmins,
        warnSender,
        warningTemplate,
        warningAutoDeleteSeconds,
      });
      toast('Command & Strict Mode settings saved', 'success');
      addLog(`Command settings updated. Prefix: "${prefix}", Strict Mode: ${strictCommandMode ? 'ON' : 'OFF'}`, 'info');
    } catch (err) {
      toast(`Error saving settings: ${err.message}`, 'error');
    }
  });
}

// Add Custom Command Button
if (btnAddCommand) {
  btnAddCommand.addEventListener('click', async () => {
    const trigger = (newCmdTrigger?.value || '').trim();
    const description = (newCmdDesc?.value || '').trim();
    const response = (newCmdResponse?.value || '').trim();

    if (!trigger) {
      toast('Please enter a command trigger keyword', 'error');
      return;
    }
    if (!response) {
      toast('Please enter a response message for the custom command', 'error');
      return;
    }

    try {
      await apiPost('/commands/items', {
        trigger,
        description,
        response,
        action: 'custom',
        enabled: true,
      });
      if (newCmdTrigger) newCmdTrigger.value = '';
      if (newCmdDesc) newCmdDesc.value = '';
      if (newCmdResponse) newCmdResponse.value = '';
      toast(`Command "${trigger}" added`, 'success');
      addLog(`Custom command added: "${trigger}"`, 'success');
    } catch (err) {
      toast(`Error: ${err.message}`, 'error');
    }
  });
}

// ═══════════════════════════════════════════════════════════ LOGOUT

if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    if (!confirm('Revoke WhatsApp session? Session cache will be purged and a new QR code will be generated.')) {
      return;
    }
    btnLogout.disabled = true;
    btnLogout.textContent = 'Purging...';
    setWaStatus('pending', 'Purging Session');
    qrPanel.classList.remove('hidden');
    qrContainer.innerHTML = '<div class="qr-spinner">Purging cache and generating fresh QR code...</div>';

    try {
      const res = await apiPost('/logout', {});
      toast(res.message || 'Session revoked and cache purged', 'info');
      addLog('Session revoked. Awaiting new QR code...', 'warn');
    } catch (err) {
      toast(`Logout error: ${err.message}`, 'error');
      btnLogout.disabled = false;
      btnLogout.textContent = 'Log Out';
      setWaStatus('offline', 'Error Revoking');
    }
  });
}

// ═══════════════════════════════════════════════════════════ STATE SYNC

function syncStateToUI(state) {
  if (!state) return;
  dashboardState = state;
  updateDashboard(state);

  // Target groups (array or fallback)
  const groups = Array.isArray(state.targetGroups)
    ? state.targetGroups
    : (state.groupTarget?.name ? [state.groupTarget.name] : []);
  renderTargetGroups(groups);

  // Countdown
  if (state.countdown) {
    countdownDailyContent = state.countdown.dailyContent || {};
    dayDate.min = toSriLankaDatetimeValue(state.countdown.startDate).slice(0, 10);
    dayDate.max = toSriLankaDatetimeValue(state.countdown.targetDate).slice(0, 10);
    if (!dayDirty) showCountdownDay();
    countdownSavedMedia = state.countdown;
    if (!countdownDirty) {
      if (countdownTitle)     countdownTitle.value       = state.countdown.eventTitle || '';
      if (countdownEnabled)   countdownEnabled.checked   = !!state.countdown.enabled;
      if (countdownStartDate) countdownStartDate.value   = toSriLankaDatetimeValue(state.countdown.startDate);
      if (countdownDate)      countdownDate.value        = toSriLankaDatetimeValue(state.countdown.targetDate);
      if (countdownTemplate)  countdownTemplate.value    = state.countdown.messageTemplate || '';
      if (countdownDailyTime) countdownDailyTime.value   = state.countdown.dailyTime || '09:00';

      if (!countdownMediaRemoved && !countdownMediaInput.files.length && state.countdown.mediaUrl) {
        if (countdownMediaName) countdownMediaName.textContent = state.countdown.mediaName || 'Attached Poster';
        if (countdownMediaClear) countdownMediaClear.classList.remove('hidden');
        if (countdownMediaPreview) {
          showCountdownMedia(countdownMediaPreview);
        }
      } else if (countdownMediaInput && !countdownMediaInput.files.length) {
        clearMediaPicker(countdownMediaInput, countdownMediaName, countdownMediaPreview, countdownMediaClear);
      }
    }
    showCountdownMedia(countdownPreviewMedia);
    updateCountdownScheduleHint();
    updateCountdownPreviewText();
  }

  // Posts & alarms
  renderPosts(state.scheduledPosts);
  renderAlarms(state.dailyAlarms);

  // Bot commands
  if (state.botCommands) {
    if (commandsEnabled)        commandsEnabled.checked        = !!state.botCommands.enabled;
    if (commandPrefix)          commandPrefix.value            = state.botCommands.prefix || '!';
    if (commandCooldown)        commandCooldown.value          = state.botCommands.cooldownSeconds ?? 3;
    if (commandRestrictGroups)  commandRestrictGroups.checked  = !!state.botCommands.allowedInTargetGroupsOnly;
    if (commandStrictMode)      commandStrictMode.checked      = !!state.botCommands.strictCommandMode;
    if (commandStrictAdmins)    commandStrictAdmins.checked    = state.botCommands.strictIgnoreAdmins !== false;
    if (commandStrictWarn)      commandStrictWarn.checked      = state.botCommands.warnSender !== false;
    if (commandWarningTemplate) commandWarningTemplate.value   = state.botCommands.warningTemplate || '';
    if (commandWarningAutodel)  commandWarningAutodel.value    = state.botCommands.warningAutoDeleteSeconds ?? 10;
    renderCommands(state.botCommands.commands, state.botCommands.prefix || '!');
  }
}

function updateOverviewCountdown() {
  const cfg = dashboardState?.countdown;
  if (!cfg) return;
  const target = new Date(cfg.targetDate).getTime();
  const valid = Number.isFinite(target);
  const remaining = valid ? Math.max(0, Math.floor((target - Date.now()) / 1000)) : 0;
  const values = [Math.floor(remaining / 86400), Math.floor((remaining % 86400) / 3600), Math.floor((remaining % 3600) / 60), remaining % 60];
  ['days', 'hours', 'minutes', 'seconds'].forEach((unit, index) => {
    document.getElementById(`overview-${unit}`).textContent = String(values[index]).padStart(2, '0');
  });
  const expired = valid && target <= Date.now();
  document.getElementById('overview-countdown-status').textContent = !valid ? 'Not configured' : expired ? 'Event ended' : cfg.enabled ? 'Active' : 'Paused';
  document.getElementById('overview-countdown-note').textContent = !valid
    ? 'Add an event, attach a poster, and share the excitement.'
    : expired ? 'This event date has passed. Choose a future date to start a new countdown.'
      : !cfg.enabled ? 'Automatic broadcasts are paused. Enable them in countdown settings.'
        : cfg.dailyTime ? `${cfg.mediaPath ? 'Poster attached · ' : ''}Daily at ${cfg.dailyTime} Sri Lanka time to all target groups.` : 'Choose and save a daily publish time to start automatic broadcasts.';
}

function updateDashboard(state) {
  const groups = state.targetGroups || (state.groupTarget?.name ? [state.groupTarget.name] : []);
  const posts = (state.scheduledPosts || []).filter((post) => !post.sent);
  const alarms = (state.dailyAlarms || []).filter((alarm) => alarm.enabled);
  document.getElementById('metric-groups').textContent = groups.length;
  document.getElementById('metric-posts').textContent = posts.length;
  document.getElementById('nav-post-count').textContent = posts.length;
  document.getElementById('metric-alarms').textContent = alarms.length;
  document.getElementById('posts-card-status').textContent = `${posts.length} queued`;
  document.getElementById('alarms-card-status').textContent = `${alarms.length} active`;
  document.getElementById('commands-card-status').textContent = state.botCommands?.enabled ? 'Enabled' : 'Disabled';
  const cfg = state.countdown || {};
  const target = new Date(cfg.targetDate);
  const valid = Number.isFinite(target.getTime());
  document.getElementById('overview-event-title').textContent = cfg.eventTitle || (valid ? 'Event Countdown' : 'Make every moment count.');
  document.getElementById('overview-event-date').textContent = valid
    ? target.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })
    : 'Create a countdown your group can look forward to.';
  document.getElementById('countdown-card-status').textContent = !valid ? 'Not configured' : target <= new Date() ? 'Event ended' : cfg.enabled ? 'Active' : 'Paused';
  updateOverviewCountdown();
}

function updateCountdownScheduleHint() {
  const target = new Date(countdownDate.value ? countdownDate.value + '+05:30' : '').getTime();
  const hint = document.getElementById('countdown-schedule-hint');
  const expired = Number.isFinite(target) && target <= Date.now();
  hint.classList.toggle('hidden', !expired);
  hint.textContent = expired ? 'This event date has passed. Select a future date to broadcast a countdown.' : '';
}
countdownDate.addEventListener('input', updateCountdownScheduleHint);

// ═══════════════════════════════════════════════════════════ INITIAL LOAD

(async () => {
  try {
    const data = await apiGet('/state');
    if (data.state) {
      if (Array.isArray(data.targetGroups)) {
        data.state.targetGroups = data.targetGroups;
      }
      syncStateToUI(data.state);
    }
  } catch (err) {
    addLog(`Failed to load initial configuration: ${err.message}`, 'error');
  }
})();

// ═══════════════════════════════════════════════════════════ UTILITIES

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

function fmtSriLankaDate(iso) {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short' }) + ' (Sri Lanka time)';
}

function toSriLankaDatetimeValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 16) : '';
}

function fmtDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

// ═══════════════════════════════════════════════════════════ MEDIA PICKER HELPERS

function wireMediaPicker(inputEl, nameEl, previewEl, clearEl) {
  if (!inputEl) return;

  inputEl.addEventListener('change', () => {
    const file = inputEl.files[0];
    if (!file) { clearMediaPicker(inputEl, nameEl, previewEl, clearEl); return; }
    if (nameEl) nameEl.textContent = file.name;
    if (clearEl) clearEl.classList.remove('hidden');
    showLocalPreview(file, previewEl);
  });

  if (clearEl) {
    clearEl.addEventListener('click', () => {
      clearMediaPicker(inputEl, nameEl, previewEl, clearEl);
    });
  }

  const area = inputEl.closest('.media-upload-area');
  if (area) {
    area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragover'); });
    area.addEventListener('dragleave', ()  => area.classList.remove('dragover'));
    area.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('dragover');
      const dt = e.dataTransfer;
      if (dt.files.length) {
        try {
          inputEl.files = dt.files;
        } catch (_) {}
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }
}

function clearMediaPicker(inputEl, nameEl, previewEl, clearEl) {
  if (inputEl) inputEl.value = '';
  if (nameEl)  nameEl.textContent = 'Choose file or drag & drop';
  if (previewEl) {
    if (previewEl.dataset.objectUrl) URL.revokeObjectURL(previewEl.dataset.objectUrl);
    delete previewEl.dataset.objectUrl;
    previewEl.innerHTML = '';
    previewEl.classList.add('hidden');
  }
  if (clearEl)  clearEl.classList.add('hidden');
}

function showLocalPreview(file, previewEl) {
  if (!previewEl) return;
  clearMediaPicker(null, null, previewEl, null);
  const type = file.type || (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name) ? 'image/'
    : /\.(mp4|mov|webm|mkv)$/i.test(file.name) ? 'video/'
      : /\.(mp3|ogg|wav|m4a|aac)$/i.test(file.name) ? 'audio/' : '');
  let el;
  if (type.startsWith('video/')) {
    el = document.createElement('video');
    el.controls = true;
    el.muted    = true;
  } else if (type.startsWith('image/')) {
    el = document.createElement('img');
    el.alt = file.name;
  } else if (type.startsWith('audio/')) {
    el = document.createElement('audio');
    el.controls = true;
  } else {
    previewEl.classList.add('hidden');
    return;
  }
  const url = URL.createObjectURL(file);
  previewEl.dataset.objectUrl = url;
  el.src = url;
  previewEl.appendChild(el);
  previewEl.classList.remove('hidden');
}

function mediaIcon(url) {
  if (!url) return '[MEDIA]';
  const ext = url.split('.').pop().toLowerCase();
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return '[VIDEO]';
  if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return '[IMAGE]';
  if (['mp3','ogg','wav','m4a','aac'].includes(ext)) return '[AUDIO]';
  return '[FILE]';
}
