import {
  DEFAULT_SETTINGS,
  DEFAULT_TIMER,
  PHASES,
  dailyGoal,
  dayKey,
  emptyDay,
  getState,
  goalProgress,
  phaseMinutes,
  scheduleReview,
  withLock,
} from './lib/storage.js';

const ALARM_END = 'phase-end';
const ALARM_TICK = 'badge-tick';
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SUBMISSIONS = 20;
const SLUG_RE = /^[a-z0-9-]+$/;
const BADGE_COLORS = { focus: '#E5533D', shortBreak: '#23964A', longBreak: '#23964A' };

const isRunning = (timer) => timer.phase !== 'idle' && timer.endsAt != null;
const isPaused = (timer) => timer.phase !== 'idle' && timer.remainingMs != null;

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(({ reason }) =>
  withLock(async () => {
    await reconcileTimer();
    if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
    }
  }),
);

chrome.runtime.onStartup.addListener(() => withLock(reconcileTimer));

chrome.alarms.onAlarm.addListener((alarm) =>
  withLock(async () => {
    const { timer } = await getState();
    if (alarm.name === ALARM_END) {
      if (isRunning(timer) && timer.endsAt <= Date.now() + 1000) await finishPhase(timer);
      else await syncAlarms(timer);
    } else if (alarm.name === ALARM_TICK) {
      await updateBadge(timer);
    }
  }),
);

// ---------- Pomodoro timer ----------

async function saveTimer(timer) {
  await chrome.storage.local.set({ timer });
  await syncAlarms(timer);
  return timer;
}

async function syncAlarms(timer) {
  await Promise.all([chrome.alarms.clear(ALARM_END), chrome.alarms.clear(ALARM_TICK)]);
  if (isRunning(timer)) {
    await chrome.alarms.create(ALARM_END, { when: timer.endsAt });
    await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  }
  await updateBadge(timer);
}

async function updateBadge(timer) {
  let text = '';
  if (isRunning(timer)) text = `${Math.max(1, Math.ceil((timer.endsAt - Date.now()) / 60000))}m`;
  else if (isPaused(timer)) text = '||';
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[timer.phase] });
}

// Handles phases that ended while the browser was closed or the worker was asleep.
async function reconcileTimer() {
  const { timer } = await getState();
  if (isRunning(timer) && timer.endsAt <= Date.now()) return finishPhase(timer);
  return syncAlarms(timer);
}

async function startPhase(phase) {
  if (!PHASES[phase]) throw new Error(`Unknown phase: ${phase}`);
  const { settings, timer } = await getState();
  const durationMs = phaseMinutes(settings, phase) * 60000;
  return saveTimer({ ...timer, phase, durationMs, endsAt: Date.now() + durationMs, remainingMs: null });
}

async function pauseTimer() {
  const { timer } = await getState();
  if (!isRunning(timer)) return timer;
  return saveTimer({ ...timer, remainingMs: Math.max(0, timer.endsAt - Date.now()), endsAt: null });
}

async function resumeTimer() {
  const { timer } = await getState();
  if (!isPaused(timer)) return timer;
  return saveTimer({ ...timer, endsAt: Date.now() + timer.remainingMs, remainingMs: null });
}

async function skipPhase() {
  const { timer } = await getState();
  return timer.phase === 'idle' ? timer : finishPhase(timer, { skipped: true });
}

async function finishPhase(timer, { skipped = false } = {}) {
  const { settings, history } = await getState();
  let { completedFocus } = timer;
  let nextPhase = 'focus';

  if (timer.phase === 'focus') {
    if (!skipped) {
      completedFocus += 1;
      const key = dayKey();
      const day = history[key] ?? emptyDay();
      day.focusMin += Math.round(timer.durationMs / 60000);
      day.pomodoros += 1;
      checkDailyGoal(day, settings);
      await chrome.storage.local.set({ history: { ...history, [key]: day } });
    }
    nextPhase = !skipped && completedFocus % settings.longBreakEvery === 0 ? 'longBreak' : 'shortBreak';
  }

  const autoStart = timer.phase === 'focus' ? settings.autoStartBreaks : settings.autoStartFocus;
  if (!skipped && settings.notifications) notifyPhaseEnd(timer.phase, nextPhase, completedFocus, autoStart);

  await saveTimer({ ...DEFAULT_TIMER, nextPhase, completedFocus });
  return autoStart ? startPhase(nextPhase) : (await getState()).timer;
}

function notifyPhaseEnd(ended, next, completedFocus, autoStarted) {
  const nextLabel = PHASES[next].toLowerCase();
  const title = ended === 'focus' ? `Pomodoro #${completedFocus} done 🍅` : 'Break is over';
  const message =
    ended === 'focus'
      ? autoStarted
        ? `Nice work. Your ${nextLabel} has started.`
        : `Nice work. Start a ${nextLabel} when you're ready.`
      : autoStarted
        ? 'Next focus session has started. Pick a problem!'
        : 'Ready for the next focus session?';
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    priority: 2,
  });
}

// ---------- daily goal ----------

// Mutates `day`: snapshots today's goal and stamps goalMetAt the first time it's reached.
function checkDailyGoal(day, settings, { notify = true } = {}) {
  day.goal ??= dailyGoal(settings);
  if (day.goalMetAt || !goalProgress(day, day.goal).met) return;
  day.goalMetAt = Date.now();
  if (!notify || !settings.notifications) return;

  const parts = [];
  if (day.goal.problems > 0) parts.push(`${day.goal.problems} problem${day.goal.problems === 1 ? '' : 's'}`);
  if (day.goal.pomodoros > 0) parts.push(`${day.goal.pomodoros} pomodoro${day.goal.pomodoros === 1 ? '' : 's'}`);
  chrome.notifications.create(`daily-goal-${dayKey()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Daily goal reached 🎯',
    message: `${parts.join(' and ')} done today. Great consistency!`,
    priority: 2,
  });
}

// ---------- LeetCode tracking ----------

async function problemOpened({ slug }) {
  if (!SLUG_RE.test(slug)) return null;
  const { pending } = await getState();
  const now = Date.now();
  for (const [key, entry] of Object.entries(pending)) {
    if (now - entry.openedAt > PENDING_TTL_MS) delete pending[key];
  }
  pending[slug] ??= { openedAt: now, failedAttempts: 0 };
  await chrome.storage.local.set({ pending });
  return pending[slug];
}

async function problemAttempt({ slug, status }) {
  if (!SLUG_RE.test(slug)) return null;
  const { pending } = await getState();
  const entry = pending[slug] ?? { openedAt: Date.now(), failedAttempts: 0 };
  entry.failedAttempts += 1;
  entry.lastStatus = String(status ?? '');
  pending[slug] = entry;
  await chrome.storage.local.set({ pending });
  return entry;
}

async function problemSolved({ meta, result }) {
  const slug = meta?.titleSlug;
  if (!SLUG_RE.test(slug ?? '')) throw new Error('Invalid problem slug');

  const { problems, pending, history, timer, settings } = await getState();
  const now = Date.now();
  const existing = problems[slug];
  const submissionId = String(result?.submissionId ?? now);
  if (existing?.submissions.some((s) => s.id === submissionId)) return { problem: existing, isNew: false };

  const work = pending[slug];
  const timeSpentMs = work && now - work.openedAt <= PENDING_TTL_MS ? now - work.openedAt : null;
  const submission = {
    id: submissionId,
    at: now,
    lang: result?.lang ?? null,
    runtime: result?.runtime ?? null,
    runtimePct: result?.runtimePct ?? null,
    memory: result?.memory ?? null,
    memoryPct: result?.memoryPct ?? null,
    failedAttempts: work?.failedAttempts ?? 0,
    timeSpentMs,
    duringFocus: timer.phase === 'focus' && timer.endsAt != null,
  };

  const problem = existing ?? {
    slug,
    firstSolvedAt: now,
    notes: '',
    review: scheduleReview(0, now),
    submissions: [],
  };
  problem.id = meta.questionFrontendId ?? problem.id ?? null;
  problem.title = meta.title ?? problem.title ?? slug;
  problem.difficulty = meta.difficulty ?? problem.difficulty ?? null;
  problem.tags = meta.tags?.length ? meta.tags : (problem.tags ?? []);
  problem.lastSolvedAt = now;
  problem.submissions = [...problem.submissions, submission].slice(-MAX_SUBMISSIONS);
  // Re-solving a problem that is due counts as a successful review.
  if (existing && existing.review?.dueAt <= now) problem.review = scheduleReview(existing.review.stage + 1, now);

  const key = dayKey(now);
  const day = history[key] ?? emptyDay();
  if (!day.solvedSlugs.includes(slug)) day.solvedSlugs.push(slug);
  checkDailyGoal(day, settings);

  delete pending[slug];
  await chrome.storage.local.set({
    problems: { ...problems, [slug]: problem },
    history: { ...history, [key]: day },
    pending,
  });
  return { problem, isNew: !existing };
}

async function mutateProblem(slug, mutate) {
  const { problems } = await getState();
  const problem = problems[slug];
  if (!problem) throw new Error('Problem not found');
  mutate(problem);
  await chrome.storage.local.set({ problems });
  return problem;
}

const reviewProblem = ({ slug, remembered }) =>
  mutateProblem(slug, (p) => {
    p.review = { ...scheduleReview(remembered ? (p.review?.stage ?? -1) + 1 : 0), lastReviewedAt: Date.now() };
  });

const updateNotes = ({ slug, notes }) =>
  mutateProblem(slug, (p) => {
    p.notes = String(notes ?? '').slice(0, 5000);
  });

async function deleteProblem({ slug }) {
  const { problems } = await getState();
  delete problems[slug];
  await chrome.storage.local.set({ problems });
  return null;
}

// ---------- settings & data ----------

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

async function updateSettings({ settings: partial }) {
  const { settings: current, history } = await getState();
  // Merge so a caller that omits a field (e.g. a dashboard tab from an older version) keeps its current value.
  const input = { ...current, ...partial };
  const settings = {
    focusMin: clampInt(input.focusMin, 1, 180, DEFAULT_SETTINGS.focusMin),
    shortBreakMin: clampInt(input.shortBreakMin, 1, 60, DEFAULT_SETTINGS.shortBreakMin),
    longBreakMin: clampInt(input.longBreakMin, 1, 90, DEFAULT_SETTINGS.longBreakMin),
    longBreakEvery: clampInt(input.longBreakEvery, 2, 12, DEFAULT_SETTINGS.longBreakEvery),
    autoStartBreaks: Boolean(input.autoStartBreaks),
    autoStartFocus: Boolean(input.autoStartFocus),
    notifications: Boolean(input.notifications),
    showFloatingTimer: Boolean(input.showFloatingTimer),
    goalProblems: clampInt(input.goalProblems, 0, 20, DEFAULT_SETTINGS.goalProblems),
    goalPomodoros: clampInt(input.goalPomodoros, 0, 16, DEFAULT_SETTINGS.goalPomodoros),
  };

  // Apply a changed goal to today unless today's goal was already reached; earlier days keep their snapshot.
  const key = dayKey();
  const today = history[key];
  if (today && !today.goalMetAt) {
    today.goal = dailyGoal(settings);
    checkDailyGoal(today, settings, { notify: false });
    await chrome.storage.local.set({ settings, history });
  } else {
    await chrome.storage.local.set({ settings });
  }
  return settings;
}

async function importData({ data }) {
  if (!data || typeof data.problems !== 'object' || data.problems === null) {
    throw new Error("That file doesn't look like a LeetFocus export.");
  }
  const state = await getState();

  const problems = { ...state.problems };
  let imported = 0;
  for (const [slug, incoming] of Object.entries(data.problems)) {
    if (!SLUG_RE.test(slug) || incoming?.slug !== slug || !Array.isArray(incoming.submissions)) continue;
    imported += 1;
    const current = problems[slug];
    if (!current) {
      problems[slug] = incoming;
      continue;
    }
    const byId = new Map([...current.submissions, ...incoming.submissions].map((s) => [String(s.id ?? s.at), s]));
    problems[slug] = {
      ...current,
      ...incoming,
      notes: current.notes || incoming.notes || '',
      firstSolvedAt: Math.min(current.firstSolvedAt, incoming.firstSolvedAt ?? Infinity),
      lastSolvedAt: Math.max(current.lastSolvedAt, incoming.lastSolvedAt ?? 0),
      submissions: [...byId.values()].sort((a, b) => a.at - b.at).slice(-MAX_SUBMISSIONS),
      review: (incoming.review?.dueAt ?? 0) > (current.review?.dueAt ?? 0) ? incoming.review : current.review,
    };
  }

  const history = { ...state.history };
  for (const [key, day] of Object.entries(data.history ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || typeof day !== 'object' || day === null) continue;
    const current = history[key] ?? emptyDay();
    history[key] = {
      focusMin: Math.max(current.focusMin, Number(day.focusMin) || 0),
      pomodoros: Math.max(current.pomodoros, Number(day.pomodoros) || 0),
      solvedSlugs: [...new Set([...current.solvedSlugs, ...(Array.isArray(day.solvedSlugs) ? day.solvedSlugs : [])])],
      ...((current.goal ?? day.goal) && { goal: current.goal ?? day.goal }),
      ...((current.goalMetAt ?? day.goalMetAt) && { goalMetAt: current.goalMetAt ?? day.goalMetAt }),
    };
  }

  await chrome.storage.local.set({ problems, history });
  return { imported };
}

async function clearProgress() {
  await chrome.storage.local.remove(['problems', 'history', 'pending']);
  return resetTimerState();
}

const resetTimerState = () => saveTimer({ ...DEFAULT_TIMER });

// ---------- messaging ----------

const HANDLERS = {
  'timer:start': async ({ phase }) => startPhase(phase ?? (await getState()).timer.nextPhase),
  'timer:pause': pauseTimer,
  'timer:resume': resumeTimer,
  'timer:skip': skipPhase,
  'timer:reset': resetTimerState,
  'problem:opened': problemOpened,
  'problem:attempt': problemAttempt,
  'problem:solved': problemSolved,
  'problem:review': reviewProblem,
  'problem:notes': updateNotes,
  'problem:delete': deleteProblem,
  'settings:update': updateSettings,
  'data:import': importData,
  'data:clear': clearProgress,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  withLock(() => handler(message))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
