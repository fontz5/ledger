// Tasks view — docs/05_TASKS_STEP2.md Module U.
// Task 2.U2: read-only tree render (hierarchy, progress, breakdown, colour). Every number
// comes from js/logic.js; every colour name resolves through TASK_COLORS/DEFAULT_COLOR
// (03 Part B) — never a raw hex invented here. All user text goes in via textContent —
// never innerHTML with user-supplied strings.
// Task 2.U3: pinned "Overdue" section (D31) — overdue leaves lift above the tree,
// red-flagged, offering mark-done / keep-working. Nothing automatic: never hidden,
// auto-completed, or auto-rescheduled, and the leaf still appears in its place in
// the tree (the section is a lift, not a move-away).
// Task 2.U4: detail-first interaction (2026-07-16 decision). Tapping a tree row opens a
// READ-ONLY detail popup (title, meta, description=notes); Edit / Add subtask / Delete are
// secondary actions from there. Add/Edit is a finite-task form (title/priority/deadline/
// notes); the colour picker is 2.U5, so colour is NOT edited here. Delete cascades through
// descendants + referencing slots (deleteCascade) behind an in-popup confirm. New records
// go through makeTask so owner:"me"/exceptions:{}/defaults are always correct.
// Mutations update the held state, re-render, and call opts.onChange (the persistence seam
// 2.INT wires to saveState) — this module itself touches no storage (golden rule 4).
// Task 2.U5: the stateful controls. (1) A row checkbox — FINITE ONLY (D25: `done` is a
// finite-only field, so routines/events get no checkbox rather than one that silently
// no-ops) — calls the already-tested pure setDoneCascade; a container's box also reflects
// the tri-state via `indeterminate`. (2) The 8-swatch colour picker in the add/edit form
// sets task.color to a NAME (never a raw hex). (3) The overdue-row actions from 2.U3 (built
// inert there) get their listeners: mark done → setDoneCascade(...,true); keep working →
// openDetail (same read-only popup as a normal row tap).
// Task 3.U1: the add form gains a finite|routine type selector (event is Step 4). Picking
// routine swaps the Deadline field for the Recurrence field-set (weekday multi-select, time,
// duration, window start/end) — Title/Priority/Notes/Colour stay shared. Edit branches on
// node.type with no selector shown (type is fixed once created). validateRecurrence (3.R1)
// gates create/save; on failure nothing is created/changed and the error shows inline. The
// container detail's secondary action is relabelled "Add sub-item" so a routine can be added
// under a container alongside finite subtasks.
// Task 3.U2: the detail popup is routine-aware — Deadline is replaced by Cadence
// (recurrenceSummary) and Progress reads "<done>/<total> (<pct>%)"; below the meta sits a
// scrollable occurrence list (occurrencesWithStatus) whose rows cycle
// planned -> done -> skipped -> moved -> planned via setOccurrenceStatus. A cycle fires
// onChange, re-renders the tree behind the modal, and reopens the popup in place so the
// Progress line updates live. The tree row itself still gets no checkbox (D25/2.U5) and
// marking only ever happens here.
// Still to come: the saveState wiring for routine mutations is confirmed end-to-end at
// 3.INT (the onChange seam itself is already live from 2.INT).
// Task 4.U1: the add form's type selector gains "event". Picking event hides Deadline and
// the Recurrence field-set, showing All day / Location / Recurring instead. Non-recurring
// shows a Start/End pair (date-only when All day, datetime-local otherwise); checking
// Recurring hides Start/End and reuses the SAME weekday/time/duration/window field-set the
// routine branch already built (D41: a recurring event's own start/end stay null — the
// window lives in recurrence.start/.end, exactly like a routine). validateEventTimes (4.E1)
// gates create/save. Editing a non-recurring event opens this form directly; editing a
// recurring event is routed through the 4.U3 "This occurrence / Whole series" chooser
// instead (that routing lives in the event detail popup's Edit action, 4.U3). This form
// itself renders/validates a pre-filled recurring-event edit correctly (mirrors 3.U1's
// routine edit) for the chooser's "Whole series" path.

import {
  childrenOf,
  progressOf,
  completionState,
  breakdownOf,
  isOverdue,
  deleteCascade,
  setDoneCascade,
  validateRecurrence,
  WEEKDAY_ABBR,
  recurrenceSummary,
  occurrencesWithStatus,
  setOccurrenceStatus,
  validateEventTimes,
  expandOccurrences,
  eventSummary,
  cancelEventOccurrence,
  overrideEventOccurrence,
} from "../logic.js";
import { TASK_COLORS, TASK_COLOR_NAMES, DEFAULT_COLOR, makeTask } from "../state.js";

// ---- View instance state (set by mountTasksView; used by the mutation handlers) ----
let _pane = null;
let _state = null;
let _onChange = () => {};

function colorOf(task) {
  return TASK_COLORS[task.color] ?? TASK_COLORS[DEFAULT_COLOR[task.type]];
}

// "YYYY-MM-DDTHH:mm" (or "YYYY-MM-DD") -> "YYYY-MM-DD HH:mm" for display. Pure string
// slicing — no Date round-trip, so no timezone shift (and never toISOString).
function eventDateLabel(task) {
  if (!task.start) return "";
  return task.start.replace("T", " ");
}

// D6: "deliverables N% · sessions D/T" — only the parts that apply to this container.
function breakdownLabel(tasks, node) {
  const b = breakdownOf(tasks, node);
  const parts = [];
  if (b.deliverablesPct !== null) parts.push(`deliverables ${b.deliverablesPct}%`);
  if (b.sessionsTotal > 0) parts.push(`sessions ${b.sessionsDone}/${b.sessionsTotal}`);
  return parts.join(" · ");
}

// Finite-only checkbox (D25). Lives in `.task-controls`, a SIBLING of `.task-main`, so a
// click never bubbles into the row's open-detail listener. Checking a container cascades
// to every finite descendant via the already-tested pure setDoneCascade (D23/D25); the
// container's box also shows the tri-state via `indeterminate` for a "partial" row.
function buildCheckbox(node, state) {
  // Wrapped in a <label> so the tap target hits the 40px floor (03 Part B "Spacing and
  // sizing") without inflating the checkbox's own visual size — a native label click
  // toggles its checkbox.
  const wrap = document.createElement("label");
  wrap.className = "task-checkbox-wrap";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "task-checkbox";
  input.checked = state === "done";
  input.indeterminate = state === "partial";
  input.setAttribute("aria-label", `Mark "${node.title}" done`);
  input.addEventListener("change", () => toggleDone(node.id, input.checked));
  wrap.appendChild(input);
  return wrap;
}

function toggleDone(id, value) {
  setDoneCascade(_state.tasks, id, value);
  commit();
}

function renderRow(tasks, node, isContainer) {
  const row = document.createElement("div");
  row.className = "task-row";
  const color = colorOf(node);
  row.style.borderLeftColor = color.solid; // 3px colour accent (D22)
  if (isContainer) {
    row.classList.add("container-row");
    row.style.background = color.wash; // container header tint (D22)
  }

  const state = completionState(tasks, node); // null for events

  // The tap target: the content column opens the read-only detail popup (2.U4). A real
  // role=button + keyboard support keeps it operable without a mouse (a11y floor). The
  // container's chevron lives in a SEPARATE grid cell, so toggling never opens the popup.
  const main = document.createElement("div");
  main.className = "task-main";
  main.setAttribute("role", "button");
  main.setAttribute("tabindex", "0");
  main.setAttribute("aria-label", `Open ${node.title}`);
  main.addEventListener("click", () => openDetail(node));
  main.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetail(node);
    }
  });

  const titleLine = document.createElement("div");
  titleLine.className = "task-title-line";

  if (state === "done") {
    const tick = document.createElement("span");
    tick.className = "task-tick";
    tick.textContent = "✓";
    titleLine.appendChild(tick);
  }

  const title = document.createElement("span");
  title.className = "task-title";
  if (state === "done") title.classList.add("done");
  title.textContent = node.title;
  titleLine.appendChild(title);

  if (node.priority === "high" || node.priority === "med") {
    const chip = document.createElement("span");
    chip.className = `chip pri-${node.priority}`;
    chip.textContent = node.priority === "high" ? "high" : "med";
    titleLine.appendChild(chip);
  } // low = no chip (03 Part B)

  main.appendChild(titleLine);

  if (state === null) {
    // Event: no progress, no bar — render it by date (D20/D25).
    const when = document.createElement("div");
    when.className = "task-event-date";
    when.textContent = eventDateLabel(node);
    main.appendChild(when);
  } else {
    const pct = progressOf(tasks, node);
    const progress = document.createElement("div");
    progress.className = "task-progress";

    const bar = document.createElement("div");
    bar.className = "progress-bar";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    progress.appendChild(bar);

    const label = document.createElement("span");
    label.className = "progress-label";
    label.textContent = state === "partial" ? `${pct}% · partially done` : `${pct}%`;
    progress.appendChild(label);

    main.appendChild(progress);
  }

  row.appendChild(main);

  // Leading controls column: the checkbox (finite only, D25) plus — for a container —
  // the chevron `renderNode` inserts afterward. Both live in ONE cell so the row keeps its
  // two-column grid (controls | content) whether it carries zero, one, or two leading
  // controls (03 Part B "two columns: checkbox + content").
  const controls = document.createElement("div");
  controls.className = "task-controls";
  if (node.type === "finite") controls.appendChild(buildCheckbox(node, state));
  if (controls.childNodes.length) row.insertBefore(controls, main);

  return { row, controls };
}

function renderNode(tasks, node) {
  const kids = childrenOf(tasks, node.id);
  const isContainer = kids.length > 0;

  const wrap = document.createElement("div");
  wrap.className = "task-node";

  const { row, controls } = renderRow(tasks, node, isContainer);

  if (!isContainer) {
    wrap.appendChild(row);
    return wrap;
  }

  // Container: expand/collapse via an explicit chevron button (the row's content opens
  // the detail popup — 2.U4). Expanded by default; the breakdown line (D6) and the
  // nested children show only while expanded.
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "task-toggle";
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-label", `Collapse ${node.title}`);
  toggle.textContent = "▾";
  controls.insertBefore(toggle, controls.firstChild);
  if (!row.contains(controls)) row.insertBefore(controls, row.firstChild);

  const body = document.createElement("div");
  body.className = "task-children";

  const breakdown = breakdownLabel(tasks, node);
  if (breakdown) {
    const line = document.createElement("div");
    line.className = "task-breakdown";
    line.textContent = breakdown;
    body.appendChild(line);
  }

  for (const kid of kids) body.appendChild(renderNode(tasks, kid));

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.setAttribute(
      "aria-label",
      `${expanded ? "Expand" : "Collapse"} ${node.title}`
    );
    toggle.textContent = expanded ? "▸" : "▾";
    body.hidden = expanded;
  });

  wrap.appendChild(row);
  wrap.appendChild(body);
  return wrap;
}

// Pinned "Overdue" section (05 §2.U3, D31). Selection is the shared `isOverdue`
// predicate and nothing else — leaf-only lives in the predicate (03: "both surfaces
// share this one predicate"), so the view adds no rule of its own. Returns null when
// nothing is overdue (no empty section). The overdue-row actions are wired in 2.U5; the
// overdue leaf is also reachable for detail/edit via its normal tree row.
function renderOverdueSection(tasks, today) {
  const overdue = tasks.filter((t) => isOverdue(tasks, t, today));
  if (overdue.length === 0) return null;

  const section = document.createElement("section");
  section.className = "overdue-section";
  section.setAttribute("aria-label", "Overdue");

  const heading = document.createElement("h2");
  heading.className = "overdue-heading";
  heading.textContent = "Overdue";
  section.appendChild(heading);

  for (const node of overdue) {
    const row = document.createElement("div");
    row.className = "overdue-row";
    row.dataset.taskId = node.id;

    const line = document.createElement("div");
    line.className = "overdue-title-line";

    const title = document.createElement("span");
    title.className = "overdue-title";
    title.textContent = node.title;
    line.appendChild(title);

    const chip = document.createElement("span");
    chip.className = "chip overdue-chip";
    chip.textContent = `due ${node.deadline}`;
    line.appendChild(chip);

    row.appendChild(line);

    // The two D31 actions (05 §2.U5): mark done cascades via the same setDoneCascade the
    // row checkbox uses; keep working opens the read-only detail popup (Edit lives there).
    // Nothing automatic — the row itself is left in place; it simply drops off the section
    // on the next render once effectiveDone/isOverdue says so.
    const actions = document.createElement("div");
    actions.className = "overdue-actions";

    const done = document.createElement("button");
    done.type = "button";
    done.className = "btn sm overdue-done-btn";
    done.textContent = "Mark done";
    done.addEventListener("click", () => toggleDone(node.id, true));
    actions.appendChild(done);

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn sm ghost overdue-keep-btn";
    keep.textContent = "Keep working";
    keep.addEventListener("click", () => openDetail(node));
    actions.appendChild(keep);

    row.appendChild(actions);
    section.appendChild(row);
  }

  return section;
}

// Builds the tasks-view element for a state (05 §2.U2 tree + §2.U3 overdue section).
// Pure DOM construction from state + logic.js — no storage, no globals. `today` is
// computed ONCE here as a local YYYY-MM-DD (never toISOString — timezone bugs).
export function renderTasks(state) {
  const today = new Date().toLocaleDateString("en-CA");
  const list = document.createElement("div");
  list.className = "task-list";
  const overdue = renderOverdueSection(state.tasks, today);
  if (overdue) list.appendChild(overdue);
  for (const top of state.tasks.filter((t) => t.parentId === null)) {
    list.appendChild(renderNode(state.tasks, top));
  }
  return list;
}

// ---- Modal host (2.U4): one dialog at a time, appended to <body>. Read-only detail
// popup and the add/edit form both live here. Escape / overlay-click / Close dismiss;
// focus moves into the dialog on open and is restored to the opener on close. ----

let _openerEl = null;

function closeModal() {
  const existing = document.getElementById("modal-host");
  if (existing) existing.remove();
  if (_openerEl && typeof _openerEl.focus === "function") _openerEl.focus();
  _openerEl = null;
}

// Builds the overlay + dialog scaffold and returns the inner .modal-card to fill. `title`
// labels the dialog for assistive tech. Opening records the currently-focused element so
// closing can restore focus.
function openModal(titleText, fillCard) {
  closeModal();
  _openerEl = typeof document !== "undefined" ? document.activeElement : null;

  const host = document.createElement("div");
  host.id = "modal-host";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.addEventListener("click", closeModal);

  const dialog = document.createElement("div");
  dialog.className = "modal-card card";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const titleId = "modal-title";
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("tabindex", "-1");
  // Clicks inside the dialog must not fall through to the overlay's dismiss handler.
  dialog.addEventListener("click", (e) => e.stopPropagation());
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
  });

  const heading = document.createElement("h2");
  heading.className = "modal-title";
  heading.id = titleId;
  heading.textContent = titleText;
  dialog.appendChild(heading);

  fillCard(dialog);

  host.appendChild(overlay);
  host.appendChild(dialog);
  document.body.appendChild(host);
  if (typeof dialog.focus === "function") dialog.focus();
  return dialog;
}

function metaRow(label, value) {
  const row = document.createElement("div");
  row.className = "detail-meta-row";
  const k = document.createElement("span");
  k.className = "detail-meta-key";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "detail-meta-val";
  v.textContent = value;
  row.appendChild(k);
  row.appendChild(v);
  return row;
}

// D40: per-occurrence STATUS only, cycling in this fixed order. "moved" is a status
// annotation on the original rule date here — no relocation (that's Step 4/5).
const OCC_STATUS_ORDER = ["planned", "done", "skipped", "moved"];
const OCC_STATUS_LABEL = { planned: "Planned", done: "Done", skipped: "Skipped", moved: "Moved" };

function nextOccStatus(status) {
  const i = OCC_STATUS_ORDER.indexOf(status);
  return OCC_STATUS_ORDER[(i + 1) % OCC_STATUS_ORDER.length];
}

// Scrollable occurrence list (3.U2 sub-step 2): one row per live occurrence
// (occurrencesWithStatus already drops D36-cancelled dates), each row's status button
// cycling planned -> done -> skipped -> moved -> planned. No new hex: done uses --positive,
// skipped/moved use --ink-faint (the amber accent stays reserved per 03 colour rules).
function renderOccurrenceList(node) {
  const list = document.createElement("div");
  list.className = "occurrence-list";
  for (const occ of occurrencesWithStatus(node)) {
    const row = document.createElement("div");
    row.className = "occurrence-row";

    const date = document.createElement("span");
    date.className = "occurrence-date";
    date.textContent = occ.date;
    row.appendChild(date);

    const time = document.createElement("span");
    time.className = "occurrence-time";
    time.textContent = occ.time;
    row.appendChild(time);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `occurrence-status status-${occ.status}`;
    btn.textContent = OCC_STATUS_LABEL[occ.status];
    btn.setAttribute("aria-label", `${occ.date} status: ${OCC_STATUS_LABEL[occ.status]}. Tap to change.`);
    btn.addEventListener("click", () => cycleOccurrence(node, occ.date, occ.status));
    row.appendChild(btn);

    list.appendChild(row);
  }
  return list;
}

// Marks one occurrence (3.R2's setOccurrenceStatus), persists via the existing onChange
// seam, re-renders the tree behind the modal, and reopens the popup in place so the
// Progress line and the row's own label update live (never closes the modal, unlike commit()).
function cycleOccurrence(node, dateISO, currentStatus) {
  setOccurrenceStatus(_state.tasks, node.id, dateISO, nextOccStatus(currentStatus));
  _onChange(_state);
  rerender();
  openDetail(node);
}

// Read-only occurrence list for a recurring EVENT (4.U2 sub-step 2) — reuses the 3.U2
// `.occurrence-*` row/date/time CSS but a distinct render: no status button (events carry
// no `log`), and two per-row actions instead. Cancel is wired directly to the pure
// `cancelEventOccurrence` (4.E2) behind an inline confirm (cancelling one date has only one
// meaning, no scope choice — 05 §4.U2 sub-step 2). Edit opens the 4.U3 scope chooser
// pre-scoped to this date (05 §4.U3 sub-step 1: "an occurrence row's Edit action — date
// already known, passed through").
function renderEventOccurrenceList(node) {
  const list = document.createElement("div");
  list.className = "occurrence-list";
  for (const occ of expandOccurrences(node)) {
    const row = document.createElement("div");
    row.className = "occurrence-row";

    const date = document.createElement("span");
    date.className = "occurrence-date";
    date.textContent = occ.date;
    row.appendChild(date);

    const time = document.createElement("span");
    time.className = "occurrence-time";
    time.textContent = node.allDay ? "All day" : occ.time;
    row.appendChild(time);

    const actions = document.createElement("div");
    actions.className = "occurrence-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn sm ghost";
    editBtn.textContent = "Edit";
    editBtn.setAttribute("aria-label", `Edit the ${occ.date} occurrence`);
    editBtn.addEventListener("click", () =>
      openScopeChooser(node, { action: "edit", dateISO: occ.date })
    );
    actions.appendChild(editBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn sm ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.setAttribute("aria-label", `Cancel the ${occ.date} occurrence`);
    cancelBtn.addEventListener("click", () => confirmCancelOccurrence(node, occ.date, actions));
    actions.appendChild(cancelBtn);

    row.appendChild(actions);
    list.appendChild(row);
  }
  return list;
}

// In-row cancel confirmation (mirrors confirmDelete's replace-then-confirm shape): nothing
// is cancelled on a single tap. Confirming calls the pure cancelEventOccurrence (writes only
// `exceptions`), persists via the existing onChange seam, re-renders the tree behind the
// modal, and reopens the popup in place (same pattern as cycleOccurrence) so the occurrence
// drops out of the list live rather than closing the modal.
function confirmCancelOccurrence(node, dateISO, actionsRow) {
  const confirm = document.createElement("div");
  confirm.className = "modal-confirm";

  const msg = document.createElement("p");
  msg.className = "modal-confirm-msg";
  msg.textContent = `Cancel the ${dateISO} occurrence?`;
  confirm.appendChild(msg);

  const row = document.createElement("div");
  row.className = "modal-actions";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn sm ghost";
  back.textContent = "Keep";
  back.addEventListener("click", () => openDetail(node));
  row.appendChild(back);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn sm modal-confirm-delete";
  del.textContent = "Cancel occurrence";
  del.addEventListener("click", () => {
    cancelEventOccurrence(_state.tasks, node.id, dateISO);
    _onChange(_state);
    rerender();
    openDetail(node);
  });
  row.appendChild(del);

  confirm.appendChild(row);
  actionsRow.replaceWith(confirm);
}

// 4.U3: the "This occurrence / Whole series" scope chooser (D36/D40) — asked before an Edit
// or Delete on a RECURRING event proceeds; a non-recurring event's Edit/Delete stay direct,
// unchanged. `dateISO` is passed through when already known (an occurrence row's own Edit);
// it is `null` from the detail popup's own action row, which acts on the series as a whole
// and has no specific date yet — so "This occurrence" is only offered when a date is known.
// (There is no chooser-driven "Delete -> This occurrence" entry with a date either: an
// occurrence row's own Cancel already calls cancelEventOccurrence directly, per 4.U2 — same
// "no scope choice needed" reasoning documented there — so the case never arises in practice;
// this function handles it anyway for the "edit vs delete" symmetry, not build-ahead.)
// "Whole series" reuses the EXISTING openForm/confirmDelete flows unchanged (D36: whole-
// series edit is a plain field reassignment onto the node; delete is the existing cascade) —
// no new mutation path for that branch. Cancelling the chooser (or picking "This occurrence"
// with no date) returns to the detail popup, whose occurrence list is itself the date picker
// for that case — reusing it rather than building a second one.
function openScopeChooser(node, { action, dateISO = null }) {
  const heading = action === "edit" ? "Edit event" : "Delete event";
  openModal(heading, (dialog) => {
    const msg = document.createElement("p");
    msg.className = "modal-confirm-msg";
    msg.textContent = dateISO
      ? `${action === "edit" ? "Edit" : "Delete"} just the ${dateISO} occurrence, or the whole series?`
      : action === "edit"
      ? "Edit the whole series, or Cancel here and pick one occurrence to edit from the list below."
      : `Delete the whole series, or Cancel here and use "Cancel" on one occurrence in the list below to remove just that date.`;
    dialog.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    if (dateISO) {
      const occBtn = document.createElement("button");
      occBtn.type = "button";
      occBtn.className = "btn sm ghost";
      occBtn.textContent = "This occurrence";
      occBtn.addEventListener("click", () => {
        if (action === "edit") openOccurrenceForm(node, dateISO);
        else {
          msg.remove(); // Delete swaps `actions` for a confirm IN THIS SAME modal (unlike
          // Edit, which opens a fresh one) — drop the now-stale "which scope?" prompt so it
          // doesn't linger stacked above the real confirm message.
          confirmCancelOccurrence(node, dateISO, actions);
        }
      });
      actions.appendChild(occBtn);
    }

    const seriesBtn = document.createElement("button");
    seriesBtn.type = "button";
    seriesBtn.className = "btn sm ghost";
    seriesBtn.textContent = "Whole series";
    seriesBtn.addEventListener("click", () => {
      if (action === "edit") openForm({ mode: "edit", node });
      else {
        msg.remove(); // same stale-prompt fix as the occurrence branch above.
        confirmDelete(node, actions);
      }
    });
    actions.appendChild(seriesBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn sm ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => openDetail(node));
    actions.appendChild(cancelBtn);

    dialog.appendChild(actions);
  });
}

// 4.U3 sub-step 3: the reduced "This occurrence" edit form for one date of a recurring
// event — Start time / Duration / Location only (mirrors the routine recurrence field-set's
// time+duration inputs, 3.U1), never the full 4.U1 event form, since D36's `exceptions`
// object only ever overrides fields on top of the rule for that one date. Pre-filled from
// the rule's own values (`node.recurrence.time`/`.durationMin`, `node.location`), overridden
// by the date's existing `exceptions[dateISO]` object when present (an already-overridden
// occurrence keeps showing its own values, not the rule's, on re-edit). Saving calls the
// pure `overrideEventOccurrence` (4.E2), writing only `exceptions[dateISO]` — the base
// `recurrence`/`start`/`end` are never touched by this path.
function openOccurrenceForm(node, dateISO) {
  const existing = node.exceptions && node.exceptions[dateISO];
  const ov = existing && typeof existing === "object" ? existing : {};
  const rec = node.recurrence;

  openModal(`Edit occurrence — ${dateISO}`, (dialog) => {
    const form = document.createElement("form");
    form.className = "task-form";

    const timeInput = labelledInput(form, "Start time", "time", ov.time || rec.time);
    timeInput.step = 1800; // 30-min boundary (D30 shared time-block vocabulary)

    const durationInput = labelledInput(
      form,
      "Duration (minutes)",
      "number",
      String(ov.durationMin ?? rec.durationMin)
    );
    durationInput.step = 30;
    durationInput.min = 30;

    const locationInput = labelledInput(
      form,
      "Location",
      "text",
      ov.location != null ? ov.location : node.location || ""
    );

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
    cancel.addEventListener("click", () => openDetail(node));
    actions.appendChild(cancel);

    form.appendChild(actions);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      overrideEventOccurrence(_state.tasks, node.id, dateISO, {
        time: timeInput.value,
        durationMin: Number(durationInput.value),
        location: locationInput.value,
      });
      _onChange(_state);
      rerender();
      openDetail(node);
    });

    dialog.appendChild(form);
    if (typeof timeInput.focus === "function") timeInput.focus();
  });
}

// Read-only detail popup (2.U4 sub-step 1): title, meta (type / priority / deadline /
// progress), and description (the existing `notes` field — no schema change). Edit / Add
// subtask / Delete are secondary actions from here. 3.U2: a routine node swaps Deadline for
// Cadence + a "<done>/<total> (<pct>%)" Progress line and gains the occurrence list.
function openDetail(node) {
  openModal(node.title, (dialog) => {
    const meta = document.createElement("div");
    meta.className = "detail-meta";
    meta.appendChild(metaRow("Type", node.type));
    if (node.type === "routine") {
      meta.appendChild(metaRow("Priority", node.priority));
      meta.appendChild(metaRow("Cadence", recurrenceSummary(node.recurrence)));
      const occ = occurrencesWithStatus(node);
      const done = occ.filter((o) => o.status === "done").length;
      const pct = progressOf(_state.tasks, node);
      meta.appendChild(metaRow("Progress", `${done}/${occ.length} (${pct}%)`));
    } else if (node.type !== "event") {
      meta.appendChild(metaRow("Priority", node.priority));
      meta.appendChild(metaRow("Deadline", node.deadline || "—"));
      meta.appendChild(metaRow("Progress", `${progressOf(_state.tasks, node)}%`));
    } else {
      // Event (4.U2): When = eventSummary (4.E1), Location only when set — no Priority/
      // Progress row (both meaningless for an event, 03: priority ignored, progressOf null).
      meta.appendChild(metaRow("When", eventSummary(node)));
      if (node.location) meta.appendChild(metaRow("Location", node.location));
    }
    dialog.appendChild(meta);

    const descLabel = document.createElement("div");
    descLabel.className = "detail-desc-label";
    descLabel.textContent = "Description";
    dialog.appendChild(descLabel);

    const desc = document.createElement("p");
    desc.className = "detail-desc";
    desc.textContent = node.notes ? node.notes : "No description.";
    dialog.appendChild(desc);

    if (node.type === "routine") {
      dialog.appendChild(renderOccurrenceList(node));
    } else if (node.type === "event" && node.recurrence) {
      dialog.appendChild(renderEventOccurrenceList(node));
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    // 4.U3: for a recurring event, Edit/Delete open the "This occurrence / Whole series"
    // chooser instead of going straight to the form/confirm; every other type (and a
    // non-recurring event) is unaffected — same direct routing as before.
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn sm";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      if (node.type === "event" && node.recurrence) openScopeChooser(node, { action: "edit" });
      else openForm({ mode: "edit", node });
    });
    actions.appendChild(editBtn);

    // An event is always a leaf (03 defines no event-child concept) — no "Add sub-item".
    if (node.type !== "event") {
      const subBtn = document.createElement("button");
      subBtn.type = "button";
      subBtn.className = "btn sm ghost";
      subBtn.textContent = "Add sub-item";
      subBtn.addEventListener("click", () =>
        openForm({ mode: "add", parentId: node.id })
      );
      actions.appendChild(subBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn sm ghost detail-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      if (node.type === "event" && node.recurrence) openScopeChooser(node, { action: "delete" });
      else confirmDelete(node, actions);
    });
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

// In-popup delete confirmation (2.U4 sub-step 3 "confirm before delete"): replaces the
// action row with an explicit "Delete X and its N subtasks?" prompt so nothing is deleted
// on a single tap. Confirming runs the pure deleteCascade (descendants + referencing
// slots) and commits.
function confirmDelete(node, actionsRow) {
  const descendantCount = countDescendants(node.id);

  const confirm = document.createElement("div");
  confirm.className = "modal-confirm";

  const msg = document.createElement("p");
  msg.className = "modal-confirm-msg";
  msg.textContent =
    descendantCount > 0
      ? `Delete "${node.title}" and its ${descendantCount} subtask${
          descendantCount === 1 ? "" : "s"
        }?`
      : `Delete "${node.title}"?`;
  confirm.appendChild(msg);

  const row = document.createElement("div");
  row.className = "modal-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn sm ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => openDetail(node));
  row.appendChild(cancel);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn sm modal-confirm-delete";
  del.textContent = "Delete";
  del.addEventListener("click", () => applyDelete(node));
  row.appendChild(del);

  confirm.appendChild(row);
  actionsRow.replaceWith(confirm);
}

function countDescendants(id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  let n = 0;
  for (const k of childrenOf(_state.tasks, id)) n += 1 + countDescendants(k.id, seen);
  return n;
}

// Add / Edit form (2.U4 sub-step 2 + 2.U5's colour picker + 3.U1's Recurrence field-set).
// Title/Priority/Notes/Colour are shared by both types. ADD gets a finite|routine type
// selector at the top (event is Step 4 — not added here); picking routine swaps the
// Deadline field for the Recurrence field-set (weekday multi-select, time, duration, window
// start/end). EDIT shows no selector — it branches on `node.type` (fixed once created) and
// only the relevant field-set is visible. `add` creates a task under `parentId` (null = top
// level) via makeTask; `edit` mutates the tapped record's editable fields, assigning a whole
// new `recurrence` on a routine save.
function openForm({ mode, node = null, parentId = null }) {
  const heading = mode === "edit" ? "Edit task" : parentId ? "Add sub-item" : "Add task";
  let currentType = mode === "edit" ? node.type : "finite";

  openModal(heading, (dialog) => {
    const form = document.createElement("form");
    form.className = "task-form";

    // Type selector — ADD only (05 §3.U1 sub-step 1: "not shown on edit, type is fixed").
    let typeSelect = null;
    if (mode === "add") {
      typeSelect = document.createElement("select");
      typeSelect.className = "form-control";
      typeSelect.id = "form-type";
      for (const t of ["finite", "routine", "event"]) {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        typeSelect.appendChild(opt);
      }
      appendField(form, "Type", typeSelect);
    }

    const titleInput = labelledInput(form, "Title", "text", node ? node.title : "");
    titleInput.required = true;

    const prioritySelect = document.createElement("select");
    prioritySelect.className = "form-control";
    prioritySelect.id = "form-priority";
    for (const p of ["low", "med", "high"]) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      if ((node ? node.priority : "low") === p) opt.selected = true;
      prioritySelect.appendChild(opt);
    }
    appendField(form, "Priority", prioritySelect);

    // ---- Finite-only field: Deadline ----
    const deadlineInput = labelledInput(
      form,
      "Deadline",
      "date",
      node && node.deadline ? node.deadline : ""
    );
    const deadlineField = deadlineInput.parentElement;

    // ---- Routine-only field-set: the Recurrence rule (3.U1) ----
    const rec = node && node.recurrence ? node.recurrence : null;

    const weekdayRow = document.createElement("div");
    weekdayRow.className = "weekday-row";
    const selectedDays = new Set(rec ? rec.days : []);
    const dayButtons = [];
    for (let d = 0; d < 7; d++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "weekday-btn";
      btn.textContent = WEEKDAY_ABBR[d];
      btn.dataset.day = String(d);
      btn.setAttribute("aria-label", WEEKDAY_ABBR[d]);
      btn.setAttribute("aria-pressed", String(selectedDays.has(d)));
      btn.addEventListener("click", () => {
        if (selectedDays.has(d)) selectedDays.delete(d);
        else selectedDays.add(d);
        btn.setAttribute("aria-pressed", String(selectedDays.has(d)));
      });
      dayButtons.push(btn);
      weekdayRow.appendChild(btn);
    }
    appendField(form, "Days", weekdayRow);
    const daysField = weekdayRow.parentElement;

    const timeInput = labelledInput(form, "Start time", "time", rec ? rec.time : "09:00");
    timeInput.step = 1800; // 30-min boundary (D30 shared time-block vocabulary)
    const timeField = timeInput.parentElement;

    const durationInput = labelledInput(
      form,
      "Duration (minutes)",
      "number",
      rec ? String(rec.durationMin) : "60"
    );
    durationInput.step = 30;
    durationInput.min = 30;
    const durationField = durationInput.parentElement;

    const startInput = labelledInput(form, "Window start", "date", rec ? rec.start : "");
    const startField = startInput.parentElement;

    const endInput = labelledInput(form, "Window end", "date", rec ? rec.end : "");
    const endField = endInput.parentElement;

    // ---- Event-only fields (4.U1) ----
    const ev = node && node.type === "event" ? node : null;
    let eventRecurring = !!(ev && ev.recurrence);

    const allDayInput = document.createElement("input");
    allDayInput.type = "checkbox";
    allDayInput.checked = ev ? !!ev.allDay : false;
    const allDayField = appendCheckboxField(form, "All day", allDayInput);

    const recurringInput = document.createElement("input");
    recurringInput.type = "checkbox";
    recurringInput.checked = eventRecurring;
    const recurringField = appendCheckboxField(form, "Recurring", recurringInput);

    const eventStartInput = labelledInput(
      form,
      "Start",
      ev && ev.allDay ? "date" : "datetime-local",
      ev && !eventRecurring ? ev.start || "" : ""
    );
    const eventStartField = eventStartInput.parentElement;

    const eventEndInput = labelledInput(
      form,
      "End",
      ev && ev.allDay ? "date" : "datetime-local",
      ev && !eventRecurring ? ev.end || "" : ""
    );
    const eventEndField = eventEndInput.parentElement;

    allDayInput.addEventListener("change", () => {
      const t = allDayInput.checked ? "date" : "datetime-local";
      eventStartInput.type = t;
      eventEndInput.type = t;
      eventStartInput.value = "";
      eventEndInput.value = "";
    });

    recurringInput.addEventListener("change", () => {
      eventRecurring = recurringInput.checked;
      updateFieldVisibility();
    });

    const locationInput = labelledInput(form, "Location", "text", ev ? ev.location || "" : "");
    const locationField = locationInput.parentElement;

    function updateFieldVisibility() {
      const isRoutine = currentType === "routine";
      const isEvent = currentType === "event";
      const showRecurrenceSet = isRoutine || (isEvent && eventRecurring);
      deadlineField.hidden = currentType !== "finite";
      daysField.hidden = !showRecurrenceSet;
      timeField.hidden = !showRecurrenceSet;
      durationField.hidden = !showRecurrenceSet;
      startField.hidden = !showRecurrenceSet;
      endField.hidden = !showRecurrenceSet;

      allDayField.hidden = !isEvent;
      recurringField.hidden = !isEvent;
      locationField.hidden = !isEvent;
      eventStartField.hidden = !(isEvent && !eventRecurring);
      eventEndField.hidden = !(isEvent && !eventRecurring);
    }
    updateFieldVisibility();

    const notesArea = document.createElement("textarea");
    notesArea.className = "form-control";
    notesArea.id = "form-notes";
    notesArea.rows = 3;
    notesArea.value = node ? node.notes : "";
    appendField(form, "Description", notesArea);

    // Colour picker (2.U5): the 8 TASK_COLORS swatches. Sets a NAME, never a raw hex.
    // Default follows the CURRENT type (teal for routine, slate for finite, 03 Part B) until
    // the user actually picks one — `colorTouched` tracks that. `selectedColor` is read at
    // submit time; `aria-pressed` tracks the current pick.
    let colorTouched = false;
    let selectedColor = node ? node.color || DEFAULT_COLOR[node.type] : DEFAULT_COLOR[currentType];
    const swatchRow = document.createElement("div");
    swatchRow.className = "swatch-row";
    const swatches = [];
    for (const name of TASK_COLOR_NAMES) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch";
      sw.style.background = TASK_COLORS[name].solid;
      sw.dataset.color = name;
      sw.setAttribute("aria-label", `${name} colour`);
      sw.setAttribute("aria-pressed", String(name === selectedColor));
      sw.addEventListener("click", () => {
        colorTouched = true;
        selectedColor = name;
        for (const b of swatches) b.setAttribute("aria-pressed", String(b.dataset.color === name));
      });
      swatches.push(sw);
      swatchRow.appendChild(sw);
    }
    appendField(form, "Colour", swatchRow);

    if (typeSelect) {
      typeSelect.value = currentType;
      typeSelect.addEventListener("change", () => {
        currentType = typeSelect.value;
        updateFieldVisibility();
        if (!colorTouched) {
          selectedColor = DEFAULT_COLOR[currentType];
          for (const b of swatches) {
            b.setAttribute("aria-pressed", String(b.dataset.color === selectedColor));
          }
        }
      });
    }

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
    cancel.addEventListener("click", () =>
      mode === "edit" ? openDetail(node) : closeModal()
    );
    actions.appendChild(cancel);

    form.appendChild(actions);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        return;
      }
      // `priority` is shared-form UI only for finite/routine (03: "ignored for event") — kept
      // out of `shared` and added per-branch so the event branch never writes it.
      const shared = {
        title,
        notes: notesArea.value,
        color: selectedColor,
      };

      if (currentType === "routine") {
        const recurrence = {
          days: [...selectedDays].sort((a, b) => a - b),
          time: timeInput.value,
          durationMin: Number(durationInput.value),
          start: startInput.value,
          end: endInput.value,
        };
        const check = validateRecurrence(recurrence);
        if (!check.ok) {
          errorMsg.textContent = check.error;
          errorMsg.hidden = false;
          return;
        }
        errorMsg.hidden = true;
        const fields = { ...shared, priority: prioritySelect.value, recurrence };
        if (mode === "edit") applyEdit(node, fields);
        else applyAdd({ type: "routine", ...fields }, parentId);
      } else if (currentType === "event") {
        const allDay = allDayInput.checked;
        let recurrence = null;
        let start = null;
        let end = null;
        if (recurringInput.checked) {
          recurrence = {
            days: [...selectedDays].sort((a, b) => a - b),
            time: timeInput.value,
            durationMin: Number(durationInput.value),
            start: startInput.value,
            end: endInput.value,
          };
        } else {
          start = eventStartInput.value || null;
          end = eventEndInput.value || null;
        }
        const check = validateEventTimes({ allDay, start, end, recurrence });
        if (!check.ok) {
          errorMsg.textContent = check.error;
          errorMsg.hidden = false;
          return;
        }
        errorMsg.hidden = true;
        const fields = { ...shared, allDay, location: locationInput.value, recurrence, start, end };
        if (mode === "edit") applyEdit(node, fields);
        else applyAdd({ type: "event", ...fields }, parentId);
      } else {
        const fields = { ...shared, priority: prioritySelect.value, deadline: deadlineInput.value || null };
        if (mode === "edit") applyEdit(node, fields);
        else applyAdd({ type: "finite", ...fields }, parentId);
      }
    });

    dialog.appendChild(form);
    if (typeof titleInput.focus === "function") titleInput.focus();
  });
}

function appendField(form, labelText, control) {
  const wrap = document.createElement("label");
  wrap.className = "form-field";
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = labelText;
  wrap.appendChild(span);
  wrap.appendChild(control);
  form.appendChild(wrap);
  return control;
}

function labelledInput(form, labelText, type, value) {
  const input = document.createElement("input");
  input.className = "form-control";
  input.type = type;
  input.value = value;
  appendField(form, labelText, input);
  return input;
}

// A checkbox laid out as "[ ] Label" (the label-above-control pattern `appendField` uses
// doesn't read well for a boolean toggle). Returns the wrapping <label> itself, so callers
// can toggle `.hidden` on it exactly like the other `...Field` handles.
function appendCheckboxField(form, labelText, input) {
  const wrap = document.createElement("label");
  wrap.className = "form-field form-checkbox-field";
  input.className = "form-checkbox";
  wrap.appendChild(input);
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = labelText;
  wrap.appendChild(span);
  form.appendChild(wrap);
  return wrap;
}

// ---- Mutations: update the held state, persist via the onChange seam (2.INT → saveState),
// and re-render. New records ALWAYS go through makeTask so owner/exceptions/defaults are
// correct (never a hand-built object). ----

function commit() {
  _onChange(_state);
  closeModal();
  rerender();
}

function applyAdd(fields, parentId) {
  const task = makeTask({ parentId, ...fields });
  _state.tasks.push(task);
  commit();
}

// `fields` carries `deadline` (finite), `recurrence` (routine), or `allDay`/`location`/
// `recurrence`/`start`/`end` (event) — never a mix — so only the branch matching the node's
// own (immutable) type is ever touched. `priority` is finite/routine only (03: "ignored for
// event") — an event's existing priority is left untouched, never taken from the shared select.
function applyEdit(node, fields) {
  node.title = fields.title;
  node.notes = fields.notes;
  node.color = fields.color;
  if (node.type === "routine") {
    node.priority = fields.priority;
    node.recurrence = fields.recurrence;
  } else if (node.type === "event") {
    node.allDay = fields.allDay;
    node.location = fields.location;
    node.recurrence = fields.recurrence;
    node.start = fields.start;
    node.end = fields.end;
  } else {
    node.priority = fields.priority;
    node.deadline = fields.deadline;
  }
  commit();
}

function applyDelete(node) {
  const next = deleteCascade(_state.tasks, _state.slots, node.id);
  _state.tasks = next.tasks;
  _state.slots = next.slots;
  commit();
}

// ---- Mount / render ----

function rerender() {
  _pane.textContent = "";
  const inner = document.createElement("div");
  inner.className = "pane-inner";
  if (_state.tasks.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No tasks yet. Tap + to add your first one.";
    inner.appendChild(p);
  } else {
    inner.appendChild(renderTasks(_state));
  }
  _pane.appendChild(inner);
}

// Mounts the Tasks view into `pane` for `state`. `opts.onChange(state)` is the persistence
// seam (2.INT wires it to saveState; a no-op leaves mutations in memory). Returns a handle
// so the shell's global add (+) control can open the add form (05 §2.U1 routed it here).
export function mountTasksView(pane, state, opts = {}) {
  _pane = pane;
  _state = state;
  _onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
  rerender();
  return {
    openAdd: () => openForm({ mode: "add", parentId: null }),
  };
}
