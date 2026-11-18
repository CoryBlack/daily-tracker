// ---------- Storage keys ----------
const LS_DATA = 'daily-data-v1';
const LS_SHA = 'daily-data-sha';
const LS_SETTINGS = 'daily-settings-v1';
const LS_LAST_SYNC = 'daily-last-sync';
const LS_DIRTY = 'daily-unsynced'; // set while this device has edits GitHub hasn't received

// ?today=YYYY-MM-DD simulates another date, for testing date boundaries and week rollover.
const DEBUG_TODAY = (() => {
  const p = new URLSearchParams(location.search).get('today');
  return isDateKey(p) ? p : null;
})();

// ---------- State ----------
let data = loadLocalData();
let settings = loadSettings();
let view = 'tasks';
let tasksTab = 'open';
let reorder = { routines: false };
let currentDay = today();
let toastTimer = null;
let editRev = 0; // bumped on every local edit; tells a finishing sync whether edits arrived mid-flight

function today() { return DEBUG_TODAY || dateKey(new Date()); }

const syncer = createSync({
  settings: () => settings,
  getData: () => ({ ...data }),
  getSha: () => localStorage.getItem(LS_SHA),
  isDirty: () => !!localStorage.getItem(LS_DIRTY),
  getRev: () => editRev,
  applyRemote(remote, sha, rev) {
    const merged = mergeData(data, remote);
    const changed = hasChangesOver(merged, data);
    data = merged;
    saveLocalData();
    localStorage.setItem(LS_SHA, sha);
    localStorage.setItem(LS_LAST_SYNC, nowIso());
    if (rev === editRev) localStorage.removeItem(LS_DIRTY);
    else syncer.schedule();
    if (changed) render();
  },
  status: setSyncStatus
});

// ---------- Local data ----------
function loadLocalData() {
  const raw = localStorage.getItem(LS_DATA);
  if (!raw) return emptyData();
  try {
    return migrate(JSON.parse(raw));
  } catch (e) {
    // Keep the unreadable copy aside rather than discarding it; GitHub still has the
    // durable copy and the next sync merges it back in.
    console.warn('local data unreadable', e);
    localStorage.setItem(`${LS_DATA}-unreadable-${Date.now()}`, raw);
    return emptyData();
  }
}

function saveLocalData() {
  try {
    localStorage.setItem(LS_DATA, JSON.stringify(data));
  } catch (e) {
    showToast('Couldn’t save on this device — storage full?');
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { ghUser: '', ghRepo: '', ghBranch: 'main', ghToken: '' };
}

function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
}

// ---------- Mutations ----------
// Records are replaced, never edited in place, and every change stamps updatedAt — that's
// what the sync merge uses to decide which copy of a record is newer.
function find(coll, id) { return data[coll].find(r => r.id === id); }

function put(coll, rec) {
  const next = { ...rec, updatedAt: nowIso() };
  const exists = data[coll].some(r => r.id === rec.id);
  data = { ...data, [coll]: exists ? data[coll].map(r => r.id === rec.id ? next : r) : [...data[coll], next] };
  return next;
}

function patch(coll, id, changes) {
  const rec = find(coll, id);
  if (rec) put(coll, { ...rec, ...changes });
}

// `render: false` is for edits made while typing in the task list, where the DOM already
// shows the change and re-rendering would steal focus and close the keyboard.
function commit({ render: doRender = true } = {}) {
  editRev++;
  localStorage.setItem(LS_DIRTY, '1');
  saveLocalData();
  if (doRender) render();
  syncer.schedule();
}

function softDelete(coll, id, label) {
  patch(coll, id, { deletedAt: nowIso() });
  commit();
  showToast(`${label} deleted`, () => { patch(coll, id, { deletedAt: null }); commit(); });
}

function toggleTask(id) {
  const t = find('tasks', id);
  if (!t) return;
  const wasDone = t.completed;
  patch('tasks', id, wasDone ? { completed: false, completedAt: null } : { completed: true, completedAt: nowIso() });
  commit();
  showToast(wasDone ? 'Marked not done' : 'Task completed', () => {
    patch('tasks', id, { completed: t.completed, completedAt: t.completedAt });
    commit();
  });
}

// One completion record per routine per local date; unchecking tombstones it.
function toggleRoutine(routineId, date) {
  const id = completionId(routineId, date);
  const rec = find('routineCompletions', id);
  if (rec && !rec.deletedAt) {
    patch('routineCompletions', id, { deletedAt: nowIso() });
  } else if (rec) {
    patch('routineCompletions', id, { deletedAt: null, completedAt: nowIso() });
  } else {
    put('routineCompletions', { id, routineId, date, completedAt: nowIso(), createdAt: nowIso(), deletedAt: null });
  }
  commit();
}

function toggleGoal(id) {
  const g = find('weeklyGoals', id);
  if (!g) return;
  patch('weeklyGoals', id, g.completed ? { completed: false, completedAt: null } : { completed: true, completedAt: nowIso() });
  commit();
}

function incrementGoal(id) {
  const g = find('weeklyGoals', id);
  if (!g) return;
  const progress = (g.progress || 0) + 1;
  const reached = g.target && progress >= g.target && !g.completed;
  patch('weeklyGoals', id, { progress, ...(reached ? { completed: true, completedAt: nowIso() } : {}) });
  commit();
  showToast(`${g.title}: ${progress} / ${g.target}`, () => {
    patch('weeklyGoals', id, { progress: g.progress, completed: g.completed, completedAt: g.completedAt });
    commit();
  });
}

// Move a record up/down within the visible list by renumbering that list's order.
function move(coll, list, id, dir) {
  const i = list.findIndex(r => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const reordered = [...list];
  [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
  reordered.forEach((r, idx) => { if (r.order !== idx + 1) patch(coll, r.id, { order: idx + 1 }); });
  commit();
}

function addLogEntry(text, date, notes = '') {
  put('logEntries', { id: newId(), date, text, notes, createdAt: nowIso(), deletedAt: null });
  commit();
}

// ---------- Rendering helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 3.5h6l-1 5 3.5 3.5v1.5h-11V12L10 8.5z"/><path d="M12 13.5V20"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 10l6 6 6-6"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>',
  calOn: '<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/><circle cx="12" cy="14.5" r="1.6" fill="currentColor"/></svg>'
};

function checkBtn(on, act, attrs, label) {
  return `<button type="button" class="check${on ? ' on' : ''}" data-act="${act}" ${attrs} aria-label="${esc(label)}" aria-pressed="${on}"><span class="box">${ICONS.check}</span></button>`;
}

// Read-only row, used for completed tasks.
function taskRow(t, td) {
  const u = t.dueDate && !t.completed ? urgency(t.dueDate, td) : null;
  let meta = '';
  if (t.completed) meta = `Completed ${fmtShort(timestampToKey(t.completedAt), td)}`;
  else if (u) meta = `<span class="urg-${u.level}">${esc(u.label)}</span> · ${fmtShort(t.dueDate, td)}`;
  return `<div class="row${t.completed ? ' done' : ''}${u && u.level === 'overdue' ? ' overdue' : ''}">
    ${checkBtn(t.completed, 'task', `data-id="${t.id}"`, t.completed ? 'Mark not done' : 'Complete')}
    <button type="button" class="row-main" data-act="edit" data-kind="task" data-id="${t.id}">
      <span class="row-title">${esc(t.title)}</span>${meta ? `<span class="row-meta">${meta}</span>` : ''}
    </button></div>`;
}

// Editable "notepad" line for an open task: the title is a text box you type into directly.
// Undated lines get a drag handle; dated ones are kept in due-date order.
function lineRow(t, td) {
  const u = t.dueDate ? urgency(t.dueDate, td) : null;
  const meta = u ? `<span class="row-meta"><span class="urg-${u.level}">${esc(u.label)}</span> · ${fmtShort(t.dueDate, td)}</span>` : '';
  const hasDetail = !!(t.dueDate || t.notes);
  return `<div class="row line${u && u.level === 'overdue' ? ' overdue' : ''}" data-id="${t.id}">
    ${checkBtn(false, 'task', `data-id="${t.id}"`, 'Complete')}
    <div class="line-main"><textarea class="line-input" rows="1" data-id="${t.id}" enterkeyhint="next" aria-label="Task">${esc(t.title)}</textarea>${meta}${
      t.notes ? `<span class="line-notes">${esc(t.notes.split('\n')[0])}</span>` : ''}</div>
    <button type="button" class="trail-btn${hasDetail ? ' on' : ''}" data-act="edit" data-kind="task" data-id="${t.id}" aria-label="Due date and notes">${hasDetail ? ICONS.calOn : ICONS.cal}</button>
    ${t.dueDate ? '' : `<span class="drag-handle" data-id="${t.id}" aria-label="Drag to reorder" role="button">${ICONS.grip}</span>`}
  </div>`;
}

function draftRowHtml() {
  return `<div class="row line draft"><span class="check ghost"></span>
    <div class="line-main"><textarea class="line-input" rows="1" data-draft="1" enterkeyhint="next" aria-label="New task"></textarea></div></div>`;
}

function routineCheckRow(r, date) {
  const done = isRoutineDone(data, r.id, date);
  return `<div class="row${done ? ' done' : ''}">
    ${checkBtn(done, 'routine', `data-id="${r.id}"`, done ? 'Mark not done' : 'Done today')}
    <button type="button" class="row-main" data-act="edit" data-kind="routine" data-id="${r.id}"><span class="row-title">${esc(r.title)}</span></button></div>`;
}

function goalRow(g) {
  const control = g.target
    ? `<button type="button" class="counter${g.completed ? ' on' : ''}" data-act="goal-inc" data-id="${g.id}" aria-label="Add one"><span>${g.progress || 0}/${g.target}</span></button>`
    : checkBtn(g.completed, 'goal', `data-id="${g.id}"`, g.completed ? 'Mark not done' : 'Complete');
  return `<div class="row${g.completed ? ' done' : ''}">${control}
    <button type="button" class="row-main" data-act="edit" data-kind="goal" data-id="${g.id}"><span class="row-title">${esc(g.title)}</span></button></div>`;
}

function logRow(e) {
  return `<div class="row log-entry"><button type="button" class="row-main" data-act="edit" data-kind="log" data-id="${e.id}">
    <span class="row-title">${esc(e.text)}</span>${e.notes ? `<span class="row-notes">${esc(e.notes)}</span>` : ''}</button></div>`;
}

function section(title, body, { right = '', foot = '' } = {}) {
  return `<section class="card"><div class="sec-head"><h2>${title}</h2>${right}</div>${body}${foot ? `<div class="sec-foot">${foot}</div>` : ''}</section>`;
}

// ---------- Views ----------
const VIEW_TITLES = { tasks: 'Tasks', routines: 'Routines', weekly: 'This Week', log: 'Daily Log', search: 'Search', settings: 'Settings' };
const SUB_VIEWS = { search: null, settings: null };
let returnTo = 'tasks';

function go(next) {
  if (editingLine()) document.activeElement.blur();
  if (next in SUB_VIEWS && !(view in SUB_VIEWS)) returnTo = view;
  view = next;
  window.scrollTo(0, 0);
  render();
  if (view === 'search') setTimeout(() => document.getElementById('searchInput').focus(), 50);
}

// While you're typing in the task list, re-rendering would replace the text box under your
// fingers, so renders wait until you stop editing.
let renderPending = false;
function editingLine() {
  const a = document.activeElement;
  return !!(a && a.classList && a.classList.contains('line-input'));
}
function render() {
  if (editingLine() || dragState) { renderPending = true; return; }
  renderPending = false;
  renderNow();
}
function flushPendingRender() {
  setTimeout(() => { if (renderPending && !editingLine() && !dragState) render(); }, 300);
}

function renderNow() {
  const td = today();
  for (const el of document.querySelectorAll('main > .view')) el.hidden = el.id !== `view-${view}`;
  for (const el of document.querySelectorAll('.tab[data-view]')) el.classList.toggle('on', el.dataset.view === view);
  const back = document.getElementById('backBtn');
  back.hidden = !(view in SUB_VIEWS);
  document.getElementById('backLabel').textContent = VIEW_TITLES[SUB_VIEWS[view] || returnTo];
  document.getElementById('pageTitle').textContent = VIEW_TITLES[view];
  const sub = document.getElementById('pageSub');
  sub.textContent = '';
  const dbg = document.getElementById('debugBanner');
  dbg.hidden = !DEBUG_TODAY;
  dbg.textContent = DEBUG_TODAY ? `Simulating ${fmtLong(DEBUG_TODAY)}, ${DEBUG_TODAY.slice(0, 4)}` : '';

  if (view === 'tasks') renderTasks(td, sub);
  else if (view === 'routines') renderRoutines(td, sub);
  else if (view === 'weekly') { sub.textContent = fmtWeekRange(weekStartOf(td), td); renderWeekly(td); }
  else if (view === 'log') { sub.textContent = fmtLong(td); renderLog(td); }
  else if (view === 'search') renderSearch(td);
  else if (view === 'settings') renderSettings();
}

function renderTasks(td, sub) {
  const open = openTasks(data);
  const body = document.getElementById('tasksBody');

  if (tasksTab === 'done') {
    const done = completedTasks(data);
    sub.textContent = `${done.length} completed`;
    body.innerHTML = `<button type="button" class="link-btn back-link" data-act="tasks-tab" data-tab="open">← Open tasks</button>`
      + (done.length
        ? section('Completed', done.map(t => taskRow(t, td)).join(''), { right: `<span class="count">${done.length}</span>` })
        : `<section class="card"><p class="empty" style="padding-top:16px">No completed tasks yet.</p></section>`);
    return;
  }
  sub.textContent = `${fmtLong(td)} · ${open.length} open`;
  const dated = datedTasks(data);
  const ongoing = ongoingTasks(data);
  const doneCount = completedTasks(data).length;
  body.innerHTML =
    (dated.length ? section('Time-sensitive', `<div class="lines dated">${dated.map(t => lineRow(t, td)).join('')}</div>`) : '')
    + `<section class="card notepad">
        ${dated.length ? '<div class="sec-head"><h2>To do</h2></div>' : ''}
        <div class="lines" id="lineList">${ongoing.map(t => lineRow(t, td)).join('')}</div>
        <div class="row line composer"><span class="check plus" aria-hidden="true">+</span>
          <div class="line-main"><textarea class="line-input" rows="1" id="composer" data-composer="1" enterkeyhint="next" placeholder="Add a task" aria-label="Add a task"></textarea></div></div>
      </section>
      <p class="hint tasks-tip">Tap a task to edit it. Enter starts a new line, ${ICONS.grip.replace('<svg', '<svg class="inline-icon"')} drags to reorder.
        End a line with <b>@today</b>, <b>@fri</b> or <b>@12/3</b> to give it a due date, or tap ${ICONS.cal.replace('<svg', '<svg class="inline-icon"')}.</p>`
    + (doneCount ? `<button type="button" class="link-btn done-link" data-act="tasks-tab" data-tab="done">Completed (${doneCount}) →</button>` : '')
    + (settings.ghToken ? '' : `<p class="hint tasks-tip">Connect GitHub in Settings (⚙︎) to back up and sync your data.</p>`);
  body.querySelectorAll('.line-input').forEach(autosize);
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function renderRoutines(td, sub) {
  const all = live(data.routines).sort(byOrder);
  sub.textContent = `${all.filter(r => r.active).length} active`;
  const tdw = isoWeekday(td);
  const grid = [1, 2, 3, 4, 5, 6, 7].map(d => {
    const items = routinesForWeekday(data, d);
    return `<div class="day${d === tdw ? ' is-today' : ''}"><span class="day-name">${WEEKDAYS_SHORT[d - 1].toUpperCase()}</span>
      <span class="day-items${items.length ? '' : ' none'}">${items.length ? items.map(r => esc(r.title)).join(' · ') : 'Free'}</span></div>`;
  }).join('');
  const rows = all.map(r => {
    let trail = '';
    if (reorder.routines) {
      trail = `<button type="button" class="trail-btn" data-act="move" data-coll="routines" data-list="routines" data-id="${r.id}" data-dir="-1" aria-label="Move up">${ICONS.up}</button>`
        + `<button type="button" class="trail-btn" data-act="move" data-coll="routines" data-list="routines" data-id="${r.id}" data-dir="1" aria-label="Move down">${ICONS.down}</button>`;
    }
    return `<div class="row${r.active ? '' : ' inactive'}"><button type="button" class="row-main no-check" data-act="edit" data-kind="routine" data-id="${r.id}">
      <span class="row-title">${esc(r.title)}${r.active ? '' : '<span class="tag">Paused</span>'}</span>
      <span class="row-meta">${fmtWeekdays(r.weekdays)}</span></button>${trail}</div>`;
  }).join('');
  const todays = routinesForWeekday(data, tdw);
  const doneToday = todays.filter(r => isRoutineDone(data, r.id, td)).length;
  document.getElementById('routinesBody').innerHTML =
    (todays.length ? section(`Today · ${WEEKDAYS_LONG[tdw - 1]}`, todays.map(r => routineCheckRow(r, td)).join(''),
      { right: `<span class="count">${doneToday}/${todays.length}</span>` }) : '')
    + section('Your week', `<div class="week-grid">${grid}</div>`)
    + section('All routines', (rows || '<p class="empty">No routines yet.</p>')
      + `<button type="button" class="add-row" data-act="add" data-kind="routine">+ Add routine</button>`,
      { right: all.length > 1 ? `<button type="button" class="link-btn" data-act="reorder" data-coll="routines">${reorder.routines ? 'Done' : 'Reorder'}</button>` : '' });
}

function renderWeekly(td) {
  const ws = weekStartOf(td);
  const goals = goalsForWeek(data, ws);
  const done = goals.filter(g => g.completed).length;
  const past = pastWeeks(data, ws);
  document.getElementById('weeklyBody').innerHTML =
    section('Goals', (goals.length ? goals.map(goalRow).join('') : '<p class="empty">No goals for this week yet.</p>')
      + `<button type="button" class="add-row" data-act="add" data-kind="goal">+ Add weekly goal</button>`,
      { right: goals.length ? `<span class="count">${done}/${goals.length} done</span>` : '' })
    + (past.length ? `<h3 class="group-label">Previous weeks</h3>` + past.map(w => {
      const n = w.goals.filter(g => g.completed).length;
      return `<details class="week"><summary><span>${fmtWeekRange(w.weekStart, td)}</span><span class="count">${n} of ${w.goals.length} done</span></summary>
        ${w.goals.map(goalRow).join('')}</details>`;
    }).join('') : '');
}

function renderLog(td) {
  document.getElementById('todayLog').innerHTML = logForDate(data, td).map(logRow).join('');
  const days = logDays(data).filter(d => d.date !== td);
  document.getElementById('logBody').innerHTML = days.length
    ? days.map(d => section(`${esc(fmtLong(d.date))}${d.date.slice(0, 4) === td.slice(0, 4) ? '' : `, ${d.date.slice(0, 4)}`}`,
      d.entries.map(logRow).join(''))).join('')
    : '';
}

function highlight(text, words) {
  let html = esc(text);
  for (const w of words) {
    if (!w) continue;
    const re = new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, m => `<mark>${m}</mark>`);
  }
  return html;
}

function renderSearch(td) {
  const q = document.getElementById('searchInput').value;
  const body = document.getElementById('searchBody');
  if (!q.trim()) {
    body.innerHTML = `<p class="hint" style="padding:0 4px">Search tasks (including completed), routines, weekly goals and your daily log.</p>`;
    return;
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = search(data, q, td);
  body.innerHTML = results.length
    ? `<section class="card">${results.slice(0, 200).map(r => `
      <button type="button" class="result" data-act="edit" data-kind="${r.collection}" data-id="${r.sourceRecordId}">
        <div class="result-top"><span class="result-date">${fmtShort(r.date, td)}</span><span class="result-type t-${r.type}">${r.typeLabel}</span></div>
        <div class="result-title">${highlight(r.title, words)}</div>
        ${r.status || r.secondaryText ? `<div class="result-sub">${esc([r.status, r.secondaryText].filter(Boolean).join(' · '))}</div>` : ''}
      </button>`).join('')}</section>
      <p class="hint" style="padding:0 4px">${results.length} result${results.length === 1 ? '' : 's'}</p>`
    : `<p class="hint" style="padding:0 4px">No matches for “${esc(q)}”.</p>`;
}

function renderSettings() {
  document.getElementById('ghUser').value = settings.ghUser || '';
  document.getElementById('ghRepo').value = settings.ghRepo || '';
  document.getElementById('ghBranch').value = settings.ghBranch || 'main';
  document.getElementById('ghToken').value = settings.ghToken || '';
  const last = localStorage.getItem(LS_LAST_SYNC);
  const counts = COLLECTIONS.map(c => `${live(data[c]).length} ${c.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(', ');
  document.getElementById('dataStats').textContent =
    `${counts}. Schema v${SCHEMA_VERSION}.${last ? ` Last synced ${new Date(last).toLocaleString()}.` : ''}`;
  document.getElementById('removeSampleBtn').hidden = !COLLECTIONS.some(c => data[c].some(r => r.sample && !r.deletedAt));
}

// ---------- Sync status ----------
let lastStatus = { kind: 'off', text: '' };
function setSyncStatus(kind, text) {
  lastStatus = { kind, text };
  document.getElementById('syncDot').className = `sync-dot ${kind}`;
  document.getElementById('settingsBtn').title = text;
  document.getElementById('settingsStatus').textContent = text;
  const banner = document.getElementById('syncBanner');
  banner.hidden = kind !== 'error';
  banner.textContent = kind === 'error' ? `${text}. Your changes are safe on this device.` : '';
}

// ---------- Sheet (add / edit forms) ----------
let sheetCleanup = null;

function openSheet(html, { compact = false } = {}) {
  const sheet = document.getElementById('sheet');
  sheet.className = `sheet${compact ? ' compact' : ''}`;
  sheet.innerHTML = html;
  sheet.hidden = false;
  document.getElementById('sheetBackdrop').hidden = false;
  document.body.classList.add('locked');
  return sheet;
}

function closeSheet() {
  document.getElementById('sheet').hidden = true;
  document.getElementById('sheet').innerHTML = '';
  document.getElementById('sheetBackdrop').hidden = true;
  document.body.classList.remove('locked');
  sheetCleanup = null;
}

function sheetHead(title, saveLabel = 'Save') {
  return `<div class="sheet-head"><button type="button" class="cancel" data-sheet="cancel">Cancel</button><h2>${title}</h2>
    <button type="button" class="save" data-sheet="save">${saveLabel}</button></div>`;
}

function openAddMenu() {
  openSheet(`<div class="sheet-head"><button type="button" class="cancel" data-sheet="cancel">Cancel</button><h2>Add</h2><span style="min-width:70px"></span></div>
    <div class="add-choices">
      <button type="button" class="add-choice" data-act="add" data-kind="task"><b>Task</b><small>One-time, optional due date</small></button>
      <button type="button" class="add-choice" data-act="add" data-kind="routine"><b>Routine</b><small>Repeats on set weekdays</small></button>
      <button type="button" class="add-choice" data-act="add" data-kind="goal"><b>Weekly goal</b><small>Sometime this week</small></button>
      <button type="button" class="add-choice" data-act="add" data-kind="log"><b>Log entry</b><small>Something you did</small></button>
    </div>`, { compact: true });
}

const KIND_COLL = { task: 'tasks', routine: 'routines', goal: 'weeklyGoals', log: 'logEntries' };
const COLL_KIND = { tasks: 'task', routines: 'routine', weeklyGoals: 'goal', logEntries: 'log' };

function openEditor(kind, id, opts = {}) {
  kind = COLL_KIND[kind] || kind;
  const rec = id ? find(KIND_COLL[kind], id) : null;
  if (id && !rec) return;
  ({ task: taskForm, routine: routineForm, goal: goalForm, log: logForm })[kind](rec, opts);
}

function titleField(value, placeholder) {
  return `<div class="field"><input type="text" class="title-input" id="fTitle" value="${esc(value)}" placeholder="${placeholder}" enterkeyhint="done" autocomplete="off"><p class="error-text" id="fError" hidden></p></div>`;
}
function notesField(value) {
  return `<div class="field"><label for="fNotes">Notes</label><textarea id="fNotes" rows="3" placeholder="Optional">${esc(value)}</textarea></div>`;
}
function switchRow(id, label, on) {
  return `<label class="switch-row"><span>${label}</span><span class="switch"><input type="checkbox" id="${id}"${on ? ' checked' : ''}><span></span></span></label>`;
}
function deleteBtn(label) {
  return `<button type="button" class="btn danger" data-sheet="delete">Delete ${label}</button>`;
}

// Wires up a form opened in the sheet: Save button, Enter in the title, Delete.
function wireForm(sheet, { onSave, onDelete }) {
  const title = sheet.querySelector('#fTitle');
  const error = msg => { const e = sheet.querySelector('#fError'); e.textContent = msg; e.hidden = !msg; };
  const save = () => { const err = onSave(); if (err) error(err); else closeSheet(); };
  sheet.querySelector('[data-sheet="save"]').addEventListener('click', save);
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  const del = sheet.querySelector('[data-sheet="delete"]');
  if (del && onDelete) del.addEventListener('click', () => { closeSheet(); onDelete(); });
  if (!title.value) title.focus();
}

function taskForm(t) {
  const td = today();
  const sheet = openSheet(`${sheetHead(t ? 'Edit task' : 'New task', t ? 'Save' : 'Add')}<div class="sheet-body">
    ${titleField(t ? t.title : '', 'What needs doing?')}
    <div class="field"><label for="fDue">Due date</label><input type="date" id="fDue" value="${t && t.dueDate ? t.dueDate : ''}">
      <div class="chips">
        <button type="button" class="chip" data-due="${td}">Today</button>
        <button type="button" class="chip" data-due="${addDays(td, 1)}">Tomorrow</button>
        <button type="button" class="chip" data-due="${addDays(weekStartOf(td), 7)}">Next week</button>
        <button type="button" class="chip" data-due="">No date</button>
      </div></div>
    ${notesField(t ? t.notes : '')}
    ${t ? `<p class="hint">Added ${fmtShort(timestampToKey(t.createdAt), td)}${t.completed ? ` · completed ${fmtShort(timestampToKey(t.completedAt), td)}` : ''}</p>` : ''}
    ${t ? `<div class="sheet-actions">
      <button type="button" class="btn" data-sheet="complete">${t.completed ? 'Mark not done' : 'Mark complete'}</button>
      ${deleteBtn('task')}</div>` : ''}
  </div>`);
  const due = sheet.querySelector('#fDue');
  sheet.querySelectorAll('[data-due]').forEach(b => b.addEventListener('click', () => { due.value = b.dataset.due; }));
  const values = () => ({
    title: sheet.querySelector('#fTitle').value.trim(),
    notes: sheet.querySelector('#fNotes').value.trim(),
    dueDate: isDateKey(due.value) ? due.value : null
  });
  if (t) sheet.querySelector('[data-sheet="complete"]').addEventListener('click', () => {
    const v = values();
    if (v.title) { patch('tasks', t.id, v); }
    closeSheet();
    toggleTask(t.id);
  });
  wireForm(sheet, {
    onSave() {
      const v = values();
      if (!v.title) return 'Give the task a title.';
      if (t) patch('tasks', t.id, v);
      else put('tasks', newTask(v));
      commit();
    },
    onDelete: t && (() => softDelete('tasks', t.id, 'Task'))
  });
}

function routineForm(r) {
  let days = new Set(r ? r.weekdays : []);
  const sheet = openSheet(`${sheetHead(r ? 'Edit routine' : 'New routine', r ? 'Save' : 'Add')}<div class="sheet-body">
    ${titleField(r ? r.title : '', 'e.g. Stretch')}
    <div class="field"><span class="field-label">Repeats on</span>
      <div class="weekday-picker">${WEEKDAY_LETTERS.map((l, i) => `<button type="button" data-day="${i + 1}" aria-label="${WEEKDAYS_LONG[i]}">${l}</button>`).join('')}</div>
      <div class="chips"><button type="button" class="chip" data-preset="1234567">Every day</button>
        <button type="button" class="chip" data-preset="12345">Weekdays</button>
        <button type="button" class="chip" data-preset="67">Weekends</button></div></div>
    ${notesField(r ? r.notes : '')}
    ${r ? switchRow('fActive', 'Active', r.active) : ''}
    ${r ? `<p class="hint">Pausing hides it from your checklist but keeps its history. Delete only if you never want it again.</p><div class="sheet-actions">${deleteBtn('routine')}</div>` : ''}
  </div>`);
  const paint = () => sheet.querySelectorAll('[data-day]').forEach(b => {
    const on = days.has(+b.dataset.day);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
  sheet.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
    const d = +b.dataset.day;
    days.has(d) ? days.delete(d) : days.add(d);
    paint();
  }));
  sheet.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
    days = new Set([...b.dataset.preset].map(Number));
    paint();
  }));
  paint();
  wireForm(sheet, {
    onSave() {
      const title = sheet.querySelector('#fTitle').value.trim();
      if (!title) return 'Give the routine a title.';
      if (!days.size) return 'Pick at least one day.';
      const v = { title, notes: sheet.querySelector('#fNotes').value.trim(), weekdays: [...days].sort() };
      if (r) patch('routines', r.id, { ...v, active: sheet.querySelector('#fActive').checked });
      else put('routines', { id: newId(), ...v, active: true, createdAt: nowIso(), order: nextOrder(data.routines), deletedAt: null });
      commit();
    },
    onDelete: r && (() => softDelete('routines', r.id, 'Routine'))
  });
}

function goalForm(g) {
  const td = today();
  const weekStart = g ? g.weekStart : weekStartOf(td);
  let progress = g ? g.progress || 0 : 0;
  const sheet = openSheet(`${sheetHead(g ? 'Edit goal' : 'New weekly goal', g ? 'Save' : 'Add')}<div class="sheet-body">
    ${titleField(g ? g.title : '', 'e.g. Research a dance class')}
    <p class="hint" style="margin-top:-6px">Week of ${fmtWeekRange(weekStart, td)}</p>
    <div class="field"><label for="fTarget">Target number (optional)</label>
      <input type="number" id="fTarget" inputmode="numeric" min="1" placeholder="e.g. 3 for “start 3 conversations”" value="${g && g.target ? g.target : ''}"></div>
    <div class="field" id="fProgressWrap"><span class="field-label">Progress</span>
      <div class="stepper"><button type="button" data-step="-1" aria-label="Less">−</button><output id="fProgress"></output><button type="button" data-step="1" aria-label="More">+</button></div></div>
    ${notesField(g ? g.notes : '')}
    ${g ? switchRow('fDone', 'Completed', g.completed) : ''}
    ${g ? `<div class="sheet-actions">${deleteBtn('goal')}</div>` : ''}
  </div>`);
  const targetEl = sheet.querySelector('#fTarget');
  const doneEl = sheet.querySelector('#fDone');
  const target = () => { const n = parseInt(targetEl.value, 10); return n > 0 ? n : null; };
  const paint = () => {
    const t = target();
    sheet.querySelector('#fProgressWrap').hidden = !g || !t;
    sheet.querySelector('#fProgress').textContent = `${progress} / ${t || 0}`;
  };
  sheet.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    progress = Math.max(0, progress + +b.dataset.step);
    if (doneEl && target()) doneEl.checked = progress >= target();
    paint();
  }));
  targetEl.addEventListener('input', paint);
  paint();
  wireForm(sheet, {
    onSave() {
      const title = sheet.querySelector('#fTitle').value.trim();
      if (!title) return 'Give the goal a title.';
      const v = { title, notes: sheet.querySelector('#fNotes').value.trim(), target: target(), progress };
      if (g) {
        const completed = doneEl.checked;
        patch('weeklyGoals', g.id, { ...v, completed, completedAt: completed ? (g.completedAt || nowIso()) : null });
      } else {
        put('weeklyGoals', { id: newId(), ...v, weekStart, completed: false, completedAt: null, createdAt: nowIso(),
          order: nextOrder(data.weeklyGoals.filter(x => x.weekStart === weekStart)), deletedAt: null });
      }
      commit();
    },
    onDelete: g && (() => softDelete('weeklyGoals', g.id, 'Goal'))
  });
}

function logForm(e, { backdate } = {}) {
  const td = today();
  const sheet = openSheet(`${sheetHead(e ? 'Edit entry' : 'Log entry', e ? 'Save' : 'Add')}<div class="sheet-body">
    ${titleField(e ? e.text : '', 'What did you do?')}
    <div class="field"><label for="fDate">Day</label><input type="date" id="fDate" max="${td}" value="${e ? e.date : (backdate ? addDays(td, -1) : td)}"></div>
    ${notesField(e ? e.notes : '')}
    ${e ? `<p class="hint">Written ${new Date(e.createdAt).toLocaleString()}</p><div class="sheet-actions">${deleteBtn('entry')}</div>` : ''}
  </div>`);
  wireForm(sheet, {
    onSave() {
      const text = sheet.querySelector('#fTitle').value.trim();
      const date = sheet.querySelector('#fDate').value;
      if (!text) return 'Write a short description.';
      if (!isDateKey(date)) return 'Pick a day.';
      const notes = sheet.querySelector('#fNotes').value.trim();
      if (e) { patch('logEntries', e.id, { text, date, notes }); commit(); }
      else addLogEntry(text, date, notes);
    },
    onDelete: e && (() => softDelete('logEntries', e.id, 'Entry'))
  });
}

// ---------- Toast ----------
function showToast(text, undo) {
  const el = document.getElementById('toast');
  document.getElementById('toastText').textContent = text;
  const btn = document.getElementById('toastUndo');
  btn.hidden = !undo;
  btn.onclick = () => { el.hidden = true; if (undo) undo(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 5000 : 3000);
}

// ---------- Settings actions ----------
async function saveSettingsFromForm() {
  const prev = `${settings.ghUser}/${settings.ghRepo}/${settings.ghBranch}`;
  settings = {
    ghUser: document.getElementById('ghUser').value.trim(),
    ghRepo: document.getElementById('ghRepo').value.trim(),
    ghBranch: document.getElementById('ghBranch').value.trim() || 'main',
    ghToken: document.getElementById('ghToken').value.trim()
  };
  saveSettings();
  if (prev !== `${settings.ghUser}/${settings.ghRepo}/${settings.ghBranch}`) localStorage.removeItem(LS_SHA);
  await syncer.pull();
  renderSettings();
}

function exportData() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `daily-data-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Sample records are flagged so they can be removed again in one tap.
function loadSampleData() {
  const td = today();
  const now = nowIso();
  const nov15 = `${td.slice(0, 4)}-11-15` >= td ? `${td.slice(0, 4)}-11-15` : `${+td.slice(0, 4) + 1}-11-15`;
  const base = { notes: '', createdAt: now, deletedAt: null, sample: true };
  let order = nextOrder(data.tasks);
  const tasks = [
    ['Apply to circuses'], ['Check in on circus applications'], ['Develop new pottery animal designs'],
    ['Keep track of Etsy store'], ['Sell storage-unit items on Marketplace'],
    ['Call shoe factory', addDays(td, 1)], ['Cancel United credit card', nov15]
  ];
  for (const [title, dueDate] of tasks) {
    put('tasks', { ...base, id: newId(), title, dueDate: dueDate || null, completed: false, completedAt: null, pinned: false, order: order++ });
  }
  order = nextOrder(data.routines);
  for (const [title, weekdays] of [['Gym', [1, 3, 5]], ['Stretch', [1, 2, 3, 4, 5, 6, 7]], ['Conversation practice', [2, 4]]]) {
    put('routines', { ...base, id: newId(), title, weekdays, active: true, order: order++ });
  }
  const ws = weekStartOf(td);
  put('weeklyGoals', { ...base, id: newId(), title: 'Start three conversations', weekStart: ws, target: 3, progress: 1, completed: false, completedAt: null, order: 1 });
  put('weeklyGoals', { ...base, id: newId(), title: 'Research one dance class or Meetup group', weekStart: ws, target: null, progress: 0, completed: false, completedAt: null, order: 2 });
  put('logEntries', { ...base, id: newId(), date: addDays(td, -1), text: 'Practiced ball spinning for 20 minutes' });
  put('logEntries', { ...base, id: newId(), date: addDays(td, -1), text: 'Sent an application to Circus Grimaldi' });
  commit();
  showToast('Sample data added');
}

function removeSampleData() {
  for (const c of COLLECTIONS) for (const r of data[c]) if (r.sample && !r.deletedAt) patch(c, r.id, { deletedAt: nowIso() });
  commit();
  showToast('Sample data removed');
}

// ---------- Notepad task list ----------
function newTask(fields) {
  return { id: newId(), notes: '', dueDate: null, ...fields, createdAt: nowIso(), completed: false, completedAt: null,
    pinned: false, order: nextOrder(data.tasks), deletedAt: null };
}

// Undated tasks are ordered by their position in the list on screen.
function saveLineOrder() {
  const ids = [...document.querySelectorAll('#lineList > .row[data-id]')].map(r => r.dataset.id);
  ids.forEach((id, i) => {
    const t = find('tasks', id);
    if (t && t.order !== i + 1) patch('tasks', id, { order: i + 1 });
  });
}

function deleteLine(id) {
  patch('tasks', id, { deletedAt: nowIso() });
  commit({ render: false });
  showToast('Task deleted', () => { patch('tasks', id, { deletedAt: null }); commit(); });
}

// Save an existing line's text when you leave it. Emptying a line deletes the task (undoable).
function saveLine(el) {
  if (el.dataset.gone) return;
  const t = find('tasks', el.dataset.id);
  if (!t || t.deletedAt || t.completed) return;
  const text = el.value.trim();
  if (!text) {
    el.dataset.gone = '1';
    deleteLine(t.id);
    renderPending = true;
    return;
  }
  const { title, dueDate } = parseQuickDate(text, today());
  if (title === t.title && !dueDate) { if (el.value !== t.title) el.value = t.title; return; }
  patch('tasks', t.id, dueDate ? { title, dueDate } : { title });
  el.value = title;
  commit({ render: false });
  if (dueDate) { renderPending = true; showToast(`Due ${fmtShort(dueDate, today())}`); }
}

// Turn the text in a draft line (or the bottom "Add a task" line) into a task, placed where
// that line sits. Returns the new task's row, or null if it went to Time-sensitive.
function createFromInput(el) {
  const text = el.value.trim();
  if (!text) return null;
  const { title, dueDate } = parseQuickDate(text, today());
  const t = put('tasks', newTask({ title, dueDate }));
  const td = today();
  let row = null;
  if (!dueDate) {
    const holder = document.createElement('div');
    holder.innerHTML = lineRow(t, td);
    row = holder.firstElementChild;
    const list = document.getElementById('lineList');
    const at = el.closest('.row');
    if (at && at.parentElement === list) list.insertBefore(row, at);
    else list.appendChild(row);
    autosize(row.querySelector('.line-input'));
    saveLineOrder();
  } else {
    renderPending = true;
    showToast(`Added · due ${fmtShort(dueDate, td)}`);
  }
  commit({ render: false });
  return row;
}

function addDraftAfter(row) {
  const holder = document.createElement('div');
  holder.innerHTML = draftRowHtml();
  const draft = holder.firstElementChild;
  row.after(draft);
  const input = draft.querySelector('.line-input');
  input.focus();
  return input;
}

function onLineKeydown(e) {
  const el = e.target;
  if (!el.classList.contains('line-input') || e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (el.dataset.composer) {
      // Bottom line: add and keep typing right here.
      if (!el.value.trim()) { el.blur(); return; }
      createFromInput(el);
      el.value = '';
      autosize(el);
      el.scrollIntoView({ block: 'nearest' });
    } else if (el.dataset.draft) {
      const draftRow = el.closest('.row');
      if (!el.value.trim()) { draftRow.remove(); el.blur(); return; }
      el.dataset.gone = '1';
      const row = createFromInput(el);
      addDraftAfter(row || draftRow);
      draftRow.remove();
    } else {
      saveLine(el);
      const row = el.closest('.row');
      if (row.parentElement && row.parentElement.id === 'lineList') addDraftAfter(row);
      else el.blur();
    }
  } else if (e.key === 'Backspace' && !el.value && !el.dataset.composer) {
    // Backspace on an empty line removes it and jumps to the line above, like a notepad.
    e.preventDefault();
    const row = el.closest('.row');
    const prev = row.previousElementSibling && row.previousElementSibling.querySelector('.line-input');
    const next = row.nextElementSibling && row.nextElementSibling.querySelector('.line-input');
    const target = prev || next;
    el.dataset.gone = '1';
    if (target) { target.focus(); const end = prev ? target.value.length : 0; target.setSelectionRange(end, end); }
    else el.blur();
    if (el.dataset.id) deleteLine(el.dataset.id);
    row.remove();
  }
}

function onLineBlur(e) {
  const el = e.target;
  if (!el.classList || !el.classList.contains('line-input')) return;
  if (el.dataset.draft) {
    if (!el.dataset.gone) { el.dataset.gone = '1'; createFromInput(el); }
    el.closest('.row')?.remove();
  } else if (el.dataset.composer) {
    if (el.value.trim()) { createFromInput(el); el.value = ''; autosize(el); }
  } else {
    saveLine(el);
  }
  flushPendingRender();
}

// Pasting several lines into a task line makes one task per line.
function onLinePaste(e) {
  const el = e.target;
  if (!el.classList.contains('line-input') || !e.clipboardData) return;
  const lines = splitPastedLines(e.clipboardData.getData('text'));
  if (lines.length < 2) return;
  e.preventDefault();
  const before = el.value.slice(0, el.selectionStart);
  const after = el.value.slice(el.selectionEnd);
  lines[0] = before + lines[0];
  lines[lines.length - 1] += after;
  if (el.dataset.id) { el.value = lines.shift(); saveLine(el); }
  const anchor = el.dataset.id ? el.closest('.row').nextElementSibling : el.closest('.row');
  for (const line of lines) {
    createFromInput({ value: line, closest: () => anchor });
  }
  if (!el.dataset.id) { el.value = ''; autosize(el); }
  showToast(`Added ${lines.length + (el.dataset.id ? 1 : 0)} tasks`);
}

// ---------- Drag to reorder ----------
// Press the grip and slide: other rows make room, the list scrolls near the edges, and the
// new order is saved on release.
let dragState = null;

function startDrag(e) {
  const handle = e.target.closest('.drag-handle');
  if (!handle || dragState) return;
  e.preventDefault();
  if (editingLine()) document.activeElement.blur();
  const row = handle.closest('.row');
  const rows = [...document.querySelectorAll('#lineList > .row[data-id]')];
  if (rows.length < 2) return;
  const from = rows.indexOf(row);
  const rects = rows.map(r => { const b = r.getBoundingClientRect(); return { top: b.top + window.scrollY, h: b.height }; });
  dragState = { row, rows, from, to: from, rects, startY: e.clientY + window.scrollY, clientY: e.clientY, pointerId: e.pointerId, raf: 0 };
  handle.setPointerCapture(e.pointerId);
  row.classList.add('dragging');
  document.body.classList.add('drag-active');
  const loop = () => {
    if (!dragState) return;
    const edge = 90, bottomEdge = window.innerHeight - 110;
    if (dragState.clientY < edge) window.scrollBy(0, -Math.ceil((edge - dragState.clientY) / 8));
    else if (dragState.clientY > bottomEdge) window.scrollBy(0, Math.ceil((dragState.clientY - bottomEdge) / 8));
    layoutDrag();
    dragState.raf = requestAnimationFrame(loop);
  };
  dragState.raf = requestAnimationFrame(loop);
}

function layoutDrag() {
  const s = dragState;
  const dy = s.clientY + window.scrollY - s.startY;
  const me = s.rects[s.from];
  const center = me.top + me.h / 2 + dy;
  let to = 0;
  s.rects.forEach((r, j) => { if (j !== s.from && r.top + r.h / 2 < center) to++; });
  s.to = to;
  s.row.style.transform = `translateY(${dy}px)`;
  s.rows.forEach((r, j) => {
    if (j === s.from) return;
    let shift = 0;
    if (j > s.from && j <= to) shift = -me.h;
    else if (j < s.from && j >= to) shift = me.h;
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function moveDrag(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  dragState.clientY = e.clientY;
  layoutDrag();
}

function endDrag(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const s = dragState;
  cancelAnimationFrame(s.raf);
  dragState = null;
  document.body.classList.remove('drag-active');
  s.rows.forEach(r => { r.style.transition = 'none'; r.style.transform = ''; });
  s.row.classList.remove('dragging');
  if (e.type !== 'pointercancel' && s.to !== s.from) {
    const others = s.rows.filter(r => r !== s.row);
    const list = document.getElementById('lineList');
    if (s.to >= others.length) list.appendChild(s.row);
    else list.insertBefore(s.row, others[s.to]);
    saveLineOrder();
    commit({ render: false });
  }
  requestAnimationFrame(() => s.rows.forEach(r => { r.style.transition = ''; }));
  flushPendingRender();
}

// ---------- Events ----------
function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  // Leaving a line you were typing in saves it before the button does its thing.
  if (editingLine()) document.activeElement.blur();
  const { act, id } = el.dataset;
  const td = today();
  switch (act) {
    case 'go': closeSheet(); go(el.dataset.view); break;
    case 'add-menu': openAddMenu(); break;
    case 'add': openEditor(el.dataset.kind, null, { backdate: !!el.dataset.backdate }); break;
    case 'edit': openEditor(el.dataset.kind, id); break;
    case 'task': toggleTask(id); break;
    case 'routine': toggleRoutine(id, td); break;
    case 'goal': toggleGoal(id); break;
    case 'goal-inc': incrementGoal(id); break;
    case 'tasks-tab': tasksTab = el.dataset.tab; render(); break;
    case 'reorder': reorder[el.dataset.coll] = !reorder[el.dataset.coll]; render(); break;
    case 'move': {
      move(el.dataset.coll, live(data.routines).sort(byOrder), id, +el.dataset.dir);
      break;
    }
  }
}

function checkDayRollover() {
  if (today() !== currentDay) { currentDay = today(); render(); }
}

function wireEvents() {
  document.addEventListener('click', onClick);
  document.getElementById('sheet').addEventListener('click', e => {
    if (e.target.closest('[data-sheet="cancel"]')) closeSheet();
  });
  document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.getElementById('sheet').hidden) closeSheet(); });

  document.getElementById('searchBtn').addEventListener('click', () => go('search'));
  document.getElementById('settingsBtn').addEventListener('click', () => go('settings'));
  document.getElementById('backBtn').addEventListener('click', () => go(SUB_VIEWS[view] || returnTo));
  document.getElementById('searchInput').addEventListener('input', () => renderSearch(today()));

  const tasksBody = document.getElementById('tasksBody');
  tasksBody.addEventListener('keydown', onLineKeydown);
  tasksBody.addEventListener('focusout', onLineBlur);
  tasksBody.addEventListener('paste', onLinePaste);
  tasksBody.addEventListener('input', e => { if (e.target.classList.contains('line-input')) autosize(e.target); });
  tasksBody.addEventListener('pointerdown', startDrag);
  document.addEventListener('pointermove', moveDrag);
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  document.getElementById('logQuickForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('logQuickInput');
    const text = input.value.trim();
    if (!text) return;
    addLogEntry(text, today());
    input.value = '';
  });

  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
  document.getElementById('syncNowBtn').addEventListener('click', () => syncer.pull().then(renderSettings));
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('sampleBtn').addEventListener('click', loadSampleData);
  document.getElementById('removeSampleBtn').addEventListener('click', removeSampleData);

  // Coming back to the app (iOS resumes suspended PWAs rather than reloading): pick up
  // changes from other devices and roll over to a new day if midnight passed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { checkDayRollover(); syncer.pull(); }
    else syncer.flush();
  });
  window.addEventListener('online', () => syncer.pull());
  window.addEventListener('resize', () => document.querySelectorAll('#tasksBody .line-input').forEach(autosize));
  setInterval(checkDayRollover, 30000);
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  render();
  setSyncStatus(settings.ghToken ? 'busy' : 'off', settings.ghToken ? 'Syncing…' : 'Not connected');
  syncer.pull();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
