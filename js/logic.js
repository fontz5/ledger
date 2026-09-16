// Pure logic functions (Ledger v2 data layer).
// Algorithms are locked in docs/03_DOMAIN_CONSTANTS.md Part A — do not re-derive here.
// No imports, no DOM, no storage: everything is passed in as plain arrays/objects.

export function childrenOf(tasks, id) {
  return tasks.filter(t => t.parentId === id);
}

// Returns array of { date:"YYYY-MM-DD", time, durationMin, ...override } within [start, end], inclusive.
// Consults node.exceptions (D36): a date mapped to null is CANCELLED (skipped entirely); an object
// overrides just that occurrence's fields. Works for routines AND recurring events — both carry
// `recurrence` + `exceptions`. With the default `exceptions:{}` this is byte-for-byte the old behaviour.
export function expandOccurrences(node) {
  const r = node.recurrence;
  if (!r) return [];
  const exc = node.exceptions || {};
  const out = [];
  const end = new Date(r.end + 'T00:00:00');
  let d = new Date(r.start + 'T00:00:00');
  while (d <= end) {
    if (r.days.includes(d.getDay())) {
      const date = d.toLocaleDateString('en-CA');
      const ov = exc[date];                     // undefined = no override, null = cancelled, object = overrides
      if (ov !== null) out.push({ date, time: r.time, durationMin: r.durationMin, ...(ov || {}) });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Status of a single occurrence; default "planned" if not in the log.
export function occurrenceStatus(routine, dateISO) {
  return (routine.log && routine.log[dateISO]) || 'planned';
}

// tasks: full Task[]; node: a Task. Returns 0..100 or null (event).
// `seen` is the D24 cycle guard — callers never pass it.
export function progressOf(tasks, node, seen = new Set()) {
  if (node.type === 'event') return null;

  if (node.type === 'routine') {
    const occ = expandOccurrences(node);
    if (occ.length === 0) return 0;
    const done = occ.filter(o => occurrenceStatus(node, o.date) === 'done').length;
    return Math.round((100 * done) / occ.length);
  }

  if (seen.has(node.id)) return 0;   // cycle (D24): contribute nothing, never crash
  seen.add(node.id);

  // finite:
  const kids = childrenOf(tasks, node.id).filter(k => k.type !== 'event');
  if (kids.length === 0) return node.done ? 100 : 0;          // finite leaf

  let totalW = 0, acc = 0;                                     // finite container
  for (const k of kids) {
    const w = (typeof k.weight === 'number' ? k.weight : 1);
    totalW += w;
    acc += w * progressOf(tasks, k, seen);
  }
  return totalW === 0 ? 0 : Math.round(acc / totalW);
}

// Returns { deliverablesPct:0..100|null, sessionsDone:int, sessionsTotal:int }
export function breakdownOf(tasks, node) {
  const kids = childrenOf(tasks, node.id);
  const finite = kids.filter(k => k.type === 'finite');
  const routines = kids.filter(k => k.type === 'routine');

  let dPct = null;
  if (finite.length) {
    let tw = 0, a = 0;
    for (const k of finite) { const w = k.weight ?? 1; tw += w; a += w * progressOf(tasks, k); }
    dPct = tw ? Math.round(a / tw) : 0;
  }
  let done = 0, total = 0;
  for (const r of routines) {
    const occ = expandOccurrences(r);
    total += occ.length;
    done += occ.filter(o => occurrenceStatus(r, o.date) === 'done').length;
  }
  return { deliverablesPct: dPct, sessionsDone: done, sessionsTotal: total };
}

export function effectiveDone(tasks, node, seen = new Set()) {
  if (node.type === 'event') return false;
  if (node.type === 'routine') {
    const occ = expandOccurrences(node);
    return occ.length > 0 && occ.every(o => occurrenceStatus(node, o.date) === 'done');
  }
  if (seen.has(node.id)) return false;   // cycle (D24): never claim done from broken data
  seen.add(node.id);
  const kids = childrenOf(tasks, node.id).filter(k => k.type !== 'event');
  return kids.length ? kids.every(k => effectiveDone(tasks, k, seen)) : node.done;
}

// Returns "none" | "partial" | "done", or null for an event (no progress, D20).
export function completionState(tasks, node) {
  if (node.type === 'event') return null;
  if (effectiveDone(tasks, node)) return 'done';   // NOT pct===100 — rounding lies (199/200 → 100)
  return progressOf(tasks, node) > 0 ? 'partial' : 'none';
}

// Overdue (D31): pure, LEAF-ONLY — a finite task whose own `deadline` is strictly before
// `today` and is not effectively done. It never climbs the tree: a container is NOT overdue
// because a child is. Events and routines are never overdue. `today` is passed in as a local
// "YYYY-MM-DD" (caller derives it with toLocaleDateString('en-CA'), never toISOString()).
export function isOverdue(tasks, node, today) {
  if (node.type !== 'finite') return false;      // events dated, routines occurrence-based
  if (!node.deadline) return false;              // no deadline can't be overdue
  if (effectiveDone(tasks, node)) return false;  // done (or all children done) is never overdue
  return node.deadline < today;                  // "YYYY-MM-DD" < "YYYY-MM-DD" is a valid lexical compare
}

// Guards a Recurrence rule before it is used to build/save a routine. Returns the FIRST
// failure (days -> time -> duration -> window), never a joined list. Pure; no defaults
// applied — the caller (the routine form, 3.U1) owns what the user typed.
export function validateRecurrence(rec) {
  if (!Array.isArray(rec.days) || rec.days.length < 1 ||
      !rec.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return { ok: false, error: 'Pick at least one weekday.' };
  }
  if (typeof rec.time !== 'string' || !/^([01]\d|2[0-3]):(00|30)$/.test(rec.time)) {
    return { ok: false, error: 'Start time must be on a 30-minute boundary.' };
  }
  if (!Number.isInteger(rec.durationMin) || rec.durationMin <= 0 || rec.durationMin % 30 !== 0) {
    return { ok: false, error: 'Length must be a positive multiple of 30 minutes.' };
  }
  if (typeof rec.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec.start) ||
      typeof rec.end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec.end) ||
      rec.start > rec.end) {
    return { ok: false, error: 'Window end must be on or after the start.' };
  }
  return { ok: true };
}

export const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A --mono-friendly human label for the detail popup. Assumes rec is already valid
// (the form calls validateRecurrence first). Pure.
export function recurrenceSummary(rec) {
  const days = [...rec.days].sort((a, b) => a - b).map(d => WEEKDAY_ABBR[d]).join(', ');
  const time = rec.time;
  const h = Math.floor(rec.durationMin / 60);
  const m = rec.durationMin % 60;
  const dur = m === 0 ? `${h}h` : h === 0 ? `${m}m` : `${h}h${m}`;
  const window = `${rec.start} – ${rec.end}`;
  return `${days} · ${time} · ${dur} · ${window}`;
}

// Guards an event's own time fields before create/save (4.U1). D41: a recurring event's
// start/end are null and irrelevant here, so a set recurrence delegates to validateRecurrence
// verbatim (same messages as 3.R1 — never re-derived). Otherwise checks the all-day
// (date-only) or timed (datetime-local) shape depending on `allDay`. Pure; no Date math —
// ISO YYYY-MM-DD[THH:mm] sorts lexically in chronological order.
export function validateEventTimes(ev) {
  if (ev.recurrence) {
    return validateRecurrence(ev.recurrence);
  }
  if (ev.allDay) {
    if (typeof ev.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.start) ||
        typeof ev.end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.end)) {
      return { ok: false, error: 'Start and end dates must be valid.' };
    }
    if (ev.start > ev.end) {
      return { ok: false, error: 'End date must be on or after the start date.' };
    }
    return { ok: true };
  }
  const TIMED_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof ev.start !== 'string' || !TIMED_RE.test(ev.start) ||
      typeof ev.end !== 'string' || !TIMED_RE.test(ev.end)) {
    return { ok: false, error: 'Start and end must be valid dates/times.' };
  }
  if (ev.start >= ev.end) {
    return { ok: false, error: 'End must be after start.' };
  }
  return { ok: true };
}

// A human label for the event detail popup's "When" row (supersedes the old bare
// eventDateLabel string-slice in js/views/tasks.js). Assumes ev is already valid (the form
// validates first via validateEventTimes). Pure; plain string slicing, never toISOString.
export function eventSummary(ev) {
  if (ev.recurrence) {
    return recurrenceSummary(ev.recurrence) + (ev.allDay ? ' · all day' : '');
  }
  if (ev.allDay) {
    return ev.start === ev.end ? `${ev.start} (all day)` : `${ev.start} – ${ev.end} (all day)`;
  }
  if (ev.start.slice(0, 10) === ev.end.slice(0, 10)) {
    return `${ev.start.slice(0, 10)} ${ev.start.slice(11)}–${ev.end.slice(11)}`;
  }
  return `${ev.start.replace('T', ' ')} – ${ev.end.replace('T', ' ')}`;
}

// Patches one occurrence's fields for a recurring event's "This occurrence" edit (4.U3).
// Writes ONLY `exceptions` — never `recurrence`/`log`/`start`/`end`. No-op on a non-event,
// non-recurring, or nonexistent id, and on a `dateISO` that isn't a LIVE occurrence of the
// rule right now (mirrors setOccurrenceStatus's guard) — an already-cancelled date is dropped
// by expandOccurrences, so this same guard also stops an override call from silently
// un-cancelling it; that must be done explicitly instead.
export function overrideEventOccurrence(tasks, id, dateISO, patch) {
  const t = tasks.find(x => x.id === id);
  if (!t || t.type !== 'event' || !t.recurrence) return;
  if (!expandOccurrences(t).some(o => o.date === dateISO)) return;
  const existing = t.exceptions[dateISO];
  t.exceptions[dateISO] = (existing && typeof existing === 'object')
    ? { ...existing, ...patch }
    : { ...patch };
}

// Cancels one occurrence of a recurring event (4.U2's row Cancel / 4.U3's "This occurrence"
// delete). Writes ONLY `exceptions`. Same guards/no-ops as overrideEventOccurrence.
export function cancelEventOccurrence(tasks, id, dateISO) {
  const t = tasks.find(x => x.id === id);
  if (!t || t.type !== 'event' || !t.recurrence) return;
  if (!expandOccurrences(t).some(o => o.date === dateISO)) return;
  t.exceptions[dateISO] = null;
}

// Delete a task and everything that depends on it (01 acceptance: "Deleting a task deletes
// its descendants and any slots referencing them"; 05 §2.U4 sub-step 3). PURE: returns new
// {tasks, slots} arrays — the caller swaps them into state; the inputs are not mutated. It
// collects the id plus every transitive descendant (cycle-guarded, D24), then drops each
// task in that set and each slot whose taskId points into it, leaving no orphan
// parentId/taskId.
export function deleteCascade(tasks, slots, id) {
  const doomed = new Set();
  (function collect(tid) {
    if (doomed.has(tid)) return;                 // cycle guard (D24)
    doomed.add(tid);
    for (const k of childrenOf(tasks, tid)) collect(k.id);
  })(id);
  return {
    tasks: tasks.filter(t => !doomed.has(t.id)),
    slots: slots.filter(s => !doomed.has(s.taskId)),
  };
}

// One row per occurrence for the routine detail/check-off UI (01 acceptance, 3.U2).
// Composes expandOccurrences + occurrenceStatus; a cancelled date (exceptions[d] === null)
// never appears here — expandOccurrences already dropped it. Pure.
export function occurrencesWithStatus(node) {
  return expandOccurrences(node).map(o => ({ ...o, status: occurrenceStatus(node, o.date) }));
}

// Writes ONLY `log` — never `exceptions`/`done`/anything else. "moved" is a status
// annotation on the original rule date (D40), not a relocation. No-op on a non-routine id
// or a `dateISO` that is not a LIVE occurrence of the rule right now (guards against
// writing a stray/cancelled-date key — a cancelled occurrence must stay out of the
// denominator, D36). `status:"planned"` resets by deleting the key.
export function setOccurrenceStatus(tasks, id, dateISO, status) {
  const t = tasks.find(x => x.id === id);
  if (!t || t.type !== 'routine') return;
  if (!expandOccurrences(t).some(o => o.date === dateISO)) return;
  if (status === 'planned') {
    delete t.log[dateISO];
  } else {
    t.log[dateISO] = status;
  }
}

// `done` is a FINITE-ONLY field (D25). The cascade touches finite tasks and nothing
// else: it skips routines (their completion lives in `log`, one occurrence at a time —
// a parent tick must never bulk-close future sessions) and events (D23). It never
// writes a `done` flag that no reader consumes.
export function setDoneCascade(tasks, id, value, seen = new Set()) {
  const t = tasks.find(x => x.id === id);
  if (!t || t.type !== 'finite') return;
  if (seen.has(id)) return;              // cycle (D24)
  seen.add(id);
  t.done = value;
  t.completedAt = value ? Date.now() : null;
  for (const k of childrenOf(tasks, id)) {
    if (k.type === 'finite') setDoneCascade(tasks, k.id, value, seen);
  }
}
