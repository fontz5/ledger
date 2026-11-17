// Deadlines view — docs/05_TASKS_STEP5.md Module D.
// Task 5.D1: countdown list render + row tap. Renders `deadlineCountdown` (5.L2, already DONE)
// as a list — title, `deadline` (mono), and a prominent "N days" / "N days ago" (D35 exact
// phrasing; "0 days" for due-today, never "0 days ago"). Overdue rows (daysUntil < 0) get the
// --danger text / --danger-wash chip treatment (03 Part B "Overdue: --danger text with
// --danger-wash background chip"), same rule as the Tasks-view Overdue section (D31),
// independent of the task's own colour. Tapping a row calls the injected
// `onSelectDeadline(taskId)` callback — this task only decides the callback SHAPE; its real
// destination (switch to Calendar Month with a runway) is 5.D-INT's job, not built here even
// though Month (5.M1/5.M2) already exists — no building ahead of the task breakdown. The global
// add (+) control is shell-level (js/app.js, same as every other view) and needs no wiring here.

import { deadlineCountdown } from "../logic.js";

function todayISO() {
  return new Date().toLocaleDateString("en-CA");
}

function daysLabel(daysUntil) {
  return daysUntil >= 0 ? `${daysUntil} days` : `${-daysUntil} days ago`;
}

function buildRow(item, onSelectDeadline) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "deadline-row" + (item.daysUntil < 0 ? " deadline-row-overdue" : "");

  const title = document.createElement("span");
  title.className = "deadline-row-title";
  title.textContent = item.title;

  const date = document.createElement("span");
  date.className = "deadline-row-date";
  date.textContent = item.deadline;

  const countdown = document.createElement("span");
  countdown.className = "deadline-row-countdown";
  countdown.textContent = daysLabel(item.daysUntil);

  row.append(title, date, countdown);
  row.addEventListener("click", () => onSelectDeadline(item.id));
  return row;
}

function render(pane, state, onSelectDeadline) {
  pane.textContent = "";
  const inner = document.createElement("div");
  inner.className = "pane-inner deadlines-view";

  const items = deadlineCountdown(state.tasks, todayISO());

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No deadlines yet. Add your first one above.";
    inner.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "deadline-list";
    for (const item of items) list.appendChild(buildRow(item, onSelectDeadline));
    inner.appendChild(list);
  }

  pane.appendChild(inner);
}

// Mounts the Deadlines view into `pane` for `state`. `opts.onSelectDeadline(taskId)` is called
// on row tap; defaults to a no-op (5.D-INT wires the real destination once it exists).
export function mountDeadlinesView(pane, state, opts = {}) {
  const onSelectDeadline =
    typeof opts.onSelectDeadline === "function" ? opts.onSelectDeadline : () => {};
  render(pane, state, onSelectDeadline);
  return {};
}
