// State schema & record factories (Ledger v2 data layer).
// Field names/types/defaults are locked in docs/03_DOMAIN_CONSTANTS.md Part A — do not re-derive here.

export const TASK_TYPES = ["finite", "routine", "event"];
export const PRIORITIES = ["low", "med", "high"];

// Task-colour palette (03 Part B, verbatim) — the single source for JS; keys MUST match
// the CSS var suffixes in css/styles.css (--tc-<name> / --tc-<name>-wash).
export const TASK_COLORS = {
  slate:  { solid: "#5B6570", wash: "rgba(91,101,112,.14)" },
  teal:   { solid: "#2E8B70", wash: "rgba(46,139,112,.14)" },
  amber:  { solid: "#B7822B", wash: "rgba(183,130,43,.15)" },
  blue:   { solid: "#3C6E9E", wash: "rgba(60,110,158,.14)" },
  green:  { solid: "#5E8C3C", wash: "rgba(94,140,60,.15)" },
  coral:  { solid: "#C4633F", wash: "rgba(196,99,63,.14)" },
  rose:   { solid: "#B24A6A", wash: "rgba(178,74,106,.14)" },
  violet: { solid: "#6C5AA6", wash: "rgba(108,90,166,.15)" },
};

export const TASK_COLOR_NAMES = Object.keys(TASK_COLORS);

export const DEFAULT_COLOR = { finite: "slate", routine: "teal", event: "amber" };

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function makeAppState() {
  return {
    version: 1,
    tasks: [],
    slots: [],
    settings: { providerType: "local", sheetUrl: "" },
  };
}

export function makeTask({
  type,
  title,
  parentId = null,
  priority = "low",
  weight = 1,
  color,
  notes = "",
  createdAt = Date.now(),
  completedAt = null,
  deadline = null,
  done = false,
  recurrence = null,
  log = {},
  exceptions = {},
  allDay = false,
  start = null,
  end = null,
  location = "",
} = {}) {
  return {
    id: uid(),
    type,
    title,
    owner: "me",
    parentId,
    priority,
    weight,
    color: color ?? DEFAULT_COLOR[type],
    notes,
    createdAt,
    completedAt,
    deadline,
    done,
    recurrence,
    log,
    exceptions,
    allDay,
    start,
    end,
    location,
  };
}

// D30: a Slot has a LENGTH at 30-min granularity — start:"HH:mm" + durationMin (default 60).
// The old integer `hour` field is gone; migrate() maps legacy hour -> start:"HH:00",durationMin:60.
export function makeSlot({ date, start, durationMin = 60, taskId } = {}) {
  return {
    id: uid(),
    owner: "me",
    date,
    start,
    durationMin,
    taskId,
  };
}

// Upgrades a legacy v1 blob ({tasks:[{id,title,due,pri,done,parentId,createdAt}],slots:[{id,date,hour,taskId}]})
// to the current v2 AppState. Already-current state (version >= 1) is left untouched (idempotent).
export function migrate(state) {
  if (state && typeof state.version === "number" && state.version >= 1) {
    return state;
  }

  const src = state || {};

  const tasks = (src.tasks || []).map((t) => ({
    id: t.id,
    type: "finite",
    title: t.title,
    owner: "me",
    parentId: t.parentId ?? null,
    priority: t.priority ?? t.pri ?? "low",
    weight: typeof t.weight === "number" ? t.weight : 1,
    color: t.color ?? DEFAULT_COLOR.finite,
    notes: t.notes ?? "",
    createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
    completedAt: t.completedAt ?? null,
    deadline: t.deadline ?? (t.due || null),
    done: !!t.done,
    recurrence: null,
    log: {},
    exceptions: {},
    allDay: false,
    start: null,
    end: null,
    location: "",
  }));

  // D30: a legacy/pre-D30 slot carries integer `hour` -> start:"HH:00" (zero-padded),
  // durationMin:60; a slot already carrying `start` is left as-is.
  const slots = (src.slots || []).map((s) => {
    const hasStart = typeof s.start === "string";
    return {
      id: s.id,
      owner: "me",
      date: s.date,
      start: hasStart ? s.start : String(s.hour).padStart(2, "0") + ":00",
      durationMin: hasStart ? s.durationMin : 60,
      taskId: s.taskId,
    };
  });

  return {
    version: 1,
    tasks,
    slots,
    settings: src.settings ?? { providerType: "local", sheetUrl: "" },
  };
}
