// Popup script — runs in the extension popup window.
// Communicates with the service worker via chrome.runtime.sendMessage.
// Watches chrome.storage.onChanged for live status updates.

import { loadConfig, saveConfig, addTarget, removeTarget, updateTarget } from './storage.js';
import { getAuthToken, getApiKey, searchVenues } from './api.js';
import { parseVenueSlug, fetchVenueInfo } from './sevenrooms-api.js';

// ── DOM refs ────────────────────────────────────────────────────────────────
const authBadge       = document.getElementById('auth-badge');
const viewSetup       = document.getElementById('view-setup');
const viewStatus      = document.getElementById('view-status');
const apiKeyInput     = document.getElementById('api-key');
const authTokenInput  = document.getElementById('auth-token');
const credsHelp       = document.getElementById('creds-help');
const credsHint       = document.getElementById('creds-hint');
const modeSelect      = document.getElementById('mode');
const intervalSelect  = document.getElementById('interval');
const targetsList     = document.getElementById('targets-list');
const noTargetsMsg    = document.getElementById('no-targets-msg');
const btnAddTarget    = document.getElementById('btn-add-target');
const btnStart        = document.getElementById('btn-start');
const btnStop         = document.getElementById('btn-stop');
const statusSummary   = document.getElementById('status-summary');
const statusTargets   = document.getElementById('status-targets');
const tplTarget       = document.getElementById('tpl-target');
const tplStatusTarget = document.getElementById('tpl-status-target');

// ── Time slot options (30-min intervals) ────────────────────────────────────
function buildTimeOptions(selectEl, defaultValue) {
  selectEl.innerHTML = '';
  for (let h = 11; h <= 23; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const val = `${hh}:${mm}`;
      const label = formatHour(h, m);
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (val === defaultValue) opt.selected = true;
      selectEl.appendChild(opt);
    }
  }
}

function formatHour(h, m) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  await checkAuth();
  const config = await loadConfig();
  apiKeyInput.value   = config.apiKey    || '';
  authTokenInput.value = config.authToken || '';
  modeSelect.value = config.mode || 'notify';
  intervalSelect.value = String(config.intervalMinutes || 1);

  if (config.active) {
    showStatusView(config);
  } else {
    showSetupView(config);
  }

  // Listen for storage changes to update status view live
  chrome.storage.onChanged.addListener(async (changes) => {
    const updated = await loadConfig();
    if (updated.active) {
      showStatusView(updated);
    } else {
      showSetupView(updated);
    }
  });
}

// ── Auth check ───────────────────────────────────────────────────────────────
async function checkAuth() {
  const [token, apiKey] = await Promise.all([getAuthToken(), getApiKey()]);
  if (token && apiKey) {
    authBadge.textContent = 'Ready';
    authBadge.className = 'badge badge--ok';
  } else {
    authBadge.textContent = 'Needs credentials';
    authBadge.className = 'badge badge--error';
  }
}

// ── Setup view ───────────────────────────────────────────────────────────────
function showSetupView(config) {
  viewSetup.classList.remove('hidden');
  viewStatus.classList.add('hidden');
  renderTargetCards(config.targets || []);
  validateStartButton(config.targets || []);
}

function renderTargetCards(targets) {
  targetsList.innerHTML = '';
  if (targets.length === 0) {
    noTargetsMsg.classList.remove('hidden');
    return;
  }
  noTargetsMsg.classList.add('hidden');
  for (const target of targets) {
    targetsList.appendChild(buildTargetCard(target));
  }
}

function buildTargetCard(target) {
  const frag = tplTarget.content.cloneNode(true);
  const card = frag.querySelector('.target-card');
  card.dataset.id = target.id;

  const titleEl      = card.querySelector('.target-card__title');
  const venueSearch  = card.querySelector('.input--venue-search');
  const venueId      = card.querySelector('.input--venue-id');
  const resultsEl    = card.querySelector('.search-results');
  const srUrlInput   = card.querySelector('.input--sr-url');
  const venueResyEl  = card.querySelector('.venue-resy');
  const venueSrEl    = card.querySelector('.venue-sevenrooms');
  const platformBtns = card.querySelectorAll('.platform-btn');
  const dateInput    = card.querySelector('.input--date');
  const partySizeEl  = card.querySelector('.input--party-size');
  const timeStartEl  = card.querySelector('.input--time-start');
  const timeEndEl    = card.querySelector('.input--time-end');
  const removeBtn    = card.querySelector('.btn--remove');

  // ── Platform toggle ──────────────────────────────────────────
  const currentPlatform = target.platform || 'resy';
  function applyPlatform(platform) {
    platformBtns.forEach((b) => {
      b.classList.toggle('platform-btn--active', b.dataset.platform === platform);
    });
    venueResyEl.classList.toggle('hidden', platform !== 'resy');
    venueSrEl.classList.toggle('hidden', platform !== 'sevenrooms');
  }
  applyPlatform(currentPlatform);

  platformBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.platform;
      applyPlatform(p);
      await updateTarget(target.id, { platform: p, venueId: '', venueName: '' });
      titleEl.textContent = 'Restaurant';
      revalidate();
    });
  });

  // ── Resy venue search ────────────────────────────────────────
  if (target.venueName) {
    venueSearch.value = target.venueName;
    titleEl.textContent = target.venueName;
  }
  venueId.value = target.venueId || '';

  let searchTimer;
  venueSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = venueSearch.value.trim();
    if (q.length < 2) { resultsEl.classList.add('hidden'); return; }
    searchTimer = setTimeout(() => doVenueSearch(q, resultsEl, venueSearch, venueId, titleEl, target.id), 350);
  });
  venueSearch.addEventListener('blur', () => {
    setTimeout(() => resultsEl.classList.add('hidden'), 200);
  });

  // ── SevenRooms URL ───────────────────────────────────────────
  const srValidation = card.querySelector('.sr-validation');
  if (target.platform === 'sevenrooms' && target.venueId) {
    srUrlInput.value = target.venueId;
    titleEl.textContent = target.venueName || target.venueId;
  }

  async function handleSrUrlChange() {
    const raw = srUrlInput.value.trim();
    if (!raw) return;
    const slug = parseVenueSlug(raw);
    if (!slug) {
      setSrValidation(srValidation, 'error', 'Could not extract venue slug from URL');
      return;
    }

    setSrValidation(srValidation, 'loading', 'Validating venue…');
    const { valid, name } = await fetchVenueInfo(slug);

    if (!valid) {
      setSrValidation(srValidation, 'error', `Venue "${slug}" not found on SevenRooms`);
      await updateTarget(target.id, { venueId: '', venueName: '' });
      titleEl.textContent = 'Restaurant';
      revalidate();
      return;
    }

    setSrValidation(srValidation, 'ok', `Found: ${name}`);
    titleEl.textContent = name;
    await updateTarget(target.id, { venueId: slug, venueName: name });
    revalidate();
  }

  srUrlInput.addEventListener('change', handleSrUrlChange);
  srUrlInput.addEventListener('blur', handleSrUrlChange);

  // ── Shared field persistence ─────────────────────────────────
  dateInput.value    = target.date || '';
  partySizeEl.value  = String(target.partySize || 2);
  buildTimeOptions(timeStartEl, target.timeStart || '18:00');
  buildTimeOptions(timeEndEl, target.timeEnd || '22:00');
  dateInput.min = new Date().toISOString().split('T')[0];

  dateInput.addEventListener('change', () => updateTarget(target.id, { date: dateInput.value }).then(revalidate));
  partySizeEl.addEventListener('change', () => updateTarget(target.id, { partySize: Number(partySizeEl.value) }));
  timeStartEl.addEventListener('change', () => updateTarget(target.id, { timeStart: timeStartEl.value }));
  timeEndEl.addEventListener('change', () => updateTarget(target.id, { timeEnd: timeEndEl.value }));

  // Remove button
  removeBtn.addEventListener('click', async () => {
    await removeTarget(target.id);
    const config = await loadConfig();
    renderTargetCards(config.targets);
    validateStartButton(config.targets);
  });

  return frag;
}

async function doVenueSearch(query, resultsEl, searchInput, venueIdInput, titleEl, targetId) {
  const [apiKey, token] = await Promise.all([getApiKey(), getAuthToken()]);

  if (!token) {
    showSearchError(resultsEl, 'Log into resy.com, browse around, then retry');
    return;
  }
  if (!apiKey) {
    showSearchError(resultsEl, 'Browse resy.com while logged in to capture API key');
    return;
  }

  showSearchLoading(resultsEl);
  try {
    const venues = await searchVenues(query, apiKey, token);
    showSearchResults(resultsEl, venues, async (venue) => {
      searchInput.value = venue.name;
      venueIdInput.value = venue.venueId;
      titleEl.textContent = venue.name;
      resultsEl.classList.add('hidden');
      await updateTarget(targetId, { venueId: venue.venueId, venueName: venue.name, urlSlug: venue.urlSlug });
      revalidate();
    });
  } catch (err) {
    showSearchError(resultsEl, `Search failed: ${err.message}`);
  }
}

function showSearchResults(el, venues, onSelect) {
  el.innerHTML = '';
  if (venues.length === 0) {
    const li = document.createElement('li');
    li.className = 'no-results';
    li.textContent = 'No results';
    el.appendChild(li);
  } else {
    for (const v of venues) {
      const li = document.createElement('li');
      li.innerHTML = `${v.name} <span class="venue-loc">${[v.locality, v.region].filter(Boolean).join(', ')}</span>`;
      li.addEventListener('click', () => onSelect && onSelect(v));
      el.appendChild(li);
    }
  }
  el.classList.remove('hidden');
}

function setSrValidation(el, state, message) {
  el.textContent = message;
  el.className = `sr-validation sr-validation--${state}`;
  el.classList.remove('hidden');
}

function showSearchLoading(el) {
  el.innerHTML = '<li class="no-results">Searching…</li>';
  el.classList.remove('hidden');
}

function showSearchError(el, message) {
  el.innerHTML = `<li class="no-results search-error">${message}</li>`;
  el.classList.remove('hidden');
}

async function revalidate() {
  const { targets } = await loadConfig();
  validateStartButton(targets);
}

function validateStartButton(targets) {
  const valid = targets.length > 0 && targets.every((t) => t.venueId && t.date);
  btnStart.disabled = !valid;
}

// ── Status view ───────────────────────────────────────────────────────────────
function showStatusView(config) {
  viewSetup.classList.add('hidden');
  viewStatus.classList.remove('hidden');

  const count = (config.targets || []).length;
  statusSummary.textContent = `Monitoring ${count} restaurant${count !== 1 ? 's' : ''} — every ${formatInterval(config.intervalMinutes)} min`;

  statusTargets.innerHTML = '';
  for (const t of config.targets || []) {
    const frag = tplStatusTarget.content.cloneNode(true);
    const card = frag.querySelector('.status-card');
    card.dataset.id = t.id;
    card.querySelector('.status-card__name').textContent = t.venueName || '(unnamed)';
    card.querySelector('.status-card__meta').textContent =
      `${t.date} · ${t.timeStart}–${t.timeEnd} · Party of ${t.partySize}`;
    const statusEl = card.querySelector('.status-card__status');
    statusEl.textContent = t.status || 'Waiting…';
    if (t.status && t.status.includes('found')) statusEl.classList.add('found');
    if (t.status && t.status.startsWith('Error')) statusEl.classList.add('error');
    statusTargets.appendChild(frag);
  }
}

function formatInterval(mins) {
  if (!mins || mins === 1) return '1';
  if (mins < 1) return '30s';
  return String(mins);
}

// ── Event listeners ───────────────────────────────────────────────────────────
credsHelp.addEventListener('click', (e) => {
  e.preventDefault();
  credsHint.classList.toggle('hidden');
});

apiKeyInput.addEventListener('change', () => {
  saveConfig({ apiKey: apiKeyInput.value.trim() });
  checkAuth();
});

authTokenInput.addEventListener('change', () => {
  saveConfig({ authToken: authTokenInput.value.trim() });
  checkAuth();
});

modeSelect.addEventListener('change', () => saveConfig({ mode: modeSelect.value }));
intervalSelect.addEventListener('change', () => saveConfig({ intervalMinutes: Number(intervalSelect.value) }));

btnAddTarget.addEventListener('click', async () => {
  const target = await addTarget();
  noTargetsMsg.classList.add('hidden');
  const card = buildTargetCard(target);
  targetsList.appendChild(card);
  validateStartButton((await loadConfig()).targets);

  // Scroll to the new card and focus the first input field
  const addedCard = targetsList.lastElementChild;
  addedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const firstInput = addedCard.querySelector('.input--venue-search, .input--sr-url');
  if (firstInput) firstInput.focus();
});

btnStart.addEventListener('click', async () => {
  const { intervalMinutes } = await loadConfig();
  const [apiKey, token] = await Promise.all([getApiKey(), getAuthToken()]);
  if (!apiKey || !token) {
    credsHint.classList.remove('hidden');
    return;
  }
  chrome.runtime.sendMessage({ type: 'START', intervalMinutes });
});

btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP' });
});

// ── Boot ─────────────────────────────────────────────────────────────────────
init();
