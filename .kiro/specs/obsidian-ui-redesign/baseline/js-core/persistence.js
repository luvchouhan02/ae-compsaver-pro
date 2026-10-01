// ============================================================
// core/persistence.js — validity-key gated persisted caches
// ------------------------------------------------------------
// Feature: save-import-performance-redesign
//
// Pure, dependency-injected persistence helpers for the CEP panel's
// persisted state. This file hosts the Metadata_Cache (expensive
// per-template metadata) and — as the redesign progresses — the
// Library_Index. Both are gated by a folder-derived "validity key"
// so the panel can decide whether a cached entry is still current
// WITHOUT rescanning template contents.
//
// Written in the same dual-load style as core/saveOrchestrator.js:
// bare globals for ExtendScript / CEP <script> inclusion, plus a
// CommonJS export tail so jest + fast-check can drive the pure logic
// without After Effects or a browser.
//
// Design references:
//   - Metadata_Cache: state.js (+ persistence helpers)
//   - Validity key: composite of mtime / size / entry-count
//   - Round-trip serialize()/parse() (Req 11.5)
//   - Corruption tolerance: malformed input => all entries missing (Req 11.6)
//   - Currency predicate: recorded key === current folder key (Req 11.7)
// ============================================================

// Bump when the on-disk cache shape changes.
var METADATA_CACHE_VERSION = 1;

// ── path normalization ─────────────────────────────────────────────
// Mirror state.js#normFolderPath so keys are stable regardless of the
// slash style / trailing slash a caller happens to pass in. Kept local
// so this module stays self-contained under jest (where state.js, which
// constructs a CSInterface at load, cannot be required).
function normalizeFolderPath(p) {
    return ("" + (p || "")).replace(/\\/g, "/").replace(/\/+$/, "");
}

// ── validity-key derivation ─────────────────────────────────────────
// A folder's validity key is a composite of its entry count, the summed
// byte size of its direct entries, and the newest mtime among the folder
// and its direct entries. Two folders with equal keys are treated as
// unchanged. This reads directory metadata only (readdir + stat); it does
// NOT open or parse any file contents (Req 11.7).
//
// `fsImpl` is injectable for tests; in the CEP runtime it defaults to the
// resolved Node fs via the global nfs() helper (core/node.js).
function deriveFolderValidityKey(folderPath, fsImpl) {
    var fs = fsImpl || (typeof nfs === "function" ? nfs() : null);
    if (!fs || typeof fs.readdirSync !== "function") return null;

    var dir = normalizeFolderPath(folderPath);
    if (!dir) return null;

    var names;
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        // Folder gone / unreadable — no derivable key. Callers treat a
        // null current key as "not current" (never equal to a recorded key).
        return null;
    }

    var count = names ? names.length : 0;
    var totalSize = 0;
    var maxMtime = 0;

    function foldMtime(st) {
        if (!st) return;
        var m = 0;
        if (typeof st.mtimeMs === "number") {
            m = st.mtimeMs;
        } else if (st.mtime && typeof st.mtime.getTime === "function") {
            m = st.mtime.getTime();
        }
        if (m > maxMtime) maxMtime = m;
    }

    for (var i = 0; i < count; i++) {
        var full = dir + "/" + names[i];
        var st = null;
        try {
            st = fs.statSync(full);
        } catch (e) {
            continue; // transient entry — skip, don't abort the whole key
        }
        if (st && typeof st.size === "number") totalSize += st.size;
        foldMtime(st);
    }

    // Fold the folder's own mtime so adds/removes that leave count/size
    // unchanged still move the key.
    try {
        foldMtime(fs.statSync(dir));
    } catch (e) {
        /* best-effort */
    }

    return count + ":" + totalSize + ":" + maxMtime;
}

// ── Metadata_Cache ──────────────────────────────────────────────────
// Persisted map: normalized folderPath -> { folderPath, validityKey, metadata }.
//
// opts:
//   fs        — injected Node fs (defaults to global nfs() at call time)
//   deriveKey — injected (folderPath) => key, overrides deriveFolderValidityKey
//   version   — on-disk schema version to stamp on serialize()
function MetadataCache(opts) {
    opts = opts || {};
    this._entries = {}; // folderPath -> entry
    this._fs = opts.fs || null;
    this._deriveKey = typeof opts.deriveKey === "function" ? opts.deriveKey : null;
    this.version = typeof opts.version === "number" ? opts.version : METADATA_CACHE_VERSION;
}

// Current validity key for a folder (no content rescan). Uses the injected
// deriveKey when provided, else deriveFolderValidityKey with the injected fs.
MetadataCache.prototype.currentKey = function (folderPath) {
    if (this._deriveKey) return this._deriveKey(normalizeFolderPath(folderPath));
    return deriveFolderValidityKey(folderPath, this._fs);
};

// True iff the folder has a recorded entry whose recorded validity key equals
// the folder's current validity key. Never rescans contents (Req 11.7,
// Property 30). A null/undefined current key (folder gone / unreadable) can
// never equal a recorded string key, so the entry is not current.
MetadataCache.prototype.isCurrent = function (folderPath) {
    var key = normalizeFolderPath(folderPath);
    var entry = this._entries[key];
    if (!entry) return false;
    var current = this.currentKey(key);
    if (current === null || current === undefined) return false;
    return entry.validityKey === current;
};

// True iff an entry exists for the folder (regardless of currency).
MetadataCache.prototype.has = function (folderPath) {
    return Object.prototype.hasOwnProperty.call(this._entries, normalizeFolderPath(folderPath));
};

// Return the stored metadata for a folder, or null when absent. Currency is a
// separate question — callers gate reads with isCurrent() (Req 11.3/11.4).
MetadataCache.prototype.get = function (folderPath) {
    var entry = this._entries[normalizeFolderPath(folderPath)];
    return entry ? entry.metadata : null;
};

// Return the full stored entry ({ folderPath, validityKey, metadata }) or null.
MetadataCache.prototype.getEntry = function (folderPath) {
    var entry = this._entries[normalizeFolderPath(folderPath)];
    return entry || null;
};

// Store metadata for a folder together with a validity key. When validityKey
// is omitted it is derived from the folder's current state at write time
// (recorded at save time per Req 11.1).
MetadataCache.prototype.put = function (folderPath, metadata, validityKey) {
    var key = normalizeFolderPath(folderPath);
    if (!key) return this;
    var vk = (validityKey === undefined || validityKey === null)
        ? this.currentKey(key)
        : validityKey;
    this._entries[key] = {
        folderPath: key,
        validityKey: vk,
        metadata: metadata
    };
    return this;
};

// Drop an entry so its metadata is recomputed on next access (Req 11.2).
MetadataCache.prototype.remove = function (folderPath) {
    delete this._entries[normalizeFolderPath(folderPath)];
    return this;
};

// Number of recorded entries.
MetadataCache.prototype.size = function () {
    var n = 0;
    for (var k in this._entries) {
        if (Object.prototype.hasOwnProperty.call(this._entries, k)) n++;
    }
    return n;
};

// Snapshot of recorded entries as an array (stable order by folderPath).
MetadataCache.prototype.entries = function () {
    var out = [];
    for (var k in this._entries) {
        if (Object.prototype.hasOwnProperty.call(this._entries, k)) out.push(this._entries[k]);
    }
    out.sort(function (a, b) {
        return a.folderPath < b.folderPath ? -1 : (a.folderPath > b.folderPath ? 1 : 0);
    });
    return out;
};

// Serialize to a JSON string: { version, entries: [{ folderPath, validityKey,
// metadata }] }. Paired with MetadataCache.parse for an exact round trip
// (Req 11.5, Property 28).
MetadataCache.prototype.serialize = function () {
    return JSON.stringify({
        version: this.version,
        entries: this.entries()
    });
};

// Parse a serialized cache string back into a MetadataCache. On ANY malformed
// input (invalid JSON, wrong shape, non-array entries) this returns an EMPTY
// cache — every folder reads as missing/not-current — and never throws
// (Req 11.6, Property 29). Individual entries missing a usable folderPath are
// dropped rather than failing the whole parse.
MetadataCache.parse = function (serialized, opts) {
    var cache = new MetadataCache(opts);

    var data = null;
    try {
        data = JSON.parse(serialized);
    } catch (e) {
        return cache; // not valid JSON -> all missing
    }

    if (!data || typeof data !== "object" || Object.prototype.toString.call(data.entries) !== "[object Array]") {
        return cache; // wrong shape -> all missing
    }

    if (typeof data.version === "number") cache.version = data.version;

    for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        if (!e || typeof e !== "object") continue;
        var fp = normalizeFolderPath(e.folderPath);
        if (!fp) continue; // unusable entry -> treat as missing
        cache._entries[fp] = {
            folderPath: fp,
            validityKey: e.validityKey === undefined ? null : e.validityKey,
            metadata: e.metadata === undefined ? null : e.metadata
        };
    }

    return cache;
};

// ── save-time metadata persistence (Task 3.5 / Req 11.1, 11.2) ──────
// Persist a freshly-saved template's expensive metadata into the
// Metadata_Cache together with its recorded validity key, tolerating a
// cache-write failure WITHOUT aborting the save.
//
// On success: the cache holds { folderPath, validityKey, metadata } for the
// template and — when a `persist` sink is supplied — the serialized cache is
// flushed to disk via that sink.
//
// On ANY failure (missing cache/path, a throw from put, or a throw from the
// persist/serialize flush): the entry is recorded as ABSENT (removed) so the
// metadata is recomputed on next access, and the function returns
// { ok:false, ... } WITHOUT throwing (Req 11.2, Property 31). The caller
// therefore treats this as advisory only — the essential save has already
// succeeded and must complete regardless of the outcome here.
//
// deps:
//   cache       — a MetadataCache instance (required)
//   folderPath  — template folder path (normalized internally) (required)
//   metadata    — the expensive Template_Metadata to store (required)
//   validityKey — optional explicit key; when omitted the cache derives it
//                 from the folder's current on-disk state at write time
//   persist     — optional (serialized:string) => void sink that flushes the
//                 serialized cache to disk; a throw here counts as a write
//                 failure and rolls the entry back to absent
function persistTemplateMetadata(deps) {
    deps = deps || {};
    var cache = deps.cache;
    var metadata = deps.metadata;
    var validityKey = deps.validityKey;
    var persist = typeof deps.persist === "function" ? deps.persist : null;
    var key = normalizeFolderPath(deps.folderPath);

    if (!cache || typeof cache.put !== "function" || !key) {
        return { ok: false, persisted: false, reason: "invalid-cache-or-path" };
    }

    try {
        // Record the expensive metadata plus its validity key (Req 11.1). An
        // omitted validityKey is derived from the folder's current state.
        cache.put(key, metadata, validityKey);
        // Flush to disk when a sink is supplied; a throw here is a write failure.
        if (persist) persist(cache.serialize());
        return { ok: true, persisted: true };
    } catch (e) {
        // Cache write failed: record the entry as ABSENT so it is recomputed on
        // next access, and DO NOT abort the save (Req 11.2, Property 31).
        try {
            if (typeof cache.remove === "function") cache.remove(key);
        } catch (e2) {
            /* best-effort — a remove failure must not surface either */
        }
        return {
            ok: false,
            persisted: false,
            reason: (e && e.message) ? e.message : String(e)
        };
    }
}

// ── Library_Index ───────────────────────────────────────────────────
// The persisted, incrementally-updated view of the template library. In the
// CEP runtime it backs `allTemplates` (state.js); here it owns the ordered
// entry list plus the persisted envelope { version, validityKey, entries[] }.
//
// The index NEVER rescans disk to reflect a change it can compute locally
// (Req 12.1/12.2/12.7): callers use insertAtHead / patchEntry / removeEntry.
// A whole-library `validityKey` (disk-state key) gates the one case a full
// Library_Scan is unavoidable (Req 12.4, Property 33). Every incremental
// mutation is transactional: on failure the prior (last valid) entry list is
// restored, an error indication is recorded, and the needs-full-scan flag is
// raised so the next reconcile performs a scan (Req 12.8, Property 16).
//
// Bump when the on-disk index shape changes.
var LIBRARY_INDEX_VERSION = 1;

// The default thumbnail lifecycle state for a freshly inserted entry whose
// rendered thumbnail does not yet exist (Req 3.2).
var LIBRARY_THUMB_PLACEHOLDER = "placeholder";

// Known entry fields (design: LibraryIndexEntry). Copied faithfully so the
// serialize()/parse() round trip is exact (Req 12.6, Property 32).
var LIBRARY_ENTRY_FIELDS = [
    "id", "name", "category", "section",
    "folderPath", "thumbnailPath", "thumbStatus", "favorite"
];

// Build a normalized entry object from a caller-supplied entry. Only DEFINED
// fields are copied (so JSON serialize/parse round-trips without spurious
// `undefined` keys), folderPath is normalized, and thumbStatus defaults to a
// placeholder. Throws on an entry with no usable folderPath so the caller's
// transactional mutation rolls back and flags a rescan.
function normalizeLibraryEntry(src) {
    if (!src || typeof src !== "object") {
        throw new Error("LibraryIndex: entry must be an object");
    }
    var fp = normalizeFolderPath(src.folderPath);
    if (!fp) {
        throw new Error("LibraryIndex: entry requires a folderPath");
    }
    var out = {};
    // Preserve every own-enumerable defined field so round-trip stays exact,
    // including any fields beyond the documented LibraryIndexEntry shape.
    for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        if (src[k] === undefined) continue;
        out[k] = src[k];
    }
    out.folderPath = fp;
    if (out.thumbStatus === undefined) out.thumbStatus = LIBRARY_THUMB_PLACEHOLDER;
    return out;
}

// opts:
//   version     — on-disk schema version to stamp on serialize()
//   validityKey — recorded whole-library disk-state key
function LibraryIndex(opts) {
    opts = opts || {};
    this._entries = [];          // ordered list of LibraryIndexEntry
    this._needsFullScan = false; // raised on a failed incremental update (Req 12.8)
    this._lastError = null;      // most recent incremental-update error indication
    this.version = typeof opts.version === "number" ? opts.version : LIBRARY_INDEX_VERSION;
    this.validityKey = (opts.validityKey === undefined) ? null : opts.validityKey;
}

// ── internal helpers ────────────────────────────────────────────────
LibraryIndex.prototype._indexOfPath = function (normalizedPath) {
    for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i].folderPath === normalizedPath) return i;
    }
    return -1;
};

// Deep-ish snapshot of the entry list (each entry shallow-cloned) so a rolled
// back mutation cannot leave a half-applied entry behind.
LibraryIndex.prototype._snapshotEntries = function () {
    var snap = [];
    for (var i = 0; i < this._entries.length; i++) {
        var e = this._entries[i];
        var copy = {};
        for (var k in e) {
            if (Object.prototype.hasOwnProperty.call(e, k)) copy[k] = e[k];
        }
        snap.push(copy);
    }
    return snap;
};

// Run an incremental mutation transactionally. On success clears the last
// error and returns true. On ANY thrown error, restores the pre-mutation
// entry list (last valid index), records the error indication, raises the
// needs-full-scan flag, and returns false (Req 12.8, Property 16).
LibraryIndex.prototype._mutate = function (fn) {
    var snapshot = this._snapshotEntries();
    try {
        fn(this);
        this._lastError = null;
        return true;
    } catch (e) {
        this._entries = snapshot;
        this._lastError = (e && e.message) ? e.message : String(e);
        this._needsFullScan = true;
        return false;
    }
};

// ── incremental operations ──────────────────────────────────────────
// Insert a template entry at the head (position 0). Any previously present
// entries keep their original relative order; an existing entry for the same
// folderPath is replaced in place at the head (an index never holds duplicate
// folders). No Library_Scan is performed (Req 3.5/12.1, Property 7).
LibraryIndex.prototype.insertAtHead = function (entry) {
    return this._mutate(function (self) {
        var e = normalizeLibraryEntry(entry);
        var existing = self._indexOfPath(e.folderPath);
        if (existing >= 0) self._entries.splice(existing, 1);
        self._entries.unshift(e);
    });
};

// Merge `fields` into the entry matching folderPath. Only that one entry
// changes; all others are untouched and no scan runs (Req 4.5/4.6/12.2/12.7,
// Properties 14/15). A patch targeting an absent folder is a failed update:
// it flags a rescan since the in-memory index is out of sync with disk.
LibraryIndex.prototype.patchEntry = function (folderPath, fields) {
    var key = normalizeFolderPath(folderPath);
    return this._mutate(function (self) {
        var idx = self._indexOfPath(key);
        if (idx < 0) {
            throw new Error("LibraryIndex.patchEntry: no entry for " + key);
        }
        if (!fields || typeof fields !== "object") {
            throw new Error("LibraryIndex.patchEntry: fields must be an object");
        }
        var current = self._entries[idx];
        var merged = {};
        for (var k in current) {
            if (Object.prototype.hasOwnProperty.call(current, k)) merged[k] = current[k];
        }
        for (var f in fields) {
            if (!Object.prototype.hasOwnProperty.call(fields, f)) continue;
            if (fields[f] === undefined) { delete merged[f]; continue; }
            merged[f] = fields[f];
        }
        // folderPath is the identity key — never let a patch move an entry.
        merged.folderPath = key;
        self._entries[idx] = merged;
    });
};

// Remove the entry matching folderPath (Req 12.2, Property 15). Removing an
// absent folder is a failed update that flags a rescan (index/disk mismatch).
LibraryIndex.prototype.removeEntry = function (folderPath) {
    var key = normalizeFolderPath(folderPath);
    return this._mutate(function (self) {
        var idx = self._indexOfPath(key);
        if (idx < 0) {
            throw new Error("LibraryIndex.removeEntry: no entry for " + key);
        }
        self._entries.splice(idx, 1);
    });
};

// ── needs-full-scan flag + error indication ─────────────────────────
LibraryIndex.prototype.needsFullScan = function () {
    return !!this._needsFullScan;
};
LibraryIndex.prototype.markNeedsFullScan = function () {
    this._needsFullScan = true;
    return this;
};
LibraryIndex.prototype.clearNeedsFullScan = function () {
    this._needsFullScan = false;
    return this;
};
LibraryIndex.prototype.lastError = function () {
    return this._lastError || null;
};

// ── read accessors ──────────────────────────────────────────────────
LibraryIndex.prototype.has = function (folderPath) {
    return this._indexOfPath(normalizeFolderPath(folderPath)) >= 0;
};
LibraryIndex.prototype.getEntry = function (folderPath) {
    var idx = this._indexOfPath(normalizeFolderPath(folderPath));
    return idx >= 0 ? this._entries[idx] : null;
};
LibraryIndex.prototype.size = function () {
    return this._entries.length;
};
// Ordered shallow copy of the entry list (head first).
LibraryIndex.prototype.entries = function () {
    return this._entries.slice();
};
LibraryIndex.prototype.setValidityKey = function (key) {
    this.validityKey = (key === undefined) ? null : key;
    return this;
};

// ── chunked reconcile ───────────────────────────────────────────────
// Reconcile the index against disk in work units that each hold the UI thread
// for no more than `workUnitMs` (default 50ms) continuously, yielding between
// units so the panel stays responsive (Req 12.3/12.4).
//
// `tasks`     — an array of work items (e.g. folderPaths to reconcile).
// `processor` — (item, index) => void, applied to each work item in order.
// opts:
//   workUnitMs — max continuous ms per work unit before yielding (default 50)
//   now        — () => ms clock (default Date.now)
//   schedule   — (fn) => void yield primitive (default setTimeout(fn, 0))
//
// Returns a Promise that resolves with this index when every work item has
// been processed (clearing the needs-full-scan flag) and rejects if a work
// item throws (leaving the flag raised so a later reconcile retries).
LibraryIndex.prototype.reconcile = function (tasks, processor, opts) {
    opts = opts || {};
    var self = this;
    var workUnitMs = typeof opts.workUnitMs === "number" ? opts.workUnitMs : 50;
    var now = typeof opts.now === "function"
        ? opts.now
        : function () { return (typeof Date !== "undefined" ? Date.now() : 0); };
    var schedule = typeof opts.schedule === "function"
        ? opts.schedule
        : function (fn) { setTimeout(fn, 0); };
    var list = tasks ? tasks.slice() : [];
    var proc = typeof processor === "function" ? processor : function () { };
    var i = 0;

    return new Promise(function (resolve, reject) {
        function runChunk() {
            var start = now();
            try {
                // Always make progress with at least one item, then keep going
                // until the continuous work-unit budget is spent.
                while (i < list.length) {
                    proc(list[i], i, self);
                    i++;
                    if (now() - start >= workUnitMs) break;
                }
            } catch (e) {
                self._lastError = (e && e.message) ? e.message : String(e);
                self._needsFullScan = true;
                reject(e);
                return;
            }
            if (i < list.length) {
                schedule(runChunk); // yield the UI thread, resume next work unit
            } else {
                self._needsFullScan = false; // reconciled clean against disk
                self._lastError = null;
                resolve(self);
            }
        }
        runChunk();
    });
};

// ── serialization ───────────────────────────────────────────────────
// Serialize to a JSON string: { version, validityKey, entries: [...] }. Paired
// with LibraryIndex.parse for an exact round trip (Req 12.6, Property 32).
LibraryIndex.prototype.serialize = function () {
    return JSON.stringify({
        version: this.version,
        validityKey: this.validityKey,
        entries: this._entries
    });
};

// Attempt to parse a serialized index. Returns { ok, index }: ok=false when the
// input is absent, not valid JSON, or malformed (wrong shape). Used by the
// full-scan predicate to distinguish "unparseable" from "valid" (Property 33).
LibraryIndex.tryParse = function (serialized, opts) {
    var idx = new LibraryIndex(opts);

    if (serialized === null || serialized === undefined || serialized === "") {
        return { ok: false, index: idx }; // absent
    }

    var data = null;
    try {
        data = JSON.parse(serialized);
    } catch (e) {
        return { ok: false, index: idx }; // not valid JSON
    }

    if (!data || typeof data !== "object" ||
        Object.prototype.toString.call(data.entries) !== "[object Array]") {
        return { ok: false, index: idx }; // wrong shape
    }

    if (typeof data.version === "number") idx.version = data.version;
    idx.validityKey = (data.validityKey === undefined) ? null : data.validityKey;

    for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        if (!e || typeof e !== "object") continue;
        var fp = normalizeFolderPath(e.folderPath);
        if (!fp) continue; // unusable entry -> drop rather than fail the parse
        var copy = {};
        for (var k in e) {
            if (!Object.prototype.hasOwnProperty.call(e, k)) continue;
            if (e[k] === undefined) continue;
            copy[k] = e[k];
        }
        copy.folderPath = fp;
        idx._entries.push(copy);
    }

    return { ok: true, index: idx };
};

// Parse a serialized index into a LibraryIndex. On valid input this reproduces
// the exact entry set and field values that were serialized (Req 12.6,
// Property 32). On ANY malformed input (invalid JSON, wrong shape) this returns
// an EMPTY index flagged for a full rescan and never throws (Req 12.4) — the
// panel recovers by scanning rather than failing.
LibraryIndex.parse = function (serialized, opts) {
    var res = LibraryIndex.tryParse(serialized, opts);
    if (res.ok) return res.index;
    res.index._needsFullScan = true;
    return res.index;
};

// Full-scan trigger predicate (Req 12.4, Property 33). A full Library_Scan is
// required IF AND ONLY IF the persisted index is absent, fails to parse, or its
// recorded validity key does not equal the current disk validity key.
//
//   serialized     — the persisted index string (or null/"" when absent)
//   currentDiskKey — the current whole-library disk-state validity key
LibraryIndex.fullScanRequired = function (serialized, currentDiskKey, opts) {
    var res = LibraryIndex.tryParse(serialized, opts);
    if (!res.ok) return true;                       // absent or unparseable
    return res.index.validityKey !== currentDiskKey; // key mismatch
};

// ── MediaEntryRepository ───────────────────────────────────────────────
//
// The generic LibraryIndex methods above are deliberately path-oriented so
// existing template callers keep their current behaviour.  Media imports need
// a different identity boundary: immutable stable IDs, source-path lookup,
// legacy migration, and a storage transaction that cannot publish a partial
// index.  This repository owns that boundary without changing LibraryIndex's
// public API.

function mediaHasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function mediaIsArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
}

// Clone only JSON-compatible data.  Rejecting values JSON would silently
// change (cycles, functions, undefined, non-finite numbers, Date, etc.) is
// intentional: a failed operation must retain the prior durable snapshot,
// never publish a lossy approximation of it.
function cloneMediaValue(value, seen, copies) {
    var valueType = typeof value;
    var i;
    if (value === null || valueType === "string" || valueType === "boolean") return value;
    if (valueType === "number") {
        if (!isFinite(value)) throw new Error("MediaEntryRepository: non-finite number cannot be persisted");
        return value;
    }
    if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
        throw new Error("MediaEntryRepository: value is not JSON-compatible");
    }
    if (valueType !== "object") {
        throw new Error("MediaEntryRepository: unsupported value type");
    }

    seen = seen || [];
    copies = copies || [];
    for (i = 0; i < seen.length; i++) {
        if (seen[i] === value) throw new Error("MediaEntryRepository: cyclic value cannot be persisted");
    }
    seen.push(value);

    var out;
    if (mediaIsArray(value)) {
        out = [];
        for (i = 0; i < value.length; i++) out.push(cloneMediaValue(value[i], seen, copies));
    } else {
        // JSON-compatible objects must be ordinary record-like objects.  This
        // avoids turning a Date/RegExp/custom instance into a different value
        // during serialization.
        if (Object.prototype.toString.call(value) !== "[object Object]") {
            seen.pop();
            throw new Error("MediaEntryRepository: object is not JSON-compatible");
        }
        out = {};
        for (var key in value) {
            if (mediaHasOwn(value, key)) out[key] = cloneMediaValue(value[key], seen, copies);
        }
    }
    seen.pop();
    return out;
}

function cloneMediaEntries(entries) {
    var list = [];
    if (!mediaIsArray(entries)) throw new Error("MediaEntryRepository: entries must be an array");
    for (var i = 0; i < entries.length; i++) list.push(cloneMediaValue(entries[i]));
    return list;
}

function isMediaSourcePathField(key) {
    return /^(source(Path|File)?|original(Path|File)?|mediaSource(Path)?)$/i.test(key);
}

function normalizeMediaPathFields(record) {
    if (!record || typeof record !== "object" || mediaIsArray(record)) return record;
    for (var key in record) {
        if (!mediaHasOwn(record, key)) continue;
        if ((key === "folderPath" || isMediaSourcePathField(key)) && typeof record[key] === "string") {
            record[key] = normalizeFolderPath(record[key]);
        }
    }
    return record;
}

function legacyMediaIdPath(entry) {
    var sourcePath = typeof entry.sourcePath === "string" ? normalizeFolderPath(entry.sourcePath) : "";
    var folderPath = typeof entry.folderPath === "string" ? normalizeFolderPath(entry.folderPath) : "";
    return sourcePath || folderPath;
}

function encodeLegacyMediaPath(pathValue) {
    try {
        return encodeURIComponent(pathValue);
    } catch (e) {
        // encodeURIComponent rejects malformed surrogate pairs.  Encoding UTF-16
        // code units is deterministic and injective for those rare legacy paths.
        var encoded = "";
        for (var i = 0; i < pathValue.length; i++) {
            var part = pathValue.charCodeAt(i).toString(16);
            while (part.length < 4) part = "0" + part;
            encoded += "u" + part;
        }
        return encoded;
    }
}

function stableMediaIdKey(id) {
    return typeof id + ":" + String(id);
}

// Normalize a single old or new media record without dropping unknown fields.
// Legacy metadata remains intact, but each of its own fields is promoted only
// when no top-level field with that name exists.
function normalizeMediaEntry(src) {
    if (!src || typeof src !== "object" || mediaIsArray(src)) {
        throw new Error("MediaEntryRepository: entry must be an object");
    }

    var out = cloneMediaValue(src);
    var metadata = out.metadata;
    if (metadata && typeof metadata === "object" && !mediaIsArray(metadata)) {
        normalizeMediaPathFields(metadata);
        for (var metadataKey in metadata) {
            if (mediaHasOwn(metadata, metadataKey) && !mediaHasOwn(out, metadataKey)) {
                out[metadataKey] = cloneMediaValue(metadata[metadataKey]);
            }
        }
        // Keep the object itself for compatibility with the old persisted
        // shape.  Do not replace top-level values with conflicting legacy data.
        out.metadata = metadata;
    }
    normalizeMediaPathFields(out);

    // Existing IDs are authoritative, including non-string legacy IDs.  Only a
    // missing/null/empty ID is migrated.  The chosen normalized source path (or
    // folder path when no source was recorded) makes migration deterministic.
    if (out.id === undefined || out.id === null || out.id === "") {
        var legacyPath = legacyMediaIdPath(out);
        if (!legacyPath) {
            throw new Error("MediaEntryRepository: legacy entry requires sourcePath or folderPath for ID migration");
        }
        out.id = "legacy-" + encodeLegacyMediaPath(legacyPath);
    }
    return out;
}

function getNormalizedEntrySourcePath(entry) {
    if (!entry || typeof entry !== "object") return "";
    if (typeof entry.sourcePath === "string") return normalizeFolderPath(entry.sourcePath);
    if (entry.metadata && typeof entry.metadata === "object" && typeof entry.metadata.sourcePath === "string") {
        return normalizeFolderPath(entry.metadata.sourcePath);
    }
    return "";
}

function deriveFolderValidityKeyAsync(folderPath, fsImpl) {
    return new Promise(function (resolve) {
        var fs = fsImpl || (typeof nfs === "function" ? nfs() : null);
        var dir = normalizeFolderPath(folderPath);
        if (!fs || typeof fs.readdir !== "function" || typeof fs.stat !== "function" || !dir) {
            resolve(null);
            return;
        }

        fs.readdir(dir, function (readError, names) {
            if (readError || !mediaIsArray(names)) {
                resolve(null);
                return;
            }
            var count = names.length;
            var totalSize = 0;
            var maxMtime = 0;
            var remaining = count + 1; // direct children plus the directory
            var finished = false;

            function foldStats(stats) {
                if (!stats) return;
                if (typeof stats.size === "number" && isFinite(stats.size)) totalSize += stats.size;
                var mtime = 0;
                if (typeof stats.mtimeMs === "number") mtime = stats.mtimeMs;
                else if (stats.mtime && typeof stats.mtime.getTime === "function") mtime = stats.mtime.getTime();
                if (mtime > maxMtime) maxMtime = mtime;
            }
            function completeOne(error, stats) {
                if (!error) foldStats(stats);
                remaining--;
                if (!finished && remaining === 0) {
                    finished = true;
                    resolve(count + ":" + totalSize + ":" + maxMtime);
                }
            }

            fs.stat(dir, completeOne);
            for (var i = 0; i < names.length; i++) fs.stat(dir + "/" + names[i], completeOne);
        });
    });
}

// Wave 2: a string `storedKey` opts into the versioned (v2) Combined_Validity_Key
// with the generation short-circuit — a root already known dirty by its
// Root_Generation emits its segment without any disk read (Requirement 8.4).
// Two-argument callers keep the pre-Wave-2 behaviour exactly: every signature
// derived, legacy format emitted.
function deriveCombinedValidityKeyAsync(paths, fsImpl, storedKey) {
    var normalizedPaths = [];
    var list = mediaIsArray(paths) ? paths : [];
    for (var i = 0; i < list.length; i++) {
        var normalized = normalizeFolderPath(list[i]);
        if (normalized) normalizedPaths.push(normalized);
    }
    if (!normalizedPaths.length) return Promise.resolve(null);

    if (typeof storedKey === "string") {
        return deriveVersionedValidityKeyAsync(normalizedPaths, fsImpl, storedKey);
    }

    var keys = [];
    var pending = normalizedPaths.length;
    return new Promise(function (resolve) {
        for (var index = 0; index < normalizedPaths.length; index++) {
            (function (pathValue, position) {
                deriveFolderValidityKeyAsync(pathValue, fsImpl).then(function (key) {
                    keys[position] = pathValue + ":" + (key === null ? "null" : key);
                    pending--;
                    if (pending === 0) resolve(keys.join(";"));
                }, function () {
                    keys[position] = pathValue + ":null";
                    pending--;
                    if (pending === 0) resolve(keys.join(";"));
                });
            })(normalizedPaths[index], index);
        }
    });
}

// v2 key over already-normalized roots. A root whose current generation differs
// from the generation recorded in the stored key derives NO signature at all.
function deriveVersionedValidityKeyAsync(normalizedPaths, fsImpl, storedKey) {
    var stored = parseCombinedValidityKey(storedKey);
    var segments = [];
    var pending = normalizedPaths.length;
    return new Promise(function (resolve) {
        function settle(position, pathValue, gen, sig) {
            segments[position] = { path: pathValue, gen: gen, sig: sig };
            pending--;
            if (pending === 0) resolve(buildCombinedValidityKey(segments));
        }
        for (var index = 0; index < normalizedPaths.length; index++) {
            (function (pathValue, position) {
                var gen = getRootGeneration(pathValue);
                var storedGen = storedGenerationForPath(stored, pathValue);
                if (storedGen !== null && storedGen !== gen) {
                    settle(position, pathValue, gen, VALIDITY_SIG_GENERATION);
                    return;
                }
                deriveRootSignatureAsync(pathValue, fsImpl).then(function (sig) {
                    settle(position, pathValue, gen, sig === null ? VALIDITY_SIG_UNKNOWN : sig);
                }, function () {
                    settle(position, pathValue, gen, VALIDITY_SIG_UNKNOWN);
                });
            })(normalizedPaths[index], index);
        }
    });
}

function MediaEntryRepository(opts) {
    opts = opts || {};
    this._index = opts.index || opts.libraryIndex || new LibraryIndex({
        version: opts.version,
        validityKey: opts.validityKey
    });
    if (opts.entries && mediaIsArray(opts.entries)) this._index._entries = cloneMediaEntries(opts.entries);
    this._storageKey = opts.storageKey || "compSaver_libraryIndex";
    this._allTemplates = opts.allTemplates || null;
    this._getAllTemplates = typeof opts.getAllTemplates === "function" ? opts.getAllTemplates : null;
    this._publish = typeof opts.publish === "function" ? opts.publish : null;
    this._normalizer = typeof opts.normalizeEntry === "function"
        ? opts.normalizeEntry
        : (typeof opts.normalize === "function" ? opts.normalize : null);
    this._serializer = typeof opts.serialize === "function" ? opts.serialize : null;
    this._fs = opts.fs || null;
    this._validityPaths = opts.validityPaths || opts.libraryPaths || opts.folderPaths ||
        (opts.rootPath ? [opts.rootPath] : []);
    this._deriveValidityKeyAsync = typeof opts.deriveValidityKeyAsync === "function"
        ? opts.deriveValidityKeyAsync
        : null;
    this._lastError = null;
    this._lastSerialized = null;
    this._durableEntries = cloneMediaEntries(this._index._entries || []);

    if (typeof opts.persist === "function") {
        this._persist = opts.persist;
    } else if (typeof opts.storage === "function") {
        this._persist = opts.storage;
    } else if (opts.storage && typeof opts.storage.setItem === "function") {
        this._persist = function (serialized) { opts.storage.setItem(this._storageKey, serialized); };
    } else {
        // TEST-HARNESS-ONLY fallback.  Production wiring (see
        // ensureProductionMediaRuntime in js/core/fastMediaEngine.js) MUST
        // inject a `persist` that funnels through commitVerifiedLocalStorage;
        // this raw setItem bypass has no staging/verify/previous-good
        // protection and must never be reached outside tests.
        this._persist = function (serialized) {
            if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.setItem === "function") {
                localStorage.setItem(this._storageKey, serialized);
            }
        };
    }
}

MediaEntryRepository.prototype._normalizeEntry = function (entry) {
    var candidate = cloneMediaValue(entry);
    if (this._normalizer) candidate = this._normalizer(candidate);
    return normalizeMediaEntry(candidate);
};

// Strict normalization: every entry in `entries` must carry a distinct stable
// ID.  Applied to the entries an operation INTRODUCES (an optimistic batch),
// where a collision means two records would fight over one identity and the
// caller must be told before anything is published.
MediaEntryRepository.prototype._normalizeEntries = function (entries) {
    var list = cloneMediaEntries(entries);
    var normalized = [];
    var ids = {};
    for (var i = 0; i < list.length; i++) {
        var entry = this._normalizeEntry(list[i]);
        var idKey = "$" + stableMediaIdKey(entry.id);
        if (mediaHasOwn(ids, idKey)) {
            throw new Error("MediaEntryRepository: stable ID collision for " + String(entry.id));
        }
        ids[idKey] = true;
        normalized.push(entry);
    }
    return normalized;
};

// Tolerant normalization for entries this repository only CARRIES THROUGH:
// the already-durable rows of the shared library index.
//
// Those rows include template records whose ID is derived from the template
// name alone (generateTemplateId), so the same name saved under two categories
// legitimately produces two rows with one ID.  Applying the strict guard to
// them made a pre-existing data defect fatal for everything downstream: one
// duplicated name ("order notification", saved under Uncategorized,
// Notification and Notifications) threw out of _normalizeEntries and therefore
// failed EVERY commitOptimisticBatch and patchById for every media record.
// That is what broke media import end to end — the batch commit failed before
// the copy stage ran, so no media folder was ever created (the card then
// pointed at a non-existent folderPath and the host reported "Image folder not
// found"), and completion patches could never move a record from pending to
// ready.
//
// Carried duplicates are reported rather than raised, so callers can surface or
// repair them while normal operations keep working.  Uniqueness is still
// enforced where it is this repository's own invariant: the incoming batch
// (_normalizeEntries) and any ID an operation newly claims.
MediaEntryRepository.prototype._normalizeCarriedEntries = function (entries) {
    var list = cloneMediaEntries(entries);
    var normalized = [];
    var ids = {};
    var duplicates = [];
    for (var i = 0; i < list.length; i++) {
        var entry = this._normalizeEntry(list[i]);
        var idKey = "$" + stableMediaIdKey(entry.id);
        if (mediaHasOwn(ids, idKey)) duplicates.push(entry.id);
        ids[idKey] = true;
        normalized.push(entry);
    }
    return { entries: normalized, ids: ids, duplicates: duplicates };
};

MediaEntryRepository.prototype._templateMirror = function () {
    var target = this._allTemplates;
    if (!target && this._getAllTemplates) target = this._getAllTemplates();
    if (!target && typeof window !== "undefined" && window && mediaIsArray(window.allTemplates)) target = window.allTemplates;
    if (!target && typeof allTemplates !== "undefined" && mediaIsArray(allTemplates)) target = allTemplates;
    return mediaIsArray(target) ? target : null;
};

MediaEntryRepository.prototype._publishDurable = function (entries, validityKey, serialized) {
    // `entries` arrive already reconciled against the LIVE shared index (see
    // _reconcileWithLiveIndex in _commitEntries), so publishing them can
    // never evict entries added to the shared LibraryIndex since this
    // repository's private cache was taken.
    var publishedEntries = cloneMediaEntries(entries);
    this._index._entries = cloneMediaEntries(publishedEntries);
    this._index.validityKey = validityKey;
    this._durableEntries = cloneMediaEntries(publishedEntries);
    this._lastSerialized = serialized;

    // Keep the existing warm-start mirror in lockstep only after storage has
    // succeeded.  Mutating the existing array preserves consumers' references.
    var mirror = this._templateMirror();
    if (mirror) {
        mirror.length = 0;
        for (var i = 0; i < publishedEntries.length; i++) mirror.push(cloneMediaValue(publishedEntries[i]));
    }
    if (this._publish) {
        try {
            this._publish(this.snapshot());
        } catch (e) {
            // External notification cannot undo a completed durable commit.
        }
    }
};

MediaEntryRepository.prototype._failure = function (operation, error) {
    this._lastError = {
        operation: operation,
        error: error,
        message: error && error.message ? error.message : String(error)
    };
    return { ok: false, operation: operation, error: error };
};

MediaEntryRepository.prototype._success = function (operation, entries, validityKey, serialized) {
    this._publishDurable(entries, validityKey, serialized);
    this._lastError = null;
    return {
        ok: true,
        operation: operation,
        snapshot: this.snapshot(),
        validityKey: validityKey
    };
};

MediaEntryRepository.prototype._serializeEntries = function (entries, validityKey) {
    var envelope = {
        version: this._index.version,
        validityKey: validityKey,
        entries: cloneMediaEntries(entries)
    };
    var serialized = this._serializer ? this._serializer(envelope) : JSON.stringify(envelope);
    if (typeof serialized !== "string") throw new Error("MediaEntryRepository: serializer must return a string");
    return serialized;
};

// Derive the stable ID a live (possibly pre-migration) shared-index entry
// will carry once normalized, without mutating it.  Falls back to the raw ID,
// or null when no identity can be established.
MediaEntryRepository.prototype._stableIdOf = function (entry) {
    if (!entry || typeof entry !== "object") return null;
    try {
        return this._normalizeEntry(entry).id;
    } catch (e) {
        /* fall through to the raw ID */
    }
    if (entry.id === undefined || entry.id === null || entry.id === "") return null;
    return entry.id;
};

// Reconcile the repository's candidate entries against the LIVE shared index
// before a durable commit.  The private _durableEntries cache is a snapshot
// from construction (or the last commit); entries added to the shared
// LibraryIndex since then — e.g. template saves via insertAtHead — must not
// be evicted by a media commit.  The commit envelope therefore starts from the
// current shared entries and applies the repository's own changes on top:
// each candidate replaces the live entry with the same stable ID in place,
// and candidates with no live counterpart (the repository's own new entries)
// keep their candidate position ahead of the reconciled list, preserving the
// head-first insertion order of commitOptimisticBatch.
//
// Live rows are paired with candidates BY OCCURRENCE, not by ID alone: the Nth
// live row carrying an ID takes the Nth candidate carrying it.  Pre-existing
// duplicate IDs are legitimate for carried template rows (see
// _normalizeCarriedEntries), and matching by ID alone collapsed every such row
// into one — silently deleting real catalog records on the next media commit.
MediaEntryRepository.prototype._reconcileWithLiveIndex = function (candidate) {
    var live = mediaIsArray(this._index._entries) ? this._index._entries : [];
    var queues = {};
    var i;
    var key;
    for (i = 0; i < candidate.length; i++) {
        key = "$" + stableMediaIdKey(candidate[i].id);
        if (!mediaHasOwn(queues, key)) queues[key] = [];
        queues[key].push(i);
    }
    var merged = [];
    var cursor = {};
    var consumed = {};
    for (i = 0; i < live.length; i++) {
        var liveId = this._stableIdOf(live[i]);
        var idKey = liveId === null ? null : "$" + stableMediaIdKey(liveId);
        var queue = idKey !== null && mediaHasOwn(queues, idKey) ? queues[idKey] : null;
        var offset = queue && mediaHasOwn(cursor, idKey) ? cursor[idKey] : 0;
        if (queue && offset < queue.length) {
            cursor[idKey] = offset + 1;
            consumed["$" + queue[offset]] = true;
            merged.push(cloneMediaValue(candidate[queue[offset]]));
            continue;
        }
        merged.push(cloneMediaValue(live[i]));
    }
    var head = [];
    for (i = 0; i < candidate.length; i++) {
        if (!mediaHasOwn(consumed, "$" + i)) head.push(cloneMediaValue(candidate[i]));
    }
    return head.concat(merged);
};

MediaEntryRepository.prototype._commitEntries = function (operation, entries, validityKey) {
    // Merge the candidate with whatever the LIVE shared index holds right now
    // so this commit can never publish a stale private cache over it.
    var reconciled;
    try {
        reconciled = this._reconcileWithLiveIndex(entries);
    } catch (reconcileError) {
        return this._failure(operation, reconcileError);
    }

    var serialized;
    try {
        serialized = this._serializeEntries(reconciled, validityKey);
    } catch (e) {
        return this._failure(operation, e);
    }

    var persistResult;
    try {
        persistResult = this._persist.call(this, serialized, this.snapshot());
    } catch (e2) {
        return this._failure(operation, e2);
    }

    var self = this;
    if (persistResult && typeof persistResult.then === "function") {
        return persistResult.then(function () {
            return self._success(operation, reconciled, validityKey, serialized);
        }, function (error) {
            return self._failure(operation, error);
        });
    }
    return this._success(operation, reconciled, validityKey, serialized);
};

// Insert the accepted optimistic records ahead of the pre-existing ordered
// index.  First-occurrence source paths are retained; already committed source
// paths are left untouched.  This protects the repository even if a caller
// forgot to deduplicate picker results before committing.
MediaEntryRepository.prototype.commitOptimisticBatch = function (entries) {
    var operation = "commitOptimisticBatch";
    try {
        if (!mediaIsArray(entries)) throw new Error("MediaEntryRepository: batch entries must be an array");
        var carried = this._normalizeCarriedEntries(this._durableEntries);
        var existing = carried.entries;
        var incoming = this._normalizeEntries(entries);
        var sourcePaths = {};
        var i;
        for (i = 0; i < existing.length; i++) {
            var existingSource = getNormalizedEntrySourcePath(existing[i]);
            if (existingSource) sourcePaths["$" + existingSource] = true;
        }
        var accepted = [];
        for (i = 0; i < incoming.length; i++) {
            var source = getNormalizedEntrySourcePath(incoming[i]);
            if (source && mediaHasOwn(sourcePaths, "$" + source)) continue;
            if (source) sourcePaths["$" + source] = true;
            accepted.push(incoming[i]);
        }
        // Re-check IDs over the complete candidate after batch de-duplication:
        // an accepted entry may not claim an ID that a carried row already
        // holds.  Checking only the newly claimed IDs (instead of re-validating
        // the whole candidate) keeps this guard on the collisions this commit
        // would actually create, while pre-existing duplicates among the
        // carried rows pass through untouched.
        for (i = 0; i < accepted.length; i++) {
            if (mediaHasOwn(carried.ids, "$" + stableMediaIdKey(accepted[i].id))) {
                throw new Error("MediaEntryRepository: stable ID collision for " + String(accepted[i].id));
            }
        }
        var candidate = accepted.concat(existing);
        return this._commitEntries(operation, candidate, this._index.validityKey);
    } catch (e) {
        return this._failure(operation, e);
    }
};

MediaEntryRepository.prototype.patchById = function (id, fields) {
    var operation = "patchById";
    try {
        if (id === undefined || id === null || id === "") throw new Error("MediaEntryRepository: patch requires an ID");
        if (!fields || typeof fields !== "object" || mediaIsArray(fields)) {
            throw new Error("MediaEntryRepository: patch fields must be an object");
        }
        var candidate = this._normalizeCarriedEntries(this._durableEntries).entries;
        var index = -1;
        for (var i = 0; i < candidate.length; i++) {
            if (candidate[i].id === id) {
                index = i;
                break;
            }
        }
        if (index < 0) throw new Error("MediaEntryRepository.patchById: no entry for " + String(id));
        if (mediaHasOwn(fields, "id") && fields.id !== undefined && fields.id !== candidate[index].id) {
            throw new Error("MediaEntryRepository.patchById: stable ID is immutable");
        }

        var merged = cloneMediaValue(candidate[index]);
        var patch = cloneMediaValue(fields);
        for (var key in patch) {
            if (!mediaHasOwn(patch, key) || key === "id") continue;
            if (patch[key] === undefined) delete merged[key];
            else merged[key] = patch[key];
        }
        merged.id = candidate[index].id;
        // A patch cannot introduce an ID (immutable above), so the candidate's
        // ID multiset is unchanged and re-validating it would only re-raise
        // carried duplicates this operation did not create.
        candidate[index] = this._normalizeEntry(merged);
        return this._commitEntries(operation, candidate, this._index.validityKey);
    } catch (e) {
        return this._failure(operation, e);
    }
};

// Drop one record by stable ID.  Transactional (nothing is published unless the
// durable write succeeds) and idempotent: removing an ID that is already absent
// reports ok with removed:0 rather than failing, so per-item cleanup of a failed
// provisional import can be retried safely.
MediaEntryRepository.prototype.removeById = function (id) {
    var operation = "removeById";
    try {
        if (id === undefined || id === null || id === "") throw new Error("MediaEntryRepository: remove requires an ID");
        var candidate = this._normalizeCarriedEntries(this._durableEntries).entries;
        var kept = [];
        var removed = 0;
        for (var i = 0; i < candidate.length; i++) {
            if (candidate[i].id === id) { removed++; continue; }
            kept.push(candidate[i]);
        }
        if (!removed) return { ok: true, operation: operation, removed: 0, snapshot: this.snapshot() };
        var result = this._commitEntries(operation, kept, this._index.validityKey);
        var self = this;
        var annotate = function (committed) {
            if (committed && committed.ok) committed.removed = removed;
            return committed;
        };
        if (result && typeof result.then === "function") return result.then(annotate);
        return annotate(result);
    } catch (e) {
        return this._failure(operation, e);
    }
};

MediaEntryRepository.prototype.getById = function (id) {
    for (var i = 0; i < this._durableEntries.length; i++) {
        var entry = this._durableEntries[i];
        if (entry && entry.id === id) return cloneMediaValue(entry);
        // A loaded legacy entry is addressable by its deterministic ID even
        // before its first subsequent commit persists that migration.
        try {
            var normalized = normalizeMediaEntry(entry);
            if (normalized.id === id) return cloneMediaValue(normalized);
        } catch (e) {
            /* malformed historical entry is not addressable */
        }
    }
    return null;
};

MediaEntryRepository.prototype.getBySourcePath = function (sourcePath) {
    var normalizedPath = normalizeFolderPath(sourcePath);
    if (!normalizedPath) return null;
    for (var i = 0; i < this._durableEntries.length; i++) {
        if (getNormalizedEntrySourcePath(this._durableEntries[i]) === normalizedPath) {
            return cloneMediaValue(this._durableEntries[i]);
        }
    }
    return null;
};

// Return an isolated ordered view of the last successful durable entries.
MediaEntryRepository.prototype.snapshot = function () {
    return cloneMediaEntries(this._durableEntries);
};

MediaEntryRepository.prototype.lastError = function () {
    return this._lastError;
};

MediaEntryRepository.prototype._currentValidityKeyAsync = function () {
    var self = this;
    if (!this._deriveValidityKeyAsync) {
        // Bug C fix (validity-key unification): templates.js compares the
        // stored key against the versioned (cskey2|) Combined_Validity_Key at
        // startup (getCombinedDiskValidityKey / scheduleStartupValidation),
        // but this default derivation used to emit the legacy
        // path:count:size:mtime format — the two can never match, forcing a
        // rescan on every launch. When the index already stores a v2 key
        // (production startup writes one), hand it to the builder so the
        // refresh persists the SAME v2 format and matches next launch exactly
        // when the disk is unchanged. A non-v2 stored key (legacy, null) keeps
        // the pre-Wave-2 behaviour byte-for-byte, so legacy expectations and
        // harnesses remain untouched; the next startup reconcile upgrades the
        // stored key to v2 and every later refresh follows suit.
        var storedKey = this._index && typeof this._index.validityKey === "string" &&
            this._index.validityKey.indexOf(VALIDITY_KEY_PREFIX) === 0
            ? this._index.validityKey
            : undefined;
        return deriveCombinedValidityKeyAsync(this._validityPaths, this._fs, storedKey);
    }
    return new Promise(function (resolve, reject) {
        var completed = false;
        function done(error, key) {
            if (completed) return;
            completed = true;
            if (arguments.length === 1 && !(error instanceof Error)) {
                resolve(error);
            } else if (error) {
                reject(error);
            } else {
                resolve(key);
            }
        }
        try {
            var result = self._deriveValidityKeyAsync.length >= 2
                ? self._deriveValidityKeyAsync(self._validityPaths.slice(), done)
                : self._deriveValidityKeyAsync(self._validityPaths.slice());
            if (result && typeof result.then === "function") {
                result.then(function (key) {
                    if (!completed) {
                        completed = true;
                        resolve(key);
                    }
                }, function (error) {
                    if (!completed) {
                        completed = true;
                        reject(error);
                    }
                });
            } else if (self._deriveValidityKeyAsync.length < 2 && !completed) {
                completed = true;
                resolve(result);
            }
        } catch (e) {
            if (!completed) {
                completed = true;
                reject(e);
            }
        }
    });
};

// Refreshes only validity metadata through callback/Promise based filesystem
// APIs, then persists that key with the same transaction discipline as entry
// commits.  No sync filesystem operation is used here.
MediaEntryRepository.prototype.refreshValidityAsync = function () {
    var self = this;
    var operation = "refreshValidityAsync";
    return this._currentValidityKeyAsync().then(function (key) {
        try {
            var candidate = self._normalizeEntries(self._durableEntries);
            var result = self._commitEntries(operation, candidate, key === undefined ? null : key);
            return result && typeof result.then === "function" ? result : Promise.resolve(result);
        } catch (e) {
            return self._failure(operation, e);
        }
    }, function (error) {
        return self._failure(operation, error);
    });
};

// ── CEP File I/O Helpers (Hybrid Cache Strategy) ──────────────────────

// ── Index_Store (Wave 2, Requirement 9) ─────────────────────────────
// localStorage has no rename, so atomicity is verify-then-commit with a
// durable previous-good copy: stage, re-read, verify, promote the current
// committed payload (only when it itself verifies), commit, clear staging.
// Every window in that sequence leaves at least one verifying payload
// readable, and loadLibraryIndex walks INDEX -> STAGING -> PREV.
var INDEX_KEY = "compSaver_libraryIndex";
var INDEX_STAGING_KEY = "compSaver_libraryIndex__staging";
var INDEX_PREV_KEY = "compSaver_libraryIndex__prev";

// Same naming discipline for the Root_Manifest writer, which shares the
// helper.  Note the ladder only prevents drift between writers while ALL
// writers to a shared key funnel through commitVerifiedLocalStorage: any raw
// localStorage.setItem bypass (e.g. an uninjected MediaEntryRepository
// persist) can silently overwrite a verified payload and break this guarantee.
var ROOT_MANIFEST_STAGING_KEY = "compSaver_rootManifest__staging";
var ROOT_MANIFEST_PREV_KEY = "compSaver_rootManifest__prev";

// Resolve localStorage without ever throwing (absent in ExtendScript, and a
// hostile host can make the property access itself throw).
function verifiedStorage() {
    try {
        if (typeof localStorage === "undefined" || !localStorage) return null;
        return localStorage;
    } catch (e) {
        return null;
    }
}

// Read a key as a non-empty string, or null. Never throws.
function readVerifiedKey(store, key) {
    if (!store || typeof store.getItem !== "function") return null;
    if (typeof key !== "string" || key === "") return null;
    var raw = null;
    try {
        raw = store.getItem(key);
    } catch (e) {
        return null;
    }
    if (typeof raw !== "string" || raw === "") return null;
    return raw;
}

// True iff the payload stored at `key` passes the caller's verifier.
function verifiedKeyHolds(store, key, verify) {
    var raw = readVerifiedKey(store, key);
    if (raw === null) return false;
    try {
        return verify(raw) === true;
    } catch (e) {
        return false;
    }
}

// Drop the staging key, EXCEPT while it holds the only verifying payload in the
// store (Requirement 9.8). A store without removeItem is left alone.
function releaseStagingKey(store, key, stagingKey, prevKey, verify) {
    if (!store || typeof store.removeItem !== "function") return;
    if (typeof stagingKey !== "string" || stagingKey === "") return;
    if (verifiedKeyHolds(store, stagingKey, verify) &&
        !verifiedKeyHolds(store, key, verify) &&
        !verifiedKeyHolds(store, prevKey, verify)) {
        return; // only verifying payload present — must not be deleted
    }
    try {
        store.removeItem(stagingKey);
    } catch (e) {
        /* best-effort */
    }
}

// The one shared verify-then-commit writer (Requirements 9.1-9.5, 9.8, 9.14).
// `verify` is a caller-supplied (payload) => boolean. Returns true only when the
// payload reached the committed key. Never throws.
function commitVerifiedLocalStorage(key, stagingKey, prevKey, payload, verify) {
    var store = verifiedStorage();
    if (!store || typeof store.setItem !== "function" || typeof store.getItem !== "function") return false;
    if (typeof key !== "string" || key === "") return false;
    if (typeof stagingKey !== "string" || stagingKey === "") return false;
    if (typeof payload !== "string") return false;
    var check = typeof verify === "function" ? verify : function () { return false; };

    // 1. stage
    try {
        store.setItem(stagingKey, payload);
    } catch (e) {
        // Quota / hostile host: the committed key is untouched.
        releaseStagingKey(store, key, stagingKey, prevKey, check);
        return false;
    }

    // 2. re-read and verify what actually landed
    var staged = readVerifiedKey(store, stagingKey);
    var stagedOk = false;
    if (staged !== null) {
        try {
            stagedOk = check(staged) === true;
        } catch (e) {
            stagedOk = false;
        }
    }
    if (!stagedOk) {
        releaseStagingKey(store, key, stagingKey, prevKey, check);
        return false; // committed key left exactly as it was (Requirement 9.3)
    }

    // 3. promote the current committed payload — only when it itself verifies,
    //    so a corrupt payload can never poison the fallback (Requirement 9.5).
    if (typeof prevKey === "string" && prevKey !== "") {
        var current = readVerifiedKey(store, key);
        if (current !== null) {
            var currentOk = false;
            try {
                currentOk = check(current) === true;
            } catch (e) {
                currentOk = false;
            }
            if (currentOk) {
                try {
                    store.setItem(prevKey, current);
                } catch (e) {
                    /* best-effort: staging still holds the new payload */
                }
            }
        }
    }

    // 4. commit
    try {
        store.setItem(key, payload);
    } catch (e) {
        // Staging still verifies and may now be the only good copy — keep it.
        return false;
    }

    // 5. clear staging
    releaseStagingKey(store, key, stagingKey, prevKey, check);
    return true;
}

// Verifier for Index_Store payloads (Requirement 9.2).
function libraryIndexPayloadVerifies(payload) {
    if (typeof payload !== "string" || payload === "") return false;
    var res = null;
    try {
        res = LibraryIndex.tryParse(payload);
    } catch (e) {
        return false;
    }
    return !!(res && res.ok === true);
}

// Shape probe for Root_Manifest payloads: { version:<number>, roots:<object> }.
function rootManifestPayloadVerifies(payload) {
    if (typeof payload !== "string" || payload === "") return false;
    var data = null;
    try {
        data = JSON.parse(payload);
    } catch (e) {
        return false;
    }
    if (!data || typeof data !== "object") return false;
    if (typeof data.version !== "number") return false;
    if (!data.roots || typeof data.roots !== "object") return false;
    return true;
}

function saveLibraryIndex() {
    var li = null;
    try {
        li = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;
    } catch (e) {
        console.warn("[CompSaver] Failed to persist LibraryIndex:", e);
        return;
    }
    if (!li) return;
    try {
        var committed = commitVerifiedLocalStorage(
            INDEX_KEY,
            INDEX_STAGING_KEY,
            INDEX_PREV_KEY,
            li.serialize(),
            libraryIndexPayloadVerifies
        );
        if (committed !== true) {
            console.warn("[CompSaver] Failed to persist LibraryIndex:", new Error("staged payload failed verification"));
        }
    } catch (e) {
        console.warn("[CompSaver] Failed to persist LibraryIndex:", e);
    }
}

// Reason channel for the most recent loadLibraryIndex() call. Purely
// observational: it never changes what loadLibraryIndex returns, it only records
// WHY the returned index looks the way it does so the startup trace can report a
// cache decision with an exact reason.
//   "not-loaded"      — loadLibraryIndex has not run yet in this context
//   "absent"          — no stored string
//   "index-parsed"    — parsed with at least one entry
//   "index-empty"     — parsed, zero entries
//   "corrupt"         — tryParse reported ok === false (bad JSON / wrong shape)
//   "no-index-object" — getLibraryIndex() returned null
// Wave 2 (Requirements 9.6, 9.7, 9.9) adds the recovery-ladder reasons:
//   "recovered-staging"  — the committed key was absent/unusable and the staging
//                          key verified (the newer of the two survivors)
//   "recovered-previous" — neither the committed nor the staging key was usable
//                          and the previous-good key verified
//   "version-ahead"      — a payload written by a NEWER CompSaver: its entries are
//                          not consumed and the stored string is left in place
var _lastLibraryIndexLoadReason = "not-loaded";

function getLastLibraryIndexLoadReason() {
    return _lastLibraryIndexLoadReason;
}

// A parsed payload is consumable only while its schema version is at or behind
// this build's (Requirements 9.9, 9.10). A missing/non-numeric version is left
// to tryParse's default, which is this build's version.
function libraryIndexVersionAhead(index) {
    if (!index) return false;
    var v = index.version;
    if (typeof v !== "number" || !isFinite(v)) return false;
    return v > LIBRARY_INDEX_VERSION;
}

function loadLibraryIndex() {
    var li = null;
    try {
        li = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;
    } catch (e) {
        li = null;
    }
    if (!li) {
        _lastLibraryIndexLoadReason = "no-index-object";
        return null;
    }

    // Recovery ladder (Requirements 9.6, 9.7): the committed key first, then the
    // staged payload (newer than previous-good), then the previous-good copy. A
    // candidate is accepted only when it parses AND its version is not ahead.
    // Nothing is ever removed here, so a verifying payload always survives a load.
    var store = verifiedStorage();
    var ladder = [INDEX_KEY, INDEX_STAGING_KEY, INDEX_PREV_KEY];
    var acceptedRes = null;
    var acceptedFrom = -1;
    var fallbackRes = null; // first stored-but-unusable payload, for the copy below
    var sawStored = false;
    var sawVersionAhead = false;

    for (var i = 0; i < ladder.length; i++) {
        var raw = readVerifiedKey(store, ladder[i]);
        if (raw === null) continue;
        sawStored = true;
        var candidate = null;
        try {
            candidate = LibraryIndex.tryParse(raw);
        } catch (e) {
            candidate = null;
        }
        if (!candidate || candidate.ok !== true) {
            if (fallbackRes === null && candidate) fallbackRes = candidate;
            continue;
        }
        if (libraryIndexVersionAhead(candidate.index)) {
            // Written by a newer CompSaver: consume nothing, leave it in place.
            sawVersionAhead = true;
            break;
        }
        acceptedRes = candidate;
        acceptedFrom = i;
        break;
    }

    if (sawVersionAhead) {
        _lastLibraryIndexLoadReason = "version-ahead";
        return li;
    }

    if (acceptedRes !== null || fallbackRes !== null) {
        // tryParse instead of parse so the failure mode is observable. Field
        // copying stays byte-identical to the previous parse() call site: on
        // ok === false tryParse yields an empty index with validityKey null,
        // which is exactly what parse() produced (parse only additionally set
        // _needsFullScan, which was never copied here and still is not).
        var res = acceptedRes !== null ? acceptedRes : fallbackRes;
        var parsed = res.index;
        li._entries = parsed._entries;
        li.version = parsed.version;
        li.validityKey = parsed.validityKey;
        if (res.ok !== true) {
            _lastLibraryIndexLoadReason = "corrupt";
        } else if (acceptedFrom === 1) {
            _lastLibraryIndexLoadReason = "recovered-staging";
        } else if (acceptedFrom === 2) {
            _lastLibraryIndexLoadReason = "recovered-previous";
        } else if (li._entries && li._entries.length > 0) {
            _lastLibraryIndexLoadReason = "index-parsed";
        } else {
            _lastLibraryIndexLoadReason = "index-empty";
        }
    } else {
        _lastLibraryIndexLoadReason = sawStored ? "corrupt" : "absent";
    }
    return li;
}

// ── Root_Manifest (Wave 2, Requirement 8.2) ─────────────────────────
// Generation counters bumped by CompSaver's own mutations, so a change the
// panel made itself costs zero disk reads to detect on the next launch.
//
// Persisted shape: { version: 1, roots: { "<normalized path>": <int >= 0> } }
//
// Every read is tolerant: absent, non-JSON, wrong-shaped, or non-integer input
// resolves to generation 0 for the affected root and the caller falls back to
// Root_Signature alone (Requirement 8.12).
var ROOT_MANIFEST_KEY = "compSaver_rootManifest";
var ROOT_MANIFEST_VERSION = 1;

function rootManifestStorage() {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    return localStorage;
}

// Non-negative integer, or 0 for anything else (non-number, NaN, negative,
// fractional, string, object, absent) — Requirement 8.12.
function rootGenerationValue(value) {
    if (typeof value !== "number" || !isFinite(value)) return 0;
    if (value < 0) return 0;
    if (Math.floor(value) !== value) return 0;
    return value;
}

function loadRootManifest() {
    var manifest = { version: ROOT_MANIFEST_VERSION, roots: {} };
    var store = rootManifestStorage();
    if (!store || typeof store.getItem !== "function") return manifest;

    var raw = null;
    try {
        raw = store.getItem(ROOT_MANIFEST_KEY);
    } catch (e) {
        return manifest;
    }
    if (typeof raw !== "string" || raw === "") return manifest;

    var data = null;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return manifest; // non-JSON — every root reads as generation 0
    }
    if (!data || typeof data !== "object") return manifest;

    var roots = data.roots;
    if (!roots || typeof roots !== "object") return manifest;

    for (var key in roots) {
        if (!Object.prototype.hasOwnProperty.call(roots, key)) continue;
        var normalized = normalizeFolderPath(key);
        if (!normalized) continue;
        var gen = rootGenerationValue(roots[key]);
        if (gen > 0) manifest.roots[normalized] = gen;
    }
    return manifest;
}

function getRootGeneration(root) {
    var normalized = normalizeFolderPath(root);
    if (!normalized) return 0;
    var manifest = loadRootManifest();
    if (!Object.prototype.hasOwnProperty.call(manifest.roots, normalized)) return 0;
    return rootGenerationValue(manifest.roots[normalized]);
}

// Read, increment, write, return the new value. Best-effort by design: a
// storage failure only costs a background reconcile, since Root_Signature is
// still compared (Requirement 8.3 is satisfied by the write attempt happening
// inside the same call, before any subsequent key read).
//
// The write goes through the shared commitVerifiedLocalStorage helper with a
// manifest shape probe, so the manifest and the index writer cannot drift.
//
// M4 fix: the manifest lives in storage shared by every open panel, so the
// naive read-modify-write could lose a concurrent bump (two panels both read
// generation 3, both write 4). The bump therefore verifies like a
// compare-and-set: after writing it re-reads the committed manifest and
// checks the stored generation against the one it wrote. A HIGHER value
// means another panel bumped afterwards — monotonic, adopted as the result.
// A LOWER value means a concurrent panel's stale snapshot overwrote ours —
// the bump retries from the freshly read value, a bounded number of times.
var ROOT_GENERATION_CAS_ATTEMPTS = 3;

function bumpRootGeneration(root) {
    var normalized = normalizeFolderPath(root);
    if (!normalized) return 0;

    var next = 0;
    for (var attempt = 0; attempt < ROOT_GENERATION_CAS_ATTEMPTS; attempt++) {
        var manifest = loadRootManifest();
        next = 0;
        if (Object.prototype.hasOwnProperty.call(manifest.roots, normalized)) {
            next = rootGenerationValue(manifest.roots[normalized]);
        }
        next = next + 1;
        manifest.roots[normalized] = next;

        try {
            commitVerifiedLocalStorage(
                ROOT_MANIFEST_KEY,
                ROOT_MANIFEST_STAGING_KEY,
                ROOT_MANIFEST_PREV_KEY,
                JSON.stringify({
                    version: ROOT_MANIFEST_VERSION,
                    roots: manifest.roots
                }),
                rootManifestPayloadVerifies
            );
        } catch (e) {
            /* best-effort: the signature still catches the change */
        }

        // CAS verification: re-read the shared manifest. The committed shape
        // carries no writer identity, so the check is on the value: ours (or
        // higher) means the bump is durable and monotonic; lower means a
        // concurrent write clobbered it and the loop retries from scratch.
        var observed = getRootGeneration(root);
        if (observed >= next) return observed;
    }

    // Bounded retries exhausted under a continuously racing writer: keep the
    // previous best-effort contract — return the value the last attempt
    // wrote; Root_Signature still catches the underlying change.
    return next;
}

// ── Root_Signature (Wave 2, Requirements 8.5, 8.6) ──────────────────
// Depth-1 signature for the library-index validity path only: the root's own
// count:size:mtime triple, plus the triple of each immediate child folder, so a
// change inside <root>/<section>/ moves the signature. Reads directory metadata
// only (readdir + stat); it opens and parses no file, and it descends at most
// one level below the root (Requirement 8.5). The category level is deliberately
// not walked — a save always goes through CompSaver and is caught by the
// generation bump.
//
// deriveFolderValidityKey stays untouched: its output is the persisted
// MetadataCache entry key (Requirement 8.11).
//
// The emitted string uses only digits, ":" and "|", so it can never collide with
// the combined-key delimiters.
function signatureStatSize(st) {
    if (st && typeof st.size === "number" && isFinite(st.size)) return st.size;
    return 0;
}

function signatureStatMtime(st) {
    if (!st) return 0;
    if (typeof st.mtimeMs === "number" && isFinite(st.mtimeMs)) return st.mtimeMs;
    if (st.mtime && typeof st.mtime.getTime === "function") {
        var m = st.mtime.getTime();
        return (typeof m === "number" && isFinite(m)) ? m : 0;
    }
    return 0;
}

function foldSignatureMtime(current, st) {
    var m = signatureStatMtime(st);
    return m > current ? m : current;
}

function sortedNameList(names) {
    var copy = [];
    for (var i = 0; i < names.length; i++) copy.push("" + names[i]);
    copy.sort();
    return copy;
}

// A stat that says "not a directory" settles it; otherwise a successful readdir
// is the evidence (test doubles need not implement isDirectory).
function signatureStatIsFile(st) {
    if (!st || typeof st.isDirectory !== "function") return false;
    try {
        return st.isDirectory() !== true;
    } catch (e) {
        return false;
    }
}

function signatureChildTriple(childCount, st) {
    return childCount + ":" + signatureStatSize(st) + ":" + signatureStatMtime(st);
}

// CompSaver's own bookkeeping inside a library root must NEVER reach the
// signature. `.compsaver_metadata.json` is rewritten through a sibling
// `.compsaver_metadata.json.tmp` that is created and renamed on every save, and
// creating/removing a directory entry moves the root's own directory mtime. Fold
// any of that in and the signature moves on its own: the recorded key never
// matches the derived one, every reopen reports "stale", and each one pays a
// full blocking host rescan for a library that never changed — a
// self-invalidating cache. Template content lives in the section folders, so
// dot-entries and the migration log are not evidence of a template change.
// Template content lives ONLY in these seven section folders. Everything else a
// library root contains is CompSaver's own runtime output — `text_animations`
// and `preview_assets` (render output), `preview_debug.txt` and `migration.log`
// (logs that grow), `.compsaver_metadata.json` and its `.tmp` sibling, `effects`,
// `_shared` — and none of it is evidence that a template changed. Measured on a
// real library, folding those in moved the signature every time a preview
// rendered, so the recorded key never matched the derived one: every reopen
// reported "stale" and paid a ~74 s blocking host rescan, which itself triggered
// more preview renders and guaranteed the next reopen was stale too.
var SIGNATURE_SECTION_FOLDERS = ["comp", "effect", "footage", "icon", "layer", "overlay", "text"];

// A section folder's fingerprint is its category count plus the newest mtime
// across those categories. Adding, renaming or deleting a template inside a
// category moves that category directory's mtime, so external edits are still
// detected at depth 2 without ever reading a file.
function signatureFoldSectionSync(fs, sectionDir) {
    var names;
    try {
        names = fs.readdirSync(sectionDir);
    } catch (e) {
        return null; // section folder absent for this library
    }
    if (!mediaIsArray(names)) names = [];

    var newest = 0;
    for (var i = 0; i < names.length; i++) {
        if (typeof fs.statSync !== "function") break;
        var st = null;
        try {
            st = fs.statSync(sectionDir + "/" + names[i]);
        } catch (e) {
            continue; // transient entry
        }
        newest = foldSignatureMtime(newest, st);
    }
    return names.length + ":" + newest;
}

function deriveRootSignature(root, fsImpl) {
    var fs = fsImpl || (typeof nfs === "function" ? nfs() : null);
    if (!fs || typeof fs.readdirSync !== "function") return null;

    var dir = normalizeFolderPath(root);
    if (!dir) return null;

    // Establish that the ROOT itself is readable before folding anything. An
    // unreadable root must yield null, never a string: null never compares equal
    // to a recorded signature, so the root is treated as changed. A string would
    // make two different unreadable roots compare equal to each other, and would
    // make a root that is only temporarily unreadable look permanently fresh —
    // real changes would then never be picked up.
    try {
        fs.readdirSync(dir);
    } catch (e) {
        return null;
    }

    // Only the seven section folders, in a fixed order, so nothing CompSaver
    // writes elsewhere in the root can move the key. An absent section
    // contributes the literal "-", which keeps the segment count fixed and
    // distinguishes a readable-but-empty root from an unreadable one.
    var parts = [];
    try {
        for (var i = 0; i < SIGNATURE_SECTION_FOLDERS.length; i++) {
            var fold = signatureFoldSectionSync(fs, dir + "/" + SIGNATURE_SECTION_FOLDERS[i]);
            parts.push(fold === null ? "-" : fold);
        }
    } catch (e) {
        return null;
    }
    return parts.join("|");
}

function deriveRootSignatureAsync(root, fsImpl) {
    return new Promise(function (resolve) {
        var fs = fsImpl || (typeof nfs === "function" ? nfs() : null);
        var dir = normalizeFolderPath(root);
        if (!fs || typeof fs.readdir !== "function" || typeof fs.stat !== "function" || !dir) {
            resolve(null);
            return;
        }

        // Byte-for-byte the same fold as the synchronous twin, section for
        // section — including the root-readability probe, which must resolve
        // null rather than a string so an unreadable root reads as changed.
        // The two keys are compared against each other, so any divergence here
        // would report a permanent false "stale".
        var folds = [];
        var pending = SIGNATURE_SECTION_FOLDERS.length;

        function settle() {
            pending--;
            if (pending > 0) return;
            var parts = [];
            for (var i = 0; i < SIGNATURE_SECTION_FOLDERS.length; i++) {
                parts.push(typeof folds[i] === "string" ? folds[i] : "-");
            }
            resolve(parts.join("|"));
        }

        fs.readdir(dir, function (rootError, rootNames) {
            if (rootError || !mediaIsArray(rootNames)) {
                resolve(null); // unreadable root
                return;
            }
            foldSections();
        });

        function foldSections() {
            for (var s = 0; s < SIGNATURE_SECTION_FOLDERS.length; s++) {
                (function (sectionDir, position) {
                    fs.readdir(sectionDir, function (readError, names) {
                        if (readError || !mediaIsArray(names)) {
                            settle(); // absent section -> "-"
                            return;
                        }
                        if (names.length === 0) {
                            folds[position] = "0:0";
                            settle();
                            return;
                        }
                        var newest = 0;
                        var left = names.length;
                        for (var c = 0; c < names.length; c++) {
                            fs.stat(sectionDir + "/" + names[c], function (statError, st) {
                                if (!statError) newest = foldSignatureMtime(newest, st);
                                left--;
                                if (left === 0) {
                                    folds[position] = names.length + ":" + newest;
                                    settle();
                                }
                            });
                        }
                    });
                })(dir + "/" + SIGNATURE_SECTION_FOLDERS[s], s);
            }
        }
    });
}

// ── Combined_Validity_Key, versioned format (Requirement 8.8) ───────
// The pre-Wave-2 segment was `path + ":" + count + ":" + size + ":" + mtime`,
// joined by ";" — ambiguous to split back into a path, since Windows paths and
// the token both contain colons. The v2 format separates the path from its token
// with a unit separator, which cannot appear in a path:
//
//   cskey2|<path>\u001f<gen>~<sig>;<path>\u001f<gen>~<sig>
//
// Parsing splits segments on ";" and each segment on its FIRST separator, so the
// path is recovered exactly however many colons or backslashes it contains.
var VALIDITY_KEY_PREFIX = "cskey2|";
var VALIDITY_FIELD_SEP = "\u001f"; // unit separator, illegal in paths
var VALIDITY_SIG_UNKNOWN = "null"; // unreadable root
var VALIDITY_SIG_GENERATION = "gen"; // known dirty by generation, no disk read

// segments: [{ path, gen, sig }]. The path is used verbatim (callers normalize),
// so a key built from a path round-trips back to that exact string.
function buildCombinedValidityKey(segments) {
    var list = mediaIsArray(segments) ? segments : [];
    var parts = [];
    for (var i = 0; i < list.length; i++) {
        var seg = list[i];
        if (!seg || typeof seg !== "object") continue;
        var path = "" + (seg.path === undefined || seg.path === null ? "" : seg.path);
        if (path === "") continue;
        var gen = rootGenerationValue(seg.gen);
        var sig = (typeof seg.sig === "string" && seg.sig !== "") ? seg.sig : VALIDITY_SIG_UNKNOWN;
        parts.push(path + VALIDITY_FIELD_SEP + gen + "~" + sig);
    }
    return VALIDITY_KEY_PREFIX + parts.join(";");
}

// { version: 2, tokens: { path: "gen~sig" } } for a v2 key,
// { version: 1, tokens: null } for anything else (legacy, null, "").
function parseCombinedValidityKey(key) {
    if (typeof key !== "string" || key === "") return { version: 1, tokens: null };
    if (key.substring(0, VALIDITY_KEY_PREFIX.length) !== VALIDITY_KEY_PREFIX) {
        return { version: 1, tokens: null };
    }
    var tokens = {};
    var body = key.substring(VALIDITY_KEY_PREFIX.length);
    var segments = body.split(";");
    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg) continue;
        var at = seg.indexOf(VALIDITY_FIELD_SEP); // FIRST separator
        if (at <= 0) continue;
        var path = seg.substring(0, at);
        if (path === "") continue;
        tokens[path] = seg.substring(at + 1);
    }
    return { version: 2, tokens: tokens };
}

// The generation recorded in a stored v2 token, or null when the stored key is
// not v2, carries no token for this root, or carries a non-integer generation —
// in which case the caller derives a signature rather than short-circuiting.
function storedGenerationForPath(stored, path) {
    if (!stored || stored.version !== 2 || !stored.tokens) return null;
    if (!Object.prototype.hasOwnProperty.call(stored.tokens, path)) return null;
    var token = stored.tokens[path];
    if (typeof token !== "string") return null;
    var at = token.indexOf("~");
    var genText = at >= 0 ? token.substring(0, at) : token;
    if (!/^[0-9]+$/.test(genText)) return null;
    return parseInt(genText, 10);
}

// The single place the libraryPaths / rootPath fallback lives, so the sync key,
// the async key, and the metadata cache paths all agree (Requirement 8.10).
function resolveValidityPaths(pathsToScan) {
    if (mediaIsArray(pathsToScan) && pathsToScan.length > 0) return pathsToScan;
    if (typeof libraryPaths !== "undefined" && libraryPaths && libraryPaths.length > 0) return libraryPaths;
    if (typeof rootPath !== "undefined" && rootPath) return [rootPath];
    return [];
}

function getCombinedDiskValidityKey(pathsToScan) {
    var segments = [];
    try {
        var paths = resolveValidityPaths(pathsToScan);
        for (var i = 0; i < paths.length; i++) {
            var p = normalizeFolderPath(paths[i]);
            if (!p) continue;
            // The generation is a monotonic counter, not a dirty flag: a root
            // CompSaver has ever written still needs its signature, or external
            // changes to it would never move the key again (Requirements 8.1,
            // 8.5, 8.6). The generation short-circuit belongs to the async
            // builder, which compares against the generation recorded in the
            // stored key (Requirement 8.4).
            segments.push({
                path: p,
                gen: getRootGeneration(p),
                sig: deriveRootSignature(p) || VALIDITY_SIG_UNKNOWN
            });
        }
    } catch (e) {
        /* a partial key is still a key; never throw from the startup path */
    }
    return buildCombinedValidityKey(segments);
}

// Metadata_File and its sibling temp file. The temp file lives in the SAME
// directory as the target, so the rename stays same-volume and therefore atomic
// (Requirement 9.11).
var METADATA_FILE_SUFFIX = "/.compsaver_metadata.json";
var METADATA_TMP_SUFFIX = "/.compsaver_metadata.json.tmp";

function metadataFilePath(libRoot) {
    return libRoot + METADATA_FILE_SUFFIX;
}

function metadataTempFilePath(libRoot) {
    return libRoot + METADATA_TMP_SUFFIX;
}

// Temp-file-and-rename, so a crash mid-write leaves the previous complete file
// in place instead of a truncated one. When renameSync is unavailable or throws,
// this degrades to exactly today's direct write, so a filesystem without rename
// is never worse off than before (Requirement 9.12). Throws are left to the
// caller's per-root catch, which owns the existing console.warn text.
function writeMetadataFileAtomically(fs, libRoot, payload) {
    var target = metadataFilePath(libRoot);
    var tmp = metadataTempFilePath(libRoot);
    if (typeof fs.renameSync === "function") {
        try {
            fs.writeFileSync(tmp, payload, "utf8");
            fs.renameSync(tmp, target);
            return;
        } catch (renameErr) {
            /* fall through to today's direct write */
        }
    }
    fs.writeFileSync(target, payload, "utf8");
    try {
        if (typeof fs.unlinkSync === "function") fs.unlinkSync(tmp);
    } catch (unlinkErr) {
        /* best effort: a leftover temp file is harmless, the target is committed */
    }
}

// MetadataCache.parse never throws — malformed input yields an EMPTY cache — so
// "parsed to zero entries" is the corruption signal the caller acts on. Only the
// read itself can throw, which the caller catches.
function readMetadataCacheFile(fs, filePath) {
    return MetadataCache.parse(fs.readFileSync(filePath, "utf8"));
}

function saveMetadataCache() {
    var cache = typeof getMetadataCache === "function" ? getMetadataCache() : null;
    if (!cache) return;
    var fs = typeof nfs === "function" ? nfs() : null;
    if (!fs || !fs.writeFile) return;

    var paths = resolveValidityPaths();
    var allEntries = cache.entries();

    for (var p = 0; p < paths.length; p++) {
        (function (libRoot) {
            var libEntries = [];
            for (var i = 0; i < allEntries.length; i++) {
                if (allEntries[i].folderPath.indexOf(libRoot + "/") === 0) {
                    libEntries.push(allEntries[i]);
                }
            }
            if (libEntries.length === 0) return; // No metadata for this library root

            var subCache = new MetadataCache();
            for (var e = 0; e < libEntries.length; e++) {
                subCache.put(libEntries[e].folderPath, libEntries[e].metadata, libEntries[e].validityKey);
            }
            try {
                writeMetadataFileAtomically(fs, libRoot, subCache.serialize());
            } catch (err) {
                console.warn("[CompSaver] Failed to write metadata cache for", libRoot, err);
            }
        })(normalizeFolderPath(paths[p]));
    }
}

function loadMetadataCache() {
    var cache = typeof getMetadataCache === "function" ? getMetadataCache() : null;
    if (!cache) return;
    var fs = typeof nfs === "function" ? nfs() : null;
    if (!fs || !fs.readFileSync) return;

    var paths = resolveValidityPaths();
    for (var p = 0; p < paths.length; p++) {
        var libRoot = normalizeFolderPath(paths[p]);
        try {
            var subCache = null;
            var metaFile = metadataFilePath(libRoot);
            if (fs.existsSync(metaFile)) {
                try {
                    subCache = readMetadataCacheFile(fs, metaFile);
                } catch (readErr) {
                    subCache = null;
                    console.warn("[CompSaver] Failed to load metadata cache for", libRoot, readErr);
                }
            }
            // Absent, unreadable, or parsed to zero entries: a crash between the
            // temp write and the rename can leave the good payload in the sibling
            // temp file, so recover from it when it carries entries (Req 9.13).
            if (!subCache || subCache.size() === 0) {
                var tmpFile = metadataTempFilePath(libRoot);
                var tmpCache = null;
                if (typeof fs.existsSync === "function" && fs.existsSync(tmpFile)) {
                    try {
                        tmpCache = readMetadataCacheFile(fs, tmpFile);
                    } catch (tmpErr) {
                        tmpCache = null;
                    }
                }
                if (tmpCache && tmpCache.size() > 0) subCache = tmpCache;
            }
            if (subCache) {
                var entries = subCache.entries();
                for (var i = 0; i < entries.length; i++) {
                    cache.put(entries[i].folderPath, entries[i].metadata, entries[i].validityKey);
                }
            }
        } catch (err) {
            console.warn("[CompSaver] Failed to load metadata cache for", libRoot, err);
        }
    }
}

// Dual-load guard: CommonJS for jest, bare globals for CEP <script> inclusion.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        METADATA_CACHE_VERSION: METADATA_CACHE_VERSION,
        LIBRARY_INDEX_VERSION: LIBRARY_INDEX_VERSION,
        LIBRARY_THUMB_PLACEHOLDER: LIBRARY_THUMB_PLACEHOLDER,
        LIBRARY_ENTRY_FIELDS: LIBRARY_ENTRY_FIELDS,
        normalizeFolderPath: normalizeFolderPath,
        deriveFolderValidityKey: deriveFolderValidityKey,
        normalizeLibraryEntry: normalizeLibraryEntry,
        normalizeMediaEntry: normalizeMediaEntry,
        deriveFolderValidityKeyAsync: deriveFolderValidityKeyAsync,
        deriveCombinedValidityKeyAsync: deriveCombinedValidityKeyAsync,
        ROOT_MANIFEST_KEY: ROOT_MANIFEST_KEY,
        ROOT_MANIFEST_VERSION: ROOT_MANIFEST_VERSION,
        INDEX_KEY: INDEX_KEY,
        INDEX_STAGING_KEY: INDEX_STAGING_KEY,
        INDEX_PREV_KEY: INDEX_PREV_KEY,
        commitVerifiedLocalStorage: commitVerifiedLocalStorage,
        libraryIndexPayloadVerifies: libraryIndexPayloadVerifies,
        saveLibraryIndex: saveLibraryIndex,
        loadLibraryIndex: loadLibraryIndex,
        VALIDITY_KEY_PREFIX: VALIDITY_KEY_PREFIX,
        VALIDITY_FIELD_SEP: VALIDITY_FIELD_SEP,
        loadRootManifest: loadRootManifest,
        getRootGeneration: getRootGeneration,
        bumpRootGeneration: bumpRootGeneration,
        deriveRootSignature: deriveRootSignature,
        deriveRootSignatureAsync: deriveRootSignatureAsync,
        buildCombinedValidityKey: buildCombinedValidityKey,
        parseCombinedValidityKey: parseCombinedValidityKey,
        resolveValidityPaths: resolveValidityPaths,
        getCombinedDiskValidityKey: getCombinedDiskValidityKey,
        saveMetadataCache: saveMetadataCache,
        loadMetadataCache: loadMetadataCache,
        persistTemplateMetadata: persistTemplateMetadata,
        getLastLibraryIndexLoadReason: getLastLibraryIndexLoadReason,
        MetadataCache: MetadataCache,
        LibraryIndex: LibraryIndex,
        MediaEntryRepository: MediaEntryRepository
    };
}
