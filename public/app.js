/**
 * public/app.js
 * HUD frontend controller.
 * Connects to the Socket.IO server, drives all UI panels, and communicates
 * with the REST API for all configuration mutations and test messages.
 */
'use strict';

let dashboardState = null;

// ═══════════════════════════════════════════════════════════ 24-HOUR TIME INPUTS
// Native time pickers follow the browser locale, which is often 12-hour. Each one stays as a
// hidden input holding the value and is shown as a date field plus 24-hour hour/minute selects.
function use24HourTime(input) {
  const withDate = input.type === 'datetime-local';
  const pad = (n) => String(n).padStart(2, '0');
  const select = (count, label) => {
    const el = document.createElement('select');
    el.className = 'field-input time24__part';
    el.setAttribute('aria-label', label);
    el.innerHTML = '<option value="">--</option>' + Array.from({ length: count }, (_, i) => `<option>${pad(i)}</option>`).join('');
    return el;
  };
  const date = withDate ? Object.assign(document.createElement('input'), { type: 'date', className: 'field-input time24__date' }) : null;
  const hour = select(24, 'Hour (00 to 23)');
  const minute = select(60, 'Minute');
  const separator = Object.assign(document.createElement('span'), { className: 'time24__sep', textContent: ':' });
  const wrap = document.createElement('div');
  wrap.className = 'time24';
  wrap.append(...[date, hour, separator, minute].filter(Boolean));
  input.after(wrap);
  input.classList.add('hidden');
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');

  // Labels move to the first visible control.
  const first = date || hour;
  first.id = `${input.id}-picker`;
  document.querySelectorAll(`label[for="${input.id}"]`).forEach((label) => { label.htmlFor = first.id; });

  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const show = (value) => {
    const [day, time = ''] = withDate ? value.split('T') : ['', value];
    if (date) date.value = day || '';
    hour.value = time.slice(0, 2);
    minute.value = time.slice(3, 5);
  };
  // Values set by code (loading saved settings, clearing a form) also update the selects.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return native.get.call(this); },
    set(value) { native.set.call(this, value); show(native.get.call(this)); },
  });
  show(native.get.call(input));

  const update = (event) => {
    let value = '';
    if (date ? date.value : hour.value || minute.value) {
      hour.value ||= '00';
      minute.value ||= '00';
      value = `${date ? `${date.value}T` : ''}${hour.value}:${minute.value}`;
    }
    native.set.call(input, value);
    input.dispatchEvent(new Event(event.type, { bubbles: true }));
  };
  for (const el of [date, hour, minute].filter(Boolean)) {
    el.addEventListener('input', update);
    el.addEventListener('change', update);
  }
}
document.querySelectorAll('input[type="time"], input[type="datetime-local"]').forEach(use24HourTime);

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
  const ts = new Date().toLocaleTimeString('en-GB', { hourCycle: 'h23' });
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
  serverTimeEl.textContent = new Date().toLocaleString('en-GB', { hourCycle: 'h23' });
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
  document.getElementById('approval-setup-panel').classList.toggle('hidden', status !== 'online');
  if (status !== 'online') clearApprovalSetup();
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
  refreshApprovalSetup();
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
  loadPosterLibrary();
});

socket.on('log:event', (ev) => {
  const types = {
    countdown: 'success',
    scheduled_post: 'success',
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

let approvalSetupToken = null;
function clearApprovalSetup() {
  approvalSetupToken = null;
  document.getElementById('approval-setup-details').classList.add('hidden');
  document.getElementById('approval-setup-qr').removeAttribute('src');
  document.getElementById('approval-setup-key').textContent = '';
  document.getElementById('approval-setup-code').value = '';
}
async function refreshApprovalSetup() {
  try {
    const status = await apiGet('/approval/status');
    document.getElementById('approval-setup-status').textContent = status.enabled
      ? 'Authenticator approval is enabled for changes and immediate sends.'
      : 'Protect changes and immediate sends with a code from your authenticator app.';
    document.getElementById('approval-setup-start').classList.toggle('hidden', status.enabled);
    if (status.enabled) clearApprovalSetup();
  } catch (err) { document.getElementById('approval-setup-status').textContent = `Could not check approval: ${err.message}`; }
}
document.getElementById('approval-setup-start').addEventListener('click', async () => {
  try {
    const result = await apiPost('/approval/setup', {});
    approvalSetupToken = result.token;
    document.getElementById('approval-setup-qr').src = result.qrImage;
    document.getElementById('approval-setup-key').textContent = result.key;
    document.getElementById('approval-setup-details').classList.remove('hidden');
  } catch (err) { toast(`Could not start setup: ${err.message}`, 'error'); }
});
document.getElementById('approval-setup-confirm').addEventListener('click', async () => {
  try {
    await apiPost('/approval/confirm', { token: approvalSetupToken, code: document.getElementById('approval-setup-code').value.trim() });
    clearApprovalSetup();
    await refreshApprovalSetup();
    toast('Authenticator approval enabled', 'success');
  } catch (err) { toast(`Could not enable approval: ${err.message}`, 'error'); }
});

let approvalQueue = Promise.resolve();
function requestApproval() {
  const request = approvalQueue.then(() => new Promise((resolve) => {
    const dialog = document.getElementById('approval-dialog');
    const form = document.getElementById('approval-form');
    const code = document.getElementById('approval-code');
    const cancel = document.getElementById('approval-cancel');
    const finish = (credentials) => {
      form.removeEventListener('submit', submit);
      cancel.removeEventListener('click', abort);
      dialog.removeEventListener('cancel', abort);
      dialog.close(); code.value = '';
      resolve(credentials);
    };
    const submit = (event) => { event.preventDefault(); finish({ code: code.value }); };
    const abort = (event) => { event.preventDefault(); finish(null); };
    form.addEventListener('submit', submit);
    cancel.addEventListener('click', abort);
    dialog.addEventListener('cancel', abort);
    dialog.showModal(); code.focus();
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
    'X-Approval-Code': credentials.code } });
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
  if (!data.ok) throw Object.assign(new Error(data.error || 'Upload request failed'), { data });
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
const serviceLabels = { dispatch: 'Send a message', countdown: 'Countdown', posts: 'Scheduled posts', commands: 'Bot commands' };

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
  deactivateSvgEditorPanel();
  activeTargetGroup = groupName;
  document.body.classList.add('workspace-open');
  document.body.classList.remove('service-focus');
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
  deactivateSvgEditorPanel();
  activeTargetGroup = null;
  document.body.classList.remove('workspace-open', 'service-focus');
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
  deactivateSvgEditorPanel();
  document.body.classList.remove('service-focus');
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
  const navServiceId = button.dataset.navService;

  // SVG Editor is a standalone top-level panel — not part of the group workspace
  if (navServiceId === 'svg-editor') {
    activateSvgEditorPanel();
    return;
  }

  if (!currentTargetGroups.length) {
    toast('Add a target group to set up your automations.', 'info');
    showAddGroup();
    return;
  }
  openGroupWorkspace(activeTargetGroup || currentTargetGroups[0]);
  // Sidebar tabs show only the chosen service, without the group workspace around it.
  document.body.classList.add('service-focus');
  selectService(navServiceId);
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
    const testMediaArea = document.getElementById('test-media-area');
    const selectedPosterUrl = testMediaArea?.dataset.selectedPosterUrl;
    const selectedPosterName = testMediaArea?.dataset.selectedPosterName;

    if (!message && !hasFile && !selectedPosterUrl) {
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
      if (hasFile) {
        fd.append('media', testMediaInput.files[0]);
      } else if (selectedPosterUrl) {
        fd.append('mediaUrl', selectedPosterUrl);
        fd.append('mediaName', selectedPosterName || 'poster.png');
      }

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
let countdowns = [];
let selectedCountdownId = null;     // null while creating a new countdown
let countdownSelectionMade = false; // until the user picks one, the first countdown is shown
let countdownDailyContent = {};
let dayDirty = false;
let dayMediaCleared = false;
const dayDate = document.getElementById('countdown-day-date');
const dayTitle = document.getElementById('countdown-day-title');
const dayMessage = document.getElementById('countdown-day-message');
const dayMedia = document.getElementById('countdown-day-media');
const dayMediaName = document.getElementById('countdown-day-media-name');
let displayedDay = '';
const btnNewCountdown = document.getElementById('btn-new-countdown');
const countdownsList = document.getElementById('countdowns-list');

function selectedCountdown() {
  return countdowns.find((cfg) => cfg.id === selectedCountdownId) || null;
}

/** API path for the countdown being edited; new countdowns post to the collection. */
function countdownPath(suffix = '') {
  return selectedCountdownId ? `/countdowns/${selectedCountdownId}${suffix}` : `/countdowns${suffix}`;
}

function countdownTime(cfg) {
  return new Date(cfg?.targetDate).getTime();
}

function countdownStatus(cfg) {
  const target = countdownTime(cfg);
  if (!Number.isFinite(target)) return { label: 'Not configured', badge: 'badge--disabled' };
  if (target <= Date.now()) return { label: 'Event ended', badge: 'badge--disabled' };
  return cfg.enabled ? { label: 'Active', badge: 'badge--enabled' } : { label: 'Paused', badge: 'badge--pending' };
}

/** Upcoming countdowns by target date, then ended ones (most recent first). */
function sortedCountdowns(list = countdowns) {
  const now = Date.now();
  return [...list].sort((a, b) => {
    const ta = countdownTime(a) || 0;
    const tb = countdownTime(b) || 0;
    if ((ta > now) !== (tb > now)) return ta > now ? -1 : 1;
    return ta > now ? ta - tb : tb - ta;
  });
}

/** The countdown featured on the overview: the next active one, else the next upcoming, else the latest. */
function primaryCountdown(list = []) {
  const sorted = sortedCountdowns(list);
  return sorted.find((cfg) => countdownStatus(cfg).label === 'Active') ||
    sorted.find((cfg) => countdownTime(cfg) > Date.now()) || sorted[0] || null;
}

const dayCards = document.getElementById('countdown-day-cards');
const dayEditor = document.getElementById('countdown-day-editor');

/** Sri Lanka calendar date (YYYY-MM-DD) of an ISO timestamp. */
function sriLankaDay(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 10) : '';
}

const MAX_COUNTDOWN_DAYS = 366;

/** Every Sri Lanka calendar date from the start date (or today) to the target date. */
function countdownDays(cfg) {
  const first = sriLankaDay(cfg?.startDate) || sriLankaDay(new Date().toISOString());
  const last = sriLankaDay(cfg?.targetDate);
  const days = [];
  if (!last) return days;
  for (let ms = Date.parse(`${first}T00:00:00Z`); days.length < MAX_COUNTDOWN_DAYS; ms += 86400000) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (day > last) break;
    days.push(day);
  }
  return days;
}

/** The countdown as currently entered in the form, falling back to its saved poster. */
function countdownDraft() {
  const saved = selectedCountdown() || {};
  const iso = (value) => {
    const ms = Date.parse(value ? `${value}+05:30` : '');
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  };
  const area = document.getElementById('countdown-media-area');
  let mediaUrl = area?.dataset.selectedPosterUrl || null;
  let mediaName = area?.dataset.selectedPosterName || null;
  if (countdownMediaInput.files[0]) {
    mediaUrl = countdownMediaPreview.dataset.objectUrl || null;
    mediaName = countdownMediaInput.files[0].name;
  } else if (!mediaUrl && !countdownMediaRemoved) {
    mediaUrl = saved.mediaUrl || null;
    mediaName = saved.mediaName || null;
  }
  return {
    startDate: iso(countdownStartDate.value),
    targetDate: iso(countdownDate.value),
    dailyTime: countdownDailyTime.value || '09:00',
    eventTitle: countdownTitle.value.trim(),
    messageTemplate: countdownTemplate.value,
    mediaUrl,
    mediaName,
  };
}

function formatDay(day, long = false) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', long
    ? { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

/** One card per day showing what that day's broadcast will contain. */
function renderDayCards() {
  const cfg = countdownDraft();
  const days = countdownDays(cfg);
  const summary = document.getElementById('countdown-day-summary');
  dayDate.min = days[0] || '';
  dayDate.max = days[days.length - 1] || '';
  if (displayedDay && !days.includes(displayedDay) && !dayDirty) {
    // The dates changed and the open day is no longer part of the countdown.
    dayDate.value = displayedDay = '';
    dayEditor.classList.add('hidden');
  }
  if (!days.length) {
    setDayCardsHtml(`<div class="item-list__empty">${cfg.targetDate && sriLankaDay(cfg.startDate) > sriLankaDay(cfg.targetDate)
      ? 'The start date is after the target date.' : 'Choose the start and target dates to see a card for each day.'}</div>`);
    summary.textContent = '';
    return;
  }
  const lastDay = sriLankaDay(cfg.targetDate);
  summary.textContent = `${days.length} days · ${days.filter((day) => countdownDailyContent[day]).length} customised${days[days.length - 1] < lastDay ? ` · showing the first ${MAX_COUNTDOWN_DAYS}` : ''}`;
  const startMs = Date.parse(cfg.startDate) || -Infinity;
  const target = new Date(cfg.targetDate);
  const today = sriLankaDay(new Date().toISOString());
  const cards = days.map((day) => {
    const entry = countdownDailyContent[day];
    const slot = Date.parse(`${day}T${cfg.dailyTime || '09:00'}:00+05:30`);
    const sends = slot >= startMs && slot < target.getTime();
    const mediaUrl = entry?.mediaUrl || cfg.mediaUrl;
    const mediaName = entry?.mediaUrl ? entry.mediaName : cfg.mediaName;
    const fullUrl = mediaUrl && (/^(https?|blob):/.test(mediaUrl) ? mediaUrl : API_ORIGIN + mediaUrl);
    const message = resolveCountdownTemplate(entry?.messageTemplate || cfg.messageTemplate || 'Only {days} days and {hours} hours left.', target, slot);
    const [badge, badgeClass] = !sends ? ['No broadcast', 'badge--disabled'] : entry ? ['Custom', 'badge--enabled'] : ['Main content', 'badge--pending'];
    return `<button type="button" data-day="${day}" class="day-card${entry ? ' day-card--custom' : ''}${day === displayedDay ? ' is-selected' : ''}${slot < Date.now() ? ' day-card--past' : ''}">
      <span class="day-card__top"><strong>${escHtml(formatDay(day))}</strong>${day === today ? '<span class="day-card__today">Today</span>' : ''}<span class="item-card__badge ${badgeClass}">${badge}</span></span>
      ${!fullUrl ? '' : /\.(png|jpe?g|gif|webp|svg)$/i.test(mediaUrl.startsWith('blob:') ? mediaName : mediaUrl)
        ? `<img class="day-card__poster" src="${escAttr(fullUrl)}" alt="" loading="lazy" />`
        : `<span class="day-card__file">${mediaIcon(mediaName || mediaUrl)} ${escHtml(mediaName || 'Attachment')}</span>`}
      <span class="day-card__title${entry?.eventTitle ? '' : ' is-inherited'}">${escHtml(entry?.eventTitle || cfg.eventTitle || 'Event Countdown')}</span>
      <span class="day-card__message${entry?.messageTemplate ? '' : ' is-inherited'}">${escHtml(message)}</span>
    </button>`;
  });
  setDayCardsHtml(cards.join(''));
}

// Re-rendering identical cards would swallow a click that blurs a form field, as its change
// event fires between mouse down and mouse up; so the cards are only replaced when they differ.
let dayCardsHtml = '';
function setDayCardsHtml(html) {
  if (html === dayCardsHtml) return;
  dayCardsHtml = html;
  dayCards.innerHTML = html;
}
dayCards.addEventListener('click', (event) => {
  const card = event.target.closest('.day-card');
  if (card) openCountdownDay(card.dataset.day);
});

function openCountdownDay(day) {
  if (day === displayedDay) return;
  if (dayDirty && !confirm('Discard unsaved changes for this day?')) return;
  dayDate.value = day;
  showCountdownDay();
  dayEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  dayTitle.focus({ preventScroll: true });
}

function showCountdownDay() {
  displayedDay = dayDate.value;
  const day = countdownDailyContent[displayedDay] || {};
  dayTitle.value = day.eventTitle || '';
  dayMessage.value = day.messageTemplate || '';
  dayMedia.value = '';
  dayMediaCleared = false;
  dayDirty = false;
  const daySubCard = dayMedia.closest('.sub-card');
  daySubCard?.removeAttribute('data-selected-day-poster-url');
  daySubCard?.removeAttribute('data-selected-day-poster-name');
  const daySelect = document.getElementById('countdown-day-poster-select');
  if (daySelect) daySelect.value = '';
  dayMediaName.textContent = day.mediaName ? `Saved: ${day.mediaName}` : 'Using main poster.';
  dayEditor.classList.toggle('hidden', !displayedDay);
  document.getElementById('countdown-day-heading').textContent = displayedDay
    ? `${formatDay(displayedDay, true)} · ${countdownDailyContent[displayedDay] ? 'Custom content' : 'Using main content'}`
    : '';
  renderDayCards();
}
document.getElementById('countdown-day-close').addEventListener('click', () => {
  if (dayDirty && !confirm('Discard unsaved changes for this day?')) return;
  dayDate.value = '';
  showCountdownDay();
});
dayDate.addEventListener('change', () => {
  if (dayDirty && !confirm('Discard unsaved changes for this day?')) { dayDate.value = displayedDay; return; }
  showCountdownDay();
});
for (const input of [dayTitle, dayMessage, dayMedia]) input.addEventListener('input', () => { dayDirty = true; });
dayMedia.addEventListener('change', () => {
  dayDirty = true;
  dayMediaCleared = false;
  const daySubCard = dayMedia.closest('.sub-card');
  daySubCard?.removeAttribute('data-selected-day-poster-url');
  daySubCard?.removeAttribute('data-selected-day-poster-name');
  const daySelect = document.getElementById('countdown-day-poster-select');
  if (daySelect) daySelect.value = '';
  dayMediaName.textContent = dayMedia.files[0] ? `Selected: ${dayMedia.files[0].name}` : 'Using saved image or main poster.';
});
document.getElementById('countdown-day-clear').addEventListener('click', () => {
  dayMedia.value = '';
  dayMediaCleared = true;
  dayDirty = true;
  const daySubCard = dayMedia.closest('.sub-card');
  daySubCard?.removeAttribute('data-selected-day-poster-url');
  daySubCard?.removeAttribute('data-selected-day-poster-name');
  const daySelect = document.getElementById('countdown-day-poster-select');
  if (daySelect) daySelect.value = '';
  dayMediaName.textContent = 'Using main poster after saving.';
});
document.getElementById('countdown-day-save').addEventListener('click', async () => {
  if (!dayDate.value) { toast('Choose a date first', 'error'); return; }
  const savedCountdownFirst = !selectedCountdownId || countdownDirty;
  if (savedCountdownFirst) {
    try {
      const res = await apiPostForm(countdownPath(), countdownFormData());
      acceptCountdownState(res.state, res.countdownId);
    } catch (err) {
      toast(`Could not save the countdown: ${err.message}`, 'error');
      return;
    }
  }
  const fd = new FormData();
  fd.append('eventTitle', dayTitle.value);
  fd.append('messageTemplate', dayMessage.value);
  const daySubCard = dayMedia.closest('.sub-card');
  const selectedDayPosterUrl = daySubCard?.getAttribute('data-selected-day-poster-url');
  const selectedDayPosterName = daySubCard?.getAttribute('data-selected-day-poster-name');
  if (dayMedia.files[0]) {
    fd.append('media', dayMedia.files[0]);
  } else if (selectedDayPosterUrl) {
    fd.append('mediaUrl', selectedDayPosterUrl);
    fd.append('mediaName', selectedDayPosterName || 'poster.png');
  } else if (dayMediaCleared) {
    fd.append('clearMedia', 'true');
  }
  try {
    const res = await apiPostForm(`/countdowns/${selectedCountdownId}/days/${dayDate.value}`, fd);
    countdownDailyContent = res.state.countdowns.find((cfg) => cfg.id === selectedCountdownId)?.dailyContent || {};
    showCountdownDay();
    toast(savedCountdownFirst ? 'Countdown and content for this day saved' : 'Content for this day saved', 'success');
  } catch (err) { toast(`Could not save this day: ${err.message}`, 'error'); }
});
wireMediaPicker(countdownMediaInput, countdownMediaName, countdownMediaPreview, countdownMediaClear);

for (const input of [countdownEnabled, countdownTitle, countdownStartDate, countdownDate, countdownTemplate, countdownDailyTime, countdownMediaInput]) {
  input?.addEventListener('input', () => { countdownDirty = true; });
  input?.addEventListener('change', () => { countdownDirty = true; });
  input?.addEventListener('input', updateCountdownPreviewText);
  input?.addEventListener('change', updateCountdownPreviewText);
  input?.addEventListener('input', renderDayCards);
  input?.addEventListener('change', renderDayCards);
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
  if (countdownStartDate.value && new Date(countdownStartDate.value + '+05:30') >= new Date(countdownDate.value + '+05:30')) {
    throw new Error('The start date must be before the target date');
  }
  fd.append('messageTemplate', countdownTemplate.value);
  if (!countdownDailyTime.value) throw new Error('Please choose a daily publish time');
  fd.append('dailyTime', countdownDailyTime.value);
  const countdownMediaArea = document.getElementById('countdown-media-area');
  const selectedPosterUrl = countdownMediaArea?.dataset.selectedPosterUrl;
  const selectedPosterName = countdownMediaArea?.dataset.selectedPosterName;
  if (countdownMediaInput.files[0]) {
    fd.append('media', countdownMediaInput.files[0]);
  } else if (selectedPosterUrl) {
    fd.append('mediaUrl', selectedPosterUrl);
    fd.append('mediaName', selectedPosterName || 'poster.png');
  } else if (countdownMediaRemoved) {
    fd.append('clearMedia', 'true');
  }
  return fd;
}

function showCountdownMedia(previewEl) {
  if (!previewEl) return;
  const file = countdownMediaInput.files[0];
  const countdownMediaArea = document.getElementById('countdown-media-area');
  const selectedPosterUrl = countdownMediaArea?.dataset.selectedPosterUrl;
  const selectedPosterName = countdownMediaArea?.dataset.selectedPosterName;

  if (file) {
    showLocalPreview(file, previewEl);
  } else if (selectedPosterUrl) {
    clearMediaPicker(null, null, previewEl, null);
    const fullUrl = selectedPosterUrl.startsWith('http') ? selectedPosterUrl : API_ORIGIN + selectedPosterUrl;
    previewEl.innerHTML = `<img src="${escAttr(fullUrl)}" alt="${escAttr(selectedPosterName || 'Event poster')}" />`;
    previewEl.classList.remove('hidden');
  } else if (!countdownMediaRemoved && selectedCountdown()?.mediaUrl) {
    clearMediaPicker(null, null, previewEl, null);
    const url = selectedCountdown().mediaUrl;
    const fullUrl = url.startsWith('http') ? url : API_ORIGIN + url;
    const tag = /\.(mp4|mov|webm|mkv)$/i.test(url) ? 'video' : 'img';
    previewEl.innerHTML = `<${tag} src="${escAttr(fullUrl)}" ${tag === 'video' ? 'controls muted' : 'alt="Event poster"'} />`;
    previewEl.classList.remove('hidden');
  } else {
    clearMediaPicker(null, null, previewEl, null);
  }
}

function acceptCountdownState(state, countdownId) {
  if (countdownId) selectedCountdownId = countdownId;
  countdownSelectionMade = true;
  countdownDirty = false;
  countdownMediaRemoved = false;
  countdownMediaInput.value = '';
  if (state) syncStateToUI(state);
}

/** Fill the editor from the selected countdown, or with defaults for a new one. */
function loadCountdownForm() {
  const cfg = selectedCountdown() || { enabled: true, dailyTime: '09:00' };
  countdownTitle.value     = cfg.eventTitle || '';
  countdownEnabled.checked = !!cfg.enabled;
  countdownStartDate.value = toSriLankaDatetimeValue(cfg.startDate);
  countdownDate.value      = toSriLankaDatetimeValue(cfg.targetDate);
  countdownTemplate.value  = cfg.messageTemplate || '';
  countdownDailyTime.value = cfg.dailyTime || '09:00';

  if (!countdownMediaRemoved && !countdownMediaInput.files.length && cfg.mediaUrl) {
    countdownMediaName.textContent = cfg.mediaName || 'Attached Poster';
    countdownMediaClear.classList.remove('hidden');
    showCountdownMedia(countdownMediaPreview);
  } else if (!countdownMediaInput.files.length) {
    clearMediaPicker(countdownMediaInput, countdownMediaName, countdownMediaPreview, countdownMediaClear);
  }
}

function renderCountdownEditor() {
  const cfg = selectedCountdown();
  document.getElementById('countdown-editing-label').textContent = cfg ? `Editing: ${cfg.eventTitle || 'Event Countdown'}` : 'New countdown';
  if (!countdownDirty) loadCountdownForm();

  countdownDailyContent = cfg?.dailyContent || {};
  if (!dayDirty) showCountdownDay();
  else renderDayCards();

  renderCountdownList();
  showCountdownMedia(countdownPreviewMedia);
  updateCountdownScheduleHint();
  updateCountdownPreviewText();
}

function selectCountdown(id) {
  if ((countdownDirty || dayDirty) && !confirm('Discard unsaved countdown changes?')) return;
  selectedCountdownId = id;
  countdownSelectionMade = true;
  countdownDirty = false;
  dayDirty = false;
  dayDate.value = '';
  countdownMediaRemoved = false;
  clearMediaPicker(countdownMediaInput, countdownMediaName, countdownMediaPreview, countdownMediaClear);
  renderCountdownEditor();
}

function renderCountdownList() {
  if (!countdowns.length) {
    countdownsList.innerHTML = '<div class="item-list__empty">No countdowns yet. Fill in the form below and save to create one.</div>';
    return;
  }
  countdownsList.innerHTML = '';
  for (const cfg of sortedCountdowns()) {
    const status = countdownStatus(cfg);
    const selected = cfg.id === selectedCountdownId;
    const card = document.createElement('div');
    card.className = `item-card countdown-item${selected ? ' is-selected' : ''}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', String(selected));
    card.innerHTML = `
      <div class="item-card__header">
        <span class="countdown-item__title">${escHtml(cfg.eventTitle || 'Event Countdown')}</span>
        <span class="item-card__badge ${status.badge}">${status.label}</span>
        <button class="btn btn--danger btn--sm ml-auto" type="button" data-delete-countdown="${escAttr(cfg.id)}" title="Delete countdown">Delete</button>
      </div>
      <span class="item-card__time">Target: ${cfg.targetDate ? fmtSriLankaDate(cfg.targetDate) : 'Not set'}${cfg.enabled && cfg.dailyTime ? ` · Daily at ${escHtml(cfg.dailyTime)}` : ''}${cfg.mediaUrl ? ' · Poster attached' : ''}</span>
    `;
    card.addEventListener('click', (event) => {
      if (!event.target.closest('[data-delete-countdown]') && !selected) selectCountdown(cfg.id);
    });
    card.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === card) {
        event.preventDefault();
        if (!selected) selectCountdown(cfg.id);
      }
    });
    card.querySelector('[data-delete-countdown]').addEventListener('click', async () => {
      if (!confirm(`Delete the countdown "${cfg.eventTitle || 'Event Countdown'}"?`)) return;
      try {
        const res = await apiDelete(`/countdowns/${cfg.id}`);
        if (selected) {
          selectedCountdownId = null;
          countdownSelectionMade = false;
          countdownDirty = false;
          dayDirty = false;
        }
        syncStateToUI(res.state);
        toast('Countdown deleted', 'info');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      }
    });
    countdownsList.appendChild(card);
  }
}

btnNewCountdown?.addEventListener('click', () => {
  selectCountdown(null);
  if (!selectedCountdownId) countdownTitle.focus();
});

if (countdownMediaClear) {
  countdownMediaClear.addEventListener('click', () => {
    countdownMediaRemoved = true;
    countdownDirty = true;
    showCountdownMedia(countdownPreviewMedia);
    renderDayCards();
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
      const res = await apiPostForm(countdownPath(), countdownFormData());
      acceptCountdownState(res.state, res.countdownId);
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
      const res = await apiPostForm(countdownPath('/broadcast'), countdownFormData());
      acceptCountdownState(res.state, res.countdownId);
      toast(`Countdown broadcast sent to ${res.sentCount} group(s)`, 'success');
      addLog(`Manual countdown broadcast dispatched to ${res.sentCount} group(s)`, 'success');
    } catch (err) {
      // The countdown may have been saved even though sending failed.
      if (err.data?.countdownId) selectedCountdownId = err.data.countdownId;
      toast(`Countdown broadcast failed: ${err.message}`, 'error');
      addLog(`Countdown broadcast failed: ${err.message}`, 'error');
    } finally {
      btnBroadcastCountdown.disabled = false;
      btnBroadcastCountdown.textContent = 'Broadcast Countdown Now';
    }
  });
}

function resolveCountdownTemplate(template, targetDate, now = Date.now()) {
  const diffMs = targetDate.getTime() - now;
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
    const postMediaArea = document.getElementById('post-media-area');
    const selectedPosterUrl = postMediaArea?.dataset.selectedPosterUrl;
    const selectedPosterName = postMediaArea?.dataset.selectedPosterName;
    const hasMedia = Boolean(postMediaInput.files[0] || selectedPosterUrl);

    if (isNaN(scheduledDate.getTime()) || (!message && !hasMedia)) {
      toast('Please specify a valid date and a message or attachment', 'error');
      return;
    }
    try {
      const fd = new FormData();
      const scheduledAt = scheduledDate.toISOString();
      fd.append('scheduledAt', scheduledAt);
      fd.append('message',     message);
      if (postMediaInput.files[0]) {
        fd.append('media', postMediaInput.files[0]);
      } else if (selectedPosterUrl) {
        fd.append('mediaUrl', selectedPosterUrl);
        fd.append('mediaName', selectedPosterName || 'poster.png');
      }

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

  // Countdowns
  countdowns = state.countdowns || [];
  if (selectedCountdownId && !selectedCountdown()) {
    // The countdown being edited was deleted elsewhere.
    selectedCountdownId = null;
    countdownSelectionMade = false;
    countdownDirty = false;
    dayDirty = false;
  }
  if (!countdownSelectionMade && !countdownDirty && !selectedCountdownId && countdowns.length) {
    selectedCountdownId = sortedCountdowns()[0].id;
  }
  renderCountdownEditor();

  // Posts
  renderPosts(state.scheduledPosts);

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
  if (!dashboardState) return;
  const cfg = primaryCountdown(dashboardState.countdowns) || {};
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
  const allCountdowns = state.countdowns || [];
  const activeCountdowns = allCountdowns.filter((cfg) => countdownStatus(cfg).label === 'Active');
  document.getElementById('metric-groups').textContent = groups.length;
  document.getElementById('metric-posts').textContent = posts.length;
  document.getElementById('nav-post-count').textContent = posts.length;
  document.getElementById('metric-countdowns').textContent = activeCountdowns.length;
  document.getElementById('posts-card-status').textContent = `${posts.length} queued`;
  document.getElementById('commands-card-status').textContent = state.botCommands?.enabled ? 'Enabled' : 'Disabled';
  const cfg = primaryCountdown(allCountdowns) || {};
  const target = new Date(cfg.targetDate);
  const valid = Number.isFinite(target.getTime());
  document.getElementById('overview-event-title').textContent = cfg.eventTitle || (valid ? 'Event Countdown' : 'Make every moment count.');
  document.getElementById('overview-event-date').textContent = valid
    ? target.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23' })
    : 'Create a countdown your group can look forward to.';
  document.getElementById('countdown-card-status').textContent = activeCountdowns.length ? `${activeCountdowns.length} active`
    : allCountdowns.length ? `${allCountdowns.length} saved` : 'Not configured';
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
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }) + ' (Sri Lanka time)';
}

function toSriLankaDatetimeValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 16) : '';
}

function fmtDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-GB', { hourCycle: 'h23' });
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
    const area = inputEl.closest('.media-upload-area');
    if (area) {
      delete area.dataset.selectedPosterUrl;
      delete area.dataset.selectedPosterName;
      const parent = area.parentElement;
      const sel = parent?.querySelector(`.poster-library-select[data-area="${area.id}"]`);
      if (sel) sel.value = '';
    }
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
      delete area.dataset.selectedPosterUrl;
      delete area.dataset.selectedPosterName;
      const parent = area.parentElement;
      const sel = parent?.querySelector(`.poster-library-select[data-area="${area.id}"]`);
      if (sel) sel.value = '';
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
  // Preview-only refreshes pass no input and must keep a library poster selection.
  const area = inputEl?.closest('.media-upload-area');
  if (area) {
    delete area.dataset.selectedPosterUrl;
    delete area.dataset.selectedPosterName;
    const parent = area.parentElement;
    const sel = parent?.querySelector(`.poster-library-select[data-area="${area.id}"]`);
    if (sel) sel.value = '';
  }
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

// ═══════════════════════════════════════════════════════════ POSTER LIBRARY HELPERS

async function loadPosterLibrary() {
  try {
    const res = await fetch(`${API_ORIGIN}/api/posters/library`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.posters)) return;
    const posters = data.posters;

    document.querySelectorAll('.poster-library-select').forEach((sel) => {
      const currentVal = sel.value;
      sel.innerHTML = '<option value="">-- Choose from Poster Library --</option>';
      for (const p of posters) {
        const opt = document.createElement('option');
        opt.value = p.mediaUrl;
        opt.dataset.name = p.name;
        opt.textContent = `${p.name} (${p.filename})`;
        sel.appendChild(opt);
      }
      if (currentVal && Array.from(sel.options).some((o) => o.value === currentVal)) {
        sel.value = currentVal;
      }
    });
    renderPosterGrid(posters);
  } catch (err) {
    console.warn('[Poster Library] Could not load saved posters:', err);
  }
}

/** Thumbnails of the poster library on the Posters page, each with a delete button. */
function renderPosterGrid(posters) {
  const grid = document.getElementById('poster-library-grid');
  if (!grid) return;
  document.getElementById('poster-library-count').textContent = `${posters.length} poster${posters.length === 1 ? '' : 's'}`;
  if (!posters.length) {
    grid.innerHTML = '<div class="item-list__empty">No posters yet. Add PNG, JPG, WebP or SVG files above.</div>';
    return;
  }
  grid.innerHTML = posters.map((p) => `
    <div class="poster-tile">
      <img src="${escAttr(/^https?:/.test(p.mediaUrl) ? p.mediaUrl : API_ORIGIN + p.mediaUrl)}" alt="" loading="lazy" />
      <span class="poster-tile__name">${escHtml(p.name)}</span>
      <button class="btn btn--danger btn--sm" type="button" data-delete-poster="${escAttr(p.filename)}" data-name="${escAttr(p.name)}">Delete</button>
    </div>`).join('');
}
document.getElementById('poster-library-grid')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-poster]');
  if (!button || !confirm(`Delete the poster "${button.dataset.name}"?`)) return;
  try {
    await apiDelete(`/posters/library/${encodeURIComponent(button.dataset.deletePoster)}`);
    toast('Poster deleted', 'info');
    await loadPosterLibrary();
  } catch (err) {
    toast(`Could not delete poster: ${err.message}`, 'error');
  }
});

function wirePosterLibraryEvents() {
  document.querySelectorAll('.poster-library-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const val = sel.value;
      const selectedOption = sel.options[sel.selectedIndex];
      const posterName = selectedOption?.dataset?.name || (selectedOption ? selectedOption.textContent : '');
      const areaId = sel.dataset.area;
      const target = sel.dataset.target;

      if (areaId) {
        const area = document.getElementById(areaId);
        if (!area) return;
        const input = area.querySelector('input[type="file"]');
        const nameEl = area.querySelector('[id$="-name"]');
        const previewEl = area.querySelector('.media-preview');
        const clearEl = area.querySelector('button[id$="-clear"]');

        if (val) {
          if (input) input.value = '';
          area.dataset.selectedPosterUrl = val;
          area.dataset.selectedPosterName = posterName;
          if (nameEl) nameEl.textContent = `[Library] ${posterName}`;
          if (clearEl) clearEl.classList.remove('hidden');

          if (previewEl) {
            clearMediaPicker(null, null, previewEl, null);
            const fullUrl = val.startsWith('http') ? val : API_ORIGIN + val;
            previewEl.innerHTML = `<img src="${escAttr(fullUrl)}" alt="${escAttr(posterName)}" />`;
            previewEl.classList.remove('hidden');
          }

          if (areaId === 'countdown-media-area') {
            countdownMediaRemoved = false;
            countdownDirty = true;
            if (countdownPreviewMedia) {
              const fullUrl = val.startsWith('http') ? val : API_ORIGIN + val;
              countdownPreviewMedia.innerHTML = `<img src="${escAttr(fullUrl)}" alt="${escAttr(posterName)}" />`;
              countdownPreviewMedia.classList.remove('hidden');
            }
            renderDayCards();
          }
        } else {
          delete area.dataset.selectedPosterUrl;
          delete area.dataset.selectedPosterName;
          if (!input?.files?.length) {
            clearMediaPicker(input, nameEl, previewEl, clearEl);
            if (areaId === 'countdown-media-area') {
              showCountdownMedia(countdownPreviewMedia);
            }
          }
        }
      } else if (target === 'countdown-day') {
        const daySubCard = dayMedia?.closest('.sub-card');
        if (val) {
          dayMedia.value = '';
          dayMediaCleared = false;
          dayDirty = true;
          daySubCard?.setAttribute('data-selected-day-poster-url', val);
          daySubCard?.setAttribute('data-selected-day-poster-name', posterName);
          dayMediaName.textContent = `[Library] ${posterName}`;
        } else {
          daySubCard?.removeAttribute('data-selected-day-poster-url');
          daySubCard?.removeAttribute('data-selected-day-poster-name');
          dayMediaName.textContent = 'Using main poster.';
        }
      }
    });
  });
}

wirePosterLibraryEvents();
loadPosterLibrary();

function mediaIcon(url) {
  if (!url) return '[MEDIA]';
  const ext = url.split('.').pop().toLowerCase();
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return '[VIDEO]';
  if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return '[IMAGE]';
  if (['mp3','ogg','wav','m4a','aac'].includes(ext)) return '[AUDIO]';
  return '[FILE]';
}


// ══════════════════════════════════════════════════════════════════════════════
// SVG EDITOR — TOP-LEVEL PANEL NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Deactivates the SVG Editor view and restores standard dashboard visibility.
 */
function deactivateSvgEditorPanel() {
  document.body.classList.remove('svg-editor-open');
  const svgPanel = document.getElementById('svg-editor-panel');
  if (svgPanel) svgPanel.classList.add('hidden');
}

/**
 * Shows the SVG Editor panel and isolates it as the only view in the tab.
 */
function activateSvgEditorPanel() {
  // Close any open group workspace without clearing the active group
  document.body.classList.remove('workspace-open');
  document.body.classList.add('svg-editor-open');
  if (groupWorkspaceViewEl) groupWorkspaceViewEl.classList.add('hidden');
  if (groupsListViewEl) groupsListViewEl.classList.remove('hidden');

  // Update breadcrumb
  document.getElementById('breadcrumb-current').textContent = 'Posters';

  // Mark the nav link active
  document.querySelectorAll('.sidebar__nav .nav-link, [data-overview]').forEach((link) => {
    const isSvgEditor = link.dataset.navService === 'svg-editor';
    link.classList.toggle('is-active', isSvgEditor);
    if (isSvgEditor) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  // Show SVG panel
  const svgPanel = document.getElementById('svg-editor-panel');
  if (svgPanel) svgPanel.classList.remove('hidden');

  window.scrollTo({ top: 0 });
}

// Reset SVG editor panel when user navigates to overview or activity log
(function wireSvgNavExits() {
  document.querySelectorAll('[data-overview]').forEach((button) => {
    button.addEventListener('click', () => {
      deactivateSvgEditorPanel();
    });
  });

  document.querySelectorAll('a[href="#activity-section"]').forEach((link) => {
    link.addEventListener('click', () => {
      deactivateSvgEditorPanel();
      closeGroupWorkspace();
    });
  });
})();

// ══════════════════════════════════════════════════════════════════════════════
// SVG EDITOR MODULE
// Parses uploaded SVG, extracts text nodes into friendly form fields,
// updates preview in real-time, and provides download / use-as-poster.
// ══════════════════════════════════════════════════════════════════════════════

(function svgEditorModule() {
  // ─── State ─────────────────────────────────────────────────────────────────
  let _svgDoc  = null;   // Parsed SVG DOM Document
  let _svgName = 'edited.svg';
  let lastSvgInput = null; // Track focused text input for inserting superscripts

  // ─── Quick Superscript Toolbar Insertion ──────────────────────────────────
  document.querySelectorAll('.btn-insert-char').forEach((btn) => {
    btn.addEventListener('click', () => {
      const char = btn.dataset.char;
      if (lastSvgInput && document.body.contains(lastSvgInput)) {
        const start = lastSvgInput.selectionStart ?? lastSvgInput.value.length;
        const end = lastSvgInput.selectionEnd ?? lastSvgInput.value.length;
        const val = lastSvgInput.value;
        lastSvgInput.value = val.slice(0, start) + char + val.slice(end);
        const newPos = start + char.length;
        lastSvgInput.setSelectionRange(newPos, newPos);
        lastSvgInput.focus();
        lastSvgInput.dispatchEvent(new Event('input'));
      } else {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(char).then(() => {
            toast(`Copied ${char} to clipboard! Paste it into your text field.`, 'info');
          }).catch(() => {});
        }
      }
    });
  });

  // ─── Element references ────────────────────────────────────────────────────
  const uploadZone       = document.getElementById('svg-upload-zone');
  const fileInput        = document.getElementById('svg-file-input');
  const workspace        = document.getElementById('svg-editor-workspace');
  const previewContainer = document.getElementById('svg-preview-container');
  const fieldsContainer  = document.getElementById('svg-fields-container');
  const noTextHint       = document.getElementById('svg-no-text-hint');
  const btnDownload      = document.getElementById('btn-svg-download');
  const btnUsePoster     = document.getElementById('btn-svg-use-as-poster');
  const btnSaveLibrary   = document.getElementById('btn-svg-save-library');
  const btnClear         = document.getElementById('btn-svg-clear');
  const posterStatus     = document.getElementById('svg-poster-status');
  const tplSelect        = document.getElementById('svg-template-select');
  const btnLoadTpl       = document.getElementById('btn-load-template');
  const fieldSearchInput = document.getElementById('svg-field-search');
  const fieldsCountEl    = document.getElementById('svg-fields-count');

  if (!uploadZone) return; // Panel not in DOM

  let _templatesCache = [];
  let _fieldRows = []; // array of { rowEl, input, labelText, idx }

  async function loadSvgTemplates() {
    if (!tplSelect) return;
    try {
      const res = await fetch(`${API_ORIGIN}/api/posters/templates`);
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.templates)) return;
      _templatesCache = data.templates;
      tplSelect.innerHTML = '<option value="">-- Choose an SVG Template --</option>';
      for (const t of data.templates) {
        const opt = document.createElement('option');
        opt.value = t.filename;
        opt.textContent = `${t.name} (${t.filename})${t.custom ? ' · added' : ''}`;
        tplSelect.appendChild(opt);
      }
      renderCustomTemplates();
    } catch (err) {
      console.warn('[SVG Editor] Could not load templates:', err);
    }
  }

  // ─── Poster library: templates and posters added from this computer ───────
  const customTemplatesBox  = document.getElementById('svg-custom-templates');
  const customTemplatesList = document.getElementById('svg-custom-templates-list');
  const posterUploadInput   = document.getElementById('poster-upload-input');
  const btnPosterUpload     = document.getElementById('btn-poster-upload');
  const posterUploadStatus  = document.getElementById('poster-upload-status');

  function renderCustomTemplates() {
    if (!customTemplatesList) return;
    const custom = _templatesCache.filter((t) => t.custom);
    customTemplatesBox.classList.toggle('hidden', !custom.length);
    customTemplatesList.innerHTML = custom.map((t) => `
      <div class="poster-template-row">
        <span>${escHtml(t.name)}</span><span class="field-hint-inline">${escHtml(t.filename)}</span>
        <button class="btn btn--danger btn--sm ml-auto" type="button" data-delete-template="${escAttr(t.filename)}">Delete</button>
      </div>`).join('');
  }

  customTemplatesList?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-template]');
    if (!button || !confirm(`Delete the template "${button.dataset.deleteTemplate}"? Posters already saved from it stay in the library.`)) return;
    try {
      await apiDelete(`/posters/templates/${encodeURIComponent(button.dataset.deleteTemplate)}`);
      toast('Template deleted', 'info');
      await loadSvgTemplates();
    } catch (err) {
      toast(`Could not delete template: ${err.message}`, 'error');
    }
  });

  btnPosterUpload?.addEventListener('click', async () => {
    const files = [...posterUploadInput.files];
    if (!files.length) {
      toast('Choose one or more poster files first', 'error');
      return;
    }
    btnPosterUpload.disabled = true;
    const added = [];
    const failed = [];
    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, '');
      posterUploadStatus.textContent = `Adding ${file.name}...`;
      try {
        if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') {
          // Keep the SVG as an editable template, and add a PNG WhatsApp can show.
          const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
          if (doc.querySelector('parsererror') || doc.documentElement.nodeName.toLowerCase() !== 'svg') throw new Error('not a valid SVG file');
          const template = new FormData();
          template.append('media', file, file.name);
          await apiPostForm('/posters/templates', template);
          const poster = new FormData();
          poster.append('media', await svgToPng(doc.documentElement), `${name}.png`);
          poster.append('name', name);
          await apiPostForm('/posters/save', poster);
        } else if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
          const poster = new FormData();
          poster.append('media', file, file.name);
          poster.append('name', name);
          await apiPostForm('/posters/save', poster);
        } else {
          throw new Error('use a PNG, JPG, WebP or SVG file');
        }
        added.push(file.name);
      } catch (err) {
        failed.push(`${file.name} (${err.message})`);
      }
    }
    posterUploadInput.value = '';
    btnPosterUpload.disabled = false;
    posterUploadStatus.textContent = [
      added.length ? `Added ${added.length} file${added.length === 1 ? '' : 's'} to the library.` : '',
      failed.length ? `Not added: ${failed.join('; ')}` : '',
    ].filter(Boolean).join(' ');
    if (added.length) toast(`Added ${added.length} poster file${added.length === 1 ? '' : 's'}`, 'success');
    if (failed.length) toast(`Some files were not added: ${failed.join('; ')}`, 'error');
    await loadSvgTemplates();
    await loadPosterLibrary();
  });

  function loadTemplateByName(filename) {
    const tpl = _templatesCache.find((t) => t.filename === filename);
    if (!tpl || !tpl.content) return;
    try {
      _svgName = tpl.filename;
      const parser = new DOMParser();
      _svgDoc = parser.parseFromString(tpl.content, 'image/svg+xml');
      const parseErr = _svgDoc.querySelector('parsererror');
      if (parseErr) throw new Error('SVG parsing failed: ' + parseErr.textContent);
      renderEditor();
      toast(`Loaded template "${tpl.name}"`, 'success');
    } catch (err) {
      console.error('[SVG Editor] Could not load template:', err);
      toast('Could not load template: ' + err.message, 'error');
    }
  }

  if (btnLoadTpl) {
    btnLoadTpl.addEventListener('click', () => {
      const selected = tplSelect?.value;
      if (!selected) {
        toast('Please select an SVG template first', 'error');
        return;
      }
      loadTemplateByName(selected);
    });
  }

  if (tplSelect) {
    tplSelect.addEventListener('change', () => {
      if (tplSelect.value) {
        loadTemplateByName(tplSelect.value);
      }
    });
  }

  if (fieldSearchInput) {
    fieldSearchInput.addEventListener('input', () => {
      const q = (fieldSearchInput.value || '').trim().toLowerCase();
      let visible = 0;
      _fieldRows.forEach(({ rowEl, input, labelText }) => {
        const val = (input.value || '').toLowerCase();
        const matches = !q || labelText.includes(q) || val.includes(q);
        rowEl.style.display = matches ? '' : 'none';
        if (matches) visible++;
      });
      if (fieldsCountEl) {
        fieldsCountEl.textContent = q
          ? `${visible} of ${_fieldRows.length} matching`
          : `${_fieldRows.length} editable fields`;
      }
    });
  }

  loadSvgTemplates();

  // ─── File input change ─────────────────────────────────────────────────────
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadSvgFile(file);
  });

  // ─── Drag & drop ───────────────────────────────────────────────────────────
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && (file.type === 'image/svg+xml' || file.name.endsWith('.svg'))) {
      loadSvgFile(file);
    } else {
      showToast('Please drop a valid .svg file.', true);
    }
  });
  uploadZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });

  // ─── Clear ─────────────────────────────────────────────────────────────────
  btnClear.addEventListener('click', () => {
    _svgDoc = null;
    _svgName = 'edited.svg';
    previewContainer.innerHTML = '';
    fieldsContainer.innerHTML = '';
    _fieldRows = [];
    noTextHint.style.display = 'none';
    workspace.classList.add('hidden');
    uploadZone.classList.remove('hidden');
    fileInput.value = '';
    if (tplSelect) tplSelect.value = '';
    if (fieldSearchInput) fieldSearchInput.value = '';
    if (fieldsCountEl) fieldsCountEl.textContent = '';
    posterStatus.textContent = '';
  });

  // ─── Load SVG file ─────────────────────────────────────────────────────────
  function loadSvgFile(file) {
    _svgName = file.name.replace(/\.svg$/i, '') + '-edited.svg';
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parser = new DOMParser();
        _svgDoc = parser.parseFromString(e.target.result, 'image/svg+xml');
        // Check for parse errors
        const parseErr = _svgDoc.querySelector('parsererror');
        if (parseErr) throw new Error('SVG parsing failed: ' + parseErr.textContent);
        renderEditor();
      } catch (err) {
        console.error('[SVG Editor] Could not parse SVG:', err);
        toast('Could not parse SVG: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  // ─── Render editor ─────────────────────────────────────────────────────────
  function renderEditor() {
    if (!_svgDoc) return;

    // Show workspace, hide upload zone
    uploadZone.classList.add('hidden');
    workspace.classList.remove('hidden');
    posterStatus.textContent = '';
    if (fieldSearchInput) fieldSearchInput.value = '';

    // Build form fields and render interactive live SVG preview
    buildFieldForm();
    renderPreview();
  }

  // ─── Render preview ────────────────────────────────────────────────────────
  function renderPreview() {
    if (!_svgDoc) return;
    previewContainer.innerHTML = '';

    // Clone SVG for interactive live preview
    const clonedSvg = _svgDoc.documentElement.cloneNode(true);
    clonedSvg.querySelectorAll('script').forEach((s) => s.remove());
    clonedSvg.style.maxWidth = '100%';
    clonedSvg.style.maxHeight = '480px';
    clonedSvg.style.height = 'auto';
    clonedSvg.style.display = 'block';

    // Interactive click & hover: clicking text in SVG focuses its field
    clonedSvg.querySelectorAll('[data-svg-field-idx]').forEach((node) => {
      node.style.cursor = 'pointer';
      const idx = node.dataset.svgFieldIdx;

      node.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetInput = document.getElementById(`svg-text-field-${idx}`);
        if (targetInput) {
          targetInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetInput.focus();
          if (typeof targetInput.select === 'function') targetInput.select();
        }
      });

      node.addEventListener('mouseenter', () => {
        highlightPreviewElement(idx, true);
      });
      node.addEventListener('mouseleave', () => {
        highlightPreviewElement(idx, false);
      });
    });

    previewContainer.appendChild(clonedSvg);
  }

  function highlightPreviewElement(idx, isHighlight) {
    const liveNode = previewContainer.querySelector(`[data-svg-field-idx="${idx}"]`);
    const rowEl = document.getElementById(`svg-field-row-${idx}`);
    if (liveNode) {
      if (isHighlight) liveNode.classList.add('svg-preview-highlight');
      else liveNode.classList.remove('svg-preview-highlight');
    }
    if (rowEl) {
      rowEl.classList.toggle('is-highlighted', isHighlight);
    }
  }

  // ─── Universal Text Extractor ──────────────────────────────────────────────
  function extractSvgTextElements(root) {
    const items = [];
    const seen = new WeakSet();

    root.querySelectorAll('text, tspan, textPath').forEach((el, idx) => {
      if (el.closest('defs, clipPath, mask, style, script')) return;
      if (seen.has(el)) return;

      const tag = el.tagName.toLowerCase();
      if (tag === 'tspan') {
        const txt = el.textContent ?? '';
        if (txt.trim() !== '') {
          items.push({ el, text: txt, isTspan: true, idx });
          seen.add(el);
        }
      } else if (tag === 'text') {
        const childTspans = el.querySelectorAll('tspan');
        if (childTspans.length === 0) {
          const txt = el.textContent ?? '';
          if (txt.trim() !== '') {
            items.push({ el, text: txt, isTspan: false, idx });
            seen.add(el);
          }
        } else {
          // Direct text nodes inside <text> that are not in tspans
          const direct = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent)
            .join('');
          if (direct.trim() !== '') {
            items.push({ el, text: direct, isTspan: false, isDirectOnly: true, idx });
            seen.add(el);
          }
        }
      } else if (tag === 'textpath') {
        const txt = el.textContent ?? '';
        if (txt.trim() !== '') {
          items.push({ el, text: txt, isTextPath: true, idx });
          seen.add(el);
        }
      }
    });

    return items;
  }

  // ─── Build field form ──────────────────────────────────────────────────────
  function buildFieldForm() {
    if (!_svgDoc) return;
    fieldsContainer.innerHTML = '';
    _fieldRows = [];

    const textElements = extractSvgTextElements(_svgDoc.documentElement);

    if (textElements.length === 0) {
      noTextHint.style.display = '';
      if (fieldsCountEl) fieldsCountEl.textContent = '0 fields';
      return;
    }
    noTextHint.style.display = 'none';

    if (fieldsCountEl) {
      fieldsCountEl.textContent = `${textElements.length} editable fields`;
    }

    textElements.forEach(({ el, text, isDirectOnly }, i) => {
      // Stamp index on the SVG element for two-way binding
      el.dataset.svgFieldIdx = String(i);

      const fieldId = `svg-text-field-${i}`;
      const label = getLabelForElement(el, i, text);
      const initialVal = text;

      const wrapper = document.createElement('div');
      wrapper.className = 'svg-field-row';
      wrapper.id = `svg-field-row-${i}`;

      // Field Header with Label and Quick Tools
      const header = document.createElement('div');
      header.className = 'svg-field-header';

      const lbl = document.createElement('label');
      lbl.className = 'field-label';
      lbl.htmlFor = fieldId;
      lbl.textContent = label;
      lbl.title = el.id ? `ID: ${el.id}` : `Tag: <${el.tagName}>`;

      const tools = document.createElement('div');
      tools.className = 'svg-field-tools';

      const btnUpper = document.createElement('button');
      btnUpper.type = 'button';
      btnUpper.className = 'svg-field-tool-btn';
      btnUpper.textContent = 'AA';
      btnUpper.title = 'Convert to UPPERCASE';

      const btnTitle = document.createElement('button');
      btnTitle.type = 'button';
      btnTitle.className = 'svg-field-tool-btn';
      btnTitle.textContent = 'Aa';
      btnTitle.title = 'Convert to Title Case';

      const btnReset = document.createElement('button');
      btnReset.type = 'button';
      btnReset.className = 'svg-field-tool-btn';
      btnReset.textContent = '↺';
      btnReset.title = 'Reset to original text';

      tools.appendChild(btnUpper);
      tools.appendChild(btnTitle);
      tools.appendChild(btnReset);

      header.appendChild(lbl);
      header.appendChild(tools);

      // Input Control (textarea for multi-line or long strings, input for short strings)
      let input;
      if (text.length > 50 || text.includes('\n')) {
        input = document.createElement('textarea');
        input.rows = 2;
        input.className = 'field-textarea';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'field-input';
      }
      input.id = fieldId;
      input.value = text;
      input.autocomplete = 'off';
      input.dataset.svgFieldIdx = String(i);

      // Tool click listeners
      btnUpper.addEventListener('click', () => {
        input.value = input.value.toUpperCase();
        input.dispatchEvent(new Event('input'));
      });
      btnTitle.addEventListener('click', () => {
        input.value = input.value.replace(/\b\w/g, (c) => c.toUpperCase());
        input.dispatchEvent(new Event('input'));
      });
      btnReset.addEventListener('click', () => {
        input.value = initialVal;
        input.dispatchEvent(new Event('input'));
      });

      // Track focus for superscript toolbar & highlight preview element
      input.addEventListener('focus', () => {
        lastSvgInput = input;
        highlightPreviewElement(i, true);
      });
      input.addEventListener('blur', () => {
        highlightPreviewElement(i, false);
      });

      // Real-time update
      input.addEventListener('input', () => {
        updateTextElement(el, input.value, isDirectOnly);
        // Fast direct DOM update in inline preview
        const liveNode = previewContainer.querySelector(`[data-svg-field-idx="${i}"]`);
        if (liveNode) {
          updateTextElement(liveNode, input.value, isDirectOnly);
        }
      });

      wrapper.appendChild(header);
      wrapper.appendChild(input);
      fieldsContainer.appendChild(wrapper);

      _fieldRows.push({
        rowEl: wrapper,
        input,
        labelText: label.toLowerCase(),
        idx: i,
      });
    });
  }

  // ─── Human-readable label generator for ANY SVG ────────────────────────────
  function getLabelForElement(el, idx, currentText) {
    if (el.getAttribute('data-label')) return el.getAttribute('data-label');
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');

    const parent = el.parentElement;
    if (parent && parent.getAttribute('data-label')) {
      return `${parent.getAttribute('data-label')}`;
    }

    if (el.id && !/^(text|tspan|path|g|svg)\d*$/i.test(el.id)) {
      const clean = el.id
        .replace(/^txt-|^text-|^tspan-|^div-/, '')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      if (clean.length > 2) return clean;
    }

    if (parent && parent.id && !/^(text|tspan|path|g|svg)\d*$/i.test(parent.id)) {
      const parentClean = parent.id
        .replace(/^txt-|^text-|^tspan-|^div-/, '')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      if (parentClean.length > 2) return parentClean;
    }

    const group = el.closest('g[id]');
    let groupName = '';
    if (group && group.id && !/^g\d+$/i.test(group.id)) {
      groupName = group.id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) + ' · ';
    }

    const trimmed = (currentText || '').trim();
    if (trimmed) {
      const snippet = trimmed.length > 24 ? trimmed.slice(0, 24) + '…' : trimmed;
      return `${groupName}"${snippet}"`;
    }

    return `Text Field #${idx + 1}`;
  }

  // ─── Update an element's text robustly ──────────────────────────────────────
  function updateTextElement(el, newValue, isDirectOnly) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'tspan' || tag === 'textpath') {
      el.textContent = newValue;
    } else if (tag === 'text') {
      const childTspans = el.querySelectorAll('tspan');
      if (childTspans.length === 0 || !isDirectOnly) {
        el.textContent = newValue;
      } else {
        const textNodes = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
        if (textNodes.length > 0) {
          textNodes[0].textContent = newValue;
          for (let i = 1; i < textNodes.length; i++) textNodes[i].textContent = '';
        } else {
          const tn = el.ownerDocument.createTextNode(newValue);
          el.insertBefore(tn, el.firstChild);
        }
      }
    } else {
      el.textContent = newValue;
    }
  }

  // ─── Download SVG ──────────────────────────────────────────────────────────
  btnDownload.addEventListener('click', () => {
    if (!_svgDoc) return;
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(_svgDoc.documentElement);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = _svgName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  // ─── Use as Countdown Poster ───────────────────────────────────────────────
  // Rasterizes the SVG to PNG via <canvas>, then uploads to the server as the countdown poster.
  btnUsePoster.addEventListener('click', async () => {
    if (!_svgDoc) return;
    posterStatus.textContent = 'Preparing poster...';
    btnUsePoster.disabled = true;

    try {
      const pngBlob = await svgToPng(_svgDoc.documentElement);
      const formData = new FormData();
      formData.append('media', pngBlob, _svgName.replace(/\.svg$/i, '.png'));

      const res = await approvedFetch(`${API_ORIGIN}/api/countdown`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok) {
        posterStatus.textContent = '✓ Saved as countdown poster!';
        toast('SVG saved as countdown poster.', 'success');
      } else {
        throw new Error(data.error || 'Upload failed');
      }
    } catch (err) {
      console.error('[SVG Editor] Could not save poster:', err);
      posterStatus.textContent = '✗ ' + err.message;
      toast('Could not save poster: ' + err.message, 'error');
    } finally {
      btnUsePoster.disabled = false;
    }
  });

  // ─── Save to Poster Library (PNG) ──────────────────────────────────────────
  if (btnSaveLibrary) {
    btnSaveLibrary.addEventListener('click', async () => {
      if (!_svgDoc) return;
      posterStatus.textContent = 'Rendering PNG and saving to poster library...';
      btnSaveLibrary.disabled = true;

      try {
        const defaultName = _svgName.replace(/\.svg$/i, '').replace(/-edited$/i, '') + '-poster';
        const posterName = prompt('Enter a title/name for this saved PNG poster:', defaultName) || defaultName;
        const pngBlob = await svgToPng(_svgDoc.documentElement);

        const formData = new FormData();
        const safeFilename = `${posterName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}.png`;
        formData.append('media', pngBlob, safeFilename);
        formData.append('name', posterName);

        const res = await approvedFetch(`${API_ORIGIN}/api/posters/save`, {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (data.ok) {
          posterStatus.textContent = `✓ Saved "${posterName}" to Poster Library as PNG!`;
          toast(`Saved "${posterName}" to Poster Library.`, 'success');
          await loadPosterLibrary();
        } else {
          throw new Error(data.error || 'Failed to save poster');
        }
      } catch (err) {
        console.error('[SVG Editor] Save to library error:', err);
        posterStatus.textContent = '✗ ' + err.message;
        toast('Could not save poster: ' + err.message, 'error');
      } finally {
        btnSaveLibrary.disabled = false;
      }
    });
  }

  // ─── SVG → PNG via canvas ──────────────────────────────────────────────────
  function svgToPng(svgEl) {
    return new Promise((resolve, reject) => {
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svgEl);

      // Extract viewBox or width/height for canvas sizing
      let width  = 1200;
      let height = 630;
      const vb = svgEl.getAttribute('viewBox');
      if (vb) {
        const parts = vb.trim().split(/[\s,]+/);
        if (parts.length >= 4) {
          width  = parseFloat(parts[2]) || width;
          height = parseFloat(parts[3]) || height;
        }
      } else {
        const wAttr = svgEl.getAttribute('width');
        const hAttr = svgEl.getAttribute('height');
        if (wAttr) width = parseFloat(wAttr) || width;
        if (hAttr) height = parseFloat(hAttr) || height;
      }

      const canvas = document.createElement('canvas');
      const maxDim = 3840;
      let scale = 2; // 2× for retina-quality output
      if (Math.max(width * scale, height * scale) > maxDim) {
        scale = maxDim / Math.max(width, height);
      }

      canvas.width  = Math.round(width  * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        canvas.toBlob((pngBlob) => {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error('Canvas toBlob failed'));
        }, 'image/png');
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not render SVG to canvas'));
      };
      img.src = url;
    });
  }

  // ─── Helper: showToast shim (uses the global toast() function) ────────────
  function showToast(message, isError) {
    toast(message, isError ? 'error' : 'success');
  }
})();
