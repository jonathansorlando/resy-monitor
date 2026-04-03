// Service worker — handles polling, booking, and notifications.
// All state lives in chrome.storage (never in-memory) because the service
// worker is suspended between alarm ticks.

import { loadConfig, saveConfig, updateTarget } from './storage.js';
import {
  getAuthToken,
  getApiKey,
  findAvailability,
  getDetails,
  bookReservation,
} from './api.js';
import {
  findAvailability as srFindAvailability,
  bookingUrl as srBookingUrl,
} from './sevenrooms-api.js';

const ALARM_NAME = 'resy-poll';

// ─── Alarm lifecycle ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(restoreAlarm);
chrome.runtime.onStartup.addListener(restoreAlarm);

async function restoreAlarm() {
  const { active, intervalMinutes } = await loadConfig();
  if (active) {
    scheduleAlarm(intervalMinutes);
  }
}

function scheduleAlarm(intervalMinutes) {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: intervalMinutes,
      periodInMinutes: intervalMinutes,
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkAvailability();
  }
});

// ─── Start / stop ─────────────────────────────────────────────────────────────

// Called from popup via chrome.runtime.sendMessage
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    handleStart(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'STOP') {
    handleStop().then(sendResponse);
    return true;
  }
});

async function handleStart({ intervalMinutes }) {
  await saveConfig({ active: true, intervalMinutes });
  scheduleAlarm(intervalMinutes);
  // Run an immediate check so the user sees feedback right away
  checkAvailability();
  return { ok: true };
}

async function handleStop() {
  await saveConfig({ active: false });
  chrome.alarms.clear(ALARM_NAME);
  return { ok: true };
}

// ─── Core polling logic ───────────────────────────────────────────────────────

async function checkAvailability() {
  const config = await loadConfig();
  if (!config.active) return;

  const [authToken, apiKey] = await Promise.all([getAuthToken(), getApiKey()]);
  if (!authToken || !apiKey) {
    await saveConfig({ active: false });
    chrome.alarms.clear(ALARM_NAME);
    notify('Resy Monitor — Not logged in', 'Browse resy.com while logged in, then restart.', null);
    return;
  }

  const { targets, mode } = config;

  // Poll all targets in parallel
  const results = await Promise.all(
    targets.map((target) => pollTarget(target, apiKey, authToken))
  );

  // Persist updated per-target statuses
  for (const { id, lastChecked, status } of results) {
    await updateTarget(id, { lastChecked, status });
  }

  // Collect targets that have available slots
  const available = results.filter((r) => r.slots && r.slots.length > 0);
  if (available.length === 0) return;

  if (mode === 'notify') {
    for (const r of available) {
      const times = r.slots.map((s) => s.time).join(', ');
      const url = r.platform === 'sevenrooms'
        ? srBookingUrl(r.venueId)
        : `https://resy.com/cities/ny/${r.urlSlug || ''}`;
      notify(
        `${r.venueName} is available!`,
        `Open times: ${times} — Click to book`,
        url
      );
    }
    // Stop monitoring after notifying — user must act manually
    await saveConfig({ active: false });
    chrome.alarms.clear(ALARM_NAME);
    return;
  }

  // autobook mode: attempt booking on Resy targets.
  // SevenRooms targets always notify-and-stop (no booking API available).
  if (mode === 'autobook') {
    for (const r of available) {
      if (r.platform === 'sevenrooms') {
        const times = r.slots.map((s) => s.time).join(', ');
        notify(
          `${r.venueName} is available! (SevenRooms)`,
          `Open times: ${times} — Click to book`,
          srBookingUrl(r.venueId)
        );
        await saveConfig({ active: false });
        chrome.alarms.clear(ALARM_NAME);
        return;
      }
      const booked = await attemptBooking(r, apiKey, authToken);
      if (booked) {
        await saveConfig({ active: false });
        chrome.alarms.clear(ALARM_NAME);
        return;
      }
    }
  }
}

// Poll a single target and return result including any matching slots.
async function pollTarget(target, apiKey, authToken) {
  const now = new Date().toISOString();
  try {
    let allSlots;
    if (target.platform === 'sevenrooms') {
      allSlots = await srFindAvailability(target.venueId, target.partySize, target.date, target.timeStart);
    } else {
      allSlots = await findAvailability(target.venueId, target.partySize, target.date, apiKey, authToken);
    }
    const slots = allSlots.filter((s) => timeInRange(s.time, target.timeStart, target.timeEnd));
    return {
      ...target,
      slots,
      lastChecked: now,
      status: slots.length > 0
        ? `${slots.length} slot(s) found!`
        : `No availability (checked ${formatTime(now)})`,
    };
  } catch (err) {
    return {
      ...target,
      slots: [],
      lastChecked: now,
      status: `Error: ${err.message}`,
    };
  }
}

// Attempt to book the first matching slot for a target.
// Returns true on success, false on failure.
async function attemptBooking(result, apiKey, authToken) {
  for (const slot of result.slots) {
    try {
      const { bookToken, paymentMethodId } = await getDetails(
        slot.configId,
        result.partySize,
        result.date,
        slot.time,
        apiKey,
        authToken
      );
      await bookReservation(
        bookToken,
        slot.configId,
        result.partySize,
        paymentMethodId,
        apiKey,
        authToken
      );
      await updateTarget(result.id, {
        status: `Booked at ${slot.time}`,
        lastChecked: new Date().toISOString(),
      });
      notify(
        `Reservation booked at ${result.venueName}!`,
        `${result.partySize} people at ${slot.time} on ${result.date}`,
        `https://resy.com/profile`
      );
      return true;
    } catch (err) {
      // Slot was taken between find and book — try next slot
      console.warn(`Booking attempt failed for ${result.venueName} at ${slot.time}: ${err.message}`);
    }
  }
  return false;
}

// ─── Notifications ────────────────────────────────────────────────────────────

function notify(title, message, url) {
  const id = `resy-${Date.now()}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: '../icons/icon-48.png',
    title,
    message,
    priority: 2,
  });
  if (url) {
    chrome.notifications.onClicked.addListener(function handler(notifId) {
      if (notifId === id) {
        chrome.tabs.create({ url });
        chrome.notifications.onClicked.removeListener(handler);
      }
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns true if HH:MM time is within [start, end] inclusive.
function timeInRange(time, start, end) {
  return time >= start && time <= end;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
