// Shared data model and helpers used by the service worker, popup, and dashboard.
//
// chrome.storage.local layout:
//   settings  -> DEFAULT_SETTINGS shape
//   timer     -> DEFAULT_TIMER shape
//   problems  -> { [slug]: Problem }
//   history   -> { [YYYY-MM-DD]: { focusMin, pomodoros, solvedSlugs[], goal?, goalMetAt? } }
//                (goal is a snapshot of that day's daily goal, so changing it later doesn't rewrite the past)
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
  goalProblems: 3, // 0 turns this part of the daily goal off
  goalPomodoros: 4,
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

export function computeStreaks(history, isActive = (day) => solvedOn(day) > 0) {
  const active = (key) => isActive(history[key]);

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

// ---------- daily goal ----------

export const dailyGoal = (settings) => ({ problems: settings.goalProblems, pomodoros: settings.goalPomodoros });

export const goalEnabled = (goal) => goal.problems > 0 || goal.pomodoros > 0;

// Days recorded before the goal feature have no snapshot, so fall back to the current goal.
export const goalForDay = (day, settings) => day?.goal ?? dailyGoal(settings);

export function goalProgress(day, goal) {
  const solved = solvedOn(day);
  const pomodoros = day?.pomodoros ?? 0;
  const parts = [];
  if (goal.problems > 0) parts.push({ key: 'problems', label: 'Problems', done: solved, target: goal.problems });
  if (goal.pomodoros > 0) parts.push({ key: 'pomodoros', label: 'Pomodoros', done: pomodoros, target: goal.pomodoros });
  const met = parts.length > 0 && parts.every((p) => p.done >= p.target);
  return { parts, met, enabled: parts.length > 0 };
}

// Today's card: turning the goal off hides it immediately, even if today already has a snapshot.
export function todayGoalProgress(day, settings) {
  const current = dailyGoal(settings);
  return goalProgress(day, goalEnabled(current) ? goalForDay(day, settings) : current);
}

export const computeGoalStreaks = (history, settings) =>
  computeStreaks(history, (day) => day != null && goalProgress(day, goalForDay(day, settings)).met);

export function goalRemainingText(progress) {
  if (!progress.enabled) return '';
  if (progress.met) return 'Goal complete 🎉';
  const left = progress.parts
    .filter((p) => p.done < p.target)
    .map((p) => {
      const n = p.target - p.done;
      return `${n} ${p.key === 'problems' ? `problem${n === 1 ? '' : 's'}` : `pomodoro${n === 1 ? '' : 's'}`}`;
    });
  return `${left.join(' + ')} to go`;
}

export function goalRowsHtml(progress) {
  return progress.parts
    .map((p) => {
      const done = p.done >= p.target;
      const pct = Math.min(100, (p.done / p.target) * 100);
      return `
        <div class="goal-row" data-done="${done}">
          <span class="goal-label">${p.label}</span>
          <span class="meter" role="progressbar" aria-label="${p.label}" aria-valuemin="0" aria-valuemax="${p.target}" aria-valuenow="${Math.min(p.done, p.target)}"><span style="width:${pct.toFixed(1)}%"></span></span>
          <span class="goal-count tabular">${done ? '✓ ' : ''}${p.done}/${p.target}</span>
        </div>`;
    })
    .join('');
}

// ---------- reviews ----------

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
