# Resy Monitor

A Chrome extension that monitors Resy for restaurant reservation availability and either notifies you or automatically books when a slot opens.

## Features

- Monitor multiple restaurants simultaneously
- Filter by date, time window, and party size
- **Notify mode** — desktop notification when availability is found, click to open Resy
- **Auto-book mode** — automatically books the first available slot and stops monitoring
- Configurable polling interval (30s, 1m, 2m, 5m)
- Polling survives browser background/sleep via Chrome's alarms API

## Installation

1. Clone this repo:
   ```bash
   git clone https://github.com/jonathansorlando/resy-monitor.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `resy-monitor` folder

## Setup

The extension requires a Resy API key and auth token, both extracted from your logged-in Resy session:

1. Log into [resy.com](https://resy.com) in Chrome
2. Open DevTools (`F12`) → **Network** tab
3. Search for any restaurant on resy.com to trigger an API call
4. Click any request to `api.resy.com` → **Request Headers**
5. Copy the value inside `api_key="…"` from the `Authorization` header → paste into the **API Key** field in the extension
6. Copy the full value of `X-Resy-Auth-Token` → paste into the **Auth Token** field

Both tokens are valid for ~45 days. Click **"How to get these ›"** in the popup for a reminder.

## Usage

1. Click the Resy Monitor icon in the Chrome toolbar
2. Enter your API Key and Auth Token
3. Click **+ Add Restaurant** and search for a venue
4. Set your target **date**, **time window**, and **party size**
5. Add more restaurants if desired (all are monitored simultaneously)
6. Choose **Notify me** or **Auto-book**
7. Select a polling interval and click **Start Monitoring**

In **Auto-book** mode, the first successful booking stops all monitoring and sends a confirmation notification.

## Project Structure

```
resy-monitor/
├── manifest.json          # Chrome Extension Manifest V3 config
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── src/
    ├── api.js             # Resy API module (auth, search, availability, booking)
    ├── storage.js         # chrome.storage.sync helpers and schema
    ├── background.js      # Service worker: polling loop, booking flow, notifications
    ├── content.js         # Content script injected into resy.com (auth capture)
    ├── interceptor.js     # Runs in page's main world to intercept fetch calls
    ├── popup.html         # Extension popup markup
    ├── popup.js           # Popup logic: setup view, status view, restaurant search
    └── popup.css          # Popup styles
```

### Key Files

**`src/api.js`**
All Resy API calls. Reads credentials from `chrome.storage.sync`. Key functions:
- `getAuthToken()` / `getApiKey()` — credential accessors
- `searchVenues(query, apiKey, token)` — venue search via `/3/venuesearch/search`
- `findAvailability(venueId, partySize, date, apiKey, token)` — slot search via `/4/find`
- `getDetails(configId, ...)` — exchange config ID for a book token via `/3/details`
- `bookReservation(bookToken, ...)` — complete reservation via `/3/book`

**`src/background.js`**
Service worker that handles all background activity:
- Uses `chrome.alarms` (not `setInterval`) so polling survives service worker suspension
- On each alarm tick, polls all targets in parallel via `Promise.all`
- In auto-book mode, attempts booking on the first target with matching slots; on success clears the alarm and stops all monitoring
- All state is persisted in `chrome.storage` — nothing is held in memory

**`src/storage.js`**
Typed wrappers around `chrome.storage.sync`. Storage schema:
```js
{
  apiKey: string,
  authToken: string,
  targets: [{
    id, venueId, venueName, date,
    timeStart, timeEnd, partySize,
    lastChecked, status
  }],
  mode: "notify" | "autobook",
  intervalMinutes: number,
  active: boolean
}
```

**`src/popup.js`**
Popup has two views:
- **Setup view** — credential entry, restaurant search, target configuration, start button
- **Status view** — live per-target status cards with a pulsing green indicator, stop button

The popup uses `chrome.storage.onChanged` to receive live updates from the service worker without message passing.

**`src/content.js` + `src/interceptor.js`**
`content.js` runs in the isolated world on resy.com and injects `interceptor.js` into the page's main world. `interceptor.js` wraps `window.fetch` to capture `X-Resy-Auth-Token` and the API key from outgoing requests and passes them back via `postMessage`. This enables automatic credential capture without manual DevTools extraction (when CSP allows).

## Resy API Overview

The extension uses Resy's undocumented internal API. Booking follows a mandatory three-step sequence:

```
GET  /4/find      → available slots (configId per slot)
POST /3/details   → exchange configId for a bookToken
POST /3/book      → complete reservation with bookToken
```

Authentication requires two headers on every request:
- `Authorization: ResyAPI api_key="<key>"`
- `X-Resy-Auth-Token: <token>`

## Notes

- Resy does not offer a public API; this extension uses the same internal API as resy.com
- Credentials expire approximately every 45 days and must be refreshed manually
- The extension only books on your behalf using your own account credentials
