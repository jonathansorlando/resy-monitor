// SevenRooms API module
// Availability uses the public widget API — no authentication required.
// Booking requires official SevenRooms API credentials (not yet implemented).

const WIDGET_BASE = 'https://www.sevenrooms.com/api-yoa';

// Extract the venue slug from a SevenRooms URL or return the value as-is
// if it's already a slug.
// Handles:
//   https://www.sevenrooms.com/reservations/restaurantname
//   https://www.sevenrooms.com/explore/nyc/restaurantname
//   restaurantname  (raw slug)
export function parseVenueSlug(input) {
  try {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);
    // Last non-empty path segment is the venue slug
    return parts[parts.length - 1] || '';
  } catch {
    // Not a URL — treat as raw slug
    return input.trim();
  }
}

// GET /api-yoa/availability/widget/range
// Returns array of { time, accessPersistentId, description } for bookable slots.
export async function findAvailability(venueSlug, partySize, date, timeStart) {
  // SevenRooms date format: MM-DD-YYYY
  const [year, month, day] = date.split('-');
  const srDate = `${month}-${day}-${year}`;

  const params = new URLSearchParams({
    venue: venueSlug,
    time_slot: timeStart,       // preferred anchor time; filter to range after
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
      // time_iso: "2025-12-25T19:00:00"
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
