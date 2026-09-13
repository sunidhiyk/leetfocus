// Floating Pomodoro timer on LeetCode problem pages.
// Rendered inside a closed Shadow DOM so LeetCode's styles can't leak in (and ours can't leak out).
// The service worker owns the timer; this widget only reads chrome.storage and sends commands.
(() => {
  if (window.top !== window || window.__leetfocusWidget) return;
  window.__leetfocusWidget = true;

  const PHASES = { focus: 'Focus', shortBreak: 'Short break', longBreak: 'Long break' };
  const DEFAULT_SETTINGS = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, showFloatingTimer: true };
  const DEFAULT_TIMER = { phase: 'idle', nextPhase: 'focus', endsAt: null, remainingMs: null, durationMs: null };
  const DEFAULT_PREFS = { x: 24, y: 24, minimized: false }; // distance from the right/bottom edges
  // Matches /problems/two-sum/... and contest pages like /contest/weekly-contest-400/problems/two-sum/.
  const PROBLEM_RE = /(?:^|\/)problems\/([a-z0-9-]+)/;
  const PENDING_TTL_MS = 6 * 60 * 60 * 1000;
  const EDGE = 8;
  const DRAG_THRESHOLD = 4;
  const MINI_CIRCUMFERENCE = 2 * Math.PI * 17;

  const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    skip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.2v11.6a1 1 0 0 0 1.55.83l8.2-5.8a1 1 0 0 0 0-1.66l-8.2-5.8A1 1 0 0 0 5 6.2z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="2.2" rx="1.1"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    .w {
      --focus: #e5533d; --break: #23964a; --accent: var(--focus);
      --bg: rgba(255, 255, 255, 0.94); --text: #1c1a18; --muted: #6d6760;
      --border: rgba(0, 0, 0, 0.09); --hover: rgba(0, 0, 0, 0.06);
      position: relative; overflow: hidden; box-sizing: border-box;
      font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--text); background: var(--bg);
      border: 1px solid var(--border); border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      user-select: none; -webkit-user-select: none; touch-action: none; cursor: grab;
    }
    .w[data-theme="dark"] {
      --focus: #ff6b52; --break: #45c06b;
      --bg: rgba(30, 30, 35, 0.94); --text: #eceae6; --muted: #9a969f;
      --border: rgba(255, 255, 255, 0.1); --hover: rgba(255, 255, 255, 0.08);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }
    .w[data-phase="break"] { --accent: var(--break); }
    .w.dragging { cursor: grabbing; }

    .full { display: flex; align-items: center; gap: 10px; padding: 8px 8px 10px 8px; }
    .grip { display: grid; grid-template-columns: repeat(2, 3px); gap: 3px; padding: 0 2px; opacity: 0.45; }
    .grip i { width: 3px; height: 3px; border-radius: 50%; background: var(--muted); }
    .readout { min-width: 96px; }
    .time {
      font: 600 21px/1.1 ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
      font-variant-numeric: tabular-nums; letter-spacing: -0.5px;
    }
    .w[data-state="paused"] .time { opacity: 0.5; }
    .sub { margin-top: 1px; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .phase { color: var(--accent); font-weight: 650; }

    .actions { display: flex; gap: 2px; }
    button { all: unset; box-sizing: border-box; cursor: pointer; }
    .icon {
      display: grid; place-items: center; width: 30px; height: 30px;
      border-radius: 8px; color: var(--muted);
      transition: background-color 0.15s, color 0.15s, filter 0.15s;
    }
    .icon:hover:not(:disabled) { background: var(--hover); color: var(--text); }
    .icon:disabled { opacity: 0.35; cursor: default; }
    .icon.primary { background: var(--accent); color: #fff; }
    .icon.primary:hover { background: var(--accent); color: #fff; filter: brightness(1.08); }
    .icon svg { width: 16px; height: 16px; fill: currentColor; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--hover); }
    .fill { display: block; width: 0; height: 100%; background: var(--accent); transition: width 0.5s linear; }

    .mini { display: none; }
    .w[data-minimized="true"] { border-radius: 50%; }
    .w[data-minimized="true"] .full,
    .w[data-minimized="true"] .bar { display: none; }
    .w[data-minimized="true"] .mini {
      position: relative; display: grid; place-items: center;
      width: 46px; height: 46px; border-radius: 50%; cursor: inherit;
    }
    .mini svg { position: absolute; inset: 4px; width: 38px; height: 38px; transform: rotate(-90deg); }
    .mini circle { fill: none; stroke-width: 3; }
    .mini .track { stroke: var(--hover); }
    .mini .prog { stroke: var(--accent); stroke-linecap: round; stroke-dasharray: ${MINI_CIRCUMFERENCE.toFixed(2)}; }
    .mini-label { font: 700 12px/1 system-ui, sans-serif; font-variant-numeric: tabular-nums; color: var(--text); }
    .w[data-state="paused"] .mini-label { color: var(--muted); }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
      100% { box-shadow: 0 0 0 16px transparent; }
    }
    .w.pulse { animation: pulse 1.1s ease-out 3; }

    @media (prefers-reduced-motion: reduce) {
      .w.pulse { animation: none; }
      .fill, .icon { transition: none; }
    }
  `;

  const MARKUP = `
    <div class="w" data-phase="focus" data-state="idle" data-minimized="false" role="region" aria-label="LeetFocus Pomodoro timer">
      <button class="mini" type="button" data-mini title="LeetFocus: click to expand, drag to move">
        <svg viewBox="0 0 38 38" aria-hidden="true">
          <circle class="track" cx="19" cy="19" r="17" />
          <circle class="prog" cx="19" cy="19" r="17" />
        </svg>
        <span class="mini-label">25</span>
      </button>
      <div class="full">
        <span class="grip" title="Drag to move" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
        <div class="readout">
          <div class="time" role="timer">25:00</div>
          <div class="sub"><span class="phase">Focus</span><span class="spent"></span></div>
        </div>
        <div class="actions">
          <button class="icon primary" type="button" data-act="primary">${ICONS.play}</button>
          <button class="icon" type="button" data-act="skip" title="Skip to next phase" aria-label="Skip to next phase">${ICONS.skip}</button>
          <button class="icon" type="button" data-act="minimize" title="Minimize" aria-label="Minimize timer">${ICONS.minimize}</button>
        </div>
      </div>
      <div class="bar" aria-hidden="true"><span class="fill"></span></div>
    </div>`;

  let timer = DEFAULT_TIMER;
  let settings = DEFAULT_SETTINGS;
  let pending = {};
  let prefs = DEFAULT_PREFS;
  let host = null;
  let els = null;
  let tickId = null;
  let drag = null;
  let lastPrimaryIcon = null;

  const alive = () => Boolean(chrome.runtime?.id);
  const onProblemPage = () => PROBLEM_RE.test(location.pathname);
  const shouldShow = () => settings.showFloatingTimer !== false && onProblemPage();

  const clock = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  const shortDuration = (ms) => {
    const min = Math.floor(ms / 60000);
    if (min < 1) return '<1m';
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
  };
  const phaseMinutes = (phase) =>
    ({ focus: settings.focusMin, shortBreak: settings.shortBreakMin, longBreak: settings.longBreakMin })[phase] ?? settings.focusMin;

  async function send(type, payload = {}) {
    if (!alive()) return teardown();
    try {
      await chrome.runtime.sendMessage({ type, ...payload });
    } catch {
      teardown();
    }
  }

  // ---------- mount / unmount ----------

  function mount() {
    if (!document.documentElement) return;
    if (host) {
      // The page's own scripts can wipe nodes they didn't create (e.g. when React re-renders); put it back.
      if (!host.isConnected) document.documentElement.appendChild(host);
      return;
    }
    host = document.createElement('div');
    host.setAttribute('data-leetfocus', 'widget');
    Object.assign(host.style, { position: 'fixed', zIndex: '2147483646', right: '24px', bottom: '24px' });
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>${MARKUP}`;
    els = {
      w: root.querySelector('.w'),
      mini: root.querySelector('[data-mini]'),
      miniProg: root.querySelector('.mini .prog'),
      miniLabel: root.querySelector('.mini-label'),
      time: root.querySelector('.time'),
      phase: root.querySelector('.phase'),
      spent: root.querySelector('.spent'),
      primary: root.querySelector('[data-act="primary"]'),
      skip: root.querySelector('[data-act="skip"]'),
      fill: root.querySelector('.fill'),
    };
    wireEvents();
    document.documentElement.appendChild(host);
    applyTheme();
    applyPrefs();
    render();
    tickId = setInterval(() => document.visibilityState === 'visible' && render(), 500);
    console.info('[LeetFocus] floating timer active');
  }

  function unmount() {
    clearInterval(tickId);
    host?.remove();
    host = null;
    els = null;
    lastPrimaryIcon = null;
  }

  function teardown() {
    unmount();
    clearInterval(navId);
    themeObserver.disconnect();
    window.removeEventListener('resize', onResize);
  }

  function sync() {
    if (!alive()) return teardown();
    if (shouldShow()) mount();
    else unmount();
  }

  // ---------- rendering ----------

  function render() {
    if (!els) return;
    const running = timer.phase !== 'idle' && timer.endsAt != null;
    const paused = timer.phase !== 'idle' && timer.remainingMs != null;
    const phase = timer.phase === 'idle' ? timer.nextPhase : timer.phase;
    const total = timer.phase === 'idle' ? phaseMinutes(phase) * 60000 : timer.durationMs;
    const left = running ? Math.max(0, timer.endsAt - Date.now()) : paused ? timer.remainingMs : total;
    const progress = total ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
    const label = PHASES[phase] ?? PHASES.focus;

    els.w.dataset.phase = phase === 'focus' ? 'focus' : 'break';
    els.w.dataset.state = running ? 'running' : paused ? 'paused' : 'idle';
    els.time.textContent = clock(left);
    els.phase.textContent = running ? label : paused ? `Paused · ${label}` : `Ready · ${label}`;
    els.fill.style.width = `${(progress * 100).toFixed(2)}%`;
    els.miniLabel.textContent = String(Math.ceil(left / 60000));
    els.miniProg.style.strokeDashoffset = String(MINI_CIRCUMFERENCE * (1 - progress));
    els.miniProg.style.opacity = progress > 0.002 ? '1' : '0';
    els.mini.setAttribute('aria-label', `LeetFocus ${label}: ${clock(left)} left. Expand timer`);

    const icon = running ? 'pause' : 'play';
    if (icon !== lastPrimaryIcon) {
      els.primary.innerHTML = ICONS[icon];
      lastPrimaryIcon = icon;
    }
    const action = running ? 'Pause' : paused ? 'Resume' : `Start ${label.toLowerCase()}`;
    els.primary.title = action;
    els.primary.setAttribute('aria-label', action);
    els.skip.disabled = timer.phase === 'idle';

    const slug = location.pathname.match(PROBLEM_RE)?.[1];
    const work = slug && pending[slug];
    const spent = work ? Date.now() - work.openedAt : null;
    els.spent.textContent = spent != null && spent < PENDING_TTL_MS ? ` · ${shortDuration(spent)} on this problem` : '';
  }

  function applyTheme() {
    if (!els) return;
    els.w.dataset.theme = pageIsDark() ? 'dark' : 'light';
  }

  // LeetCode marks its theme with a class on <html>; otherwise judge by the page's actual background.
  function pageIsDark() {
    const html = document.documentElement;
    if (html.classList.contains('dark') || html.dataset.theme === 'dark') return true;
    if (html.classList.contains('light') || html.dataset.theme === 'light') return false;
    for (const el of [document.body, html]) {
      const rgb = el && getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (rgb && (rgb[3] ?? 1) > 0) return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128;
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyPrefs() {
    if (!els) return;
    els.w.dataset.minimized = String(Boolean(prefs.minimized));
    place(prefs.x, prefs.y);
  }

  // Positions by distance from the bottom-right corner so the widget stays anchored when the window resizes.
  function place(x, y) {
    if (!host) return { x, y };
    const { width, height } = host.getBoundingClientRect();
    const cx = Math.min(Math.max(EDGE, x), Math.max(EDGE, window.innerWidth - width - EDGE));
    const cy = Math.min(Math.max(EDGE, y), Math.max(EDGE, window.innerHeight - height - EDGE));
    host.style.right = `${cx}px`;
    host.style.bottom = `${cy}px`;
    return { x: cx, y: cy };
  }

  const savePrefs = (patch) => {
    prefs = { ...prefs, ...patch };
    if (alive()) chrome.storage.local.set({ widget: prefs }).catch(() => {});
  };

  function pulse() {
    if (!els) return;
    els.w.classList.remove('pulse');
    void els.w.offsetWidth; // restart the animation
    els.w.classList.add('pulse');
  }

  // ---------- interaction ----------

  function wireEvents() {
    els.w.addEventListener('click', (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const act = button.dataset.act;
      if (act === 'minimize') {
        savePrefs({ minimized: true });
        applyPrefs();
      } else if (act === 'skip') {
        send('timer:skip');
      } else if (act === 'primary') {
        if (timer.phase === 'idle') send('timer:start', { phase: timer.nextPhase });
        else if (timer.endsAt != null) send('timer:pause');
        else send('timer:resume');
      }
    });

    const expand = () => {
      savePrefs({ minimized: false });
      applyPrefs();
    };

    // Pointer clicks on the mini ring are handled in endDrag (pointer capture retargets the click);
    // this listener covers keyboard activation, which reports detail === 0.
    els.mini.addEventListener('click', (event) => {
      if (event.detail === 0) expand();
    });

    els.w.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-act]')) return;
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: prefs.x,
        y: prefs.y,
        moved: false,
        onMini: Boolean(event.target.closest('[data-mini]')),
      };
      els.w.setPointerCapture(event.pointerId);
    });

    els.w.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      els.w.classList.add('dragging');
      const pos = place(drag.x - dx, drag.y - dy);
      drag.last = pos;
    });

    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      els.w.classList.remove('dragging');
      if (drag.moved && drag.last) savePrefs(drag.last);
      else if (event.type === 'pointerup' && drag.onMini) expand();
      drag = null;
    };
    els.w.addEventListener('pointerup', endDrag);
    els.w.addEventListener('pointercancel', endDrag);
  }

  const onResize = () => place(prefs.x, prefs.y);
  window.addEventListener('resize', onResize);

  const themeObserver = new MutationObserver(applyTheme);
  const observeTheme = () =>
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

  // LeetCode is a single-page app: show/hide as the user navigates between problems and other pages.
  const navId = setInterval(sync, 1000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !alive()) return;
    if (changes.timer) {
      const previous = changes.timer.oldValue;
      timer = { ...DEFAULT_TIMER, ...changes.timer.newValue };
      // Pulse only when a phase ran out on its own, not when the user skipped or reset it.
      const finished = previous?.endsAt != null && previous.endsAt <= Date.now() + 1500;
      if (finished && previous.phase !== timer.phase) pulse();
    }
    if (changes.settings) settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    if (changes.pending) pending = changes.pending.newValue ?? {};
    if (changes.widget) {
      prefs = { ...DEFAULT_PREFS, ...changes.widget.newValue };
      applyPrefs();
    }
    sync();
    render();
  });

  chrome.storage.local.get(['timer', 'settings', 'pending', 'widget']).then((data) => {
    timer = { ...DEFAULT_TIMER, ...data.timer };
    settings = { ...DEFAULT_SETTINGS, ...data.settings };
    pending = data.pending ?? {};
    prefs = { ...DEFAULT_PREFS, ...data.widget };
    observeTheme();
    sync();
  });
})();
