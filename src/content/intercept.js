// Runs in the page's MAIN world so it can observe LeetCode's own network calls.
// After you press Submit, LeetCode polls /submissions/detail/<id>/check/ until the judge finishes.
// We read the final result and hand it to bridge.js (isolated world) via window.postMessage.
(() => {
  if (window.__leetfocusPatched) return;
  window.__leetfocusPatched = true;

  // Numeric ids are real submissions; "Run" uses ids like runcode_123_abc and is ignored.
  const CHECK_RE = /\/submissions\/detail\/(\d+)\/check\/?/;

  const emit = (submissionId, payload) => {
    if (payload?.state !== 'SUCCESS') return;
    window.postMessage({ source: 'leetfocus-intercept', submissionId, payload }, window.location.origin);
  };

  const urlOf = (input) => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url ?? '';
  };

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const match = urlOf(args[0]).match(CHECK_RE);
      if (match) {
        response
          .clone()
          .json()
          .then((data) => emit(match[1], data))
          .catch(() => {});
      }
    } catch {
      // Never break the page.
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const match = String(url).match(CHECK_RE);
    if (match) {
      this.addEventListener('load', () => {
        try {
          emit(match[1], JSON.parse(this.responseText));
        } catch {
          // Ignore non-JSON responses.
        }
      });
    }
    return originalOpen.call(this, method, url, ...rest);
  };
})();
