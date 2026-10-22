// ---------- Data model ----------
// One JSON document holds everything. Every record has a stable id, createdAt and updatedAt.
// Records are never removed from the document: completing keeps the record, and deleting
// sets deletedAt (a "tombstone") so the deletion can sync to other devices and be undone.
//
// data = {
//   schemaVersion,
//   tasks:              { id, title, notes, createdAt, updatedAt, dueDate|null, completed, completedAt|null, pinned, order, deletedAt|null }
//   routines:           { id, title, notes, active, weekdays: [1..7 Mon..Sun], createdAt, updatedAt, order, deletedAt|null }
//   routineCompletions: { id: routineId@date, routineId, date, completedAt, updatedAt, deletedAt|null }
//   weeklyGoals:        { id, title, notes, weekStart, completed, completedAt|null, target|null, progress, createdAt, updatedAt, order, deletedAt|null }
//   logEntries:         { id, date, text, notes, createdAt, updatedAt, deletedAt|null }
// }

const SCHEMA_VERSION = 1;
const COLLECTIONS = ['tasks', 'routines', 'routineCompletions', 'weeklyGoals', 'logEntries'];

class NewerSchemaError extends Error {}

function emptyData() {
  const d = { schemaVersion: SCHEMA_VERSION };
  for (const c of COLLECTIONS) d[c] = [];
  return d;
}

function nowIso() { return new Date().toISOString(); }

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Validate a document and bring it up to the current schema. Throws rather than guessing
// when the shape is wrong, so a malformed copy can never be merged in or written back.
function migrate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Data is not an object');
  const version = raw.schemaVersion == null ? 1 : raw.schemaVersion;
  if (typeof version !== 'number') throw new Error('Bad schemaVersion');
  if (version > SCHEMA_VERSION) {
    throw new NewerSchemaError(`Data was written by a newer version of the app (schema ${version}). Reload to update.`);
  }
  const data = { ...raw };
  // Future migrations go here, e.g. `if (version < 2) { ... }`.
  for (const c of COLLECTIONS) {
    if (data[c] == null) data[c] = [];
    if (!Array.isArray(data[c])) throw new Error(`${c} is not a list`);
    for (const r of data[c]) {
      if (!r || typeof r.id !== 'string' || !r.id) throw new Error(`${c} has a record without an id`);
    }
  }
  data.schemaVersion = SCHEMA_VERSION;
  return data;
}

// Record-level merge: union of both copies by id; when both have a record, the one with
// the later updatedAt wins (ties go to `a`). Nothing present in either copy is dropped.
function mergeData(a, b) {
  const out = { ...b, ...a, schemaVersion: Math.max(a.schemaVersion || 1, b.schemaVersion || 1) };
  for (const c of COLLECTIONS) {
    const byId = new Map();
    for (const r of b[c] || []) byId.set(r.id, r);
    for (const r of a[c] || []) {
      const other = byId.get(r.id);
      if (!other || (r.updatedAt || '') >= (other.updatedAt || '')) byId.set(r.id, r);
    }
    out[c] = [...byId.values()];
  }
  return out;
}

// True when `a` has anything `b` lacks or holds a different version of.
function hasChangesOver(a, b) {
  if ((a.schemaVersion || 1) !== (b.schemaVersion || 1)) return true;
  for (const c of COLLECTIONS) {
    const seen = new Map((b[c] || []).map(r => [r.id, r.updatedAt || '']));
    for (const r of a[c] || []) {
      if (seen.get(r.id) !== (r.updatedAt || '')) return true;
    }
  }
  return false;
}

// Belt and braces before any write: every record in `before` must still exist in `after`.
function assertNoLoss(before, after) {
  for (const c of COLLECTIONS) {
    const ids = new Set(after[c].map(r => r.id));
    for (const r of before[c] || []) {
      if (!ids.has(r.id)) throw new Error(`Refusing to write: ${c} record ${r.id} would be lost`);
    }
  }
}

function countRecords(data) {
  return COLLECTIONS.reduce((n, c) => n + (data[c] || []).length, 0);
}

// ---------- Queries ----------
const live = list => list.filter(r => !r.deletedAt);
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || '').localeCompare(b.createdAt || '');
const nextOrder = list => list.reduce((m, r) => Math.max(m, r.order ?? 0), 0) + 1;

function completionId(routineId, date) { return `${routineId}@${date}`; }

function isRoutineDone(data, routineId, date) {
  const c = data.routineCompletions.find(r => r.id === completionId(routineId, date));
  return !!(c && !c.deletedAt);
}

function routinesForWeekday(data, weekday) {
  return live(data.routines).filter(r => r.active && r.weekdays.includes(weekday)).sort(byOrder);
}

function lastRoutineCompletion(data, routineId) {
  let last = null;
  for (const c of data.routineCompletions) {
    if (c.routineId === routineId && !c.deletedAt && (!last || c.date > last)) last = c.date;
  }
  return last;
}

function openTasks(data) { return live(data.tasks).filter(t => !t.completed); }

// Earliest due date first, so overdue tasks naturally lead.
function datedTasks(data) {
  return openTasks(data).filter(t => t.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byOrder(a, b));
}

function ongoingTasks(data) {
  return openTasks(data).filter(t => !t.dueDate).sort(byOrder);
}

function completedTasks(data) {
  return live(data.tasks).filter(t => t.completed)
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
}

// Today's "Coming up": every overdue task and everything due within a week, then later
// tasks only until the list reaches `fill` items. The rest live on the Tasks screen.
function comingUpForToday(data, today, { soonDays = 7, fill = 5 } = {}) {
  const all = datedTasks(data);
  const shown = [];
  for (const t of all) {
    const diff = daysBetween(today, t.dueDate);
    if (diff <= soonDays || shown.length < fill) shown.push(t);
    else break;
  }
  return { items: shown, hidden: all.length - shown.length };
}

// Today's "Ongoing": all pinned undated tasks, then other undated tasks up to `fill` total.
function ongoingForToday(data, { fill = 5 } = {}) {
  const all = ongoingTasks(data);
  const pinned = all.filter(t => t.pinned);
  const rest = all.filter(t => !t.pinned).slice(0, Math.max(0, fill - pinned.length));
  return { items: [...pinned, ...rest], hidden: all.length - pinned.length - rest.length };
}

function goalsForWeek(data, weekStart) {
  return live(data.weeklyGoals).filter(g => g.weekStart === weekStart).sort(byOrder);
}

function pastWeeks(data, currentWeekStart) {
  const weeks = new Map();
  for (const g of live(data.weeklyGoals)) {
    if (g.weekStart >= currentWeekStart) continue;
    if (!weeks.has(g.weekStart)) weeks.set(g.weekStart, []);
    weeks.get(g.weekStart).push(g);
  }
  return [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([weekStart, goals]) => ({ weekStart, goals: goals.sort(byOrder) }));
}

function logForDate(data, date) {
  return live(data.logEntries).filter(e => e.date === date)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

function logDays(data) {
  const days = new Map();
  for (const e of live(data.logEntries)) {
    if (!days.has(e.date)) days.set(e.date, []);
    days.get(e.date).push(e);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => ({ date, entries: entries.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')) }));
}

// ---------- Search ----------
// Every searchable record is normalized to one shape so results of different kinds can be
// listed together and new record types can be added without touching the search UI:
//   { key, type, typeLabel, date, title, secondaryText, status, collection, sourceRecordId, haystack }
function searchIndex(data, today) {
  const out = [];
  const add = (collection, rec, type, typeLabel, date, title, secondaryText, status) => {
    out.push({
      key: `${collection}:${rec.id}`, type, typeLabel, date, title, secondaryText: secondaryText || '',
      status: status || '', collection, sourceRecordId: rec.id, createdAt: rec.createdAt || '',
      haystack: `${title}\n${rec.notes || ''}`.toLowerCase()
    });
  };
  for (const t of live(data.tasks)) {
    if (t.completed) {
      add('tasks', t, 'completed-task', 'Completed task', timestampToKey(t.completedAt || t.updatedAt), t.title, t.notes,
        t.dueDate ? `Was due ${fmtShort(t.dueDate, today)}` : '');
    } else {
      add('tasks', t, 'task', 'Task', timestampToKey(t.createdAt), t.title, t.notes,
        t.dueDate ? urgency(t.dueDate, today).label : 'Ongoing');
    }
  }
  for (const e of live(data.logEntries)) add('logEntries', e, 'log', 'Daily log', e.date, e.text, e.notes);
  for (const r of live(data.routines)) {
    const last = lastRoutineCompletion(data, r.id);
    add('routines', r, 'routine', 'Routine', timestampToKey(r.createdAt), r.title, r.notes,
      `${fmtWeekdays(r.weekdays)}${r.active ? '' : ' · inactive'}${last ? ` · last done ${fmtShort(last, today)}` : ''}`);
  }
  for (const g of live(data.weeklyGoals)) {
    const progress = g.target ? ` · ${g.progress || 0} / ${g.target}` : '';
    add('weeklyGoals', g, 'goal', 'Weekly goal', g.weekStart, g.title, g.notes,
      `Week of ${fmtWeekRange(g.weekStart, today)}${progress}${g.completed ? ' · done' : ''}`);
  }
  return out;
}

// Case-insensitive partial matching; every word in the query must appear somewhere in the
// record's title or notes. Newest first.
function search(data, query, today) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return searchIndex(data, today)
    .filter(r => words.every(w => r.haystack.includes(w)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}
