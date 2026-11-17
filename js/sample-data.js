// Sample seed data (PIN v2 dev fixture) — docs/05_TASKS_STEP1.md §1.5.
// Exercises every item type for eyeballing the UI and local testing before any cloud wiring.
// Dev-only: 1.INT's boot wires this behind an explicit trigger (e.g. `?seed=1`), never auto-loaded
// over real data — this module only builds the state, it does not decide when to load it.

import { makeAppState, makeTask, makeSlot } from "./state.js";
import { expandOccurrences } from "./logic.js";

// Dates below are all computed relative to "today" (never hardcoded calendar dates, and never
// toISOString — CLAUDE.md's local-date rule) so a fresh `?seed=1` always lands the user near the
// current date instead of requiring them to navigate to whatever month the fixture was authored
// in. `addDays` shifts by exactly N days; every window/date offset below is a multiple of 7 so
// weekday alignment (Monday routine, Friday routine) is preserved regardless of what weekday
// "today" itself happens to be. NOTE: multiples of 7 preserve ALIGNMENT but not COUNT — a
// recurrence WINDOW must additionally be pinned to its own weekday at BOTH ends, or its
// occurrence count changes with the weekday "today" falls on (see `slidesStart`/`slidesEnd`).
function todayISO() {
  return new Date().toLocaleDateString("en-CA");
}
function addDays(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}
// Earliest date >= dateISO landing on the given day-of-week (0=Sun..6=Sat) — `today` isn't
// necessarily a Monday/Friday itself, so an offset window's start needs snapping to the
// recurrence's own weekday before further multiples-of-7 offsets stay aligned to it.
function nextWeekday(dateISO, dow) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
  return d.toLocaleDateString("en-CA");
}

// `opts.today` overrides the wall-clock date ("YYYY-MM-DD"), so the fixture's weekday-sensitive
// windows can be asserted on every day of the week instead of only on whatever day the suite
// happens to run. Same injectable-date convention `visibleRunway`/`focusMonthFor` use in
// js/views/calendar.js. Production callers pass nothing and get the real today.
export function sampleState({ today: todayOverride } = {}) {
  const state = makeAppState();
  const today = todayOverride ?? todayISO();

  // --- Course (finite container) + two routines + two attached exams — all "blue" ---
  const course = makeTask({
    type: "finite", title: "CS 402: Distributed Systems", color: "blue", priority: "med",
  });

  // Window holds EXACTLY 16 Monday occurrences (the canonical count, 03 Part A's worked
  // example, matching the original Jan12-May1 span), with "today" always inside it: the start
  // is the first Monday on/after today-49, the end is 15 weeks later, i.e. the 16th Monday.
  // The previous [today-49, today+63] window spanned 113 days = 16 weeks + 1 day, and BOTH
  // endpoints inherited today's weekday (both offsets being multiples of 7) — so whenever
  // "today" was itself a Monday the window held 17 Mondays, not 16, silently breaking the
  // course's 8/16 + 2/5 -> 10/21 breakdown one day in seven.
  const slidesStart = nextWeekday(addDays(today, -49), 1); // first Monday on/after today-49
  const slidesEnd = addDays(slidesStart, 15 * 7); // the 16th Monday (inclusive end)
  const slides = makeTask({
    type: "routine", title: "Prepare slides", parentId: course.id, color: "blue",
    recurrence: { days: [1], time: "09:00", durationMin: 120, start: slidesStart, end: slidesEnd },
  });
  // First 8 Monday occurrences marked done — lands right around "today" regardless of which
  // weekday today actually is (7-week run-up above).
  expandOccurrences(slides).slice(0, 8).forEach(o => { slides.log[o.date] = "done"; });

  // Option A (D5, confirmed 2026-07-16): marking happens only on the weeks an assignment is due,
  // not every Friday. The weekly rule stays (Recurrence is weekly-only); the non-assignment
  // Fridays are CANCELLED via the D36 `exceptions` map, leaving five specific due-date Fridays.
  const markStart = nextWeekday(slidesStart, 5); // the first Friday on/after slidesStart
  const markAssignment = makeTask({
    type: "routine", title: "Mark assignment", parentId: course.id, color: "blue",
    recurrence: { days: [5], time: "17:00", durationMin: 60, start: markStart, end: slidesEnd },
  });
  // 3-week spacing, first due-Friday 2 weeks into the window — same cadence as the original
  // fixture; with a 7-week run-up above, this lands 2 due-Fridays before today and 3 after.
  const assignmentFridays = [14, 35, 56, 77, 98].map((n) => addDays(markStart, n));
  expandOccurrences(markAssignment)
    .filter(o => !assignmentFridays.includes(o.date))
    .forEach(o => { markAssignment.exceptions[o.date] = null; });
  expandOccurrences(markAssignment)
    .filter(o => o.date < today)
    .forEach(o => { markAssignment.log[o.date] = "done"; });

  const midterm = makeTask({
    type: "event", title: "Midterm exam", parentId: course.id, color: "blue",
    start: `${addDays(today, 3)}T10:00`, end: `${addDays(today, 3)}T12:00`, location: "Hall A",
  });
  const final = makeTask({
    type: "event", title: "Final exam", parentId: course.id, color: "blue",
    start: `${addDays(slidesEnd, 3)}T09:00`, end: `${addDays(slidesEnd, 3)}T11:00`, location: "Hall A",
  });

  // --- Paper (finite container) — "violet": Review done, Design done, Experiment not ---
  const paper = makeTask({
    type: "finite", title: "CHI paper", color: "violet", priority: "high", deadline: addDays(today, 26),
  });
  // A done finite leaf ALWAYS carries a completedAt (03 Part A; setDoneCascade stamps it on every tick).
  // Fixed epochs, not Date.now(), so these two timestamps don't drift per run.
  // (Note: `id` and `createdAt` still come from the factories' time-seeded defaults.)
  const review = makeTask({
    type: "finite", title: "Review", parentId: paper.id, color: "violet",
    done: true, completedAt: 1740000000000,
  });
  const design = makeTask({
    type: "finite", title: "Design", parentId: paper.id, color: "violet",
    done: true, completedAt: 1740600000000,
  });
  const experiment = makeTask({ type: "finite", title: "Experiment", parentId: paper.id, color: "violet", done: false });

  // --- Standalone event (default event color) ---
  const meeting = makeTask({
    type: "event", title: "Dept meeting",
    start: `${addDays(today, -30)}T14:00`, end: `${addDays(today, -30)}T15:00`, location: "Room 4.12",
  });

  state.tasks.push(course, slides, markAssignment, midterm, final, paper, review, design, experiment, meeting);

  // --- Planner slots (the 2h block exercises D30 multi-length rendering in Step 5) ---
  // Placed on/around today (not the recurrence window's own start) so opening Calendar in
  // Day/Week mode shows draggable content immediately, with no navigation needed.
  state.slots.push(
    makeSlot({ date: today, start: "09:00", taskId: slides.id }),
    makeSlot({ date: addDays(today, 1), start: "19:00", taskId: review.id }),
    makeSlot({ date: addDays(today, -1), start: "14:00", durationMin: 120, taskId: experiment.id }),
  );

  return state;
}
