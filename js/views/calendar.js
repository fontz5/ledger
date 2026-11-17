// Calendar view — docs/05_TASKS_STEP5.md Module M.
// Task 5.M1: Month mode base render + navigation. The 7x4-6 grid (D21/D35): dots capped at
// 3 + "+n" per day (colour = each item's task.color solid; an overdue deadline's dot is
// --danger regardless of colour, "overdue always wins"), today highlight, tap-to-expand day
// detail (below the grid on phone, a side panel at/above 720px via CSS — same 7-col grid
// both places, only density differs), prev/next/today navigation. Every count/date comes
// from js/logic.js (monthMatrix/itemsOnDate/isOverdue); this module computes no Date math of
// its own beyond deriving "today" once via toLocaleDateString('en-CA') (never toISOString).
// Task 5.M2: an optional `runwayFor: taskId` passed to mountCalendarView() layers D35's runway
// highlight on top — yellow (--accent-wash) from today to the day before the deadline, red
// (--danger) on the deadline day itself, clipped to whatever's in the currently-rendered
// matrix (lead/trail cells included — they're real visible grid cells) with a note when the
// runway extends past it. `visibleRunway()` is exported so the exact D35 worked example can be
// asserted directly against a fixed todayISO, since mountCalendarView itself has no
// injectable-date seam (same convention as 5.M1). A fresh prev/next/today clears it (D35:
// transient emphasis, not a persistent mode).
//
// Task 5.G1 (Module G): adds Day and Week time-grid modes alongside Month, switched via a new
// mode nav (D35: "Calendar is now Day/Week/Month"). Day = one date column, Week = seven, both on
// the shared 06:00-22:00 / 30-min row grid (03 Part B "Planner"), right-aligned --mono time
// labels in a 64px column, hour rows labelled/half-hour rows blank. An all-day/multi-day banner
// row sits above the time rows (D33) — structure only here, 5.G2 populates it. A "now" line
// renders only when the shown date(s) include today and the current time falls inside the grid
// window, and re-renders on a 60s interval. Prev/next/today + a jump-to-date input navigate Day
// by 1 day and Week by 7. No item rendering (Slots/events/occurrences, 5.G2), no Slot CRUD
// (5.G3), no drag (5.X1) — skeleton only, no build-ahead. Mounting always resets to Month (same
// "no injectable-date seam, always today" convention 5.M1 established) since no caller passes a
// mode yet (5.D-INT, not built, is the first future caller that would).
//
// Task 5.G2: populates the Day/Week grid with sized blocks. `itemsOnDate` (5.L4) supplies one
// date's Slots/routine-occurrences/event-occurrences; timed ones are shaped for `layoutDay`
// (5.L1: `{start, durationMin}`) so overlaps render side-by-side via the returned
// `lane`/`laneCount`, positioned top/height by percentage of the 06:00-22:00 window (same
// percentage convention the now-line already uses — resolution-independent, no row-height
// rounding). All-day event occurrences and non-all-day *multi-day* events (start date !== end
// date) render as banner chips instead (D33) — a recurring event's occurrence is always
// single-day by construction (expandOccurrences yields one `date` per hit), so only a
// non-recurring event can be multi-day. Tapping a routine/event block reuses `js/views/tasks.js`
// `openDetail` UNCHANGED (imported, not reimplemented) — a Slot block gets no click handler yet
// (5.G3 owns Slot create/edit/delete; it has no existing popup to reuse).
//
// Task 5.G3 (D34's mandatory tap-to-edit floor): tapping an empty 30-min row cell opens a
// create form (task picker + start/durationMin, pre-filled/snapped from the tapped row — every
// row IS a 30-min boundary, so there's no sub-row position to snap); tapping an existing Slot
// block opens a read-only detail popup with Edit/Delete. Reuses `js/views/tasks.js`'s modal/
// form scaffold (`openModal`/`closeModal`/`metaRow`/`appendField`/`labelledInput`, all now
// exported, behaviour unchanged) rather than duplicating it — both target the same
// `#modal-host`, so "one dialog at a time" holds across modules. Mutations go through a new
// local `commitSlots()` -> `opts.onChange` seam mirroring `mountTasksView`'s own `commit()`
// (defaults to a no-op if no `onChange` is passed — `js/app.js`'s calendar mount call site is
// deliberately NOT touched here; wiring it to `persistChange` is 5.G-INT's own reserved job,
// same "make a wiring change only if something doesn't already funnel through" scope line as
// 2.INT/4.INT before it). A Slot's own `date` is not user-editable via the Edit form (D34/05
// spec: edit "reopens the same fields as create" — task/start/durationMin only); `moveSlot` is
// still called (same date, new-or-same start) ahead of `resizeSlot` so both re-validate via
// `validateSlotTimes` regardless of which field(s) actually changed.
//
// Task 5.X1 (D34's enhancement, D42's gate): pointer-drag move/resize on top of 5.G2/5.G3 —
// additive only, 5.G3's form fields already cover every mutation this reaches. **D42 gate**:
// only a Slot block or a non-recurring event's own block gets a drag handle attached at all; a
// routine occurrence or a recurring event's occurrence (`item.recurring`, set from the task's
// own `recurrence` field in `timedAndBannerItems`) gets NEITHER a move nor a resize handle — its
// existing tap-to-open path (5.G2, untouched) remains the only way to interact with it. A plain
// tap on a draggable block still opens its detail exactly as before (movement below
// `DRAG_THRESHOLD_PX` never engages `_drag`, so the ordinary `click` fires); a real drag beyond
// that threshold sets `_justDragged` for one tick so the same `click` doesn't ALSO reopen detail
// right after a drop. Live feedback during drag is vertical-only (`el.style.top`/`height`,
// mirroring the now-line's percentage-of-window convention) — sub-step 2's own wording ("updates
// its vertical position live") — a Week-mode column change is resolved only at drop, by nearest-
// centre column under the pointer (`weekModeTargetDate`, using `_gridColumns` captured for the
// CURRENT render). Every commit re-validates via the exact same functions the explicit forms use
// (`moveSlot`/`resizeSlot` for a Slot, `validateEventTimes` for an event) and simply calls the
// existing full `rerender()` on any drop, valid or not: a commit mutates `_state` first so the
// re-render shows the new position; a rejected commit never touches `_state`, so the same
// re-render naturally redraws the ORIGINAL position — "snaps back" for free, no separate revert
// path needed. Real touch/mouse geometry (`getBoundingClientRect`, `pointerdown`/`move`/`up`) is
// exactly the part this task's own spec defers to a HUMAN CHECK — reported OUTSTANDING, not
// claimed, same convention every other Step-5 UI task's phone-only item already used.
//
// Task 5.D-INT: completes 5.D1's stubbed `onSelectDeadline` (js/app.js wires it, not this
// module) by teaching `mountCalendarView` to land on the runway-targeted task's own deadline
// month via the new pure `focusMonthFor` (mirroring `visibleRunway`'s "no injectable-date seam"
// workaround) instead of always today's month — an overdue task's deadline is in the past, so
// its month is used exactly the same way, matching D35's "the red date always shows" contract.
// Every other `mountCalendarView` caller (no `runwayFor`) is unaffected — `focusMonthFor` falls
// back to `todayISO()`.
//
// Task 7.U3 (D45): the month grid's dots now render EITHER their colour or the user's emoji for
// that palette category, resolved by the pure `markerFor(task, prefs)` from 7.U2 — this module
// adds no rule of its own about which wins. With the default `prefs.marker === "color"` (and for
// any category with no mapping in emoji mode) the dot is byte-identical to 5.M1's. An overdue
// deadline's dot keeps a --danger ring + wash behind the glyph, since a glyph cannot carry the
// red fill that "overdue always wins" relies on. The 3-dots-then-"+n" cap (D21) is untouched.

import { monthMatrix, itemsOnDate, isOverdue, runwayDates, layoutDay, childrenOf, validateSlotTimes, moveSlot, resizeSlot, validateEventTimes, markerFor, WEEKDAY_ABBR } from "../logic.js";
import { TASK_COLORS, DEFAULT_COLOR, makeSlot } from "../state.js";
import { openDetail as openTaskDetail, openModal, closeModal, metaRow, appendField, labelledInput } from "./tasks.js";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---- View instance state (set by mountCalendarView) ----
let _pane = null;
let _state = null;
let _onChange = () => {};
let _year = 0;
let _month = 0; // 0-11
let _expandedDate = null;
let _runwayFor = null; // taskId, or null (5.M2)

// 5.G1 — Day/Week mode state.
let _mode = "month"; // "month" | "day" | "week"
let _dayDate = null; // ISO date shown in Day mode
let _weekStart = null; // ISO date (a Sunday) — first day shown in Week mode
let _nowTimer = null;

const GRID_START_MIN = 360; // 06:00 (03 Part B "Planner")
const GRID_END_MIN = 1320; // 22:00
const GRID_ROWS = (GRID_END_MIN - GRID_START_MIN) / 30; // 32

function todayISO() {
  return new Date().toLocaleDateString("en-CA");
}

// Local-date-safe day arithmetic (never toISOString — CLAUDE.md/03's timezone-bug rule).
function shiftISO(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function sundayOf(dateISO) {
  return shiftISO(dateISO, -new Date(dateISO + "T00:00:00").getDay());
}

function weekDates(weekStartISO) {
  const out = [];
  for (let i = 0; i < 7; i++) out.push(shiftISO(weekStartISO, i));
  return out;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function timeToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutesToDateTime(dateISO, totalMin) {
  const dayOffset = Math.floor(totalMin / 1440);
  const mins = ((totalMin % 1440) + 1440) % 1440;
  const date = dayOffset === 0 ? dateISO : shiftISO(dateISO, dayOffset);
  return `${date}T${minToTime(mins)}`;
}

// ---- Drag-to-move / drag-to-resize (5.X1, D34 enhancement, D42 gate) ----

const DRAG_THRESHOLD_PX = 6;
let _drag = null; // {kind:'move'|'resize', item, el, moved, pointerId, startClientX/Y, rowHeightPx, startTopPct, startHeightPct, startDateISO} | null
let _justDragged = false; // suppresses the one click that follows a real drag's pointerup
let _gridColumns = []; // [{dateISO, el}] for the CURRENT render — Week-mode drop-column snapping

function beginDrag(e, kind, item, el) {
  if (_drag) return;
  const rowsEl = el.parentNode;
  const rect = rowsEl.getBoundingClientRect();
  _drag = {
    kind,
    item,
    el,
    moved: false,
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    rowHeightPx: rect.height / GRID_ROWS,
    startTopPct: parseFloat(el.style.top) || 0,
    startHeightPct: parseFloat(el.style.height) || 0,
    startDateISO: rowsEl.dataset.date,
  };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragCancel);
}

function onDragMove(e) {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  const dxPx = e.clientX - _drag.startClientX;
  const dyPx = e.clientY - _drag.startClientY;
  if (!_drag.moved && Math.hypot(dxPx, dyPx) > DRAG_THRESHOLD_PX) _drag.moved = true;
  if (!_drag.moved) return;
  const deltaPct = (dyPx / (_drag.rowHeightPx * GRID_ROWS)) * 100;
  if (_drag.kind === "move") {
    _drag.el.style.top = `${_drag.startTopPct + deltaPct}%`;
  } else {
    const minHeightPct = (30 / (GRID_END_MIN - GRID_START_MIN)) * 100;
    _drag.el.style.height = `${Math.max(_drag.startHeightPct + deltaPct, minHeightPct)}%`;
  }
}

function endDragListeners() {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragCancel);
}

function onDragEnd(e) {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  endDragListeners();
  const drag = _drag;
  _drag = null;
  if (!drag.moved) return; // a plain tap — the block's own click handler opens detail as usual

  // Set for one tick so the click that (on most platforms) follows this pointerup doesn't ALSO
  // reopen detail right after a drop — but some touch browsers suppress that click entirely
  // after a significant drag, so this must not depend on one ever arriving: self-clear on the
  // next tick regardless, or it would dangle and silently eat a LATER, unrelated tap.
  _justDragged = true;
  setTimeout(() => { _justDragged = false; }, 0);
  const dyRows = Math.round((e.clientY - drag.startClientY) / drag.rowHeightPx);

  if (drag.kind === "move") {
    const newDateISO = weekModeTargetDate(e.clientX) ?? drag.startDateISO;
    const newStart = minToTime(timeToMin(drag.item.start) + dyRows * 30);
    commitDragMove(drag.item, newDateISO, newStart);
  } else {
    commitDragResize(drag.item, drag.item.durationMin + dyRows * 30);
  }
  rerender(); // a commit mutates _state first (new position shows); a rejected one doesn't
              // (original position redraws — "snaps back" for free, D34/5.X1 sub-step 2/3).
}

function onDragCancel(e) {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  endDragListeners();
  _drag = null;
  rerender(); // any live (uncommitted) visual move reverts since _state was never touched
}

// Nearest-centre date column under the pointer at drop, for a Week-mode cross-column move.
// `null` in Day mode (only one column — the caller falls back to the drag's own start date).
function weekModeTargetDate(clientX) {
  if (_gridColumns.length <= 1) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of _gridColumns) {
    const rect = c.el.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const dist = Math.abs(clientX - center);
    if (dist < bestDist) { bestDist = dist; best = c.dateISO; }
  }
  return best;
}

// Re-validates via the exact same functions the explicit 5.G3 form uses (moveSlot for a Slot,
// validateEventTimes for a non-recurring event) — an invalid result is a no-op (caller's
// rerender() then redraws the unchanged, original position).
function commitDragMove(item, newDateISO, newStart) {
  if (item.kind === "slot") {
    const slot = _state.slots.find((s) => s.id === item.slotId);
    if (!slot) return;
    const result = moveSlot(slot, newDateISO, newStart);
    if (!result.ok) return;
    slot.date = result.slot.date;
    slot.start = result.slot.start;
    _onChange(_state);
  } else if (item.kind === "event") {
    const task = _state.tasks.find((t) => t.id === item.taskId);
    if (!task || !task.start || !task.end) return;
    const durationMin = Math.round((new Date(task.end) - new Date(task.start)) / 60000);
    const newStartDT = minutesToDateTime(newDateISO, timeToMin(newStart));
    const newEndDT = minutesToDateTime(newDateISO, timeToMin(newStart) + durationMin);
    const check = validateEventTimes({ ...task, start: newStartDT, end: newEndDT });
    if (!check.ok) return;
    task.start = newStartDT;
    task.end = newEndDT;
    _onChange(_state);
  }
}

function commitDragResize(item, newDurationMin) {
  if (item.kind === "slot") {
    const slot = _state.slots.find((s) => s.id === item.slotId);
    if (!slot) return;
    const result = resizeSlot(slot, newDurationMin);
    if (!result.ok) return;
    slot.durationMin = result.slot.durationMin;
    _onChange(_state);
  } else if (item.kind === "event") {
    const task = _state.tasks.find((t) => t.id === item.taskId);
    if (!task || !task.start) return;
    const newEndDT = minutesToDateTime(task.start.slice(0, 10), timeToMin(task.start.slice(11, 16)) + newDurationMin);
    const check = validateEventTimes({ ...task, end: newEndDT });
    if (!check.ok) return;
    task.end = newEndDT;
    _onChange(_state);
  }
}

// Any existing finite LEAF, routine, or event (05_TASKS_STEP5 5.G3 sub-step 1) — a finite
// CONTAINER is excluded, same "does this finite task have real children" definition
// `progressOf`/`breakdownOf` already use (non-event children only; an attached event doesn't
// make a finite task a container).
function eligibleSlotTasks(tasks) {
  return tasks.filter((t) => {
    if (t.type === "routine" || t.type === "event") return true;
    if (t.type === "finite") return childrenOf(tasks, t.id).filter((k) => k.type !== "event").length === 0;
    return false;
  });
}

// ---- Slot CRUD (5.G3, the D34 mandatory tap-to-edit floor) ----

function commitSlots() {
  _onChange(_state);
  closeModal();
  rerender();
}

function applySlotCreate(fields) {
  _state.slots.push(makeSlot(fields));
  commitSlots();
}

// The Edit form carries the same Date/Start/Duration fields as create (7.A6 — D34's non-drag
// floor, `01` line 25), so `fields.date` may move the slot to another day. `moveSlot` (new date +
// start) runs ahead of `resizeSlot` so both re-validate via `validateSlotTimes` regardless of
// which field(s) actually changed (05 5.G3 sub-step 2). Nothing on `slot` — date included — is
// written until BOTH succeed: a failed step returns its `{ok:false,error}` with `slot` untouched,
// and the caller (the form's submit handler) shows it inline. The view's focused date/week is
// not changed; the grid just redraws via `commitSlots`.
function applySlotEdit(slot, fields) {
  const moved = moveSlot(slot, fields.date, fields.start);
  if (!moved.ok) return moved;
  const resized = resizeSlot(moved.slot, fields.durationMin);
  if (!resized.ok) return resized;
  slot.date = resized.slot.date;
  slot.start = resized.slot.start;
  slot.durationMin = resized.slot.durationMin;
  slot.taskId = fields.taskId;
  commitSlots();
  return { ok: true };
}

// Deleting a Slot never touches the task/event/routine it referenced (05 5.G3 sub-step 2) —
// it's a planner assignment, not the work item itself; only `_state.slots` is filtered.
function applySlotDelete(slot) {
  _state.slots = _state.slots.filter((s) => s.id !== slot.id);
  commitSlots();
}

function confirmSlotDelete(slot, actionsRow) {
  const confirm = document.createElement("div");
  confirm.className = "modal-confirm";

  const msg = document.createElement("p");
  msg.className = "modal-confirm-msg";
  msg.textContent = "Delete this slot?";
  confirm.appendChild(msg);

  const row = document.createElement("div");
  row.className = "modal-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn sm ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => openSlotDetail(slot));
  row.appendChild(cancel);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn sm modal-confirm-delete";
  del.textContent = "Delete";
  del.addEventListener("click", () => applySlotDelete(slot));
  row.appendChild(del);

  confirm.appendChild(row);
  actionsRow.replaceWith(confirm);
}

// Read-only Slot detail popup (05 5.G3 sub-step 2), mirroring tasks.js's own openDetail
// shape/CSS classes (reused, not reimplemented) with Edit/Delete/Close actions.
function openSlotDetail(slot) {
  const task = _state.tasks.find((t) => t.id === slot.taskId);
  openModal(task ? task.title : "Slot", (dialog) => {
    const meta = document.createElement("div");
    meta.className = "detail-meta";
    meta.appendChild(metaRow("Date", slot.date));
    meta.appendChild(metaRow("Start", slot.start));
    meta.appendChild(metaRow("Duration", `${slot.durationMin} min`));
    dialog.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn sm";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openSlotForm({ mode: "edit", slot }));
    actions.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn sm ghost detail-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => confirmSlotDelete(slot, actions));
    actions.appendChild(delBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn sm ghost";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeModal);
    actions.appendChild(closeBtn);

    dialog.appendChild(actions);
  });
}

// Create (`mode:"create"`, needs `date`+`start` from the tapped cell) or Edit (`mode:"edit"`,
// needs `slot`) Slot form — task picker (`eligibleSlotTasks`) + date/start/durationMin, validated
// via `validateSlotTimes` (5.L5) on submit; on failure shows the error inline and changes nothing
// (05 5.G3 sub-step 1/2). The tapped cell's `date` only PRE-FILLS the Date field (7.A6); what is
// saved is the field's value, in both modes.
function openSlotForm({ mode, slot = null, date = null, start = null }) {
  const heading = mode === "edit" ? "Edit slot" : "Add slot";
  openModal(heading, (dialog) => {
    const form = document.createElement("form");
    form.className = "task-form";

    const taskSelect = document.createElement("select");
    taskSelect.className = "form-control";
    taskSelect.required = true;
    const blankOpt = document.createElement("option");
    blankOpt.value = "";
    blankOpt.textContent = "— choose a task —";
    taskSelect.appendChild(blankOpt);
    for (const t of eligibleSlotTasks(_state.tasks)) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.title} (${t.type})`;
      if (slot && slot.taskId === t.id) opt.selected = true;
      taskSelect.appendChild(opt);
    }
    appendField(form, "Task", taskSelect);

    // 7.A6: same field in create and edit ("reopens the same fields as create"), so a slot can be
    // moved to another day without dragging (D34: the editor is the floor).
    const dateInput = labelledInput(form, "Date", "date", slot ? slot.date : date);
    dateInput.required = true;

    const startInput = labelledInput(form, "Start time", "time", slot ? slot.start : start);
    startInput.step = 1800; // 30-min boundary (D30)
    startInput.required = true;

    const durationInput = labelledInput(
      form,
      "Duration (minutes)",
      "number",
      String(slot ? slot.durationMin : 60)
    );
    durationInput.step = 30;
    durationInput.min = 30;
    durationInput.required = true;

    const errorMsg = document.createElement("p");
    errorMsg.className = "form-error";
    errorMsg.hidden = true;
    form.appendChild(errorMsg);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn sm";
    save.textContent = "Save";
    actions.appendChild(save);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn sm ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => (mode === "edit" ? openSlotDetail(slot) : closeModal()));
    actions.appendChild(cancel);

    form.appendChild(actions);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const taskId = taskSelect.value;
      if (!taskId) {
        errorMsg.textContent = "Pick a task.";
        errorMsg.hidden = false;
        return;
      }
      const slotDate = dateInput.value;
      if (!slotDate) {
        errorMsg.textContent = "Pick a date.";
        errorMsg.hidden = false;
        return;
      }
      const fields = { taskId, date: slotDate, start: startInput.value, durationMin: Number(durationInput.value) };

      if (mode === "edit") {
        const result = applySlotEdit(slot, fields);
        if (!result.ok) {
          errorMsg.textContent = result.error;
          errorMsg.hidden = false;
          return;
        }
      } else {
        const check = validateSlotTimes({ start: fields.start, durationMin: fields.durationMin });
        if (!check.ok) {
          errorMsg.textContent = check.error;
          errorMsg.hidden = false;
          return;
        }
        errorMsg.hidden = true;
        applySlotCreate(fields);
      }
    });

    dialog.appendChild(form);
    if (typeof taskSelect.focus === "function") taskSelect.focus();
  });
}

// Splits one date's itemsOnDate() result into timed blocks (fed to layoutDay, 5.L1) and
// all-day/multi-day banner items (D33). A non-recurring event occurrence carries `start`/`end`
// (full "YYYY-MM-DDTHH:mm"); a recurring one carries `time`/`durationMin` and is always
// single-day. `key` is a stable per-render id (layoutDay preserves unrecognised fields).
function timedAndBannerItems(dateISO) {
  const info = itemsOnDate(_state.tasks, _state.slots, dateISO);
  const timed = [];
  const banner = [];

  for (const o of info.routineOccurrences) {
    const task = _state.tasks.find((t) => t.id === o.taskId);
    if (!task) continue;
    timed.push({
      key: `r:${o.taskId}:${o.date}`,
      kind: "routine",
      taskId: o.taskId,
      start: o.time,
      durationMin: o.durationMin,
      status: o.status,
      color: colorOf(task).solid,
      title: task.title,
    });
  }

  for (const o of info.eventOccurrences) {
    const task = _state.tasks.find((t) => t.id === o.taskId);
    if (!task) continue;
    const isMultiDay = !!(o.start && o.end && o.start.slice(0, 10) !== o.end.slice(0, 10));
    if (o.allDay || isMultiDay) {
      banner.push({ key: `e:${o.taskId}:${o.date}`, taskId: o.taskId, title: task.title, color: colorOf(task).solid });
      continue;
    }
    const start = o.time || (o.start ? o.start.slice(11, 16) : null);
    const durationMin = typeof o.durationMin === "number"
      ? o.durationMin
      : Math.round((new Date(o.end) - new Date(o.start)) / 60000);
    if (!start || !(durationMin > 0)) continue;
    timed.push({
      key: `e:${o.taskId}:${o.date}`,
      kind: "event",
      recurring: !!task.recurrence, // D42 gate (5.X1): only a non-recurring event's own block drags
      taskId: o.taskId,
      start,
      durationMin,
      color: colorOf(task).solid,
      title: task.title,
    });
  }

  for (const s of info.slots) {
    const task = _state.tasks.find((t) => t.id === s.taskId);
    timed.push({
      key: `s:${s.id}`,
      kind: "slot",
      slotId: s.id,
      taskId: s.taskId,
      start: s.start,
      durationMin: s.durationMin,
      color: task ? colorOf(task).solid : "var(--ink-faint)",
      title: task ? task.title : "(unknown task)",
    });
  }

  return { timed, banner };
}

function buildBannerChip(item) {
  const chip = document.createElement("span");
  chip.className = "timegrid-banner-chip";
  chip.style.background = item.color;
  chip.textContent = item.title;
  chip.addEventListener("click", () => {
    const task = _state.tasks.find((t) => t.id === item.taskId);
    if (task) openTaskDetail(task);
  });
  return chip;
}

// A laid-out (`lane`/`laneCount` from layoutDay) timed item as an absolutely-positioned block
// inside `.timegrid-rows`. Top/height are percentages of the 06:00-22:00 window (mirrors the
// now-line's own positioning convention — independent of row-height rounding).
function buildBlock(item) {
  const el = document.createElement("div");
  el.className = "timegrid-block" + (item.kind === "routine" && item.status ? ` status-${item.status}` : "");
  el.style.background = item.color;
  const top = ((timeToMin(item.start) - GRID_START_MIN) / (GRID_END_MIN - GRID_START_MIN)) * 100;
  const height = (item.durationMin / (GRID_END_MIN - GRID_START_MIN)) * 100;
  const width = 100 / item.laneCount;
  const left = item.lane * width;
  el.style.top = `${top}%`;
  el.style.height = `${height}%`;
  el.style.left = `${left}%`;
  el.style.width = `${width}%`;

  const title = document.createElement("span");
  title.className = "timegrid-block-title";
  title.textContent = item.title;
  el.appendChild(title);

  if (item.kind === "routine" || item.kind === "event") {
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    const open = () => {
      // A real drag (beyond the tap threshold) sets this for one tick so the click that
      // follows its pointerup doesn't ALSO reopen detail right after a drop (5.X1).
      if (_justDragged) { _justDragged = false; return; }
      const task = _state.tasks.find((t) => t.id === item.taskId);
      if (task) openTaskDetail(task);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  } else if (item.kind === "slot") {
    el.dataset.slotId = item.slotId;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    const open = () => {
      if (_justDragged) { _justDragged = false; return; }
      const slot = _state.slots.find((s) => s.id === item.slotId);
      if (slot) openSlotDetail(slot);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  }

  // D42 gate: only a Slot, or a non-recurring event's own block, ever gets a drag handle — a
  // routine occurrence or a recurring event's occurrence gets neither a move nor a resize
  // affordance, only its existing tap-to-open path above (5.X1 sub-step 1).
  const draggable = item.kind === "slot" || (item.kind === "event" && !item.recurring);
  if (draggable) {
    el.classList.add("timegrid-block-draggable");
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      beginDrag(e, "move", item, el);
    });

    const handle = document.createElement("div");
    handle.className = "timegrid-block-resize-handle";
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // never also trigger the block's own move-drag above
      if (e.pointerType === "mouse" && e.button !== 0) return;
      beginDrag(e, "resize", item, el);
    });
    el.appendChild(handle);
  }

  return el;
}

// Hour rows get "HH:00"; half-hour rows are blank (03 Part B: "half-hour rows can carry a
// lighter/blank label").
function rowTimeLabel(rowIndex) {
  if (rowIndex % 2 !== 0) return "";
  const totalMin = GRID_START_MIN + rowIndex * 30;
  return `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:00`;
}

function formatDayLabel(dateISO) {
  const d = new Date(dateISO + "T00:00:00");
  return `${WEEKDAY_ABBR[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

function formatWeekLabel(weekStartISO) {
  const start = new Date(weekStartISO + "T00:00:00");
  const endISO = shiftISO(weekStartISO, 6);
  const end = new Date(endISO + "T00:00:00");
  return start.getMonth() === end.getMonth()
    ? `${MONTH_NAMES[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`
    : `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

// Pure: which of a task's runwayDates() fall inside the currently-rendered matrix (which
// includes lead/trail cells from adjacent months — those ARE visible grid cells, per 5.M2
// sub-step 1's literal "every yellow date currently visible in the grid"), and whether the
// runway extends beyond that. Exported for the reviewer/tests to call directly with a fixed
// todayISO — mountCalendarView itself always uses the real wall-clock today (no injectable-date
// seam, matching 5.M1's own convention), so this is the only way to exercise the exact D35
// worked example without waiting for the calendar date to match it.
export function visibleRunway(todayISO, deadlineISO, matrix) {
  const { yellow, red } = runwayDates(todayISO, deadlineISO);
  const visible = new Set(matrix.flat().map((c) => c.date));
  const yellowSet = new Set(yellow.filter((d) => visible.has(d)));
  const redVisible = visible.has(red);
  const clipped = yellow.some((d) => !visible.has(d)) || !redVisible;
  let note = null;
  if (clipped) {
    const outside = [...yellow, red].find((d) => !visible.has(d));
    const [y, m] = outside.split("-").map(Number);
    note = `Runway continues into ${MONTH_NAMES[m - 1]} ${y}.`;
  }
  return { yellowSet, red: redVisible ? red : null, clipped, note };
}

// Pure: which (year, month) Month should open on — the targeted task's own deadline month when
// `runwayFor` names a task that has one, else `todayISO`'s month (5.D-INT: "landing on the month
// containing that task's deadline", including an already-overdue one, whose deadline is in the
// past). Exported for the same reason `visibleRunway` is: `mountCalendarView` has no injectable-
// date seam (5.M1's convention), so this is the only way to assert the exact landing month
// without waiting for the real calendar date to match a fixture.
export function focusMonthFor(tasks, runwayFor, todayISO) {
  const task = runwayFor ? tasks.find((t) => t.id === runwayFor) : null;
  const dateISO = task && task.deadline ? task.deadline : todayISO;
  const [y, m] = dateISO.split("-").map(Number);
  return { year: y, month: m - 1 };
}

function colorOf(task) {
  return TASK_COLORS[task.color] ?? TASK_COLORS[DEFAULT_COLOR[task.type]];
}

// Normalizes one date's itemsOnDate() result into a flat, render-ready list — the single
// place both the per-cell dots and the day-detail panel read from, so they always agree
// (deadlines, then routine occurrences, then event occurrences — same order the 5.M1 dot
// count formula uses). `timeLabel` is the occurrence's own time when it has one, else the
// type name ("deadline"/"event" for an all-day item) — the spec's "time-or-type-label" rule.
function normalizedItems(dateISO, today) {
  const info = itemsOnDate(_state.tasks, _state.slots, dateISO);
  const out = [];
  for (const t of info.deadlines) {
    const overdue = isOverdue(_state.tasks, t, today);
    out.push({
      title: t.title,
      color: overdue ? "var(--danger)" : colorOf(t).solid,
      // 7.U3 (D45): `marker` rides ALONGSIDE `color`, never replacing it — the day-detail rows
      // and the Day/Week chips keep reading `color` exactly as they do today. `overdue` travels
      // as its own flag because an emoji glyph cannot carry --danger the way a filled dot can
      // (sub-step 2), so the dot needs the flag, not just the colour.
      marker: markerFor(t, _state.prefs),
      overdue,
      timeLabel: "deadline",
    });
  }
  for (const o of info.routineOccurrences) {
    const t = _state.tasks.find((x) => x.id === o.taskId);
    if (!t) continue;
    out.push({ title: t.title, color: colorOf(t).solid, marker: markerFor(t, _state.prefs), overdue: false, timeLabel: o.time || "routine" });
  }
  for (const o of info.eventOccurrences) {
    const t = _state.tasks.find((x) => x.id === o.taskId);
    if (!t) continue;
    const timeLabel = o.allDay ? "event" : o.time || (o.start ? o.start.slice(11, 16) : "event");
    out.push({ title: t.title, color: colorOf(t).solid, marker: markerFor(t, _state.prefs), overdue: false, timeLabel });
  }
  return out;
}

function buildDayCell(cell, today, runway) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "cal-day" +
    (cell.inMonth ? "" : " cal-day-out") +
    (cell.isToday ? " cal-day-today" : "") +
    (runway && runway.yellowSet.has(cell.date) ? " cal-day-runway-yellow" : "") +
    (runway && runway.red === cell.date ? " cal-day-runway-red" : "");
  btn.setAttribute("aria-pressed", String(_expandedDate === cell.date));
  btn.setAttribute("aria-label", cell.date);

  const num = document.createElement("span");
  num.className = "cal-day-num";
  num.textContent = String(Number(cell.date.slice(8, 10)));
  btn.appendChild(num);

  const items = normalizedItems(cell.date, today);
  const dotsWrap = document.createElement("div");
  dotsWrap.className = "cal-dots";
  for (const it of items.slice(0, 3)) {
    const dot = document.createElement("span");
    dot.className = "cal-dot";
    if (it.marker && it.marker.kind === "emoji") {
      // Emoji mode with a mapping for this category: the glyph IS the marker, so the 6px
      // colour fill is dropped (.cal-dot-emoji) and an overdue item keeps a --danger ring
      // behind the glyph instead of a red fill (sub-step 2). The ≤3 + "+n" cap is untouched.
      dot.className = "cal-dot cal-dot-emoji" + (it.overdue ? " cal-dot-overdue" : "");
      dot.textContent = it.marker.value;
    } else {
      // Colour mode, and emoji mode's unmapped-category fallback: byte-identical to 5.M1 —
      // `it.color` already resolves overdue to --danger, so nothing here changes.
      dot.style.background = it.color;
    }
    dotsWrap.appendChild(dot);
  }
  if (items.length > 3) {
    const more = document.createElement("span");
    more.className = "cal-dot-more";
    more.textContent = `+${items.length - 3}`;
    dotsWrap.appendChild(more);
  }
  btn.appendChild(dotsWrap);

  btn.addEventListener("click", () => {
    _expandedDate = _expandedDate === cell.date ? null : cell.date;
    rerender();
  });
  return btn;
}

function buildDetailPanel(dateISO, today) {
  const panel = document.createElement("div");
  panel.className = "cal-detail-panel";

  const heading = document.createElement("h2");
  heading.className = "cal-detail-heading";
  heading.textContent = dateISO;
  panel.appendChild(heading);

  const items = normalizedItems(dateISO, today);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nothing on this day.";
    panel.appendChild(empty);
    return panel;
  }

  const list = document.createElement("div");
  list.className = "cal-detail-list";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "cal-detail-row";
    row.style.borderLeftColor = it.color;

    const title = document.createElement("span");
    title.className = "cal-detail-title";
    title.textContent = it.title;

    const meta = document.createElement("span");
    meta.className = "cal-detail-meta";
    meta.textContent = it.timeLabel;

    row.append(title, meta);
    list.appendChild(row);
  }
  panel.appendChild(list);
  return panel;
}

function changeMonth(delta) {
  let m = _month + delta;
  let y = _year;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  _month = m;
  _year = y;
  _expandedDate = null;
  // 7.R3/D46: the runway SURVIVES prev/next. D35 originally made it transient, which meant
  // following the grid's own "Runway continues into <month>" note destroyed the runway you
  // navigated to see. Today and the explicit dismiss control are the only ways to clear it.
  rerender();
}

function goToToday() {
  const d = new Date();
  _year = d.getFullYear();
  _month = d.getMonth();
  _expandedDate = null;
  _runwayFor = null; // Today still clears it (7.R3 sub-step 2)
  rerender();
}

function buildNav() {
  const nav = document.createElement("div");
  nav.className = "cal-nav";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn ghost sm";
  prevBtn.textContent = "‹ Prev";
  prevBtn.addEventListener("click", () => changeMonth(-1));

  const label = document.createElement("span");
  label.className = "cal-month-label";
  label.textContent = `${MONTH_NAMES[_month]} ${_year}`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn ghost sm";
  nextBtn.textContent = "Next ›";
  nextBtn.addEventListener("click", () => changeMonth(1));

  const todayBtn = document.createElement("button");
  todayBtn.type = "button";
  todayBtn.className = "btn sm";
  todayBtn.textContent = "Today";
  todayBtn.addEventListener("click", () => goToToday());

  nav.append(prevBtn, label, nextBtn, todayBtn);
  return nav;
}

// 5.G1 — switches between Month/Week/Day. Kept separate from buildNav (Month's own prev/next/
// today bar) since each mode needs its own navigation semantics.
function buildModeNav() {
  const nav = document.createElement("div");
  nav.className = "cal-mode-nav";
  for (const m of ["day", "week", "month"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost sm cal-mode-btn" + (_mode === m ? " cal-mode-btn-active" : "");
    btn.textContent = m[0].toUpperCase() + m.slice(1);
    btn.setAttribute("aria-pressed", String(_mode === m));
    btn.addEventListener("click", () => {
      if (_mode === m) return;
      // Carry the tapped Month date into Day/Week instead of leaving them wherever they last
      // were — only when actually leaving Month with a date selected (2026-09-19).
      if (_mode === "month" && _expandedDate && (m === "day" || m === "week")) {
        _dayDate = _expandedDate;
        _weekStart = sundayOf(_expandedDate);
      }
      _mode = m;
      rerender();
    });
    nav.appendChild(btn);
  }
  return nav;
}

// The reverse direction of buildModeNav's Month->Day/Week carry: jumping to a date from the
// Day/Week jump-to-date picker updates Month's displayed month + selection and the other of
// Day/Week too, so switching to either later lands in the right place (2026-09-19).
function setFocusDate(dateISO) {
  _dayDate = dateISO;
  _weekStart = sundayOf(dateISO);
  const d = new Date(dateISO + "T00:00:00");
  _year = d.getFullYear();
  _month = d.getMonth();
  _expandedDate = dateISO;
}

function changeDayWeek(delta) {
  if (_mode === "day") _dayDate = shiftISO(_dayDate, delta);
  else _weekStart = shiftISO(_weekStart, delta * 7);
  rerender();
}

function goToTodayDayWeek() {
  const t = todayISO();
  _dayDate = t;
  _weekStart = sundayOf(t);
  rerender();
}

// Prev/next/today + jump-to-date, shared shape between Day and Week (advances 1 day vs. 7 —
// spec 5.G1 sub-step 5).
function buildDayWeekNav() {
  const nav = document.createElement("div");
  nav.className = "cal-nav cal-nav-stacked";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn ghost sm";
  prevBtn.textContent = "‹ Prev";
  prevBtn.addEventListener("click", () => changeDayWeek(-1));

  const label = document.createElement("span");
  label.className = "cal-month-label cal-nav-label-row";
  label.textContent = _mode === "day" ? formatDayLabel(_dayDate) : formatWeekLabel(_weekStart);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn ghost sm";
  nextBtn.textContent = "Next ›";
  nextBtn.addEventListener("click", () => changeDayWeek(1));

  const todayBtn = document.createElement("button");
  todayBtn.type = "button";
  todayBtn.className = "btn sm";
  todayBtn.textContent = "Today";
  todayBtn.addEventListener("click", () => goToTodayDayWeek());

  const jump = document.createElement("input");
  jump.type = "date";
  jump.className = "cal-jump-input";
  jump.setAttribute("aria-label", "Jump to date");
  jump.value = _mode === "day" ? _dayDate : _weekStart;
  jump.addEventListener("change", () => {
    if (!jump.value) return;
    setFocusDate(jump.value);
    rerender();
  });

  const jumpIcon = document.createElement("span");
  jumpIcon.className = "cal-jump-icon";
  jumpIcon.setAttribute("aria-hidden", "true");

  const jumpWrap = document.createElement("span");
  jumpWrap.className = "cal-jump-wrap";
  jumpWrap.append(jumpIcon, jump);

  const controls = document.createElement("div");
  controls.className = "cal-nav-row";
  controls.append(prevBtn, nextBtn, todayBtn, jumpWrap);

  nav.append(label, controls);
  return nav;
}

// The shared time-label column — mirrors each day column's row structure so labels line up.
function buildLabelsColumn(withHeaderSpacer) {
  const col = document.createElement("div");
  col.className = "timegrid-col timegrid-labelscol";

  if (withHeaderSpacer) {
    const spacer = document.createElement("div");
    spacer.className = "timegrid-header-spacer";
    col.appendChild(spacer);
  }

  const bannerSpacer = document.createElement("div");
  bannerSpacer.className = "timegrid-banner-spacer";
  col.appendChild(bannerSpacer);

  const rows = document.createElement("div");
  rows.className = "timegrid-rows timegrid-labels";
  for (let r = 0; r < GRID_ROWS; r++) {
    const cell = document.createElement("div");
    cell.className = "timegrid-row timegrid-label-row" + (r % 2 !== 0 ? " timegrid-row-half" : "");
    cell.textContent = rowTimeLabel(r);
    rows.appendChild(cell);
  }
  col.appendChild(rows);
  return col;
}

// One date's column: optional weekday/date header (Week mode), the all-day/multi-day banner
// (structure only — 5.G2 populates it), the 32-row time grid, and a now-line when this column
// is today's date and the wall-clock time falls inside the 06:00-22:00 window.
function buildDateColumn(dateISO, today, withHeader) {
  const col = document.createElement("div");
  col.className = "timegrid-col timegrid-daycol" + (dateISO === today ? " timegrid-daycol-today" : "");

  if (withHeader) {
    const header = document.createElement("div");
    header.className = "timegrid-daycol-header";
    const d = new Date(dateISO + "T00:00:00");
    header.textContent = `${WEEKDAY_ABBR[d.getDay()]} ${d.getDate()}`;
    col.appendChild(header);
  }

  const { timed, banner: bannerItems } = timedAndBannerItems(dateISO);

  const banner = document.createElement("div");
  banner.className = "timegrid-banner";
  banner.dataset.date = dateISO;
  for (const b of bannerItems) banner.appendChild(buildBannerChip(b));
  col.appendChild(banner);

  const rows = document.createElement("div");
  rows.className = "timegrid-rows";
  rows.dataset.date = dateISO;
  for (let r = 0; r < GRID_ROWS; r++) {
    const cell = document.createElement("div");
    cell.className = "timegrid-row" + (r % 2 !== 0 ? " timegrid-row-half" : "");
    // 5.G3 (D34 tap-to-edit floor): tapping empty grid space opens the create-Slot form,
    // pre-filled/snapped to this row's own 30-min start (every row IS a 30-min boundary, so
    // there's no sub-row position to snap further). A tap that actually lands on a block (a
    // sibling of this cell, absolutely positioned over it) never reaches this listener — the
    // block is the click target, not this row div, so no stopPropagation is needed.
    const rowStartMin = GRID_START_MIN + r * 30;
    cell.addEventListener("click", () => {
      openSlotForm({ mode: "create", date: dateISO, start: minToTime(rowStartMin) });
    });
    rows.appendChild(cell);
  }

  for (const item of layoutDay(timed)) rows.appendChild(buildBlock(item));

  if (dateISO === today) {
    const nowMin = nowMinutes();
    if (nowMin >= GRID_START_MIN && nowMin <= GRID_END_MIN) {
      const line = document.createElement("div");
      line.className = "timegrid-nowline";
      line.style.top = `${((nowMin - GRID_START_MIN) / (GRID_END_MIN - GRID_START_MIN)) * 100}%`;
      rows.appendChild(line);
    }
  }

  col.appendChild(rows);
  return col;
}

function buildTimeGrid() {
  const today = todayISO();
  const isWeek = _mode === "week";
  const dates = isWeek ? weekDates(_weekStart) : [_dayDate];

  const wrap = document.createElement("div");
  wrap.className = "timegrid" + (isWeek ? " timegrid-week" : " timegrid-day");
  wrap.appendChild(buildLabelsColumn(isWeek));
  // Captured for the CURRENT render only — a Week-mode drag-drop snaps to the nearest column
  // centre under the pointer (5.X1); `null` from `weekModeTargetDate` in Day mode (length 1).
  _gridColumns = [];
  for (const dateISO of dates) {
    const col = buildDateColumn(dateISO, today, isWeek);
    _gridColumns.push({ dateISO, el: col });
    wrap.appendChild(col);
  }
  return wrap;
}

function rerender() {
  _pane.textContent = "";
  const inner = document.createElement("div");
  inner.className = "pane-inner calendar-view";

  inner.appendChild(buildModeNav());

  if (_mode !== "month") {
    inner.appendChild(buildDayWeekNav());
    inner.appendChild(buildTimeGrid());
    _pane.appendChild(inner);
    return;
  }

  inner.appendChild(buildNav());

  const body = document.createElement("div");
  body.className = "cal-body";

  const gridCol = document.createElement("div");
  gridCol.className = "cal-grid-col";

  const weekdayRow = document.createElement("div");
  weekdayRow.className = "cal-weekday-row";
  for (const abbr of WEEKDAY_ABBR) {
    const wd = document.createElement("span");
    wd.className = "cal-weekday";
    wd.textContent = abbr;
    weekdayRow.appendChild(wd);
  }
  gridCol.appendChild(weekdayRow);

  const today = todayISO();
  const matrix = monthMatrix(_year, _month, today);

  let runway = null;
  if (_runwayFor) {
    const task = _state.tasks.find((t) => t.id === _runwayFor);
    if (task && task.deadline) {
      runway = visibleRunway(today, task.deadline, matrix);
      if (runway.clipped) {
        const note = document.createElement("p");
        note.className = "cal-runway-note";
        note.textContent = runway.note;
        gridCol.appendChild(note);
      }
      // 7.R3 sub-step 2: now that the highlight survives navigation (D46) it needs an explicit
      // way out, or it would be inescapable short of pressing Today.
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "btn ghost sm cal-runway-dismiss";
      dismiss.textContent = "Clear runway";
      dismiss.addEventListener("click", () => {
        _runwayFor = null;
        rerender();
      });
      gridCol.appendChild(dismiss);
    }
  }

  const grid = document.createElement("div");
  grid.className = "cal-month-grid";
  for (const week of matrix) {
    for (const cell of week) {
      grid.appendChild(buildDayCell(cell, today, runway));
    }
  }
  gridCol.appendChild(grid);
  body.appendChild(gridCol);

  if (_expandedDate) {
    body.appendChild(buildDetailPanel(_expandedDate, today));
  }

  inner.appendChild(body);
  _pane.appendChild(inner);
}

// Mounts Calendar Month mode into `pane` for `state`. Mirrors mountTasksView's shape
// (js/views/tasks.js) so the shell can call it the same way; returns a handle for future
// callers (5.D-INT's runway-targeted open, 5.M2's runwayFor) — empty for now, no build-ahead.
export function mountCalendarView(pane, state, opts = {}) {
  _pane = pane;
  _state = state;
  // 5.G3: Slot mutations call this after every create/edit/delete (mirrors mountTasksView's
  // own `_onChange`). Defaults to a no-op — wiring `js/app.js`'s calendar mount call site to
  // `persistChange` is 5.G-INT's own reserved job, not this task's (same "make a wiring change
  // only if something doesn't already funnel through" scope line 2.INT/4.INT already set).
  _onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
  _runwayFor = opts.runwayFor ?? null;
  // 5.D-INT: land on the runway-targeted task's own deadline month, not always today's — a
  // no-op for every prior caller (no runwayFor -> falls back to todayISO(), same as before).
  const { year, month } = focusMonthFor(_state.tasks, _runwayFor, todayISO());
  _year = year;
  _month = month;
  _expandedDate = null;

  // 5.G1: every (re-)mount starts on Month (same "always today, no injectable seam" convention
  // 5.M1 established) — no caller passes a mode yet, so this is the only entry point in use.
  _mode = "month";
  const t = todayISO();
  _dayDate = t;
  _weekStart = sundayOf(t);

  // Re-render on a reasonable interval so the now-line tracks the clock (5.G1 sub-step 4).
  // Cleared and re-armed on every mount so repeated tab-switches never stack timers; skips the
  // Month body (no now-line there).
  if (_nowTimer) clearInterval(_nowTimer);
  _nowTimer = setInterval(() => {
    if (_mode !== "month") rerender();
  }, 60000);

  rerender();
  return {};
}
