// ---------- Calendar dates ----------
// A "date key" is a local calendar date as 'YYYY-MM-DD'. All due dates, routine completions,
// log days and week starts are stored this way so a task due Nov 15 stays due Nov 15 no
// matter the timezone. Never parse a date key with new Date('YYYY-MM-DD') — that's UTC
// midnight, which is the previous evening anywhere west of Greenwich.
// Moments in time (createdAt, completedAt, updatedAt) are ISO timestamps instead.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// The local calendar date an ISO timestamp falls on.
function timestampToKey(iso) {
  return dateKey(new Date(iso));
}

function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

// Whole calendar days from a to b (positive when b is later). Computed in UTC so DST
// transitions can't produce 23- or 25-hour "days".
function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

// 1 = Monday … 7 = Sunday (ISO weekday numbering).
function isoWeekday(key) {
  return parseKey(key).getDay() || 7;
}

// Weeks run Monday–Sunday; a week is identified by its Monday's date key.
function weekStartOf(key) {
  return addDays(key, 1 - isoWeekday(key));
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// Human-readable countdown for a due date, plus a level used for styling.
function urgency(dueDate, today) {
  const diff = daysBetween(today, dueDate);
  if (diff < 0) return { label: `Overdue by ${plural(-diff, 'day')}`, level: 'overdue', diff };
  if (diff === 0) return { label: 'Due today', level: 'today', diff };
  if (diff === 1) return { label: 'Due tomorrow', level: 'soon', diff };
  return { label: `${diff} days left`, level: diff <= 7 ? 'soon' : 'later', diff };
}

// 'Wednesday, October 21'
function fmtLong(key) {
  const d = parseKey(key);
  return `${WEEKDAYS_LONG[isoWeekday(key) - 1]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`;
}

// 'Oct 21', or 'Oct 21, 2025' when not in the reference year.
function fmtShort(key, today) {
  const d = parseKey(key);
  const s = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return today && key.slice(0, 4) === today.slice(0, 4) ? s : `${s}, ${d.getFullYear()}`;
}

// 'Oct 19 – 25' or 'Oct 26 – Nov 1'
function fmtWeekRange(weekStart, today) {
  const end = addDays(weekStart, 6);
  const s = parseKey(weekStart), e = parseKey(end);
  const tail = s.getMonth() === e.getMonth() ? `${e.getDate()}` : `${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}`;
  const year = today && weekStart.slice(0, 4) === today.slice(0, 4) ? '' : `, ${e.getFullYear()}`;
  return `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${tail}${year}`;
}

// 'Mon · Wed · Fri', 'Every day', 'Weekdays', 'Weekends'
function fmtWeekdays(days) {
  const set = [...new Set(days)].sort();
  if (set.length === 7) return 'Every day';
  if (set.join() === '1,2,3,4,5') return 'Weekdays';
  if (set.join() === '6,7') return 'Weekends';
  if (!set.length) return 'No days';
  return set.map(d => WEEKDAYS_SHORT[d - 1]).join(' · ');
}
