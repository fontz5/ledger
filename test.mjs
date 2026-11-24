import { makeAppState, makeTask, makeSlot, uid, DEFAULT_COLOR, TASK_COLOR_NAMES, migrate, parseImportedState } from "./js/state.js";
import {
  childrenOf, expandOccurrences, occurrenceStatus, progressOf, breakdownOf,
  effectiveDone, setDoneCascade, completionState, isOverdue, deleteCascade,
  validateRecurrence, recurrenceSummary, occurrencesWithStatus, setOccurrenceStatus,
  validateEventTimes, eventSummary, overrideEventOccurrence, cancelEventOccurrence,
  layoutDay, deadlineCountdown, monthMatrix, runwayDates,
  itemsOnDate, validateSlotTimes, moveSlot, resizeSlot, markerFor, exportState,
  normalizeExecUrl, EXEC_URL_BASE, EXEC_URL_SUFFIX,
  isCompletedHidden, completedHiddenRoots, completedAtOf, eventIsPending, hasPendingEvent,
  HIDE_DELAY_MS, HIDE_DELAY_CONTAINER_MS,
} from "./js/logic.js";
import {
  STORAGE_KEY, CORRUPT_SUFFIX, Store, StorageProvider, LocalStorageProvider, SheetsProvider,
  StorageCorruptError, LEGACY_KEYS, readLegacyV1,
} from "./js/storage.js";
import { sampleState } from "./js/sample-data.js";
import {
  boot, saveState, getState, persistChange,
  renderBootError, bootWithRecovery, discardCorruptAndReboot,
} from "./js/app.js";
import { visibleRunway, focusMonthFor, mountCalendarView } from "./js/views/calendar.js";

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

// 7.A1 sub-step 4: pin "now" for a block whose fixtures depend on what day it is. Only `new Date()`
// and `Date.now()` are redirected; parsing ("YYYY-MM-DD"), arithmetic and every other Date use are
// untouched, so only the answer to "what is today" changes. Returns the restore function — always
// call it, or every later block inherits the pin.
// Three date-dependent assertions were found by running this whole suite under twelve pinned dates
// (7.A1 sub-step 4); the fix for each is a pin plus an explicit precondition assertion, so a future
// change to the pinned date fails loudly instead of quietly making the check vacuous.
function pinToday(dateISO) {
  const Real = Date;
  const at = new Real(dateISO + "T10:30:00").getTime();
  class Pinned extends Real {
    constructor(...a) { return a.length === 0 ? new Real(at) : new Real(...a); }
    static now() { return at; }
  }
  Pinned.parse = Real.parse;
  Pinned.UTC = Real.UTC;
  globalThis.Date = Pinned;
  return () => { globalThis.Date = Real; };
}

const EXPECTED_TASK_FIELDS = [
  "id", "type", "title", "owner", "parentId", "priority", "weight", "color",
  "notes", "createdAt", "completedAt", "deadline", "done", "recurrence",
  "log", "exceptions", "allDay", "start", "end", "location",
].sort();

// --- 1.1 State schema & record factories ---

const state = makeAppState();
assert(
  state.version === 1 &&
    Array.isArray(state.tasks) && state.tasks.length === 0 &&
    Array.isArray(state.slots) && state.slots.length === 0 &&
    state.settings.providerType === "local" && state.settings.sheetUrl === "",
  "makeAppState() yields the locked-empty AppState shape"
);

const finite = makeTask({ type: "finite", title: "x" });
assert(
  JSON.stringify(Object.keys(finite).sort()) === JSON.stringify(EXPECTED_TASK_FIELDS),
  "makeTask({type:'finite',title:'x'}) field set matches 03 Part A exactly"
);
assert(finite.owner === "me", "finite task owner === 'me'");
assert(finite.weight === 1, "finite task weight === 1");
assert(JSON.stringify(finite.log) === "{}", "finite task log is {}");
assert(finite.color === DEFAULT_COLOR.finite, "finite task color defaults to DEFAULT_COLOR.finite");
assert(finite.priority === "low", "finite task priority defaults to 'low'");
assert(finite.done === false, "finite task done defaults to false");

const routine = makeTask({ type: "routine", title: "Prepare slides" });
assert(routine.color === DEFAULT_COLOR.routine, "routine task color defaults to DEFAULT_COLOR.routine");
assert(JSON.stringify(routine.log) === "{}", "routine task log defaults to {}");
assert(routine.recurrence === null, "routine task recurrence defaults to null");

const event = makeTask({ type: "event", title: "Dept meeting" });
assert(event.color === DEFAULT_COLOR.event, "event task color defaults to DEFAULT_COLOR.event");
assert(event.start === null && event.end === null, "event task start/end default to null");
assert(event.allDay === false, "D33: event task allDay defaults to false");
assert(makeTask({ type: "event", title: "Trip", allDay: true }).allDay === true, "D33: makeTask honours an explicit allDay:true");

const examEvent = makeTask({ type: "event", title: "Midterm", parentId: "c1" });
assert(examEvent.parentId === "c1", "event may carry a non-null parentId (attached exam)");
assert(examEvent.type === "event", "attached exam is still type:'event'");

const slot = makeSlot({ date: "2026-07-16", start: "09:30", durationMin: 120, taskId: "t1" });
assert(
  slot.owner === "me" && slot.date === "2026-07-16" && slot.start === "09:30" &&
    slot.durationMin === 120 && slot.taskId === "t1" && typeof slot.id === "string",
  "makeSlot() yields the locked D30 Slot shape (start + durationMin)"
);
assert(
  JSON.stringify(Object.keys(slot).sort()) === JSON.stringify(["date", "durationMin", "id", "owner", "start", "taskId"]),
  "makeSlot() field set is exactly {id,owner,date,start,durationMin,taskId} — no `hour` key"
);
assert(
  makeSlot({ date: "2026-07-16", start: "09:00", taskId: "t1" }).durationMin === 60,
  "makeSlot() durationMin defaults to 60"
);

const id1 = uid();
const id2 = uid();
assert(id1 !== id2, "uid() does not repeat across calls");

// --- 1.2 Pure logic functions ---

// finite container, 3 children, 2 done, equal weight -> 67
{
  const parent = makeTask({ type: "finite", title: "Paper" });
  const c1 = makeTask({ type: "finite", title: "Review", parentId: parent.id, done: true });
  const c2 = makeTask({ type: "finite", title: "Design", parentId: parent.id, done: true });
  const c3 = makeTask({ type: "finite", title: "Experiment", parentId: parent.id, done: false });
  const tasks = [parent, c1, c2, c3];
  assert(progressOf(tasks, parent) === 67, "finite container, 3 equal-weight children, 2 done -> 67");
}

// weighted {Review 1 done, Design 1, Experiment 2} -> 25
{
  const parent = makeTask({ type: "finite", title: "Paper" });
  const review = makeTask({ type: "finite", title: "Review", parentId: parent.id, weight: 1, done: true });
  const design = makeTask({ type: "finite", title: "Design", parentId: parent.id, weight: 1, done: false });
  const experiment = makeTask({ type: "finite", title: "Experiment", parentId: parent.id, weight: 2, done: false });
  const tasks = [parent, review, design, experiment];
  assert(progressOf(tasks, parent) === 25, "weighted {Review 1 done, Design 1, Experiment 2} -> 25");
}

// expandOccurrences(days:[1], 2026-01-12..2026-05-01) -> length 16, every date a Monday
{
  const routine = makeTask({
    type: "routine", title: "Prepare slides",
    recurrence: { days: [1], time: "09:00", durationMin: 120, start: "2026-01-12", end: "2026-05-01" },
  });
  const occ = expandOccurrences(routine);
  assert(occ.length === 16, "expandOccurrences length === 16");
  assert(
    occ.every(o => new Date(o.date + "T00:00:00").getDay() === 1),
    "expandOccurrences: every date is a Monday"
  );

  // D36 exceptions map (2.A2)
  assert(
    JSON.stringify(routine.exceptions) === "{}",
    "D36: makeTask defaults exceptions to {} (routine)"
  );
  assert(
    JSON.stringify(makeTask({ type: "finite", title: "x" }).exceptions) === "{}",
    "D36: makeTask({type:'finite',title:'x'}).exceptions is {}"
  );
  {
    // backward-compat: a record MISSING the exceptions field expands identically to exceptions:{}
    const { exceptions: _drop, ...noExcField } = routine;
    assert(
      JSON.stringify(expandOccurrences(noExcField)) === JSON.stringify(occ),
      "D36: missing exceptions field === exceptions:{} (byte-identical expansion)"
    );

    // cancel: one Monday mapped to null is dropped from the expansion
    const cancelDate = occ[3].date;
    const cancelled = { ...routine, exceptions: { [cancelDate]: null } };
    const cocc = expandOccurrences(cancelled);
    assert(cocc.length === 15, "D36 cancel: null exception -> 15 occurrences");
    assert(
      !cocc.some(o => o.date === cancelDate),
      "D36 cancel: the cancelled date is absent"
    );

    // override: an object spreads over just that occurrence's fields
    const ovDate = occ[5].date;
    const overridden = { ...routine, exceptions: { [ovDate]: { start: "14:00" } } };
    const oocc = expandOccurrences(overridden);
    assert(oocc.length === 16, "D36 override: length stays 16");
    const hit = oocc.find(o => o.date === ovDate);
    assert(hit.start === "14:00", "D36 override: that occurrence carries start:'14:00'");
    assert(
      hit.time === "09:00" && hit.durationMin === 120,
      "D36 override: non-overridden fields unchanged"
    );
    assert(
      oocc.filter(o => o.date !== ovDate).every(o => !("start" in o)),
      "D36 override: other occurrences untouched"
    );
  }

  // routine with 8 of 16 occurrences logged done -> 50
  const log = {};
  occ.slice(0, 8).forEach(o => { log[o.date] = "done"; });
  const routineWithLog = { ...routine, log };
  assert(progressOf([routineWithLog], routineWithLog) === 50, "routine 8/16 done -> 50");

  // effectiveDone: false when not all occurrences done, true when all are
  assert(effectiveDone([routineWithLog], routineWithLog) === false, "effectiveDone false when only 8/16 occurrences done");
  const allDoneLog = {};
  occ.forEach(o => { allDoneLog[o.date] = "done"; });
  const routineAllDone = { ...routine, log: allDoneLog };
  assert(effectiveDone([routineAllDone], routineAllDone) === true, "effectiveDone true when all occurrences done");
}

// progressOf(event) -> null
{
  const event = makeTask({ type: "event", title: "Dept meeting" });
  assert(progressOf([event], event) === null, "progressOf(event) -> null");
}

// effectiveDone true only when all descendants done (finite container)
{
  const parent = makeTask({ type: "finite", title: "Paper" });
  const c1 = makeTask({ type: "finite", title: "Review", parentId: parent.id, done: true });
  const c2 = makeTask({ type: "finite", title: "Design", parentId: parent.id, done: false });
  let tasks = [parent, c1, c2];
  assert(effectiveDone(tasks, parent) === false, "effectiveDone false when a descendant is not done");

  tasks = [parent, { ...c1, done: true }, { ...c2, done: true }];
  assert(effectiveDone(tasks, parent) === true, "effectiveDone true when all descendants done");
}

// setDoneCascade: toggling a container cascades to descendants
{
  const parent = makeTask({ type: "finite", title: "Paper" });
  const c1 = makeTask({ type: "finite", title: "Review", parentId: parent.id, done: false });
  const c2 = makeTask({ type: "finite", title: "Design", parentId: parent.id, done: false });
  const tasks = [parent, c1, c2];
  setDoneCascade(tasks, parent.id, true);
  assert(
    tasks.every(t => t.done === true && typeof t.completedAt === "number"),
    "setDoneCascade cascades done=true + completedAt to all descendants"
  );
}

// setDoneCascade skips events (D23): an attached exam is never marked done
{
  const course = makeTask({ type: "finite", title: "Course" });
  const sub = makeTask({ type: "finite", title: "Reading", parentId: course.id, done: false });
  const exam = makeTask({ type: "event", title: "Midterm", parentId: course.id, start: "2026-03-09T10:00" });
  const tasks = [course, sub, exam];
  setDoneCascade(tasks, course.id, true);
  assert(course.done === true && sub.done === true, "setDoneCascade still cascades to finite descendants");
  assert(
    exam.done === false && exam.completedAt === null,
    "setDoneCascade does NOT mark an attached event done (D23)"
  );

  const before = { ...exam };
  setDoneCascade(tasks, exam.id, true);
  assert(
    exam.done === false && exam.completedAt === before.completedAt,
    "setDoneCascade on an event id is a no-op (D23)"
  );

  assert(effectiveDone(tasks, course) === true, "an attached event does not block the parent's effectiveDone");
}

// D25: completionState is a derived tri-state; the cascade never touches a routine's log
{
  const rec = { days: [1], time: "09:00", durationMin: 120, start: "2026-01-12", end: "2026-05-01" };
  const occ = expandOccurrences(makeTask({ type: "routine", title: "t", recurrence: rec }));

  // the tri-state, read straight off the log
  const none = makeTask({ type: "routine", title: "Slides", recurrence: rec });
  const half = { ...none, log: Object.fromEntries(occ.slice(0, 8).map(o => [o.date, "done"])) };
  const all = { ...none, log: Object.fromEntries(occ.map(o => [o.date, "done"])) };
  assert(completionState([none], none) === "none", "routine, 0 occurrences logged -> 'none'");
  assert(completionState([half], half) === "partial", "routine, 8/16 logged -> 'partial'");
  assert(completionState([all], all) === "done", "routine, 16/16 logged -> 'done'");

  // events have no completion at all
  const ev = makeTask({ type: "event", title: "Midterm", start: "2026-03-09T10:00" });
  assert(completionState([ev], ev) === null, "completionState(event) -> null");

  // finite leaf + container
  const leaf = makeTask({ type: "finite", title: "Leaf", done: true });
  assert(completionState([leaf], leaf) === "done", "finite leaf done -> 'done'");

  // THE BUG D25 FIXES: cascade a course holding a half-logged routine
  const course = makeTask({ type: "finite", title: "Course" });
  const reading = makeTask({ type: "finite", title: "Reading", parentId: course.id });
  const slides = { ...half, id: "r1", parentId: course.id };
  const exam = makeTask({ type: "event", title: "Midterm", parentId: course.id });
  const tasks = [course, reading, slides, exam];
  const logBefore = JSON.stringify(slides.log);

  setDoneCascade(tasks, course.id, true);

  assert(reading.done === true, "cascade still marks finite descendants done (D25)");
  assert(slides.done === false, "cascade does NOT write done onto a routine (D25)");
  assert(JSON.stringify(slides.log) === logBefore, "cascade does NOT bulk-close a routine's log (D25)");
  assert(exam.done === false, "cascade still skips events (D23)");
  assert(completionState(tasks, slides) === "partial", "the half-logged routine still reads 'partial'");
  assert(
    completionState(tasks, course) === "partial",
    "the course reads 'partial' after the tick — not a fabricated 'done' (D25)"
  );
  assert(effectiveDone(tasks, course) === false, "course is not effectiveDone while sessions are unlogged");
}

// D25: rounding must not fake a 'done'
{
  const rec = { days: [1, 2, 3, 4, 5], time: "09:00", durationMin: 30, start: "2026-01-05", end: "2026-12-31" };
  const probe = makeTask({ type: "routine", title: "Daily", recurrence: rec });
  const occ = expandOccurrences(probe);
  const allButOne = { ...probe, log: Object.fromEntries(occ.slice(0, occ.length - 1).map(o => [o.date, "done"])) };
  assert(progressOf([allButOne], allButOne) === 100, "n-1 of n occurrences rounds UP to 100%");
  assert(
    completionState([allButOne], allButOne) === "partial",
    "…but completionState still says 'partial' — rounding never fakes 'done' (D25)"
  );
}

// D24: a parentId cycle must not blow the stack
{
  const a = makeTask({ type: "finite", title: "A" });
  const b = makeTask({ type: "finite", title: "B", parentId: a.id });
  a.parentId = b.id;                       // cycle: a -> b -> a
  const tasks = [a, b];
  let crashed = false, pct = null, eff = null;
  try {
    pct = progressOf(tasks, a);
    eff = effectiveDone(tasks, a);
    setDoneCascade(tasks, a.id, true);
  } catch (e) { crashed = true; }
  assert(!crashed, "parentId cycle does not throw (D24 cycle guard)");
  assert(typeof pct === "number" && pct >= 0 && pct <= 100, "progressOf returns a sane number on a cycle");
  assert(eff === false, "effectiveDone never claims done from a cycle");
}

// D24 guard is invisible to correct data: deep chain still rolls up
{
  const p = makeTask({ type: "finite", title: "P" });
  const mid = makeTask({ type: "finite", title: "Mid", parentId: p.id });
  const g1 = makeTask({ type: "finite", title: "G1", parentId: mid.id, done: true });
  const g2 = makeTask({ type: "finite", title: "G2", parentId: mid.id, done: false });
  const tasks = [p, mid, g1, g2];
  assert(progressOf(tasks, p) === 50, "cycle guard does not disturb normal grandchild rollup (50)");
  assert(effectiveDone(tasks, p) === false, "cycle guard does not disturb normal effectiveDone");
}

// childrenOf, occurrenceStatus, breakdownOf sanity
{
  const parent = makeTask({ type: "finite", title: "Course" });
  const child = makeTask({ type: "finite", title: "Sub", parentId: parent.id });
  assert(childrenOf([parent, child], parent.id).length === 1, "childrenOf returns direct children only");

  const routine = makeTask({
    type: "routine", title: "Prepare slides",
    recurrence: { days: [1], time: "09:00", durationMin: 60, start: "2026-01-05", end: "2026-01-12" },
    log: { "2026-01-05": "done" },
  });
  assert(occurrenceStatus(routine, "2026-01-05") === "done", "occurrenceStatus returns logged status");
  assert(occurrenceStatus(routine, "2026-01-12") === "planned", "occurrenceStatus defaults to 'planned'");

  const course = makeTask({ type: "finite", title: "Course" });
  const paper = makeTask({ type: "finite", title: "Sub", parentId: course.id, done: true });
  const bd = breakdownOf([course, paper, routine], course);
  assert(bd.deliverablesPct === 100, "breakdownOf deliverablesPct reflects finite children");
}

// D31: isOverdue is pure, leaf-only; effectiveDone suppresses it (task 2.A4)
{
  const today = "2026-07-16";

  const leaf = makeTask({ type: "finite", title: "Late leaf", deadline: "2026-07-10" });
  assert(isOverdue([leaf], leaf, today) === true, "D31: finite leaf, past deadline, not done -> true");

  const doneLeaf = makeTask({ type: "finite", title: "Late but done", deadline: "2026-07-10", done: true });
  assert(isOverdue([doneLeaf], doneLeaf, today) === false, "D31: same leaf done -> false (effectiveDone suppresses)");

  // Leaf-only: the container has no deadline of its own; its child being overdue must NOT lift it.
  const container = makeTask({ type: "finite", title: "Course" });
  const lateChild = makeTask({ type: "finite", title: "Late child", parentId: container.id, deadline: "2026-07-10" });
  const tasks = [container, lateChild];
  assert(isOverdue(tasks, lateChild, today) === true, "D31: the overdue child itself reads true");
  assert(isOverdue(tasks, container, today) === false, "D31: container with an overdue child -> false (leaf-only, never climbs)");

  const ev = makeTask({ type: "event", title: "Past meeting", start: "2026-07-01T10:00", end: "2026-07-01T11:00" });
  assert(isOverdue([ev], ev, today) === false, "D31: event with a past start -> false (events are never overdue)");

  const routine = makeTask({
    type: "routine", title: "Old routine",
    recurrence: { days: [1], time: "09:00", durationMin: 60, start: "2026-01-05", end: "2026-01-12" },
  });
  assert(isOverdue([routine], routine, today) === false, "D31: routine -> false (routines are never overdue)");

  const noDeadline = makeTask({ type: "finite", title: "No deadline" });
  assert(isOverdue([noDeadline], noDeadline, today) === false, "D31: finite with no deadline -> false");
}

// --- 1.4 v1 -> v2 migration ---

{
  const v1 = {
    tasks: [
      { id: "t1", title: "Old finite task", due: "2026-05-01", pri: "high", done: false, parentId: null, createdAt: 1700000000000 },
      { id: "t2", title: "Old child task", due: "", pri: "low", done: true, parentId: "t1", createdAt: 1700000100000 },
    ],
    slots: [{ id: "s1", date: "2026-02-03", hour: 9, taskId: "t1" }],
  };

  const migrated = migrate(v1);

  assert(migrated.version === 1, "migrate(): v1 blob yields version 1");
  assert(migrated.tasks.length === 2 && migrated.slots.length === 1, "migrate(): task/slot counts preserved");
  assert(
    migrated.tasks.every(t => t.type === "finite" && t.owner === "me" && t.weight === 1 && JSON.stringify(t.log) === "{}"),
    "migrate(): every task gets type='finite', owner='me', weight=1, log={}"
  );
  assert(
    migrated.tasks.every(t => JSON.stringify(t.exceptions) === "{}"),
    "migrate()/D36: every v1 task is default-filled with exceptions={}"
  );
  const [m1, m2] = migrated.tasks;
  assert(m1.priority === "high" && m1.deadline === "2026-05-01" && m1.done === false, "migrate(): pri/due renamed to priority/deadline, done preserved");
  assert(m2.priority === "low" && m2.deadline === null && m2.done === true, "migrate(): blank due -> null deadline");
  assert(m1.parentId === null && m2.parentId === "t1", "migrate(): parentId preserved");
  assert(m1.color === DEFAULT_COLOR.finite && m1.recurrence === null && m1.allDay === false && m1.start === null && m1.end === null && m1.location === "", "migrate(): missing type fields default per 03");
  assert(migrated.slots[0].owner === "me" && migrated.slots[0].taskId === "t1", "migrate(): slots gain owner='me'");
  assert(
    migrated.slots[0].start === "09:00" && migrated.slots[0].durationMin === 60 && !("hour" in migrated.slots[0]),
    "migrate()/D30: v1 slot hour:9 -> start:'09:00' (zero-padded), durationMin:60, no `hour` key"
  );
  {
    const preShaped = migrate({
      tasks: [{ id: "t1", title: "x" }],
      slots: [{ id: "s2", date: "2026-02-04", start: "14:30", durationMin: 90, taskId: "t1" }],
    });
    assert(
      preShaped.slots[0].start === "14:30" && preShaped.slots[0].durationMin === 90,
      "migrate()/D30: a slot already carrying `start` is left as-is"
    );
  }
  assert(migrated.settings.providerType === "local" && migrated.settings.sheetUrl === "", "migrate(): settings filled with defaults when missing");

  const migratedTwice = migrate(migrated);
  assert(JSON.stringify(migratedTwice) === JSON.stringify(migrated), "migrate(): running migrate twice equals running it once (idempotent)");

  const alreadyV2 = makeAppState();
  alreadyV2.tasks.push(makeTask({ type: "routine", title: "Untouched" }));
  const untouched = migrate(alreadyV2);
  assert(JSON.stringify(untouched) === JSON.stringify(alreadyV2), "migrate(): a current-version state is left untouched");
}

// --- 6.C1 settings.token (D43) ---

{
  assert(makeAppState().settings.token === "", "6.C1: makeAppState() defaults settings.token to ''");

  const preD43V2 = { version: 1, tasks: [], slots: [], settings: { providerType: "local", sheetUrl: "" } };
  const filled = migrate(preD43V2);
  assert(filled.settings.token === "", "6.C1: migrate() fills settings.token='' on a pre-D43 v2 blob");
  assert(
    filled.settings.providerType === "local" && filled.settings.sheetUrl === "",
    "6.C1: migrate() preserves the other pre-existing settings fields while filling token"
  );

  const withRealToken = { version: 1, tasks: [], slots: [], settings: { providerType: "sheets", sheetUrl: "https://script.google.com/x", token: "real-secret" } };
  const preserved = migrate(withRealToken);
  assert(preserved.settings.token === "real-secret", "6.C1: migrate() never clobbers an existing real settings.token");

  const preD43V1 = {
    tasks: [{ id: "t1", title: "Old", due: "", pri: "low", done: false, parentId: null, createdAt: 1700000000000 }],
    slots: [],
    settings: { sheetUrl: "https://old" },
  };
  const migratedV1 = migrate(preD43V1);
  assert(migratedV1.settings.token === "" && migratedV1.settings.sheetUrl === "https://old", "6.C1: migrate() fills token='' on the legacy v1->v2 upgrade path too");
}

// --- 6.C2 migrate()'s version-type guard (closes the standing OPEN watch-item) ---

{
  const fullV2Task = makeTask({
    type: "routine",
    title: "Full v2 routine",
    recurrence: { freq: "weekly", days: [5], time: "09:00" },
    log: { "2026-01-02": true, "2026-01-09": false },
  });
  const stringVersionState = {
    version: "1",
    tasks: [fullV2Task],
    slots: [],
    settings: { providerType: "local", sheetUrl: "", token: "" },
  };
  const migratedStringVersion = migrate(stringVersionState);
  assert(
    migratedStringVersion.tasks.length === 1 && migratedStringVersion.tasks[0].type === "routine",
    "6.C2: migrate() on version:'1' does NOT flatten a routine task to type:'finite'"
  );
  assert(
    JSON.stringify(migratedStringVersion.tasks[0].log) === JSON.stringify(fullV2Task.log),
    "6.C2: migrate() on version:'1' does NOT wipe the routine's log"
  );
  assert(
    JSON.stringify(migratedStringVersion.tasks[0].recurrence) === JSON.stringify(fullV2Task.recurrence),
    "6.C2: migrate() on version:'1' does NOT null the task's recurrence"
  );
  assert(
    migratedStringVersion.tasks[0].start === fullV2Task.start && migratedStringVersion.tasks[0].end === fullV2Task.end,
    "6.C2: migrate() on version:'1' does NOT null start/end"
  );

  const realV1Blob = {
    tasks: [{ id: "t1", title: "Old", due: "2026-05-01", pri: "high", done: false, parentId: null, createdAt: 1700000000000 }],
    slots: [{ id: "s1", date: "2026-05-01", hour: 9, taskId: "t1" }],
  };
  const migratedRealV1 = migrate(realV1Blob);
  assert(
    migratedRealV1.tasks[0].type === "finite" && migratedRealV1.tasks[0].priority === "high",
    "6.C2 regression: a real v1 blob (no version key at all) still migrates normally"
  );

  const zeroVersion = migrate({ version: 0, tasks: [], slots: [], settings: {} });
  assert(
    zeroVersion.version === 1 && Array.isArray(zeroVersion.tasks),
    "6.C2: version:0 (genuinely invalid) still routes to legacy migration"
  );

  const garbageVersion = migrate({ version: "abc", tasks: [], slots: [], settings: {} });
  assert(
    garbageVersion.version === 1 && Array.isArray(garbageVersion.tasks),
    "6.C2: version:'abc' (genuinely non-numeric) still routes to legacy migration"
  );
}

// --- 1.3 Storage layer & providers ---

assert(STORAGE_KEY === "ledger.state", "STORAGE_KEY matches the locked 03 constant");

// StorageProvider base: every method throws "not implemented"
{
  const base = new StorageProvider();
  const results = await Promise.allSettled([
    base.authenticate(), base.load(), base.save(makeAppState()),
  ]);
  assert(
    results.every(r => r.status === "rejected" && r.reason.message === "not implemented"),
    "StorageProvider base methods all throw 'not implemented'"
  );
}

// SheetsProvider.save — real network client, mocked fetch (6.P3; Google is unreachable from this
// dev container, so every assertion here drives an injected fetch, never a real one).
{
  let received = null;
  const okFetch = async (url, opts) => {
    received = { url, opts };
    return { json: async () => ({ ok: true }) };
  };
  const state = makeAppState();
  state.version = 3;
  state.tasks = [{ id: "t1", owner: "me" }];
  state.slots = [{ id: "s1" }];
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", token: "secret", fetch: okFetch });
  const result = await sheets.save(state);
  assert(result === true, "6.P3: save() resolves true on mocked {ok:true}");
  assert(received.opts.method === "POST", "6.P3: request is a POST");
  assert(
    received.opts.headers["Content-Type"] === "text/plain;charset=utf-8",
    "6.P3: request carries the exact Content-Type header from 03 Part C"
  );
  const sentBody = JSON.parse(received.opts.body);
  assert(sentBody.action === "save", "6.P3: request body has action:'save'");
  assert(sentBody.token === "secret", "6.P3: request body carries the token");
  assert(sentBody.version === 3, "6.P3: request body carries state.version");
  assert(Array.isArray(sentBody.tasks) && sentBody.tasks.length === 1 && sentBody.tasks[0].id === "t1", "6.P3: request body carries state.tasks");
  assert(Array.isArray(sentBody.slots) && sentBody.slots.length === 1 && sentBody.slots[0].id === "s1", "6.P3: request body carries state.slots");
  assert(!("settings" in sentBody), "6.P3: request body NEVER carries settings (D26 rule 4 / D43)");
}

// A state with slots set to a non-array -> save() throws WITHOUT calling fetch (client-side guard).
{
  let fetchCalls = 0;
  const countingFetch = async () => {
    fetchCalls++;
    return { json: async () => ({ ok: true }) };
  };
  const state = makeAppState();
  state.tasks = [];
  state.slots = "not-an-array";
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", token: "t", fetch: countingFetch });
  let threw = false;
  try {
    await sheets.save(state);
  } catch {
    threw = true;
  }
  assert(threw === true, "6.P3: save() throws when state.slots is not an array");
  assert(fetchCalls === 0, "6.P3: save() never calls fetch when the client-side guard rejects the payload");
}

// {ok:false,error} -> save() throws surfacing that message.
{
  const failFetch = async () => ({ json: async () => ({ ok: false, error: "unauthorized" }) });
  const state = makeAppState();
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", token: "t", fetch: failFetch });
  let caught = null;
  try {
    await sheets.save(state);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof Error && caught.message === "unauthorized", "6.P3: save() throws surfacing the server's error message on {ok:false}");
}

// SheetsProvider.authenticate — real network client, mocked fetch (6.P1; Google is unreachable
// from this dev container, so every assertion here drives an injected fetch, never a real one).
{
  let received = null;
  const okFetch = async (url, opts) => {
    received = { url, opts };
    return { json: async () => ({ ok: true, version: 1, tasks: [], slots: [] }) };
  };
  const sheets = new SheetsProvider({
    execUrl: "https://example.invalid/exec",
    token: "secret",
    fetch: okFetch,
  });
  const result = await sheets.authenticate();
  assert(result === true, "6.P1: authenticate() resolves true on mocked {ok:true,...}");
  assert(sheets.token === "secret", "6.P1: authenticate() remembers the accepted token as this.token");
  assert(received.url === "https://example.invalid/exec", "6.P1: request goes to this.execUrl");
  assert(received.opts.method === "POST", "6.P1: request is a POST");
  assert(
    received.opts.headers["Content-Type"] === "text/plain;charset=utf-8",
    "6.P1: request carries the exact Content-Type header from 03 Part C"
  );
  const sentBody = JSON.parse(received.opts.body);
  assert(sentBody.action === "load", "6.P1: request body has action:'load'");
  assert(sentBody.token === "secret", "6.P1: request body carries the token");
  assert(!received.url.includes("secret"), "6.P1: the token never appears in the URL/query string");
}

// authenticate(passphrase) — an explicit passphrase argument overrides the constructor's token.
{
  let received = null;
  const okFetch = async (url, opts) => {
    received = opts;
    return { json: async () => ({ ok: true }) };
  };
  const sheets = new SheetsProvider({
    execUrl: "https://example.invalid/exec",
    token: "fallback",
    fetch: okFetch,
  });
  const result = await sheets.authenticate("explicit");
  assert(result === true, "6.P1: authenticate(passphrase) resolves true on {ok:true}");
  assert(sheets.token === "explicit", "6.P1: an explicit passphrase argument overrides the constructor's token");
  assert(JSON.parse(received.body).token === "explicit", "6.P1: the explicit passphrase is what gets sent");
}

// {ok:false,...} -> authenticate() resolves false (never throws).
{
  const failFetch = async () => ({ json: async () => ({ ok: false, error: "unauthorized" }) });
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", fetch: failFetch });
  const result = await sheets.authenticate("badtoken");
  assert(result === false, "6.P1: authenticate() resolves false on mocked {ok:false,...}");
}

// A rejected/thrown fetch -> authenticate() resolves false, does not throw.
{
  const throwFetch = async () => {
    throw new Error("network down");
  };
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", fetch: throwFetch });
  let threw = false;
  let result;
  try {
    result = await sheets.authenticate("t");
  } catch {
    threw = true;
  }
  assert(threw === false, "6.P1: authenticate() itself never throws on a rejected fetch");
  assert(result === false, "6.P1: a rejected/thrown fetch resolves authenticate() to false");
}

// SheetsProvider.load — real network client, mocked fetch (6.P2; Google is unreachable from this
// dev container, so every assertion here drives an injected fetch, never a real one).
{
  const okFetch = async () => ({
    json: async () => ({ ok: true, version: 2, tasks: [{ id: "t1" }], slots: [{ id: "s1" }] }),
  });
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", token: "t", fetch: okFetch });
  const result = await sheets.load();
  assert(
    result.version === 2 &&
      Array.isArray(result.tasks) && result.tasks.length === 1 && result.tasks[0].id === "t1" &&
      Array.isArray(result.slots) && result.slots.length === 1 && result.slots[0].id === "s1" &&
      Object.keys(result).sort().join(",") === "slots,tasks,version",
    "6.P2: load() resolves exactly {version, tasks, slots} on a valid {ok:true,...} reply"
  );
}

// {ok:false,...} -> load() throws (never a silently-empty result).
{
  const failFetch = async () => ({ json: async () => ({ ok: false, error: "unauthorized" }) });
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", token: "t", fetch: failFetch });
  let threw = false;
  try {
    await sheets.load();
  } catch {
    threw = true;
  }
  assert(threw === true, "6.P2: load() throws on {ok:false,...} (test asserts a catch fires)");
}

// A malformed {ok:true,...} reply (non-array tasks) -> load() also throws.
{
  const malformedFetch = async () => ({
    json: async () => ({ ok: true, version: 1, tasks: "not-an-array", slots: [] }),
  });
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", token: "t", fetch: malformedFetch });
  let threw = false;
  try {
    await sheets.load();
  } catch {
    threw = true;
  }
  assert(threw === true, "6.P2: load() throws on a malformed reply (tasks is not an array)");
}

// LocalStorageProvider round-trip WITH a real localStorage present (mocked, since Node has none)
{
  class FakeLocalStorage {
    #data = new Map();
    getItem(k) { return this.#data.has(k) ? this.#data.get(k) : null; }
    setItem(k, v) { this.#data.set(k, String(v)); }
    removeItem(k) { this.#data.delete(k); }
  }
  globalThis.localStorage = new FakeLocalStorage();

  const provider = new LocalStorageProvider();
  assert(await provider.authenticate() === true, "LocalStorageProvider.authenticate() returns true");

  const fresh = await provider.load();
  assert(
    fresh.version === 1 && fresh.tasks.length === 0 && fresh.slots.length === 0,
    "LocalStorageProvider.load() with nothing stored yields a fresh empty AppState"
  );

  const seeded = makeAppState();
  seeded.tasks.push(makeTask({ type: "finite", title: "Round-trip me" }));
  assert(await provider.save(seeded) === true, "LocalStorageProvider.save() returns true");

  const loaded = await provider.load();
  assert(
    JSON.stringify(loaded) === JSON.stringify(seeded),
    "save() then load() round-trips an AppState via real localStorage"
  );

  delete globalThis.localStorage;
}

// LocalStorageProvider round-trip WITHOUT localStorage available (the _mem fallback)
{
  assert(typeof globalThis.localStorage === "undefined", "localStorage is unavailable for this block (simulated)");

  const provider = new LocalStorageProvider();
  const seeded = makeAppState();
  seeded.tasks.push(makeTask({ type: "routine", title: "Fallback me" }));
  assert(await provider.save(seeded) === true, "save() succeeds via the _mem fallback when localStorage throws");

  const loaded = await provider.load();
  // Compare against an EXPECTED snapshot taken before save(), never against the object handed to
  // save() — pre-D28 `_mem` aliased that object, so comparing it to itself passed by construction
  // and would have passed even if save() were a no-op.
  const expected = JSON.parse(JSON.stringify(seeded));
  assert(
    JSON.stringify(loaded) === JSON.stringify(expected),
    "save() then load() round-trips an AppState via the _mem fallback"
  );
  assert(loaded !== seeded, "D28.2: _mem load() returns a COPY, not the caller's live object");

  // The real proof the fallback stores a snapshot: mutate the caller's object after save().
  seeded.tasks[0].title = "MUTATED AFTER SAVE";
  const reloaded = await provider.load();
  assert(
    reloaded.tasks[0].title === "Fallback me",
    "D28.2: mutating the caller's object after save() does NOT change what load() returns"
  );
}

// --- D28 regressions (raised by the 1.3 review) ---

// D28.1 — localStorage READABLE but NOT writable (quota exceeded / Safari private browsing).
// Pre-D28 this was the silent-data-loss case: set() threw, the value went to _mem, save() returned
// true, and load() read localStorage successfully and never consulted _mem → a FRESH EMPTY STATE.
{
  class QuotaFullStorage {
    #data = new Map();
    getItem(k) { return this.#data.has(k) ? this.#data.get(k) : null; }
    setItem() { throw new Error("QuotaExceededError"); }  // reads fine, writes always refused
    removeItem(k) { this.#data.delete(k); }
  }
  globalThis.localStorage = new QuotaFullStorage();

  const provider = new LocalStorageProvider();
  const seeded = makeAppState();
  seeded.tasks.push(makeTask({ type: "finite", title: "Survive the quota" }));
  assert(await provider.save(seeded) === true, "D28.1: save() returns true when the write is refused (held in _mem)");

  const loaded = await provider.load();
  assert(
    JSON.stringify(loaded) === JSON.stringify(JSON.parse(JSON.stringify(seeded))),
    "D28.1: load() returns the SAVED state, not a stale/empty one, when localStorage is readable-but-unwritable"
  );
  assert(loaded.tasks.length === 1, "D28.1: the refused write is not silently lost");

  delete globalThis.localStorage;
}

// D28.1b — a buffered (refused) write must not shadow a LATER successful write.
{
  class FlakyStorage {
    #data = new Map();
    refuse = true;
    getItem(k) { return this.#data.has(k) ? this.#data.get(k) : null; }
    setItem(k, v) { if (this.refuse) throw new Error("QuotaExceededError"); this.#data.set(k, String(v)); }
    removeItem(k) { this.#data.delete(k); }
  }
  const store = new FlakyStorage();
  globalThis.localStorage = store;

  const provider = new LocalStorageProvider();
  const first = makeAppState();
  first.tasks.push(makeTask({ type: "finite", title: "buffered" }));
  await provider.save(first);                     // refused → buffered in _mem

  store.refuse = false;                           // quota freed up
  const second = makeAppState();
  second.tasks.push(makeTask({ type: "finite", title: "persisted" }));
  await provider.save(second);                    // lands in localStorage; _mem entry must be dropped

  const loaded = await provider.load();
  assert(
    loaded.tasks[0].title === "persisted",
    "D28.1b: once a real write lands, the stale _mem buffer is dropped and does not shadow it"
  );

  delete globalThis.localStorage;
}

// D28.3 — a corrupt blob is PRESERVED and raises, never degrading into an empty state that the
// next save() would make permanent.
{
  class FakeLocalStorage {
    #data = new Map();
    getItem(k) { return this.#data.has(k) ? this.#data.get(k) : null; }
    setItem(k, v) { this.#data.set(k, String(v)); }
    removeItem(k) { this.#data.delete(k); }
  }
  const store = new FakeLocalStorage();
  store.setItem(STORAGE_KEY, '{"tasks":[{"id":"t1","titl');   // truncated mid-write
  globalThis.localStorage = store;

  const provider = new LocalStorageProvider();

  let err = null;
  try { await provider.load(); } catch (e) { err = e; }
  assert(err instanceof StorageCorruptError, "D28.3: load() on a corrupt blob throws StorageCorruptError");
  assert(
    err && !("tasks" in Object(err.state ?? {})),
    "D28.3: load() does NOT return a fresh empty state on corruption"
  );
  assert(
    store.getItem(STORAGE_KEY + CORRUPT_SUFFIX) === '{"tasks":[{"id":"t1","titl',
    "D28.3: the unparseable blob is preserved verbatim under <key>.corrupt"
  );

  // ...and the corrupt key is write-locked, so a caller cannot casually overwrite the evidence.
  let writeErr = null;
  try { await provider.save(makeAppState()); } catch (e) { writeErr = e; }
  assert(writeErr instanceof StorageCorruptError, "D28.3: save() refuses to overwrite a preserved-corrupt key");

  // force:true is the deliberate 'discard the unreadable blob' action.
  const fresh = makeAppState();
  fresh.tasks.push(makeTask({ type: "finite", title: "after recovery" }));
  assert(await provider.save(fresh, { force: true }) === true, "D28.3: save({force:true}) recovers from corruption");
  const loaded = await provider.load();
  assert(loaded.tasks[0].title === "after recovery", "D28.3: after a forced save, load() works again");
  assert(
    store.getItem(STORAGE_KEY + CORRUPT_SUFFIX) === '{"tasks":[{"id":"t1","titl',
    "D28.3: the preserved blob survives the forced recovery"
  );

  delete globalThis.localStorage;
}

// --- 1.5 Sample seed data ---

{
  const seed = sampleState();

  assert(
    seed.version === 1 && Array.isArray(seed.tasks) && Array.isArray(seed.slots) &&
      seed.settings.providerType === "local" && seed.settings.sheetUrl === "",
    "sampleState() yields a valid AppState shape"
  );
  assert(
    seed.tasks.every(t => JSON.stringify(Object.keys(t).sort()) === JSON.stringify(EXPECTED_TASK_FIELDS)),
    "sampleState(): every task has the full 03 Part A field set"
  );
  assert(
    seed.slots.every(s => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(["date", "durationMin", "id", "owner", "start", "taskId"])),
    "sampleState(): every slot has the full D30 Slot field set"
  );

  const course = seed.tasks.find(t => t.title === "CS 402: Distributed Systems");
  const slides = seed.tasks.find(t => t.title === "Prepare slides");
  const markAssignment = seed.tasks.find(t => t.title === "Mark assignment");
  const midterm = seed.tasks.find(t => t.title === "Midterm exam");
  const final = seed.tasks.find(t => t.title === "Final exam");
  const paper = seed.tasks.find(t => t.title === "CHI paper");
  const review = seed.tasks.find(t => t.title === "Review");
  const design = seed.tasks.find(t => t.title === "Design");
  const experiment = seed.tasks.find(t => t.title === "Experiment");
  const meeting = seed.tasks.find(t => t.title === "Dept meeting");

  assert(
    [course, slides, markAssignment, midterm, final, paper, review, design, experiment, meeting].every(Boolean),
    "sampleState(): every expected sample record is present"
  );

  assert(progressOf(seed.tasks, paper) === 67, "sampleState(): Paper progress (Review+Design done, Experiment not) -> 67");

  // 7.A1 sub-step 3: this assertion used to read
  //     progressOf(...) === Math.round((100 * slidesDone) / slidesOcc.length)
  // where slidesDone/slidesOcc came from the SAME expandOccurrences + occurrenceStatus calls that
  // progressOf makes internally — it restated the implementation and passed at any occurrence
  // count, so it could not fail. Replaced with the literal values the seed is pinned to produce:
  // the window is deliberately built to hold exactly 16 Mondays with the first 8 marked done on
  // EVERY weekday (see js/sample-data.js's slidesStart/slidesEnd comment), so these are constants,
  // not whatever the fixture happens to emit today.
  const slidesOcc = expandOccurrences(slides);
  const slidesDone = slidesOcc.filter(o => occurrenceStatus(slides, o.date) === "done").length;
  assert(
    slidesOcc.length === 16 && slidesDone === 8 && progressOf(seed.tasks, slides) === 50,
    `sampleState(): the slides routine is exactly 8 done of 16 Mondays -> 50% (got ${slidesDone}/${slidesOcc.length} -> ${progressOf(seed.tasks, slides)}%)`
  );

  assert(
    course.color === "blue" && slides.color === "blue" && markAssignment.color === "blue" &&
      midterm.color === "blue" && final.color === "blue",
    "sampleState(): course + its routines + its exams all share color 'blue'"
  );
  assert(paper.color === "violet", "sampleState(): paper is color 'violet'");

  assert(
    midterm.type === "event" && midterm.parentId === course.id &&
      final.type === "event" && final.parentId === course.id,
    "sampleState(): both exams are type:'event' attached to the course via parentId"
  );

  const withoutExams = seed.tasks.filter(t => t.id !== midterm.id && t.id !== final.id);
  assert(
    progressOf(seed.tasks, course) === progressOf(withoutExams, course),
    "sampleState(): course progress is unchanged whether or not the attached exams are present"
  );

  // --- 2.A5: Option-A "Mark assignment" + a multi-length slot ---

  // Dates are computed relative to "today" (sample-data.js), not literal — assert structure
  // (5 Fridays, 3-week spacing) rather than exact hardcoded values.
  const markOcc = expandOccurrences(markAssignment).map(o => o.date);
  assert(
    markOcc.length === 5 && markOcc.every(d => new Date(d + "T00:00:00").getDay() === 5),
    "sampleState() 2.A5: 'Mark assignment' occurrences are five Fridays"
  );
  assert(
    markOcc.every((d, i) => i === 0 || (new Date(d) - new Date(markOcc[i - 1])) / 86400000 === 21),
    "sampleState() 2.A5: the five Option-A assignment Fridays are spaced 3 weeks apart"
  );
  const everyFriday = expandOccurrences({ ...markAssignment, exceptions: {} });
  assert(
    markOcc.length < everyFriday.length,
    "sampleState() 2.A5: the Option-A set is sparser than the bare weekly rule yields"
  );
  assert(
    Object.keys(markAssignment.log).every(d => markOcc.includes(d)),
    "sampleState() 2.A5: every 'Mark assignment' log entry sits on a live (non-cancelled) occurrence"
  );
  assert(
    progressOf(seed.tasks, markAssignment) === 40,
    "sampleState() 2.A5: 'Mark assignment' progress is 2 of 5 Option-A occurrences -> 40"
  );
  assert(
    seed.tasks.every(t => typeof t.exceptions === "object" && t.exceptions !== null),
    "sampleState() 2.A5: every task carries an exceptions map (D36)"
  );
  assert(
    seed.slots.some(s => s.durationMin > 60),
    "sampleState() 2.A5: at least one slot is multi-length (durationMin > 60, D30)"
  );
  assert(
    seed.slots.every(s => seed.tasks.some(t => t.id === s.taskId)),
    "sampleState() 2.A5: every slot references a live task id"
  );
}

// --- 1.INT Boot integration (+ D29 legacy-v1 adoption + dev-only seed trigger) ---

function makeSpyStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = {};
  return {
    _data: data,
    _calls: calls,
    getItem(k) {
      calls[k] = (calls[k] || 0) + 1;
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
  };
}

// Cold boot, no data anywhere -> a valid empty v2 state.
{
  globalThis.localStorage = makeSpyStorage();
  const state = await boot({ search: "" });
  assert(
    state.version === 1 && state.tasks.length === 0 && state.slots.length === 0,
    "1.INT: cold boot with no data yields a valid empty v2 state"
  );
  delete globalThis.localStorage;
}

// No ?seed=1 -> the seed is never imported, even on an empty state.
{
  globalThis.localStorage = makeSpyStorage();
  const state = await boot({ search: "" });
  assert(state.tasks.length === 0, "1.INT: booting with no ?seed=1 never imports the seed");
  delete globalThis.localStorage;
}

// ?seed=1 on an EMPTY state loads the seed.
{
  globalThis.localStorage = makeSpyStorage();
  const state = await boot({ search: "?seed=1" });
  const seed = sampleState();
  assert(
    state.tasks.length === seed.tasks.length && state.slots.length === seed.slots.length,
    "1.INT: ?seed=1 on an empty state loads sampleState()"
  );
  delete globalThis.localStorage;
}

// ?seed=1 on a NON-EMPTY state does NOT overwrite it without explicit confirmation.
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;
  const seeded = makeAppState();
  seeded.tasks.push(makeTask({ type: "finite", title: "Real user data" }));
  storage.setItem(STORAGE_KEY, JSON.stringify(seeded));

  const refused = await boot({ search: "?seed=1", confirmOverwrite: () => false });
  assert(
    refused.tasks.length === 1 && refused.tasks[0].title === "Real user data",
    "1.INT: ?seed=1 on non-empty state, confirmation refused -> real data untouched"
  );

  const confirmed = await boot({ search: "?seed=1", confirmOverwrite: () => true });
  const seed = sampleState();
  assert(
    confirmed.tasks.length === seed.tasks.length,
    "1.INT: ?seed=1 on non-empty state, confirmation granted -> seed loads"
  );
  delete globalThis.localStorage;
}

// D29: boot with ONLY the three legacy v1 keys populated -> a fully migrated v2 state; ids and
// parentId intact; all three legacy keys still hold their ORIGINAL bytes afterwards.
{
  const v1Tasks = JSON.stringify([
    { id: "t1", title: "Legacy finite task", due: "2026-06-01", pri: "high", done: false, parentId: null, createdAt: 1700000000000 },
  ]);
  const v1Slots = JSON.stringify([{ id: "s1", date: "2026-02-03", hour: 9, taskId: "t1" }]);
  const v1Settings = JSON.stringify({ sheetUrl: "" });

  const storage = makeSpyStorage({
    [LEGACY_KEYS.tasks]: v1Tasks,
    [LEGACY_KEYS.slots]: v1Slots,
    [LEGACY_KEYS.settings]: v1Settings,
  });
  globalThis.localStorage = storage;

  const state = await boot({ search: "" });
  assert(state.version === 1, "1.INT/D29: adopted legacy state is a valid v2 AppState");
  assert(
    state.tasks.length === 1 && state.tasks[0].id === "t1" && state.tasks[0].type === "finite" &&
      state.tasks[0].owner === "me" && state.tasks[0].parentId === null,
    "1.INT/D29: legacy task is typed/owned, id/parentId preserved"
  );
  assert(
    state.slots.length === 1 && state.slots[0].taskId === "t1",
    "1.INT/D29: legacy slot preserved, taskId ref intact"
  );
  assert(
    state.slots[0].start === "09:00" && state.slots[0].durationMin === 60 && !("hour" in state.slots[0]),
    "1.INT/D29+D30: adopted legacy slot's hour:9 mapped to start:'09:00',durationMin:60 via migrate()"
  );
  assert(
    storage.getItem(LEGACY_KEYS.tasks) === v1Tasks &&
      storage.getItem(LEGACY_KEYS.slots) === v1Slots &&
      storage.getItem(LEGACY_KEYS.settings) === v1Settings,
    "1.INT/D29: all three legacy keys still hold their ORIGINAL bytes after adoption"
  );
  assert(
    storage.getItem(STORAGE_KEY) != null,
    "1.INT/D29: the adopted state was persisted under STORAGE_KEY (saveState ran once)"
  );

  // Second boot: STORAGE_KEY now present -> must NOT re-read the legacy keys at all.
  const callsBefore = { ...storage._calls };
  const secondState = await boot({ search: "" });
  assert(
    storage._calls[LEGACY_KEYS.tasks] === callsBefore[LEGACY_KEYS.tasks] &&
      storage._calls[LEGACY_KEYS.slots] === callsBefore[LEGACY_KEYS.slots] &&
      storage._calls[LEGACY_KEYS.settings] === callsBefore[LEGACY_KEYS.settings],
    "1.INT/D29: a second boot reads STORAGE_KEY and does NOT re-read the legacy keys"
  );
  assert(
    secondState.tasks.length === 1,
    "1.INT/D29: second boot returns the same adopted state, not a fresh empty one"
  );

  delete globalThis.localStorage;
}

// A corrupt STORAGE_KEY must still throw StorageCorruptError, never silently falling through
// to v1 adoption (D28 + D29 interaction).
{
  const storage = makeSpyStorage({
    [STORAGE_KEY]: '{"tasks":[{"id":"t1","titl', // truncated -> corrupt
    [LEGACY_KEYS.tasks]: JSON.stringify([
      { id: "t2", title: "Should NOT be adopted", due: "", pri: "low", done: false, parentId: null, createdAt: 1700000000000 },
    ]),
  });
  globalThis.localStorage = storage;

  let err = null;
  try { await boot({ search: "" }); } catch (e) { err = e; }
  assert(
    err instanceof StorageCorruptError,
    "1.INT: a corrupt ledger.state throws StorageCorruptError rather than silently adopting v1"
  );
  assert(
    storage._calls[LEGACY_KEYS.tasks] === undefined,
    "1.INT: a corrupt STORAGE_KEY never falls through to reading the legacy keys"
  );

  // Clean up the shared module-level _corrupt flag so it cannot leak into later tests/boots.
  await new LocalStorageProvider().save(makeAppState(), { force: true });
  delete globalThis.localStorage;
}

// D37 (2.A3): a corrupt LEGACY key is the opposite call — "nothing to adopt", never a boot-block.
// ledger.state absent + truncated ledger.tasks -> boot() proceeds to a fresh empty v2 state,
// adopts nothing, and the raw bytes are preserved under ledger.tasks.corrupt (by Store.get, D28.2).
{
  const corruptBytes = '[{"id":"t1","title":"trunc'; // truncated mid-write -> corrupt
  const storage = makeSpyStorage({
    [LEGACY_KEYS.tasks]: corruptBytes, // no STORAGE_KEY anywhere
  });
  globalThis.localStorage = storage;

  let state = null, err = null;
  try { state = await boot({ search: "" }); } catch (e) { err = e; }
  assert(err === null, "2.A3/D37: a corrupt legacy key never throws out of boot()");
  assert(
    state !== null && state.version === 1 && state.tasks.length === 0 && state.slots.length === 0,
    "2.A3/D37: boot on a corrupt legacy key yields a fresh empty v2 state (adopts nothing)"
  );
  assert(
    storage.getItem(LEGACY_KEYS.tasks + CORRUPT_SUFFIX) === corruptBytes,
    "2.A3/D37: the corrupt legacy bytes are preserved verbatim under ledger.tasks.corrupt"
  );
  assert(
    storage.getItem(LEGACY_KEYS.tasks) === corruptBytes,
    "2.A3/D37: the legacy key itself is left untouched (D29 read-only, free rollback)"
  );

  delete globalThis.localStorage;
}

// A mutation + saveState() + reload preserves it (through app.js's own state, not just storage.js).
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;

  await boot({ search: "" });
  const s = getState();
  s.tasks.push(makeTask({ type: "finite", title: "Added after boot" }));
  await saveState(s);

  // Simulate a fresh page load: a brand-new provider instance reading the same backing store.
  const reloaded = await new LocalStorageProvider().load();
  assert(
    reloaded.tasks.length === 1 && reloaded.tasks[0].title === "Added after boot",
    "1.INT: a mutation + saveState() + reload preserves it"
  );

  delete globalThis.localStorage;
}

// 2.INT: the exact onChange seam mountTasksView is wired to (app.js's exported
// `persistChange`, not a re-implementation) persists a mutation via saveState — proven by a
// fresh provider instance reading the same backing store, simulating a page reload.
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;

  await boot({ search: "" });
  const s = getState();
  s.tasks.push(makeTask({ type: "finite", title: "Added via onChange seam" }));
  persistChange(s); // fire-and-forget, exactly as mountTasksView's commit() calls it

  const reloaded = await new LocalStorageProvider().load();
  assert(
    reloaded.tasks.some((t) => t.title === "Added via onChange seam"),
    "2.INT: mountTasksView's onChange seam (app.js persistChange) persists a mutation via saveState"
  );

  delete globalThis.localStorage;
}

// --- 2.U4 deleteCascade (pure): descendants + referencing slots, no orphans ---
{
  // c (container) -> [c1 (finite) -> c1a (finite leaf)], c2 (finite leaf); plus a sibling s.
  const c = makeTask({ type: "finite", title: "container" });
  const c1 = makeTask({ type: "finite", title: "child1", parentId: c.id });
  const c1a = makeTask({ type: "finite", title: "grandchild", parentId: c1.id });
  const c2 = makeTask({ type: "finite", title: "child2", parentId: c.id });
  const sib = makeTask({ type: "finite", title: "sibling" }); // unrelated top-level
  const tasks = [c, c1, c1a, c2, sib];
  const slots = [
    makeSlot({ date: "2026-07-20", start: "09:00", durationMin: 60, taskId: c1a.id }), // under doomed subtree
    makeSlot({ date: "2026-07-20", start: "10:00", durationMin: 60, taskId: c2.id }),  // under doomed subtree
    makeSlot({ date: "2026-07-20", start: "11:00", durationMin: 60, taskId: sib.id }), // unrelated, must survive
  ];

  const out = deleteCascade(tasks, slots, c.id);
  assert(
    out.tasks.length === 1 && out.tasks[0].id === sib.id,
    "2.U4 deleteCascade: deleting a container removes it and every descendant"
  );
  assert(
    out.slots.length === 1 && out.slots[0].taskId === sib.id,
    "2.U4 deleteCascade: slots referencing any deleted task are removed; unrelated slots survive"
  );
  assert(
    out.tasks.every((t) => t.parentId === null || out.tasks.some((p) => p.id === t.parentId)),
    "2.U4 deleteCascade: no orphan parentId left behind"
  );
  assert(
    out.slots.every((s) => out.tasks.some((t) => t.id === s.taskId)),
    "2.U4 deleteCascade: no orphan slot.taskId left behind"
  );
  assert(
    tasks.length === 5 && slots.length === 3,
    "2.U4 deleteCascade: inputs are not mutated (returns new arrays)"
  );

  // Deleting a leaf drops only that leaf.
  const leafOut = deleteCascade(tasks, slots, c1a.id);
  assert(
    leafOut.tasks.length === 4 && !leafOut.tasks.some((t) => t.id === c1a.id) &&
      leafOut.slots.length === 2 && !leafOut.slots.some((s) => s.taskId === c1a.id),
    "2.U4 deleteCascade: deleting a leaf removes just that leaf and its slot"
  );
}

// --- 2.U4 add-subtask changes the parent's progressOf (leaf -> container rollup) ---
{
  const leaf = makeTask({ type: "finite", title: "was a leaf", done: true }); // done leaf = 100
  const tasks = [leaf];
  assert(progressOf(tasks, leaf) === 100, "2.U4 add-subtask: a done finite leaf reads 100 first");
  // Adding an undone subtask via makeTask turns it into a container whose rollup drops.
  const kid = makeTask({ type: "finite", title: "new subtask", parentId: leaf.id }); // undone = 0
  tasks.push(kid);
  assert(
    progressOf(tasks, leaf) === 0,
    "2.U4 add-subtask: adding an undone subtask makes the leaf a container that now rolls up from the child (100 -> 0)"
  );
  assert(
    kid.owner === "me" && JSON.stringify(kid.exceptions) === "{}" && kid.type === "finite",
    "2.U4 add-subtask: makeTask gives the new subtask owner:'me' and exceptions:{}"
  );
}

// --- 3.R1 validateRecurrence + recurrenceSummary ---
{
  const good = { days: [1], time: "09:00", durationMin: 120, start: "2026-01-12", end: "2026-05-01" };
  assert(
    JSON.stringify(validateRecurrence(good)) === JSON.stringify({ ok: true }),
    "3.R1 validateRecurrence: a valid rule passes"
  );
  assert(
    validateRecurrence({ ...good, days: [] }).error === "Pick at least one weekday.",
    "3.R1 validateRecurrence: empty days rejected with the weekday message"
  );
  assert(
    validateRecurrence({ ...good, time: "09:15" }).error === "Start time must be on a 30-minute boundary.",
    "3.R1 validateRecurrence: off-boundary time rejected with the boundary message"
  );
  assert(
    validateRecurrence({ ...good, durationMin: 45 }).error === "Length must be a positive multiple of 30 minutes.",
    "3.R1 validateRecurrence: non-30-multiple duration rejected with the length message"
  );
  assert(
    validateRecurrence({ ...good, start: "2026-05-01", end: "2026-01-12" }).error ===
      "Window end must be on or after the start.",
    "3.R1 validateRecurrence: end before start rejected with the window message"
  );
  assert(
    recurrenceSummary(good) === "Mon · 09:00 · 2h · 2026-01-12 – 2026-05-01",
    "3.R1 recurrenceSummary: the first rule formats exactly as spec'd"
  );
  assert(
    recurrenceSummary({ days: [5], time: "17:00", durationMin: 60, start: "2026-01-16", end: "2026-05-01" }) ===
      "Fri · 17:00 · 1h · 2026-01-16 – 2026-05-01",
    "3.R1 recurrenceSummary: the second rule formats exactly as spec'd"
  );
}

// --- 3.R2 occurrencesWithStatus + setOccurrenceStatus ---
{
  // Mirrors sample-data.js's "Prepare slides": Mondays 2026-01-12..2026-05-01, first 8 done.
  const rec = { days: [1], time: "09:00", durationMin: 120, start: "2026-01-12", end: "2026-05-01" };
  const slides = makeTask({ type: "routine", title: "Prepare slides", recurrence: rec });
  expandOccurrences(slides).slice(0, 8).forEach(o => { slides.log[o.date] = "done"; });
  const tasks = [slides];

  const rows = occurrencesWithStatus(slides);
  assert(rows.length === 16, "3.R2 occurrencesWithStatus: 16 Mondays in the window");
  assert(
    rows.filter(r => r.status === "done").length === 8 &&
      rows.filter(r => r.status === "planned").length === 8,
    "3.R2 occurrencesWithStatus: exactly 8 done + 8 planned"
  );
  assert(
    rows.every(r => new Date(r.date + "T00:00:00").getDay() === 1),
    "3.R2 occurrencesWithStatus: every row's date is a Monday"
  );
  assert(
    rows.every(r => "time" in r && "durationMin" in r && "status" in r),
    "3.R2 occurrencesWithStatus: each row carries {date,time,durationMin,status}"
  );

  assert(progressOf(tasks, slides) === 50, "3.R2 baseline: 8/16 done is 50%");

  const ninth = rows[8].date; // the 9th Monday, currently "planned"
  setOccurrenceStatus(tasks, slides.id, ninth, "done");
  assert(occurrenceStatus(slides, ninth) === "done", "3.R2 setOccurrenceStatus: writes 'done' into log");
  assert(progressOf(tasks, slides) === 56, "3.R2 setOccurrenceStatus: progress 50 -> 56 (round(100*9/16))");

  const tenth = rows[9].date;
  setOccurrenceStatus(tasks, slides.id, tenth, "skipped");
  assert(
    occurrenceStatus(slides, tenth) === "skipped" && progressOf(tasks, slides) === 56,
    "3.R2 setOccurrenceStatus: 'skipped' is logged but does not move progress (stays out of the numerator)"
  );

  setOccurrenceStatus(tasks, slides.id, ninth, "planned");
  assert(
    !(ninth in slides.log) && progressOf(tasks, slides) === 50,
    "3.R2 setOccurrenceStatus: 'planned' resets by deleting the log key"
  );

  const finiteTask = makeTask({ type: "finite", title: "Not a routine" });
  const beforeFinite = JSON.stringify(finiteTask);
  setOccurrenceStatus([finiteTask], finiteTask.id, "2026-01-12", "done");
  assert(
    JSON.stringify(finiteTask) === beforeFinite,
    "3.R2 setOccurrenceStatus: no-op on a non-routine id"
  );

  const strayDate = "2026-01-13"; // a Tuesday — never a live occurrence of a Monday-only rule
  setOccurrenceStatus(tasks, slides.id, strayDate, "done");
  assert(
    !(strayDate in slides.log),
    "3.R2 setOccurrenceStatus: no-op on a dateISO that is not a live occurrence"
  );

  // A cancelled date (exceptions[d] === null, D36) is likewise not live and must be guarded.
  const markAssignment = makeTask({
    type: "routine", title: "Mark assignment",
    recurrence: { days: [5], time: "17:00", durationMin: 60, start: "2026-01-16", end: "2026-02-06" },
  });
  const cancelledFriday = expandOccurrences(markAssignment)[0].date;
  markAssignment.exceptions[cancelledFriday] = null;
  setOccurrenceStatus([markAssignment], markAssignment.id, cancelledFriday, "done");
  assert(
    !(cancelledFriday in markAssignment.log),
    "3.R2 setOccurrenceStatus: no-op on a cancelled-via-exceptions date"
  );
}

// 3.INT: a routine created + one of its occurrences marked, both via the exact mutation path
// mountTasksView uses (state array mutation -> app.js's exported persistChange, the onChange
// seam commit() calls) -> saveState(), then a FRESH LocalStorageProvider instance (simulating a
// page reload) still has the recurrence and the log entry. Proves routine mutations round-trip
// through storage, not just through the held in-memory state.
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;

  await boot({ search: "" });
  const s = getState();

  const newRoutine = makeTask({
    type: "routine", title: "Water plants", parentId: null,
    recurrence: { days: [3], time: "08:00", durationMin: 30, start: "2026-08-01", end: "2026-09-01" },
  });
  s.tasks.push(newRoutine); // applyAdd's own mutation
  persistChange(s); // commit()'s onChange call

  const firstOcc = occurrencesWithStatus(newRoutine)[0].date;
  setOccurrenceStatus(s.tasks, newRoutine.id, firstOcc, "done"); // cycleOccurrence's own mutation
  persistChange(s); // commit()/cycleOccurrence's onChange call

  const reloaded = await new LocalStorageProvider().load();
  const found = reloaded.tasks.find((t) => t.id === newRoutine.id);
  assert(found !== undefined, "3.INT round-trip: the created routine survives a reload");
  assert(
    JSON.stringify(found.recurrence) === JSON.stringify(newRoutine.recurrence),
    "3.INT round-trip: the routine's recurrence is preserved byte-exact"
  );
  assert(
    found.log[firstOcc] === "done",
    "3.INT round-trip: the marked occurrence's log entry is preserved"
  );

  delete globalThis.localStorage;
}

// 3.INT: breakdownOf on the seed's course proves a container holds several routines with
// different cadences and their sessions sum together (01 acceptance) — "Prepare slides" (8/16)
// + "Mark assignment" (2/5, five due-Fridays after the D36 exceptions-cancel) -> 10/21.
{
  const state = sampleState();
  const course = state.tasks.find((t) => t.title === "CS 402: Distributed Systems");
  const bd = breakdownOf(state.tasks, course);
  assert(
    bd.sessionsDone === 10 && bd.sessionsTotal === 21,
    "3.INT breakdownOf: the seed course's two routines (8/16 + 2/5) sum to sessionsDone:10, sessionsTotal:21"
  );
}

// Seed determinism regression: the fixture derives every window from "today", so its occurrence
// counts must not depend on which weekday "today" lands on. They did — the old
// [today-49, today+63] slides window spanned 16 weeks + 1 day with both endpoints inheriting
// today's weekday, so it yielded 17 Mondays (not 16) every Monday, and the 3.INT assertion above
// failed one day in seven. Swept over 7 consecutive dates, which covers every weekday exactly once.
{
  const sweep = [];
  for (let i = 0; i < 7; i++) {
    const today = new Date(2026, 8, 28 + i).toLocaleDateString("en-CA"); // 2026-09-28 is a Monday
    const state = sampleState({ today });
    const course = state.tasks.find((t) => t.title === "CS 402: Distributed Systems");
    const slides = state.tasks.find((t) => t.title === "Prepare slides");
    const mark = state.tasks.find((t) => t.title === "Mark assignment");
    sweep.push({
      today,
      dow: new Date(today + "T00:00:00").getDay(),
      slides: expandOccurrences(slides).length,
      mark: expandOccurrences(mark).length,
      bd: breakdownOf(state.tasks, course),
      windowStart: slides.recurrence.start,
      windowEnd: slides.recurrence.end,
    });
  }

  assert(
    new Set(sweep.map((s) => s.dow)).size === 7,
    "seed determinism: the 7-date sweep covers every weekday exactly once"
  );
  assert(
    sweep.every((s) => s.slides === 16),
    "seed determinism: 'Prepare slides' expands to 16 Mondays on EVERY weekday (03 Part A canonical count)"
  );
  assert(
    sweep.every((s) => s.mark === 5),
    "seed determinism: 'Mark assignment' expands to 5 Option-A Fridays on EVERY weekday (D36 cancel)"
  );
  assert(
    sweep.every((s) => s.bd.sessionsDone === 10 && s.bd.sessionsTotal === 21),
    "seed determinism: the course breakdown is 10/21 on EVERY weekday, not just 6 days in 7"
  );
  // The specific case that was failing: "today" itself a Monday, i.e. the routine's own weekday.
  assert(
    sweep[0].dow === 1 && sweep[0].slides === 16 && sweep[0].bd.sessionsTotal === 21,
    "seed determinism: seeding ON a Monday yields 16 Mondays, not 17 (the original defect)"
  );
  // The property the window was always meant to have, now actually guaranteed.
  assert(
    sweep.every((s) => s.windowStart <= s.today && s.today <= s.windowEnd),
    "seed determinism: 'today' falls inside the slides window on every weekday"
  );
}

// --- 4.E1 validateEventTimes + eventSummary ---
{
  assert(
    validateEventTimes({ allDay: false, start: "2026-02-03T14:00", end: "2026-02-03T15:00", recurrence: null }).ok === true,
    "4.E1 validateEventTimes: a valid timed same-day event passes"
  );
  assert(
    validateEventTimes({ allDay: false, start: "2026-02-03T15:00", end: "2026-02-03T14:00", recurrence: null }).error ===
      "End must be after start.",
    "4.E1 validateEventTimes: timed end-before-start -> 'End must be after start.'"
  );
  assert(
    validateEventTimes({ allDay: false, start: "2026-02-03T14:00", end: "2026-02-03T14:00", recurrence: null }).error ===
      "End must be after start.",
    "4.E1 validateEventTimes: timed equal start/end is rejected (strict <)"
  );
  assert(
    validateEventTimes({ allDay: false, start: "2026-02-03 14:00", end: "2026-02-03T15:00", recurrence: null }).error ===
      "Start and end must be valid dates/times.",
    "4.E1 validateEventTimes: malformed timed start -> the format message"
  );
  assert(
    validateEventTimes({ allDay: true, start: "2026-03-12", end: "2026-03-10", recurrence: null }).error ===
      "End date must be on or after the start date.",
    "4.E1 validateEventTimes: all-day end-before-start -> the date-order message"
  );
  assert(
    validateEventTimes({ allDay: true, start: "2026-03-10", end: "2026-03-10", recurrence: null }).ok === true,
    "4.E1 validateEventTimes: all-day single-day (start===end) passes"
  );
  assert(
    validateEventTimes({ allDay: true, start: "03-10-2026", end: "2026-03-12", recurrence: null }).error ===
      "Start and end dates must be valid.",
    "4.E1 validateEventTimes: malformed all-day start -> the format message"
  );
  const badRecurrence = { days: [], time: "10:00", durationMin: 60, start: "2026-02-01", end: "2026-05-01" };
  // 7.A1 sub-step 4: kept as a delegation check (that IS the property — one source of the
  // message), but guarded so it cannot pass on a pair of undefineds. Without the non-empty
  // clause, a validateEventTimes that stopped validating recurrence entirely would still satisfy
  // `undefined === undefined`.
  assert(
    typeof validateRecurrence(badRecurrence).error === "string" &&
      validateRecurrence(badRecurrence).error.length > 0 &&
      validateEventTimes({ allDay: false, start: null, end: null, recurrence: badRecurrence }).error ===
        validateRecurrence(badRecurrence).error,
    "4.E1 validateEventTimes: a malformed recurrence delegates verbatim to validateRecurrence's own (non-empty) message"
  );
  const goodRecurrence = { days: [2], time: "10:00", durationMin: 60, start: "2026-02-01", end: "2026-05-01" };
  assert(
    validateEventTimes({ allDay: false, start: null, end: null, recurrence: goodRecurrence }).ok === true,
    "4.E1 validateEventTimes: a valid recurrence delegates to validateRecurrence and passes"
  );

  assert(
    eventSummary({ allDay: false, start: "2026-02-03T14:00", end: "2026-02-03T15:00", recurrence: null }) ===
      "2026-02-03 14:00–15:00",
    "4.E1 eventSummary: timed same-day -> '2026-02-03 14:00–15:00'"
  );
  assert(
    eventSummary({ allDay: false, start: "2026-02-03T22:00", end: "2026-02-04T01:00", recurrence: null }) ===
      "2026-02-03 22:00 – 2026-02-04 01:00",
    "4.E1 eventSummary: timed multi-day -> 'start – end' with T replaced by a space"
  );
  assert(
    eventSummary({ allDay: true, start: "2026-03-10", end: "2026-03-10", recurrence: null }) === "2026-03-10 (all day)",
    "4.E1 eventSummary: all-day single-day -> 'date (all day)'"
  );
  assert(
    eventSummary({ allDay: true, start: "2026-03-10", end: "2026-03-12", recurrence: null }) ===
      "2026-03-10 – 2026-03-12 (all day)",
    "4.E1 eventSummary: all-day multi-day -> 'start – end (all day)'"
  );
  const rec = { days: [2], time: "10:00", durationMin: 60, start: "2026-02-01", end: "2026-05-01" };
  assert(
    eventSummary({ allDay: false, start: null, end: null, recurrence: rec }) === recurrenceSummary(rec),
    "4.E1 eventSummary: recurring, non-all-day -> recurrenceSummary's own string, unsuffixed"
  );
  assert(
    eventSummary({ allDay: true, start: null, end: null, recurrence: rec }) === recurrenceSummary(rec) + " · all day",
    "4.E1 eventSummary: recurring, all-day -> recurrenceSummary suffixed with ' · all day'"
  );
}

// --- 4.E2 overrideEventOccurrence + cancelEventOccurrence ---
{
  const makeFixture = () => [makeTask({
    type: "event", title: "Weekly sync",
    recurrence: { days: [2], time: "10:00", durationMin: 60, start: "2026-02-03", end: "2026-03-03" },
  })];

  let tasks = makeFixture();
  const id = tasks[0].id;
  overrideEventOccurrence(tasks, id, "2026-02-10", { start: "2026-02-10T11:00", durationMin: 30 });
  let occ = expandOccurrences(tasks[0]);
  let patched = occ.find(o => o.date === "2026-02-10");
  assert(
    patched.start === "2026-02-10T11:00" && patched.durationMin === 30,
    "4.E2 overrideEventOccurrence: patched date carries the override fields"
  );
  assert(
    occ.filter(o => o.date !== "2026-02-10").every(o => o.time === "10:00" && o.durationMin === 60 && o.start === undefined),
    "4.E2 overrideEventOccurrence: every other Tuesday is unaffected"
  );
  assert(
    occ.map(o => o.date).join(",") === "2026-02-03,2026-02-10,2026-02-17,2026-02-24,2026-03-03",
    "4.E2 overrideEventOccurrence: no date added/removed by an override"
  );

  tasks = makeFixture();
  cancelEventOccurrence(tasks, tasks[0].id, "2026-02-17");
  occ = expandOccurrences(tasks[0]);
  assert(
    !occ.some(o => o.date === "2026-02-17") && occ.length === 4,
    "4.E2 cancelEventOccurrence: the cancelled date is entirely absent from expandOccurrences"
  );
  assert(
    tasks[0].exceptions["2026-02-17"] === null,
    "4.E2 cancelEventOccurrence: writes exceptions[date] = null"
  );

  // no-ops: non-recurring event, non-event task, unknown id
  tasks = [makeTask({ type: "event", title: "One-off", start: "2026-02-03T14:00", end: "2026-02-03T15:00" })];
  const before1 = JSON.stringify(tasks);
  overrideEventOccurrence(tasks, tasks[0].id, "2026-02-03", { location: "Room 1" });
  cancelEventOccurrence(tasks, tasks[0].id, "2026-02-03");
  assert(JSON.stringify(tasks) === before1, "4.E2: both functions no-op on a non-recurring event");

  tasks = [makeTask({ type: "routine", title: "Reading", recurrence: { days: [2], time: "10:00", durationMin: 60, start: "2026-02-03", end: "2026-03-03" } })];
  const before2 = JSON.stringify(tasks);
  overrideEventOccurrence(tasks, tasks[0].id, "2026-02-10", { time: "11:00" });
  cancelEventOccurrence(tasks, tasks[0].id, "2026-02-10");
  assert(JSON.stringify(tasks) === before2, "4.E2: both functions no-op on a non-event (routine) task");

  tasks = makeFixture();
  const before3 = JSON.stringify(tasks);
  overrideEventOccurrence(tasks, "no-such-id", "2026-02-10", { time: "11:00" });
  cancelEventOccurrence(tasks, "no-such-id", "2026-02-10");
  assert(JSON.stringify(tasks) === before3, "4.E2: both functions no-op on an unknown id");

  // overriding an already-cancelled date must not silently un-cancel it
  tasks = makeFixture();
  cancelEventOccurrence(tasks, tasks[0].id, "2026-02-17");
  overrideEventOccurrence(tasks, tasks[0].id, "2026-02-17", { time: "12:00" });
  assert(
    tasks[0].exceptions["2026-02-17"] === null,
    "4.E2 overrideEventOccurrence: a call on an already-cancelled (null) date is a no-op, stays null"
  );
}

// --- 4.INT: wire event create/edit/series-edit/occurrence-override/cancel/delete through
// storage. Sub-step 1 (reading js/views/tasks.js end to end) found every Module-U mutation
// already funnels through the existing onChange seam (commit()'s _onChange / the direct
// _onChange(_state) calls in openOccurrenceForm's submit + confirmCancelOccurrence's del
// click) -> app.js's persistChange -> saveState — same as 3.INT found for routines, no
// wiring change needed. What follows are the round-trip/regression assertions this task
// owes headlessly; DOM-dependent behaviour (the form, the chooser, occurrence-row actions)
// is deferred to the phone HUMAN CHECK per this task's own spec.

// A standalone timed event AND an attached all-day multi-day event both round-trip through
// a fresh LocalStorageProvider().load() (simulated reload), mirroring applyAdd/commit's own
// mutation path (state array push -> persistChange).
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;

  await boot({ search: "" });
  const s = getState();

  const container = makeTask({ type: "finite", title: "Course container" });
  s.tasks.push(container);
  persistChange(s);

  const standalone = makeTask({
    type: "event", title: "Team standup",
    start: "2026-02-03T09:00", end: "2026-02-03T09:30",
  });
  s.tasks.push(standalone); // applyAdd's own mutation
  persistChange(s); // commit()'s onChange call

  const attached = makeTask({
    type: "event", title: "Field trip", parentId: container.id,
    allDay: true, start: "2026-03-10", end: "2026-03-12", location: "Museum",
  });
  s.tasks.push(attached);
  persistChange(s);

  const reloaded = await new LocalStorageProvider().load();
  const foundStandalone = reloaded.tasks.find((t) => t.id === standalone.id);
  const foundAttached = reloaded.tasks.find((t) => t.id === attached.id);

  assert(
    foundStandalone !== undefined &&
      foundStandalone.allDay === false &&
      foundStandalone.start === "2026-02-03T09:00" &&
      foundStandalone.end === "2026-02-03T09:30" &&
      foundStandalone.recurrence === null,
    "4.INT round-trip: a standalone timed event survives a reload byte-exact"
  );
  assert(
    foundAttached !== undefined &&
      foundAttached.parentId === container.id &&
      foundAttached.allDay === true &&
      foundAttached.start === "2026-03-10" &&
      foundAttached.end === "2026-03-12" &&
      foundAttached.location === "Museum",
    "4.INT round-trip: an attached all-day multi-day event survives a reload byte-exact"
  );

  delete globalThis.localStorage;
}

// A recurring event created + one occurrence overridden (mirrors openOccurrenceForm's submit
// handler) + another cancelled (mirrors confirmCancelOccurrence's del click), all via the real
// mutation path -> persistChange, survives a fresh LocalStorageProvider().load() with
// allDay/start/end/location/recurrence/exceptions preserved exactly.
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;

  await boot({ search: "" });
  const s = getState();

  const recEvent = makeTask({
    type: "event", title: "Study group", location: "Library",
    recurrence: { days: [2], time: "10:00", durationMin: 60, start: "2026-02-03", end: "2026-03-03" },
  });
  s.tasks.push(recEvent); // applyAdd's own mutation
  persistChange(s); // commit()'s onChange call

  const dates = expandOccurrences(recEvent).map((o) => o.date);
  const overrideDate = dates[1]; // 2026-02-10
  const cancelDate = dates[2]; // 2026-02-17

  overrideEventOccurrence(s.tasks, recEvent.id, overrideDate, {
    time: "11:30", durationMin: 30, location: "Room 2",
  }); // openOccurrenceForm's submit
  persistChange(s); // its own onChange call

  cancelEventOccurrence(s.tasks, recEvent.id, cancelDate); // confirmCancelOccurrence's del click
  persistChange(s); // its own onChange call

  const reloaded = await new LocalStorageProvider().load();
  const found = reloaded.tasks.find((t) => t.id === recEvent.id);
  assert(found !== undefined, "4.INT round-trip: the created recurring event survives a reload");
  assert(found.allDay === false, "4.INT round-trip: allDay preserved");
  assert(
    found.start === null && found.end === null,
    "4.INT round-trip: a recurring event's own start/end stay null (D41)"
  );
  assert(found.location === "Library", "4.INT round-trip: location preserved");
  assert(
    JSON.stringify(found.recurrence) === JSON.stringify(recEvent.recurrence),
    "4.INT round-trip: recurrence stays byte-identical after an occurrence override/cancel"
  );
  assert(
    JSON.stringify(found.exceptions[overrideDate]) ===
      JSON.stringify({ time: "11:30", durationMin: 30, location: "Room 2" }),
    "4.INT round-trip: the overridden occurrence's exceptions entry is preserved exactly"
  );
  assert(
    found.exceptions[cancelDate] === null,
    "4.INT round-trip: the cancelled occurrence's exceptions entry is preserved as null"
  );

  delete globalThis.localStorage;
}

// Reassigning `recurrence` directly (the "Whole series" edit — applyEdit's event branch,
// a plain field reassignment, D36) changes every non-overridden occurrence while a
// previously-overridden date keeps its own value.
{
  const tasks = [makeTask({
    type: "event", title: "Weekly sync",
    recurrence: { days: [2], time: "10:00", durationMin: 60, start: "2026-02-03", end: "2026-03-03" },
  })];
  const node = tasks[0];
  const overrideDate = expandOccurrences(node)[1].date; // 2026-02-10
  overrideEventOccurrence(tasks, node.id, overrideDate, { time: "12:00" });

  node.recurrence = { ...node.recurrence, time: "14:00" }; // the whole-series edit itself

  const occ = expandOccurrences(node);
  const overridden = occ.find((o) => o.date === overrideDate);
  const others = occ.filter((o) => o.date !== overrideDate);
  assert(
    overridden.time === "12:00",
    "4.INT whole-series edit: a previously-overridden occurrence keeps its own value"
  );
  assert(
    others.length > 0 && others.every((o) => o.time === "14:00"),
    "4.INT whole-series edit: every non-overridden occurrence reflects the reassigned recurrence"
  );
}

// Regression (D20/D23/D25): progressOf/breakdownOf on a container mixing finite/routine/event
// children is unaffected by the events — the seed's "CS 402" course already carries two
// routines (Prepare slides, Mark assignment) and two events (Midterm exam, Final exam); adding
// one more event child must not move either number.
{
  const state = sampleState();
  const course = state.tasks.find((t) => t.title === "CS 402: Distributed Systems");
  const beforeBd = breakdownOf(state.tasks, course);
  const beforePct = progressOf(state.tasks, course);

  state.tasks.push(makeTask({
    type: "event", title: "Extra exam session", parentId: course.id,
    start: "2026-04-01T10:00", end: "2026-04-01T11:00",
  }));

  const afterBd = breakdownOf(state.tasks, course);
  const afterPct = progressOf(state.tasks, course);

  assert(
    JSON.stringify(beforeBd) === JSON.stringify(afterBd),
    "4.INT regression: breakdownOf on a finite+routine+event container is unaffected by an added event child"
  );
  assert(
    beforePct === afterPct,
    "4.INT regression: progressOf on a finite+routine+event container is unaffected by an added event child"
  );
}

// --- 5.L1 layoutDay ---

{
  const A = { id: "A", start: "09:00", durationMin: 60 };
  const B = { id: "B", start: "09:30", durationMin: 60 }; // overlaps A
  const C = { id: "C", start: "11:00", durationMin: 60 }; // no overlap
  const out = layoutDay([A, B, C]);
  const a = out.find((o) => o.id === "A");
  const b = out.find((o) => o.id === "B");
  const c = out.find((o) => o.id === "C");
  assert(
    new Set([a.lane, b.lane]).size === 2 && a.laneCount === 2 && b.laneCount === 2,
    "5.L1 layoutDay: two overlapping items get distinct lanes and laneCount:2"
  );
  assert(
    c.lane === 0 && c.laneCount === 1,
    "5.L1 layoutDay: a non-overlapping item gets lane:0, laneCount:1"
  );
}

{
  const items = [
    { id: "A", start: "09:00", durationMin: 90 },
    { id: "B", start: "09:30", durationMin: 90 },
    { id: "C", start: "10:00", durationMin: 90 },
  ]; // all three mutually overlap
  const out = layoutDay(items);
  assert(
    out.every((o) => o.laneCount === 3),
    "5.L1 layoutDay: three mutually-overlapping items all get laneCount:3"
  );
}

{
  const items = [
    { id: "A", start: "09:00", durationMin: 60 },
    { id: "B", start: "10:00", durationMin: 60 }, // touches, does not overlap
  ];
  const out = layoutDay(items);
  assert(
    out.every((o) => o.lane === 0 && o.laneCount === 1),
    "5.L1 layoutDay: back-to-back items (end === next start) are not an overlap"
  );
}

// --- 5.L2 deadlineCountdown ---

{
  const past = makeTask({ type: "finite", title: "Past", deadline: "2026-02-01" });
  const soon = makeTask({ type: "finite", title: "Soon", deadline: "2026-02-10" });
  const mid = makeTask({ type: "finite", title: "Mid", deadline: "2026-02-08" });
  const doneOne = makeTask({ type: "finite", title: "Done", deadline: "2026-02-06", done: true });
  const tasks = [past, soon, mid, doneOne];
  const out = deadlineCountdown(tasks, "2026-02-05");
  assert(
    out.length === 3 &&
      out[0].deadline === "2026-02-01" && out[0].daysUntil === -4 &&
      out[1].deadline === "2026-02-08" && out[1].daysUntil === 3 &&
      out[2].deadline === "2026-02-10" && out[2].daysUntil === 5,
    "5.L2 deadlineCountdown: sorted soonest-first by date, daysUntil exact, done task excluded"
  );
}

{
  const routine = makeTask({ type: "routine", title: "R", recurrence: { freq: "weekly", byDay: ["MO"], startDate: "2026-01-01", endDate: "2026-03-01" } });
  const out = deadlineCountdown([routine], "2026-02-05");
  assert(
    out.length === 0,
    "5.L2 deadlineCountdown: a routine with no deadline field never appears"
  );
}

// --- 5.L3 monthMatrix + runwayDates ---

{
  // Feb 2026: Feb 1 is a Sunday, so week 1 starts exactly on Feb 1 (inMonth:true throughout).
  const weeks = monthMatrix(2026, 1, "2026-02-15");
  const rowCountOk = weeks.length >= 4 && weeks.length <= 6 && weeks.every(r => r.length === 7);
  const firstRowAllInMonth = weeks[0].every(c => c.inMonth === true);
  let todayCells = 0;
  for (const row of weeks) for (const c of row) if (c.isToday) todayCells++;
  const todayCell = weeks.flat().find(c => c.date === "2026-02-15");
  assert(
    rowCountOk && firstRowAllInMonth && todayCells === 1 && todayCell.isToday === true,
    "5.L3 monthMatrix: Feb 2026 (starts Sunday) has correct row shape, full in-month first row, exactly one isToday cell"
  );
}

{
  // April 2026 starts on a Wednesday: first row needs >=3 lead inMonth:false cells (Sun/Mon/Tue).
  const weeks = monthMatrix(2026, 3, "2026-04-01");
  const leadCount = weeks[0].filter(c => !c.inMonth).length;
  assert(
    leadCount >= 3,
    "5.L3 monthMatrix: April 2026 (starts mid-week) has >=3 lead inMonth:false cells in its first row"
  );
}

{
  const out = runwayDates("2026-07-16", "2026-07-20");
  assert(
    JSON.stringify(out.yellow) === JSON.stringify(["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"]) &&
      out.red === "2026-07-20",
    "5.L3 runwayDates: D35 worked example matches verbatim"
  );
}

{
  const out = runwayDates("2026-07-20", "2026-07-16");
  assert(
    out.yellow.length === 0 && out.red === "2026-07-16",
    "5.L3 runwayDates: an already-overdue deadline has no yellow runway but still flags red"
  );
}

// --- 5.L4 itemsOnDate ---

{
  const DATE = "2026-02-10"; // Tuesday (Feb 2026 starts on a Sunday)
  const OTHER = "2026-02-20";
  const deadlineTask = makeTask({ type: "finite", title: "Deadline", deadline: DATE });
  const routineTask = makeTask({
    type: "routine", title: "Routine",
    recurrence: { days: [2], time: "09:00", durationMin: 30, start: "2026-02-01", end: "2026-02-28" },
  });
  const multiDayEvent = makeTask({
    type: "event", title: "Multi-day", allDay: true, start: "2026-02-08", end: "2026-02-12",
  });
  const recurringEvent = makeTask({
    type: "event", title: "Recurring event",
    recurrence: { days: [2], time: "14:00", durationMin: 60, start: "2026-02-01", end: "2026-02-28" },
  });
  const cancelledRoutine = makeTask({
    type: "routine", title: "Cancelled",
    recurrence: { days: [2], time: "10:00", durationMin: 30, start: "2026-02-01", end: "2026-02-28" },
    exceptions: { [DATE]: null },
  });
  const tasks = [deadlineTask, routineTask, multiDayEvent, recurringEvent, cancelledRoutine];
  const slotOnDate = makeSlot({ date: DATE, start: "08:00", durationMin: 30, taskId: routineTask.id });
  const slotOffDate = makeSlot({ date: OTHER, start: "08:00", durationMin: 30, taskId: routineTask.id });
  const slots = [slotOnDate, slotOffDate];

  const out = itemsOnDate(tasks, slots, DATE);
  assert(
    out.deadlines.length === 1 && out.deadlines[0].id === deadlineTask.id &&
      out.routineOccurrences.length === 1 && out.routineOccurrences[0].taskId === routineTask.id &&
      out.eventOccurrences.length === 2 &&
      out.eventOccurrences.some(e => e.taskId === multiDayEvent.id) &&
      out.eventOccurrences.some(e => e.taskId === recurringEvent.id) &&
      !out.eventOccurrences.some(e => e.taskId === cancelledRoutine.id) &&
      out.slots.length === 1 && out.slots[0].id === slotOnDate.id,
    "5.L4 itemsOnDate: deadline, routine occurrence, multi-day event, recurring event all present; cancelled occurrence absent; slots filtered to the date"
  );

  const empty = itemsOnDate(tasks, slots, "2026-03-01");
  assert(
    empty.deadlines.length === 0 && empty.routineOccurrences.length === 0 &&
      empty.eventOccurrences.length === 0 && empty.slots.length === 0,
    "5.L4 itemsOnDate: a date with nothing on it returns all-empty arrays"
  );
}

// --- 5.L5 validateSlotTimes + moveSlot/resizeSlot ---

{
  const boundary = validateSlotTimes({ start: "09:15", durationMin: 60 });
  const multiple = validateSlotTimes({ start: "09:00", durationMin: 45 });
  const floor = validateSlotTimes({ start: "05:30", durationMin: 30 });
  const ceiling = validateSlotTimes({ start: "21:30", durationMin: 60 });
  const exact = validateSlotTimes({ start: "21:30", durationMin: 30 });
  assert(
    boundary.ok === false && boundary.error === "Start must be on a 30-minute boundary." &&
      multiple.ok === false && multiple.error === "Duration must be a positive multiple of 30 minutes." &&
      floor.ok === false && floor.error === "Start must be at or after 06:00." &&
      ceiling.ok === false && ceiling.error === "A block cannot extend past 22:00." &&
      exact.ok === true,
    "5.L5 validateSlotTimes: boundary, multiple-of-30, floor, ceiling checks fail as specified; an exact 22:00 end passes"
  );
}

{
  const slot = makeSlot({ date: "2026-02-10", start: "09:00", durationMin: 60, taskId: "t1" });
  const moved = moveSlot(slot, "2026-02-11", "10:00");
  const movedBad = moveSlot(slot, "2026-02-11", "10:15");
  const resized = resizeSlot(slot, 90);
  const resizedBad = resizeSlot(slot, 45);
  assert(
    moved.ok === true && moved.slot !== slot && moved.slot.date === "2026-02-11" && moved.slot.start === "10:00" &&
      movedBad.ok === false &&
      resized.ok === true && resized.slot !== slot && resized.slot.durationMin === 90 &&
      resizedBad.ok === false,
    "5.L5 moveSlot/resizeSlot: passing cases return a new object with the change applied; rejected cases fail via validateSlotTimes"
  );
}

// --- 5.M-INT: Month mode wired to real state (itemsOnDate over the seeded sample-data month) ---

{
  const state = sampleState();
  const today = new Date().toLocaleDateString("en-CA");
  const [ty, tm] = today.split("-").map(Number);
  const matrix = monthMatrix(ty, tm - 1, today);

  // Sub-step 2: call itemsOnDate for every day in the month `?seed=1` boots into (Calendar Month
  // has no runwayFor here, so it lands on today's month, same as js/views/calendar.js's own
  // focusMonthFor fallback) — proves the call succeeds across a whole month of the real
  // sample-data fixture (js/sample-data.js), not just 5.L4's own synthetic single-day fixture.
  const perDay = matrix.flat().map((cell) => itemsOnDate(state.tasks, state.slots, cell.date));
  assert(
    perDay.every(
      (info) =>
        Array.isArray(info.deadlines) && Array.isArray(info.routineOccurrences) &&
        Array.isArray(info.eventOccurrences) && Array.isArray(info.slots)
    ),
    "5.M-INT: itemsOnDate returns the full shape for every day in the seeded month"
  );

  // Hand-counted expectation for "today" specifically: js/sample-data.js always seeds exactly
  // one Slot on `today` (the 09:00 "Prepare slides" slot) and no finite deadline lands on
  // `today` (the CHI paper's deadline is today+26) or event (midterm/final/meeting all sit on
  // other dates) — deterministic regardless of which weekday "today" is. The only
  // weekday-dependent pieces are the `slides`/`markAssignment` routine occurrences, so those are
  // cross-checked against `expandOccurrences` (a different, already-DONE pure function) rather
  // than assumed, since this suite must stay correct on whatever real calendar date it runs.
  const slides = state.tasks.find((t) => t.title === "Prepare slides");
  const markAssignment = state.tasks.find((t) => t.title === "Mark assignment");
  const slidesToday = expandOccurrences(slides).some((o) => o.date === today);
  const markToday = expandOccurrences(markAssignment).some((o) => o.date === today);
  const expectedRoutine = (slidesToday ? 1 : 0) + (markToday ? 1 : 0);

  const todayInfo = itemsOnDate(state.tasks, state.slots, today);
  assert(
    todayInfo.deadlines.length === 0,
    "5.M-INT itemsOnDate(today): no finite deadline lands on today (CHI paper's deadline is today+26)"
  );
  assert(
    todayInfo.routineOccurrences.length === expectedRoutine,
    "5.M-INT itemsOnDate(today): routine-occurrence count matches the expandOccurrences cross-check"
  );
  assert(
    todayInfo.eventOccurrences.length === 0,
    "5.M-INT itemsOnDate(today): no event lands on today (midterm/final/meeting sit on other dates)"
  );
  assert(
    todayInfo.slots.length === 1 && todayInfo.slots[0].taskId === slides.id,
    "5.M-INT itemsOnDate(today): exactly the one seeded 09:00 'Prepare slides' Slot"
  );
  const total =
    todayInfo.deadlines.length + todayInfo.routineOccurrences.length +
    todayInfo.eventOccurrences.length + todayInfo.slots.length;
  assert(
    total === expectedRoutine + 1,
    "5.M-INT itemsOnDate(today): total item count matches the hand-counted expectation exactly"
  );
}

// --- 5.G-INT: wire Day/Week grid + Slot CRUD to storage ---
//
// Sub-step 1 (confirm, don't assume — read `js/views/calendar.js` end to end): every Module-G
// mutation (create/edit/delete/drag) already funnels into the module's own `_onChange(_state)`
// seam (5.G3/5.X1's own job, already reviewed) — `commitSlots()` (line 317), `commitDragMove`/
// `commitDragResize` (lines 269/280/291/299) all call it. The ONE thing that did NOT funnel
// through was `js/app.js`'s calendar mount call site itself: `views.calendar` passed `opts`
// straight through to `mountCalendarView` with no `onChange`, so `_onChange` defaulted to its
// no-op and every Slot mutation updated in-memory `_state` (the view re-rendered fine) but was
// never persisted. Fixed in `js/app.js`: `calendar: (p, opts = {}) =>
// mountCalendarView(p, getState(), { ...opts, onChange: persistChange })`, mirroring
// `mountTasksView`'s own `{ onChange: persistChange }` wiring (2.INT's precedent below).
//
// Sub-step 2: create/edit/delete a Slot via the real mutation path — `makeSlot` (the exact
// factory `applySlotCreate` calls) + `persistChange` (the exact seam `commitSlots`/
// `commitDragMove`/`commitDragResize` now reach via the fix above) — then a fresh
// `LocalStorageProvider().load()` proves the round-trip, same shape as 2.INT's own
// "onChange seam persists a mutation" test above.
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;

  await boot({ search: "" });
  const s = getState();
  const slot = makeSlot({ date: "2026-03-10", start: "10:00", durationMin: 90, taskId: "t-1" });
  s.slots.push(slot);
  persistChange(s); // exactly as commitSlots() calls it after applySlotCreate

  let reloaded = await new LocalStorageProvider().load();
  let found = reloaded.slots.find((x) => x.id === slot.id);
  assert(
    found !== undefined &&
      found.date === "2026-03-10" && found.start === "10:00" &&
      found.durationMin === 90 && found.taskId === "t-1",
    "5.G-INT: a Slot created via makeSlot + the onChange seam round-trips exactly"
  );

  // Edit: mirrors applySlotEdit's own moveSlot/resizeSlot-then-persist sequence.
  const moved = moveSlot(found, found.date, "11:00");
  const resized = resizeSlot(moved.slot, 60);
  const s2 = getState();
  const target = s2.slots.find((x) => x.id === slot.id);
  target.start = resized.slot.start;
  target.durationMin = resized.slot.durationMin;
  persistChange(s2);

  reloaded = await new LocalStorageProvider().load();
  found = reloaded.slots.find((x) => x.id === slot.id);
  assert(
    found.start === "11:00" && found.durationMin === 60,
    "5.G-INT: editing a Slot via moveSlot/resizeSlot + the onChange seam round-trips exactly"
  );

  // Delete: mirrors applySlotDelete's own filter-then-persist sequence; must not touch the
  // referenced task (there is none here — `taskId: "t-1"` is a bare id, no task record exists
  // to touch, which is itself consistent with 5.G3's "deleting a Slot never touches the task").
  const s3 = getState();
  s3.slots = s3.slots.filter((x) => x.id !== slot.id);
  persistChange(s3);

  reloaded = await new LocalStorageProvider().load();
  assert(
    reloaded.slots.find((x) => x.id === slot.id) === undefined,
    "5.G-INT: deleting a Slot via the onChange seam round-trips (removed on reload)"
  );

  delete globalThis.localStorage;
}

// --- 5.X-INT: wire drag to storage ---
//
// Sub-step 1 (confirm, don't assume — read `js/views/calendar.js` end to end): `commitDragMove`
// (lines 261-282) and `commitDragResize` (lines 284-301) call `moveSlot`/`resizeSlot` and, ONLY
// when `result.ok`, mutate the slot/task and call the module's own `_onChange(_state)` — the
// exact same module-scoped seam `commitSlots` (5.G3/5.G-INT) reaches, wired once at mount time
// in `js/app.js` (`calendar: (p, opts) => mountCalendarView(p, getState(), { ...opts, onChange:
// persistChange })`). There is no separate drag-specific wiring to fix: 5.G-INT's fix already
// covers every caller of `_onChange`, drag included. The live drag itself (`onDragMove`) only
// ever writes `el.style.top`/`el.style.height` (DOM, not `_state`); `onDragCancel` calls
// `rerender()` with no `_state` mutation at all — so an in-progress or cancelled drag can never
// reach `_onChange`/`persistChange`.
//
// Sub-step 2 (the one behaviour 5.G-INT's own test above didn't cover): a completed drag
// round-trips via `moveSlot`/`resizeSlot` + `persistChange` exactly as already proven above
// (identical functions, identical seam) — this block instead proves the REVERT half: an invalid
// drop's `result.ok === false` guard means the slot is never mutated and `persistChange` is
// never called, so storage is left byte-identical to before the drag started.
{
  const storage = makeSpyStorage();
  globalThis.localStorage = storage;

  await boot({ search: "" });
  const s = getState();
  const slot = makeSlot({ date: "2026-03-10", start: "20:00", durationMin: 60, taskId: "t-1" });
  s.slots.push(slot);
  persistChange(s);

  const before = storage.getItem(STORAGE_KEY);

  // Invalid MOVE: dragging to 21:45 is not on a 30-min boundary (validateSlotTimes rejects it).
  // Mirrors `commitDragMove`'s own `if (!result.ok) return;` — no mutation, no `_onChange`.
  const badMove = moveSlot(slot, slot.date, "21:45");
  assert(badMove.ok === false, "5.X-INT: an off-grid drop is rejected by moveSlot (result.ok === false)");
  if (badMove.ok) persistChange(s); // would only run on a bug; keeps the guard shape explicit

  assert(
    storage.getItem(STORAGE_KEY) === before,
    "5.X-INT: an invalid MOVE drop never calls persistChange — stored state is byte-identical"
  );

  // Invalid RESIZE: 20:00 + 150min = 22:30, past the 22:00 ceiling (validateSlotTimes rejects it).
  const badResize = resizeSlot(slot, 150);
  assert(badResize.ok === false, "5.X-INT: a past-22:00 resize is rejected by resizeSlot (result.ok === false)");
  if (badResize.ok) persistChange(s);

  assert(
    storage.getItem(STORAGE_KEY) === before,
    "5.X-INT: an invalid RESIZE drop never calls persistChange — stored state is byte-identical"
  );

  const reloaded = await new LocalStorageProvider().load();
  const found = reloaded.slots.find((x) => x.id === slot.id);
  assert(
    found.start === "20:00" && found.durationMin === 60,
    "5.X-INT: the Slot on reload still has its pre-drag start/durationMin (nothing reverted was ever written)"
  );

  delete globalThis.localStorage;
}

// --- 5.INT: full Step-5 regression ---
//
// Sub-step 3: progressOf/breakdownOf on a container mixing finite/routine/event children must be
// unaffected by anything Step 5 added. 4.INT's own regression block above already proves this for
// an added EVENT child; Slots are the other thing Step 5 introduced (D30) and that block predates
// them. Slots live in the separate top-level `state.slots` array (never in `tasks`, never carry a
// `parentId`) — `childrenOf`/`progressOf`/`breakdownOf` (js/logic.js) only ever read the `tasks`
// array they're passed, so a Slot is structurally invisible to them, not just coincidentally
// unaffected. This proves it concretely against the same "CS 402" mixed container 4.INT used.
{
  const state = sampleState();
  const course = state.tasks.find((t) => t.title === "CS 402: Distributed Systems");
  const beforeBd = breakdownOf(state.tasks, course);
  const beforePct = progressOf(state.tasks, course);

  state.slots.push(makeSlot({ date: "2026-04-01", start: "10:00", durationMin: 60, taskId: course.id }));

  const afterBd = breakdownOf(state.tasks, course);
  const afterPct = progressOf(state.tasks, course);

  assert(
    JSON.stringify(beforeBd) === JSON.stringify(afterBd),
    "5.INT regression: breakdownOf on a finite+routine+event container is unaffected by an added Slot"
  );
  assert(
    beforePct === afterPct,
    "5.INT regression: progressOf on a finite+routine+event container is unaffected by an added Slot"
  );
}

// --- 7.N1 The rename froze the storage keys (D44) ---
// The rename is cosmetic everywhere EXCEPT here. These assertions hardcode the key strings as
// literals on purpose: comparing against STORAGE_KEY/LEGACY_KEYS would pass even if someone
// renamed them to "pin.*", which is the exact regression D44 exists to prevent.
assert(STORAGE_KEY === "ledger.state", "7.N1/D44: STORAGE_KEY is still the frozen literal 'ledger.state'");
assert(LEGACY_KEYS.tasks === "ledger.tasks", "7.N1/D44: LEGACY_KEYS.tasks is still 'ledger.tasks'");
assert(LEGACY_KEYS.slots === "ledger.slots", "7.N1/D44: LEGACY_KEYS.slots is still 'ledger.slots'");
assert(LEGACY_KEYS.settings === "ledger.settings", "7.N1/D44: LEGACY_KEYS.settings is still 'ledger.settings'");

// The load-bearing regression: a state written BEFORE the rename (i.e. under the literal
// "ledger.state", by a build that never heard of PIN) must still load byte-identically after it.
// storage.js is re-imported with a cache-busting query so this runs against a genuinely fresh
// module instance — its own empty `_mem`, nothing carried over from an earlier block.
{
  const preRename = makeAppState();
  preRename.tasks.push(makeTask({ type: "finite", title: "Written before the rename" }));
  preRename.slots.push(makeSlot({ date: "2026-09-28", start: "09:00", durationMin: 90, taskId: preRename.tasks[0].id }));
  const preRenameBytes = JSON.stringify(preRename);

  const store = makeSpyStorage({ "ledger.state": preRenameBytes });
  globalThis.localStorage = store;

  const fresh = await import(`./js/storage.js?rename=${Date.now()}`);
  const loaded = await new fresh.LocalStorageProvider().load();

  assert(
    JSON.stringify(loaded) === preRenameBytes,
    "7.N1/D44: a state saved under 'ledger.state' before the rename loads byte-identically after it"
  );
  assert(
    (store._calls["ledger.state"] || 0) > 0 && !("pin.state" in store._calls),
    "7.N1/D44: load() reads 'ledger.state' and never looks for a 'pin.*' key"
  );

  delete globalThis.localStorage;
}

// --- 7.R1 Boot surfaces StorageCorruptError with an explicit discard recovery (D28) ---
// A minimal DOM stub: just enough of document/Element for the boot-error region. The view
// modules are not involved — 7.R1 renders straight into #pane before any view mounts.
function makeDomStub() {
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      className: "",
      type: "",
      _attrs: {},
      _text: "",
      children: [],
      _listeners: {},
      get textContent() { return this._text; },
      set textContent(v) { this.children = []; this._text = String(v); },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      append(...cs) { for (const c of cs) this.children.push(c); },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      click() { for (const fn of this._listeners.click || []) fn({}); },
    };
  }
  globalThis.document = { createElement: el };
  return el("main");
}
const domWalk = (n) => [n, ...n.children.flatMap(domWalk)];
const domText = (n) => domWalk(n).map((x) => x._text).join(" ");
const domFind = (n, pred) => domWalk(n).filter(pred);
const flush = () => new Promise((r) => setTimeout(r, 0));

const CORRUPT_BYTES = '{"version":1,"tasks":[{"id":"t1","titl'; // truncated mid-write

// The whole 7.R1 path, driven end to end against a corrupt ledger.state.
{
  const storage = makeSpyStorage({ [STORAGE_KEY]: CORRUPT_BYTES });
  globalThis.localStorage = storage;
  const pane = makeDomStub();
  let readyState = null;

  const result = await bootWithRecovery({
    search: "",
    pane,
    onReady: (s) => { readyState = s; },
  });

  assert(
    result.ok === false && result.error instanceof StorageCorruptError,
    "7.R1: a corrupt ledger.state is caught by bootWithRecovery, not thrown into a blank page"
  );
  assert(readyState === null, "7.R1: onReady never fires on a corrupt boot (the app does not mount)");

  const regions = domFind(pane, (n) => n.getAttribute("role") === "alert");
  assert(regions.length === 1, "7.R1: exactly one error region is rendered into #pane");
  const buttons = domFind(pane, (n) => n.tagName === "BUTTON");
  assert(buttons.length === 1, "7.R1: the error region contains a real <button> control");
  assert(
    buttons[0].textContent.trim().length > 0 && buttons[0].type === "button",
    "7.R1: the discard control is a labelled type='button'"
  );
  assert(
    domText(pane).includes(STORAGE_KEY + CORRUPT_SUFFIX),
    "7.R1: the error text names where the unreadable data was preserved"
  );

  // Nothing is replaced until the control is used.
  assert(
    storage.getItem(STORAGE_KEY) === CORRUPT_BYTES,
    "7.R1/D28: state is NOT replaced by merely rendering the error (no automatic fresh start)"
  );
  assert(
    storage.getItem(STORAGE_KEY + CORRUPT_SUFFIX) === CORRUPT_BYTES,
    "7.R1/D28 rule 2: the raw bytes were preserved under ledger.state.corrupt"
  );

  // Now click it — the one and only path that discards.
  buttons[0].click();
  await flush();

  const written = JSON.parse(storage.getItem(STORAGE_KEY));
  assert(
    written.tasks.length === 0 && written.slots.length === 0,
    "7.R1: clicking discard force-saves a fresh empty AppState over the corrupt key"
  );
  assert(
    storage.getItem(STORAGE_KEY + CORRUPT_SUFFIX) === CORRUPT_BYTES,
    "7.R1/D28 rule 2: the original bytes STILL survive under ledger.state.corrupt after the discard"
  );
  assert(
    readyState !== null && readyState.tasks.length === 0 && readyState.slots.length === 0 &&
      getState().tasks.length === 0,
    "7.R1: after the discard the app re-boots into the empty state (onReady fires with it)"
  );

  delete globalThis.localStorage;
  delete globalThis.document;
}

// A normal boot renders no error region at all.
{
  globalThis.localStorage = makeSpyStorage();
  const pane = makeDomStub();
  let readyState = null;
  const result = await bootWithRecovery({ search: "", pane, onReady: (s) => { readyState = s; } });
  assert(result.ok === true, "7.R1: a normal boot returns ok:true");
  assert(
    pane.children.length === 0 && domFind(pane, (n) => n.getAttribute("role") === "alert").length === 0,
    "7.R1: a normal boot renders NO error region into #pane"
  );
  assert(readyState === result.state, "7.R1: a normal boot hands the loaded state to onReady");
  delete globalThis.localStorage;
  delete globalThis.document;
}

// Any other boot failure still propagates — only StorageCorruptError gets the recovery screen.
{
  globalThis.localStorage = makeSpyStorage();
  const pane = makeDomStub();
  const exploding = { async load() { throw new TypeError("something else broke"); }, async save() { return true; } };
  let err = null;
  try {
    await bootWithRecovery({ search: "", pane, provider: exploding });
  } catch (e) { err = e; }
  assert(
    err instanceof TypeError && domFind(pane, (n) => n.getAttribute("role") === "alert").length === 0,
    "7.R1: a non-StorageCorruptError propagates untouched and renders no recovery screen"
  );
  delete globalThis.localStorage;
  delete globalThis.document;
}

// renderBootError escapes nothing into markup: hostile text stays literal text.
{
  makeDomStub();
  const pane = makeDomStub();
  renderBootError(pane, { backupKey: '<img src=x onerror=alert(1)>' }, () => {});
  assert(
    domText(pane).includes("<img src=x onerror=alert(1)>") &&
      domFind(pane, (n) => n.tagName === "IMG").length === 0,
    "7.R1: a hostile backupKey stays literal text (textContent, never innerHTML)"
  );
  delete globalThis.document;
}

// --- 7.R2 The dev-only seed leaves the shipped module graph ---
// The claim is "a normal boot never fetches sample-data.js". In a browser that is decided by the
// STATIC import graph reachable from the one <script type="module"> the page loads, so the check
// walks that graph over the real source. (A loader-level runtime probe cannot prove it from inside
// test.mjs, which imports the fixture itself for its own 1.5 assertions.)
{
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve: resolvePath } = await import("node:path");

  const appSrc = readFileSync("./js/app.js", "utf8");
  const staticImports = (src) =>
    [...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);

  assert(
    !staticImports(appSrc).includes("./sample-data.js"),
    "7.R2: js/app.js has NO top-level import of sample-data.js"
  );
  assert(
    /await import\(["']\.\/sample-data\.js["']\)/.test(appSrc),
    "7.R2: js/app.js imports the fixture dynamically"
  );
  // ...and that dynamic import is inside the ?seed=1 branch, not at some other call site.
  {
    const branchAt = appSrc.indexOf("if (shouldLoadSeed(search))");
    const dynAt = appSrc.indexOf('await import("./sample-data.js")');
    const branchEnd = appSrc.indexOf("\n  return state;", branchAt);
    assert(
      branchAt !== -1 && dynAt > branchAt && dynAt < branchEnd,
      "7.R2: the dynamic import sits inside the shouldLoadSeed(search) branch"
    );
    assert(
      appSrc.split('import("./sample-data.js")').length - 1 === 1,
      "7.R2: the fixture is imported from exactly ONE place in app.js"
    );
    assert(
      /window\.confirm\(/.test(appSrc) && /confirmOverwrite\(state\)/.test(appSrc),
      "7.R2: the 1.INT confirm() overwrite guard is left exactly as it was"
    );
  }

  // Transitive: nothing reachable from the page's entry module pulls the fixture in statically.
  const entry = resolvePath("./js/app.js");
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      queue.push(resolvePath(dirname(file), spec));
    }
  }
  assert(
    !seen.has(resolvePath("./js/sample-data.js")),
    "7.R2: sample-data.js is unreachable from js/app.js's STATIC graph (the shipped graph)"
  );
  assert(
    seen.has(resolvePath("./js/storage.js")) && seen.has(resolvePath("./js/views/tasks.js")),
    "7.R2 control: the walk really does traverse the graph (storage.js + views/tasks.js are in it)"
  );
  assert(
    (readFileSync("./index.html", "utf8").match(/<script/g) || []).length === 1 &&
      readFileSync("./index.html", "utf8").includes('src="js/app.js"'),
    "7.R2: the page still loads exactly one module entry point (js/app.js)"
  );
}

// ?seed=1 still seeds through the dynamic import, and a boot without it still yields an empty state.
{
  globalThis.localStorage = makeSpyStorage();
  const seeded = await boot({ search: "?seed=1" });
  const seed = sampleState();
  assert(
    seeded.tasks.length === seed.tasks.length && seeded.slots.length === seed.slots.length,
    "7.R2: ?seed=1 still loads the full fixture via the dynamic import"
  );
  delete globalThis.localStorage;
}
{
  globalThis.localStorage = makeSpyStorage();
  const plain = await boot({ search: "" });
  assert(plain.tasks.length === 0 && plain.slots.length === 0, "7.R2: a boot without ?seed=1 stays empty");
  delete globalThis.localStorage;
}

// --- 7.R3 The deadline runway survives month navigation (D46) ---
// Part 1 (pure): a runway that spans a month boundary, seen from BOTH sides. This is the exact
// shape of the bug — from July the grid says "Runway continues into August 2026", and following
// that advice used to be what destroyed the runway.
{
  const july = monthMatrix(2026, 6, "2026-07-28"); // 2026-06-28 .. 2026-08-01
  const august = monthMatrix(2026, 7, "2026-07-28"); // 2026-07-26 .. 2026-09-05

  const fromJuly = visibleRunway("2026-07-28", "2026-08-04", july);
  assert(
    [...fromJuly.yellowSet].sort().join(",") ===
      "2026-07-28,2026-07-29,2026-07-30,2026-07-31,2026-08-01" &&
      fromJuly.red === null && fromJuly.clipped === true &&
      fromJuly.note === "Runway continues into August 2026.",
    "7.R3: a boundary-spanning runway seen from the EARLIER month — 5 yellow visible, red clipped, note names August"
  );

  const fromAugust = visibleRunway("2026-07-28", "2026-08-04", august);
  assert(
    fromAugust.yellowSet.size === 7 && fromAugust.red === "2026-08-04" &&
      fromAugust.clipped === false && fromAugust.note === null,
    "7.R3: the same runway seen from the LATER month — all 7 yellow + the red deadline visible, nothing clipped"
  );
  assert(
    fromAugust.yellowSet.has("2026-07-28") && fromAugust.yellowSet.has("2026-07-31"),
    "7.R3: August's leading cells still carry July's yellow (the runway is continuous across the seam)"
  );
}

// Part 2 (DOM): prev/next keeps the highlight; Today and the dismiss control clear it.
// Dates are derived from the wall clock because mountCalendarView has no injectable-date seam
// (5.M1's convention), so the fixture is built relative to today rather than from a literal.
// 7.A1 sub-step 4: that clock is now PINNED. The fixture puts the deadline on the 4th of NEXT
// month and then asserts that navigating back one month produces a "Runway continues into …"
// note — but a month grid also renders trailing cells from the following month, so on some real
// dates (2026-11-01, 2027-01-01, 2028-02-29 among them) the 4th is ALREADY visible from the
// earlier month, the runway is not clipped, and the view correctly renders no note at all. The
// app was right and the assertion was wrong one day in several. Pinned mid-month, with the
// clipping precondition asserted below so this cannot quietly go vacuous if the date is changed.
{
  const restoreClock = pinToday("2026-09-15");
  function makeCalDomStub() {
    function el(tag) {
      return {
        tagName: String(tag).toUpperCase(), className: "", type: "", value: "",
        style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {},
        classList: { add(...cs) { this._n.className += " " + cs.join(" "); } },
        get textContent() { return this._t; },
        set textContent(v) { this.children = []; this._t = String(v); },
        setAttribute(k, v) { this._a[k] = String(v); },
        getAttribute(k) { return k in this._a ? this._a[k] : null; },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { for (const c of cs) this.children.push(c); },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); },
        addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
        focus() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 600 }; },
        dispatch(t) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
      };
    }
    const wrap = (tag) => { const n = el(tag); n.classList._n = n; return n; };
    globalThis.document = { createElement: wrap };
    return wrap("main");
  }
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const byClass = (root, c) => walk(root).filter((n) => (" " + n.className + " ").includes(" " + c + " "));
  const byLabel = (root, label) => walk(root).find((n) => n.tagName === "BUTTON" && n._t === label);

  const pane = makeCalDomStub();
  const iso = (d) => d.toLocaleDateString("en-CA");
  const now = new Date();
  // Deadline = the 4th of NEXT month, so the runway always crosses exactly one month boundary.
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 4);
  const state = makeAppState();
  const target = makeTask({ type: "finite", title: "Boundary runway", deadline: iso(nextMonth) });
  state.tasks.push(target);

  mountCalendarView(pane, state, { runwayFor: target.id });
  assert(
    byClass(pane, "cal-day-runway-red").length === 1,
    "7.R3: mounting with runwayFor lands on the deadline month with the red deadline cell highlighted"
  );
  const dismissBtn = byClass(pane, "cal-runway-dismiss");
  assert(
    dismissBtn.length === 1 && dismissBtn[0].tagName === "BUTTON" && dismissBtn[0]._t.trim().length > 0,
    "7.R3 sub-step 2: an explicit, labelled dismiss control is rendered while a runway is active"
  );

  // THE regression: navigate back a month — the runway must still be highlighted there.
  byLabel(pane, "‹ Prev").dispatch("click");
  assert(
    byClass(pane, "cal-day-runway-yellow").length > 0,
    "7.R3/D46: Prev re-renders the adjacent month with the runway's yellow cells STILL highlighted"
  );
  // Precondition, asserted rather than assumed (7.A1 sub-step 4): the note only exists when the
  // runway is genuinely clipped by the shown grid. If a future change to the pinned date makes the
  // deadline visible from this month, THIS fails loudly instead of the note check going vacuous.
  const shownMatrix = monthMatrix(now.getFullYear(), now.getMonth(), iso(now));
  assert(
    !shownMatrix.flat().some((c) => c.date === iso(nextMonth)),
    "7.R3 precondition: the deadline is genuinely off the previous month's grid, so a clipped-runway note is the correct rendering"
  );
  assert(
    byClass(pane, "cal-runway-note").length === 1 &&
      byClass(pane, "cal-runway-note")[0]._t.includes(
        ["January","February","March","April","May","June","July","August","September","October","November","December"][nextMonth.getMonth()]
      ),
    "7.R3: the clipped note is still accurate for the newly-shown month (it names the deadline's month)"
  );

  // ...and forward again, back onto the deadline month.
  byLabel(pane, "Next ›").dispatch("click");
  assert(
    byClass(pane, "cal-day-runway-red").length === 1,
    "7.R3/D46: Next keeps the runway too — the red deadline cell is back"
  );

  // The dismiss control clears it.
  byClass(pane, "cal-runway-dismiss")[0].dispatch("click");
  assert(
    byClass(pane, "cal-day-runway-yellow").length === 0 &&
      byClass(pane, "cal-day-runway-red").length === 0 &&
      byClass(pane, "cal-runway-dismiss").length === 0,
    "7.R3 sub-step 2: the dismiss control clears the runway (and removes itself)"
  );

  // Today clears it as well (sub-step 2), proven on a month where it WOULD otherwise show.
  mountCalendarView(pane, state, { runwayFor: target.id });
  byLabel(pane, "Today").dispatch("click");
  assert(
    byClass(pane, "cal-day-runway-yellow").length === 0 &&
      byClass(pane, "cal-day-runway-red").length === 0,
    "7.R3 sub-step 2: Today still clears the runway"
  );

  // A mount with no runwayFor renders neither highlight nor dismiss control (no regression).
  mountCalendarView(pane, state, {});
  assert(
    byClass(pane, "cal-day-runway-yellow").length === 0 &&
      byClass(pane, "cal-runway-dismiss").length === 0 &&
      byClass(pane, "cal-day").length > 0,
    "7.R3: a normal Calendar mount still renders a month grid with no runway and no dismiss control"
  );

  restoreClock();
  delete globalThis.document;
}

// --- 7.U1 Task + subtasks render in one box ---
// The Done-when asks for a COUNT of bordered elements in a 3-deep fixture, so this block
// does two things a pure DOM assertion can't do on its own: it renders the real Tasks view
// against a DOM stub (5.M1/7.R3 precedent), and it resolves "is this element bordered?" by
// running the SHIPPED css/styles.css through a small cascade evaluator. Nothing here restates
// the intended rules — the borders are read out of the stylesheet the browser will load.
// Pixel/legibility acceptance still rides 7.INT's phone pass (the spec defers it there).
{
  const { readFileSync } = await import("node:fs");
  const cssSrc = readFileSync("./css/styles.css", "utf8");
  const noComments = cssSrc.replace(/\/\*[\s\S]*?\*\//g, "");

  // Control: the evaluator below flattens the stylesheet and ignores at-rule blocks, which is
  // only honest if no at-rule touches the task tree's box.
  const AT_BLOCK = /@[a-z-]+[^{]*\{(?:[^{}]*\{[^{}]*\}\s*)*\}/gi;
  const atBlocks = noComments.match(AT_BLOCK) || [];
  assert(
    atBlocks.length > 0 &&
      !atBlocks.some((b) => b.includes(".task-node") || b.includes(".task-row")),
    "7.U1 control: no @media/at-rule block touches .task-node/.task-row, so the flat cascade is the whole story"
  );

  const BORDER_STYLES = ["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"];
  const SIDES = ["top", "right", "bottom", "left"];

  // CSS border shorthands always write BOTH longhands (an omitted width resolves to `medium`,
  // an omitted style to `none`) — that reset behaviour is exactly what makes `border: none`
  // erase a box, so model it rather than merging.
  function shorthand(value) {
    let style = null;
    let width = null;
    for (const t of value.trim().split(/\s+/)) {
      if (BORDER_STYLES.includes(t)) style = t;
      else if (/^[\d.]+(px|em|rem|%)?$/.test(t) || ["thin", "medium", "thick"].includes(t)) width = t;
    }
    return { style: style === null ? "none" : style, width: width === null ? "medium" : width };
  }

  function parseDecls(body) {
    const out = {};
    for (const piece of body.split(";")) {
      const i = piece.indexOf(":");
      if (i < 0) continue;
      const prop = piece.slice(0, i).trim().toLowerCase();
      const value = piece.slice(i + 1).trim();
      if (prop === "border") {
        const { style, width } = shorthand(value);
        for (const s of SIDES) { out[`border-${s}-style`] = style; out[`border-${s}-width`] = width; }
      } else if (/^border-(top|right|bottom|left)$/.test(prop)) {
        const s = prop.split("-")[1];
        const { style, width } = shorthand(value);
        out[`border-${s}-style`] = style;
        out[`border-${s}-width`] = width;
      } else if (/^border-(top|right|bottom|left)-(style|width)$/.test(prop)) {
        out[prop] = value;
      } else if (prop === "border-style" || prop === "border-width") {
        const kind = prop.split("-")[1];
        for (const s of SIDES) out[`border-${s}-${kind}`] = value;
      }
    }
    return out;
  }

  const BORDER_PROP = /(^|[;\s])border(-(top|right|bottom|left))?(-(style|width))?\s*:/;
  const rules = [];
  {
    const flat = noComments.replace(AT_BLOCK, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    let order = 0;
    while ((m = re.exec(flat)) !== null) {
      const decls = parseDecls(m[2]);
      const declaresBorder = BORDER_PROP.test(m[2]);
      for (const sel of m[1].split(",")) {
        const s = sel.trim();
        if (s) rules.push({ sel: s, decls, declaresBorder, order: order++, spec: specificity(s) });
      }
    }
  }
  function specificity(sel) {
    const ids = (sel.match(/#[\w-]+/g) || []).length;
    const classes = (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/:(?!not)[a-z-]+/g) || []).length +
      (sel.match(/\[[^\]]*\]/g) || []).length;
    const types = (sel.match(/(^|[\s>+~])[a-z][\w-]*/g) || []).length;
    return ids * 10000 + classes * 100 + types;
  }

  const hasClass = (el, c) => (" " + el.className + " ").includes(" " + c + " ");

  // Only the selector forms the task CSS actually uses are modelled; anything else throws and
  // the rule is recorded as skipped (and then proven irrelevant to this render, below).
  function compoundMatch(el, compound) {
    let rest = compound;
    const tag = rest.match(/^[a-z][\w-]*/i);
    if (tag) {
      if (el.tagName !== tag[0].toUpperCase()) return false;
      rest = rest.slice(tag[0].length);
    }
    while (rest.length) {
      let m;
      if ((m = rest.match(/^\.([\w-]+)/)) !== null) {
        if (!hasClass(el, m[1])) return false;
      } else if ((m = rest.match(/^:not\(\.([\w-]+)\)/)) !== null) {
        if (hasClass(el, m[1])) return false;
      } else {
        throw new Error(`unsupported selector syntax: ${compound}`);
      }
      rest = rest.slice(m[0].length);
    }
    return true;
  }

  // Right-to-left match over descendant/child combinators. The task selectors chain distinct
  // classes, so taking the nearest matching ancestor needs no backtracking.
  function selectorMatches(el, sel) {
    const parts = sel.split(/\s*(>)\s*|\s+/).filter((p) => p);
    let i = parts.length - 1;
    if (!compoundMatch(el, parts[i])) return false;
    let cur = el;
    i -= 1;
    while (i >= 0) {
      let child = false;
      if (parts[i] === ">") { child = true; i -= 1; }
      const compound = parts[i];
      i -= 1;
      if (child) {
        cur = cur.parent;
        if (!cur || !compoundMatch(cur, compound)) return false;
      } else {
        let a = cur.parent;
        while (a && !compoundMatch(a, compound)) a = a.parent;
        if (!a) return false;
        cur = a;
      }
    }
    return true;
  }

  const skipped = new Set();
  function computed(el) {
    const win = {};
    for (const r of rules) {
      let m = false;
      try {
        m = selectorMatches(el, r.sel);
      } catch {
        if (r.declaresBorder) skipped.add(r.sel);
        continue;
      }
      if (!m) continue;
      for (const [prop, value] of Object.entries(r.decls)) {
        const prev = win[prop];
        if (!prev || r.spec > prev.spec || (r.spec === prev.spec && r.order > prev.order)) {
          win[prop] = { spec: r.spec, order: r.order, value };
        }
      }
    }
    const out = {};
    for (const [p, v] of Object.entries(win)) out[p] = v.value;
    return out;
  }
  const visibleSide = (c, s) => {
    const st = c[`border-${s}-style`];
    const w = c[`border-${s}-width`];
    return Boolean(st) && st !== "none" && st !== "hidden" && w !== "0" && w !== "0px";
  };
  // "Bordered" = a box: a visible border on top AND right AND bottom. The 3px left accent
  // alone (D22) is an accent, not a box, so it is deliberately not counted.
  const isBoxed = (el) => ["top", "right", "bottom"].every((s) => visibleSide(computed(el), s));

  // A DOM stub with parent links (the cascade needs ancestry) and enough Element surface for
  // the Tasks view: insertBefore/contains/firstChild, classList, dataset, checkbox props.
  function makeTaskDomStub() {
    function el(tag) {
      const n = {
        tagName: String(tag).toUpperCase(),
        className: "", type: "", value: "", checked: false, indeterminate: false,
        hidden: false, style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {},
        parent: null,
        get firstChild() { return this.children[0] || null; },
        get childNodes() { return this.children; },
        get textContent() { return this._t; },
        set textContent(v) {
          for (const c of this.children) c.parent = null;
          this.children = [];
          this._t = String(v);
        },
        setAttribute(k, v) { this._a[k] = String(v); },
        getAttribute(k) { return k in this._a ? this._a[k] : null; },
        appendChild(c) { c.parent = this; this.children.push(c); return c; },
        append(...cs) { for (const c of cs) this.appendChild(c); },
        insertBefore(c, ref) {
          const i = ref ? this.children.indexOf(ref) : -1;
          c.parent = this;
          if (i < 0) this.children.push(c);
          else this.children.splice(i, 0, c);
          return c;
        },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; },
        remove() { if (this.parent) this.parent.removeChild(this); },
        contains(c) { return this.children.some((x) => x === c || x.contains(c)); },
        addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
        focus() {},
        dispatch(t) {
          for (const fn of (this._ev[t] || []).slice()) fn({ type: t, key: "", preventDefault() {}, stopPropagation() {} });
        },
      };
      n.classList = {
        add(...cs) { for (const c of cs) if (!hasClass(n, c)) n.className = (n.className + " " + c).trim(); },
        contains(c) { return hasClass(n, c); },
      };
      return n;
    }
    globalThis.document = {
      createElement: el,
      getElementById: () => null,
      body: el("body"),
      activeElement: null,
    };
    return el("main");
  }
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));

  const { mountTasksView, cancelPendingHides } = await import("./js/views/tasks.js");
  const { TASK_COLORS } = await import("./js/state.js");

  // --- Fixture 1: a 3-deep container chain (the spec's counting fixture). ---
  const pane = makeTaskDomStub();
  const st = makeAppState();
  const root = makeTask({ type: "finite", title: "Thesis", color: "blue" });
  const mid = makeTask({ type: "finite", title: "Chapter 1", parentId: root.id, color: "green" });
  const leafA = makeTask({ type: "finite", title: "Draft intro", parentId: mid.id, color: "coral" });
  const leafB = makeTask({ type: "finite", title: "Draft methods", parentId: mid.id });
  const leafC = makeTask({ type: "finite", title: "Outline", parentId: root.id });
  st.tasks.push(root, mid, leafA, leafB, leafC);
  let changes = 0;
  mountTasksView(pane, st, { onChange: () => { changes += 1; } });

  const nodes = byClass(pane, "task-node");
  const containers = nodes.filter((n) => hasClass(n, "has-children"));
  assert(
    nodes.length === 5 && containers.length === 2 &&
      containers.every((n) => byClass(n, "task-children").length > 0),
    "7.U1 sub-step 1: renderNode hooks every node that HAS children with .has-children (2 of the 5 nodes here)"
  );
  assert(
    nodes.filter((n) => !hasClass(n, "has-children")).length === 3,
    "7.U1 sub-step 1: the three leaves carry no .has-children hook"
  );

  // Honesty control for the evaluator: nothing inline can add or remove a box, and no
  // border-declaring rule was skipped that could have matched anything in this render.
  const inlineProps = new Set(walk(pane).flatMap((n) => Object.keys(n.style)));
  assert(
    [...inlineProps].every((p) => ["borderLeftColor", "background", "width"].includes(p)),
    `7.U1 control: the render only sets colour/fill/width inline (${[...inlineProps].join(",") || "none"}) — no inline border style or width, so the stylesheet decides every box`
  );
  const present = new Set(walk(pane).flatMap((n) => [n.tagName.toLowerCase(), ...n.className.split(/\s+/)]).filter(Boolean));
  assert(
    [...skipped].every((sel) => ![...present].some((tok) => sel.includes("." + tok) || new RegExp(`(^|[\\s>+~])${tok}([.:\\[\\s>+~]|$)`).test(sel))),
    `7.U1 control: no border-declaring rule with unmodelled syntax could match this render (skipped: ${[...skipped].join(" | ") || "none"})`
  );

  // THE Done-when count.
  const boxed = walk(pane).filter(isBoxed);
  assert(
    boxed.length === 1,
    `7.U1 DONE-WHEN: a 3-deep container (2 containers, 3 leaves) renders inside exactly ONE bordered element — 1, not 3 (got ${boxed.length}: ${boxed.map((b) => b.className).join(" | ") || "none"})`
  );
  assert(
    boxed.length === 1 && hasClass(boxed[0], "task-node") && hasClass(boxed[0], "has-children") &&
      boxed[0].parent && !hasClass(boxed[0].parent, "task-node"),
    "7.U1 sub-steps 2+3: the one box is the OUTERMOST container's node wrap, not a row and not a nested node"
  );
  const rows = byClass(pane, "task-row");
  assert(
    rows.length === 5 && rows.every((r) => boxed[0].contains(r)) && rows.every((r) => !isBoxed(r)),
    "7.U1: all 5 rows (2 containers + 3 leaves) live INSIDE that one box and none draws a box of its own"
  );
  assert(
    nodes.filter((n) => n !== boxed[0]).every((n) => !isBoxed(n)),
    "7.U1 sub-step 3: the nested container's wrap draws no second box (1, not 3)"
  );

  // The accent and the wash survive the move (sub-step 4 / D22).
  assert(
    boxed[0].style.borderLeftColor === TASK_COLORS.blue.solid &&
      visibleSide(computed(boxed[0]), "left") &&
      computed(boxed[0])["border-left-width"] === "3px",
    "7.U1 sub-step 4: the card's left edge is the container's own 3px colour accent (D22)"
  );
  const containerRow = rows.find((r) => hasClass(r, "container-row"));
  assert(
    containerRow.style.background === TASK_COLORS.blue.wash &&
      !visibleSide(computed(containerRow), "left"),
    "7.U1 sub-step 4: the container header keeps its colour wash and drops its own accent (no doubled 6px band)"
  );
  const leafRow = rows.find((r) => r.dataset.taskId === leafA.id) ||
    walk(pane).find((n) => hasClass(n, "task-row") && byClass(n, "task-title").some((t) => t.textContent === "Draft intro"));
  assert(
    leafRow.style.borderLeftColor === TASK_COLORS.coral.solid &&
      computed(leafRow)["border-left-style"] === "solid" &&
      computed(leafRow)["border-left-width"] === "3px",
    "7.U1 sub-step 4: a nested leaf keeps its own 3px colour accent against the merged fill (D22)"
  );

  // --- Everything inside the merged box still renders and still works. ---
  const toggles = byClass(pane, "task-toggle");
  const kidBoxes = byClass(pane, "task-children");
  assert(
    toggles.length === 2 && toggles.every((t) => t.getAttribute("aria-expanded") === "true"),
    "7.U1: both containers still render an expanded chevron inside the merged box"
  );
  toggles[0].dispatch("click");
  assert(
    kidBoxes[0].hidden === true && toggles[0].getAttribute("aria-expanded") === "false" &&
      toggles[0].getAttribute("aria-label") === "Expand Thesis" && toggles[0].textContent === "▸",
    "7.U1: collapse still works (children hidden, aria-expanded false, label flipped)"
  );
  toggles[0].dispatch("click");
  assert(
    kidBoxes[0].hidden === false && toggles[0].getAttribute("aria-expanded") === "true",
    "7.U1: expand still works"
  );
  assert(
    byClass(pane, "task-breakdown").length === 2 &&
      byClass(pane, "task-breakdown")[0].textContent.includes("deliverables"),
    "7.U1: the container breakdown line (D6) still renders inside the merged box"
  );
  const fills = byClass(pane, "progress-fill");
  assert(
    byClass(pane, "progress-bar").length === 5 && fills.length === 5 &&
      fills.every((f) => /^\d+%$/.test(f.style.width)) &&
      fills[0].style.width === `${progressOf(st.tasks, root)}%`,
    "7.U1: every row still renders its progress bar, the parent's still reading progressOf"
  );
  const boxes = byClass(pane, "task-checkbox");
  assert(boxes.length === 5, "7.U1: the finite checkbox still renders on every row in the merged box");
  const leafBox = byClass(pane, "task-checkbox").find((b) => b.getAttribute("aria-label") === 'Mark "Draft intro" done');
  leafBox.checked = true;
  leafBox.dispatch("change");
  assert(
    changes === 1 && st.tasks.find((t) => t.id === leafA.id).done === true,
    "7.U1: checking a nested leaf still cascades through setDoneCascade and still fires the persistence seam"
  );
  assert(
    walk(pane).filter(isBoxed).length === 1 && byClass(pane, "task-node").length === 5,
    "7.U1: after the re-render triggered by that mutation the tree is still exactly one box"
  );

  // --- Fixture 2: a leaf with no children still gets its own box. ---
  const paneLeaf = makeTaskDomStub();
  const stLeaf = makeAppState();
  stLeaf.tasks.push(makeTask({ type: "finite", title: "Buy milk" }));
  mountTasksView(paneLeaf, stLeaf, {});
  const leafBoxed = walk(paneLeaf).filter(isBoxed);
  assert(
    leafBoxed.length === 1 && hasClass(leafBoxed[0], "task-row") && !hasClass(leafBoxed[0], "container-row"),
    `7.U1 DONE-WHEN: a top-level leaf with no children still renders its own single box (got ${leafBoxed.length})`
  );

  // --- Fixture 3: unlimited depth — 4 levels, still one box (sub-step 3). ---
  const paneDeep = makeTaskDomStub();
  const stDeep = makeAppState();
  let parentId = null;
  for (const title of ["L1", "L2", "L3", "L4"]) {
    const t = makeTask({ type: "finite", title, parentId });
    stDeep.tasks.push(t);
    parentId = t.id;
  }
  mountTasksView(paneDeep, stDeep, {});
  assert(
    byClass(paneDeep, "task-node").length === 4 && byClass(paneDeep, "has-children").length === 3 &&
      walk(paneDeep).filter(isBoxed).length === 1,
    "7.U1 sub-step 3: a 4-deep chain (3 nested containers) is still exactly ONE box — no boxes inside boxes"
  );

  // --- Static checks on the 7.U1 CSS itself: no new hex, nothing that can widen a row. ---
  const u1Css = cssSrc.slice(cssSrc.indexOf("/* Task 7.U1:"), cssSrc.indexOf(".task-toggle {"));
  assert(
    u1Css.includes(".task-node.has-children") && !/#[0-9a-fA-F]{3,8}\b/.test(u1Css),
    "7.U1: the new CSS introduces no hex — fill/border/radius/accent all come from existing tokens"
  );
  assert(
    !/(^|[;\s{])(width|min-width|padding|padding-left|padding-right|margin-left|margin-right)\s*:/.test(u1Css),
    "7.U1: the new CSS sets no width/inline padding, so the 360px no-horizontal-scroll geometry is untouched (visual rides 7.INT)"
  );

  // 7.U4 teardown: checking a leaf above opened a real grace window, and its timer would fire
  // after this block has deleted the document it was going to re-render. Not an assertion — test
  // hygiene for the 7.U4 behaviour this block now exercises incidentally.
  cancelPendingHides();
  delete globalThis.document;
}

// --- 7.U2 AppState.prefs + markerFor (D45) ---
{
  const DEFAULT_PREFS = '{"marker":"color","emoji":{}}';

  // Done-when 1: makeAppState().prefs deep-equals {marker:"color", emoji:{}} and is a SIBLING of settings.
  const fresh = makeAppState();
  assert(
    JSON.stringify(fresh.prefs) === DEFAULT_PREFS,
    '7.U2 DONE-WHEN: makeAppState().prefs deep-equals {marker:"color",emoji:{}}'
  );
  assert(
    "prefs" in fresh && !("prefs" in fresh.settings),
    "7.U2 (D45): prefs is a TOP-LEVEL sibling of settings, never nested inside it"
  );

  // Done-when 2a: migrate() fills prefs on a pre-D45 v2 blob (already-current early-return path).
  const preD45V2 = { version: 1, tasks: [], slots: [], settings: { providerType: "local", sheetUrl: "", token: "" } };
  const filledV2 = migrate(preD45V2);
  assert(
    JSON.stringify(filledV2.prefs) === DEFAULT_PREFS,
    "7.U2 DONE-WHEN: migrate() fills prefs with the defaults on a pre-D45 v2 blob"
  );
  assert(
    !("prefs" in preD45V2),
    "7.U2: migrate() does not mutate its input — the pre-D45 fixture still has no prefs"
  );

  // Done-when 2b: migrate() fills prefs on the legacy v1 -> v2 upgrade path too.
  const legacyV1 = { tasks: [{ id: "L1", title: "old", due: "2026-01-02", pri: "high" }], slots: [], settings: { sheetUrl: "https://old" } };
  assert(
    JSON.stringify(migrate(legacyV1).prefs) === DEFAULT_PREFS,
    "7.U2: migrate() fills prefs on the legacy v1->v2 upgrade path as well"
  );

  // Done-when 2c: an existing prefs survives byte-unchanged (JSON-compared both ways).
  const realPrefs = { marker: "emoji", emoji: { blue: "\u{1F535}", teal: "\u{1F331}" } };
  const withPrefs = { version: 1, tasks: [], slots: [], settings: {}, prefs: realPrefs };
  const keptRaw = JSON.stringify(realPrefs);
  const kept = migrate(withPrefs);
  assert(
    JSON.stringify(kept.prefs) === keptRaw,
    "7.U2 DONE-WHEN: migrate() leaves an existing prefs byte-unchanged (no default clobbers it)"
  );
  assert(
    kept.prefs.marker === "emoji" && kept.prefs.emoji.blue === "\u{1F535}" && Object.keys(kept.prefs.emoji).length === 2,
    "7.U2: a real emoji map survives migrate() whole — the default {} never replaces it"
  );
  // Partial prefs: the missing field is default-filled, the present one is preserved (the token pattern).
  const partial = migrate({ version: 1, tasks: [], slots: [], settings: {}, prefs: { marker: "emoji" } });
  assert(
    partial.prefs.marker === "emoji" && JSON.stringify(partial.prefs.emoji) === "{}",
    "7.U2: migrate() default-fills only the MISSING prefs field (marker kept, emoji filled to {})"
  );
  // Idempotency: migrating twice changes nothing.
  assert(
    JSON.stringify(migrate(migrate(preD45V2))) === JSON.stringify(filledV2),
    "7.U2: migrate() stays idempotent with prefs in place"
  );

  // Done-when 3: markerFor's three cases.
  const blueTask = makeTask({ type: "finite", title: "paper", color: "blue" });
  const roseTask = makeTask({ type: "finite", title: "admin", color: "rose" });

  const underDefault = markerFor(blueTask, fresh.prefs);
  assert(
    underDefault.kind === "color" && underDefault.value === "blue",
    "7.U2 DONE-WHEN: markerFor returns the COLOUR under the default prefs (marker:'color')"
  );
  const emojiPrefs = { marker: "emoji", emoji: { blue: "\u{1F535}" } };
  const mapped = markerFor(blueTask, emojiPrefs);
  assert(
    mapped.kind === "emoji" && mapped.value === "\u{1F535}",
    "7.U2 DONE-WHEN: markerFor returns the EMOJI when the mode is 'emoji' and the category is mapped"
  );
  const unmapped = markerFor(roseTask, emojiPrefs);
  assert(
    unmapped.kind === "color" && unmapped.value === "rose",
    "7.U2 DONE-WHEN: markerFor falls back to the colour for an UNMAPPED category even in emoji mode"
  );
  // The mode alone is not enough: a mapping without emoji mode still renders the colour.
  const colorModeWithMap = markerFor(blueTask, { marker: "color", emoji: { blue: "\u{1F535}" } });
  assert(
    colorModeWithMap.kind === "color" && colorModeWithMap.value === "blue",
    "7.U2: a mapped category still renders its colour while the mode is 'color' (both conditions required)"
  );
  // Robustness: markerFor never throws on missing/empty inputs.
  assert(
    markerFor(blueTask, undefined).kind === "color" &&
      markerFor(blueTask, { marker: "emoji" }).kind === "color" &&
      markerFor(blueTask, { marker: "emoji", emoji: { blue: "" } }).kind === "color" &&
      markerFor({}, { marker: "emoji", emoji: {} }).value === null,
    "7.U2: markerFor never throws — missing prefs / missing emoji map / empty glyph / colourless task all resolve to kind:'color'"
  );
  // Every one of the 8 palette names is a usable key, and the glyph is returned verbatim.
  const allMapped = { marker: "emoji", emoji: {} };
  TASK_COLOR_NAMES.forEach((n, i) => { allMapped.emoji[n] = `g${i}`; });
  assert(
    TASK_COLOR_NAMES.length === 8 &&
      TASK_COLOR_NAMES.every((n, i) => {
        const r = markerFor(makeTask({ type: "finite", title: n, color: n }), allMapped);
        return r.kind === "emoji" && r.value === `g${i}`;
      }),
    "7.U2: the emoji map is keyed by all 8 palette names (03 Part B) and each resolves to its own glyph"
  );

  // Done-when 4: no Task record gained a field.
  assert(
    JSON.stringify(Object.keys(makeTask({ type: "finite", title: "x" })).sort()) === JSON.stringify(EXPECTED_TASK_FIELDS),
    "7.U2 DONE-WHEN: no Task record gained a field — makeTask's key set is unchanged"
  );
  assert(
    !("emoji" in blueTask) && !("marker" in blueTask),
    "7.U2 (D45): the emoji mapping lives in prefs, keyed by palette name — never on the Task"
  );
}

// --- 7.U3 Month renders emoji or colour markers per preference + picker (D45) ---
// Two DOM blocks (the 7.R3/5.M1 stub convention) plus static checks on the new CSS. The month
// block asserts the COLOUR mode renders byte-identically to 5.M1 first — that is the regression
// the Done-when cares most about — then flips `prefs` and re-mounts. Emoji legibility at 360px is
// explicitly deferred to 7.INT's phone pass by the spec; nothing here claims to judge it.
{
  // 7.A1 sub-step 4: PINNED. This block probes YESTERDAY's cell in the current month's grid, and
  // that cell does not exist when today is the 1st of a month beginning on a Sunday — the grid
  // starts at the Sunday on/before the 1st, so there is no earlier visible cell at all. Unpinned,
  // the suite did not merely fail on 2026-11-01, it THREW at `dotsOfDate` and took the remaining
  // ~180 assertions with it. The app is correct (an October deadline does not belong on the
  // November grid); the fixture's assumption was not. Mid-month, so both today and yesterday are
  // always real cells.
  const restoreClock = pinToday("2026-09-15");
  const { mountSettingsView } = await import("./js/views/settings.js");
  const { TASK_COLORS: TC } = await import("./js/state.js");

  function makeDomStub() {
    function el(tag) {
      return {
        tagName: String(tag).toUpperCase(), className: "", type: "", value: "", disabled: false,
        style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {},
        classList: { add(...cs) { this._n.className += " " + cs.join(" "); } },
        get textContent() { return this._t; },
        set textContent(v) { this.children = []; this._t = String(v); },
        setAttribute(k, v) { this._a[k] = String(v); },
        getAttribute(k) { return k in this._a ? this._a[k] : null; },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { for (const c of cs) this.children.push(c); },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); },
        addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
        focus() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 600 }; },
        dispatch(t) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
      };
    }
    const wrap = (tag) => { const n = el(tag); n.classList._n = n; return n; };
    globalThis.document = { createElement: wrap };
    return wrap("main");
  }
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const byClass = (root, c) => walk(root).filter((n) => (" " + n.className + " ").includes(" " + c + " "));
  const iso = (d) => d.toLocaleDateString("en-CA");
  const todayISO = iso(new Date());
  const yesterdayISO = iso(new Date(Date.now() - 86400000));
  // The dots of one dated cell. `buildDayCell` labels every cell with its own ISO date
  // (aria-label), which is the only date seam the view exposes — and an OVERDUE deadline renders
  // on its own past cell, not on today's, so the fixtures below need both.
  const dotsOfDate = (pane, dateISO) => {
    const cell = byClass(pane, "cal-day").find((c) => c.getAttribute("aria-label") === dateISO);
    return byClass(cell, "cal-dots")[0].children;
  };
  const dotsOfToday = (pane) => dotsOfDate(pane, todayISO);

  // ---- Part 1 (month grid): colour mode is unchanged; emoji mode swaps only mapped dots. ----
  const pane = makeDomStub();
  const mkState = (prefs) => {
    const st = makeAppState();
    if (prefs) st.prefs = prefs;
    st.tasks.push(makeTask({ type: "finite", title: "Blue deadline", color: "blue", deadline: todayISO }));
    st.tasks.push(makeTask({ type: "finite", title: "Rose deadline", color: "rose", deadline: todayISO }));
    return st;
  };

  // Done-when 1: with marker:"color" (the default) every dot is exactly 5.M1's — class "cal-dot"
  // only, the task colour painted as `background`, and NO text content.
  mountCalendarView(pane, mkState(), {});
  let dots = dotsOfToday(pane);
  assert(
    dots.length === 2 &&
      dots.every((d) => d.className === "cal-dot" && d._t === "") &&
      dots[0].style.background === TC.blue.solid && dots[1].style.background === TC.rose.solid,
    "7.U3 DONE-WHEN: with marker:'color' the dots render exactly as 5.M1 left them (class 'cal-dot', task colour as background, no glyph)"
  );

  // Done-when 2: emoji mode — a MAPPED category renders its glyph, an UNMAPPED one still renders
  // its colour dot (markerFor's fallback, not a rule restated in the view).
  mountCalendarView(pane, mkState({ marker: "emoji", emoji: { blue: "\u{1F4D8}" } }), {});
  dots = dotsOfToday(pane);
  assert(
    dots.length === 2 &&
      (" " + dots[0].className + " ").includes(" cal-dot-emoji ") && dots[0]._t === "\u{1F4D8}" &&
      dots[0].style.background === undefined,
    "7.U3 DONE-WHEN: with marker:'emoji' a mapped category renders its GLYPH and no colour fill"
  );
  assert(
    dots[1].className === "cal-dot" && dots[1]._t === "" && dots[1].style.background === TC.rose.solid,
    "7.U3 DONE-WHEN: an UNMAPPED category still renders its colour dot in emoji mode"
  );

  // Done-when 3: an overdue deadline stays flagged in BOTH modes.
  const overdueState = (prefs) => {
    const st = makeAppState();
    if (prefs) st.prefs = prefs;
    st.tasks.push(makeTask({ type: "finite", title: "Late", color: "blue", deadline: yesterdayISO }));
    st.tasks.push(makeTask({ type: "finite", title: "Blue today", color: "blue", deadline: todayISO }));
    return st;
  };
  mountCalendarView(pane, overdueState(), {});
  const overdueDot = dotsOfDate(pane, yesterdayISO).find((d) => d.style.background === "var(--danger)");
  assert(
    overdueDot !== undefined && dotsOfToday(pane).every((d) => d.style.background === TC.blue.solid),
    "7.U3 DONE-WHEN: in colour mode an overdue deadline's dot is still forced to --danger (5.M1's 'overdue always wins')"
  );
  mountCalendarView(pane, overdueState({ marker: "emoji", emoji: { blue: "\u{1F4D8}" } }), {});
  const lateDots = dotsOfDate(pane, yesterdayISO);
  const onTimeDots = dotsOfToday(pane);
  assert(
    lateDots.length === 1 && lateDots[0]._t === "\u{1F4D8}" &&
      (" " + lateDots[0].className + " ").includes(" cal-dot-overdue ") &&
      onTimeDots.length === 1 && onTimeDots[0]._t === "\u{1F4D8}" &&
      !(" " + onTimeDots[0].className + " ").includes(" cal-dot-overdue "),
    "7.U3 DONE-WHEN sub-step 2: in emoji mode the overdue item carries cal-dot-overdue (the --danger ring) while the same glyph for an on-time item does not"
  );

  // Done-when 4: the <=3-dots-then-"+n" cap (D21) still holds, in BOTH modes.
  const capState = (prefs) => {
    const st = makeAppState();
    if (prefs) st.prefs = prefs;
    for (let i = 0; i < 5; i++) {
      st.tasks.push(makeTask({ type: "finite", title: `d${i}`, color: "blue", deadline: todayISO }));
    }
    return st;
  };
  for (const [label, prefs] of [["colour", undefined], ["emoji", { marker: "emoji", emoji: { blue: "\u{1F4D8}" } }]]) {
    mountCalendarView(pane, capState(prefs), {});
    const cell = byClass(pane, "cal-day-today")[0];
    assert(
      byClass(cell, "cal-dot").length === 3 &&
        byClass(cell, "cal-dot-more").length === 1 && byClass(cell, "cal-dot-more")[0]._t === "+2",
      `7.U3 DONE-WHEN: the D21 cap is untouched in ${label} mode — 5 items render 3 dots + "+2"`
    );
  }

  // ---- Part 2 (the picker): structure, the onChange seam, and a real reload round-trip. ----
  const pickerPane = makeDomStub();
  const pickerState = makeAppState();
  let changes = 0;
  mountSettingsView(pickerPane, pickerState, { onChange: () => { changes++; } });

  const modeSelect = walk(pickerPane).find((n) => n.tagName === "SELECT");
  assert(
    modeSelect !== undefined && modeSelect.children.length === 2 &&
      modeSelect.children.map((o) => o.value).join(",") === "color,emoji" && modeSelect.value === "color",
    "7.U3 sub-step 4: the picker renders a 2-option marker-mode select, reflecting the current prefs.marker"
  );
  const emojiInputs = walk(pickerPane).filter((n) => n.dataset && n.dataset.category);
  assert(
    emojiInputs.length === 8 &&
      JSON.stringify(emojiInputs.map((i) => i.dataset.category)) === JSON.stringify(TASK_COLOR_NAMES),
    "7.U3 sub-step 4: exactly one emoji field per palette category, in state.js's own order (8 fields, no name re-typed in the view)"
  );
  assert(
    emojiInputs.every((i) => (" " + i.className + " ").includes(" form-control ") && i.getAttribute("aria-label")),
    "7.U3: every emoji field reuses .form-control (03 Part B's 16px input floor) and carries an accessible name"
  );
  assert(
    byClass(pickerPane, "settings-emoji-swatch").length === 8 &&
      byClass(pickerPane, "settings-emoji-swatch").map((sw) => sw.style.background).join(",") ===
        TASK_COLOR_NAMES.map((n) => TC[n].solid).join(","),
    "7.U3: each row's swatch is painted from TASK_COLORS (no hex invented in the view)"
  );

  // The onChange seam fires for both controls, and prefs is REPLACED, not mutated in place.
  const originalPrefs = pickerState.prefs;
  const originalEmojiMap = pickerState.prefs.emoji;
  modeSelect.value = "emoji";
  modeSelect.dispatch("change");
  assert(
    pickerState.prefs.marker === "emoji" && changes === 1,
    "7.U3 sub-step 4: changing the mode writes prefs.marker and persists through the onChange seam"
  );
  const blueInput = emojiInputs.find((i) => i.dataset.category === "blue");
  blueInput.value = "\u{1F4D8}";
  blueInput.dispatch("input");
  assert(
    pickerState.prefs.emoji.blue === "\u{1F4D8}" && changes === 2,
    "7.U3 sub-step 4: typing a glyph writes prefs.emoji[<category>] through the same onChange seam"
  );
  assert(
    pickerState.prefs !== originalPrefs && pickerState.prefs.emoji !== originalEmojiMap &&
      JSON.stringify(originalEmojiMap) === "{}",
    "7.U3: the picker REPLACES prefs/prefs.emoji instead of mutating them (migrate() shares the nested map by reference)"
  );
  blueInput.value = "   ";
  blueInput.dispatch("input");
  assert(
    pickerState.prefs.emoji.blue === "" && markerFor(makeTask({ type: "finite", title: "x", color: "blue" }), pickerState.prefs).kind === "color",
    "7.U3: clearing a field (or typing only spaces) stores '' and markerFor falls straight back to the colour"
  );

  // Done-when 5: the chosen emoji survives a RELOAD — the real app.js seam, the real provider,
  // a real (fake-backed) localStorage, and a second boot().
  {
    class FakeLocalStorage {
      #d = new Map();
      getItem(k) { return this.#d.has(k) ? this.#d.get(k) : null; }
      setItem(k, v) { this.#d.set(k, String(v)); }
      removeItem(k) { this.#d.delete(k); }
    }
    globalThis.localStorage = new FakeLocalStorage();
    await boot();
    const reloadPane = makeDomStub();
    mountSettingsView(reloadPane, getState(), { onChange: persistChange });
    const sel = walk(reloadPane).find((n) => n.tagName === "SELECT");
    sel.value = "emoji";
    sel.dispatch("change");
    const teal = walk(reloadPane).filter((n) => n.dataset && n.dataset.category).find((i) => i.dataset.category === "teal");
    teal.value = "\u{1F331}";
    teal.dispatch("input");
    await new Promise((r) => setTimeout(r, 0)); // persistChange is fire-and-forget
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    assert(
      raw !== null && JSON.parse(raw).prefs.emoji.teal === "\u{1F331}" && JSON.parse(raw).prefs.marker === "emoji",
      "7.U3 DONE-WHEN: the picker's writes reach localStorage through persistChange (prefs.marker + prefs.emoji both stored)"
    );
    await boot(); // the reload
    assert(
      getState().prefs.marker === "emoji" && getState().prefs.emoji.teal === "\u{1F331}",
      "7.U3 DONE-WHEN: a chosen emoji round-trips through a reload (second boot() reads it back)"
    );
    // ...and the reloaded state actually paints that glyph in the month grid.
    const afterPane = makeDomStub();
    const reloaded = getState();
    reloaded.tasks.push(makeTask({ type: "routine", title: "Prep", color: "teal", recurrence: { days: [0,1,2,3,4,5,6], time: "09:00", durationMin: 30, start: todayISO, end: todayISO } }));
    mountCalendarView(afterPane, reloaded, {});
    const afterDots = dotsOfToday(afterPane);
    assert(
      afterDots.length === 1 && afterDots[0]._t === "\u{1F331}" &&
        (" " + afterDots[0].className + " ").includes(" cal-dot-emoji "),
      "7.U3: end-to-end — the reloaded preference renders the glyph in the month grid (a routine occurrence, not just a deadline)"
    );
    delete globalThis.localStorage;
  }

  // ---- Part 3: static checks on the new CSS (no new hex; the overdue ring uses --danger). ----
  {
    const { readFileSync } = await import("node:fs");
    const cssSrc = readFileSync("./css/styles.css", "utf8");
    const sliceBetween = (from, to) => {
      const a = cssSrc.indexOf(from);
      const b = cssSrc.indexOf(to, a + 1);
      if (a < 0 || b <= a) throw new Error(`7.U3 CSS slice anchors not found: ${from} .. ${to}`);
      return cssSrc.slice(a, b);
    };
    const u3Blocks = [
      sliceBetween("/* Task 7.U3 (D45): emoji markers", "/* Month runway highlight"),
      sliceBetween("/* Day-markers picker (task 7.U3)", "button:disabled"),
    ].join("\n");
    assert(
      u3Blocks.includes(".cal-dot-overdue") && u3Blocks.includes(".settings-emoji-swatch") &&
        u3Blocks.split("\n").length > 10,
      "7.U3: the static CSS check really is reading both new blocks (slice anchors resolved)"
    );
    assert(
      u3Blocks.includes(".cal-dot-emoji") && !/#[0-9a-fA-F]{3,8}\b/.test(u3Blocks),
      "7.U3 DONE-WHEN: the new CSS introduces NO hex — the overdue ring and the swatches use existing tokens/TASK_COLORS"
    );
    assert(
      /\.cal-dot-overdue\s*\{[^}]*var\(--danger\)/.test(cssSrc) && /\.cal-dot-overdue\s*\{[^}]*var\(--danger-wash\)/.test(cssSrc),
      "7.U3 sub-step 2: .cal-dot-overdue draws its ring + wash from --danger / --danger-wash"
    );
    assert(
      /\.cal-dot-emoji\s*\{[^}]*border-radius:\s*0/.test(cssSrc) && /\.cal-dot-emoji\s*\{[^}]*font-size:\s*11px/.test(cssSrc),
      "7.U3: .cal-dot-emoji drops the 6px circle for an 11px glyph (the existing chip/weekday size, 03 Part B)"
    );
    assert(
      !/560px/.test(cssSrc) && !/\.settings-emoji-input\s*\{[^}]*font-size/.test(cssSrc),
      "7.U3 accessibility floor: no 560px breakpoint anywhere, and the emoji fields do not override .form-control's 16px floor"
    );
  }

  restoreClock();
  delete globalThis.document;
}

// --- 7.X1 exportState / parseImportedState (Export/Import, pure half) ---

{
  // Sub-step 2: a state with BOTH secrets actually set, so the exclusion is tested against a
  // populated settings block rather than the empty default.
  // Both fixture values are assembled from fragments ON PURPOSE: the fixture has to LOOK like a
  // real Apps Script deployment for the exclusion test to mean anything, but no committed line may
  // contain a literal exec URL or deployment prefix, or it becomes a false positive in 7.A2's
  // no-secrets grep over the shipped tree. Neither value is real.
  const EXEC_PATH = ["mac", "ros", "/s/"].join("");                 // the Apps Script path segment
  const DEPLOY_PREFIX = ["AK", "fyc", "b"].join("");                 // the Apps Script id prefix
  const fakeExecUrl = ["https://", "script", ".google", ".com/", EXEC_PATH, DEPLOY_PREFIX, "FAKE_NOT_REAL", "/exec"].join("");
  const fakeToken = ["s3c", "r3t", "-fixture-value"].join("");
  const secretState = {
    ...sampleState(),
    settings: {
      providerType: "sheets",
      sheetUrl: fakeExecUrl,
      token: fakeToken,
    },
    prefs: { marker: "emoji", emoji: { blue: "\u{1F4D8}", teal: "\u{1F331}" } },
  };
  const text = exportState(secretState);
  const parsedBack = JSON.parse(text);

  assert(
    !text.includes(fakeToken) && !text.includes(fakeExecUrl) &&
      !text.includes(EXEC_PATH) && !text.includes(DEPLOY_PREFIX) && !text.includes("s3c" + "r3t"),
    "7.X1 DONE-WHEN: the exported text carries NEITHER the token NOR the exec URL, even with both set"
  );
  assert(
    secretState.settings.token === fakeToken && secretState.settings.sheetUrl.includes(EXEC_PATH),
    "7.X1: that exclusion test is not vacuous — the input state really did carry both secrets"
  );
  assert(
    parsedBack.settings === undefined && !("settings" in parsedBack),
    "7.X1 sub-step 2: `settings` is absent from the export payload entirely (not merely blanked)"
  );
  assert(
    Object.keys(parsedBack).sort().join(",") === "prefs,slots,tasks,version",
    "7.X1 sub-step 1/2: the payload carries exactly version, tasks, slots, prefs (D45 prefs included)"
  );
  assert(
    parsedBack.prefs.marker === "emoji" && parsedBack.prefs.emoji.blue === "\u{1F4D8}",
    "7.X1 sub-step 2: the user's prefs travel in the export (7.U2's model)"
  );

  // Done-when 1: full round-trip, byte-identical tasks/slots.
  const seed = sampleState();
  const round = parseImportedState(exportState(seed));
  assert(
    JSON.stringify(round.tasks) === JSON.stringify(seed.tasks),
    "7.X1 DONE-WHEN: exportState(seed) -> parseImportedState round-trips `tasks` byte-identically"
  );
  assert(
    JSON.stringify(round.slots) === JSON.stringify(seed.slots),
    "7.X1 DONE-WHEN: exportState(seed) -> parseImportedState round-trips `slots` byte-identically"
  );
  assert(
    round.tasks.length === seed.tasks.length && round.tasks.length > 0 &&
      round.slots.length === seed.slots.length && round.slots.length > 0,
    "7.X1: that round-trip was not vacuous — the seed really does carry tasks AND slots"
  );
  assert(
    round.settings && round.settings.token === "" && round.settings.sheetUrl === "",
    "7.X1: the imported state's settings come back as the empty defaults — an import can never inject a token/exec URL"
  );

  // Done-when 3: every malformed blob THROWS and returns nothing.
  const throws = (input) => {
    let returned = "SENTINEL";
    try {
      returned = parseImportedState(input);
      return { threw: false, returned };
    } catch (e) {
      return { threw: true, returned, isError: e instanceof Error };
    }
  };
  const empty = throws("{}");
  assert(
    empty.threw && empty.isError && empty.returned === "SENTINEL",
    "7.X1 DONE-WHEN: parseImportedState(\"{}\") throws an Error and returns nothing"
  );
  const notJson = throws("not json");
  assert(
    notJson.threw && notJson.isError && notJson.returned === "SENTINEL",
    "7.X1 DONE-WHEN: parseImportedState(\"not json\") throws an Error and returns nothing"
  );
  const badTasks = throws(JSON.stringify({ version: 1, tasks: "x", slots: [] }));
  assert(
    badTasks.threw && badTasks.isError && badTasks.returned === "SENTINEL",
    "7.X1 DONE-WHEN: a blob with `tasks: \"x\"` is REJECTED (throws, returns nothing) — a malformed import can never wipe data"
  );
  const badSlots = throws(JSON.stringify({ version: 1, tasks: [], slots: { a: 1 } }));
  assert(
    badSlots.threw && badSlots.returned === "SENTINEL",
    "7.X1 sub-step 3: a non-array `slots` is rejected on the same rule as a non-array `tasks`"
  );
  const jsonArray = throws("[]");
  assert(
    jsonArray.threw && jsonArray.returned === "SENTINEL",
    "7.X1 sub-step 3: a top-level JSON array is rejected (valid JSON, not a PIN export)"
  );
  const jsonNull = throws("null");
  assert(
    jsonNull.threw && jsonNull.returned === "SENTINEL",
    "7.X1 sub-step 3: `null` is rejected rather than crashing on a property read"
  );

  // Done-when 4 / sub-step 4: an older file still imports, via the existing migrate() —
  // including 6.C2's string-version guard.
  const legacyText = JSON.stringify({
    version: "1",
    tasks: [{ id: "t1", title: "Old task", parentId: null, pri: "high", due: "2026-03-01", done: false }],
    slots: [{ id: "s1", date: "2026-03-01", hour: 9, taskId: "t1" }],
  });
  const legacy = parseImportedState(legacyText);
  assert(
    legacy.tasks.length === 1 && legacy.tasks[0].title === "Old task" &&
      legacy.prefs && legacy.prefs.marker === "color" &&
      legacy.settings && legacy.settings.providerType === "local",
    "7.X1 DONE-WHEN: a `version:\"1\"` (string) import still migrates correctly — 6.C2's guard holds on this path"
  );
  assert(
    JSON.stringify(legacy.tasks[0]) === JSON.stringify(JSON.parse(legacyText).tasks[0]),
    "7.X1 sub-step 4: a string-version blob takes migrate()'s already-current branch — its records pass through untouched (idempotent)"
  );

  // A genuinely pre-v2 file (no `version` at all) takes migrate()'s legacy branch: hour -> start.
  const v1Text = JSON.stringify({
    tasks: [{ id: "t9", title: "v1 task", parentId: null, pri: "low", due: "2026-04-02", done: true }],
    slots: [{ id: "s9", date: "2026-04-02", hour: 14, taskId: "t9" }],
  });
  const v1 = parseImportedState(v1Text);
  assert(
    v1.tasks[0].owner === "me" && v1.slots[0].owner === "me",
    "7.X1 sub-step 4: the legacy-branch import stamps owner:\"me\" on every migrated record"
  );
  assert(
    v1.version === 1 && v1.tasks[0].type === "finite" && v1.tasks[0].deadline === "2026-04-02" &&
      v1.tasks[0].done === true && v1.slots[0].start === "14:00" && v1.slots[0].durationMin === 60,
    "7.X1 sub-step 4: a pre-v2 export (no `version`) is routed through migrate()'s legacy branch (D30 hour -> start)"
  );

  // A hand-edited file that smuggles settings in must not be able to adopt them.
  const smuggled = parseImportedState(JSON.stringify({
    version: 1,
    tasks: [],
    slots: [],
    settings: { providerType: "sheets", sheetUrl: "https://not-a-real-host.invalid/exec", token: "injected-fixture-token" },
  }));
  assert(
    smuggled.settings.token === "" && smuggled.settings.sheetUrl === "" &&
      smuggled.settings.providerType === "local",
    "7.X1: a hand-edited file carrying `settings` cannot inject a sheetUrl/token — settings are dropped, not adopted"
  );

  // Done-when: js/logic.js still has no imports / DOM / storage.
  {
    const { readFileSync } = await import("node:fs");
    const logicSrc = readFileSync("./js/logic.js", "utf8");
    assert(
      !/^\s*import\s/m.test(logicSrc) && !/\brequire\s*\(/.test(logicSrc),
      "7.X1 DONE-WHEN: js/logic.js still has NO imports"
    );
    // `window` appears in this file only as a LOCAL const inside recurrenceSummary (3.R1), so the
    // probe is for property access / globals, not the bare identifier.
    assert(
      !/\bdocument\s*\./.test(logicSrc) && !/\bwindow\s*\./.test(logicSrc) &&
        !/localStorage/.test(logicSrc) && !/\bfetch\s*\(/.test(logicSrc),
      "7.X1 DONE-WHEN: js/logic.js still touches no DOM and no storage"
    );
    assert(
      logicSrc.includes("export function exportState"),
      "7.X1 sub-step 1: exportState really lives in js/logic.js (the purity check above is not vacuous)"
    );
  }
}

// --- 7.X2 Export / Import controls in the Settings view ---
// Headless DOM-stub block (the 7.U3 / 7.R3 convention) covering the four paths the Done-when
// names: Export, a malformed file, a cancelled confirm, and a confirmed import. Export needs two
// browser bits the stub does not have — a clickable anchor and the Blob/object-URL pair — so both
// are stubbed and CAPTURED, which is what lets the test read the bytes the view actually handed
// to the browser instead of trusting that it called exportState.
{
  const { mountSettingsView } = await import("./js/views/settings.js");

  function makeDomStub() {
    function el(tag) {
      return {
        tagName: String(tag).toUpperCase(), className: "", type: "", value: "", disabled: false,
        style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {}, _clicks: 0,
        classList: { add(...cs) { this._n.className += " " + cs.join(" "); } },
        get textContent() { return this._t; },
        set textContent(v) { this.children = []; this._t = String(v); },
        setAttribute(k, v) { this._a[k] = String(v); },
        getAttribute(k) { return k in this._a ? this._a[k] : null; },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { for (const c of cs) this.children.push(c); },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); },
        addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
        click() { this._clicks++; },
        focus() {},
        dispatch(t) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
      };
    }
    const wrap = (tag) => { const n = el(tag); n.classList._n = n; return n; };
    globalThis.document = { createElement: wrap };
    return wrap("main");
  }
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const byClass = (root, c) => walk(root).filter((n) => (" " + n.className + " ").includes(" " + c + " "));
  const tick = () => new Promise((r) => setTimeout(r, 0)); // the file read + the deferred revoke
  const fileStub = (text) => ({ name: "pin.json", text: async () => text });

  // Object-URL + Blob capture. `URL` keeps its identity (other modules construct real URLs); only
  // the two static helpers are added, and both are restored at the end of the block.
  const created = [];
  const revoked = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const origBlob = globalThis.Blob;
  URL.createObjectURL = (blob) => { const u = `blob:stub/${created.length}`; created.push({ url: u, blob }); return u; };
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  globalThis.Blob = class BlobStub {
    constructor(parts, opts = {}) { this.parts = parts; this.type = opts.type || ""; }
    get text() { return this.parts.join(""); }
  };

  // Same assembled-fragment fixtures 7.X1 uses: the state must really carry both secrets for the
  // "the file has no secrets" check to mean anything, while no committed line holds a literal exec
  // URL or deployment prefix that would trip 7.A2's no-secrets grep. Neither value is real.
  const EXEC_PATH = ["mac", "ros", "/s/"].join("");
  const DEPLOY_PREFIX = ["AK", "fyc", "b"].join("");
  const liveExecUrl = ["https://", "script", ".google", ".com/", EXEC_PATH, DEPLOY_PREFIX, "FAKE_NOT_REAL", "/exec"].join("");
  const liveToken = ["s3c", "r3t", "-fixture-value"].join("");

  const pane = makeDomStub();
  const live = sampleState();
  live.settings = { providerType: "sheets", sheetUrl: liveExecUrl, token: liveToken };
  live.prefs = { marker: "color", emoji: {} };
  let changes = 0;
  let replaced = 0;
  let confirms = 0;
  let confirmMsg = "";
  let confirmReturn = true;
  mountSettingsView(pane, live, {
    onChange: () => { changes++; },
    // 7.X-INT: counters only here (no re-render), so the rest of this block keeps its original
    // element references; the real re-mounting hook is exercised in the 7.X-INT block below.
    onStateReplaced: () => { replaced++; },
    confirm: (msg) => { confirms++; confirmMsg = msg; return confirmReturn; },
  });

  // ---- Done-when 1: both controls are REAL elements, inside a settings form. ----
  const dataForm = byClass(pane, "settings-data")[0];
  assert(
    dataForm !== undefined && dataForm.tagName === "FORM" &&
      (" " + dataForm.className + " ").includes(" settings-form "),
    "7.X2 DONE-WHEN: the Export/Import controls live in their own .settings-form inside the Settings view"
  );
  const exportBtn = walk(dataForm).find((n) => n.tagName === "BUTTON");
  assert(
    exportBtn !== undefined && exportBtn.type === "button" &&
      (" " + exportBtn.className + " ").includes(" btn ") && exportBtn._t === "Export to a file",
    "7.X2 DONE-WHEN: Export is a real <button> reusing .btn (sub-step 4: no new hex)"
  );
  const fileInput = walk(dataForm).find((n) => n.tagName === "INPUT" && n.type === "file");
  assert(
    fileInput !== undefined && (" " + fileInput.className + " ").includes(" form-control "),
    "7.X2 DONE-WHEN: Import is a real <input type=\"file\"> reusing .form-control (03 Part B's 16px input floor)"
  );
  assert(
    walk(dataForm).some((n) => (" " + n.className + " ").includes(" form-field ") && n.children.includes(fileInput)) &&
      walk(dataForm).some((n) => (" " + n.className + " ").includes(" form-label ") && n._t === "Import from a file"),
    "7.X2: the file input carries a visible .form-label through the shared appendField helper (accessible name, no bare control)"
  );
  const statusEls = byClass(dataForm, "settings-status");
  assert(
    statusEls.length === 2 && statusEls.every((el) => el.getAttribute("aria-live") === "polite"),
    "7.X2 sub-step 4: the two status lines reuse .settings-status and are announced (aria-live=polite)"
  );

  // ---- Done-when 2: Export names a DATED .json and hands over exportState's bytes. ----
  exportBtn.dispatch("click");
  assert(created.length === 1, "7.X2 sub-step 1: clicking Export creates exactly one object URL");
  const expectedName = `pin-export-${new Date().toLocaleDateString("en-CA")}.json`;
  const exportStatus = statusEls[0];
  assert(
    exportStatus._t === `Exported ${expectedName}.` && exportStatus.className === "settings-status ok",
    `7.X2 DONE-WHEN: Export names a dated .json (${expectedName}) — local en-CA date, never toISOString`
  );
  assert(
    /^pin-export-\d{4}-\d{2}-\d{2}\.json$/.test(expectedName) && created[0].blob.type === "application/json",
    "7.X2 sub-step 1: the downloaded name matches pin-export-YYYY-MM-DD.json and the blob is application/json"
  );
  assert(
    JSON.stringify(JSON.parse(created[0].blob.text)) === JSON.stringify(JSON.parse(exportState(live))),
    "7.X2 sub-step 1: the bytes handed to the browser are exportState(state)'s — the view has no serializer of its own"
  );
  assert(
    !created[0].blob.text.includes(liveToken) && !created[0].blob.text.includes(EXEC_PATH) &&
      live.settings.token === liveToken && live.settings.sheetUrl.includes(EXEC_PATH),
    "7.X2: the exported file carries neither the token nor the exec URL, on a state that really holds both (7.X1 sub-step 2 holding at the UI layer)"
  );
  assert(
    !walk(pane).some((n) => n.tagName === "A"),
    "7.X2 sub-step 1: the transient download anchor is removed again — Export leaves no DOM behind"
  );
  await tick();
  assert(
    revoked.length === 1 && revoked[0] === created[0].url,
    "7.X2 sub-step 1: the object URL is revoked (on the next macrotask, not inside the click) — no leak"
  );
  assert(changes === 0 && confirms === 0, "7.X2: Export is non-destructive — it neither persists nor asks for confirmation");

  // ---- Done-when 3: a malformed file shows an error and leaves state UNTOUCHED. ----
  const tasksRef = live.tasks;
  const slotsRef = live.slots;
  const beforeTasks = JSON.stringify(live.tasks);
  const beforeSlots = JSON.stringify(live.slots);
  const importStatus = statusEls[1];
  fileInput.files = [fileStub("not json")];
  fileInput.dispatch("change");
  await tick();
  assert(
    importStatus.className === "settings-status error" && /^Import failed: /.test(importStatus._t),
    "7.X2 DONE-WHEN: a malformed file shows the existing .settings-status ERROR state (sub-step 3)"
  );
  assert(
    live.tasks === tasksRef && live.slots === slotsRef &&
      JSON.stringify(live.tasks) === beforeTasks && JSON.stringify(live.slots) === beforeSlots,
    "7.X2 DONE-WHEN: a malformed file leaves tasks/slots untouched (same arrays, same contents)"
  );
  assert(
    confirms === 0,
    "7.X2 sub-step 3: the file is validated BEFORE the confirm, so an unreadable file never asks the user a destructive question"
  );
  // The same holds for valid JSON that is not a PIN export (7.X1's tasks-not-an-array rejection).
  fileInput.files = [fileStub(JSON.stringify({ version: 1, tasks: "x", slots: [] }))];
  fileInput.dispatch("change");
  await tick();
  assert(
    importStatus.className === "settings-status error" && live.tasks === tasksRef && confirms === 0,
    "7.X2: a blob whose `tasks` is not an array is rejected the same way — error shown, nothing replaced, no confirm"
  );

  // ---- Done-when 4: cancelling the confirm changes NOTHING. ----
  const incoming = makeAppState();
  incoming.tasks.push(makeTask({ type: "finite", title: "Imported task", color: "teal", deadline: "2026-12-01" }));
  incoming.slots.push(makeSlot({ date: "2026-12-01", start: "08:00", durationMin: 45, taskId: incoming.tasks[0].id }));
  incoming.prefs = { marker: "emoji", emoji: { teal: "\u{1F331}" } };
  const incomingText = exportState(incoming);

  confirmReturn = false;
  fileInput.files = [fileStub(incomingText)];
  fileInput.dispatch("change");
  await tick();
  assert(
    confirms === 1 && /replace your local/i.test(confirmMsg),
    "7.X2 sub-step 3: a VALID file does go behind the injectable confirm() seam Push/Pull use"
  );
  assert(
    live.tasks === tasksRef && live.slots === slotsRef &&
      JSON.stringify(live.tasks) === beforeTasks && JSON.stringify(live.slots) === beforeSlots &&
      importStatus.className === "settings-status",
    "7.X2 DONE-WHEN: cancelling the confirm changes nothing (and clears the error state rather than claiming a failure)"
  );

  // ---- Done-when 5: a valid file behind a CONFIRMED dialog replaces tasks/slots. ----
  confirmReturn = true;
  fileInput.files = [fileStub(incomingText)];
  fileInput.dispatch("change");
  await tick();
  assert(
    confirms === 2 && JSON.stringify(live.tasks) === JSON.stringify(incoming.tasks) &&
      JSON.stringify(live.slots) === JSON.stringify(incoming.slots),
    "7.X2 DONE-WHEN: a valid file behind a confirmed dialog replaces tasks/slots byte-identically"
  );
  assert(
    live.tasks !== tasksRef && live.tasks.length === 1 && live.slots.length === 1 &&
      beforeTasks !== JSON.stringify(incoming.tasks),
    "7.X2: that replacement was not vacuous — the arrays really changed from the pre-import ones"
  );
  assert(
    importStatus.className === "settings-status ok" && importStatus._t === "Imported 1 task(s) and 1 slot(s).",
    "7.X2: a successful import reports what it loaded through the same .settings-status line"
  );
  assert(
    live.settings.token === liveToken && live.settings.sheetUrl === liveExecUrl &&
      live.settings.providerType === "sheets",
    "7.X2: the LIVE local-only settings survive an import untouched — the caller never spreads the parsed state wholesale (7.X1's review note)"
  );
  assert(
    live.prefs.marker === "emoji" && live.prefs.emoji.teal === "\u{1F331}",
    "7.X2: the D45 prefs the export carries are adopted too, so 7.X1 sub-step 2's prefs payload is not dead weight"
  );
  assert(
    live.tasks[0].owner === "me" && live.slots[0].owner === "me",
    "7.X2: every imported record still carries owner:\"me\" (golden rule 5 — parseImportedState's migrate() stamps it)"
  );
  // FLIPPED HERE (7.X-INT sub-step 1). 7.X2 asserted `changes === 0` to prove it had not built
  // ahead; the same harness now proves the opposite, and proves it is scoped to the ONE confirmed
  // import: two malformed files and one cancelled confirm came first and none of them may persist
  // or re-render.
  assert(
    changes === 1 && replaced === 1,
    "7.X-INT sub-step 1: a confirmed import calls onChange (persist) AND onStateReplaced (re-render), exactly once each"
  );

  // Golden rule 4 at this layer: the view does its own DOM/Blob work but no storage or network.
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./js/views/settings.js", "utf8");
    assert(
      !/localStorage/.test(src) && !/\bfetch\s*\(/.test(src),
      "7.X2 (golden rule 4): js/views/settings.js still touches neither localStorage nor fetch()"
    );
    // Matched on the named binding rather than the whole import line: 7.U5 added
    // `normalizeExecUrl` to the same `../logic.js` import, which is not a 7.X2 regression.
    assert(
      /import\s*\{[^}]*\bexportState\b[^}]*\}\s*from\s*"\.\.\/logic\.js"/.test(src) &&
        /parseImportedState/.test(src),
      "7.X2: the view reuses 7.X1's exportState/parseImportedState rather than re-deriving either"
    );
  }

  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
  globalThis.Blob = origBlob;
  delete globalThis.document;
}

// --- 7.X-INT: Export/Import wired to REAL state (persist + re-render + full round-trip) ---
//
// 7.X2 built the controls against an in-memory state only and said so in its own assertion. The
// three things that were missing are the three things asserted here: the import persists (so it
// survives a reload), the pane is rebuilt from the replaced state (so 7.U3's marker picker stops
// showing the pre-import mapping), and the local-only `settings` — token included — comes back
// untouched on the other side of the reload, not merely in memory.
//
// The seam is the REAL one: `onChange: persistChange` (js/app.js's own export) writing through
// LocalStorageProvider into a spy `localStorage`, and an `onStateReplaced` that re-mounts the view
// from `getState()` exactly as `js/app.js`'s `show(current)` does. "Reload" is a second real
// `boot()` against the same storage, not a simulated one.
{
  const { mountSettingsView } = await import("./js/views/settings.js");

  function makeDomStub() {
    function el(tag) {
      return {
        tagName: String(tag).toUpperCase(), className: "", type: "", value: "", disabled: false,
        style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {}, _clicks: 0,
        classList: { add(...cs) { this._n.className += " " + cs.join(" "); } },
        get textContent() { return this._t; },
        set textContent(v) { this.children = []; this._t = String(v); },
        setAttribute(k, v) { this._a[k] = String(v); },
        getAttribute(k) { return k in this._a ? this._a[k] : null; },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { for (const c of cs) this.children.push(c); },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); },
        addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
        click() { this._clicks++; },
        focus() {},
        dispatch(t) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
      };
    }
    const wrap = (tag) => { const n = el(tag); n.classList._n = n; return n; };
    globalThis.document = { createElement: wrap };
    return wrap("main");
  }
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const byClass = (root, c) => walk(root).filter((n) => (" " + n.className + " ").includes(" " + c + " "));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fileStub = (text) => ({ name: "pin.json", text: async () => text });

  // Same assembled-fragment convention 7.X1/7.X2 use: a real-shaped exec URL and token with no
  // committed literal that 7.A2's no-secrets grep could mistake for the real thing.
  const EXEC_PATH = ["mac", "ros", "/s/"].join("");
  const DEPLOY_PREFIX = ["AK", "fyc", "b"].join("");
  const liveExecUrl = ["https://", "script", ".google", ".com/", EXEC_PATH, DEPLOY_PREFIX, "FAKE_NOT_REAL", "/exec"].join("");
  const liveToken = ["s3c", "r3t", "-fixture-value"].join("");

  globalThis.localStorage = makeSpyStorage();

  // Phase 1 — a real booted app holding the user's data and a configured, connected Sheet.
  await boot({ search: "" });
  const seeded = sampleState();
  const s0 = getState();
  s0.tasks = seeded.tasks;
  s0.slots = seeded.slots;
  s0.prefs = { marker: "color", emoji: {} };
  s0.settings = { providerType: "sheets", sheetUrl: liveExecUrl, token: liveToken };
  persistChange(s0);

  // Phase 2 — Export, through the same pure function the button uses.
  const exported = exportState(getState());
  const expectedTasks = JSON.stringify(getState().tasks);
  const expectedSlots = JSON.stringify(getState().slots);
  assert(
    JSON.parse(exported).tasks.length > 0 && JSON.parse(exported).slots.length > 0,
    "7.X-INT: the exported payload really carries tasks AND slots (the round-trip below is not vacuous)"
  );

  // Phase 3 — the SAME browser is then emptied (the "I lost my data / new device" case the
  // feature exists for), keeping the local-only settings a real user would still have.
  const s1 = getState();
  s1.tasks = [];
  s1.slots = [];
  s1.prefs = { marker: "color", emoji: {} };
  persistChange(s1);
  assert(
    (await new LocalStorageProvider().load()).tasks.length === 0,
    "7.X-INT: the pre-import browser really is empty on disk (the import below is what refills it)"
  );

  // Phase 4 — mount Settings on the real seam and import the exported file.
  const pane = makeDomStub();
  let replaced = 0;
  let confirmReturn = true;
  const opts = {
    onChange: persistChange, // js/app.js's own seam — the only path to storage (golden rule 4)
    // Mirrors js/app.js `show(current)`: re-mount the current view from the shell's fresh state.
    onStateReplaced: () => {
      replaced++;
      mountSettingsView(pane, getState(), opts);
    },
    confirm: () => confirmReturn,
  };
  mountSettingsView(pane, getState(), opts);

  let fileInput = walk(pane).find((n) => n.tagName === "INPUT" && n.type === "file");
  fileInput.files = [fileStub(exported)];
  fileInput.dispatch("change");
  await tick();

  assert(replaced === 1, "7.X-INT sub-step 1: a confirmed import fires onStateReplaced, so the shell re-renders the current view");

  // Done-when 1 (the reload half): a SECOND real boot() against the same storage.
  await boot({ search: "" });
  const afterReload = getState();
  assert(
    JSON.stringify(afterReload.tasks) === expectedTasks,
    "7.X-INT DONE-WHEN: export -> import -> reload returns byte-identical `tasks`"
  );
  assert(
    JSON.stringify(afterReload.slots) === expectedSlots,
    "7.X-INT DONE-WHEN: export -> import -> reload returns byte-identical `slots`"
  );
  assert(
    afterReload.tasks.every((t) => t.owner === "me") && afterReload.slots.every((x) => x.owner === "me"),
    "7.X-INT: every record that survived the round-trip still carries owner:\"me\" (golden rule 5)"
  );

  // Done-when 2: the local-only settings survive the import AND the reload. The exported file
  // never carried them, so they must be neither adopted from it nor nulled.
  assert(
    afterReload.settings.token === liveToken &&
      afterReload.settings.sheetUrl === liveExecUrl &&
      afterReload.settings.providerType === "sheets",
    "7.X-INT DONE-WHEN: `settings.token` and `settings.sheetUrl` are unchanged across an import (verified after a reload, not just in memory)"
  );
  assert(
    !/(s3cr3t|FAKE_NOT_REAL)/.test(exported),
    "7.X-INT: that survival is not because the file smuggled them back — the export carries neither (7.X1 sub-step 2)"
  );

  // The re-render is not just a counter: the re-mounted pane reflects the imported state, which
  // is the 7.X2 review's stale-marker-picker watch-item, and the success status survives it.
  const importedPrefs = JSON.parse(exported).prefs;
  const emojiState = makeAppState();
  emojiState.tasks.push(makeTask({ type: "finite", title: "Marker probe", color: "teal" }));
  emojiState.prefs = { marker: "emoji", emoji: { teal: "\u{1F331}" } };
  fileInput = walk(pane).find((n) => n.tagName === "INPUT" && n.type === "file");
  fileInput.files = [fileStub(exportState(emojiState))];
  fileInput.dispatch("change");
  await tick();
  assert(replaced === 2 && importedPrefs.marker === "color", "7.X-INT: the second import also re-rendered, from a pane whose picker had been showing `color`");
  const modeSelect = walk(pane).find((n) => n.tagName === "SELECT");
  const tealInput = walk(pane).find((n) => n.dataset.category === "teal");
  assert(
    modeSelect !== undefined && modeSelect.value === "emoji" &&
      tealInput !== undefined && tealInput.value === "\u{1F331}",
    "7.X-INT sub-step 1: the re-render rebuilds 7.U3's marker picker from the IMPORTED prefs (no stale pre-import mapping)"
  );
  const importStatus = byClass(pane, "settings-data")[0] &&
    byClass(byClass(pane, "settings-data")[0], "settings-status")[1];
  assert(
    importStatus !== undefined && importStatus.className === "settings-status ok" &&
      importStatus._t === "Imported 1 task(s) and 0 slot(s).",
    "7.X-INT: the success message survives the re-render (the status is set after the hook, into the freshly-rendered element)"
  );

  // Non-destructive at the PERSISTENCE layer too, not just in memory: a malformed file and a
  // cancelled confirm must leave the stored blob exactly as the last good import left it.
  const storedAfterGoodImport = globalThis.localStorage.getItem(STORAGE_KEY);
  fileInput = walk(pane).find((n) => n.tagName === "INPUT" && n.type === "file");
  fileInput.files = [fileStub("not json")];
  fileInput.dispatch("change");
  await tick();
  assert(
    globalThis.localStorage.getItem(STORAGE_KEY) === storedAfterGoodImport && replaced === 2,
    "7.X-INT: a malformed file persists nothing and re-renders nothing (D26 rule 2 holds at the storage layer)"
  );
  confirmReturn = false;
  fileInput.files = [fileStub(exported)];
  fileInput.dispatch("change");
  await tick();
  assert(
    globalThis.localStorage.getItem(STORAGE_KEY) === storedAfterGoodImport && replaced === 2,
    "7.X-INT: a cancelled confirm persists nothing and re-renders nothing"
  );

  // Sub-step 1, at the call site: the shell must actually PASS the hook, or firing it is a no-op.
  // 7.R2's own convention for asserting something about js/app.js's wiring.
  {
    const { readFileSync } = await import("node:fs");
    const appSrc = readFileSync("./js/app.js", "utf8");
    const mount = appSrc.slice(appSrc.indexOf("settings:"), appSrc.indexOf("};", appSrc.indexOf("settings:")));
    assert(
      /onChange:\s*persistChange/.test(mount) && /onStateReplaced\s*:/.test(mount),
      "7.X-INT sub-step 1: js/app.js's settings mount passes BOTH onChange and onStateReplaced (the hook was a documented no-op until now)"
    );
    assert(
      /show\(current\)/.test(mount),
      "7.X-INT sub-step 1: that hook re-mounts the CURRENT view through the shell's own show(), not a bespoke re-render path"
    );

    // Wiring the hook to a real re-mount makes BOTH its callers depend on one ordering
    // invariant: fire the hook, THEN write the status line — because the re-render replaces the
    // status element. Import proves it behaviourally above; `pull()` has no headless seam (it
    // needs a real SheetsProvider, so 6.U-INT/6.INT verified it against real Google), so its half
    // of the invariant is asserted structurally here rather than claimed as tested.
    const setSrc = readFileSync("./js/views/settings.js", "utf8");
    const bodyOf = (name) => {
      const from = setSrc.indexOf(`async function ${name}(`);
      return setSrc.slice(from, setSrc.indexOf("\n}", from));
    };
    for (const fn of ["pull", "importFile"]) {
      const body = bodyOf(fn);
      const hook = body.indexOf("_onStateReplaced(");
      // The SUCCESS call specifically — the one passing "ok" — not simply the last setStatus in
      // the body, which in `pull()` is the catch block's error status and would pass vacuously.
      const okStatus = body.lastIndexOf("setStatus(", body.indexOf('"ok"'));
      assert(
        hook !== -1 && body.indexOf('"ok"') !== -1 && okStatus > hook,
        `7.X-INT: ${fn}() fires onStateReplaced BEFORE writing its SUCCESS status, so the message survives the re-render app.js now performs`
      );
    }

    // Sub-step 3 / Done-when 3: the golden-rule grep, run as an assertion rather than by hand.
    const { readdirSync, statSync } = await import("node:fs");
    const files = [];
    (function crawl(dir) {
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) crawl(full);
        else if (name.endsWith(".js")) files.push(full);
      }
    })("./js");
    const offenders = files.filter(
      (f) => f !== "./js/storage.js" && /localStorage|fetch\s*\(/.test(readFileSync(f, "utf8"))
    );
    assert(
      offenders.length === 0,
      `7.X-INT DONE-WHEN: the golden-rule grep is empty — no localStorage/fetch( outside js/storage.js (${files.length} modules scanned)`
    );
  }

  delete globalThis.document;
  delete globalThis.localStorage;
}

// --- 7.U5 Sheets exec-URL entry accepts a deployment ID + paste ---
// Two halves, matching the task's two testable surfaces: the pure normaliser (sub-step 2) and the
// Settings field + Paste control that consume it (sub-steps 3-4). No literal deployment id or
// exec URL is committed here — every fixture is assembled from fragments, the convention 7.X1/7.X2
// adopted so 7.A2's no-secrets grep stays meaningful. None of these values is real.
{
  const EXEC_HOST = ["https://", "script", ".google", ".com/", "mac", "ros", "/s/"].join("");
  const ID = ["AK", "fyc", "b"].join("") + "x".repeat(48) + "_-9";   // 57 chars, base64url, fake
  const CANONICAL = EXEC_HOST + ID + "/exec";

  // ---- Sub-step 2 / Done-when 1: the three accepted forms all yield the IDENTICAL canonical URL.
  const fromFull = normalizeExecUrl(CANONICAL);
  const fromBare = normalizeExecUrl(ID);
  const fromPadded = normalizeExecUrl("   " + ID + "  \n");
  assert(
    fromFull.ok && fromFull.url === CANONICAL,
    "7.U5 DONE-WHEN: a full pasted exec URL normalises to the canonical exec URL"
  );
  assert(
    fromBare.ok && fromBare.url === CANONICAL,
    "7.U5 DONE-WHEN: a BARE deployment id normalises to the same canonical exec URL"
  );
  assert(
    fromPadded.ok && fromPadded.url === CANONICAL,
    "7.U5 DONE-WHEN: an id with surrounding whitespace normalises to the same canonical exec URL"
  );
  assert(
    fromFull.url === fromBare.url && fromBare.url === fromPadded.url,
    "7.U5 DONE-WHEN: all three accepted forms are byte-identical to each other, not merely each valid"
  );
  assert(
    CANONICAL === EXEC_URL_BASE + ID + EXEC_URL_SUFFIX,
    "7.U5 sub-step 2: the canonical shape is built from the exported 03 Part C constants, not a literal in the view"
  );

  // The tolerant paste cases 03 Part C names: http, a trailing slash, and a copied query/fragment.
  for (const [label, input] of [
    ["http:// is canonicalised to https://", "http://" + CANONICAL.slice("https://".length)],
    ["a trailing slash is dropped", CANONICAL + "/"],
    ["a copied ?query is dropped", CANONICAL + "?usp=sharing"],
    ["a copied #fragment is dropped", CANONICAL + "#top"],
  ]) {
    const r = normalizeExecUrl(input);
    assert(r.ok && r.url === CANONICAL, `7.U5 sub-step 2: ${label}`);
  }

  // ---- Done-when 2: rejection, never a silently fabricated URL. ----
  for (const [label, input] of [
    ["a non-Apps-Script host", "https://example.com/" + ["mac", "ros", "/s/"].join("") + ID + "/exec"],
    ["a /dev deployment URL", EXEC_HOST + ID + "/dev"],
    ["the exec URL with no id at all", EXEC_HOST + "/exec"],
    ["a short typo'd string", "not-an-id"],
    ["an empty field", ""],
    ["whitespace only", "   "],
    ["a non-string", null],
    ["a number", 12345],
  ]) {
    const r = normalizeExecUrl(input);
    assert(
      r.ok === false && r.url === undefined && typeof r.error === "string" && r.error !== "",
      `7.U5 DONE-WHEN: ${label} is REJECTED with an error and no constructed URL`
    );
  }
  assert(
    normalizeExecUrl(ID).url.indexOf(ID) !== -1 && normalizeExecUrl("y".repeat(29)).ok === false &&
      normalizeExecUrl("y".repeat(30)).ok === true,
    "7.U5 sub-step 2: the 30-character id floor (03 Part C) is exactly where accept/reject flips"
  );

  // ---- Sub-steps 3-4, against the REAL js/views/settings.js through a DOM stub. ----
  const { mountSettingsView } = await import("./js/views/settings.js");
  function makeDomStub() {
    function el(tag) {
      return {
        tagName: String(tag).toUpperCase(), className: "", type: "", value: "", disabled: false,
        style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {},
        classList: { add(...cs) { this._n.className += " " + cs.join(" "); } },
        get textContent() { return this._t; },
        set textContent(v) { this.children = []; this._t = String(v); },
        setAttribute(k, v) { this._a[k] = String(v); },
        getAttribute(k) { return k in this._a ? this._a[k] : null; },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { for (const c of cs) this.children.push(c); },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); },
        addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
        click() {}, focus() {},
        dispatch(t) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
      };
    }
    const wrap = (tag) => { const n = el(tag); n.classList._n = n; return n; };
    globalThis.document = { createElement: wrap };
    return wrap("main");
  }
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const byClass = (root, c) => walk(root).filter((n) => (" " + n.className + " ").includes(" " + c + " "));
  const labelOf = (input, root) =>
    walk(root).filter((n) => n.children.includes(input)).map((w) => (w.children[0] || {})._t)[0];
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (v) =>
    Object.defineProperty(globalThis, "navigator", { value: v, configurable: true, writable: true });

  // (a) No clipboard API -> no Paste button, and the typed field is the whole story.
  setNavigator({});
  let pane = makeDomStub();
  let live = makeAppState();
  live.settings.sheetUrl = CANONICAL;   // an exec URL stored BEFORE this task existed
  live.settings.token = ["s3c", "r3t"].join("");
  let changes = 0;
  mountSettingsView(pane, live, { onChange: () => { changes++; } });

  const buttonsOf = (root) => walk(root).filter((n) => n.tagName === "BUTTON").map((b) => b._t);
  assert(
    !buttonsOf(pane).includes("Paste"),
    "7.U5 DONE-WHEN: with no navigator.clipboard.readText the Paste control is not rendered at all — the field degrades to typing"
  );

  const urlField = walk(pane).filter((n) => n.tagName === "INPUT" && n.value === CANONICAL)[0];
  assert(urlField !== undefined, "7.U5 DONE-WHEN: an already-stored full exec URL still renders in the field verbatim");
  assert(
    live.settings.sheetUrl === CANONICAL && changes === 0,
    "7.U5 DONE-WHEN: mounting does NOT migrate or rewrite an existing settings.sheetUrl (no persistence fired)"
  );
  assert(
    labelOf(urlField, pane) === "Deployment ID or exec URL",
    "7.U5 sub-step 3: the field is relabelled to name BOTH accepted forms"
  );
  assert(
    urlField.type === "text" && urlField.getAttribute("autocapitalize") === "none" &&
      urlField.getAttribute("autocorrect") === "off" && urlField.getAttribute("spellcheck") === "false",
    "7.U5 sub-step 3: type=\"text\" (a bare id is not a URL) with autocapitalise/autocorrect off — an id survives a phone keyboard"
  );

  // Typing a BARE id stores the canonical URL, so connect()/SheetsProvider are untouched by 7.U5.
  urlField.value = ID;
  urlField.dispatch("input");
  assert(
    live.settings.sheetUrl === CANONICAL && changes === 1,
    "7.U5 sub-step 3: typing a bare deployment id STORES the canonical exec URL through the existing onChange seam"
  );
  const hint = byClass(pane, "settings-status")[0];
  assert(
    hint._t === "Saved as the full exec URL." && hint.className.includes("ok"),
    "7.U5 sub-step 3: a value that normalises reports success on the shared .settings-status line"
  );

  // Unrecognised input is stored RAW — never turned into a plausible-looking wrong endpoint.
  urlField.value = "https://example.com/exec";
  urlField.dispatch("change");
  assert(
    live.settings.sheetUrl === "https://example.com/exec" &&
      live.settings.sheetUrl.indexOf("script.google") === -1,
    "7.U5 DONE-WHEN: an unrecognised value is kept verbatim — the view never fabricates an exec URL from it"
  );
  // 7.A1 sub-step 4: same shape, same guard — the point is that the view does not author its own
  // copy of the message, but "both are undefined" must not be able to satisfy it.
  assert(
    typeof normalizeExecUrl("https://example.com/exec").error === "string" &&
      normalizeExecUrl("https://example.com/exec").error.length > 0 &&
      hint._t === normalizeExecUrl("https://example.com/exec").error && hint.className.includes("error"),
    "7.U5 sub-step 3: the rejection is stated on blur, in the normaliser's own (non-empty) words — one source of the message"
  );

  // Blur on a good value rewrites the field to the canonical URL, so the user sees what was stored.
  urlField.value = "  " + ID + " ";
  urlField.dispatch("change");
  assert(
    urlField.value === CANONICAL && live.settings.sheetUrl === CANONICAL,
    "7.U5 sub-step 3: on blur the field itself is rewritten to the canonical URL — what is shown is what is stored"
  );

  // (b) With the clipboard API present, the Paste control appears and drives the same path.
  let clipboardText = "  " + ID + "\n";
  let readCalls = 0;
  setNavigator({ clipboard: { readText: async () => { readCalls++; if (clipboardText === null) throw new Error("denied"); return clipboardText; } } });
  pane = makeDomStub();
  live = makeAppState();
  changes = 0;
  mountSettingsView(pane, live, { onChange: () => { changes++; } });

  const pasteBtn = walk(pane).filter((n) => n.tagName === "BUTTON" && n._t === "Paste")[0];
  assert(
    pasteBtn !== undefined && pasteBtn.type === "button" && pasteBtn.className.includes("btn"),
    "7.U5 sub-step 4: where navigator.clipboard.readText EXISTS, a real .btn Paste control is rendered"
  );
  pasteBtn.dispatch("click");
  await tick();
  const pasteField = walk(pane).filter((n) => n.tagName === "INPUT" && n.getAttribute("inputmode") === "url")[0];
  assert(
    readCalls === 1 && live.settings.sheetUrl === CANONICAL && pasteField.value === CANONICAL,
    "7.U5 sub-step 4: Paste reads the clipboard once, normalises a whitespace-padded bare id, and fills BOTH the field and the stored value"
  );
  assert(changes >= 1, "7.U5 sub-step 4: a paste persists through the same onChange seam typing uses");

  // A refused clipboard must not throw into the page or clear what is there.
  clipboardText = null;
  const before = live.settings.sheetUrl;
  pasteBtn.dispatch("click");
  await tick();
  const pasteHint = byClass(pane, "settings-status")[0];
  assert(
    live.settings.sheetUrl === before && pasteHint.className.includes("error") &&
      pasteHint._t.indexOf("paste into the field") !== -1,
    "7.U5 DONE-WHEN: a refused/unavailable clipboard degrades gracefully — it says to type instead and changes nothing"
  );

  // Scope: 7.U5 touched neither the sync contract nor persistence.
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./js/views/settings.js", "utf8");
    assert(
      /execUrl:\s*_state\.settings\.sheetUrl/.test(src) && !/localStorage|fetch\s*\(/.test(src),
      "7.U5 (golden rule 4 + scope): connect() still hands SheetsProvider the stored sheetUrl unchanged, and the view still touches neither localStorage nor fetch()"
    );
    assert(
      !/script\.google\.com/.test(src) && /normalizeExecUrl/.test(src),
      "7.U5 sub-step 2: the exec-URL shape lives ONLY in logic.js's normaliser — the view hardcodes no host"
    );
  }

  if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
  else delete globalThis.navigator;
  delete globalThis.document;
}

// --- 7.U4 Checked task lingers, then hides + "Show completed" (D47) ---
// Half of this Done-when is about TIME, so this block drives the real Tasks view against its own
// DOM stub with the grace delays overridden to milliseconds (mountTasksView's documented seam) and
// awaits them for real — no fake clock, no source-regex standing in for behaviour. Render counts
// are taken from the stub itself: rerender() clears the pane by assigning `textContent`, so the
// pane's own set-count is an exact count of renders, which is what "hides once, not once per
// descendant" and "no orphaned timer" actually assert.
{
  const { readFileSync } = await import("node:fs");

  const hasCls = (n, c) => (" " + n.className + " ").includes(" " + c + " ");
  const walkAll = (n) => [n, ...n.children.flatMap(walkAll)];
  const byClass = (root, c) => walkAll(root).filter((n) => hasCls(n, c));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function makeStub() {
    function el(tag) {
      const n = {
        tagName: String(tag).toUpperCase(),
        id: "", className: "", type: "", value: "", checked: false, indeterminate: false,
        hidden: false, style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {},
        parent: null, _clears: 0,
        get firstChild() { return this.children[0] || null; },
        get childNodes() { return this.children; },
        get textContent() { return this._t; },
        set textContent(v) {
          this._clears += 1;
          for (const c of this.children) c.parent = null;
          this.children = [];
          this._t = String(v);
        },
        setAttribute(k, v) { this._a[k] = String(v); },
        getAttribute(k) { return k in this._a ? this._a[k] : null; },
        appendChild(c) { c.parent = this; this.children.push(c); return c; },
        append(...cs) { for (const c of cs) this.appendChild(c); },
        insertBefore(c, ref) {
          const i = ref ? this.children.indexOf(ref) : -1;
          c.parent = this;
          if (i < 0) this.children.push(c);
          else this.children.splice(i, 0, c);
          return c;
        },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; },
        remove() { if (this.parent) this.parent.removeChild(this); },
        replaceWith(other) {
          if (!this.parent) return;
          const i = this.parent.children.indexOf(this);
          other.parent = this.parent;
          this.parent.children.splice(i, 1, other);
          this.parent = null;
        },
        contains(c) { return this.children.some((x) => x === c || x.contains(c)); },
        addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
        focus() {},
        dispatch(t) {
          for (const fn of (this._ev[t] || []).slice()) {
            fn({ type: t, key: "", preventDefault() {}, stopPropagation() {} });
          }
        },
      };
      n.classList = {
        add(...cs) { for (const c of cs) if (!hasCls(n, c)) n.className = (n.className + " " + c).trim(); },
        contains(c) { return hasCls(n, c); },
      };
      return n;
    }
    const body = el("body");
    globalThis.document = {
      createElement: el,
      // Real lookup (not a null stub): closeModal() finds #modal-host by id, so one dialog at a
      // time actually holds and the delete probe below can't be fooled by a stale popup.
      getElementById: (id) => walkAll(body).find((n) => n.id === id) || null,
      body,
      activeElement: null,
    };
    return el("main");
  }

  const { mountTasksView, cancelPendingHides, openDetail } = await import("./js/views/tasks.js");

  // A FIXED reference date for the pure predicates, so nothing in this block depends on the day
  // the suite happens to run (D47's amendment made `today` a real input). The view computes its
  // own from toLocaleDateString('en-CA'); fixtures below date their events far either side of it.
  const TODAY = "2026-09-29";

  const titlesIn = (p) => byClass(p, "task-title").map((t) => t.textContent);
  const boxIn = (p, title) =>
    byClass(p, "task-checkbox").find((c) => c.getAttribute("aria-label") === `Mark "${title}" done`);

  // ---- The pure half first: the two constants and the three predicates. ----

  assert(
    HIDE_DELAY_MS > 0 && HIDE_DELAY_CONTAINER_MS > HIDE_DELAY_MS,
    `7.U4 sub-step 4: a container's grace delay is strictly LONGER than a leaf's (${HIDE_DELAY_MS}ms vs ${HIDE_DELAY_CONTAINER_MS}ms)`
  );

  {
    const st = makeAppState();
    const oldest = makeTask({ type: "finite", title: "oldest", done: true, completedAt: 1000 });
    const middle = makeTask({ type: "finite", title: "middle", done: true, completedAt: 2000 });
    const newest = makeTask({ type: "finite", title: "newest", done: true, completedAt: 3000 });
    const unstamped = makeTask({ type: "finite", title: "unstamped", done: true, completedAt: null });
    st.tasks.push(oldest, middle, newest, unstamped);
    assert(
      completedHiddenRoots(st.tasks, TODAY).map((t) => t.title).join(",") === "newest,middle,oldest,unstamped",
      "7.U4 DONE-WHEN: completedHiddenRoots orders hidden tasks NEWEST-FIRST by completedAt, an unstamped one last"
    );

    // A container that became done because its last child was checked was never itself checked,
    // so it carries no own stamp — it must still sort, by its newest descendant's.
    const st2 = makeAppState();
    const box = makeTask({ type: "finite", title: "Box" });
    const inBox = makeTask({ type: "finite", title: "in box", parentId: box.id, done: true, completedAt: 5000 });
    const solo = makeTask({ type: "finite", title: "Solo", done: true, completedAt: 4000 });
    st2.tasks.push(box, inBox, solo);
    assert(
      box.completedAt === null && completedAtOf(st2.tasks, box) === 5000,
      "7.U4: completedAtOf falls back to the newest stamp in the subtree when the container itself was never checked"
    );
    assert(
      completedHiddenRoots(st2.tasks, TODAY).map((t) => t.title).join(",") === "Box,Solo",
      "7.U4 DONE-WHEN: a hidden subtree is listed by its ROOT only — once, not once per descendant — and ordered by that fallback"
    );
    assert(
      isCompletedHidden(st2.tasks, inBox, TODAY) === true &&
        !completedHiddenRoots(st2.tasks, TODAY).some((t) => t.id === inBox.id),
      "7.U4: the descendant IS hidden, it just isn't its own entry in the list (its root already covers it)"
    );

    // Render-only, proved on the data: asking what is hidden changes nothing.
    const snapshot = JSON.stringify(st2.tasks);
    const pctBefore = progressOf(st2.tasks, box);
    completedHiddenRoots(st2.tasks, TODAY);
    isCompletedHidden(st2.tasks, box, TODAY);
    completedAtOf(st2.tasks, box);
    assert(
      JSON.stringify(st2.tasks) === snapshot && progressOf(st2.tasks, box) === pctBefore && pctBefore === 100,
      "7.U4: the three D47 predicates are pure — the tasks array is byte-identical afterwards and progressOf is unchanged"
    );

    // A lingering ancestor keeps its WHOLE subtree on screen.
    assert(
      isCompletedHidden(st2.tasks, box, TODAY, new Set([box.id])) === false &&
        isCompletedHidden(st2.tasks, inBox, TODAY, new Set([box.id])) === false,
      "7.U4 sub-step 4: an id inside its grace window keeps itself AND its descendants visible — a container's subtree never half-vanishes"
    );
  }

  // ---- Fixture A: a finite LEAF lingers, then hides; unchecking cancels. ----
  const paneA = makeStub();
  const stA = makeAppState();
  const milk = makeTask({ type: "finite", title: "Buy milk" });
  const bank = makeTask({ type: "finite", title: "Call bank" });
  const plants = makeTask({ type: "finite", title: "Water plants" });
  stA.tasks.push(milk, bank, plants);
  const LEAF_MS = 25;
  let changesA = 0;
  mountTasksView(paneA, stA, {
    onChange: () => { changesA += 1; },
    hideDelayMs: LEAF_MS,
    hideDelayContainerMs: 200,
  });

  const milkBox = boxIn(paneA, "Buy milk");
  milkBox.checked = true;
  milkBox.dispatch("change");
  const milkTitle = byClass(paneA, "task-title").find((t) => t.textContent === "Buy milk");
  assert(
    milkTitle !== undefined && hasCls(milkTitle, "done") && milk.done === true && changesA === 1,
    "7.U4 DONE-WHEN: checking a finite leaf leaves the row VISIBLE with its strike-through (and persists once)"
  );
  const lingerBar = byClass(paneA, "task-linger")[0];
  assert(
    byClass(paneA, "task-linger").length === 1 &&
      lingerBar.getAttribute("role") === "status" && lingerBar.getAttribute("aria-live") === "polite" &&
      byClass(paneA, "linger-undo-btn").length === 1 &&
      byClass(paneA, "linger-undo-btn")[0].textContent === "Undo",
    "7.U4 sub-step 4: the open grace window carries an obvious, announced cancel affordance on the row"
  );
  assert(
    byClass(paneA, "completed-toggle").length === 0,
    "7.U4: a task inside its grace window is NOT in Show completed yet — it is still in the tree"
  );

  await sleep(LEAF_MS + 40);
  assert(
    !titlesIn(paneA).includes("Buy milk") && titlesIn(paneA).includes("Call bank") &&
      byClass(paneA, "task-linger").length === 0,
    "7.U4 DONE-WHEN: after the grace delay the checked leaf is hidden from the tree (and its cancel strip goes with it)"
  );
  assert(
    milk.done === true && stA.tasks.length === 3,
    "7.U4: hiding is RENDER-ONLY — the record is still in state, still done, and nothing was deleted"
  );
  assert(
    byClass(paneA, "completed-toggle").length === 1 &&
      byClass(paneA, "completed-toggle")[0].textContent === "Show completed (1)" &&
      byClass(paneA, "completed-toggle")[0].getAttribute("aria-expanded") === "false" &&
      byClass(paneA, "completed-list")[0].hidden === true,
    "7.U4 DONE-WHEN: the hidden task is reachable through a collapsed Show completed disclosure carrying its count"
  );

  // Done-when 2: unchecking inside the window cancels the hide entirely.
  const bankBox = boxIn(paneA, "Call bank");
  bankBox.checked = true;
  bankBox.dispatch("change");
  const clearsAfterCheck = paneA._clears;
  const bankBox2 = boxIn(paneA, "Call bank");
  bankBox2.checked = false;
  bankBox2.dispatch("change");
  await sleep(LEAF_MS + 40);
  assert(
    titlesIn(paneA).includes("Call bank") && bank.done === false && bank.completedAt === null,
    "7.U4 DONE-WHEN: unchecking during the grace window cancels the hide — the row stays"
  );
  assert(
    paneA._clears === clearsAfterCheck + 1,
    "7.U4 DONE-WHEN: ...and the cancelled timer never fires a render of its own afterwards (exactly the un-check's own re-render, no more)"
  );

  // The linger bar's own Undo is the same cancel.
  const bankBox3 = boxIn(paneA, "Call bank");
  bankBox3.checked = true;
  bankBox3.dispatch("change");
  byClass(paneA, "linger-undo-btn")[0].dispatch("click");
  await sleep(LEAF_MS + 40);
  assert(
    titlesIn(paneA).includes("Call bank") && bank.done === false && byClass(paneA, "task-linger").length === 0,
    "7.U4 sub-step 4: the cancel affordance's Undo cancels the pending hide too, not just the checkbox"
  );

  // The timer must hide the row it was scheduled for, never whatever now sits in its place.
  const bankBox4 = boxIn(paneA, "Call bank");
  bankBox4.checked = true;
  bankBox4.dispatch("change");
  const bankBox5 = boxIn(paneA, "Call bank");
  bankBox5.checked = false;
  bankBox5.dispatch("change");
  const plantsBox = boxIn(paneA, "Water plants");
  plantsBox.checked = true;
  plantsBox.dispatch("change");
  await sleep(LEAF_MS + 40);
  assert(
    titlesIn(paneA).includes("Call bank") && !titlesIn(paneA).includes("Water plants"),
    "7.U4 DONE-WHEN: a cancel followed immediately by another check hides the RIGHT row — no crossed timers"
  );
  cancelPendingHides();

  // ---- Fixture B: routines, events and overdue tasks never hide. ----
  const paneB = makeStub();
  const stB = makeAppState();
  const gym = makeTask({
    type: "routine", title: "Gym",
    recurrence: { days: [1], time: "07:00", durationMin: 60, start: "2026-01-05", end: "2026-01-19" },
  });
  for (const o of expandOccurrences(gym)) gym.log[o.date] = "done";
  const recital = makeTask({ type: "event", title: "Recital", start: "2026-01-10T19:00", end: "2026-01-10T21:00" });
  const tidy = makeTask({ type: "finite", title: "Tidy", done: true, completedAt: 1000 });
  const late = makeTask({ type: "finite", title: "Late paper", deadline: "2020-01-01" });
  stB.tasks.push(gym, recital, tidy, late);

  assert(
    expandOccurrences(gym).length === 3 && progressOf(stB.tasks, gym) === 100 && effectiveDone(stB.tasks, gym) === true,
    "7.U4 control: the routine fixture really is at FULL progress (3/3 occurrences done, effectiveDone true) — so only the type guard can save it"
  );
  assert(
    isCompletedHidden(stB.tasks, gym, TODAY) === false && isCompletedHidden(stB.tasks, recital, TODAY) === false &&
      isCompletedHidden(stB.tasks, tidy, TODAY) === true,
    "7.U4 DONE-WHEN: a completed routine at full progress NEVER hides (nor does an event) — the finite task does"
  );
  assert(
    isOverdue(stB.tasks, late, TODAY) === true && isCompletedHidden(stB.tasks, late, TODAY) === false,
    "7.U4 (D31 narrowed, not reversed): an overdue task can never be hidden — isOverdue needs !effectiveDone and hiding needs effectiveDone"
  );

  mountTasksView(paneB, stB, { hideDelayMs: LEAF_MS, hideDelayContainerMs: 200 });
  assert(
    titlesIn(paneB).includes("Gym") && titlesIn(paneB).includes("Recital") &&
      titlesIn(paneB).includes("Late paper") && !titlesIn(paneB).includes("Tidy"),
    "7.U4 DONE-WHEN: the render agrees — routine, event and overdue rows stay; the already-done finite task is hidden at mount, with no grace window it never earned"
  );
  assert(
    byClass(paneB, "overdue-section").length === 1 &&
      byClass(paneB, "completed-toggle")[0].textContent === "Show completed (1)",
    "7.U4: the pinned Overdue section (D31) is untouched, and only the finite done task is in Show completed"
  );

  // ---- Fixture C: a CONTAINER hides its whole subtree once, percentages untouched. ----
  const paneC = makeStub();
  const stC = makeAppState();
  const thesis = makeTask({ type: "finite", title: "Thesis" });
  const draft = makeTask({ type: "finite", title: "Draft", parentId: thesis.id });
  const edit = makeTask({ type: "finite", title: "Edit", parentId: thesis.id });
  const print = makeTask({ type: "finite", title: "Print", parentId: thesis.id });
  const submit = makeTask({ type: "finite", title: "Submit", parentId: thesis.id });
  stC.tasks.push(thesis, draft, edit, print, submit);
  const CONT_MS = 200;
  mountTasksView(paneC, stC, { hideDelayMs: LEAF_MS, hideDelayContainerMs: CONT_MS });

  // Done-when: hidden tasks still count in every percentage.
  const draftBox = boxIn(paneC, "Draft");
  draftBox.checked = true;
  draftBox.dispatch("change");
  const pctLingering = progressOf(stC.tasks, thesis);
  const rowsLingering = byClass(paneC, "task-row").length;
  await sleep(LEAF_MS + 40);
  const pctHidden = progressOf(stC.tasks, thesis);
  const rowsHidden = byClass(paneC, "task-row").length;
  assert(
    pctLingering === 25 && pctHidden === 25 && rowsLingering === 5 && rowsHidden === 4,
    `7.U4 DONE-WHEN: progressOf(container) is IDENTICAL before and after its child is hidden (${pctLingering}% then ${pctHidden}%) while one fewer row renders — the filter is render-only`
  );
  assert(
    byClass(paneC, "progress-fill")[0].style.width === "25%" &&
      byClass(paneC, "task-breakdown")[0].textContent === "deliverables 25%",
    "7.U4: the container's own bar and D6 breakdown line still read the HIDDEN child's contribution"
  );

  // Done-when: a checked container hides its whole subtree ONCE, not once per descendant.
  const thesisBox = boxIn(paneC, "Thesis");
  const clearsBefore = paneC._clears;
  thesisBox.checked = true;
  thesisBox.dispatch("change");
  assert(
    byClass(paneC, "task-row").length === 5 && byClass(paneC, "task-linger").length === 1 &&
      byClass(paneC, "linger-text")[0].textContent === "Completed — hiding 5 items",
    "7.U4 DONE-WHEN: checking a container keeps the WHOLE subtree on screen (the already-hidden child comes back) behind ONE cancel affordance naming all 5"
  );
  assert(
    byClass(paneC, "completed-toggle").length === 0,
    "7.U4: nothing is in Show completed while the container's window is open"
  );
  await sleep(LEAF_MS + 40);
  assert(
    byClass(paneC, "task-row").length === 5,
    "7.U4 sub-step 4: the container is still on screen after the LEAF delay has elapsed — it got the longer window"
  );
  await sleep(CONT_MS);
  assert(
    byClass(paneC, "task-row").length === 0 && byClass(paneC, "task-node").length === 0,
    "7.U4 DONE-WHEN: after the container's delay the whole subtree is gone from the tree"
  );
  assert(
    paneC._clears === clearsBefore + 2,
    `7.U4 DONE-WHEN: it hid in exactly ONE render — the check's own re-render plus one hide, not one per descendant (got ${paneC._clears - clearsBefore})`
  );
  assert(
    byClass(paneC, "completed-toggle")[0].textContent === "Show completed (1)" &&
      byClass(paneC, "completed-row").length === 1 &&
      byClass(paneC, "empty-state")[0].textContent === "All done — nothing open.",
    "7.U4 DONE-WHEN: the hidden subtree appears in Show completed ONCE (the container), and the emptied tree says so"
  );
  assert(
    stC.tasks.length === 5 && stC.tasks.every((t) => t.done === true) && progressOf(stC.tasks, thesis) === 100,
    "7.U4: nothing was deleted — all 5 records survive, done, and the container still computes 100%"
  );

  // Done-when: Show completed lists them and unchecking from there restores them to the tree.
  const toggle = byClass(paneC, "completed-toggle")[0];
  toggle.dispatch("click");
  const openToggle = byClass(paneC, "completed-toggle")[0];
  assert(
    openToggle.getAttribute("aria-expanded") === "true" &&
      openToggle.textContent === "Hide completed (1)" &&
      byClass(paneC, "completed-list")[0].hidden === false,
    "7.U4 DONE-WHEN: Show completed is a real disclosure — it expands, flips aria-expanded, and relabels"
  );
  const completedRow = byClass(paneC, "completed-row")[0];
  const restore = byClass(paneC, "task-checkbox").find(
    (c) => c.getAttribute("aria-label") === 'Mark "Thesis" not done'
  );
  assert(
    completedRow.dataset.taskId === thesis.id &&
      byClass(paneC, "completed-title")[0].textContent === "Thesis" &&
      byClass(paneC, "completed-when")[0].textContent.includes("4 subtasks") &&
      restore !== undefined && restore.checked === true,
    "7.U4 DONE-WHEN: the entry names the task, says how much is under it, and offers a real CHECKED checkbox as the way back"
  );
  restore.checked = false;
  restore.dispatch("change");
  assert(
    byClass(paneC, "task-row").length === 5 && byClass(paneC, "completed-toggle").length === 0 &&
      stC.tasks.every((t) => t.done === false && t.completedAt === null),
    "7.U4 DONE-WHEN: unchecking from Show completed restores the whole subtree to the tree and empties the list"
  );
  cancelPendingHides();

  // ---- Fixture D: a mutation during a pending hide leaves no orphaned timer. ----
  const paneD = makeStub();
  const stD = makeAppState();
  const pending = makeTask({ type: "finite", title: "Pending" });
  const keeper = makeTask({ type: "finite", title: "Keeper" });
  stD.tasks.push(pending, keeper);
  mountTasksView(paneD, stD, { hideDelayMs: 300, hideDelayContainerMs: 300 });

  const pendingBox = boxIn(paneD, "Pending");
  pendingBox.checked = true;
  pendingBox.dispatch("change");
  assert(
    byClass(paneD, "task-linger").length === 1,
    "7.U4 control: the delete probe really does start from an OPEN grace window"
  );
  // Delete the pending task through the real 2.U4 detail popup while its window is open.
  openDetail(pending);
  const delBtn = byClass(document.body, "detail-delete-btn").slice(-1)[0];
  delBtn.dispatch("click");
  const confirmBtn = byClass(document.body, "modal-confirm-delete").slice(-1)[0];
  confirmBtn.dispatch("click");
  const clearsAfterDelete = paneD._clears;
  assert(
    stD.tasks.length === 1 && titlesIn(paneD).includes("Keeper") && !titlesIn(paneD).includes("Pending"),
    "7.U4 control: the delete went through while the hide was pending"
  );
  await sleep(400);
  assert(
    paneD._clears === clearsAfterDelete && titlesIn(paneD).includes("Keeper") &&
      byClass(paneD, "completed-toggle").length === 0,
    "7.U4 DONE-WHEN: a mutation during a pending hide leaves NO orphaned timer — nothing fires afterwards and the surviving row is untouched"
  );
  cancelPendingHides();

  // ---- Fixture E: the D47 AMENDMENT — a pending event holds its container on the tree. ----
  // The gap the 7.U4 reviewer gate found: `effectiveDone` excludes events from the roll-up, so a
  // container reads "done" while an exam is months away, and hiding it took the exam with it.
  // Dates are pinned far either side of TODAY so this never depends on the day the suite runs.
  {
    const mkCourse = (examStart, examEnd) => {
      const s = makeAppState();
      const course = makeTask({ type: "finite", title: "CS 402" });
      const admin = makeTask({ type: "finite", title: "Register", parentId: course.id, done: true, completedAt: 1000 });
      const exam = makeTask({ type: "event", title: "Final exam", parentId: course.id, start: examStart, end: examEnd });
      s.tasks.push(course, admin, exam);
      return { s, course, admin, exam };
    };

    // The predicate, on its own terms.
    const future = mkCourse("2026-12-01T09:00", "2026-12-01T11:00");
    assert(
      effectiveDone(future.s.tasks, future.course) === true,
      "7.U4 amendment control: the container really IS effectiveDone — events are excluded from the roll-up, so only the new clause can save it"
    );
    assert(
      eventIsPending(future.exam, TODAY) === true &&
        hasPendingEvent(future.s.tasks, future.course, TODAY) === true &&
        isCompletedHidden(future.s.tasks, future.course, TODAY) === false,
      "7.U4 DONE-WHEN (D47 amendment): a container whose finite work is done but which still has a FUTURE event under it STAYS on the tree"
    );
    const past = mkCourse("2026-01-05T09:00", "2026-01-05T11:00");
    assert(
      eventIsPending(past.exam, TODAY) === false &&
        hasPendingEvent(past.s.tasks, past.course, TODAY) === false &&
        isCompletedHidden(past.s.tasks, past.course, TODAY) === true,
      "7.U4 DONE-WHEN (D47 amendment): the same container hides once that event is PAST — nothing left to attend"
    );
    // The boundary: an event dated TODAY is still pending (you have not attended it yet).
    const onTheDay = mkCourse(`${TODAY}T09:00`, `${TODAY}T11:00`);
    assert(
      eventIsPending(onTheDay.exam, TODAY) === true && isCompletedHidden(onTheDay.s.tasks, onTheDay.course, TODAY) === false,
      "7.U4 (D47 amendment): the boundary is inclusive — an event dated TODAY is still pending, so the container stays"
    );
    // A multi-day event that STARTED in the past but has not finished is still pending.
    const straddling = mkCourse("2026-01-05T09:00", "2026-12-01T11:00");
    assert(
      eventIsPending(straddling.exam, TODAY) === true,
      "7.U4 (D47 amendment): a multi-day event that started in the past but has not ended yet is still pending (the END date decides)"
    );

    // Depth: the blocking event is a GRANDCHILD, and the block is monotone upward.
    {
      const s = makeAppState();
      const top = makeTask({ type: "finite", title: "Degree" });
      const course = makeTask({ type: "finite", title: "Course", parentId: top.id });
      const chore = makeTask({ type: "finite", title: "Chore", parentId: course.id, done: true, completedAt: 1 });
      const exam = makeTask({ type: "event", title: "Viva", parentId: course.id, start: "2026-12-20T09:00", end: "2026-12-20T10:00" });
      s.tasks.push(top, course, chore, exam);
      assert(
        isCompletedHidden(s.tasks, top, TODAY) === false && isCompletedHidden(s.tasks, course, TODAY) === false &&
          isCompletedHidden(s.tasks, chore, TODAY) === true,
        "7.U4 (D47 amendment): the block is monotone upward — a pending grandchild event holds BOTH ancestors, while the done finite leaf beside it still hides"
      );
    }

    // ROUTINES are deliberately NOT covered: a container is only effectiveDone once every
    // occurrence is done, so a hidden routine is a genuinely finished one.
    {
      const s = makeAppState();
      const course = makeTask({ type: "finite", title: "Seminar" });
      const r = makeTask({
        type: "routine", title: "Weekly reading", parentId: course.id,
        recurrence: { days: [1], time: "09:00", durationMin: 60, start: "2026-01-05", end: "2026-01-12" },
      });
      for (const o of expandOccurrences(r)) r.log[o.date] = "done";
      s.tasks.push(course, r);
      assert(
        hasPendingEvent(s.tasks, course, TODAY) === false && isCompletedHidden(s.tasks, course, TODAY) === true,
        "7.U4 (D47 amendment): a fully-done ROUTINE does not block its container — only events, which have no completion concept, can be pending under a done parent"
      );
    }

    // A RECURRING event is judged by its LAST live occurrence (D41 window), and a fully-cancelled
    // series (D36) is not pending at all.
    {
      const rule = { days: [1], time: "09:00", durationMin: 60, start: "2026-11-02", end: "2026-11-16" };
      const recurringFuture = makeTask({ type: "event", title: "Lab", recurrence: { ...rule } });
      const recurringPast = makeTask({ type: "event", title: "Old lab", recurrence: { days: [1], time: "09:00", durationMin: 60, start: "2026-01-05", end: "2026-01-19" } });
      assert(
        eventIsPending(recurringFuture, TODAY) === true && eventIsPending(recurringPast, TODAY) === false,
        "7.U4 (D47 amendment): a RECURRING event is judged by its last live occurrence (D41 puts the window in `recurrence`, its own start/end stay null)"
      );
      const cancelled = makeTask({ type: "event", title: "Cancelled series", recurrence: { ...rule } });
      for (const o of expandOccurrences(cancelled)) cancelled.exceptions[o.date] = null;
      assert(
        expandOccurrences(cancelled).length === 0 && eventIsPending(cancelled, TODAY) === false,
        "7.U4 (D47 amendment): a series whose every occurrence is cancelled (D36) is not pending — expandOccurrences already dropped them"
      );
    }

    // Conservative on bad data: the failure mode is "the container stays", never "the exam vanishes".
    {
      const undated = makeTask({ type: "event", title: "Someday" });
      assert(
        undated.start === null && eventIsPending(undated, TODAY) === true &&
          eventIsPending(makeTask({ type: "event", title: "x", start: "2026-01-01T09:00" }), undefined) === true,
        "7.U4 (D47 amendment): an UNDATED event, and any call with no `today`, both count as PENDING — the safe failure mode is a container that stays, not an exam that disappears"
      );
      assert(
        eventIsPending(makeTask({ type: "finite", title: "not an event", deadline: "2020-01-01" }), TODAY) === false,
        "7.U4 (D47 amendment): eventIsPending is event-only — a finite task is never 'pending' in this sense"
      );
    }

    // And the whole thing end to end, through the real view: check the last open subtask of a
    // course with a future exam and NO window may open at all, because nothing is going to hide.
    {
      // 7.A1 sub-step 4: PINNED. The pure predicates above take TODAY as an argument, but the VIEW
      // reads the wall clock, so with a literal 2026-12-01 exam this fixture silently inverted once
      // the real date passed it (caught by the twelve-date sweep: it failed on 2026-12-31 onwards).
      // Pinning to the same TODAY the predicates use makes "future" mean future, permanently.
      const restoreE = pinToday(TODAY);
      const paneE = makeStub();
      const { s, course, admin, exam } = mkCourse("2026-12-01T09:00", "2026-12-01T11:00");
      admin.done = false;                       // start it open so we can check it through the UI
      admin.completedAt = null;
      mountTasksView(paneE, s, { hideDelayMs: 25, hideDelayContainerMs: 25 });
      const adminBox = boxIn(paneE, "Register");
      adminBox.checked = true;
      adminBox.dispatch("change");
      // The window opens on the LEAF (which really is about to go), never on the course (which is
      // not). hideSubjectFor stops below the blocked ancestor, so no row is promised a hide it
      // will not get.
      const bars = byClass(paneE, "task-linger");
      assert(
        bars.length === 1 && bars[0].parent.children.some((c) => byClass(c, "task-title").some((t) => t.textContent === "Register")),
        "7.U4 (D47 amendment): completing the last finite child of an exam-bearing course opens the grace window on the LEAF, not on the course — a row is never promised a hide that the pending exam will block"
      );
      await sleep(80);
      assert(
        titlesIn(paneE).includes("CS 402") && titlesIn(paneE).includes("Final exam") &&
          !titlesIn(paneE).includes("Register"),
        "7.U4 DONE-WHEN (D47 amendment): after the delay the course and its pending exam are BOTH still on the tree, while the completed subtask alone has hidden"
      );
      // The verb depends on `_showCompleted`, which is module state a previous fixture may have
      // toggled — assert the COUNT and the entry, which is what this check is actually about.
      assert(
        /^(Show|Hide) completed \(1\)$/.test(byClass(paneE, "completed-toggle")[0].textContent) &&
          byClass(paneE, "completed-row").length === 1 &&
          byClass(paneE, "completed-title")[0].textContent === "Register",
        "7.U4 (D47 amendment): the hidden subtask — not the course — is the single thing Show completed lists"
      );
      cancelPendingHides();
      restoreE();
    }
  }

  // ---- Static checks on the 7.U4 CSS: no new hex, no at-rule, a11y floor intact. ----
  {
    const cssSrc = readFileSync("./css/styles.css", "utf8");
    const start = cssSrc.indexOf("/* ---- Task 7.U4");
    const u4Css = cssSrc.slice(start, cssSrc.indexOf("/* ---- Detail popup", start));
    assert(
      start !== -1 && u4Css.includes(".task-linger") && u4Css.includes(".completed-row") &&
        !/#[0-9a-fA-F]{3,8}\b/.test(u4Css),
      "7.U4: the new CSS introduces no hex — the strip, the list and both buttons use existing 03 tokens only"
    );
    // Declarations only — a comment naming @media paints nothing (the 7.U1 block strips comments
    // for the same reason before it reads the cascade).
    const u4Decl = u4Css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert(
      !/@media/.test(u4Decl) && !/animation/.test(u4Decl),
      "7.U4: no at-rule (7.U1's flat-cascade control still holds) and no animation (the blanket prefers-reduced-motion rule covers the file's transitions)"
    );
    assert(
      /\.linger-undo-btn:focus-visible/.test(u4Css) && /\.completed-toggle:focus-visible/.test(u4Css) &&
        (u4Css.match(/min-height:\s*40px/g) || []).length >= 3,
      "7.U4 accessibility floor: both new buttons carry a visible focus ring and every new control keeps the 40px tap floor"
    );
    assert(
      !/100vh/.test(u4Css) && !/560px/.test(u4Css) && /minmax\(0, 1fr\)/.test(u4Css),
      "7.U4 D21 floor: no 100vh, no 560px breakpoint, and the completed row uses minmax(0,1fr) rather than an implicit auto track"
    );
  }

  delete globalThis.document;
}

// --- 7.A1 Machine-checkable acceptance sweep ---
// Runs every `01_PROJECT_OVERVIEW.md` acceptance line a script can decide, so 7.INT's phone pass
// is spent only on what genuinely needs eyes. Each assertion below names the command or file that
// decided it — nothing here is marked "looks right". The lines this block does NOT re-decide are
// the ones an earlier task's block already decides by construction; the full classification,
// including the phone-only set handed to 7.INT, lives in 05_TASKS_STEP7.md.
{
  const { readFileSync, readdirSync, statSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");

  // The shipped tree = everything GitHub Pages will serve, plus the Apps Script source.
  const SHIPPED = ["index.html", "manifest.json", "css/styles.css", "apps-script/Code.gs"];
  const walkDir = (dir) => readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(p).isDirectory() ? walkDir(p) : [p];
  });
  const JS_MODULES = walkDir("./js").filter((f) => f.endsWith(".js")).map((f) => f.replace(/^\.\//, ""));
  const read = (f) => readFileSync(f, "utf8");
  // Blanks comments out rather than deleting them, so reported line numbers still point at the
  // real line. (The first version deleted block comments and every offender it named was wrong.)
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
     .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

  assert(
    JS_MODULES.length === 9 && JS_MODULES.includes("js/views/calendar.js") && JS_MODULES.includes("js/storage.js"),
    `7.A1: the sweep walked the real js/ tree and found all 9 shipped modules (${JS_MODULES.join(" ")})`
  );

  // --- 01 "Data/privacy": no persistence call bypasses the storage interface (golden rule 4) ---
  // decided by: grep -rn "localStorage\|fetch(" js/ | grep -v storage.js
  {
    const offenders = JS_MODULES
      .filter((f) => f !== "js/storage.js")
      .flatMap((f) => stripComments(read(f)).split("\n")
        .map((l, i) => ({ f, i: i + 1, l }))
        .filter(({ l }) => /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bfetch\s*\(/.test(l)));
    assert(
      offenders.length === 0,
      `7.A1 / 01 Data-privacy: NO persistence call bypasses the storage interface — no localStorage/sessionStorage/indexedDB/fetch( outside js/storage.js (${offenders.map((o) => o.f + ":" + o.i).join(", ") || "0 offenders"})`
    );
    // ...and the two modules that DO import storage.js take only the provider classes, never a
    // raw persistence primitive, so the interface is the only door.
    const importers = JS_MODULES.filter((f) => /from\s+"\.{1,2}\/storage\.js"/.test(read(f)));
    assert(
      importers.length === 2 && importers.includes("js/app.js") && importers.includes("js/views/settings.js") &&
        /import\s*\{\s*LocalStorageProvider\s*\}/.test(read("js/app.js")) &&
        /import\s*\{\s*SheetsProvider\s*\}/.test(read("js/views/settings.js")),
      `7.A1 / 01 Data-privacy: exactly two modules reach storage.js and both take a PROVIDER, not a primitive (${importers.join(", ")})`
    );
  }

  // --- 01 "Data/privacy": all records include owner:"me" ---
  // decided by: constructing one record on every factory path and reading .owner
  {
    const paths = [
      ["makeTask finite", makeTask({ type: "finite", title: "t" })],
      ["makeTask routine", makeTask({ type: "routine", title: "t" })],
      ["makeTask event", makeTask({ type: "event", title: "t" })],
      ["makeSlot", makeSlot({ date: "2026-01-01", start: "09:00", durationMin: 60, taskId: "x" })],
    ];
    assert(
      paths.every(([, r]) => r.owner === "me"),
      `7.A1 / 01 Data-privacy: every FACTORY path stamps owner:"me" (${paths.map(([n, r]) => n + "=" + r.owner).join(", ")})`
    );
    const seeded = sampleState();
    const migrated = migrate({
      tasks: [{ id: "L1", title: "old", due: "2026-01-02", pri: "high" }],
      slots: [{ id: "S1", date: "2026-01-02", hour: 9, taskId: "L1" }],
      settings: {},
    });
    const allRecords = [...seeded.tasks, ...seeded.slots, ...migrated.tasks, ...migrated.slots];
    assert(
      allRecords.length > 0 && allRecords.every((r) => r.owner === "me"),
      `7.A1 / 01 Data-privacy: every record produced by sampleState() AND by the legacy v1->v2 migrate() carries owner:"me" (${allRecords.length} records checked)`
    );
  }

  // --- 01 "Data/privacy": every record has a color (palette name; default per type) ---
  // decided by: reading .color off every factory/seed/migrate record and checking membership
  {
    const seeded = sampleState();
    const migrated = migrate({ tasks: [{ id: "L1", title: "old", due: "2026-01-02" }], slots: [], settings: {} });
    const tasks = [
      makeTask({ type: "finite", title: "t" }), makeTask({ type: "routine", title: "t" }),
      makeTask({ type: "event", title: "t" }), ...seeded.tasks, ...migrated.tasks,
    ];
    const bad = tasks.filter((t) => !TASK_COLOR_NAMES.includes(t.color));
    assert(
      bad.length === 0,
      `7.A1 / 01 Data-privacy: every task carries a palette-NAME colour, never a hex or a blank (${tasks.length} tasks, ${bad.length} bad)`
    );
    assert(
      makeTask({ type: "finite", title: "t" }).color === DEFAULT_COLOR.finite &&
        makeTask({ type: "routine", title: "t" }).color === DEFAULT_COLOR.routine &&
        makeTask({ type: "event", title: "t" }).color === DEFAULT_COLOR.event,
      "7.A1 / 01 Task-colour: an unset colour defaults per TYPE (03 Part B's DEFAULT_COLOR), not to one shared fallback"
    );
  }

  // --- 01 "Data/privacy": localStorage access is wrapped in try/catch with in-memory fallback ---
  // decided by: driving Store against a localStorage that THROWS on both get and set
  {
    const realLS = globalThis.localStorage;
    globalThis.localStorage = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("QuotaExceededError"); },
      removeItem() { throw new Error("nope"); },
    };
    let threw = null, roundTrip = null;
    try {
      Store.set("ledger.sweep", "value-that-must-survive");
      roundTrip = Store.get("ledger.sweep");
    } catch (e) { threw = e; }
    if (realLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = realLS;
    assert(
      threw === null && roundTrip === "value-that-must-survive",
      `7.A1 / 01 Data-privacy: a localStorage that throws on BOTH get and set neither propagates nor loses the value — the in-memory fallback answers the read (threw=${threw && threw.message}, got=${JSON.stringify(roundTrip)})`
    );
  }

  // --- 01 "Data/privacy": no secret in any committed file (golden rule 6) ---
  // decided by: scanning the shipped tree for a REAL deployment id / non-empty token literal
  {
    const REAL_EXEC = /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec/;
    const NONEMPTY_TOKEN = /\b(token|TOKEN|passphrase|secret|apiKey)\s*[:=]\s*["'][^"']+["']/;
    const files = [...SHIPPED, ...JS_MODULES];
    const hits = files.filter((f) => {
      const src = read(f);
      return REAL_EXEC.test(src) || NONEMPTY_TOKEN.test(src);
    });
    assert(
      hits.length === 0,
      `7.A1 / 01 Data-privacy + golden rule 6: no deployment id and no non-empty token/passphrase literal anywhere in the shipped tree (${files.length} files scanned: ${hits.join(", ") || "0 hits"})`
    );
    // The one near-miss, asserted rather than hand-waved: logic.js holds the exec-URL TEMPLATE
    // (host + "/macros/s/" + "/exec") with no id in it. That is a public constant, not a secret.
    assert(
      read("js/logic.js").includes("script.google.com") && !REAL_EXEC.test(read("js/logic.js")) &&
        EXEC_URL_BASE.endsWith("/macros/s/") && EXEC_URL_SUFFIX === "/exec",
      "7.A1: the `script.google.com` literal in logic.js is the id-less URL template (7.U5), not a deployment — no id can be reconstructed from it"
    );
    // The Apps Script side reads its secret from PropertiesService, never from source.
    assert(
      /PropertiesService\.getScriptProperties\(\)\.getProperty\(['"]TOKEN['"]\)/.test(read("apps-script/Code.gs")) &&
        !NONEMPTY_TOKEN.test(read("apps-script/Code.gs")),
      "7.A1 / D26: apps-script/Code.gs reads its token from PropertiesService at runtime and hardcodes none"
    );
  }

  // --- 01 Sync lines 29 + 31: decidable STATICALLY, from the Apps Script source ---
  // The live behaviour needs Google and rides 7.INT; what a script CAN decide is that the guard
  // and the row shape are in the deployed source at all. Neither had any check before this sweep.
  {
    const gs = read("apps-script/Code.gs");
    assert(
      /function handleSave_\s*\([^)]*\)\s*\{[\s\S]{0,200}?if\s*\(\s*!Array\.isArray\(\s*body\.tasks\s*\)\s*\|\|\s*!Array\.isArray\(\s*body\.slots\s*\)\s*\)[\s\S]{0,120}?return[\s\S]{0,80}?ok:\s*false/.test(gs),
      "7.A1 / 01 Sync + D26 rule 2: handleSave_ rejects a non-array tasks/slots payload BEFORE any write — the guard is the first thing in the function, so it can never silently wipe the Sheet"
    );
    const writeIdx = gs.indexOf("writeTasksTab_(body.tasks)");
    const guardIdx = gs.indexOf("!Array.isArray(body.tasks)");
    assert(
      guardIdx !== -1 && writeIdx !== -1 && guardIdx < writeIdx,
      "7.A1 / D26 rule 2 (ordering, not just presence): the array guard appears BEFORE the first write call in the source"
    );
    assert(
      /var SLOT_FIELDS\s*=\s*\[/.test(gs) &&
        /slots\.map\(function \(slot\)\s*\{\s*return SLOT_FIELDS\.map/.test(gs),
      "7.A1 / 01 Sync + D27: writeSlotsTab_ maps ONE ROW PER SLOT across SLOT_FIELDS columns — not one JSON blob per cell"
    );
    assert(
      !/JSON\.stringify\s*\(\s*slot\b/.test(gs) && !/JSON\.stringify\s*\(\s*slots\b/.test(gs),
      "7.A1 / D27 (the negative half): no slot or slot array is ever stringified into a single cell"
    );
  }

  // --- Code hygiene: no toISOString outside comments (CLAUDE.md / 03's local-date rule) ---
  // decided by: stripping comments from every module, then grepping
  {
    // Scoped to the SHIPPED modules: the rule is about how the app derives a calendar date.
    // test.mjs is excluded deliberately and not silently — its only two occurrences are an
    // assertion label that names the rule and this checker's own pattern, neither of which is a
    // date computation. (Asserted below rather than asserted away.)
    // The CALL form, not the bare word: what the rule forbids is computing a date with it. Prose
    // that names the rule ("never toISOString") and this checker's own pattern are not calls, so
    // the check needs no allowlist to exempt them — which is why it is written this way.
    // Assembled from pieces so this checker's own source does not contain the literal it hunts
    // for — otherwise the sweep reports itself, which it did.
    const CALL = new RegExp("\\." + "toISOString" + "\\s*\\(");
    const offenders = [...JS_MODULES, "test.mjs"].flatMap((f) =>
      stripComments(read(f)).split("\n").map((l, i) => ({ f, i: i + 1, l }))
        .filter(({ l }) => CALL.test(l)));
    assert(
      offenders.length === 0,
      `7.A1: nothing CALLS the UTC date formatter anywhere in the app or the suite — 03/CLAUDE.md require toLocaleDateString('en-CA') for a calendar date (${offenders.map((o) => o.f + ":" + o.i).join(", ") || "0 offenders across " + (JS_MODULES.length + 1) + " files"})`
    );
    assert(
      CALL.test("d." + "toISOString" + "()") && !CALL.test("// never " + "toISOString"),
      "7.A1 control: the toISOString check matches a real call and does NOT match prose naming the rule"
    );
    // The positive half: local dates are derived the one sanctioned way.
    assert(
      JS_MODULES.filter((f) => /toLocaleDateString\("en-CA"\)|toLocaleDateString\('en-CA'\)/.test(read(f))).length >= 4,
      "7.A1: local calendar dates are derived with toLocaleDateString('en-CA') — 03's rule, used in every module that needs a date"
    );
  }

  // --- 01 "Responsive": no 100vh, no 560px breakpoint, svh/dvh shell, 720px nav ---
  // decided by: reading css/styles.css
  {
    const css = read("css/styles.css");
    const cssDecl = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert(
      !/100vh/.test(cssDecl),
      `7.A1 / 01 Responsive + D21: no 100vh in any declaration (${(cssDecl.match(/100vh/g) || []).length} found)`
    );
    assert(
      !/560px/.test(cssDecl),
      `7.A1 / D21 (03 Part B, superseded rule): no 560px breakpoint anywhere (${(cssDecl.match(/560px/g) || []).length} found)`
    );
    assert(
      /100svh/.test(cssDecl) && /100dvh/.test(cssDecl) && /\.shell\s*\{[^}]*overflow:\s*hidden/.test(cssDecl) &&
        /\.pane\s*\{[^}]*overflow-y:\s*auto/.test(cssDecl),
      "7.A1 / 01 Responsive: the shell is 100svh/100dvh and does not scroll; the content pane does"
    );
    const breakpoints = [...new Set(
      [...cssDecl.matchAll(/@media\s*\((?:min|max)-width:\s*(\d+)px\)/g)].map((m) => m[1])
    )].sort((a, b) => a - b);
    // D21 fixes the NAV at 720px and bans 560px; it does not ban every other breakpoint. The one
    // other value is the documented 400px Week-header rule. Pinning the whole SET means a new
    // breakpoint appearing anywhere fails this and has to be justified, rather than drifting in.
    assert(
      breakpoints.join(",") === "400,720",
      `7.A1 / 01 Responsive + D21: the stylesheet's breakpoint set is exactly {400 (Week header), 720 (nav)} — no 560px, nothing undocumented (found: ${breakpoints.join(",")})`
    );
    assert(
      /@media\s*\(min-width:\s*720px\)\s*\{\s*\.nav\s*\{\s*order:\s*-1/.test(cssDecl.replace(/\s+/g, " ").replace(/ \{/g, " {")) ||
        /\.nav\s*\{\s*order:\s*1/.test(cssDecl),
      "7.A1 / 01 Responsive: the nav is the bottom bar below 720px and moves to the top at/above it (D21)"
    );
    assert(
      /prefers-reduced-motion/.test(cssDecl) && (cssDecl.match(/:focus-visible/g) || []).length >= 5,
      `7.A1 accessibility floor: prefers-reduced-motion honoured and ${(cssDecl.match(/:focus-visible/g) || []).length} visible focus rings declared`
    );
  }

  // --- node --check on every module (sub-step 2's last item) ---
  // decided by: actually running `node --check <file>` on each
  {
    const failures = [];
    for (const f of [...JS_MODULES, "test.mjs"]) {
      try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
      catch (e) { failures.push(f); }
    }
    assert(
      failures.length === 0,
      `7.A1: \`node --check\` passes on all ${JS_MODULES.length + 1} JS files (${failures.join(", ") || "0 failures"})`
    );
  }

  // --- Every 03 Part A function still byte-matches its spec block (golden rule 3) ---
  // decided by: extracting each function from 03's fenced js blocks and from the shipped module,
  // stripping ONLY comments and whitespace, and comparing. A behavioural edit cannot survive this.
  // The spec lives in the SIBLING docs repo, found relatively (override: LEDGER_DOCS_03) so no
  // machine-specific path is committed. On a clone without it the byte-match check cannot run, and
  // it says so with a visible SKIP line — never a silent pass, never a crash that hides every later block.
  const DOCS_03 = process.env.LEDGER_DOCS_03 || "../ledger-project/docs/03_DOMAIN_CONSTANTS.md";
  if (!existsSync(DOCS_03)) {
    console.log(`SKIP: 7.A1 / golden rule 3: the 03-Part-A byte-match check needs ${DOCS_03}, which is not present on this clone (set LEDGER_DOCS_03 to its path)`);
  } else {
    const md = read(DOCS_03);
    const partA = md.slice(0, md.indexOf("# PART B — DESIGN TOKENS"));
    const fences = (src) => {
      const out = []; let cur = null, lang = null;
      for (const ln of src.split("\n")) {
        if (ln.startsWith("```")) {
          if (cur === null) { cur = []; lang = ln.slice(3).trim(); }
          else { if (lang === "js") out.push(cur.join("\n")); cur = null; lang = null; }
        } else if (cur !== null) cur.push(ln);
      }
      return out;
    };
    const grab = (src, name) => {
      const m = new RegExp(`^(?:export\\s+)?function\\s+${name}\\s*\\(`, "m").exec(src);
      if (!m) return null;
      let i = src.indexOf("{", m.index), d = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === "{") d++;
        else if (src[j] === "}" && --d === 0) break;
      }
      return src.slice(m.index, j + 1);
    };
    // Comments and whitespace only. Quote style is normalised because logic.js uses single quotes
    // (matching 03) while the views use double — a style difference, never a behavioural one.
    const norm = (s) => stripComments(s).replace(/^\s*export\s+/, "").replace(/"/g, "'").replace(/\s+/g, " ").trim();

    const specSrc = fences(partA).join("\n");
    const specNames = [...specSrc.matchAll(/^(?:export\s+)?function\s+(\w+)\s*\(/gm)].map((m) => m[1]);
    assert(
      specNames.length === 12 && specNames.includes("progressOf") && specNames.includes("readLegacyV1"),
      `7.A1 control: 03 Part A really does define 12 functions to check against (${specNames.join(", ")})`
    );

    const shippedSrc = Object.fromEntries(JS_MODULES.map((f) => [f, read(f)]));
    const results = specNames.map((n) => {
      const spec = grab(specSrc, n);
      const where = JS_MODULES.find((f) => grab(shippedSrc[f], n));
      if (!where) return { n, status: "not-a-shipped-function" };
      return { n, where, status: norm(spec) === norm(grab(shippedSrc[where], n)) ? "match" : "DRIFTED" };
    });
    const drifted = results.filter((r) => r.status === "DRIFTED");
    const matched = results.filter((r) => r.status === "match");
    assert(
      drifted.length === 0 && matched.length === 12,
      `7.A1 / golden rule 3: all 12 shipped 03-Part-A functions still match their spec block byte-for-byte modulo comments (${matched.map((r) => r.n).join(", ")}) — drift: ${drifted.map((r) => r.n + " in " + r.where).join(", ") || "none"}`
    );
    // todayISO is spec'd in 03 but shipped as a private per-module helper; all four copies must
    // still agree with the spec, or "local date" quietly means four different things.
    const todayCopies = JS_MODULES.filter((f) => grab(shippedSrc[f], "todayISO"));
    assert(
      todayCopies.length === 4 &&
        todayCopies.every((f) => norm(grab(shippedSrc[f], "todayISO")) === norm(grab(specSrc, "todayISO"))),
      `7.A1 / golden rule 3: all ${todayCopies.length} private todayISO() copies match 03's definition exactly (${todayCopies.join(", ")})`
    );
    // And the mutation control: the comparator must be able to SEE a change.
    assert(
      norm(grab(specSrc, "childrenOf")) !== norm(grab(specSrc, "childrenOf").replace("=== id", "!== id")),
      "7.A1 control: the byte-match comparator is not vacuous — flipping one operator in a spec function makes it differ"
    );
  }
}

// ======================================================================================
// 7.A5 — Day/Week time-grid + Deadlines view, DOM coverage (acceptance lines 19-25, 41).
// Until now `timegrid` and `mountDeadlinesView` appeared nowhere in this file: the Step-5 view
// tasks were verified by scratchpad harnesses that did not survive their session. Everything
// below drives the REAL views through a DOM stub and asserts on what they render.
// The clock is pinned to Tue 2026-09-15 10:30 (week Sun 09-13 .. Sat 09-19); the now-line, "today"
// column, and day-count labels all derive from it, so each is asserted against a literal.
// ======================================================================================
{
  const restoreClock = pinToday("2026-09-15");
  const prevDocument = globalThis.document;
  try {
    const { mountDeadlinesView } = await import("./js/views/deadlines.js");
    const { TASK_COLORS: TC } = await import("./js/state.js");

    // Stub rich enough for the grid AND the modals it opens (document.body, getElementById, a
    // parent link so replaceWith/remove work).
    function makeGridDom() {
      const adopt = (p, c) => { c._parent = p; return c; };
      function el(tag) {
        const n = {
          tagName: String(tag).toUpperCase(), className: "", type: "", value: "", id: "", hidden: false,
          disabled: false, style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {}, _parent: null,
          get textContent() { return this._t; },
          set textContent(v) { this.children = []; this._t = String(v); },
          setAttribute(k, v) { this._a[k] = String(v); },
          getAttribute(k) { return k in this._a ? this._a[k] : null; },
          // A real <select> takes the value of its `selected` option; the stub has to do the same
          // or the Edit form would open with no task chosen.
          appendChild(c) { this.children.push(adopt(this, c)); if (this.tagName === "SELECT" && c.selected) this.value = c.value; return c; },
          append(...cs) { for (const c of cs) this.children.push(adopt(this, c)); },
          removeChild(c) { this.children = this.children.filter((x) => x !== c); },
          remove() { if (this._parent) this._parent.removeChild(this); },
          replaceWith(o) { const p = this._parent; if (p) p.children = p.children.map((x) => (x === this ? adopt(p, o) : x)); },
          addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
          focus() {},
          getBoundingClientRect() { return this._rect || { top: 0, left: 0, width: 300, height: 600 }; },
          dispatch(t) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
          // 7.U7: dispatch WITH a payload (pointer events carry pointerId/clientX/clientY), and the
          // parentNode link `beginDrag` reads to find the column's rows element.
          fire(t, ev) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {}, ...ev }); },
          get parentNode() { return this._parent; },
        };
        n.classList = {
          add(...cs) { n.className += " " + cs.join(" "); },
          remove(...cs) { n.className = n.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" "); },
        };
        return n;
      }
      const body = el("body");
      globalThis.document = {
        createElement: el, body, activeElement: null,
        getElementById: (id) => walk(body).find((n) => n.id === id) || null,
      };
      return el("main");
    }
    const walk = (n) => [n, ...n.children.flatMap(walk)];
    const hasCls = (n, c) => (" " + n.className + " ").includes(" " + c + " ");
    const byClass = (root, c) => walk(root).filter((n) => hasCls(n, c));
    const btn = (root, text) => walk(root).find((n) => n.tagName === "BUTTON" && n._t === text);
    const modalNodes = () => walk(globalThis.document.body);

    const D = "2026-09-15";
    const state = makeAppState();
    const report = makeTask({ type: "finite", title: "Write report", color: "blue" });
    const reading = makeTask({ type: "finite", title: "Read", color: "rose" });
    const gym = makeTask({
      type: "routine", title: "Gym", color: "green",
      recurrence: { days: [2], time: "14:00", durationMin: 60, start: "2026-09-01", end: "2026-12-01" },
    });
    const meeting = makeTask({ type: "event", title: "Team sync", color: "amber", start: `${D}T16:00`, end: `${D}T17:30` });
    const weeklyEv = makeTask({
      type: "event", title: "Standup", color: "teal",
      recurrence: { days: [2], time: "11:00", durationMin: 30, start: "2026-09-01", end: "2026-12-01" },
    });
    const holiday = makeTask({ type: "event", title: "Holiday", color: "rose", allDay: true, start: D, end: D });
    const trip = makeTask({ type: "event", title: "Conference", color: "blue", start: "2026-09-14T09:00", end: "2026-09-16T17:00" });
    const course = makeTask({ type: "finite", title: "Course", color: "blue" });
    const lesson = makeTask({ type: "finite", title: "Lesson", color: "blue", parentId: course.id });
    state.tasks.push(report, reading, gym, meeting, weeklyEv, holiday, trip, course, lesson);
    const slotA = makeSlot({ date: D, start: "09:00", durationMin: 90, taskId: report.id });
    const slotB = makeSlot({ date: D, start: "09:30", durationMin: 60, taskId: reading.id }); // overlaps A
    state.slots.push(slotA, slotB);
    const changes = [];

    const pane = makeGridDom();
    mountCalendarView(pane, state, { onChange: (s) => changes.push(s.slots.length) });
    const cols = () => byClass(pane, "timegrid-daycol");
    const rowsOf = (col) => byClass(col, "timegrid-rows")[0];
    const blocksOf = (col) => byClass(rowsOf(col), "timegrid-block");
    const blockTitled = (col, title) => blocksOf(col).find((b) => byClass(b, "timegrid-block-title")[0]._t === title);
    const approx = (a, b) => typeof a === "string" && Math.abs(parseFloat(a) - b) < 1e-6;
    const label = () => byClass(pane, "cal-nav-label-row")[0]._t;

    // ---- Line 19: Day + Week on a 30-min grid, 06:00-22:00 --------------------------------
    assert(byClass(pane, "timegrid").length === 0 && byClass(pane, "cal-month-grid").length === 1,
      "7.A5 precondition: a fresh mount starts in Month mode (so the Day/Week clicks below really switch)");
    btn(pane, "Day").dispatch("click");
    assert(byClass(pane, "timegrid-day").length === 1 && cols().length === 1 && hasCls(cols()[0], "timegrid-daycol-today"),
      "7.A5 line 19: Day mode renders ONE date column, and it is today's");
    const dayRows = byClass(rowsOf(cols()[0]), "timegrid-row");
    assert(dayRows.length === 32, `7.A5 line 19: the day column has 32 half-hour rows = 06:00-22:00 (got ${dayRows.length})`);
    const labelRows = byClass(byClass(pane, "timegrid-labelscol")[0], "timegrid-label-row");
    assert(
      labelRows.length === 32 && labelRows[0]._t === "06:00" && labelRows[1]._t === "" && labelRows[2]._t === "07:00" &&
        labelRows[30]._t === "21:00" && labelRows[31]._t === "" && !labelRows.some((r) => r._t === "22:00"),
      "7.A5 line 19: hour rows are labelled 06:00..21:00, half-hour rows blank, and the grid stops before 22:00"
    );
    assert(dayRows.filter((r) => hasCls(r, "timegrid-row-half")).length === 16,
      "7.A5 line 19: exactly the 16 half-hour rows carry the lighter 'half' class");
    assert(/Sep.*15.*2026/.test(label()), `7.A5 line 19: Day label names the focused date (got "${label()}")`);

    btn(pane, "Week").dispatch("click");
    assert(byClass(pane, "timegrid-week").length === 1 && cols().length === 7,
      "7.A5 line 19: Week mode renders SEVEN date columns");
    const headers = byClass(pane, "timegrid-daycol-header").map((h) => h._t);
    assert(headers.join("|") === "Sun 13|Mon 14|Tue 15|Wed 16|Thu 17|Fri 18|Sat 19",
      `7.A5 line 19: Week runs Sunday..Saturday around today (got ${headers.join("|")})`);
    assert(cols().filter((c) => hasCls(c, "timegrid-daycol-today")).length === 1 && hasCls(cols()[2], "timegrid-daycol-today"),
      "7.A5 line 19: only Tuesday the 15th is marked as today");
    assert(cols().every((c) => byClass(rowsOf(c), "timegrid-row").length === 32),
      "7.A5 line 19: every Week column has the same 32 rows");

    // ---- Line 20: slots AND events as sized blocks ------------------------------------------
    btn(pane, "Day").dispatch("click");
    const day = cols()[0];
    const bA = blockTitled(day, "Write report");
    assert(bA && approx(bA.style.top, 18.75) && approx(bA.style.height, 9.375),
      `7.A5 line 20: a 09:00 / 90-min slot sits at top 18.75% and is 9.375% tall (got ${bA && bA.style.top} / ${bA && bA.style.height})`);
    const bEv = blockTitled(day, "Team sync");
    assert(bEv && approx(bEv.style.top, 62.5) && approx(bEv.style.height, 9.375),
      `7.A5 line 20: a 16:00-17:30 event is sized from its start/end — top 62.5%, height 9.375% (got ${bEv && bEv.style.top} / ${bEv && bEv.style.height})`);
    const bRec = blockTitled(day, "Standup");
    assert(bRec && approx(bRec.style.top, 31.25) && approx(bRec.style.height, 3.125),
      "7.A5 line 20: a RECURRING event is sized from its recurrence time/durationMin (11:00, 30 min)");
    // Height must scale with durationMin, not be a constant.
    state.slots.push(makeSlot({ date: D, start: "19:00", durationMin: 30, taskId: report.id }));
    mountCalendarView(pane, state, { onChange: () => {} });
    btn(pane, "Day").dispatch("click");
    const short = blocksOf(cols()[0]).find((b) => approx(b.style.top, 81.25));
    assert(short && approx(short.style.height, 3.125), "7.A5 line 20: a 30-min slot is 3.125% tall — height follows durationMin");
    state.slots.pop();

    // ---- Line 21: all-day / multi-day events live in the top banner ----------------------
    mountCalendarView(pane, state, { onChange: (s) => changes.push(s.slots.length) });
    btn(pane, "Day").dispatch("click");
    const chips = byClass(byClass(cols()[0], "timegrid-banner")[0], "timegrid-banner-chip");
    assert(chips.map((c) => c._t).sort().join("|") === "Conference|Holiday",
      `7.A5 line 21: an all-day event AND a multi-day event appear as banner chips on the day (got ${chips.map((c) => c._t).join("|")})`);
    assert(!blockTitled(cols()[0], "Holiday") && !blockTitled(cols()[0], "Conference"),
      "7.A5 line 21: banner items are NOT also drawn as timed blocks");
    assert(chips.find((c) => c._t === "Holiday").style.background === TC.rose.solid,
      "7.A5 line 21: a banner chip carries its task colour");
    btn(pane, "Week").dispatch("click");
    const bannerChips = (col) => byClass(col, "timegrid-banner-chip").map((c) => c._t);
    assert(
      bannerChips(cols()[1]).join() === "Conference" && bannerChips(cols()[2]).sort().join("|") === "Conference|Holiday" &&
        bannerChips(cols()[3]).join() === "Conference" && bannerChips(cols()[0]).length === 0 && bannerChips(cols()[4]).length === 0,
      "7.A5 line 21: a multi-day event spans the banner of Mon-Wed ONLY (09-14..09-16); the all-day event only Tuesday"
    );

    // ---- Line 22: now-line + side-by-side lanes ---------------------------------------------
    const nowLines = byClass(pane, "timegrid-nowline");
    assert(nowLines.length === 1 && approx(nowLines[0].style.top, 28.125) && byClass(cols()[2], "timegrid-nowline").length === 1,
      `7.A5 line 22: exactly one now-line, in TODAY's column, at 10:30 = 28.125% (got ${nowLines.length} / ${nowLines[0] && nowLines[0].style.top})`);
    btn(pane, "Day").dispatch("click");
    btn(pane, "Next ›").dispatch("click");
    assert(byClass(pane, "timegrid-nowline").length === 0, "7.A5 line 22: a day that is not today has no now-line");
    btn(pane, "Today").dispatch("click");
    assert(byClass(pane, "timegrid-nowline").length === 1, "7.A5 line 22: Today brings the now-line back");
    const laneA = blockTitled(cols()[0], "Write report");
    const laneB = blockTitled(cols()[0], "Read");
    assert(
      laneA && laneB && approx(laneA.style.width, 50) && approx(laneB.style.width, 50) &&
        approx(laneA.style.left, 0) && approx(laneB.style.left, 50),
      "7.A5 line 22: two overlapping blocks render side by side, 50% wide, in lanes 0 and 1"
    );
    const loneBlock = blockTitled(cols()[0], "Gym");
    assert(loneBlock && approx(loneBlock.style.width, 100) && approx(loneBlock.style.left, 0),
      "7.A5 line 22: a non-overlapping block takes the full width");

    // ---- Line 23: routine occurrences auto-populate; add in empty time ---------------------
    assert(loneBlock && approx(loneBlock.style.top, 50) && /\bstatus-/.test(loneBlock.className),
      "7.A5 line 23: a routine's occurrence is on the grid at its own time (14:00 = 50%) with an occurrence-status class");
    btn(pane, "Week").dispatch("click");
    const gymDays = cols().map((c) => !!blockTitled(c, "Gym"));
    assert(gymDays.join() === "false,false,true,false,false,false,false",
      `7.A5 line 23: the Tuesday routine appears on Tuesday only (got ${gymDays.join()})`);
    btn(pane, "Day").dispatch("click");

    const emptyRow = byClass(rowsOf(cols()[0]), "timegrid-row")[4]; // 06:00 + 4*30min = 08:00
    emptyRow.dispatch("click");
    const dlg = () => modalNodes().find((n) => hasCls(n, "modal-card"));
    assert(dlg() && byClass(dlg(), "modal-title")[0]._t === "Add slot",
      "7.A5 line 23/25: tapping an empty grid row opens the Add-slot form");
    const timeInput = () => walk(dlg()).find((n) => n.type === "time");
    assert(timeInput().value === "08:00", `7.A5 line 23: the form is pre-filled with the tapped row's start (got ${timeInput().value})`);
    const taskSel = walk(dlg()).find((n) => n.tagName === "SELECT");
    const optionTitles = taskSel.children.map((o) => o._t);
    assert(
      ["Write report", "Lesson", "Gym", "Team sync"].every((n) => optionTitles.some((t) => t.startsWith(n))) &&
        !optionTitles.some((t) => t.startsWith("Course")),
      "7.A5 line 23: the picker offers finite leaves, routines and events — but not a finite CONTAINER (5.G3)");
    const form = walk(dlg()).find((n) => n.tagName === "FORM");
    taskSel.value = "";
    form.dispatch("submit");
    assert(state.slots.length === 2 && byClass(dlg(), "form-error")[0]._t === "Pick a task.",
      "7.A5 line 23: submitting without a task is refused inline and creates nothing");
    taskSel.value = report.id;
    form.dispatch("submit");
    const created = state.slots.find((s) => s.start === "08:00");
    assert(
      state.slots.length === 3 && created && created.date === D && created.durationMin === 60 &&
        created.owner === "me" && created.taskId === report.id,
      "7.A5 line 23: saving creates a Slot on that date at 08:00 for 60 min with owner:'me' and the chosen task"
    );
    assert(changes[changes.length - 1] === 3 && !dlg(), "7.A5 line 23: onChange fired with the new state and the modal closed");
    const newBlock = blocksOf(cols()[0]).find((b) => approx(b.style.top, 12.5));
    assert(newBlock && approx(newBlock.style.height, 6.25), "7.A5 line 23: the new slot is immediately on the grid (08:00 = 12.5%, 60 min = 6.25%)");

    // ---- Line 24: Day/Week navigation -------------------------------------------------------
    const labelToday = label();
    btn(pane, "Next ›").dispatch("click");
    const labelNext = label();
    assert(/16/.test(labelNext) && labelNext !== labelToday, `7.A5 line 24: Day Next advances ONE day (got "${labelNext}")`);
    btn(pane, "‹ Prev").dispatch("click");
    btn(pane, "‹ Prev").dispatch("click");
    assert(/14/.test(label()), `7.A5 line 24: Day Prev steps back a day at a time (got "${label()}")`);
    btn(pane, "Today").dispatch("click");
    assert(label() === labelToday, "7.A5 line 24: Today returns to the original day");
    const jump = byClass(pane, "cal-jump-input")[0];
    jump.value = "2026-10-02";
    jump.dispatch("change");
    assert(/Oct.*2.*2026/.test(label()), `7.A5 line 24: jump-to-date lands on the picked day (got "${label()}")`);
    btn(pane, "Today").dispatch("click");
    btn(pane, "Week").dispatch("click");
    const weekLabel = label();
    btn(pane, "Next ›").dispatch("click");
    assert(byClass(pane, "timegrid-daycol-header").map((h) => h._t)[0] === "Sun 20",
      "7.A5 line 24: Week Next advances SEVEN days (Sun 13 -> Sun 20)");
    btn(pane, "‹ Prev").dispatch("click");
    assert(label() === weekLabel, "7.A5 line 24: Week Prev undoes Next");
    const weekJump = byClass(pane, "cal-jump-input")[0];
    weekJump.value = "2026-10-02"; // a Friday: its week starts Sun 09-27
    weekJump.dispatch("change");
    assert(byClass(pane, "timegrid-daycol-header").map((h) => h._t).join("|") === "Sun 27|Mon 28|Tue 29|Wed 30|Thu 1|Fri 2|Sat 3",
      "7.A5 line 24: Week jump-to-date shows the week containing the picked day");

    // ---- Line 25: the tap-to-edit equivalent of drag (D34) ---------------------------------
    btn(pane, "Today").dispatch("click");
    btn(pane, "Day").dispatch("click");
    blockTitled(cols()[0], "Read").dispatch("click");
    assert(dlg() && byClass(dlg(), "modal-title")[0]._t === "Read" && !!btn(dlg(), "Edit") && !!btn(dlg(), "Delete"),
      "7.A5 line 25: tapping a slot block opens its detail with Edit and Delete");
    btn(dlg(), "Edit").dispatch("click");
    assert(byClass(dlg(), "modal-title")[0]._t === "Edit slot", "7.A5 line 25: Edit opens the pre-filled form");
    const editForm = walk(dlg()).find((n) => n.tagName === "FORM");
    const dur = walk(dlg()).find((n) => n.type === "number");
    const startIn = walk(dlg()).find((n) => n.type === "time");
    assert(dur.value === "60" && startIn.value === "09:30", "7.A5 line 25: the edit form shows the slot's current start and duration");
    dur.value = "45";
    editForm.dispatch("submit");
    assert(byClass(dlg(), "form-error")[0]._t.length > 0 && slotB.durationMin === 60,
      "7.A5 line 25: a duration that is not a 30-min multiple is refused inline and the slot is unchanged");
    dur.value = "120";
    startIn.value = "10:00";
    editForm.dispatch("submit");
    assert(slotB.start === "10:00" && slotB.durationMin === 120 && !dlg(),
      "7.A5 line 25: a valid edit (move + resize without dragging) updates the slot and closes the modal");
    const moved = blockTitled(cols()[0], "Read");
    assert(moved && approx(moved.style.top, 25) && approx(moved.style.height, 12.5),
      "7.A5 line 25: the grid redraws the edited slot at its new position and size");
    moved.dispatch("click");
    btn(dlg(), "Delete").dispatch("click");
    assert(!!btn(dlg(), "Cancel") && state.slots.includes(slotB), "7.A5 line 25: Delete asks for confirmation first and removes nothing yet");
    btn(dlg(), "Delete").dispatch("click");
    assert(!state.slots.includes(slotB) && state.tasks.includes(reading) && !blockTitled(cols()[0], "Read"),
      "7.A5 line 25: confirming Delete removes the slot but NOT the task it referenced");

    // ---- 7.A6 — line 25's DATE field: move a slot to another day without dragging (D34) -------
    // The editor is the non-drag floor, so it must carry date as well as start/duration. A
    // dedicated task keeps these slots out of the D34/D41 assertions below (which look at today).
    const mover = makeTask({ type: "finite", title: "Move me", color: "teal" });
    state.tasks.push(mover);
    const dateInput = () => walk(dlg()).find((n) => n.type === "date");
    const formOf = () => walk(dlg()).find((n) => n.tagName === "FORM");
    const weekHeaders = () => byClass(pane, "timegrid-daycol-header").map((h) => h._t).join("|");
    // A mutant that breaks the move leaves later lookups null; catch that as ONE failure here
    // rather than letting it abort the rest of the suite.
    try {
      btn(pane, "Week").dispatch("click");
      const WEEK_OF_15 = "Sun 13|Mon 14|Tue 15|Wed 16|Thu 17|Fri 18|Sat 19";
      byClass(rowsOf(cols()[4]), "timegrid-row")[12].dispatch("click"); // Thursday 09-17, 12:00
      assert(dlg() && byClass(dlg(), "modal-title")[0]._t === "Add slot" && dateInput() && dateInput().value === "2026-09-17",
        `7.A6 line 25: tapping an empty row in a Week column that is NOT today pre-fills Date with that column's date (got ${dateInput() && dateInput().value})`);
      const fieldLabels = byClass(dlg(), "form-label").map((s) => s._t);
      assert(dateInput().required === true && hasCls(dateInput(), "form-control") &&
        dateInput()._parent === byClass(dlg(), "form-field")[fieldLabels.indexOf("Date")] &&
        fieldLabels.indexOf("Date") >= 0 && fieldLabels.indexOf("Date") < fieldLabels.indexOf("Start time"),
        `7.A6 line 25: the Date field is a required, labelled .form-control placed before Start time (got ${fieldLabels.join("|")})`);
      walk(dlg()).find((n) => n.tagName === "SELECT").value = mover.id;
      dateInput().value = "";
      const slotCount = state.slots.length;
      formOf().dispatch("submit");
      assert(state.slots.length === slotCount && byClass(dlg(), "form-error")[0]._t === "Pick a date.",
        "7.A6 line 25: Add with an empty Date is refused inline with 'Pick a date.' and creates nothing");
      dateInput().value = D; // save on Tuesday although Thursday was tapped: the FIELD wins
      formOf().dispatch("submit");
      const moverSlot = state.slots.find((s) => s.taskId === mover.id);
      assert(moverSlot && moverSlot.date === D && moverSlot.start === "12:00" && moverSlot.owner === "me" && !dlg() &&
        !!blockTitled(cols()[2], "Move me") && !blockTitled(cols()[4], "Move me"),
        "7.A6 line 25: Add saves the Date FIELD's value (not the tapped column's), with owner:'me', on Tuesday's column");
      const tueBlock = blockTitled(cols()[2], "Move me");
      const [tueTop, tueHeight] = [parseFloat(tueBlock.style.top), parseFloat(tueBlock.style.height)];

      tueBlock.dispatch("click");
      btn(dlg(), "Edit").dispatch("click");
      assert(byClass(dlg(), "modal-title")[0]._t === "Edit slot" && dateInput() && dateInput().value === D,
        `7.A6 line 25: Edit pre-fills Date with the slot's own date (got ${dateInput() && dateInput().value})`);
      dateInput().value = "";
      formOf().dispatch("submit");
      assert(byClass(dlg(), "form-error")[0]._t === "Pick a date." && moverSlot.date === D && moverSlot.start === "12:00",
        "7.A6 line 25: Edit with an empty Date is refused inline with 'Pick a date.' and the slot is unchanged");
      dateInput().value = "2026-09-17";
      walk(dlg()).find((n) => n.type === "time").value = "21:30"; // 21:30 + 60 min runs past 22:00
      formOf().dispatch("submit");
      assert(byClass(dlg(), "form-error")[0]._t.length > 0 && byClass(dlg(), "form-error")[0]._t !== "Pick a date." &&
        moverSlot.date === D && moverSlot.start === "12:00" && moverSlot.durationMin === 60,
        "7.A6 line 25: a new Date together with an invalid start (21:30 for 60 min) is refused and the date is NOT changed");
      walk(dlg()).find((n) => n.type === "time").value = "12:00";
      const changesBefore = changes.length;
      formOf().dispatch("submit");
      assert(moverSlot.date === "2026-09-17" && moverSlot.start === "12:00" && moverSlot.durationMin === 60 &&
        moverSlot.owner === "me" && state.slots.includes(moverSlot) && !dlg() && changes.length === changesBefore + 1,
        "7.A6 line 25: Edit moves the slot Tue 09-15 -> Thu 09-17 (same record, owner:'me' kept, onChange fired, modal closed)");
      const thuBlock = blockTitled(cols()[4], "Move me");
      assert(!blockTitled(cols()[2], "Move me") && thuBlock &&
        approx(thuBlock.style.top, tueTop) && approx(thuBlock.style.height, tueHeight),
        "7.A6 line 25: the moved block leaves Tuesday's column and is drawn in Thursday's at the same top/height");
      assert(weekHeaders() === WEEK_OF_15 && byClass(pane, "timegrid-week").length === 1,
        "7.A6 sub-step 4: after the move the Week view stays on the week it was showing");
      // Day mode: moving the shown day's slot elsewhere must not follow it.
      btn(pane, "Day").dispatch("click");
      btn(pane, "Next ›").dispatch("click");
      btn(pane, "Next ›").dispatch("click");
      const thuLabel = label();
      blockTitled(cols()[0], "Move me").dispatch("click");
      btn(dlg(), "Edit").dispatch("click");
      dateInput().value = "2026-09-18";
      formOf().dispatch("submit");
      assert(moverSlot.date === "2026-09-18" && /17/.test(thuLabel) && label() === thuLabel && !blockTitled(cols()[0], "Move me"),
        `7.A6 sub-step 4: in Day mode the view stays on Thu 09-17 after its slot moves to 09-18 (got "${label()}")`);
    } catch (e) {
      assert(false, `7.A6 line 25: the date-field walkthrough threw (${e && e.message})`);
    } finally {
      if (dlg() && btn(dlg(), "Cancel")) btn(dlg(), "Cancel").dispatch("click");
      if (dlg() && btn(dlg(), "Close")) btn(dlg(), "Close").dispatch("click");
      btn(pane, "Day").dispatch("click");
      btn(pane, "Today").dispatch("click");
    }

    // ---- D34 / D42: which blocks may be dragged ---------------------------------------------
    const draggable = (title) => { const b = blockTitled(cols()[0], title); return !!b && hasCls(b, "timegrid-block-draggable") && byClass(b, "timegrid-block-resize-handle").length === 1; };
    const plain = (title) => { const b = blockTitled(cols()[0], title); return !!b && !hasCls(b, "timegrid-block-draggable") && byClass(b, "timegrid-block-resize-handle").length === 0; };
    assert(draggable("Write report") && draggable("Team sync"),
      "7.A5 D34: a slot and a NON-recurring event get move + resize handles");
    assert(plain("Gym") && plain("Standup"),
      "7.A5 D42: a routine occurrence and a RECURRING event's occurrence get no drag affordance");

    // ---- 7.U7: a dragged block follows the finger SIDEWAYS in Week mode ----------------------
    // `window` is the real drag listener target (pointermove/up/cancel are attached to it), so the
    // stub records those handlers and lets the test deliver pointer events with coordinates.
    // A dedicated task + slot (Tue 12:00, 60 min) so the drags below can't be confused with the
    // slots earlier 7.A5/7.A6 steps created; removed again in `finally`.
    const dragTask = makeTask({ type: "finite", title: "Dragger", color: "blue" });
    const dragSlot = makeSlot({ date: D, start: "12:00", durationMin: 60, taskId: dragTask.id });
    state.tasks.push(dragTask);
    state.slots.push(dragSlot);
    mountCalendarView(pane, state, { onChange: (s) => changes.push(s.slots.length) });
    const prevWindow = globalThis.window;
    const winH = {};
    globalThis.window = {
      addEventListener(t, fn) { (winH[t] = winH[t] || []).push(fn); },
      removeEventListener(t, fn) { winH[t] = (winH[t] || []).filter((f) => f !== fn); },
    };
    const send = (t, ev) => { for (const fn of [...(winH[t] || [])]) fn({ type: t, pointerId: 1, ...ev }); };
    try {
      btn(pane, "Week").dispatch("click");
      cols().forEach((c, i) => { c._rect = { top: 0, left: i * 100, width: 100, height: 600 }; }); // centres 50,150,250...
      const wk = (i) => cols()[i];
      const has = (n, c) => hasCls(n, c);
      const tue = 2, wed = 3, mon = 1;
      const reportBlock = () => blockTitled(wk(tue), "Dragger");
      const dropTargets = () => cols().map((c, i) => (has(c, "timegrid-daycol-droptarget") ? i : -1)).filter((i) => i >= 0);
      const grab = (blk, x = 250, y = 100) => blk.fire("pointerdown", { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
      assert(cols().length === 7 && reportBlock() && dragSlot.date === D && dragSlot.start === "12:00",
        "7.U7 precondition: Week mode, the fixture slot sits in Tuesday's column at 12:00");

      // (a) a sideways + downward move: the block carries BOTH offsets, and the landing column lights up
      let blk = reportBlock();
      grab(blk);
      send("pointermove", { clientX: 350, clientY: 137.5 }); // +100 px sideways (one column), +2 rows down (18.75 px each)
      assert(blk.style.transform === "translateX(100px)",
        `7.U7: a sideways drag in Week mode moves the block with the finger (transform ${JSON.stringify(blk.style.transform)})`);
      assert(approx(blk.style.top, 43.75), `7.U7: the vertical follow is unchanged by the sideways one (top ${blk.style.top})`);
      assert(has(blk, "timegrid-block-dragging"), "7.U7: the dragged block rides above its neighbours");
      assert(dropTargets().join() === String(wed), `7.U7: ONLY the column the drop would land in (Wed) is highlighted (got ${dropTargets()})`);

      // (b) keep moving: the highlight follows the pointer to Monday and leaves Wednesday
      send("pointermove", { clientX: 150, clientY: 137.5 });
      assert(blk.style.transform === "translateX(-100px)" && dropTargets().join() === String(mon),
        `7.U7: dragging back across moves the offset and the highlight (got ${blk.style.transform}, ${dropTargets()})`);

      // (c) drop on Wednesday: commits to Wed's date, decoration is cleared, block is in Wed's column
      send("pointermove", { clientX: 350, clientY: 137.5 });
      const changesBefore = changes.length;
      send("pointerup", { clientX: 350, clientY: 137.5 });
      assert(dragSlot.date === "2026-09-16" && dragSlot.start === "13:00" && dragSlot.owner === "me" && changes.length === changesBefore + 1,
        `7.U7: the drop still lands in the column it was over, with the row maths unchanged (got ${dragSlot.date} ${dragSlot.start})`);
      assert(blk.style.transform === "" && !has(blk, "timegrid-block-dragging") && dropTargets().length === 0,
        "7.U7: after a drop the offset, the lift and every highlight are gone");
      assert(!blockTitled(wk(tue), "Dragger") && !!blockTitled(wk(wed), "Dragger"),
        "7.U7: after the drop the block is drawn in Wednesday's column and not Tuesday's");

      // (d) cancel path: a sideways move then pointercancel leaves the slot untouched and the decoration gone
      blk = blockTitled(wk(wed), "Dragger");
      grab(blk, 350, 100);
      send("pointermove", { clientX: 150, clientY: 100 });
      assert(blk.style.transform === "translateX(-200px)", "7.U7: the cancel path starts from a live sideways offset");
      send("pointercancel", {});
      assert(dragSlot.date === "2026-09-16" && dragSlot.start === "13:00" && blk.style.transform === "" &&
        !has(blk, "timegrid-block-dragging") && dropTargets().length === 0,
        "7.U7: pointercancel clears the offset and the highlight and changes nothing");

      // (e) a REJECTED drop (start before 06:00) snaps back clean: nothing committed, nothing left offset
      blk = blockTitled(wk(wed), "Dragger");
      grab(blk, 350, 400);
      send("pointermove", { clientX: 450, clientY: 5 });
      send("pointerup", { clientX: 450, clientY: 5 }); // -21 rows from 13:00 is far before the grid
      assert(dragSlot.date === "2026-09-16" && dragSlot.start === "13:00" && blk.style.transform === "" && dropTargets().length === 0,
        "7.U7: a rejected drop commits nothing and leaves no offset or highlight behind");

      // (f) resize stays vertical-only; a plain tap (no movement) decorates nothing
      blk = blockTitled(wk(wed), "Dragger");
      byClass(blk, "timegrid-block-resize-handle")[0].fire("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 350, clientY: 100 });
      send("pointermove", { clientX: 450, clientY: 140 });
      assert(!blk.style.transform && !has(blk, "timegrid-block-dragging") && dropTargets().length === 0,
        "7.U7: a RESIZE drag stays vertical-only (no sideways offset, no highlight)");
      send("pointercancel", {});
      blk = blockTitled(wk(wed), "Dragger");
      grab(blk, 350, 100);
      send("pointermove", { clientX: 352, clientY: 101 }); // under the 6px threshold
      send("pointerup", { clientX: 352, clientY: 101 });
      assert(!blk.style.transform && !has(blk, "timegrid-block-dragging"), "7.U7: a plain tap decorates nothing");

      // (g) D42 unchanged: routine / recurring-event occurrences get no pointerdown handler at all
      assert(["Gym", "Standup"].every((t) => { const b = blockTitled(wk(tue), t); return !!b && (b._ev.pointerdown || []).length === 0; }),
        "7.U7 D42: a routine occurrence and a recurring event's occurrence still have no drag handler");

      // (h) Day mode: only one column, so a sideways move means nothing and must not offset the block
      dragSlot.date = D; dragSlot.start = "09:00";
      btn(pane, "Day").dispatch("click");
      btn(pane, "Today").dispatch("click");
      blk = blockTitled(cols()[0], "Dragger");
      grab(blk, 100, 100);
      send("pointermove", { clientX: 200, clientY: 120 });
      assert(!blk.style.transform && !has(blk, "timegrid-block-dragging") && dropTargets().length === 0,
        "7.U7: in Day mode a sideways move offsets nothing (the one column is the only target)");
      send("pointercancel", {});
    } catch (e) {
      assert(false, `7.U7: the drag walkthrough threw (${e && e.message})`);
    } finally {
      globalThis.window = prevWindow;
      state.slots = state.slots.filter((x) => x.id !== dragSlot.id);
      state.tasks = state.tasks.filter((x) => x.id !== dragTask.id);
      mountCalendarView(pane, state, { onChange: () => {} });
      btn(pane, "Day").dispatch("click");
    }

    // ---- Line 41: colour on time-grid blocks -------------------------------------------------
    const colourOf = (t) => blockTitled(cols()[0], t).style.background;
    assert(
      colourOf("Write report") === TC.blue.solid && colourOf("Gym") === TC.green.solid &&
        colourOf("Team sync") === TC.amber.solid && colourOf("Standup") === TC.teal.solid,
      "7.A5 line 41: slot, routine, event and recurring-event blocks are each painted in their task's colour"
    );
    reading.color = "violet";
    state.slots.push(makeSlot({ date: D, start: "20:00", durationMin: 60, taskId: reading.id }));
    mountCalendarView(pane, state, { onChange: () => {} });
    btn(pane, "Day").dispatch("click");
    assert(colourOf("Read") === TC.violet.solid, "7.A5 line 41: changing a task's colour changes its block's colour");

    // ---- Deadlines view (5.D1) ---------------------------------------------------------------
    const dState = makeAppState();
    const dToday = makeTask({ type: "finite", title: "Due today", deadline: D });
    const dSoon = makeTask({ type: "finite", title: "Due soon", deadline: "2026-09-20" });
    const dLate = makeTask({ type: "finite", title: "Overdue one", deadline: "2026-09-12" });
    const dDone = makeTask({ type: "finite", title: "Finished", deadline: "2026-09-18", done: true });
    const dNone = makeTask({ type: "finite", title: "No date" });
    dState.tasks.push(dSoon, dDone, dToday, dNone, dLate);
    const dPane = makeGridDom();
    const picked = [];
    mountDeadlinesView(dPane, dState, { onSelectDeadline: (id) => picked.push(id) });
    const dRows = byClass(dPane, "deadline-row");
    const rowTitle = (r) => byClass(r, "deadline-row-title")[0]._t;
    assert(dRows.map(rowTitle).join("|") === "Overdue one|Due today|Due soon",
      `7.A5 deadlines: soonest deadline first; done and undated tasks excluded (got ${dRows.map(rowTitle).join("|")})`);
    assert(
      dRows.map((r) => byClass(r, "deadline-row-countdown")[0]._t).join("|") === "3 days ago|0 days|5 days" &&
        dRows.map((r) => byClass(r, "deadline-row-date")[0]._t).join("|") === "2026-09-12|2026-09-15|2026-09-20",
      "7.A5 deadlines (D35): '3 days ago' / '0 days' (never '0 days ago') / '5 days', each beside its ISO date"
    );
    assert(hasCls(dRows[0], "deadline-row-overdue") && !hasCls(dRows[1], "deadline-row-overdue") && !hasCls(dRows[2], "deadline-row-overdue"),
      "7.A5 deadlines: ONLY the overdue row gets the overdue treatment; due-today is not overdue");
    dRows[2].dispatch("click");
    assert(picked.length === 1 && picked[0] === dSoon.id, "7.A5 deadlines: tapping a row calls onSelectDeadline with that task's id");
    const emptyPane = makeGridDom();
    mountDeadlinesView(emptyPane, makeAppState(), {});
    assert(byClass(emptyPane, "deadline-row").length === 0 && byClass(emptyPane, "empty-state").length === 1,
      "7.A5 deadlines: with no deadlines the view shows its empty state instead of an empty list");
    mountDeadlinesView(emptyPane, dState, {});
    let threw = false;
    try { byClass(emptyPane, "deadline-row")[0].dispatch("click"); } catch { threw = true; }
    assert(!threw && byClass(emptyPane, "deadline-row").length === 3, "7.A5 deadlines: with no callback supplied a row tap is a harmless no-op");
  } finally {
    globalThis.document = prevDocument;
    restoreClock();
  }
}

// --- 7.A2 Security + no-secrets sweep on the shipped tree (golden rule 6, D26) ---
// 7.A1's secret sweep scans the files the BROWSER loads. GitHub Pages publishes the whole branch,
// so this block widens the net to EVERY file in the tree (test.mjs, README, CLAUDE.md included) and
// then does the three things a grep cannot: it RUNS apps-script/Code.gs against a spy Spreadsheet to
// prove a wrong/missing token touches nothing; it drives the real Settings "Export to a file"
// button from a booted, fully-configured state; and it asks git what would actually be committed.
// Nothing here contains a literal exec URL or `AK…` prefix — they are assembled from fragments, so
// this block cannot trip its own grep.
{
  const { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const vm = await import("node:vm");

  // THE SCAN SET is exactly what a push would publish to Pages: tracked files plus untracked files
  // that are not ignored, judged by the repo's OWN .gitignore only (`core.excludesFile=/dev/null`, as
  // in sub-step 4, so a developer's global ignore cannot change the answer). A filesystem walk would
  // also read gitignored local files (.env, .claude/settings.local.json) that never reach GitHub, and
  // turn the suite red on a perfectly safe machine (7.A2 review, required fix 1).
  const BINARY = /\.(png|jpe?g|gif|ico|woff2?)$/i;
  const OS_JUNK = /(^|\/)\.DS_Store$/;
  const shippable = (root) =>
    [...new Set(
      execFileSync("git", ["-c", "core.excludesFile=/dev/null", "ls-files", "-z", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
        .split("\0").filter(Boolean)
    )].filter((f) => existsSync(join(root, f)) && !OS_JUNK.test(f) && !BINARY.test(f));
  const TREE = shippable(".");
  const read = (f, root = ".") => readFileSync(join(root, f), "utf8");
  const scan = (re, files = TREE, root = ".") =>
    files.flatMap((f) => read(f, root).split("\n").flatMap((ln, i) => (re.test(ln) ? [`${f}:${i + 1}`] : [])));
  const show = (hits) => (hits.length ? hits.join(", ") : "0 hits");
  const ignored = (p) => { try { execFileSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "-q", p], { stdio: "ignore" }); return true; } catch { return false; } };

  // "The WHOLE tree" stays meaningful: every text file on disk is either in the scan set or is one
  // git ignores — the ONLY thing the set leaves out is what can never be published.
  const SKIP_DIRS = new Set([".git", "node_modules"]);
  const walkAll = (dir) => readdirSync(dir).flatMap((f) => {
    if (SKIP_DIRS.has(f)) return [];
    const p = dir === "." ? f : `${dir}/${f}`;
    return statSync(p).isDirectory() ? walkAll(p) : [p];
  });
  const leftOut = walkAll(".").filter((f) => !OS_JUNK.test(f) && !BINARY.test(f) && !TREE.includes(f));
  assert(
    ["apps-script/Code.gs", "manifest.json", "index.html", "test.mjs", "README.md", "CLAUDE.md", "js/app.js", "js/views/settings.js"]
      .every((f) => TREE.includes(f)) &&
      leftOut.every(ignored) && TREE.every((f) => !ignored(f)),
    `7.A2 sub-step 1: the sweep covers the WHOLE publishable tree (${TREE.length} text files from git ls-files -co), not just the browser-loaded files — and every on-disk file it leaves out is gitignored (${leftOut.length ? leftOut.join(", ") : "none left out"})`
  );

  // ---- sub-step 1: the secret grep, over the whole tree ----
  // A deployment id can only appear right after the `macros/s` path segment, and every one begins with the same two-letter-plus prefix Google gives deployments.
  const ID_AFTER_MACROS = /\/macros\/s\/[A-Za-z0-9_-]{8,}/;
  const ID_PREFIX = new RegExp(["AK", "fy"].join(""));
  assert(
    scan(ID_AFTER_MACROS).length === 0 && scan(ID_PREFIX).length === 0,
    `7.A2 DONE-WHEN: no Apps Script deployment id anywhere in the tree — no id after the macros/s segment, no deployment prefix (${show([...scan(ID_AFTER_MACROS), ...scan(ID_PREFIX)])})`
  );

  // The ONLY files that may name the Apps Script host are the id-less URL template (7.U5) and the
  // suite. Anything else naming it would be a real endpoint someone pasted in.
  const HOST_FILES = [...new Set(scan(/script\.google\.com/).map((h) => h.replace(/:\d+$/, "")))];
  assert(
    HOST_FILES.length === 2 && HOST_FILES.includes("js/logic.js") && HOST_FILES.includes("test.mjs"),
    `7.A2: \`script.google.com\` appears only in js/logic.js (the id-less template) and test.mjs (fixtures + assertions about it) — found in: ${HOST_FILES.join(", ")}`
  );
  // The watch-item from 7.X1's review: test.mjs's 6.C2 fixture `https://script.google.com/x`. Ruled
  // on rather than ignored: it has no `/macros/s/<id>` and no deployment prefix, so it cannot be a deployment
  // (the assertion above covers it), and its `real-secret` is a word, not a credential (below).
  assert(
    read("test.mjs").includes("sheetUrl: \"https://script.google.com/x\"") && scan(ID_AFTER_MACROS, ["test.mjs"]).length === 0,
    "7.A2: the pre-existing test.mjs 6.C2 fixture `script.google.com/x` is excused WITH evidence — it is id-less, so no deployment can be reconstructed from it"
  );

  // Non-empty token / passphrase literals: none at all outside the suite. (Same pattern 7.A1 uses
  // over the browser-loaded files; here it covers README, CLAUDE.md, Code.gs, manifest and css too.)
  // The key may be QUOTED, in double or single quotes — the natural JSON shape, e.g. in
  // manifest.json (7.A2 review, required fix 2). The ONLY value excused is a whole `<UPPER_CASE>`
  // placeholder, which is how Code.gs's contract comment spells the token in its JSON examples.
  const TOKEN_KEY = String.raw`\b(token|TOKEN|passphrase|secret|apiKey)["']?\s*[:=]\s*["']`;
  const PLACEHOLDER_AHEAD = String.raw`(?!<[A-Z][A-Z0-9_]*>["'])`;
  const NONEMPTY_TOKEN = new RegExp(TOKEN_KEY + PLACEHOLDER_AHEAD + String.raw`[^"']+["']`);
  const ANY_TOKEN_LITERAL = new RegExp(TOKEN_KEY + String.raw`[^"']+["']`);
  const NON_SUITE = TREE.filter((f) => f !== "test.mjs");
  assert(
    scan(NONEMPTY_TOKEN, NON_SUITE).length === 0,
    `7.A2 DONE-WHEN: no non-empty token/passphrase/secret literal, quoted key or not, in any of the ${NON_SUITE.length} non-suite files (${show(scan(NONEMPTY_TOKEN, NON_SUITE))})`
  );
  // What the placeholder excuse lets through, named on every run: today exactly Code.gs's contract
  // comment (so the excuse is exercised, not dead), and every excused line is a placeholder line.
  const excusedLines = scan(ANY_TOKEN_LITERAL, NON_SUITE);
  const lineOf = (h) => { const i = h.lastIndexOf(":"); return read(h.slice(0, i)).split("\n")[Number(h.slice(i + 1)) - 1]; };
  assert(
    excusedLines.some((h) => h.startsWith("apps-script/Code.gs:")) &&
      excusedLines.every((h) => new RegExp(TOKEN_KEY + String.raw`<[A-Z][A-Z0-9_]*>["']`).test(lineOf(h))),
    `7.A2: the <UPPER_CASE> placeholder excuse is live (Code.gs's contract comment) and lets through nothing but placeholder lines (${show(excusedLines)})`
  );
  // The widened pattern, on the shapes the review named. Keys and values assembled so this source
  // is not itself a hit for the suite-literal check below.
  {
    const K = ["to", "ken"].join("");
    const V = ["abc", "123", "def", "456"].join("");
    const mustHit = [`"${K}": "${V}"`, `'${K}': '${V}'`, `{"${K}":"${V}"}`, `${K}: "${V}"`, `${K.toUpperCase()}="${V}"`, `"${K}":"<${K}>"`, `"${K}":"<${K.toUpperCase()}> ${V}"`];
    const mustPass = [`"${K}":"<${K.toUpperCase()}>"`, `'${K}': '<EXEC_URL>'`, `"${K}": ""`, `${K}: ""`];
    const missed = mustHit.filter((s) => !NONEMPTY_TOKEN.test(s));
    const flagged = mustPass.filter((s) => NONEMPTY_TOKEN.test(s));
    assert(
      missed.length === 0 && flagged.length === 0,
      `7.A2: the token pattern catches quoted JSON/JS keys and a lowercase or padded "placeholder", and excuses only an exact <UPPER_CASE> placeholder or an empty value (missed: ${missed.join(" | ") || "none"}; wrongly flagged: ${flagged.join(" | ") || "none"})`
    );
  }
  // Inside the suite every such literal must be an obviously-fake fixture WORD: short, and with no
  // digit (a real generated secret has digits). A real-looking value fails here and is reviewed.
  const suiteLiterals = [...read("test.mjs").matchAll(/\b(?:token|TOKEN|passphrase|apiKey)["']?\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert(
    suiteLiterals.length > 0 && suiteLiterals.every((v) => v.length <= 24 && !/\d/.test(v)),
    `7.A2: every token literal in test.mjs is a short digit-free fixture word, none credential-shaped (${[...new Set(suiteLiterals)].join(", ")})`
  );

  // No personal identifier: no email address, no Google account host, and no machine-specific
  // absolute home path (Pages publishes the whole branch, so one would publish the account name too).
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
  // Assembled from fragments so the pattern's own source line is not a hit for itself.
  const GOOGLE_ACCOUNT = new RegExp(["accounts\\.go", "ogle|gm", "ail\\.|goo", "glemail"].join(""), "i");
  assert(
    scan(EMAIL).length === 0 && scan(GOOGLE_ACCOUNT).length === 0,
    `7.A2 DONE-WHEN: no email address and no Google-account identifier anywhere in the tree (${show([...scan(EMAIL), ...scan(GOOGLE_ACCOUNT)])})`
  );
  const HOME_PATH = new RegExp(["\\/Us", "ers\\/[A-Za-z]", "|\\/ho", "me\\/[a-z]"].join(""));
  assert(
    scan(HOME_PATH).length === 0,
    `7.A2: no absolute home-directory path (a macOS or Linux account name) is committed anywhere in the tree (${show(scan(HOME_PATH))})`
  );
  // No high-entropy blob that a keyword grep would miss: a 32+ char base64url-ish run containing
  // BOTH a digit and a letter. (Hyphen/underscore rulers and long CSS/ARIA names have no digit.)
  const BLOB = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/;
  assert(
    scan(BLOB).length === 0,
    `7.A2: no 32+ character mixed letter/digit run (the shape of a deployment id, key or token) anywhere in the tree (${show(scan(BLOB))})`
  );

  // ---- the scan set, PROVED on a throwaway repo (never the real working tree) ----
  // It carries this repo's REAL .gitignore. The same secrets are planted three ways: in gitignored
  // local files (must NOT fail the sweep — they never reach Pages), in untracked-but-committable files
  // (must fail — `git add -A` would publish them), and force-added to the index (must fail — tracked
  // wins over ignored). Every value is assembled from fragments so this source trips nothing.
  {
    const SWEEP = [["deployment id", ID_AFTER_MACROS], ["deployment prefix", ID_PREFIX], ["token literal", NONEMPTY_TOKEN], ["email", EMAIL], ["home path", HOME_PATH], ["32+ char blob", BLOB]];
    const sweepHits = (root, files) => SWEEP.filter(([, re]) => scan(re, files, root).length > 0).map(([n]) => n);
    const K = ["to", "ken"].join("");
    const V = ["abc", "123", "def", "456"].join("");
    const execUrl = ["https://", "script", ".google", ".com/", "mac", "ros", "/s/", "AK", "fy", "c", "PLANT_FAKE_NOT_REAL_0123456789", "/exec"].join("");
    const homePath = ["/Us", "ers/", "someone/Documents/ledger-project"].join("");
    const email = ["someone", "example.com"].join("@");
    // The reviewer's two plants: Claude Code's per-machine allowlist, and an env file.
    const PLANTS = {
      ".claude/settings.local.json": JSON.stringify({ permissions: { allow: [`Read(${homePath}/**)`] } }) + "\n",
      ".env": `${K.toUpperCase()}="${V}"\nSHEET_URL=${execUrl}\nOWNER=${email}\n`,
    };
    const M13 = `{ "name": "PIN", "${K}": "${V}" }\n`; // the review's mutation M13, verbatim in shape
    const dir = mkdtempSync(join(tmpdir(), "pin-7a2-sweep-"));
    try {
      const git = (...args) => execFileSync("git", ["-c", "core.excludesFile=/dev/null", ...args], { cwd: dir, stdio: "ignore" });
      git("init", "-q");
      writeFileSync(join(dir, ".gitignore"), read(".gitignore"));
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>PIN</title>\n");
      mkdirSync(join(dir, ".claude"));
      for (const [f, body] of Object.entries(PLANTS)) writeFileSync(join(dir, f), body);

      // Non-vacuous: read DIRECTLY, the plants trip every pattern — so their absence below is the
      // scan set doing the work, not a blind pattern.
      const direct = sweepHits(dir, Object.keys(PLANTS));
      assert(direct.length === SWEEP.length, `7.A2 control: read directly, the planted files trip every sweep pattern (${direct.join(", ")})`);

      const set1 = shippable(dir);
      const hits1 = sweepHits(dir, set1);
      assert(
        Object.keys(PLANTS).every((f) => !set1.includes(f)) && set1.includes("index.html") && hits1.length === 0,
        `7.A2 scan set: a secret planted in a GITIGNORED .env or .claude/settings.local.json does NOT fail the sweep — those files never reach Pages (scanned: ${set1.join(", ")}; hits: ${hits1.join(", ") || "none"})`
      );

      // The same bytes under committable names: untracked, not ignored → `git add -A` would ship them.
      writeFileSync(join(dir, "settings.json"), PLANTS[".claude/settings.local.json"]);
      writeFileSync(join(dir, "config.env.txt"), PLANTS[".env"]);
      writeFileSync(join(dir, "manifest.json"), M13);
      const set2 = shippable(dir);
      const hits2 = sweepHits(dir, set2);
      assert(
        ["settings.json", "config.env.txt", "manifest.json"].every((f) => set2.includes(f)) && hits2.length === SWEEP.length,
        `7.A2 scan set: the SAME secrets in untracked-but-committable files DO fail the sweep, every pattern (${hits2.join(", ")})`
      );
      assert(
        scan(NONEMPTY_TOKEN, set2, dir).includes("manifest.json:1"),
        "7.A2 (review M13): a quoted-key `\"token\": \"…\"` literal added to manifest.json is caught"
      );

      // Tracked wins over ignored: force-add the ignored plants alone, and the sweep must see them.
      for (const f of ["settings.json", "config.env.txt", "manifest.json"]) rmSync(join(dir, f));
      git("add", "-f", "--", ...Object.keys(PLANTS));
      const set3 = shippable(dir);
      const hits3 = sweepHits(dir, set3);
      assert(
        Object.keys(PLANTS).every((f) => set3.includes(f)) && hits3.length === SWEEP.length,
        `7.A2 scan set: once TRACKED (force-added past .gitignore), the same .env and settings.local.json DO fail the sweep (${hits3.join(", ")})`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- sub-step 2: Code.gs is the token-gated rewrite, and it BEHAVES that way ----
  function runGs(tokenProperty) {
    const touched = []; // every Spreadsheet call, read or write
    const writes = []; // the write subset
    const range = (tab) => ({
      getValue: () => { touched.push(`${tab}.getValue`); return tab === "tasks" ? JSON.stringify([{ id: "t1", title: "Private" }]) : 1; },
      getValues: () => { touched.push(`${tab}.getValues`); return [["s1", "me", "2026-01-01", "09:00", 30, "t1"]]; },
      setValue: () => { touched.push(`${tab}.setValue`); writes.push(`${tab}.setValue`); },
      setValues: () => { touched.push(`${tab}.setValues`); writes.push(`${tab}.setValues`); },
      setNumberFormat: () => { touched.push(`${tab}.setNumberFormat`); writes.push(`${tab}.setNumberFormat`); },
    });
    const sheet = (tab) => ({
      getRange: () => range(tab),
      getLastRow: () => { touched.push(`${tab}.getLastRow`); return 2; },
      clearContents: () => { touched.push(`${tab}.clearContents`); writes.push(`${tab}.clearContents`); },
    });
    const ctx = {
      ContentService: { MimeType: { JSON: "json" }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "TOKEN" ? tokenProperty : null) }) },
      SpreadsheetApp: {
        getActiveSpreadsheet: () => {
          touched.push("getActiveSpreadsheet");
          return { getSheetByName: (n) => sheet(n), insertSheet: (n) => sheet(n) };
        },
      },
    };
    vm.runInNewContext(read("apps-script/Code.gs"), ctx, { timeout: 2000 });
    const post = (body) => {
      touched.length = 0; writes.length = 0;
      let out = null, threw = null;
      try { out = ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }); } catch (e) { threw = e; }
      return { res: out ? JSON.parse(out.text) : null, raw: out ? out.text : "", threw, touched: [...touched], writes: [...writes] };
    };
    const get = (e) => {
      touched.length = 0; writes.length = 0;
      const out = ctx.doGet(e);
      return { res: JSON.parse(out.text), raw: out.text, touched: [...touched], writes: [...writes] };
    };
    return { post, get };
  }

  const GOOD = ["k", "-", "good"].join("");
  const gs = runGs(GOOD);
  const UNAUTH = JSON.stringify({ ok: false, error: "unauthorized" });
  const SAVE_BODY = { action: "save", version: 1, tasks: [{ id: "x" }], slots: [] };

  // Positive controls first: the spy must be able to SEE a read and a write, or "touched nothing"
  // below would be vacuous.
  const okLoad = gs.post({ action: "load", token: GOOD });
  assert(
    okLoad.res.ok === true && okLoad.res.tasks.length === 1 && okLoad.res.slots.length === 1 && okLoad.touched.length > 0,
    "7.A2 control: with the RIGHT token, load returns the data and the spy sees the Spreadsheet being read (so the 'touched nothing' lines below can fail)"
  );
  const okSave = gs.post({ ...SAVE_BODY, token: GOOD });
  assert(okSave.res.ok === true && okSave.writes.length > 0, "7.A2 control: with the RIGHT token, save writes and the spy sees the writes");

  const wrongCases = [
    ["wrong token", { token: "nope" }],
    ["missing token", {}],
    ["empty-string token", { token: "" }],
    ["null token", { token: null }],
    ["numeric token", { token: 0 }],
    ["array token", { token: [GOOD] }],
    ["token with the right text but a trailing space", { token: GOOD + " " }],
  ];
  for (const action of ["load", "save"]) {
    for (const [name, extra] of wrongCases) {
      const body = action === "save" ? { ...SAVE_BODY, ...extra } : { action, ...extra };
      const r = gs.post(body);
      assert(
        r.threw === null && r.raw === UNAUTH && r.touched.length === 0,
        `7.A2 DONE-WHEN (${action}, ${name}): exactly {ok:false,error:"unauthorized"}, and the Spreadsheet is never touched — no read, no write (touched: ${r.touched.join(",") || "nothing"})`
      );
    }
  }
  // Order matters: the token gate sits BEFORE action dispatch, so an unknown action with a bad
  // token learns nothing about which actions exist.
  const unk = gs.post({ action: "dump", token: "nope" });
  assert(unk.raw === UNAUTH && unk.touched.length === 0, "7.A2: an UNKNOWN action with a bad token is still just `unauthorized` — the gate runs before action dispatch");
  const echo = gs.post({ action: "load", token: "probe-" + GOOD });
  assert(!echo.raw.includes(GOOD), "7.A2: the unauthorized reply never echoes the token (or the expected one) back");

  // The Script Property being UNSET must not turn an omitted token into a match (`undefined === undefined`).
  for (const [name, prop] of [["undefined", undefined], ["null", null], ["empty string", ""]]) {
    const unset = runGs(prop);
    const attempts = [{ action: "load" }, { action: "load", token: "" }, { action: "load", token: null }, { action: "load", token: "undefined" }];
    assert(
      attempts.every((a) => { const r = unset.post(a); return r.raw === UNAUTH && r.touched.length === 0; }),
      `7.A2: with the TOKEN Script Property ${name} (never configured), NO request is authorised — an unconfigured script fails closed, not open`
    );
  }

  // Malformed bodies: no data, no writes, whatever they do. `null` is the one a naive
  // `body.token` read would crash on; a crash returns an error page, never data (recorded).
  for (const [name, raw] of [["that is not JSON", "{oops"], ["that is empty", ""], ["that is JSON null", "null"], ["that is a bare string", "\"hi\""], ["that is an array", "[]"]]) {
    const r = gs.post(raw);
    assert(
      r.touched.length === 0 && !/"tasks"|"slots"/.test(r.raw),
      `7.A2: a request body ${name} touches nothing and returns no data (${r.threw ? "throws " + r.threw.constructor.name : r.raw})`
    );
  }

  // GET is a liveness ping and NEVER data — even when the caller smuggles the right token in.
  const pings = [gs.get({}), gs.get({ parameter: { action: "load", token: GOOD } }), gs.get(undefined)];
  assert(
    pings.every((p) => p.raw === JSON.stringify({ ok: true }) && p.touched.length === 0),
    "7.A2 D26 rule 1: doGet answers exactly {ok:true} and never opens the Spreadsheet — not even for `?action=load&token=<the right token>`"
  );
  // D26 rule 2, behaviourally (7.A1 only checks the source order): with the RIGHT token, a payload
  // whose arrays are missing or malformed is refused and nothing is written.
  for (const [name, body] of [["no tasks", { action: "save", token: GOOD, version: 1, slots: [] }], ["tasks as a string", { action: "save", token: GOOD, version: 1, tasks: "oops", slots: [] }], ["no slots", { action: "save", token: GOOD, version: 1, tasks: [] }]]) {
    const r = gs.post(body);
    assert(r.res.ok === false && r.writes.length === 0, `7.A2 D26 rule 2: an authorised save with ${name} is rejected and writes NOTHING (it can never wipe the Sheet)`);
  }
  assert(
    !ID_PREFIX.test(read("apps-script/Code.gs")) && /PropertiesService\.getScriptProperties\(\)\.getProperty\(['"]TOKEN['"]\)/.test(read("apps-script/Code.gs")),
    "7.A2 sub-step 2: the shipped Code.gs is the 6.S-series rewrite — token read from Script Properties at request time, not the v1 draft"
  );

  // ---- sub-step 3: a REAL export, from a REAL booted, fully-configured state, carries no secret ----
  {
    const { mountSettingsView } = await import("./js/views/settings.js");
    const EXEC_PATH = ["mac", "ros", "/s/"].join("");
    const DEPLOY_PREFIX = ["AK", "fy", "c"].join("");
    const liveExecUrl = ["https://", "script", ".google", ".com/", EXEC_PATH, DEPLOY_PREFIX, "SWEEP_FAKE_NOT_REAL_0123456789", "/exec"].join("");
    const liveToken = ["sw33p", "-fixt", "ure-tok3n"].join("");

    function makeDom() {
      function el(tag) {
        return {
          tagName: String(tag).toUpperCase(), className: "", type: "", value: "", disabled: false,
          style: {}, dataset: {}, _a: {}, _t: "", children: [], _ev: {}, _clicks: 0,
          classList: { add(...cs) { this._n.className += " " + cs.join(" "); } },
          get textContent() { return this._t; },
          set textContent(v) { this.children = []; this._t = String(v); },
          setAttribute(k, v) { this._a[k] = String(v); },
          getAttribute(k) { return k in this._a ? this._a[k] : null; },
          appendChild(c) { this.children.push(c); return c; },
          append(...cs) { for (const c of cs) this.children.push(c); },
          removeChild(c) { this.children = this.children.filter((x) => x !== c); },
          addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
          click() { this._clicks++; },
          focus() {},
          dispatch(t) { for (const fn of this._ev[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
        };
      }
      const wrap = (tag) => { const n = el(tag); n.classList._n = n; return n; };
      globalThis.document = { createElement: wrap };
      return wrap("main");
    }
    const walkNodes = (n) => [n, ...n.children.flatMap(walkNodes)];

    const prevDocument = globalThis.document;
    const prevStorage = globalThis.localStorage;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const origBlob = globalThis.Blob;
    const handed = [];
    try {
      URL.createObjectURL = (blob) => { handed.push(blob); return "blob:sweep/0"; };
      URL.revokeObjectURL = () => {};
      globalThis.Blob = class BlobStub {
        constructor(parts) { this.parts = parts; }
        get text() { return this.parts.join(""); }
      };

      // Phase 1: a real app, a populated planner, and a configured + connected Sheet — persisted.
      globalThis.localStorage = makeSpyStorage();
      await boot({ search: "" });
      const s0 = getState();
      const seeded = sampleState();
      s0.tasks = seeded.tasks;
      s0.slots = seeded.slots;
      s0.settings = { providerType: "sheets", sheetUrl: liveExecUrl, token: liveToken };
      persistChange(s0);

      // Phase 2: a real RELOAD, so the state under test is what a returning user really has.
      await boot({ search: "" });
      const live = getState();
      assert(
        live.settings.token === liveToken && live.settings.sheetUrl === liveExecUrl && live.tasks.length > 0 && live.slots.length > 0,
        "7.A2 sub-step 3 (non-vacuous): the reloaded state really holds the token, the exec URL, tasks AND slots"
      );
      assert(
        globalThis.localStorage.getItem(STORAGE_KEY).includes(liveToken),
        "7.A2: the secrets DO live in the browser's own storage (by design: runtime-only, browser-only) — so the export's silence below is the exclusion doing real work"
      );

      // Phase 3: press the REAL Export button of the REAL Settings view.
      const pane = makeDom();
      mountSettingsView(pane, live, { onChange: persistChange, onStateReplaced: () => {}, confirm: () => true });
      const exportBtn = walkNodes(pane).find((n) => n.tagName === "BUTTON" && n._t === "Export to a file");
      assert(!!exportBtn, "7.A2: the real Settings view renders an 'Export to a file' button");
      exportBtn.dispatch("click");
      assert(handed.length === 1, "7.A2: pressing it hands exactly one file to the browser");
      const text = handed[0].text;
      const parsed = JSON.parse(text);

      assert(
        !text.includes(liveToken) && !text.includes(liveExecUrl),
        "7.A2 DONE-WHEN: the exported FILE contains neither the token nor the exec URL"
      );
      assert(
        !text.includes(EXEC_PATH) && !text.includes(DEPLOY_PREFIX) && !/script\.google/.test(text) && !/SWEEP_FAKE|sw33p/.test(text),
        "7.A2: nor any fragment of them — no Apps Script path segment, no deployment prefix, no host"
      );
      assert(
        JSON.stringify(Object.keys(parsed)) === JSON.stringify(["version", "tasks", "slots", "prefs"]) &&
          !/"(token|sheetUrl|settings|providerType|passphrase)"\s*:/.test(text),
        `7.A2: the file's top-level keys are exactly version, tasks, slots, prefs — \`settings\` is absent, not blanked (${Object.keys(parsed).join(", ")})`
      );
      assert(
        parsed.tasks.length === live.tasks.length && parsed.slots.length === live.slots.length,
        "7.A2: the export is not simply empty — every task and slot made it into the file"
      );
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      globalThis.Blob = origBlob;
      globalThis.document = prevDocument;
      if (prevStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevStorage;
    }
  }

  // ---- sub-step 4: .gitignore covers what must never be committed, and git agrees ----
  // `core.excludesFile=/dev/null`: a developer's GLOBAL git ignore must not be able to make this pass
  // on one machine and fail on another — only the repo's own .gitignore counts (`ignored`, defined
  // at the top of this block).
  const mustIgnore = [".DS_Store", "js/.DS_Store", ".env", ".env.local", ".clasp.json", ".clasprc.json", ".claude/settings.local.json", "signing.pem", "private.key"];
  const notIgnored = mustIgnore.filter((p) => !ignored(p));
  assert(
    notIgnored.length === 0,
    `7.A2 sub-step 4: git ignores every local-only/credential file name a Pages + Apps Script project can grow (${notIgnored.length ? "NOT ignored: " + notIgnored.join(", ") : mustIgnore.length + " checked"})`
  );
  const mustTrack = ["index.html", "manifest.json", "apps-script/Code.gs", "js/app.js", "css/styles.css", "icons/icon-192.png"];
  assert(
    mustTrack.every((p) => !ignored(p)),
    "7.A2: the ignore rules are not over-broad — every shipped file is still committable"
  );
  const wouldCommit = execFileSync("git", ["-c", "core.excludesFile=/dev/null", "ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const SENSITIVE_NAME = /(^|\/)(\.env(\..*)?|\.clasp(rc)?\.json|credentials.*|id_rsa.*|secrets?\.[a-z]+|.*\.(pem|key|p12|pfx|keystore|log))$/i;
  assert(
    wouldCommit.length > 10 && !wouldCommit.some((f) => SENSITIVE_NAME.test(f)) && !wouldCommit.some((f) => /\.DS_Store$/.test(f)),
    `7.A2: of the ${wouldCommit.length} files git would commit right now, none is a credential-shaped or OS-junk file name`
  );
}

// --- 7.U6 The add button stays on top of the Day/Week time-grid ---
// Same approach as 7.U1: read the SHIPPED css/styles.css and resolve the stacking order from it,
// never from a restated copy. `.timegrid-block` (z 1) and `.timegrid-nowline` (z 2) used to
// out-rank `.add-btn` (z auto), so a block scrolled under the button painted over it and took the
// tap. The button must sit strictly above every time-grid layer and strictly below #modal-host,
// which has to keep covering it while a sheet is open. Real-browser stacking (elementFromPoint)
// is recorded in the 7.U6 handoff; the phone feel rides 7.INT.
{
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("./css/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  // Every innermost `selector { body }` pair. An at-rule wrapper (`@media … {`) never matches,
  // because its body contains braces, so the rules nested inside it are matched on their own.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((s) => s.trim()),
    body: m[2],
  }));
  const zOf = (body) => {
    const m = body.match(/(?:^|;)\s*z-index\s*:\s*([^;]+)/);
    return m ? m[1].trim() : null;
  };
  const zRules = (pred) =>
    rules.filter((r) => r.selectors.some(pred) && zOf(r.body) !== null).map((r) => ({ sel: r.selectors.join(", "), z: zOf(r.body) }));

  const grid = zRules((s) => /\.timegrid-/.test(s));
  const modal = zRules((s) => s === "#modal-host");
  const add = zRules((s) => s === ".add-btn");

  assert(
    grid.some((r) => /(^|[\s,])\.timegrid-block(?![\w-])/.test(r.sel)) && grid.some((r) => /\.timegrid-nowline(?![\w-])/.test(r.sel)),
    `7.U6 control: both time-grid layers were found with a z-index (${grid.map((r) => `${r.sel}=${r.z}`).join("; ")})`
  );
  assert(modal.length === 1, `7.U6 control: exactly one #modal-host rule sets a z-index (found ${modal.length})`);
  assert(
    [...grid, ...modal].every((r) => /^-?\d+$/.test(r.z)),
    "7.U6 control: every time-grid and #modal-host z-index is a plain integer, so the comparison below is numeric"
  );
  assert(
    add.length === 1 && /^-?\d+$/.test(add[0].z),
    `7.U6: exactly one .add-btn rule sets an integer z-index (found ${add.map((r) => r.z).join(", ") || "none"})`
  );
  assert(
    rules.some((r) => r.selectors.includes(".add-btn") && /(?:^|;)\s*position\s*:\s*(absolute|fixed)\b/.test(r.body)),
    "7.U6: .add-btn is still positioned, so its z-index actually applies"
  );
  if (add.length === 1 && grid.length > 0 && modal.length === 1) {
    const addZ = Number(add[0].z);
    const gridMax = Math.max(...grid.map((r) => Number(r.z)));
    const modalZ = Number(modal[0].z);
    assert(addZ > gridMax, `7.U6: .add-btn (z ${addZ}) sits above every time-grid layer (max z ${gridMax})`);
    assert(addZ < modalZ, `7.U6: .add-btn (z ${addZ}) sits below #modal-host (z ${modalZ}), so an open sheet still covers it`);
  }
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
