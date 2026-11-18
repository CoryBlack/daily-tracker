// Run with tests/run.sh (uses macOS's built-in JavaScriptCore shell; no Node needed).

// --- Minimal shims for the jsc shell ---
if (typeof console === 'undefined') globalThis.console = { log: print, warn: print };
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class { encode(s) { const b = unescape(encodeURIComponent(s)); return Uint8Array.from(b, c => c.charCodeAt(0)); } };
  globalThis.TextDecoder = class { decode(u) { let s = ''; for (const x of u) s += String.fromCharCode(x); return decodeURIComponent(escape(s)); } };
}

let passed = 0, failed = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print(`FAIL ${name}\n   expected ${e}\n   actual   ${a}`); }
}
function ok(cond, name) { eq(!!cond, true, name); }

// ---------- dates ----------
eq(isoWeekday('2026-10-21'), 3, 'Oct 21 2026 is Wednesday');
eq(isoWeekday('2026-10-25'), 7, 'Sunday is 7');
eq(weekStartOf('2026-10-21'), '2026-10-19', 'week starts Monday');
eq(weekStartOf('2026-10-19'), '2026-10-19', 'Monday is its own week start');
eq(weekStartOf('2026-10-25'), '2026-10-19', 'Sunday belongs to the previous Monday');
eq(weekStartOf('2027-01-01'), '2026-12-28', 'week spanning new year');
eq(addDays('2026-02-28', 1), '2026-03-01', 'month rollover');
eq(addDays('2028-02-28', 1), '2028-02-29', 'leap day');
eq(daysBetween('2026-11-14', '2026-11-15'), 1, 'one day');
eq(daysBetween('2026-03-07', '2026-03-09'), 2, 'across US DST start');
eq(daysBetween('2026-10-31', '2026-11-02'), 2, 'across US DST end');
eq(daysBetween('2026-12-31', '2027-01-01'), 1, 'across year');
eq(urgency('2026-11-15', '2026-11-14').label, 'Due tomorrow', 'tomorrow');
eq(urgency('2026-11-15', '2026-11-15').label, 'Due today', 'today');
eq(urgency('2026-11-15', '2026-11-16').label, 'Overdue by 1 day', 'overdue 1');
eq(urgency('2026-11-15', '2026-11-18').label, 'Overdue by 3 days', 'overdue 3');
eq(urgency('2026-11-15', '2026-10-21').label, '25 days left', '25 days');
eq(urgency('2026-11-15', '2026-11-12').level, 'soon', '3 days is soon');
eq(fmtLong('2026-10-21'), 'Wednesday, October 21', 'long format');
eq(fmtWeekRange('2026-10-26', '2026-10-21'), 'Oct 26 – Nov 1', 'week range across months');
eq(fmtWeekdays([1, 3, 5]), 'Mon · Wed · Fri', 'weekday summary');
eq(fmtWeekdays([1, 2, 3, 4, 5, 6, 7]), 'Every day', 'every day');
eq(timestampToKey(new Date(2026, 9, 21, 23, 59).toISOString()), '2026-10-21', 'late-night timestamp stays on local day');
eq(dateKey(new Date(2026, 9, 21, 0, 1)), '2026-10-21', 'just after midnight');

// ---------- migrate / merge ----------
eq(migrate({}).tasks, [], 'missing collections filled');
let threw = null;
try { migrate({ schemaVersion: 99 }); } catch (e) { threw = e; }
ok(threw instanceof NewerSchemaError, 'newer schema rejected');
threw = null; try { migrate({ tasks: [{ title: 'no id' }] }); } catch (e) { threw = e; } ok(threw, 'record without id rejected');
threw = null; try { migrate([]); } catch (e) { threw = e; } ok(threw, 'array rejected');
threw = null; try { migrate({ tasks: 'x' }); } catch (e) { threw = e; } ok(threw, 'non-list collection rejected');

const T = (id, updatedAt, extra = {}) => ({ id, title: id, updatedAt, createdAt: '2026-10-01T00:00:00.000Z', ...extra });
const A = { ...emptyData(), tasks: [T('a', '2026-10-02T00:00:00.000Z', { title: 'local A' }), T('local-only', '2026-10-02T00:00:00.000Z')] };
const B = { ...emptyData(), tasks: [T('a', '2026-10-01T00:00:00.000Z', { title: 'remote A' }), T('remote-only', '2026-10-01T00:00:00.000Z')], futureKey: 1 };
const M = mergeData(A, B);
eq(M.tasks.map(t => t.id).sort(), ['a', 'local-only', 'remote-only'], 'merge is a union');
eq(M.tasks.find(t => t.id === 'a').title, 'local A', 'newer edit wins');
eq(mergeData(B, A).tasks.find(t => t.id === 'a').title, 'local A', 'newer edit wins regardless of side');
eq(M.futureKey, 1, 'unknown top-level keys preserved');
const tomb = { ...emptyData(), tasks: [T('a', '2026-10-03T00:00:00.000Z', { deletedAt: '2026-10-03T00:00:00.000Z' })] };
ok(mergeData(B, tomb).tasks.find(t => t.id === 'a').deletedAt, 'newer delete wins over older edit');
ok(hasChangesOver(M, B), 'merged has changes over remote');
ok(!hasChangesOver(B, M) === false, 'remote lacks local-only so differs');
ok(!hasChangesOver(M, M), 'identical has no changes');
threw = null; try { assertNoLoss(B, A); } catch (e) { threw = e; } ok(threw, 'assertNoLoss catches a dropped record');

// ---------- queries ----------
const today = '2026-10-21';
const D = emptyData();
const task = (id, extra) => ({ id, title: id, notes: '', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', dueDate: null, completed: false, completedAt: null, pinned: false, order: 0, deletedAt: null, ...extra });
D.tasks.push(
  task('late', { dueDate: '2026-10-19' }),
  task('tomorrow', { dueDate: '2026-10-22' }),
  task('nov15', { dueDate: '2026-11-15' }),
  task('far1', { dueDate: '2027-01-01' }), task('far2', { dueDate: '2027-02-01' }),
  task('far3', { dueDate: '2027-03-01' }), task('far4', { dueDate: '2027-04-01' }),
  task('done', { dueDate: '2026-10-20', completed: true, completedAt: '2026-10-20T15:00:00.000Z' }),
  task('deleted', { dueDate: '2026-10-21', deletedAt: '2026-10-20T00:00:00.000Z' })
);
for (let i = 1; i <= 8; i++) D.tasks.push(task(`o${i}`, { order: i, pinned: i === 7 }));
eq(datedTasks(D).map(t => t.id), ['late', 'tomorrow', 'nov15', 'far1', 'far2', 'far3', 'far4'], 'dated: every open dated task, soonest first');
eq(ongoingTasks(D).map(t => t.id), ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8'], 'undated: all of them, in your order');

// quick dates (today = Wed 2026-10-21)
eq(parseQuickDate('Call shoe factory @tomorrow', today), { title: 'Call shoe factory', dueDate: '2026-10-22' }, '@tomorrow');
eq(parseQuickDate('Pay rent @today', today).dueDate, today, '@today');
eq(parseQuickDate('Gym @Fri', today).dueDate, '2026-10-23', '@fri (case-insensitive)');
eq(parseQuickDate('Gym @wed', today).dueDate, today, '@wed on a Wednesday is today');
eq(parseQuickDate('Gym @tue', today).dueDate, '2026-10-27', '@tue wraps to next week');
eq(parseQuickDate('Plan @nextweek', today).dueDate, '2026-10-26', '@nextweek is next Monday');
eq(parseQuickDate('Cancel card @11/15', today).dueDate, '2026-11-15', '@M/D this year');
eq(parseQuickDate('Taxes @4/15', today).dueDate, '2027-04-15', 'past @M/D rolls to next year');
eq(parseQuickDate('Trip @1/3/28', today).dueDate, '2028-01-03', '@M/D/YY');
eq(parseQuickDate('Bad @2/30', today), { title: 'Bad @2/30', dueDate: null }, 'invalid date left alone');
eq(parseQuickDate('Email bob@example.com', today).dueDate, null, 'email address is not a date');
eq(parseQuickDate('Ask @sam', today), { title: 'Ask @sam', dueDate: null }, 'unknown @word left alone');
eq(parseQuickDate('@tomorrow', today).dueDate, null, 'needs a title before the date');
eq(splitPastedLines('- milk\n\n* eggs\n• bread\n1. jam\n[ ] tea\n[x] done thing\nplain'), ['milk', 'eggs', 'bread', 'jam', 'tea', 'done thing', 'plain'], 'paste split strips bullets');
eq(completedTasks(D).map(t => t.id), ['done'], 'completed list');

D.routines.push(
  { id: 'gym', title: 'Gym', notes: '', active: true, weekdays: [1, 3, 5], order: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null },
  { id: 'stretch', title: 'Stretch', notes: '', active: true, weekdays: [1, 2, 3, 4, 5, 6, 7], order: 2, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null },
  { id: 'talk', title: 'Conversation practice', notes: '', active: true, weekdays: [2, 4], order: 3, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null },
  { id: 'old', title: 'Old', notes: '', active: false, weekdays: [3], order: 4, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null }
);
eq(routinesForWeekday(D, isoWeekday(today)).map(r => r.id), ['gym', 'stretch'], 'Wednesday routines (inactive excluded)');
eq(routinesForWeekday(D, isoWeekday('2026-10-22')).map(r => r.id), ['stretch', 'talk'], 'Thursday routines');
D.routineCompletions.push({ id: completionId('gym', today), routineId: 'gym', date: today, completedAt: '2026-10-21T08:00:00.000Z', updatedAt: '2026-10-21T08:00:00.000Z', deletedAt: null });
ok(isRoutineDone(D, 'gym', today), 'gym done Wednesday');
ok(!isRoutineDone(D, 'gym', '2026-10-23'), 'gym not done Friday — completion is per date');
D.routineCompletions.push({ id: completionId('stretch', today), routineId: 'stretch', date: today, completedAt: 'x', updatedAt: 'x', deletedAt: 'y' });
ok(!isRoutineDone(D, 'stretch', today), 'unchecked (tombstoned) completion is not done');
eq(lastRoutineCompletion(D, 'gym'), today, 'last completion');

const goal = (id, weekStart, extra) => ({ id, title: id, notes: '', weekStart, completed: false, completedAt: null, target: null, progress: 0, order: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null, ...extra });
D.weeklyGoals.push(goal('this', '2026-10-19'), goal('last', '2026-10-12', { completed: true }), goal('older', '2026-10-05'));
eq(goalsForWeek(D, weekStartOf(today)).map(g => g.id), ['this'], 'current week goals');
eq(goalsForWeek(D, weekStartOf('2026-10-26')).map(g => g.id), [], 'new week starts empty');
eq(pastWeeks(D, '2026-10-19').map(w => w.weekStart), ['2026-10-12', '2026-10-05'], 'past weeks newest first');

const log = (id, date, text, createdAt) => ({ id, date, text, notes: '', createdAt, updatedAt: createdAt, deletedAt: null });
D.logEntries.push(
  log('l1', '2026-10-25', 'Applied to Circus Grimaldi', '2026-10-25T20:00:00.000Z'),
  log('l2', '2026-10-29', 'Followed up with Circus Grimaldi', '2026-10-29T20:00:00.000Z'),
  log('l3', '2026-10-20', 'Backfilled yesterday', '2026-10-21T09:00:00.000Z')
);
D.tasks.push(task('grim', { title: 'Apply to Circus Grimaldi', completed: true, completedAt: new Date(2026, 9, 24, 12).toISOString() }));
eq(logForDate(D, '2026-10-20').map(e => e.id), ['l3'], 'backfilled entry lands on its date, not createdAt');
const res = search(D, 'grimaldi', '2026-10-30');
eq(res.map(r => [r.date, r.typeLabel, r.title]), [
  ['2026-10-29', 'Daily log', 'Followed up with Circus Grimaldi'],
  ['2026-10-25', 'Daily log', 'Applied to Circus Grimaldi'],
  ['2026-10-24', 'Completed task', 'Apply to Circus Grimaldi']
], 'search across log + completed tasks, newest first');
eq(search(D, 'CIRCUS grim', today).length, 3, 'multi-word, case-insensitive, partial');
eq(search(D, 'deleted', today).length, 0, 'deleted records not searchable');
eq(search(D, 'conversation', today)[0].type, 'routine', 'routines searchable');
eq(search(D, '   ', today), [], 'blank query');

// ---------- sync against a mock GitHub ----------
function mockGitHub() {
  const gh = { file: null, sha: null, n: 0, puts: 0, failNext: 0, offline: false, staleReads: 0, staleSnapshot: null, repoExists: true, forceBlob: false };
  const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  gh.setFile = text => { gh.file = text; gh.sha = `sha${++gh.n}`; };
  gh.fetch = async (url, init = {}) => {
    if (gh.offline) throw new TypeError('Failed to fetch');
    if (/\/git\/blobs\//.test(url)) return resp(200, { content: b64EncodeUtf8(gh.file), encoding: 'base64' });
    if (/\/repos\/[^/]+\/[^/?]+\?/.test(url)) return resp(gh.repoExists ? 200 : 404, {});
    if (init.method === 'PUT') {
      gh.puts++;
      if (gh.failNext) { gh.failNext--; return resp(500, {}); }
      const body = JSON.parse(init.body);
      if ((body.sha || null) !== gh.sha) return resp(409, {});
      gh.setFile(b64DecodeUtf8(body.content));
      return resp(200, { content: { sha: gh.sha } });
    }
    if (gh.staleReads && gh.staleSnapshot) { gh.staleReads--; return resp(200, gh.staleSnapshot); }
    if (gh.file == null) return resp(404, {});
    if (gh.forceBlob) return resp(200, { sha: gh.sha, content: '', encoding: 'none', size: gh.file.length });
    return resp(200, { sha: gh.sha, content: b64EncodeUtf8(gh.file), encoding: 'base64' });
  };
  return gh;
}

function device(gh, initial) {
  const dev = { data: initial || emptyData(), sha: null, statuses: [] };
  dev.sync = createSync({
    settings: () => ({ ghUser: 'u', ghRepo: 'r', ghBranch: 'main', ghToken: 't' }),
    getData: () => dev.data,
    applyRemote: (d, sha) => { dev.data = mergeData(dev.data, d); dev.sha = sha; },
    getSha: () => dev.sha, setSha: s => { dev.sha = s; },
    status: (k, t) => dev.statuses.push(k),
    fetch: gh.fetch, wait: async () => {}
  });
  dev.edit = (coll, rec) => {
    dev.data = { ...dev.data, [coll]: [...dev.data[coll].filter(r => r.id !== rec.id), { ...rec, updatedAt: new Date(Date.now() + (++clock)).toISOString() }] };
  };
  dev.last = () => dev.statuses[dev.statuses.length - 1];
  return dev;
}
let clock = 0;
const remoteData = gh => JSON.parse(gh.file);
const ids = (d, c = 'tasks') => d[c].map(r => r.id).sort();

async function syncTests() {
  // First connect creates the file.
  let gh = mockGitHub();
  let a = device(gh);
  a.edit('tasks', task('t1'));
  await a.sync.pull();
  eq(ids(remoteData(gh)), ['t1'], 'first sync creates data.json');
  eq(a.last(), 'ok', 'status ok');

  // Second device with empty cache pulls; does not wipe remote.
  let b = device(gh);
  await b.sync.pull();
  eq(ids(b.data), ['t1'], 'empty device pulls remote');
  eq(ids(remoteData(gh)), ['t1'], 'empty device did not overwrite remote');

  // Concurrent edits on two devices both survive (conflict → merge → retry).
  a.edit('tasks', task('fromA'));
  b.edit('tasks', task('fromB'));
  await a.sync.push();
  await b.sync.push();                   // b's lastSha is stale → 409 → fetch+merge
  eq(ids(remoteData(gh)), ['fromA', 'fromB', 't1'], 'concurrent edits both kept');
  await a.sync.pull();
  eq(ids(a.data), ['fromA', 'fromB', 't1'], 'other device sees merged result');

  // Same record edited on both: newest wins; delete propagates as tombstone.
  a.edit('tasks', task('t1', { title: 'older edit' }));
  b.edit('tasks', task('t1', { title: 'newer edit' }));
  await b.sync.push(); await a.sync.push(); await b.sync.pull();
  eq(remoteData(gh).tasks.find(t => t.id === 't1').title, 'newer edit', 'newest edit wins even if pushed first');
  b.edit('tasks', task('fromA', { deletedAt: nowIso() }));
  await b.sync.push(); await a.sync.pull();
  ok(a.data.tasks.find(t => t.id === 'fromA').deletedAt, 'deletion syncs as tombstone');

  // Offline: local edits kept, pushed later.
  gh.offline = true;
  a.edit('tasks', task('offline1'));
  await a.sync.push();
  eq(a.last(), 'offline', 'offline status');
  ok(!ids(remoteData(gh)).includes('offline1'), 'nothing written while offline');
  gh.offline = false;
  await a.sync.pull();
  ok(ids(remoteData(gh)).includes('offline1'), 'offline edit pushed on reconnect');

  // Server error mid-write: nothing lost, retry succeeds.
  gh.failNext = 2;                        // fast-path write and the fallback write both fail
  a.edit('tasks', task('after500'));
  await a.sync.push();
  ok(!ids(remoteData(gh)).includes('after500'), 'failed write did not land');
  ok(ids(a.data).includes('after500'), 'failed write kept locally');
  await a.sync.push();
  ok(ids(remoteData(gh)).includes('after500'), 'retry lands it');

  // Stale read right after a write (GitHub eventual consistency): still converges, no loss.
  const before = ids(remoteData(gh));
  gh.staleSnapshot = { sha: 'sha-stale', content: b64EncodeUtf8(JSON.stringify(emptyData())), encoding: 'base64' };
  gh.staleReads = 1;
  b.edit('tasks', task('afterStale'));
  b.sha = 'bogus';                       // force the fetch path
  await b.sync.push();
  const after = ids(remoteData(gh));
  ok(before.every(id => after.includes(id)) && after.includes('afterStale'), 'stale read caused no loss');

  // Corrupt remote: refuse to write anything.
  const good = gh.file;
  gh.setFile('{"tasks": [ broken');
  a.edit('tasks', task('whileCorrupt'));
  a.sha = null;
  await a.sync.pull();
  eq(a.last(), 'error', 'corrupt remote reported');
  eq(gh.file, '{"tasks": [ broken', 'corrupt remote left untouched');
  ok(ids(a.data).includes('t1'), 'local data intact after corrupt remote');

  // Remote written by a newer schema: refuse to write.
  gh.setFile(JSON.stringify({ ...JSON.parse(good), schemaVersion: 99 }));
  const newer = gh.file;
  await a.sync.push();
  eq(gh.file, newer, 'newer-schema remote left untouched');

  // Large file (>1 MB) comes back without inline content: must use the blob, not treat as empty.
  gh.setFile(good);
  gh.forceBlob = true;
  let c = device(gh);
  await c.sync.pull();
  ok(ids(c.data).includes('t1'), 'large file read via blob API');
  eq(ids(remoteData(gh)), ids(JSON.parse(good)), 'large file not overwritten');
  gh.forceBlob = false;

  // Repo missing / no access: never "create" data, report config error.
  gh = mockGitHub(); gh.repoExists = false;
  a = device(gh); a.edit('tasks', task('x'));
  await a.sync.pull();
  eq(a.last(), 'error', 'missing repo is an error');
  eq(gh.puts, 0, 'no write attempted to a missing repo');

  // Rapid pushes coalesce and never lose edits.
  gh = mockGitHub();
  a = device(gh);
  await a.sync.pull();
  const runs = [];
  for (let i = 0; i < 5; i++) { a.edit('tasks', task(`rapid${i}`)); runs.push(a.sync.push()); }
  await Promise.all(runs);
  await a.sync.push();
  eq(ids(remoteData(gh)).length, 5, 'rapid edits all synced');
  ok(gh.puts <= 4, `rapid pushes coalesced (${gh.puts} writes)`);

  // A device with no unsynced edits never writes (no empty commits on every app switch),
  // and a pull with nothing new doesn't write either.
  const putsBefore = gh.puts;
  let clean = device(gh);
  await clean.sync.pull();
  clean.isDirty = false;
  const cleanSync = createSync({
    settings: () => ({ ghUser: 'u', ghRepo: 'r', ghToken: 't' }), getData: () => clean.data,
    applyRemote: () => {}, getSha: () => clean.sha, status: () => {}, isDirty: () => false, fetch: gh.fetch
  });
  await cleanSync.push();
  await cleanSync.pull();
  eq(gh.puts, putsBefore, 'clean device and no-op pull write nothing');
}

syncTests().then(() => {
  print(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error('tests failed');
}, e => { print('CRASH', e, e.stack); throw e; });
