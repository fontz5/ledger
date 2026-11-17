// Settings/Sync view — docs/05_TASKS_STEP6.md Module U, tasks 6.U1 + 6.U2 (D43, D16).
// New fourth nav tab: a local-only connect form plus manual Push/Pull for Sheets sync. Every
// mutation to `state.settings.sheetUrl`/`.token`/`.tasks`/`.slots` goes through the same
// onChange/persistChange seam every other view uses (golden rule 4) — this module calls
// `provider.authenticate()`/`.save()`/`.load()` only; the network call itself stays inside
// `SheetsProvider`.
//
// Task 7.U3 (D45) adds the "Day markers" picker: the marker-mode toggle plus one emoji field per
// palette category, writing `state.prefs` through that same `onChange` seam. `prefs` is NOT part
// of any sync payload (D45: local in Step 7, Step 8 teaches sync to carry it), so Push still
// sends exactly {version,tasks,slots} and Pull still preserves local `prefs` via its spread.
//
// Task 7.U5 relaxes the exec-URL field: it now accepts either the full Apps Script `/exec` URL or
// the bare deployment id inside it, normalising through 7.U5's pure `normalizeExecUrl` (logic.js)
// before anything is stored, plus a feature-detected Paste button. The stored value is always the
// canonical URL, so `connect()` and `SheetsProvider` are untouched by this task.
//
// Task 7.X2 adds the "Your data" form: Export (writes `exportState(state)` to a file) and Import
// (reads a picked file and routes it through `parseImportedState`). Both pure functions are 7.X1's;
// this module only supplies the browser plumbing and the error/confirm affordances.

import { SheetsProvider } from "../storage.js";
import { migrate, parseImportedState, TASK_COLOR_NAMES, TASK_COLORS } from "../state.js";
import { exportState, normalizeExecUrl } from "../logic.js";
import { appendField, labelledInput } from "./tasks.js";

let _pane = null;
let _state = null;
let _onChange = () => {};
let _onStateReplaced = () => {};
let _confirm = () => true;
let _statusEl = null;
let _pushBtn = null;
let _pullBtn = null;
let _pushStatusEl = null;
let _pullStatusEl = null;
let _exportStatusEl = null;
let _importStatusEl = null;
let _provider = null; // the connected SheetsProvider instance, set once authenticate() succeeds
let _urlInput = null;   // 7.U5: the exec-URL/deployment-id field, so the Paste button can write it
let _urlHintEl = null;  // 7.U5: the normaliser's accept/reject line, reusing .settings-status

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "settings-status" + (kind ? ` ${kind}` : "");
}

// --- 7.U5: exec-URL entry -----------------------------------------------------------------
// Sub-step 3. `text` is what the user actually typed or pasted; `normalizeExecUrl` (7.U5, pure)
// decides whether it resolves to a deployment. When it does, the CANONICAL url is what gets
// stored — never the raw text — so `connect()` always hands `SheetsProvider` a real endpoint.
// When it does not, the raw text is stored unchanged: fabricating a URL from unrecognised input
// would fail later at Connect with a misleading error (03 Part C, "Exec URL shape").
//
// `settled` separates the two callers. On every keystroke (`input`) it is false: the value is
// kept current but a half-typed id is not scolded mid-word, so only the success line shows. On
// blur (`change`) and on Paste it is true: the field is rewritten to the canonical URL so the
// user can see what was stored, and a rejection is stated.
function applyExecUrl(text, settled) {
  const res = normalizeExecUrl(text);
  _state.settings.sheetUrl = res.ok ? res.url : text;
  if (res.ok) {
    if (settled) _urlInput.value = res.url;
    setStatus(_urlHintEl, "Saved as the full exec URL.", "ok");
  } else if (settled && text.trim() !== "") {
    setStatus(_urlHintEl, res.error, "error");
  } else {
    setStatus(_urlHintEl, "", "");
  }
  _onChange(_state);
}

// Sub-step 4. Feature-detected at RENDER time: where `navigator.clipboard.readText` is missing —
// every non-secure context, and any browser without the async clipboard API — no button is drawn
// at all and the typed field is the whole story. That absence IS the graceful degradation; there
// is no path here that assumes the clipboard exists.
function hasClipboardRead() {
  return (
    typeof navigator !== "undefined" &&
    navigator.clipboard != null &&
    typeof navigator.clipboard.readText === "function"
  );
}

async function pasteExecUrl() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    // Permission refused, or the browser only grants the clipboard inside a user gesture it did
    // not recognise. Say what happened and what to do (03 Part B, "Tone of UI copy").
    setStatus(_urlHintEl, "Could not read the clipboard — paste into the field instead.", "error");
    return;
  }
  applyExecUrl(text, true);
}

async function connect() {
  setStatus(_statusEl, "Connecting…", "");
  const provider = new SheetsProvider({
    execUrl: _state.settings.sheetUrl,
    token: _state.settings.token,
  });
  const ok = await provider.authenticate();
  if (ok) {
    _provider = provider;
    _pushBtn.disabled = false;
    _pullBtn.disabled = false;
    setStatus(_statusEl, "Connected.", "ok");
  } else {
    setStatus(_statusEl, "Could not connect — check the exec URL and token.", "error");
  }
}

// 6.U2 sub-step 1: confirm (destructive to the Sheet's current contents, D16 last-write-wins),
// then push exactly {version,tasks,slots} — never `settings` (D26 rule 4 / D43).
async function push() {
  if (!_provider) return; // defense in depth on top of the disabled attribute
  if (!_confirm("This will overwrite the Sheet's current contents with your local data. Continue?")) {
    return;
  }
  setStatus(_pushStatusEl, "Pushing…", "");
  try {
    await _provider.save({ version: _state.version, tasks: _state.tasks, slots: _state.slots });
    setStatus(_pushStatusEl, `Pushed — last pushed ${new Date().toLocaleTimeString()}.`, "ok");
  } catch (e) {
    setStatus(_pushStatusEl, `Push failed: ${e.message}`, "error");
  }
}

// 6.U2 sub-step 2: confirm (destructive to unsaved LOCAL edits), pull, migrate() the result
// (exercises 6.C2's string-version guard on the real Pull path), then merge into a full
// AppState that keeps LOCAL settings untouched (Sheets never returns settings) while replacing
// tasks/slots/version, and persist through the same onChange seam every other view uses.
async function pull() {
  if (!_provider) return;
  if (!_confirm("This will overwrite unsaved local changes with the Sheet's data. Continue?")) {
    return;
  }
  setStatus(_pullStatusEl, "Pulling…", "");
  try {
    const raw = await _provider.load();
    const merged = migrate({ ..._state, version: raw.version, tasks: raw.tasks, slots: raw.slots });
    _state = merged;
    _onChange(_state);
    _onStateReplaced(_state); // 6.U-INT wires this to re-rendering the shell's current view
    setStatus(_pullStatusEl, "Pulled — local data replaced with the Sheet's.", "ok");
  } catch (e) {
    setStatus(_pullStatusEl, `Pull failed: ${e.message}`, "error");
  }
}

// --- 7.U3 sub-step 4: the marker picker ---------------------------------------------------
// Writes go through `setPrefs`, which REPLACES `prefs` (and `prefs.emoji`) instead of mutating
// them in place: `migrate()` shallow-copies `prefs`, so the stored blob's nested `emoji` object
// can be shared by reference (the 7.U2 review's watch-item) and writing through it would edit a
// neighbour's object. The literal defaults live in 03 Part A / `makeAppState()` — nothing here
// re-declares them; a missing `prefs` is simply read as "no preference yet".
function setPrefs(patch) {
  _state.prefs = { ..._state.prefs, ...patch };
  _onChange(_state);
}

function setCategoryEmoji(name, glyph) {
  const current = (_state.prefs && _state.prefs.emoji) || {};
  setPrefs({ emoji: { ...current, [name]: glyph } });
}

function renderMarkerPicker(parent) {
  const prefs = _state.prefs || {};
  const mode = prefs.marker === "emoji" ? "emoji" : "color";
  const map = prefs.emoji || {};

  const form = document.createElement("form");
  form.className = "settings-form settings-markers";
  form.addEventListener("submit", (e) => e.preventDefault());

  const heading = document.createElement("h2");
  heading.className = "settings-heading";
  heading.textContent = "Day markers";
  form.appendChild(heading);

  const modeSelect = document.createElement("select");
  modeSelect.className = "form-control"; // carries 03 Part B's 16px input floor
  for (const [value, label] of [["color", "Colour dots"], ["emoji", "Emoji"]]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    modeSelect.appendChild(opt);
  }
  modeSelect.value = mode;
  modeSelect.addEventListener("change", () => {
    setPrefs({ marker: modeSelect.value });
  });
  appendField(form, "Month grid marker", modeSelect);

  // One field per palette category — the 8 names come from state.js, never re-typed here, and
  // each row's swatch is painted from TASK_COLORS so the user can see which category they are
  // mapping. An empty field means "no glyph": markerFor falls back to the colour for it.
  for (const name of TASK_COLOR_NAMES) {
    const row = document.createElement("div");
    row.className = "settings-emoji-row";

    const swatch = document.createElement("span");
    swatch.className = "settings-emoji-swatch";
    swatch.style.background = TASK_COLORS[name].solid;
    swatch.setAttribute("aria-hidden", "true");
    row.appendChild(swatch);

    const input = document.createElement("input");
    input.className = "form-control settings-emoji-input";
    input.type = "text";
    input.value = map[name] || "";
    input.dataset.category = name;
    input.setAttribute("aria-label", `${name} emoji`);
    input.addEventListener("input", () => {
      setCategoryEmoji(name, input.value.trim());
    });
    row.appendChild(input);

    appendField(form, name, row);
  }

  parent.appendChild(form);
}

// --- 7.X2: Export / Import controls (D43 made Settings the data-management tab) ------------
// Export hands `exportState(_state)` (7.X1 — secrets are excluded THERE, golden rule 6) to the
// browser through a transient object-URL anchor. Import reads the picked file as text and routes
// it through `parseImportedState` (7.X1), which validates + migrates or throws; a throw shows the
// existing `.settings-status` error state and replaces nothing.
//
// Task 7.X-INT closes the seam 7.X2 deliberately left open: a confirmed import now goes through
// the same `_onChange` (persistence) and `_onStateReplaced` (shell re-render) pair Pull already
// uses, so an import survives a reload and the pane the user is looking at is rebuilt from the
// imported state.

// `en-CA` is the locale that formats as local YYYY-MM-DD. Never `toISOString()`: that is UTC and
// would name yesterday's file for anyone exporting near midnight.
function exportFilename(now = new Date()) {
  return `pin-export-${now.toLocaleDateString("en-CA")}.json`;
}

function downloadExport() {
  const name = exportFilename();
  const url = URL.createObjectURL(new Blob([exportState(_state)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  _pane.appendChild(a); // some browsers only honour `download` on a connected anchor
  a.click();
  _pane.removeChild(a);
  // Revoked on the next macrotask rather than synchronously: revoking inside the same task as the
  // click has been known to cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(_exportStatusEl, `Exported ${name}.`, "ok");
}

async function importFile(file) {
  if (!file) return;
  let imported;
  try {
    imported = parseImportedState(await file.text());
  } catch (e) {
    // D26 rule 2's non-destructive instinct, as 7.X1 sub-step 3 states it: a malformed import
    // must never be able to touch the user's data.
    setStatus(_importStatusEl, `Import failed: ${e.message}`, "error");
    return;
  }
  // Validated BEFORE the confirm, so an unreadable file never asks the user a destructive
  // question. The confirm itself is the same injectable seam Push/Pull already use.
  if (!_confirm("This will replace your local tasks and schedule with the file's contents. Continue?")) {
    setStatus(_importStatusEl, "Import cancelled — nothing was changed.", "");
    return;
  }
  // Take the records (and the D45 `prefs` the export carries) off the parsed state and KEEP the
  // live local-only `settings`: `parseImportedState` returns a full AppState whose settings are
  // the empty defaults, so spreading it wholesale would blank a configured exec URL/token.
  _state.version = imported.version;
  _state.tasks = imported.tasks;
  _state.slots = imported.slots;
  _state.prefs = imported.prefs;
  // 7.X-INT sub-step 1: the SAME ordered pair pull() uses. `_onChange` first, so the shell's own
  // `getState()` already holds the imported state by the time it re-mounts; `_onStateReplaced`
  // second, to rebuild this pane (the import replaced `prefs`, so 7.U3's marker picker would
  // otherwise keep rendering the pre-import mapping). The status line is set AFTER both, because
  // the re-render replaces `_importStatusEl` — writing it first would discard the message.
  _onChange(_state);
  _onStateReplaced(_state);
  setStatus(
    _importStatusEl,
    `Imported ${imported.tasks.length} task(s) and ${imported.slots.length} slot(s).`,
    "ok"
  );
}

// No new hex and no new geometry: this reuses .settings-form / .settings-heading / .form-field /
// .form-control / .btn / .settings-status exactly as the sync form and the marker picker do.
function renderDataControls(parent) {
  const form = document.createElement("form");
  form.className = "settings-form settings-data";
  form.addEventListener("submit", (e) => e.preventDefault());

  const heading = document.createElement("h2");
  heading.className = "settings-heading";
  heading.textContent = "Your data";
  form.appendChild(heading);

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "btn ghost";
  exportBtn.textContent = "Export to a file";
  exportBtn.addEventListener("click", () => {
    downloadExport();
  });
  form.appendChild(exportBtn);

  _exportStatusEl = document.createElement("p");
  _exportStatusEl.className = "settings-status";
  _exportStatusEl.setAttribute("aria-live", "polite");
  form.appendChild(_exportStatusEl);

  const fileInput = document.createElement("input");
  fileInput.className = "form-control";
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // so re-picking the same file fires `change` again
    importFile(file);
  });
  appendField(form, "Import from a file", fileInput);

  _importStatusEl = document.createElement("p");
  _importStatusEl.className = "settings-status";
  _importStatusEl.setAttribute("aria-live", "polite");
  form.appendChild(_importStatusEl);

  parent.appendChild(form);
}

function render() {
  _pane.textContent = "";
  const inner = document.createElement("div");
  inner.className = "pane-inner settings-view";

  const form = document.createElement("form");
  form.className = "settings-form";
  form.addEventListener("submit", (e) => e.preventDefault());

  // 7.U5: the label names both accepted forms, and the type is "text" rather than "url" — a bare
  // deployment id is not a URL, so "url" would mark a perfectly good id invalid and offer a phone
  // keyboard with a ".com" key. The four attributes below are what keep an id survivable on a
  // phone: autocapitalise would upper-case its first character and autocorrect would rewrite it.
  // The field is rendered from the STORED value verbatim — an exec URL saved before this task is
  // shown and used exactly as it was, and is never rewritten on mount (03 Part C: no migration).
  _urlInput = labelledInput(form, "Deployment ID or exec URL", "text", _state.settings.sheetUrl || "");
  _urlInput.setAttribute("autocapitalize", "none");
  _urlInput.setAttribute("autocorrect", "off");
  _urlInput.setAttribute("spellcheck", "false");
  _urlInput.setAttribute("inputmode", "url");
  _urlInput.addEventListener("input", () => {
    applyExecUrl(_urlInput.value, false);
  });
  _urlInput.addEventListener("change", () => {
    applyExecUrl(_urlInput.value, true);
  });

  _urlHintEl = document.createElement("p");
  _urlHintEl.className = "settings-status";
  _urlHintEl.setAttribute("aria-live", "polite");
  form.appendChild(_urlHintEl);

  // No new class and no new hex: the Paste button reuses .btn.ghost inside the same flex row the
  // Push/Pull pair already uses.
  if (hasClipboardRead()) {
    const pasteRow = document.createElement("div");
    pasteRow.className = "settings-sync-row";
    const pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.className = "btn ghost";
    pasteBtn.textContent = "Paste";
    pasteBtn.addEventListener("click", () => {
      pasteExecUrl();
    });
    pasteRow.appendChild(pasteBtn);
    form.appendChild(pasteRow);
  }

  const tokenInput = labelledInput(form, "Token", "password", _state.settings.token || "");
  tokenInput.addEventListener("input", () => {
    _state.settings.token = tokenInput.value;
    _onChange(_state);
  });

  const connectBtn = document.createElement("button");
  connectBtn.type = "button";
  connectBtn.className = "btn";
  connectBtn.textContent = "Connect";
  connectBtn.addEventListener("click", () => {
    connect();
  });
  form.appendChild(connectBtn);

  _statusEl = document.createElement("p");
  _statusEl.className = "settings-status";
  _statusEl.setAttribute("aria-live", "polite");
  form.appendChild(_statusEl);

  const syncRow = document.createElement("div");
  syncRow.className = "settings-sync-row";

  _pushBtn = document.createElement("button");
  _pushBtn.type = "button";
  _pushBtn.className = "btn ghost";
  _pushBtn.textContent = "Push";
  _pushBtn.disabled = !_provider; // 6.U2 sub-step 3: disabled until authenticate() has succeeded
  _pushBtn.addEventListener("click", () => {
    push();
  });
  syncRow.appendChild(_pushBtn);

  _pullBtn = document.createElement("button");
  _pullBtn.type = "button";
  _pullBtn.className = "btn ghost";
  _pullBtn.textContent = "Pull";
  _pullBtn.disabled = !_provider;
  _pullBtn.addEventListener("click", () => {
    pull();
  });
  syncRow.appendChild(_pullBtn);

  form.appendChild(syncRow);

  _pushStatusEl = document.createElement("p");
  _pushStatusEl.className = "settings-status";
  _pushStatusEl.setAttribute("aria-live", "polite");
  form.appendChild(_pushStatusEl);

  _pullStatusEl = document.createElement("p");
  _pullStatusEl.className = "settings-status";
  _pullStatusEl.setAttribute("aria-live", "polite");
  form.appendChild(_pullStatusEl);

  inner.appendChild(form);
  renderMarkerPicker(inner); // 7.U3: its own form, below the sync one
  renderDataControls(inner); // 7.X2: Export/Import, last (the destructive one)
  _pane.appendChild(inner);
}

// Mounts the Settings/Sync view into `pane` for `state`. `opts.onChange(state)` is the
// persistence seam (js/app.js wires it to persistChange, matching every other view).
// `opts.onStateReplaced(state)` fires after a successful Pull or Import; js/app.js wires it to
// re-mounting the current view (7.X-INT).
// `opts.confirm(message)` is injectable (defaults to `window.confirm`) so Push/Pull and 7.X2's
// Import are testable headlessly, mirroring `app.js` `boot()`'s own `confirmOverwrite` convention.
export function mountSettingsView(pane, state, opts = {}) {
  _pane = pane;
  _state = state;
  _onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
  _onStateReplaced = typeof opts.onStateReplaced === "function" ? opts.onStateReplaced : () => {};
  _confirm =
    typeof opts.confirm === "function"
      ? opts.confirm
      : (msg) => (typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(msg) : true);
  render();
  return {};
}
