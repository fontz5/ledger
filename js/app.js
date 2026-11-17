// Boot + render wiring (PIN v2) — docs/05_TASKS_STEP1.md §1.INT + 05_TASKS_STEP2.md §2.U1.
// Ties 1.1-1.4 together behind the storage interface, then (browser only) mounts the shell:
// nav switching between Tasks and the two placeholder panes, plus the global add control.
// This module touches no browser storage or network directly; all persistence goes through
// js/storage.js (golden rule 4).

import { LocalStorageProvider } from "./storage.js";
import { migrate, makeAppState } from "./state.js";
import { mountTasksView } from "./views/tasks.js";
import { mountCalendarView } from "./views/calendar.js";
import { mountDeadlinesView } from "./views/deadlines.js";
import { mountSettingsView } from "./views/settings.js";

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
// then apply the dev-only seed trigger (which dynamically imports the fixture — 7.R2). Never
// swallows StorageCorruptError — a corrupt STORAGE_KEY throws out of provider.load() and this
// function does not catch it.
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
      // 7.R2: dev-only means dev-only. The fixture is imported HERE, behind ?seed=1, so it is
      // never in the shipped module graph and a normal boot never fetches it.
      const { sampleState } = await import("./sample-data.js");
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

// ---- Corrupt-state recovery (7.R1) — the on-screen half of D28's contract ----

// Renders the "your saved data could not be read" state into `pane`. DOM-only; it neither reads
// nor writes storage. `onDiscard` is wired to the ONE control that is allowed to destroy the
// preserved blob — nothing here happens automatically (D28: an automatic fresh start makes the
// loss permanent on the next save).
export function renderBootError(pane, err, onDiscard) {
  pane.textContent = "";
  const inner = document.createElement("div");
  inner.className = "pane-inner";

  const region = document.createElement("section");
  region.className = "card boot-error";
  region.setAttribute("role", "alert");
  region.setAttribute("aria-label", "Saved data could not be read");

  const heading = document.createElement("h2");
  heading.className = "boot-error-title";
  heading.textContent = "Saved data could not be read";

  const what = document.createElement("p");
  what.textContent =
    "PIN found data in this browser that is not readable, so it has not been loaded and nothing has been changed.";

  const kept = document.createElement("p");
  kept.textContent = `The unreadable data has been preserved under "${err.backupKey}" — discarding it below cannot be undone from inside the app.`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn boot-error-discard";
  btn.textContent = "Discard unreadable data and start fresh";
  btn.addEventListener("click", () => onDiscard());

  region.append(heading, what, kept, btn);
  inner.appendChild(region);
  pane.appendChild(inner);
  return region;
}

// The explicit recovery the button — and only the button — triggers: overwrite the preserved-corrupt
// key via the single persistence path (golden rule 4), then re-boot into the now-empty app.
export async function discardCorruptAndReboot(opts = {}) {
  await saveState(makeAppState(), { force: true });
  return bootWithRecovery(opts);
}

// boot() with the D28 recovery affordance attached. A StorageCorruptError is surfaced on screen
// (and still logged); every other error propagates untouched. Returns {ok:true,state} on a normal
// boot and {ok:false,error} when the error state was rendered.
export async function bootWithRecovery(opts = {}) {
  const { pane, onReady, ...bootOpts } = opts;
  try {
    const s = await boot(bootOpts);
    onReady?.(s);
    return { ok: true, state: s };
  } catch (err) {
    if (!err || err.name !== "StorageCorruptError") throw err;
    console.error(err.message); // kept: useful and costs nothing
    renderBootError(pane, err, () => {
      discardCorruptAndReboot(opts).catch((e) => console.error("recovery failed:", e));
    });
    return { ok: false, error: err };
  }
}

// ---- Shell rendering (2.U1) — DOM-only, called from the browser auto-run below ----

function initUI() {
  const pane = document.getElementById("pane");
  const tabs = Array.from(document.querySelectorAll(".nav .tab"));
  const addBtn = document.getElementById("addBtn");

  let tasksHandle = null;
  const views = {
    tasks: (p) => {
      tasksHandle = mountTasksView(p, getState(), { onChange: persistChange });
    },
    // 5.D-INT: a row tap switches to Calendar Month targeting that task's deadline runway
    // (D35) — `show` forwards the opts through to `views.calendar` below.
    deadlines: (p) =>
      mountDeadlinesView(p, getState(), {
        onSelectDeadline: (taskId) => show("calendar", { runwayFor: taskId }),
      }),
    // 5.G-INT: Slot create/edit/delete/drag (5.G3/5.X1) already funnel into mountCalendarView's
    // own `_onChange(_state)` seam — this was the one call site not wired to it, so every Slot
    // mutation updated in-memory state but never persisted. `opts` (e.g. 5.D-INT's `runwayFor`)
    // is spread first so `onChange` always resolves to the real seam, matching mountTasksView's
    // own `{ onChange: persistChange }` pattern above.
    calendar: (p, opts = {}) => mountCalendarView(p, getState(), { ...opts, onChange: persistChange }),
    // 6.U1: Settings/Sync tab (D43) — local-only connect form; Push/Pull land in 6.U2.
    // 7.X-INT: Settings is the one view that can replace the WHOLE state from under itself
    // (Pull, and now Import — which also swaps `prefs`, so 7.U3's marker picker would keep
    // rendering the pre-import mapping without this). `onStateReplaced` is settings.js's hook for
    // exactly that; until now nothing wired it, so it was a documented no-op. Re-mounting the
    // current view is the same `show()` every tab switch already uses, and it re-reads
    // `getState()`, so the pane is rebuilt from the replaced state. 6.U-INT considered and
    // deferred this wiring on the grounds that it would clobber pull()'s success message: it does
    // not, because `_pullStatusEl`/`_importStatusEl` are module-level and both callers set their
    // status AFTER firing the hook, so the message lands in the freshly-rendered element.
    settings: (p) =>
      mountSettingsView(p, getState(), {
        onChange: persistChange,
        onStateReplaced: () => show(current),
      }),
  };
  let current = "tasks";

  function show(name, opts) {
    current = name;
    for (const t of tabs) {
      if (t.dataset.view === name) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    }
    views[name](pane, opts);
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
  bootWithRecovery({
    search: window.location.search,
    confirmOverwrite: () =>
      window.confirm("This will overwrite existing data with the sample seed. Continue?"),
    pane: document.getElementById("pane"),
    onReady: (s) => {
      console.log(
        `PIN boot: ${s.tasks.length} task(s), ${s.slots.length} slot(s) (provider: ${s.settings.providerType})`
      );
      initUI();
    },
  });
}
/* c8 ignore stop */