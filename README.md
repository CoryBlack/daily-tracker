# Daily

A personal to-do / routine / weekly-goal app with a daily log. It opens straight to your
**Tasks**, a notepad-style list you can type into directly, with anything time-sensitive
pinned to the top.

Same setup as the workout and juggling apps: a static web app on GitHub Pages, installed to
the iPhone home screen as a PWA, with your data stored in a private GitHub repo.

## Screens

- **Tasks** (opens first): **Time-sensitive** lists every task with a due date, soonest first
  (overdue tasks are highlighted). **To do** lists everything else in your own order. Each line
  works like a notepad:
  - Tap a task to edit its text. **Enter** starts a new line below it, and **Backspace** on an
    empty line deletes it (with Undo). Clearing a line's text also deletes it.
  - The **Add a task** line at the bottom stays ready, so you can type several in a row.
    Pasting a multi-line list makes one task per line (bullets and `[ ]` are stripped).
  - Drag the grip (=) to reorder.
  - End a line with `@today`, `@tomorrow`, `@fri`, `@nextweek` or `@12/3` to give it a due
    date, or tap the calendar button for the due date, notes and delete.
  - **Completed (n)** at the bottom shows the history.
- **Routines**: today's checklist (tick them off), what each weekday looks like, and the list
  of routines. Pausing a routine hides it but keeps its history.
- **Weekly**: this week's goals (tap the `1/3` counter to add progress) and previous weeks.
- **Log**: a one-line quick add for today, plus every earlier day.
- **Search** (magnifier): searches everything, including completed tasks, past weeks and the
  log. Results are newest first.
- **+**: add a task (with a date picker), routine, weekly goal or log entry.

## Setup

1. **Repos**: `daily-tracker` (public, this code, served by Pages) and `daily-data`
   (private, holds only `data.json`; the app creates it on first sync).
2. **Token**: GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   Repository access: *Only select repositories* → `daily-data`. Permissions:
   **Contents → Read and write**. (You can instead add `daily-data` to an existing
   fine-grained token's repo list.)
3. **Install**: open `https://coryblack.github.io/daily-tracker/` in Safari → Share →
   **Add to Home Screen**.
4. **Connect**: tap the settings icon (top right) and enter username `CoryBlack`, repo
   `daily-data`, branch `main`, and the token. Tap **Save & sync**. The dot on the settings
   icon turns green.

Settings → **Load sample data** adds example records (flagged, removable with one tap).

## How data is stored

`data.json` is one document with a `schemaVersion` and five lists: `tasks`, `routines`,
`routineCompletions`, `weeklyGoals`, `logEntries`. See the comment at the top of
`js/model.js` for every field.

- **IDs and dates**: every record has a stable UUID, plus `createdAt` and `updatedAt`
  timestamps. Calendar dates (`dueDate`, log `date`, routine completion `date`, goal
  `weekStart`) are local `YYYY-MM-DD` strings, so a task due Nov 15 stays due Nov 15.
- **History is kept**: completing a task keeps it with `completedAt`. Routine completions
  are one record per routine per day (`routineId@date`). Past weeks' goals remain. Deleting
  sets `deletedAt` (hidden everywhere, undoable) instead of removing the record.
- **Migrations**: bump `SCHEMA_VERSION` in `js/model.js` and add a step in `migrate()`.
  An older copy of the app refuses to write data that a newer version produced.

## How sync stays safe

The browser keeps a full copy, so the app opens instantly and works offline. Edits are
batched and pushed about a second later. Changes from other devices are pulled whenever
the app is opened or brought back to the foreground.

Sync never replaces one copy with the other wholesale:

- **Record-level merge**: local and GitHub copies are merged by record id. The newer
  `updatedAt` wins, and nothing that exists in either copy is dropped. Two devices editing
  at once, or a device that was offline for a week, both converge without losing edits.
- **Conflict detection**: writes carry the file's last-known SHA. If anything else wrote
  in between, GitHub rejects the write and the app re-fetches, re-merges and retries.
- **Refuses to write when unsure**: it never writes if the GitHub copy is unreadable or
  malformed, if it comes from a newer schema, or if the repo isn't reachable. A pre-write
  check confirms no record from GitHub would be lost. Files over 1 MB are read through the
  blob API, so they can't be misread as empty.
- **Version history**: every write is a commit in `daily-data`, so any earlier state can be
  recovered from git history.

## Development

No build step. Serve the folder (`python3 -m http.server`) and open it.

- `tests/run.sh` runs the date, model, search and sync tests with macOS's built-in
  JavaScriptCore (no Node needed). The sync tests use a mock GitHub that simulates
  conflicts, stale reads, offline, server errors, oversized files, corrupt data and newer
  schemas. Run with different `TZ=` values to check timezone handling.
- Add `?today=2026-11-15` to the URL to simulate another date (a banner shows when active).
  Use it with sample data, not your real data, since ticking things records them on that date.
- Bump `CACHE` in `sw.js` when deploying changes so installed copies update.
