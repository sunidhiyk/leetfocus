// Isolated-world content script: tracks which problem is open, detects judge results, enriches them
// with problem metadata, and forwards everything to the service worker.
//
// Results are detected two independent ways, so a change on LeetCode's side is less likely to break tracking:
//   1. intercept.js observes the /submissions/detail/<id>/check/ polling response (fastest).
//   2. After submitting, LeetCode opens /problems/<slug>/submissions/<id>/; we look that id up via GraphQL.
// Both paths share one dedupe set, and the service worker also dedupes by submission id.
(() => {
  const SLUG_RE = /^\/problems\/([a-z0-9-]+)/;
  const SUBMISSION_URL_RE = /^\/problems\/([a-z0-9-]+)\/submissions\/(\d+)/;
  const RECENT_SUBMISSION_MS = 15 * 60 * 1000; // opening an old submission page must not log it as a new solve
  const DETAILS_POLL_MS = 1500;
  const DETAILS_MAX_POLLS = 12;
  const STATUS_NAMES = {
    10: 'Accepted',
    11: 'Wrong Answer',
    12: 'Memory Limit Exceeded',
    13: 'Output Limit Exceeded',
    14: 'Time Limit Exceeded',
    15: 'Runtime Error',
    16: 'Internal Error',
    20: 'Compile Error',
  };

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

  const SUBMISSION_QUERY = `
    query leetfocusSubmission($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        statusCode
        timestamp
        runtimeDisplay
        runtimePercentile
        memoryDisplay
        memoryPercentile
        lang { verboseName }
        question { questionId titleSlug }
      }
    }`;

  const seenSubmissions = new Set();
  const lookedUpSubmissions = new Set();
  const metaCache = new Map();
  let lastSlug = null;

  const log = (...args) => console.info('[LeetFocus]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const currentSlug = () => location.pathname.match(SLUG_RE)?.[1] ?? null;
  const percent = (value) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

  async function send(type, payload) {
    try {
      return await chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      // Extension was reloaded/updated; this tab needs a refresh to reconnect.
      return null;
    }
  }

  async function graphql(query, variables) {
    const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    const res = await fetch('/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrftoken': csrf } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    return (await res.json())?.data;
  }

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
      const q = (await graphql(QUESTION_QUERY, { titleSlug: slug }))?.question;
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
    } catch (error) {
      log('Could not load problem details, saving with basic info.', error);
      return fallback;
    }
  }

  // Shared by both detection paths. `result` is normalized: { status, questionId, lang, runtime, ... }.
  async function handleResult(submissionId, slug, result, via) {
    if (seenSubmissions.has(submissionId)) return;
    seenSubmissions.add(submissionId);
    log(`Submission ${submissionId} on "${slug}": ${result.status} (detected via ${via})`);

    if (result.status !== 'Accepted') {
      send('problem:attempt', { slug, status: result.status });
      return;
    }

    const meta = await fetchMeta(slug);
    // Guard against a result that belongs to a different problem than the one on screen.
    if (meta.questionId && result.questionId && String(meta.questionId) !== String(result.questionId)) {
      log('Result belongs to a different problem; ignored.');
      return;
    }

    const response = await send('problem:solved', {
      meta,
      result: {
        submissionId,
        lang: result.lang,
        runtime: result.runtime,
        runtimePct: result.runtimePct,
        memory: result.memory,
        memoryPct: result.memoryPct,
      },
    });

    if (response?.ok) {
      log('Saved to LeetFocus.');
      showToast(response.data.isNew ? `Saved “${meta.title}” to LeetFocus` : `Logged another solve of “${meta.title}”`);
    } else if (response === null) {
      showToast('LeetFocus was updated. Refresh this tab to keep tracking.');
    } else {
      log('Saving failed:', response.error);
    }
  }

  // Path 1: judge result relayed from intercept.js.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'leetfocus-intercept') return;
    const { submissionId, payload } = event.data;
    const slug = currentSlug();
    if (!slug) return;
    handleResult(String(submissionId), slug, {
      status: payload.status_msg,
      questionId: payload.question_id ?? null,
      lang: payload.pretty_lang ?? payload.lang ?? null,
      runtime: payload.status_runtime ?? null,
      runtimePct: percent(payload.runtime_percentile),
      memory: payload.status_memory ?? null,
      memoryPct: percent(payload.memory_percentile),
    }, 'check response');
  });

  // Path 2: the submission result page. The judge may still be running when it opens, so poll briefly.
  async function lookUpSubmissionPage() {
    const match = location.pathname.match(SUBMISSION_URL_RE);
    if (!match) return;
    const [, slug, submissionId] = match;
    if (seenSubmissions.has(submissionId) || lookedUpSubmissions.has(submissionId)) return;
    lookedUpSubmissions.add(submissionId);

    for (let poll = 0; poll < DETAILS_MAX_POLLS; poll += 1) {
      if (seenSubmissions.has(submissionId)) return; // path 1 got there first
      let details = null;
      try {
        details = (await graphql(SUBMISSION_QUERY, { submissionId: Number(submissionId) }))?.submissionDetails;
      } catch (error) {
        log('Could not look up submission', submissionId, error);
      }
      // Only act on final verdicts; anything unrecognized may mean "still judging", so keep polling.
      if (STATUS_NAMES[details?.statusCode]) {
        if (Date.now() - Number(details.timestamp) * 1000 > RECENT_SUBMISSION_MS) return; // an old submission
        handleResult(submissionId, details.question?.titleSlug ?? slug, {
          status: STATUS_NAMES[details.statusCode],
          questionId: details.question?.questionId ?? null,
          lang: details.lang?.verboseName ?? null,
          runtime: details.runtimeDisplay ?? null,
          runtimePct: percent(details.runtimePercentile),
          memory: details.memoryDisplay ?? null,
          memoryPct: percent(details.memoryPercentile),
        }, 'submission page');
        return;
      }
      await sleep(DETAILS_POLL_MS);
    }
    log('Submission', submissionId, 'had no result yet after polling; skipped.');
  }

  // LeetCode is a single-page app, so watch for client-side navigation between problems and result pages.
  function checkNavigation() {
    const slug = currentSlug();
    if (slug && slug !== lastSlug) send('problem:opened', { slug });
    lastSlug = slug;
    lookUpSubmissionPage();
  }
  checkNavigation();
  setInterval(checkNavigation, 1000);

  if (currentSlug()) log('Tracking submissions on this page.');

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
