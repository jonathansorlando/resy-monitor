// chrome.storage.sync helpers
// All reads/writes go through these to keep storage shape consistent.

const DEFAULTS = {
  apiKey: '',
  authToken: '',
  targets: [],
  mode: 'notify',       // "notify" | "autobook"
  intervalMinutes: 1,   // polling interval
  active: false,
};

// Load the full config object from storage, merging with defaults.
export function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (data) => resolve(data));
  });
}

// Save an arbitrary partial update to storage.
export function saveConfig(partial) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(partial, resolve);
  });
}

// Update a single target by id (shallow merge of fields).
export async function updateTarget(id, fields) {
  const { targets } = await loadConfig();
  const updated = targets.map((t) => (t.id === id ? { ...t, ...fields } : t));
  await saveConfig({ targets: updated });
}

// Add a new blank target and return it.
export async function addTarget() {
  const { targets } = await loadConfig();
  const target = {
    id: crypto.randomUUID(),
    platform: 'resy',        // "resy" | "sevenrooms"
    venueId: '',             // Resy venue ID or SevenRooms slug
    venueName: '',
    date: '',
    timeStart: '18:00',
    timeEnd: '22:00',
    partySize: 2,
    lastChecked: null,
    status: 'Not started',
  };
  await saveConfig({ targets: [...targets, target] });
  return target;
}

// Remove a target by id.
export async function removeTarget(id) {
  const { targets } = await loadConfig();
  await saveConfig({ targets: targets.filter((t) => t.id !== id) });
}
