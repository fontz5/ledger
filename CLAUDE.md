# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **shipped app** for Ledger, a static task/schedule planner (tasks with subtasks, deadline
calendar, daily time-blocking, recurring routines, events) that runs on GitHub Pages with localStorage
plus optional token-gated Google Sheets sync. Read the repo-root `README.md` for the end-user
deploy/sync instructions.

**The spec, task breakdown, and process for building this app live in a separate sibling repo:
`../ledger-project`** (its `docs/` and `skills/`). This repo does not contain
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

## Current state of the code (Step 1 — data & storage foundation, in progress)

Only the data layer exists so far; there is no UI wiring yet (`js/app.js` and `js/views/*` are not
built). What's here:

- `js/state.js` — `TASK_TYPES`, `PRIORITIES`, `TASK_COLOR_NAMES`, `DEFAULT_COLOR`, `uid()`,
  `makeAppState()`, `makeTask({...})`, `makeSlot({...})`. Pure factories; no imports.
- `js/logic.js` — pure functions only, **no imports/DOM/storage**: `childrenOf`, `expandOccurrences`,
  `occurrenceStatus`, `progressOf`, `breakdownOf`, `effectiveDone`, `completionState`,
  `setDoneCascade`. All take a `tasks` array as a parameter rather than reading global state, which is
  what makes them unit-testable in isolation. Recursive ones (`progressOf`, `effectiveDone`,
  `setDoneCascade`) carry a `seen` cycle guard — never remove it.
- `js/storage.js` — the **only** module allowed to touch `localStorage` or `fetch()`. Exports
  `STORAGE_KEY` (`"ledger.state"`), `CORRUPT_SUFFIX`, `StorageCorruptError`, `Store` (get/set with an
  in-memory `_mem` fallback that wins on read, so a half-broken localStorage — quota exceeded, Safari
  private mode — doesn't silently lose data), `StorageProvider` (base class:
  `authenticate`/`load`/`save`, all throw `"not implemented"`), `LocalStorageProvider` (the working
  default), and `SheetsProvider` (a stub — every method throws `"deferred to Step 6"`; do not
  implement real network I/O against it yet).
- `test.mjs` (repo root) — imports directly from `js/*.js` and asserts against the canonical worked
  examples (e.g. `progressOf` → 67 / 25 / 50, `expandOccurrences` → 16 Mondays, `progressOf(event)` →
  `null`). Extend it in place when a task adds new assertions; don't create a second test file.
- `index.html`, `apps-script/Code.gs` — **pre-existing v1 draft**, predates the locked v2 model.
  `index.html` is single-file HTML/CSS/JS with a different (v1) data shape; keep it only as a
  reference until Step 2 re-skins the UI on the new model. **`apps-script/Code.gs` is a known-insecure
  placeholder** — it has no token check and is deployed as a public "Anyone" endpoint; it is rewritten
  in Step 6 against `03_DOMAIN_CONSTANTS.md` Part C's contract. Do not treat either file as a spec for
  new work; the docs repo is the spec.

Not yet built: `css/styles.css`, `js/views/{tasks,calendar,planner}.js`, `js/app.js` (boot/migration
wiring), `js/sample-data.js`. See `ledger-project/docs/02_TECH_STACK.md` for the full locked folder
layout these will land in.

## Non-obvious rules that apply to any change here

- Dates: `new Date().toLocaleDateString('en-CA')` for local `YYYY-MM-DD`. Never `toISOString()` for a
  calendar date (it's UTC and will shift the date near midnight).
- Every `Task`/`Slot` record carries `owner: "me"`.
- `done` is meaningful only on a `finite` task; `setDoneCascade` skips routines and events entirely
  (a routine's completion lives only in its `log`, one dated occurrence at a time — never bulk-set).
- No secret (Apps Script URL, token, passphrase) may appear in any committed file — they're entered
  at runtime and stored only in the browser.
