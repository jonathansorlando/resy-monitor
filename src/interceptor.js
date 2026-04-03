// Runs in the page's MAIN world (injected by content.js).
// Wraps window.fetch to capture the auth token and API key from outgoing
// requests to api.resy.com, then posts them back to the isolated world.

(function () {
  const origFetch = window.fetch;

  window.fetch = async function (...args) {
    const [input, init = {}] = args;
    const url = typeof input === 'string' ? input : input?.url || '';

    if (url.includes('resy.com')) {
      const hdrs = init.headers || {};
      // Headers may be a plain object or a Headers instance
      const get = (h, name) =>
        typeof h.get === 'function' ? h.get(name) : h[name] || h[name.toLowerCase()];

      const authToken = get(hdrs, 'X-Resy-Auth-Token');
      const authHeader = get(hdrs, 'Authorization') || '';
      const apiKeyMatch = authHeader.match(/api_key="([^"]+)"/);
      const apiKey = apiKeyMatch ? apiKeyMatch[1] : null;

      if (authToken || apiKey) {
        window.postMessage(
          { type: 'RESY_CREDENTIALS', authToken, apiKey },
          window.location.origin
        );
      }
    }

    return origFetch.apply(this, args);
  };
})();
