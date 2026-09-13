// Isolated-world content script: tracks which problem is open, receives judge results from
// intercept.js, enriches them with problem metadata, and forwards everything to the service worker.
(() => {
  const SLUG_RE = /^\/problems\/([a-z0-9-]+)/;
  const QUESTION_QUERY = `
    query leetfocusQuestion($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionId
        questionFrontendId
        title
        titleSlug
        difficulty
        topicTags { name }
      }
    }`;

  const seenSubmissions = new Set();
  const metaCache = new Map();
  let lastSlug = null;

  const currentSlug = () => location.pathname.match(SLUG_RE)?.[1] ?? null;

  async function send(type, payload) {
    try {
      return await chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      // Extension was reloaded/updated; this tab needs a refresh to reconnect.
      return null;
    }
  }

  // LeetCode is a single-page app, so watch for client-side navigation between problems.
  function checkNavigation() {
    const slug = currentSlug();
    if (slug && slug !== lastSlug) send('problem:opened', { slug });
    lastSlug = slug;
  }
  checkNavigation();
  setInterval(checkNavigation, 1000);

  async function fetchMeta(slug) {
    if (metaCache.has(slug)) return metaCache.get(slug);
    const fallback = {
      titleSlug: slug,
      title: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      questionId: null,
      questionFrontendId: null,
      difficulty: null,
      tags: [],
    };
    try {
      const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
      const res = await fetch('/graphql/', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrftoken': csrf } : {}) },
        body: JSON.stringify({ query: QUESTION_QUERY, variables: { titleSlug: slug } }),
      });
      const q = (await res.json())?.data?.question;
      if (!q) return fallback;
      const meta = {
        titleSlug: q.titleSlug,
        title: q.title,
        questionId: q.questionId,
        questionFrontendId: q.questionFrontendId,
        difficulty: q.difficulty,
        tags: (q.topicTags ?? []).map((t) => t.name),
      };
      metaCache.set(slug, meta);
      return meta;
    } catch {
      return fallback;
    }
  }

  const percent = (value) => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'leetfocus-intercept') return;
    const { submissionId, payload } = event.data;
    if (seenSubmissions.has(submissionId)) return;
    seenSubmissions.add(submissionId);

    const slug = currentSlug();
    if (!slug) return;

    if (payload.status_msg !== 'Accepted') {
      send('problem:attempt', { slug, status: payload.status_msg });
      return;
    }

    const meta = await fetchMeta(slug);
    // Guard against a result that belongs to a different problem than the one on screen.
    if (meta.questionId && payload.question_id && String(meta.questionId) !== String(payload.question_id)) return;

    const response = await send('problem:solved', {
      meta,
      result: {
        submissionId,
        lang: payload.pretty_lang ?? payload.lang ?? null,
        runtime: payload.status_runtime ?? null,
        runtimePct: percent(payload.runtime_percentile),
        memory: payload.status_memory ?? null,
        memoryPct: percent(payload.memory_percentile),
      },
    });

    if (response?.ok) {
      showToast(response.data.isNew ? `Saved “${meta.title}” to LeetFocus` : `Logged another solve of “${meta.title}”`);
    } else if (response === null) {
      showToast('LeetFocus was updated. Refresh this tab to keep tracking.');
    }
  });

  function showToast(text) {
    const toast = document.createElement('div');
    toast.textContent = `🍅 ${text}`;
    Object.assign(toast.style, {
      position: 'fixed',
      left: '50%',
      bottom: '20px',
      translate: '-50% 0', // centered so it never sits under the floating timer
      zIndex: '2147483647',
      padding: '10px 14px',
      borderRadius: '10px',
      background: '#1c1c21',
      color: '#eceae6',
      font: '500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.25)',
      border: '1px solid #303038',
      opacity: '0',
      transform: 'translateY(8px)',
      transition: 'opacity .2s ease, transform .2s ease',
      maxWidth: '360px',
    });
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }
})();
