// Sample seed data (Ledger v2 dev fixture) — docs/05_TASKS_STEP1.md §1.5.
// Exercises every item type for eyeballing the UI and local testing before any cloud wiring.
// Dev-only: 1.INT's boot wires this behind an explicit trigger (e.g. `?seed=1`), never auto-loaded
// over real data — this module only builds the state, it does not decide when to load it.

import { makeAppState, makeTask, makeSlot } from "./state.js";
import { expandOccurrences } from "./logic.js";

export function sampleState() {
  const state = makeAppState();

  // --- Course (finite container) + two routines + two attached exams — all "blue" ---
  const course = makeTask({
    type: "finite", title: "CS 402: Distributed Systems", color: "blue", priority: "med",
  });

  const slides = makeTask({
    type: "routine", title: "Prepare slides", parentId: course.id, color: "blue",
    recurrence: { days: [1], time: "09:00", durationMin: 120, start: "2026-01-12", end: "2026-05-01" },
  });
  expandOccurrences(slides).slice(0, 8).forEach(o => { slides.log[o.date] = "done"; });

  // Option A (D5, confirmed 2026-07-16): marking happens only on the weeks an assignment is due,
  // not every Friday. The weekly rule stays (Recurrence is weekly-only); the non-assignment
  // Fridays are CANCELLED via the D36 `exceptions` map, leaving five specific due-date Fridays.
  const assignmentFridays = ["2026-01-30", "2026-02-20", "2026-03-13", "2026-04-03", "2026-04-24"];
  const markAssignment = makeTask({
    type: "routine", title: "Mark assignment", parentId: course.id, color: "blue",
    recurrence: { days: [5], time: "17:00", durationMin: 60, start: "2026-01-16", end: "2026-05-01" },
  });
  expandOccurrences(markAssignment)
    .filter(o => !assignmentFridays.includes(o.date))
    .forEach(o => { markAssignment.exceptions[o.date] = null; });
  expandOccurrences(markAssignment).slice(0, 2).forEach(o => { markAssignment.log[o.date] = "done"; });

  const midterm = makeTask({
    type: "event", title: "Midterm exam", parentId: course.id, color: "blue",
    start: "2026-03-09T10:00", end: "2026-03-09T12:00", location: "Hall A",
  });
  const final = makeTask({
    type: "event", title: "Final exam", parentId: course.id, color: "blue",
    start: "2026-05-04T09:00", end: "2026-05-04T11:00", location: "Hall A",
  });

  // --- Paper (finite container) — "violet": Review done, Design done, Experiment not ---
  const paper = makeTask({
    type: "finite", title: "CHI paper", color: "violet", priority: "high", deadline: "2026-04-01",
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
    start: "2026-02-03T14:00", end: "2026-02-03T15:00", location: "Room 4.12",
  });

  state.tasks.push(course, slides, markAssignment, midterm, final, paper, review, design, experiment, meeting);

  // --- Planner slots (the 2h block exercises D30 multi-length rendering in Step 5) ---
  state.slots.push(
    makeSlot({ date: "2026-01-12", start: "09:00", taskId: slides.id }),
    makeSlot({ date: "2026-01-13", start: "19:00", taskId: review.id }),
    makeSlot({ date: "2026-01-14", start: "14:00", durationMin: 120, taskId: experiment.id }),
  );

  return state;
}
