// Pure logic functions (PIN v2 data layer).
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

// Overlap lane assignment for one day's worth of items (D32): overlapping items get
// side-by-side lanes instead of stacking/hiding. Non-overlapping items get lane:0,
// laneCount:1. An item ending exactly when another starts is NOT an overlap (05_TASKS_STEP5
// 5.L1). Input order/extra fields are preserved on output.
export function layoutDay(items) {
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const sorted = items.map(it => ({ ...it, _s: toMin(it.start), _e: toMin(it.start) + it.durationMin }))
                       .sort((a, b) => a._s - b._s || a._e - b._e);
  const active = [];   // {_e, lane} currently open
  let cluster = [], clusterMax = 0;
  const flush = () => { for (const it of cluster) it.laneCount = clusterMax; cluster = []; clusterMax = 0; };
  for (const it of sorted) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i]._e <= it._s) active.splice(i, 1);
    if (active.length === 0 && cluster.length) flush();
    const used = new Set(active.map(a => a.lane));
    let lane = 0; while (used.has(lane)) lane++;
    it.lane = lane;
    active.push({ _e: it._e, lane });
    cluster.push(it);
    clusterMax = Math.max(clusterMax, active.length);
  }
  flush();
  return sorted.map(({ _s, _e, ...rest }) => rest);
}

// Every finite task carrying a deadline that isn't effectively done yet (leaf or container —
// the schema doesn't restrict `deadline` to leaves). Sorted by deadline date ascending (soonest
// calendar date first — see 05_TASKS_STEP5 "daysUntil sort order" scope note).
export function deadlineCountdown(tasks, today) {
  const toMin = d => new Date(d + 'T00:00:00').getTime();
  return tasks
    .filter(t => t.type === 'finite' && t.deadline && !effectiveDone(tasks, t))
    .map(t => ({
      id: t.id, title: t.title, deadline: t.deadline, color: t.color,
      daysUntil: Math.round((toMin(t.deadline) - toMin(today)) / 86400000),
    }))
    .sort((a, b) => a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0);
}

// Month grid (D21/D35): 7 columns always, Sunday on/before the 1st through Saturday on/after
// the last day of the month, 4-6 rows depending on the month. `month` is 0-11 (JS Date
// convention). No Date objects on cells — output is plain {date, inMonth, isToday}.
export function monthMatrix(year, month, todayISO) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const start = new Date(year, month, 1 - first.getDay());
  const end = new Date(year, month, last.getDate() + (6 - last.getDay()));
  const weeks = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      const date = cursor.toLocaleDateString('en-CA');
      row.push({ date, inMonth: cursor.getMonth() === month, isToday: date === todayISO });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

// Runway highlight (D35): `yellow` runs from todayISO up to (not including) deadlineISO,
// inclusive of todayISO; `red` is deadlineISO itself. Already-overdue deadlines get no
// runway (yellow: []) but still flag red.
export function runwayDates(todayISO, deadlineISO) {
  if (deadlineISO < todayISO) return { yellow: [], red: deadlineISO };
  const toDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const yellow = [];
  let cursor = toDate(todayISO);
  const end = toDate(deadlineISO);
  while (cursor < end) {
    yellow.push(cursor.toLocaleDateString('en-CA'));
    cursor.setDate(cursor.getDate() + 1);
  }
  return { yellow, red: deadlineISO };
}

// The single place that answers "what touches this date" — consumed by Month (dot counts) and
// Day/Week (grid blocks + banner) so both surfaces agree by construction (05_TASKS_STEP5 5.L4).
export function itemsOnDate(tasks, slots, dateISO) {
  const deadlines = tasks.filter(t => t.type === 'finite' && t.deadline === dateISO);
  const routineOccurrences = [];
  const eventOccurrences = [];
  for (const t of tasks) {
    if (t.type === 'routine' && t.recurrence) {
      for (const o of expandOccurrences(t)) if (o.date === dateISO)
        routineOccurrences.push({ taskId: t.id, date: o.date, time: o.time, durationMin: o.durationMin,
                                   status: occurrenceStatus(t, o.date) });
    }
    if (t.type === 'event') {
      if (t.recurrence) {
        for (const o of expandOccurrences(t)) if (o.date === dateISO)
          eventOccurrences.push({ taskId: t.id, date: o.date, time: o.time, durationMin: o.durationMin,
                                   allDay: !!t.allDay });
      } else if (t.start) {
        const s = t.start.slice(0, 10), e = (t.end || t.start).slice(0, 10);
        if (dateISO >= s && dateISO <= e)
          eventOccurrences.push({ taskId: t.id, date: dateISO, start: t.start, end: t.end, allDay: !!t.allDay });
      }
    }
  }
  return { deadlines, routineOccurrences, eventOccurrences, slots: slots.filter(s => s.date === dateISO) };
}

// Guards a Slot's own start/duration before create/move/resize (D30 snap/bounds, 05_TASKS_STEP5
// 5.L5). Returns the FIRST failure (boundary -> multiple-of-30 -> floor -> ceiling), never a
// joined list. Pure; no Date math (string boundary regex + integer minutes only).
export function validateSlotTimes(slot) {
  if (typeof slot.start !== 'string' || !/^([01]\d|2[0-3]):(00|30)$/.test(slot.start)) {
    return { ok: false, error: 'Start must be on a 30-minute boundary.' };
  }
  if (!Number.isInteger(slot.durationMin) || slot.durationMin <= 0 || slot.durationMin % 30 !== 0) {
    return { ok: false, error: 'Duration must be a positive multiple of 30 minutes.' };
  }
  const [h, m] = slot.start.split(':').map(Number);
  const startMin = h * 60 + m;
  if (startMin < 360) {
    return { ok: false, error: 'Start must be at or after 06:00.' };
  }
  if (startMin + slot.durationMin > 1320) {
    return { ok: false, error: 'A block cannot extend past 22:00.' };
  }
  return { ok: true };
}

// Pure move/resize: return a NEW candidate Slot (never mutate) plus the validation result. The
// caller (5.G3's form, 5.X1's drag handler) applies the result — these never write to
// tasks/slots themselves.
export function moveSlot(slot, newDate, newStart) {
  const candidate = { ...slot, date: newDate, start: newStart };
  const v = validateSlotTimes(candidate);
  return v.ok ? { ok: true, slot: candidate } : v;
}

export function resizeSlot(slot, newDurationMin) {
  const candidate = { ...slot, durationMin: newDurationMin };
  const v = validateSlotTimes(candidate);
  return v.ok ? { ok: true, slot: candidate } : v;
}

// D45 / 7.U2: resolve ONE task to the marker a view should draw. Returns a discriminated
// { kind:"emoji"|"color", value } — `kind` says which of the two the caller got, `value` is the
// glyph or the palette NAME (never a hex: mapping a name through TASK_COLORS is the caller's job,
// which is what keeps this module import-free). Fallback is strict: emoji mode AND a non-empty
// mapping for that category, otherwise the colour wins. The map is keyed by the 8 palette names,
// so no Task record carries an emoji and nothing is migrated. Never throws on a missing
// prefs/prefs.emoji/task.color.
export function markerFor(task, prefs) {
  const color = (task && task.color) || null;
  const p = prefs || {};
  if (p.marker === 'emoji' && color) {
    const glyph = (p.emoji || {})[color];
    if (typeof glyph === 'string' && glyph !== '') return { kind: 'emoji', value: glyph };
  }
  return { kind: 'color', value: color };
}

// 7.X1: serialise a PORTABLE state to JSON text. Pure — no DOM, no storage, no imports.
// `settings` is deliberately NOT carried: it holds the Sheets exec URL and the sync token, and an
// exported file is a file the user will email or back up (golden rule 6 / 03 Part C). What travels
// is exactly the user's data plus their display preferences: version, tasks, slots, prefs (D45).
// Pretty-printed because a human may open the file; `parseImportedState` accepts either form.
export function exportState(state) {
  const s = state || {};
  return JSON.stringify(
    {
      version: s.version ?? 1,
      tasks: s.tasks || [],
      slots: s.slots || [],
      prefs: s.prefs || { marker: 'color', emoji: {} },
    },
    null,
    2
  );
}

// 7.U5: normalise whatever the user typed or pasted into the Sheets exec-URL field into the ONE
// canonical Apps Script exec URL. Accepts either the full `/exec` URL or the bare deployment id
// inside it, so a phone user handles ~57 characters instead of ~110. Pure — no DOM, no storage,
// no imports — and returns the same `{ok:true, ...}` / `{ok:false, error}` shape
// `validateSlotTimes` uses. The shape and the rejection rules are 03 Part C, "Exec URL shape";
// nothing here is re-derived.
export const EXEC_URL_BASE = 'https://script.google.com/macros/s/';
export const EXEC_URL_SUFFIX = '/exec';

// A deployment id is base64url. The 30-character floor is 03 Part C's: comfortably under a real
// id (~57) and above anything typed by accident, so junk is rejected instead of being turned into
// a plausible-looking endpoint that only fails later at Connect.
const EXEC_URL_RE = /^https?:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]+)\/exec\/?(?:[?#].*)?$/;
const DEPLOYMENT_ID_RE = /^[A-Za-z0-9_-]{30,}$/;

export function normalizeExecUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') {
    return { ok: false, error: 'Enter the deployment ID or the full /exec URL.' };
  }
  const m = EXEC_URL_RE.exec(raw);
  const id = m ? m[1] : (DEPLOYMENT_ID_RE.test(raw) ? raw : null);
  if (id === null) {
    return { ok: false, error: 'That is not an Apps Script deployment ID or /exec URL.' };
  }
  return { ok: true, id, url: EXEC_URL_BASE + id + EXEC_URL_SUFFIX };
}

// ---- 7.U4 / D47: a checked finite task lingers, then hides ----

// The grace delays, in ms. D47 fixes the BEHAVIOUR ("a few seconds", "a longer delay for a
// container") but no number, and 03 carries no timing constant of any kind, so the two values
// live here as named exports rather than as literals buried in the view. A container gets
// double, because checking one hides its whole subtree at once (D47 constraint 2).
export const HIDE_DELAY_MS = 5000;
export const HIDE_DELAY_CONTAINER_MS = 10000;

// True when `ev` still has a date on or after `today` — something the user has yet to attend.
// A pending event is what keeps its container on the tree (D47 amendment, 2026-09-29).
// One-off: its `end` (or `start`) date. Recurring: its LAST live occurrence — D41 puts a recurring
// event's window in `recurrence` and leaves its own start/end null, and D36 cancellations are
// already out of expandOccurrences, so a fully-cancelled series is not pending.
// Deliberately conservative on bad data: an undated event, or a call with no `today`, counts as
// PENDING. The cost of that is a container that stays on screen; the cost of the other default is
// a future exam silently disappearing, which is what this predicate exists to prevent.
// Lexical "YYYY-MM-DD" compare throughout — never a Date round-trip, never toISOString().
export function eventIsPending(ev, today) {
  if (!ev || ev.type !== 'event') return false;
  if (typeof today !== 'string' || today === '') return true;
  if (ev.recurrence) {
    const occ = expandOccurrences(ev);
    if (occ.length === 0) return false;
    return occ.reduce((max, o) => (o.date > max ? o.date : max), occ[0].date) >= today;
  }
  const last = ev.end || ev.start;
  if (typeof last !== 'string' || last === '') return true;
  return last.slice(0, 10) >= today;
}

// True when any DESCENDANT of `node` is a pending event (D47 amendment). Monotone upward: if a
// node is blocked, every ancestor of it is blocked too, which is what lets the view stop at the
// first blocked ancestor when it picks a grace-window subject.
export function hasPendingEvent(tasks, node, today, seen = new Set()) {
  if (seen.has(node.id)) return false;         // cycle guard (D24)
  seen.add(node.id);
  for (const k of childrenOf(tasks, node.id)) {
    if (k.type === 'event' && eventIsPending(k, today)) return true;
    if (hasPendingEvent(tasks, k, today, seen)) return true;
  }
  return false;
}

// True when `node` must be left out of the Tasks tree (D47). RENDER-ONLY: no caller of this
// writes state, and progressOf/breakdownOf/effectiveDone keep counting a hidden task because
// they read the tasks array and never the DOM — so every percentage is identical either way.
// FINITE ONLY: a routine at full progress is `effectiveDone` too, so it is the TYPE guard —
// not effectiveDone — that keeps D47 constraint 1 ("routines and events never hide") true.
// D47 amendment (2026-09-29): the type guard alone was not enough. `effectiveDone` excludes
// events from the roll-up, so a container reads "done" while an exam is still months away — and
// hiding it took the exam off the tree too. A container with a PENDING event in its subtree
// therefore stays; once every event under it is past, it hides normally. Routines are correctly
// NOT covered: a container only becomes effectiveDone when every occurrence of every routine
// under it is done, so a hidden routine is a genuinely finished one.
// An overdue task can never be hidden here for free: isOverdue requires !effectiveDone and
// this requires effectiveDone, so D31's pinned section is untouched.
// `today` is a local "YYYY-MM-DD" from the caller (toLocaleDateString('en-CA')), exactly as
// isOverdue takes it. `lingering` is the set of ids still inside their grace window (anything
// with `.has(id)`); a lingering node keeps its WHOLE SUBTREE on screen, so a checked container
// never half-vanishes while its cancel affordance is still showing.
export function isCompletedHidden(tasks, node, today, lingering = new Set()) {
  if (node.type !== 'finite') return false;
  if (!effectiveDone(tasks, node)) return false;
  if (hasPendingEvent(tasks, node, today)) return false;
  const seen = new Set();
  let cur = node;
  while (cur && !seen.has(cur.id)) {           // cycle guard (D24)
    if (lingering.has(cur.id)) return false;
    seen.add(cur.id);
    cur = cur.parentId === null ? null : tasks.find(t => t.id === cur.parentId);
  }
  return true;
}

// The `completedAt` to order a hidden node by. setDoneCascade stamps `completedAt` on every
// finite task it touches, but a CONTAINER that became effectively done because its last child
// was checked was never itself checked, so its own stamp is null — fall back to the newest
// stamp in its finite subtree. Returns null when nothing in the subtree carries one.
export function completedAtOf(tasks, node, seen = new Set()) {
  if (seen.has(node.id)) return null;          // cycle guard (D24)
  seen.add(node.id);
  let best = typeof node.completedAt === 'number' ? node.completedAt : null;
  for (const k of childrenOf(tasks, node.id)) {
    if (k.type !== 'finite') continue;
    const kv = completedAtOf(tasks, k, seen);
    if (kv !== null && (best === null || kv > best)) best = kv;
  }
  return best;
}

// The "Show completed" list (D47): every hidden node whose PARENT is not itself hidden — the
// topmost hidden node of each hidden subtree, so a checked container appears ONCE and not once
// per descendant. Newest first by completedAt; an entry with no stamp anywhere in its subtree
// sorts last. Pure — returns the existing task records, ordered, and mutates nothing.
export function completedHiddenRoots(tasks, today, lingering = new Set()) {
  const hidden = t => isCompletedHidden(tasks, t, today, lingering);
  return tasks
    .filter(hidden)
    .filter(t => {
      if (t.parentId === null) return true;
      const p = tasks.find(x => x.id === t.parentId);
      return !p || !hidden(p);
    })
    .map(t => ({ task: t, at: completedAtOf(tasks, t) }))
    .sort((a, b) => {
      if (a.at === b.at) return 0;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return b.at - a.at;
    })
    .map(x => x.task);
}
