// SevenRooms API module
// Availability uses the public widget API — no authentication required.
// Booking requires official SevenRooms API credentials (not yet implemented).

const WIDGET_BASE = 'https://www.sevenrooms.com/api-yoa';

// Extract the venue slug from any known SevenRooms URL format, or return
// the input as-is if it's already a plain slug.
//
// Handles:
//   https://www.sevenrooms.com/reservations/theeightysix
//   https://www.sevenrooms.com/explore/nyc/theeightysix
//   https://fp.sevenrooms.com/explore/theeightysix/reservations/create/search/
//   theeightysix  (raw slug)
export function parseVenueSlug(input) {
  const raw = input.trim();
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);

    // fp.sevenrooms.com/explore/{slug}/reservations/...
    // www.sevenrooms.com/explore/{city}/{slug}
    // www.sevenrooms.com/reservations/{slug}
    const exploreIdx = parts.indexOf('explore');
    if (exploreIdx !== -1) {
      // The slug is the segment immediately after 'explore'
      // (on fp.sevenrooms.com this is the venue; on www it may be a city followed by venue)
      const afterExplore = parts.slice(exploreIdx + 1);
      // Skip known non-slug segments
      const skip = new Set(['reservations', 'create', 'search', 'widget']);
      const slug = afterExplore.find((p) => !skip.has(p));
      if (slug) return slug;
    }

    const reservationsIdx = parts.indexOf('reservations');
    if (reservationsIdx !== -1 && parts[reservationsIdx + 1]) {
      return parts[reservationsIdx + 1];
    }

    // Fallback: last path segment that isn't a known keyword
    const skip = new Set(['reservations', 'create', 'search', 'widget', 'explore']);
    const candidate = [...parts].reverse().find((p) => !skip.has(p));
    return candidate || '';
  } catch {
    // Not a URL — treat as raw slug
    return raw;
  }
}

// Validate a venue slug by fetching its widget details page, and return
// the real venue name if available.
// Returns { valid: boolean, name: string }.
export async function fetchVenueInfo(slug) {
  try {
    // The widget details endpoint returns venue metadata including the display name
    const res = await fetch(
      `https://www.sevenrooms.com/api-yoa/venues/${slug}`,
      {
        headers: {
          'Accept': 'application/json',
          'Referer': `https://www.sevenrooms.com/reservations/${slug}`,
        },
      }
    );

    if (res.ok) {
      const data = await res.json();
      const name = data?.data?.name || data?.name || null;
      if (name) return { valid: true, name };
    }

    // Fallback: make a minimal availability call — if the API responds at all
    // (even with empty slots) the slug is valid
    const today = new Date().toISOString().split('T')[0];
    const [year, month, day] = today.split('-');
    const params = new URLSearchParams({
      venue: slug,
      time_slot: '19:00',
      party_size: '2',
      halo_size_interval: '16',
      start_date: `${month}-${day}-${year}`,
      num_days: '1',
      channel: 'SEVENROOMS_WIDGET',
    });

    const avRes = await fetch(
      `${WIDGET_BASE}/availability/widget/range?${params}`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!avRes.ok) return { valid: false, name: null };

    const avData = await avRes.json();
    // Try to pull the venue name from the availability response
    const name =
      avData?.data?.venue?.name ||
      avData?.data?.name ||
      formatSlugAsName(slug);

    return { valid: true, name };
  } catch {
    return { valid: false, name: null };
  }
}

// Best-effort: title-case a slug, splitting on common camelCase boundaries.
// e.g. "theeightysix" → "Theeightysix" (can't do better without word boundaries)
// e.g. "the-eighty-six" → "The Eighty Six"
export function formatSlugAsName(slug) {
  return slug
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// GET /api-yoa/availability/widget/range
// Returns array of { time, accessPersistentId, description } for bookable slots.
export async function findAvailability(venueSlug, partySize, date, timeStart) {
  // SevenRooms date format: MM-DD-YYYY
  const [year, month, day] = date.split('-');
  const srDate = `${month}-${day}-${year}`;

  const params = new URLSearchParams({
    venue: venueSlug,
    time_slot: timeStart,
    party_size: String(partySize),
    halo_size_interval: '16',
    start_date: srDate,
    num_days: '1',
    channel: 'SEVENROOMS_WIDGET',
  });

  const res = await fetch(`${WIDGET_BASE}/availability/widget/range?${params}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Origin': 'https://www.sevenrooms.com',
      'Referer': `https://www.sevenrooms.com/reservations/${venueSlug}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SevenRooms API ${res.status}: ${text.slice(0, 120)}`);
  }

  const data = await res.json();
  const dayData = data?.data?.availability?.[date] || [];
  const slots = [];

  for (const group of dayData) {
    for (const t of group.times || []) {
      if (t.type !== 'book') continue;
      const time = t.time_iso ? t.time_iso.substring(11, 16) : '';
      if (!time) continue;
      slots.push({
        time,
        accessPersistentId: t.access_persistent_id || '',
        description: t.public_time_slot_description || '',
      });
    }
  }

  return slots;
}

// Build the direct booking URL for a SevenRooms venue.
export function bookingUrl(venueSlug) {
  return `https://www.sevenrooms.com/reservations/${venueSlug}`;
}
