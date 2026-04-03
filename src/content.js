// Isolated world content script — runs on resy.com pages.
// Injects interceptor.js into the page's MAIN world so it can wrap fetch,
// then receives captured credentials via postMessage and stores them.

// Inject the interceptor into the main world
const script = document.createElement('script');
script.src = chrome.runtime.getURL('src/interceptor.js');
(document.head || document.documentElement).appendChild(script);
script.addEventListener('load', () => script.remove());

// Receive captured credentials from the interceptor
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.type !== 'RESY_CREDENTIALS') return;

  const update = {};
  if (e.data.authToken) update.resyAuthToken = e.data.authToken;
  if (e.data.apiKey)    update.resyApiKey    = e.data.apiKey;

  if (Object.keys(update).length > 0) {
    chrome.storage.local.set(update);
    console.log('[ResyMonitor] Captured credentials from page:', Object.keys(update));
  }
});
