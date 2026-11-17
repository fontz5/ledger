# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **shipped app** for Ledger, a static task/schedule planner (tasks with subtasks, deadline
calendar, daily time-blocking, recurring routines, events) that runs on GitHub Pages with localStorage
plus optional token-gated Google Sheets sync. Read the repo-root `README.md` for the end-user
deploy/sync instructions.

**The spec, task breakdown, and process for building this app live in a separate sibling repo:
`../ledger-project`** (its `docs/` and `skills/`; the repo this file sits in is `ledger`). This repo does not contain
the design docs — do not invent field names, formulas, colors, or paths here; they come from
`ledger-project/docs/03_DOMAIN_CONSTANTS.md`.

**Do not write or change code here without first loading `ledger-project/skills/dev-workflow/SKILL.md`
(builder) or `ledger-project/skills/task-review/SKILL.md` (reviewer)** and reading
`ledger-project/docs/04_PROGRESS.md` for current status. This project runs a strict spec-first,
one-task-per-session pipeline (`start task X` / `review task X` / etc., defined in that repo's
`README.md`); ad hoc edits outside that process are expected to be rejected by the reviewer gate.

## Commands

- **Serve locally** (ES modules need http, not `file://`):
  ```bash
  python3 -m http.server 8000    # then open http://localhost:8000
  ```
- **Syntax-check a module:**
  ```bash
  node --check js/logic.js       # or state.js / storage.js / app.js
  ```
- **Run the unit tests** (all pure-logic + storage assertions, prints PASS/FAIL per line):
  ```bash
  node test.mjs
  ```
- **Golden-rule grep** (persistence must never leak outside `storage.js`):
  ```bash
  grep -rn "localStorage\|fetch(" js/ | grep -v storage.js   # must return nothing
  ```
- There is no build step, no bundler, no package manager, and no lint config — Node is a dev-only
  tool (syntax check + `test.mjs`); the shipped app is plain ES2019+ JS running directly in the
  browser via native `<script type="module">`.

## Current state of the code

The app is feature-complete through Step 6 and is in Step 7 (polish + acceptance pass). **For exactly
which tasks are done, read `ledger-project/docs/04_PROGRESS.md` — this file does not track status.**
The app is branded **PIN** (D44), but the repo, its storage keys (`ledger.*`) and the docs keep the
name Ledger; the keys are frozen permanently, so never rename them.

- `js/state.js` — `TASK_TYPES`, `PRIORITIES`, `TASK_COLOR_NAMES`, `DEFAULT_COLOR`, `uid()`,
  `makeAppState()`, `makeTask({...})`, `makeSlot({...})`, `migrate()`, `parseImportedState()`.
  Pure; no imports. `AppState` carries `tasks`, `slots`, `prefs` (D45, display preferences) and
  `settings` (the Sheets exec URL + token — browser-only, never synced or exported).
- `js/logic.js` — pure functions only, **no imports/DOM/storage**: the progress/recurrence/overdue
  logic, the time-grid and calendar helpers, `exportState`, `normalizeExecUrl`, and the D47
  completed-task helpers. All take a `tasks` array as a parameter rather than reading global state.
  Recursive ones (`progressOf`, `effectiveDone`, `setDoneCascade`) carry a `seen` cycle guard — never
  remove it.
- `js/storage.js` — the **only** module allowed to touch `localStorage` or `fetch()`. `Store` (with an
  in-memory fallback that wins on read, so a half-broken localStorage does not silently lose data),
  `LocalStorageProvider` (the default; boot always uses it), and `SheetsProvider` (real: token-gated
  `load`/`save`, used only through the Settings tab's explicit Connect / Push / Pull — D43).
  `StorageCorruptError` must never be swallowed; boot surfaces it with an explicit discard recovery.
- `js/app.js` — boot, migration, the shell/nav, and `persistChange` (the one seam views use to save).
  `js/sample-data.js` is a **dev-only** seed, loaded by dynamic import only for `?seed`.
- `js/views/{tasks,deadlines,calendar,settings}.js` — the four tabs. Build DOM with `textContent` /
  `createElement`; the codebase has no `innerHTML` and should keep it that way.
- `css/styles.css`, `index.html`, `manifest.json`, `icons/` — the shell and the Add-to-Home-Screen
  assets. Design tokens come from `03_DOMAIN_CONSTANTS.md` Part B; never invent a hex.
- `apps-script/Code.gs` — the **token-gated** Sheets backend. It reads `TOKEN` from Script Properties
  at request time (never in source), answers `GET` with `{ok:true}` only, rejects an unauthorised or
  malformed request with no data touched, and refuses a save whose `tasks`/`slots` are not arrays.
  The contract is 03 Part C (D26). Changing it means the user must redeploy it in Apps Script.
- `test.mjs` (repo root) — the single suite. Extend it in place when a task adds assertions; don't
  create a second test file. A few checks read the sibling `../ledger-project/docs/` (override with
  `LEDGER_DOCS_03`); on a clone without it they print a `SKIP:` line instead of failing.

## Non-obvious rules that apply to any change here

- Dates: `new Date().toLocaleDateString('en-CA')` for local `YYYY-MM-DD`. Never `toISOString()` for a
  calendar date (it's UTC and will shift the date near midnight).
- Every `Task`/`Slot` record carries `owner: "me"`.
- `done` is meaningful only on a `finite` task; `setDoneCascade` skips routines and events entirely
  (a routine's completion lives only in its `log`, one dated occurrence at a time — never bulk-set).
- No secret (Apps Script URL, token, passphrase) may appear in any committed file — they're entered
  at runtime and stored only in the browser.
