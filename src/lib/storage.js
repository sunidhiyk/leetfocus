// Shared data model and helpers used by the service worker, popup, and dashboard.
//
// chrome.storage.local layout:
//   settings  -> DEFAULT_SETTINGS shape
//   timer     -> DEFAULT_TIMER shape
//   problems  -> { [slug]: Problem }
//   history   -> { [YYYY-MM-DD]: { focusMin, pomodoros, solvedSlugs[] } }
//   pending   -> { [slug]: { openedAt, failedAttempts } }  (problems currently being worked on)

export const DEFAULT_SETTINGS = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
  notifications: true,
  showFloatingTimer: true,
};

export const DEFAULT_TIMER = {
  phase: 'idle', // 'idle' | 'focus' | 'shortBreak' | 'longBreak'
  nextPhase: 'focus',
  endsAt: null, // set while running
  remainingMs: null, // set while paused
  durationMs: null,
  completedFocus: 0,
};

export const PHASES = { focus: 'Focus', shortBreak: 'Short break', longBreak: 'Long break' };

export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60];

export const DAY_MS = 24 * 60 * 60 * 1000;

export async function getState() {
  const data = await chrome.storage.local.get(['settings', 'timer', 'problems', 'history', 'pending']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...data.settings },
    timer: { ...DEFAULT_TIMER, ...data.timer },
    problems: data.problems ?? {},
    history: data.history ?? {},
    pending: data.pending ?? {},
  };
}

// Serializes read-modify-write cycles within one context so concurrent events don't clobber each other.
let lock = Promise.resolve();
export function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

export function phaseMinutes(settings, phase) {
  const minutes = { focus: settings.focusMin, shortBreak: settings.shortBreakMin, longBreak: settings.longBreakMin };
  return minutes[phase] ?? settings.focusMin;
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const emptyDay = () => ({ focusMin: 0, pomodoros: 0, solvedSlugs: [] });

export const solvedOn = (day) => day?.solvedSlugs?.length ?? 0;

export function computeStreaks(history) {
  const active = (key) => solvedOn(history[key]) > 0;

  // The current streak survives until the end of today, so start from yesterday if nothing is solved yet.
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  if (!active(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (active(dayKey(cursor.getTime()))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const key of Object.keys(history).filter(active).sort()) {
    const t = new Date(`${key}T12:00:00`).getTime();
    run = prev !== null && Math.round((t - prev) / DAY_MS) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  return { current, longest: Math.max(longest, current) };
}

export function scheduleReview(stage, now = Date.now()) {
  const clamped = Math.min(Math.max(stage, 0), REVIEW_INTERVALS_DAYS.length - 1);
  return { stage: clamped, dueAt: now + REVIEW_INTERVALS_DAYS[clamped] * DAY_MS };
}

export const isDue = (problem, now = Date.now()) => problem.review?.dueAt != null && problem.review.dueAt <= now;

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  const min = Math.round(ms / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function relativeTime(ts, now = Date.now()) {
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < DAY_MS) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / DAY_MS), 'day');
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const problemUrl = (slug) => `https://leetcode.com/problems/${encodeURIComponent(slug)}/`;
