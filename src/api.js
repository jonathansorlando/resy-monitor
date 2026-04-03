// Resy API module
// All requests are made from the service worker context, which bypasses CORS
// for domains listed in host_permissions.

const BASE_URL = 'https://api.resy.com';

// Reads the user's auth token directly from their active resy.com session cookie.
// Returns null if not logged in.
export async function getAuthToken() {
  const { authToken } = await new Promise((resolve) =>
    chrome.storage.sync.get(['authToken'], resolve)
  );
  return authToken || null;
}

export async function getApiKey() {
  const { apiKey } = await new Promise((resolve) =>
    chrome.storage.sync.get(['apiKey'], resolve)
  );
  return apiKey || null;
}

// Build headers common to all requests.
function headers(apiKey, authToken) {
  return {
    'Authorization': `ResyAPI api_key="${apiKey}"`,
    'X-Resy-Auth-Token': authToken,
    'X-Resy-Universal-Auth': authToken,
    'Origin': 'https://resy.com',
    'Referer': 'https://resy.com/',
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Cache-Control': 'no-cache',
  };
}

async function apiFetch(path, options, apiKey, authToken) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: headers(apiKey, authToken),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resy API ${res.status} on ${path}: ${text}`);
  }
  return res.json();
}

// GET /2/user — returns the user profile including default payment method id.
export async function getUser(apiKey, authToken) {
  const data = await apiFetch('/2/user', { method: 'GET' }, apiKey, authToken);
  // Find default payment method id
  const methods = data.payment_methods || [];
  const def = methods.find((m) => m.is_default) || methods[0];
  return { paymentMethodId: def ? String(def.id) : null, data };
}

// POST /3/venuesearch/search — search restaurants by name.
// Returns array of { venueId, name, locality, region, urlSlug }.
export async function searchVenues(query, apiKey, authToken) {
  const data = await apiFetch(
    '/3/venuesearch/search',
    {
      method: 'POST',
      body: JSON.stringify({ query }),
    },
    apiKey,
    authToken
  );
  // Handle multiple possible response shapes from Resy's API
  const hits =
    data.search?.hits ||
    data.hits ||
    data.results?.hits ||
    data.venues ||
    [];
  return hits.map((h) => ({
    // Algolia-style responses use objectID; others use id or nested venue id
    venueId: String(h.objectID || h.id?.resy || h.id || h.venue?.id?.resy || h.venue?.id || ''),
    name: h.name || h.venue?.name || '',
    locality: h.locality || h.location?.locality || '',
    region: h.region || h.location?.region || '',
    urlSlug: h.url_slug || h.venue?.url_slug || '',
  })).filter((v) => v.venueId && v.name);
}

// GET /4/find — find available slots for a venue/date/party.
// Returns array of { time, configId, tableType, partySize }.
export async function findAvailability(venueId, partySize, date, apiKey, authToken) {
  const params = new URLSearchParams({
    venue_id: venueId,
    party_size: String(partySize),
    day: date,
    lat: '0',
    long: '0',
  });
  const data = await apiFetch(`/4/find?${params}`, { method: 'GET' }, apiKey, authToken);

  const venues = data.results?.venues || [];
  const slots = [];
  for (const v of venues) {
    for (const slotGroup of v.slots || []) {
      const config = slotGroup.config || {};
      // time format: "19:00:00" or "19:00"
      const rawTime = slotGroup.date?.start || '';
      const time = rawTime.length > 5 ? rawTime.substring(11, 16) : rawTime;
      slots.push({
        time,          // "HH:MM"
        configId: String(config.id || ''),
        configToken: config.token || '',
        tableType: config.type || '',
        partySize: slotGroup.size?.covers || partySize,
      });
    }
  }
  return slots;
}

// POST /3/details — exchange a configId for a book token.
// Returns { bookToken, paymentMethodId }.
export async function getDetails(configId, partySize, day, time, apiKey, authToken) {
  const data = await apiFetch(
    '/3/details',
    {
      method: 'POST',
      body: JSON.stringify({
        config_id: configId,
        party_size: partySize,
        day,
        time_slot: time,
      }),
    },
    apiKey,
    authToken
  );

  const bookToken = data.book_token?.value || data.book_token || '';
  const methods = data.payment_methods || [];
  const def = methods.find((m) => m.is_default) || methods[0];
  return {
    bookToken,
    paymentMethodId: def ? String(def.id) : null,
  };
}

// POST /3/book — complete the reservation.
// Returns the booking confirmation object.
export async function bookReservation(
  bookToken,
  configId,
  partySize,
  paymentMethodId,
  apiKey,
  authToken
) {
  const body = {
    book_token: { value: bookToken },
    source_id: 'resy.com-venue-page',
    party_size: partySize,
    config_id: configId,
  };
  if (paymentMethodId) {
    body.payment_method_id = paymentMethodId;
  }
  const data = await apiFetch(
    '/3/book',
    { method: 'POST', body: JSON.stringify(body) },
    apiKey,
    authToken
  );
  return data;
}
