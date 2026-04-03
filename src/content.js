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
  if (e.data.authToken) update.authToken = e.data.authToken;
  if (e.data.apiKey)    update.apiKey    = e.data.apiKey;

  if (Object.keys(update).length > 0) {
    chrome.storage.sync.set(update);
    console.log('[ResyMonitor] Captured credentials from page:', Object.keys(update));
  }
});

// Proxy fetch requests from the background service worker.
// Requests made from this content-script context carry real resy.com session
// cookies, which the service worker context cannot replicate.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'PROXY_FETCH') return;

  fetch(msg.url, {
    method: msg.method || 'GET',
    headers: msg.headers || {},
    credentials: 'include',
  })
    .then(async (res) => {
      const text = await res.text().catch(() => '');
      const respHeaders = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      sendResponse({ ok: res.ok, status: res.status, text, respHeaders });
    })
    .catch((err) => sendResponse({ error: err.message }));

  return true; // keep the message channel open for the async response
});
