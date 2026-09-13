import {
  DAY_MS,
  REVIEW_INTERVALS_DAYS,
  computeGoalStreaks,
  computeStreaks,
  dayKey,
  escapeHtml,
  formatDuration,
  getState,
  goalForDay,
  goalProgress,
  goalRemainingText,
  goalRowsHtml,
  isDue,
  problemUrl,
  relativeTime,
  solvedOn,
  todayGoalProgress,
} from '../lib/storage.js';

const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
const DIFFICULTY_RANK = { Easy: 0, Medium: 1, Hard: 2 };
const HEATMAP_WEEKS = 26;

const $ = (selector) => document.querySelector(selector);
const e = escapeHtml;

let state = null;
const expanded = new Set();
const noteTimers = new Map();

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? 'No response from LeetFocus');
  return response.data;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

const isEditingNotes = () => document.activeElement?.matches?.('textarea[data-notes]') ?? false;

async function refresh() {
  state = await getState();
  const problems = Object.values(state.problems);
  renderOverview(problems);
  renderGoal();
  renderHeatmap();
  renderTopics(problems);
  renderReview(problems);
  renderTagOptions(problems);
  // Don't rebuild the table under someone's cursor while they type notes.
  if (!isEditingNotes()) renderProblems();
}

// ---------- overview ----------

function renderOverview(problems) {
  const { history } = state;
  const total = problems.length;
  const weekAgo = Date.now() - 7 * DAY_MS;
  const newThisWeek = problems.filter((p) => p.firstSolvedAt >= weekAgo).length;
  const { current, longest } = computeStreaks(history);
  const days = Object.values(history);
  const pomodoros = days.reduce((sum, d) => sum + (d.pomodoros ?? 0), 0);
  const focusMin = days.reduce((sum, d) => sum + (d.focusMin ?? 0), 0);
  const due = problems.filter((p) => isDue(p)).length;

  $('#onboarding').hidden = total > 0;
  $('#stat-total').textContent = total;
  $('#stat-total-sub').textContent = `+${newThisWeek} new this week`;
  $('#stat-streak').textContent = `${current} day${current === 1 ? '' : 's'}`;
  $('#stat-streak-sub').textContent = `Longest: ${longest} day${longest === 1 ? '' : 's'}`;
  $('#stat-pomodoros').textContent = pomodoros;
  $('#stat-pomodoros-sub').textContent = `${formatDuration(focusMin * 60000).replace('—', '0m')} focused`;
  $('#stat-due').textContent = due;
  $('#stat-due-sub').textContent = due ? 'Clear the queue below' : 'All caught up';

  const counts = Object.fromEntries(DIFFICULTIES.map((d) => [d, 0]));
  for (const p of problems) if (p.difficulty in counts) counts[p.difficulty] += 1;
  $('#difficulty').innerHTML = DIFFICULTIES.map((d) => {
    const pct = total ? (counts[d] / total) * 100 : 0;
    return `
      <div class="diff-row">
        <span class="diff" data-difficulty="${d}">${d}</span>
        <span class="meter diff" data-difficulty="${d}"><span style="width:${pct.toFixed(1)}%"></span></span>
        <span class="value">${counts[d]}</span>
      </div>`;
  }).join('');
}

const goalMetOn = (day) => day != null && goalProgress(day, goalForDay(day, state.settings)).met;

function renderGoal() {
  const { history, settings } = state;
  const today = history[dayKey()];
  const progress = todayGoalProgress(today, settings);
  const panel = $('#goal-panel');
  panel.dataset.met = String(progress.met);

  if (!progress.enabled) {
    $('#goal-status').textContent = 'No daily goal';
    $('#goal-today').innerHTML = '';
    $('#goal-summary').textContent = 'Set a target for problems or pomodoros in Settings to build a daily habit.';
    return;
  }

  $('#goal-status').textContent = goalRemainingText(progress);
  $('#goal-today').innerHTML = goalRowsHtml(progress);

  const { current, longest } = computeGoalStreaks(history, settings);
  const cursor = new Date();
  let metLast30 = 0;
  for (let i = 0; i < 30; i += 1) {
    if (goalMetOn(history[dayKey(cursor.getTime())])) metLast30 += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  $('#goal-summary').textContent = `Goal streak: ${days(current)} (best ${longest}) · Met on ${days(metLast30)} of the last 30`;
}

function renderHeatmap() {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (HEATMAP_WEEKS - 1) * 7 - today.getDay());

  const todayKey = dayKey(today.getTime());
  const cells = [];
  let activeDays = 0;
  let totalSolves = 0;
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d.getTime());
    const day = state.history[key];
    const solved = solvedOn(day);
    const pomodoros = day?.pomodoros ?? 0;
    if (solved) {
      activeDays += 1;
      totalSolves += solved;
    }
    const level = solved === 0 ? 0 : solved === 1 ? 1 : solved === 2 ? 2 : solved <= 4 ? 3 : 4;
    const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const metGoal = goalMetOn(day);
    const label = `${date}: ${solved} solved, ${pomodoros} pomodoro${pomodoros === 1 ? '' : 's'}${metGoal ? ' · daily goal met' : ''}`;
    cells.push(`<span class="cell l${level}${metGoal ? ' goal' : ''}${key === todayKey ? ' today' : ''}" title="${label}"></span>`);
  }
  $('#heatmap').innerHTML = cells.join('');
  $('#activity-summary').textContent = `${totalSolves} solve${totalSolves === 1 ? '' : 's'} across ${activeDays} active day${activeDays === 1 ? '' : 's'} in the last 6 months`;
}

function renderTopics(problems) {
  const counts = new Map();
  for (const p of problems) for (const tag of p.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  const max = top[0]?.[1] ?? 1;
  $('#topics').innerHTML = top.length
    ? top
        .map(
          ([name, n]) => `
            <li>
              <span class="bar-label" title="${e(name)}">${e(name)}</span>
              <span class="meter"><span style="width:${((n / max) * 100).toFixed(1)}%"></span></span>
              <span class="bar-value tabular">${n}</span>
            </li>`,
        )
        .join('')
    : '<li class="empty">Your most-practised topics will appear here.</li>';
}

// ---------- review ----------

function renderReview(problems) {
  const now = Date.now();
  const due = problems.filter((p) => isDue(p, now)).sort((a, b) => a.review.dueAt - b.review.dueAt);
  const upcoming = problems.filter((p) => !isDue(p, now) && p.review?.dueAt < now + 7 * DAY_MS).length;

  $('#review-summary').textContent = due.length
    ? `${due.length} due now · ${upcoming} more this week`
    : `${upcoming} coming up this week`;

  $('#review-list').innerHTML = due
    .map(
      (p) => `
        <li>
          <span class="diff-dot" data-difficulty="${e(p.difficulty)}" title="${e(p.difficulty ?? 'Unknown')}"></span>
          <div class="review-main">
            <a href="${problemUrl(p.slug)}" target="_blank" rel="noreferrer">${p.id ? `${e(p.id)}. ` : ''}${e(p.title)}</a>
            <div class="meta">Due ${relativeTime(p.review.dueAt, now)} · Review ${p.review.stage + 1} of ${REVIEW_INTERVALS_DAYS.length}${p.notes ? ' · has notes' : ''}</div>
          </div>
          <div class="review-actions">
            <button class="btn btn-sm" type="button" data-review="forgot" data-slug="${e(p.slug)}">Needs work</button>
            <button class="btn btn-sm btn-primary" type="button" data-review="remembered" data-slug="${e(p.slug)}">Got it</button>
          </div>
        </li>`,
    )
    .join('');

  const empty = $('#review-empty');
  empty.hidden = due.length > 0;
  empty.textContent = problems.length
    ? `You're all caught up. Solved problems come back after ${REVIEW_INTERVALS_DAYS.join(', ')} days. Re-solving one on LeetCode counts as a review.`
    : 'Solve a problem on LeetCode and it will be scheduled for review tomorrow.';
}

$('#review-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-review]');
  if (!button) return;
  const remembered = button.dataset.review === 'remembered';
  const problem = await send('problem:review', { slug: button.dataset.slug, remembered });
  toast(remembered ? `Next review ${relativeTime(problem.review.dueAt)}` : 'Scheduled again for tomorrow');
});

// ---------- problems table ----------

function renderTagOptions(problems) {
  const select = $('#filter-tag');
  const current = select.value;
  const tags = [...new Set(problems.flatMap((p) => p.tags ?? []))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">All topics</option>${tags.map((t) => `<option>${e(t)}</option>`).join('')}`;
  select.value = tags.includes(current) ? current : '';
}

const lastSubmission = (p) => p.submissions.at(-1) ?? {};

const SORTERS = {
  recent: (a, b) => b.lastSolvedAt - a.lastSolvedAt,
  number: (a, b) => (Number(a.id) || 1e9) - (Number(b.id) || 1e9),
  difficulty: (a, b) => (DIFFICULTY_RANK[b.difficulty] ?? -1) - (DIFFICULTY_RANK[a.difficulty] ?? -1) || SORTERS.recent(a, b),
  solves: (a, b) => b.submissions.length - a.submissions.length || SORTERS.recent(a, b),
  time: (a, b) => (lastSubmission(b).timeSpentMs ?? -1) - (lastSubmission(a).timeSpentMs ?? -1),
};

function renderProblems() {
  const all = Object.values(state.problems);
  const q = $('#filter-q').value.trim().toLowerCase();
  const difficulty = $('#filter-difficulty').value;
  const tag = $('#filter-tag').value;

  const rows = all
    .filter((p) => !difficulty || p.difficulty === difficulty)
    .filter((p) => !tag || p.tags?.includes(tag))
    .filter((p) => !q || `${p.id ?? ''} ${p.title} ${(p.tags ?? []).join(' ')} ${p.notes ?? ''}`.toLowerCase().includes(q))
    .sort(SORTERS[$('#filter-sort').value] ?? SORTERS.recent);

  $('#problems-count').textContent = all.length ? `${rows.length} of ${all.length}` : '';
  $('#problems-body').innerHTML = rows.length
    ? rows.map(problemRow).join('')
    : `<tr><td class="table-empty" colspan="8">${all.length ? 'No problems match these filters.' : 'No problems yet. Accepted submissions on leetcode.com are saved here automatically.'}</td></tr>`;
}

function problemRow(p) {
  const last = lastSubmission(p);
  const open = expanded.has(p.slug);
  const tags = p.tags ?? [];
  const beats = (pct) => (pct != null ? ` · beats ${Math.round(pct)}%` : '');
  const slug = e(p.slug);
  return `
    <tr data-slug="${slug}">
      <td class="num tabular">${e(p.id ?? '—')}</td>
      <td>
        <a class="problem-link" href="${problemUrl(p.slug)}" target="_blank" rel="noreferrer">${e(p.title)}</a>
        ${p.notes ? '<span class="note-flag" title="Has notes">✎</span>' : ''}
      </td>
      <td><span class="diff" data-difficulty="${e(p.difficulty)}">${e(p.difficulty ?? '—')}</span></td>
      <td><div class="tags">${tags.slice(0, 3).map((t) => `<span class="tag">${e(t)}</span>`).join('')}${tags.length > 3 ? `<span class="tag" title="${e(tags.slice(3).join(', '))}">+${tags.length - 3}</span>` : ''}</div></td>
      <td class="tabular">${p.submissions.length}</td>
      <td class="muted" title="${e(new Date(p.lastSolvedAt).toLocaleString())}">${relativeTime(p.lastSolvedAt)}</td>
      <td class="tabular">${formatDuration(last.timeSpentMs)}</td>
      <td class="actions">
        <button class="btn btn-sm" type="button" data-action="toggle" aria-expanded="${open}">${open ? 'Close' : 'Details'}</button>
      </td>
    </tr>
    <tr class="detail-row" ${open ? '' : 'hidden'}>
      <td colspan="8">
        <div class="detail">
          <div class="detail-meta">
            <div><span>Language</span><strong>${e(last.lang ?? '—')}</strong></div>
            <div><span>Runtime</span><strong>${e(last.runtime ?? '—')}${beats(last.runtimePct)}</strong></div>
            <div><span>Memory</span><strong>${e(last.memory ?? '—')}${beats(last.memoryPct)}</strong></div>
            <div><span>Failed attempts first</span><strong>${last.failedAttempts ?? 0}</strong></div>
            <div><span>First solved</span><strong>${e(new Date(p.firstSolvedAt).toLocaleDateString())}</strong></div>
            <div><span>Next review</span><strong>${p.review ? relativeTime(p.review.dueAt) : '—'}</strong></div>
          </div>
          <label class="notes-label">
            Notes
            <textarea data-notes data-slug="${slug}" rows="4" placeholder="Approach, edge cases, complexity… e.g. Two pointers from both ends, skip duplicates. O(n) time, O(1) space.">${e(p.notes ?? '')}</textarea>
          </label>
          <div class="detail-actions">
            <span class="muted" data-save-state="${slug}">Notes save automatically</span>
            <button class="btn btn-sm btn-danger" type="button" data-action="delete" data-slug="${slug}">Remove from log</button>
          </div>
        </div>
      </td>
    </tr>`;
}

$('#problems-body').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const slug = button.closest('[data-slug]')?.dataset.slug ?? button.dataset.slug;

  if (button.dataset.action === 'toggle') {
    if (expanded.has(slug)) expanded.delete(slug);
    else expanded.add(slug);
    renderProblems();
  } else if (button.dataset.action === 'delete') {
    const title = state.problems[slug]?.title ?? slug;
    if (!confirm(`Remove “${title}” and its history from LeetFocus?`)) return;
    expanded.delete(slug);
    await send('problem:delete', { slug });
    toast('Problem removed');
  }
});

$('#problems-body').addEventListener('input', (event) => {
  const textarea = event.target.closest('textarea[data-notes]');
  if (!textarea) return;
  const { slug } = textarea.dataset;
  const status = document.querySelector(`[data-save-state="${CSS.escape(slug)}"]`);
  if (status) status.textContent = 'Saving…';
  clearTimeout(noteTimers.get(slug));
  noteTimers.set(
    slug,
    setTimeout(async () => {
      await send('problem:notes', { slug, notes: textarea.value });
      if (status) status.textContent = 'Saved';
    }, 500),
  );
});

for (const id of ['#filter-q', '#filter-difficulty', '#filter-tag', '#filter-sort']) {
  $(id).addEventListener(id === '#filter-q' ? 'input' : 'change', renderProblems);
}

// ---------- settings ----------

const settingsForm = $('#settings-form');

function renderSettings() {
  for (const [key, value] of Object.entries(state.settings)) {
    const input = settingsForm.elements.namedItem(key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
}

settingsForm.addEventListener('change', async () => {
  const f = settingsForm.elements;
  state.settings = await send('settings:update', {
    settings: {
      focusMin: f.focusMin.value,
      shortBreakMin: f.shortBreakMin.value,
      longBreakMin: f.longBreakMin.value,
      longBreakEvery: f.longBreakEvery.value,
      autoStartBreaks: f.autoStartBreaks.checked,
      autoStartFocus: f.autoStartFocus.checked,
      notifications: f.notifications.checked,
      showFloatingTimer: f.showFloatingTimer.checked,
      goalProblems: f.goalProblems.value,
      goalPomodoros: f.goalPomodoros.value,
    },
  });
  renderSettings();
  toast('Settings saved');
});
settingsForm.addEventListener('submit', (event) => event.preventDefault());

// ---------- data ----------

function download(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#export-json').addEventListener('click', () => {
  const { problems, history, settings } = state;
  const payload = { app: 'leetfocus', version: 1, exportedAt: new Date().toISOString(), problems, history, settings };
  download(`leetfocus-backup-${dayKey()}.json`, JSON.stringify(payload, null, 2), 'application/json');
});

$('#export-csv').addEventListener('click', () => {
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ['number', 'title', 'difficulty', 'topics', 'solves', 'first_solved', 'last_solved', 'last_time_spent_min', 'next_review', 'notes', 'url'];
  const lines = Object.values(state.problems)
    .sort(SORTERS.number)
    .map((p) => {
      const spent = lastSubmission(p).timeSpentMs;
      return [
        p.id,
        p.title,
        p.difficulty,
        (p.tags ?? []).join('; '),
        p.submissions.length,
        new Date(p.firstSolvedAt).toISOString(),
        new Date(p.lastSolvedAt).toISOString(),
        spent == null ? '' : Math.round(spent / 60000),
        p.review ? new Date(p.review.dueAt).toISOString() : '',
        p.notes,
        problemUrl(p.slug),
      ]
        .map(cell)
        .join(',');
    });
  download(`leetfocus-problems-${dayKey()}.csv`, [header.join(','), ...lines].join('\n'), 'text/csv');
});

$('#import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const { imported } = await send('data:import', { data });
    toast(`Imported ${imported} problem${imported === 1 ? '' : 's'}`);
  } catch (error) {
    toast(error instanceof SyntaxError ? "That file isn't valid JSON." : error.message);
  }
});

$('#clear-data').addEventListener('click', async () => {
  if (!confirm('Delete all solved problems, notes, review schedule and pomodoro history? Export a backup first if you might want it back.')) return;
  expanded.clear();
  await send('data:clear');
  toast('All progress deleted');
});

// ---------- init ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((key) => ['problems', 'history', 'settings'].includes(key))) refresh();
});

await refresh();
renderSettings();
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
