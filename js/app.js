// Boot + render wiring (Ledger v2) — docs/05_TASKS_STEP1.md §1.INT + 05_TASKS_STEP2.md §2.U1.
// Ties 1.1-1.4 together behind the storage interface, then (browser only) mounts the shell:
// nav switching between Tasks and the two placeholder panes, plus the global add control.
// This module touches no browser storage or network directly; all persistence goes through
// js/storage.js (golden rule 4).

import { LocalStorageProvider } from "./storage.js";
import { migrate } from "./state.js";
import { sampleState } from "./sample-data.js";
import { mountTasksView } from "./views/tasks.js";

let state = null;
let provider = null;

export function isEmptyState(s) {
  return s.tasks.length === 0 && s.slots.length === 0;
}

// `search` is a location.search-shaped string, e.g. "?seed=1". Leading "?" is optional.
export function shouldLoadSeed(search) {
  return new URLSearchParams(search).get("seed") === "1";
}

// Boot: instantiate the provider, load (D29 adoption happens inside provider.load()),
// re-run migrate as a harmless idempotent safety net, persist an adopted state exactly once,
// then apply the dev-only seed trigger. Never swallows StorageCorruptError — a corrupt
// STORAGE_KEY throws out of provider.load() and this function does not catch it.
export async function boot({
  search = "",
  confirmOverwrite = () => false,
  provider: injectedProvider,
} = {}) {
  provider = injectedProvider ?? new LocalStorageProvider();

  state = migrate(await provider.load());
  if (provider.adopted) {
    await saveState(); // persist the newly-adopted v1->v2 state exactly once
  }

  if (shouldLoadSeed(search)) {
    if (isEmptyState(state) || confirmOverwrite(state)) {
      state = sampleState();
      await saveState();
    }
    // else: refuse silently and keep the existing (non-empty, unconfirmed) state.
  }

  return state;
}

export function getState() {
  return state;
}

// The persistence seam mountTasksView calls after every UI mutation (add/edit/delete/check/
// colour) — the sole path into saveState() from view code (golden rule 4). Fire-and-forget:
// the view already re-renders itself from its own held, already-mutated state
// (js/views/tasks.js `commit()`), so this seam's only job is to persist; a rejected save is
// logged, never silently swallowed.
export function persistChange(s) {
  saveState(s).catch((err) => {
    console.error("saveState failed:", err);
  });
}

// The sole persistence path — calls ONLY provider.save(state). Pass {force:true} as the
// explicit "discard the unreadable blob" recovery after a StorageCorruptError; never
// invoked automatically.
export async function saveState(newState = state, opts) {
  state = newState;
  return provider.save(state, opts);
}

// ---- Shell rendering (2.U1) — DOM-only, called from the browser auto-run below ----

function renderPlaceholder(pane, name) {
  pane.textContent = "";
  const inner = document.createElement("div");
  inner.className = "pane-inner";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = `${name} is coming in a later step.`;
  inner.appendChild(p);
  pane.appendChild(inner);
}

function initUI() {
  const pane = document.getElementById("pane");
  const tabs = Array.from(document.querySelectorAll(".nav .tab"));
  const addBtn = document.getElementById("addBtn");

  let tasksHandle = null;
  const views = {
    tasks: (p) => {
      tasksHandle = mountTasksView(p, getState(), { onChange: persistChange });
    },
    deadlines: (p) => renderPlaceholder(p, "Deadlines"),
    calendar: (p) => renderPlaceholder(p, "Calendar"),
  };
  let current = "tasks";

  function show(name) {
    current = name;
    for (const t of tabs) {
      if (t.dataset.view === name) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    }
    views[name](pane);
  }

  for (const t of tabs) t.addEventListener("click", () => show(t.dataset.view));

  // Global add (+) control (D35): open the Tasks add form (switching to Tasks first if
  // the user is on another view). The add form itself is task 2.U4.
  addBtn.addEventListener("click", () => {
    if (current !== "tasks") show("tasks");
    tasksHandle?.openAdd();
  });

  show("tasks");
}

/* c8 ignore start -- browser-only auto-run; exercised by hand in a real browser, not Node */
if (typeof window !== "undefined") {
  boot({
    search: window.location.search,
    confirmOverwrite: () =>
      window.confirm("This will overwrite existing data with the sample seed. Continue?"),
  })
    .then((s) => {
      console.log(
        `Ledger boot: ${s.tasks.length} task(s), ${s.slots.length} slot(s) (provider: ${s.settings.providerType})`
      );
      initUI();
    })
    .catch((err) => {
      if (err && err.name === "StorageCorruptError") {
        console.error(err.message); // surfaced, never auto-recovered into a fresh empty state
      } else {
        throw err;
      }
    });
}
/* c8 ignore stop */
