// Storage layer & providers (PIN v2 data layer).
// Contract locked in docs/03_DOMAIN_CONSTANTS.md Part A ("Storage layer") and Part C ("Storage interface").
// This is the ONLY module allowed to touch localStorage or fetch().

import { makeAppState, migrate } from "./state.js";

// FROZEN (D44): the app is named PIN, but these four key strings stay `ledger.*` forever —
// renaming one makes the app read a key nobody has ever written, stranding every existing
// user's data under the old name (the D29 failure mode). They are invisible to the user.
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

// Real network client, built against the D26 contract (03 Part C). `authenticate`/`load`/`save` are
// all real as of 6.P1/6.P2/6.P3. `fetch` is injectable (constructor option) so this is unit-testable
// without a real network call — Google is unreachable from this dev container.
export class SheetsProvider extends StorageProvider {
  constructor({ execUrl, token, fetch: fetchImpl } = {}) {
    super();
    this.execUrl = execUrl;
    this.token = token;
    // .bind(globalThis): native fetch is a WindowOrWorkerGlobalScope method, and calling it later
    // as `this._fetch(...)` invokes it with `this` = the SheetsProvider instance, not the global
    // object. Chrome tolerates that; Safari/WebKit throws "TypeError: Illegal invocation" for the
    // wrong receiver — silently, since it's caught by this class's own try/catch, so the failure
    // never even reaches the network (found via a real Safari session in 6.U-INT). A test-injected
    // mock `fetchImpl` is an ordinary function with no receiver enforcement, so it's unaffected.
    this._fetch = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  }
  // Never throws (03 Part C): a thrown/network error or {ok:false,...} both resolve false.
  // On {ok:true,...}, remembers the accepted token as this.token.
  async authenticate(passphrase) {
    const token = passphrase ?? this.token;
    try {
      const res = await this._fetch(this.execUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "load", token }),
      });
      const body = await res.json();
      if (!body || body.ok !== true) return false;
      this.token = token;
      return true;
    } catch {
      return false;
    }
  }
  // Returns exactly {version, tasks, slots} — NEVER a full AppState; `settings` is caller-supplied
  // (D26 rule 4 / D43: Sheets never carries `settings`). Throws on {ok:false,...} or a malformed
  // reply (missing/non-array tasks/slots) — never hands back a partial/empty result silently.
  async load() {
    const res = await this._fetch(this.execUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "load", token: this.token }),
    });
    const body = await res.json();
    if (!body || body.ok !== true || !Array.isArray(body.tasks) || !Array.isArray(body.slots)) {
      throw new Error((body && body.error) || "SheetsProvider.load: malformed response");
    }
    return { version: body.version, tasks: body.tasks, slots: body.slots };
  }
  // Client-side guard BEFORE calling fetch (defense in depth on top of 6.S3's server-side D26 rule 2
  // check): tasks/slots must be arrays or this throws locally without sending a request. Never sends
  // state.settings (D26 rule 4 / D43). {ok:true} -> true; {ok:false,error} -> throws that message.
  async save(state) {
    if (!Array.isArray(state.tasks) || !Array.isArray(state.slots)) {
      throw new Error("SheetsProvider.save: state.tasks/state.slots must be arrays");
    }
    const res = await this._fetch(this.execUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "save",
        token: this.token,
        version: state.version,
        tasks: state.tasks,
        slots: state.slots,
      }),
    });
    const body = await res.json();
    if (!body || body.ok !== true) {
      throw new Error((body && body.error) || "SheetsProvider.save: save failed");
    }
    return true;
  }
}
