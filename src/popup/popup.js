import {
  PHASES,
  computeStreaks,
  dayKey,
  escapeHtml,
  formatClock,
  getState,
  isDue,
  phaseMinutes,
  problemUrl,
  relativeTime,
  solvedOn,
} from '../lib/storage.js';

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

const $ = (id) => document.getElementById(id);
const els = {
  card: $('timer-card'),
  tabs: [...document.querySelectorAll('.phase-tabs button')],
  ring: $('ring-progress'),
  time: $('time'),
  phaseLabel: $('phase-label'),
  cycle: $('cycle'),
  primary: $('primary'),
  skip: $('skip'),
  reset: $('reset'),
  statSolved: $('stat-solved'),
  statPomodoros: $('stat-pomodoros'),
  statFocus: $('stat-focus'),
  statStreak: $('stat-streak'),
  reviewBanner: $('review-banner'),
  reviewCount: $('review-count'),
  recent: $('recent'),
  recentEmpty: $('recent-empty'),
};

let state = null;
let selectedPhase = null; // phase picked in the tabs while idle

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? 'No response from LeetFocus');
  return response.data;
}

async function refresh() {
  state = await getState();
  renderTimer();
  renderStats();
}

function renderTimer() {
  const { timer, settings } = state;
  const running = timer.phase !== 'idle' && timer.endsAt != null;
  const paused = timer.phase !== 'idle' && timer.remainingMs != null;
  const phase = timer.phase === 'idle' ? (selectedPhase ?? timer.nextPhase) : timer.phase;
  const total = timer.phase === 'idle' ? phaseMinutes(settings, phase) * 60000 : timer.durationMs;
  const left = running ? Math.max(0, timer.endsAt - Date.now()) : paused ? timer.remainingMs : total;
  const progress = total ? 1 - left / total : 0;

  els.time.textContent = formatClock(left);
  els.ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  // A zero-length dash with round caps would still draw a dot at 12 o'clock.
  els.ring.style.opacity = progress > 0.002 ? '1' : '0';
  els.card.dataset.phase = phase === 'focus' ? 'focus' : 'break';
  els.card.dataset.state = running ? 'running' : paused ? 'paused' : 'idle';
  els.phaseLabel.textContent = running ? PHASES[phase] : paused ? `Paused · ${PHASES[phase]}` : `Ready · ${PHASES[phase]}`;
  els.primary.textContent = running ? 'Pause' : paused ? 'Resume' : 'Start';
  els.skip.disabled = timer.phase === 'idle';
  els.reset.disabled = timer.phase === 'idle' && timer.completedFocus === 0;

  for (const tab of els.tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.phase === phase));
    tab.disabled = timer.phase !== 'idle';
  }

  const every = settings.longBreakEvery;
  let filled = timer.completedFocus % every;
  const onLongBreak = timer.phase === 'longBreak' || (timer.phase === 'idle' && timer.nextPhase === 'longBreak');
  if (filled === 0 && timer.completedFocus > 0 && onLongBreak) filled = every;
  if (els.cycle.childElementCount !== every || els.cycle.dataset.filled !== String(filled)) {
    els.cycle.replaceChildren(
      ...Array.from({ length: every }, (_, i) => {
        const dot = document.createElement('span');
        dot.className = i < filled ? 'dot filled' : 'dot';
        return dot;
      }),
    );
    els.cycle.dataset.filled = String(filled);
    els.cycle.setAttribute('aria-label', `${filled} of ${every} pomodoros until a long break`);
  }
}

function renderStats() {
  const { problems, history } = state;
  const today = history[dayKey()];
  els.statSolved.textContent = solvedOn(today);
  els.statPomodoros.textContent = today?.pomodoros ?? 0;
  els.statFocus.textContent = `${today?.focusMin ?? 0}m`;
  els.statStreak.textContent = computeStreaks(history).current;

  const list = Object.values(problems);
  const due = list.filter((p) => isDue(p)).length;
  els.reviewBanner.hidden = due === 0;
  els.reviewCount.textContent = `${due} problem${due === 1 ? '' : 's'} due for review`;

  const recent = list.sort((a, b) => b.lastSolvedAt - a.lastSolvedAt).slice(0, 4);
  els.recentEmpty.hidden = recent.length > 0;
  els.recent.innerHTML = recent
    .map(
      (p) => `
        <li>
          <a href="${problemUrl(p.slug)}" target="_blank" rel="noreferrer">
            <span class="diff-dot" data-difficulty="${escapeHtml(p.difficulty)}" title="${escapeHtml(p.difficulty ?? 'Unknown')}"></span>
            <span class="title">${p.id ? `${escapeHtml(p.id)}. ` : ''}${escapeHtml(p.title)}</span>
            <span class="when">${relativeTime(p.lastSolvedAt)}</span>
          </a>
        </li>`,
    )
    .join('');
}

function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/dashboard.html${hash}`) });
  window.close();
}

els.primary.addEventListener('click', async () => {
  const { timer } = state;
  if (timer.phase === 'idle') {
    await send('timer:start', { phase: selectedPhase ?? timer.nextPhase });
    selectedPhase = null;
  } else if (timer.endsAt != null) {
    await send('timer:pause');
  } else {
    await send('timer:resume');
  }
  await refresh();
});

els.skip.addEventListener('click', async () => {
  await send('timer:skip');
  await refresh();
});

els.reset.addEventListener('click', async () => {
  selectedPhase = null;
  await send('timer:reset');
  await refresh();
});

for (const tab of els.tabs) {
  tab.addEventListener('click', () => {
    selectedPhase = tab.dataset.phase;
    renderTimer();
  });
}

$('open-dashboard').addEventListener('click', () => openDashboard());
els.reviewBanner.addEventListener('click', () => openDashboard('#review'));

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') refresh();
});

await refresh();
setInterval(renderTimer, 250);
