import { makeAppState, makeTask, makeSlot, uid, DEFAULT_COLOR, migrate } from "./js/state.js";
import {
  childrenOf, expandOccurrences, occurrenceStatus, progressOf, breakdownOf,
  effectiveDone, setDoneCascade, completionState, isOverdue, deleteCascade,
  validateRecurrence, recurrenceSummary, occurrencesWithStatus, setOccurrenceStatus,
  validateEventTimes, eventSummary, overrideEventOccurrence, cancelEventOccurrence,
} from "./js/logic.js";
import {
  STORAGE_KEY, CORRUPT_SUFFIX, Store, StorageProvider, LocalStorageProvider, SheetsProvider,
  StorageCorruptError, LEGACY_KEYS, readLegacyV1,
} from "./js/storage.js";
import { sampleState } from "./js/sample-data.js";
import { boot, saveState, getState, persistChange } from "./js/app.js";

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
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

// SheetsProvider stub: methods present but throw "deferred to Step 6"; real network is Step 6 only
{
  const sheets = new SheetsProvider({ execUrl: "https://example.invalid/exec", token: "t" });
  const results = await Promise.allSettled([
    sheets.authenticate(), sheets.load(), sheets.save(makeAppState()),
  ]);
  assert(
    results.every(r => r.status === "rejected" && r.reason.message === "deferred to Step 6"),
    "SheetsProvider stub methods all throw 'deferred to Step 6'"
  );
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

  const slidesOcc = expandOccurrences(slides);
  const slidesDone = slidesOcc.filter(o => occurrenceStatus(slides, o.date) === "done").length;
  assert(
    progressOf(seed.tasks, slides) === Math.round((100 * slidesDone) / slidesOcc.length),
    "sampleState(): slides-routine progress matches its done/total occurrence ratio"
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

  const markOcc = expandOccurrences(markAssignment).map(o => o.date);
  assert(
    JSON.stringify(markOcc) ===
      JSON.stringify(["2026-01-30", "2026-02-20", "2026-03-13", "2026-04-03", "2026-04-24"]),
    "sampleState() 2.A5: 'Mark assignment' occurrences are the five Option-A assignment Fridays"
  );
  const everyFriday = expandOccurrences({ ...markAssignment, exceptions: {} });
  assert(
    markOcc.length < everyFriday.length && everyFriday.length === 16,
    "sampleState() 2.A5: the Option-A set is sparser than the 16 Fridays the bare rule yields"
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
  assert(
    validateEventTimes({ allDay: false, start: null, end: null, recurrence: badRecurrence }).error ===
      validateRecurrence(badRecurrence).error,
    "4.E1 validateEventTimes: a malformed recurrence delegates verbatim to validateRecurrence's own message"
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

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
