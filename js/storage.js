// Storage layer & providers (Ledger v2 data layer).
// Contract locked in docs/03_DOMAIN_CONSTANTS.md Part A ("Storage layer") and Part C ("Storage interface").
// This is the ONLY module allowed to touch localStorage or fetch().

import { makeAppState, migrate } from "./state.js";

export const STORAGE_KEY = "ledger.state"; // the single key holding the entire AppState blob
export const CORRUPT_SUFFIX = ".corrupt"; // <key>.corrupt preserves a blob we could not parse

// v1 (the single-file index.html) never wrote a combined blob — it persisted these three
// separate keys. These are read, never invented (03 Part A "Legacy v1 keys" / D29).
export const LEGACY_KEYS = {
  tasks: "ledger.tasks", // v1: Task[] — {id,title,due,pri,done,parentId,createdAt}
  slots: "ledger.slots", // v1: Slot[] — {id,date,hour,taskId}; migrate() maps hour -> start:"HH:00",durationMin:60 (D30)
  settings: "ledger.settings", // v1: {sheetUrl}
};

// Assembles a v1-shaped blob from the three legacy keys. Returns null if no legacy tasks exist.
// Read-only: it NEVER writes to, clears, or deletes a legacy key (D29) — they are the free rollback.
export function readLegacyV1() {
  // D37: a corrupt legacy key is "nothing to adopt", NOT a boot-blocker. Store.get preserves the raw
  // bytes under `<key>.corrupt` (D28 rule 2) before throwing, so catching here destroys nothing.
  try {
    const tasks = Store.get(LEGACY_KEYS.tasks, null);
    if (!Array.isArray(tasks) || tasks.length === 0) return null;
    return {
      tasks,
      slots: Store.get(LEGACY_KEYS.slots, []) ?? [],
      settings: Store.get(LEGACY_KEYS.settings, undefined),
      // no `version` key — that is what makes migrate() treat this as legacy.
    };
  } catch (e) {
    if (e instanceof StorageCorruptError) return null; // any corrupt legacy key aborts adoption entirely (all-or-nothing)
    throw e;
  }
}

export class StorageCorruptError extends Error {
  constructor(key, backupKey) {
    super(`stored data at "${key}" is not valid JSON; the raw blob was preserved at "${backupKey}"`);
    this.name = "StorageCorruptError";
    this.key = key;
    this.backupKey = backupKey;
  }
}

const _mem = {}; // key → serialized string. ONLY writes localStorage refused.
const _corrupt = new Set(); // keys whose stored blob failed to parse; write-locked until forced.

export const Store = {
  get(k, def) {
    if (k in _mem) return JSON.parse(_mem[k]); // a refused write always wins over a stale read
    let raw;
    try {
      raw = localStorage.getItem(k);
    } catch {
      return def; // storage unreachable, nothing buffered
    }
    if (raw == null) return def;
    try {
      return JSON.parse(raw);
    } catch {
      const backupKey = k + CORRUPT_SUFFIX; // never silently discard unreadable data
      try {
        localStorage.setItem(backupKey, raw);
      } catch {
        _mem[backupKey] = JSON.stringify(raw);
      }
      _corrupt.add(k);
      throw new StorageCorruptError(k, backupKey);
    }
  },
  set(k, v, { force = false } = {}) {
    if (_corrupt.has(k) && !force) {
      throw new StorageCorruptError(k, k + CORRUPT_SUFFIX); // refuse to overwrite a preserved blob
    }
    const json = JSON.stringify(v); // throws on a cyclic value: unstorable, say so
    try {
      localStorage.setItem(k, json);
      delete _mem[k]; // the real write landed; drop the buffered copy
    } catch {
      _mem[k] = json; // refused: buffer it, and `get` will prefer it
    }
    _corrupt.delete(k);
    return true;
  },
};

export class StorageProvider {
  // true if access granted. local: true (or check a cosmetic lock). sheets: verify token accepted.
  async authenticate(passphrase) {
    throw new Error("not implemented");
  }
  // returns an AppState (Part A), or a fresh empty state.
  async load() {
    throw new Error("not implemented");
  }
  // persists the full AppState. returns true on success.
  async save(state) {
    throw new Error("not implemented");
  }
}

export class LocalStorageProvider extends StorageProvider {
  async authenticate(passphrase) {
    return true;
  }
  // Throws StorageCorruptError if the stored blob is unparseable (D28.3). The caller must decide:
  // surface it, or start fresh via save(state, {force:true}). It must NOT be swallowed into an
  // empty state, because the next save would make that loss permanent.
  //
  // D29 adoption ordering, in this exact order (03 Part A "Legacy v1 keys"):
  //   1. STORAGE_KEY present -> return it; legacy keys are not even read.
  //   2. STORAGE_KEY absent + readLegacyV1() non-null -> migrate() it and return the result.
  //   3. Neither -> a fresh makeAppState().
  // `this.adopted` records which branch fired, so a caller (1.INT boot) can persist an
  // adopted state exactly once instead of re-saving on every load.
  async load() {
    const existing = Store.get(STORAGE_KEY, undefined); // throws StorageCorruptError; never caught here
    if (existing !== undefined) {
      this.adopted = false;
      return existing;
    }
    const legacy = readLegacyV1();
    if (legacy) {
      this.adopted = true;
      return migrate(legacy);
    }
    this.adopted = false;
    return makeAppState();
  }
  // force:true is the deliberate "discard the unreadable blob" action; the raw blob survives
  // under STORAGE_KEY + CORRUPT_SUFFIX regardless.
  async save(state, { force = false } = {}) {
    Store.set(STORAGE_KEY, state, { force });
    return true;
  }
}

// Stub only: methods present so callers can wire against the interface now,
// but real network I/O is deferred to Step 6 (D26 contract).
export class SheetsProvider extends StorageProvider {
  constructor({ execUrl, token } = {}) {
    super();
    this.execUrl = execUrl;
    this.token = token;
  }
  async authenticate(passphrase) {
    throw new Error("deferred to Step 6");
  }
  async load() {
    throw new Error("deferred to Step 6");
  }
  async save(state) {
    throw new Error("deferred to Step 6");
  }
}
