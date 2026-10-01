"use strict";

// Atomic, crash-safe persistence properties for feature panel-reopen-startup
// (tasks 10.3, 10.4, 10.5 — design section 6 "Atomic, crash-safe persistence",
// Requirement 9).
//
// Every property runs the REAL js/core/persistence.js inside a vm realm, the same
// pattern tests/performance/startup-lifecycle.property.test.js uses for its
// degraded-index realm. Nothing the module owns is reimplemented here:
//   * "verifying" is decided by the shipped LibraryIndex.tryParse(...).ok === true
//   * the load reason is read from the shipped getLastLibraryIndexLoadReason()
//   * every expected entry set comes from the shipped tryParse / MetadataCache.parse
//   * every expected payload string is the string the module itself handed the double
// The harness only supplies the seams the module reaches for: localStorage, nfs(),
// libraryPaths, getLibraryIndex, getMetadataCache, console.
//
// CRASH MODEL. A power cut or a killed process cannot resume mid-sequence, so a
// truncated write is modelled as a truncated write FOLLOWED BY DEATH: the double
// stops accepting any further mutation. localStorage additionally gets the two
// survivable failure modes a real browser produces and the module is expected to
// defend against: a throwing setItem (quota) and a setItem that silently stores a
// truncated string and returns normally.

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

jest.setTimeout(600000);

const ROOT = path.resolve(__dirname, "../..");
const PERSISTENCE_SOURCE = nodeFs.readFileSync(path.join(ROOT, "js/core/persistence.js"), "utf8");
const PERSISTENCE_SCRIPT = new vm.Script(PERSISTENCE_SOURCE, { filename: "persistence.js" });

// Index_Store keys. Asserted against the module's own exports by an example test
// below, so a rename in the product cannot leave these silently stale.
const INDEX_KEY = "compSaver_libraryIndex";
const INDEX_STAGING_KEY = "compSaver_libraryIndex__staging";
const INDEX_PREV_KEY = "compSaver_libraryIndex__prev";
const LADDER = [INDEX_KEY, INDEX_STAGING_KEY, INDEX_PREV_KEY];

const METADATA_SUFFIX = "/.compsaver_metadata.json";
const METADATA_TMP_SUFFIX = "/.compsaver_metadata.json.tmp";

const WARN_WRITE = "[CompSaver] Failed to write metadata cache for";
const WARN_LOAD = "[CompSaver] Failed to load metadata cache for";

// ─── realm ───────────────────────────────────────────────────────────────────

/**
 * The real persistence module in its own realm. `localStorage`, `nfs()`, and
 * `libraryPaths` are the only host seams injected up front; `getLibraryIndex`
 * and `getMetadataCache` are attached by the caller after load because the
 * module only resolves them at call time.
 */
function createRealm(options) {
    const opts = options || {};
    const warnings = [];
    const errors = [];
    const context = {
        console: {
            log: function () { },
            error: function () {
                errors.push(Array.prototype.slice.call(arguments).map(formatArg).join(" "));
            },
            warn: function () {
                warnings.push(Array.prototype.slice.call(arguments).map(formatArg).join(" "));
            },
        },
        module: { exports: {} },
        exports: {},
    };
    if (opts.localStorage) context.localStorage = opts.localStorage;
    if (opts.fsDouble) {
        context.nfs = function () { return opts.fsDouble; };
    }
    if (opts.libraryPaths) context.libraryPaths = opts.libraryPaths.slice();
    context.window = context;
    vm.createContext(context);
    PERSISTENCE_SCRIPT.runInContext(context);
    return { context: context, warnings: warnings, errors: errors };
}

function formatArg(value) {
    if (value instanceof Error) return value.message;
    try {
        return String(value);
    } catch (e) {
        return "<unstringifiable>";
    }
}

function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

// A serialized index built THROUGH the module, so the payload under test is
// exactly what the product writes rather than a hand-rolled lookalike.
function realmIndex(context, entries, validityKey, version) {
    const envelope = {
        version: typeof version === "number" ? version : context.LIBRARY_INDEX_VERSION,
        validityKey: validityKey === undefined ? null : validityKey,
        entries: entries,
    };
    return context.LibraryIndex.tryParse(JSON.stringify(envelope)).index;
}

function payloadVerifies(context, payload) {
    if (typeof payload !== "string" || payload === "") return false;
    try {
        const res = context.LibraryIndex.tryParse(payload);
        return !!(res && res.ok === true);
    } catch (e) {
        return false;
    }
}

// The recovery ladder as Requirements 9.6/9.7/9.9 state it: the committed key
// first, then staging (newer than previous-good), then previous-good; a payload
// whose version is ahead of this build fences the ladder instead of being read.
function ladderAcceptedKey(context, snapshot) {
    for (let i = 0; i < LADDER.length; i++) {
        const raw = snapshot[LADDER[i]];
        if (typeof raw !== "string" || raw === "") continue;
        let res = null;
        try {
            res = context.LibraryIndex.tryParse(raw);
        } catch (e) {
            res = null;
        }
        if (!res || res.ok !== true) continue;
        const version = res.index.version;
        if (typeof version === "number" && isFinite(version) && version > context.LIBRARY_INDEX_VERSION) {
            return { key: null, fenced: true };
        }
        return { key: LADDER[i], fenced: false };
    }
    return { key: null, fenced: false };
}

// ─── generators shared by properties 15 and 16 ───────────────────────────────

const nameArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);

const entryArb = fc.record({
    id: nameArb,
    name: nameArb,
    category: fc.constantFrom("All", "Titles", "Lower Thirds"),
    section: fc.constantFrom("comp", "icon", "text", "effect"),
    folderPath: fc
        .array(nameArb, { minLength: 2, maxLength: 4 })
        .map(function (segments) { return "C:/lib/" + segments.join("/"); }),
    thumbStatus: fc.constantFrom("placeholder", "ready"),
    favorite: fc.boolean(),
});

const validityKeyArb = fc.oneof(
    fc.constant(null),
    fc.string({ maxLength: 10 }),
    fc.constant("cskey2|C:/lib\u001f3\u001f7:2048:1700000000000")
);

function truncatePayload(value, keepPercent) {
    const len = value.length;
    if (len === 0) return "";
    const keep = Math.floor((len * keepPercent) / 100);
    return value.slice(0, Math.max(0, Math.min(len - 1, keep)));
}

// ─── Property 15 harness: an interruptible localStorage ───────────────────────

/**
 * A localStorage double that can be interrupted at any step of the write
 * sequence. Every mutation (setItem / removeItem) consumes one step index, and
 * the generated plan decides what happens at step `plan.step`:
 *
 *   "throw"    — setItem/removeItem throws, as a quota-exceeded host does
 *   "truncate" — setItem silently stores a PREFIX of the string and returns
 *   "die"      — the process dies: this mutation and every later one are lost
 *   "none"     — the whole sequence runs cleanly
 *
 * It also watches for destruction of the last good copy: before any mutation
 * that removes or overwrites a verifying Index_Store payload, it records a
 * violation when no OTHER Index_Store key holds a verifying payload
 * (Requirement 9.8). `verify` is the shipped verifier, injected after the realm
 * exists.
 */
function createCrashStore(plan) {
    const data = {};
    const violations = [];
    let step = 0;
    let dead = false;
    let verify = function () { return false; };

    function holds(key) {
        const raw = data[key];
        if (typeof raw !== "string" || raw === "") return false;
        try {
            return verify(raw) === true;
        } catch (e) {
            return false;
        }
    }

    function noteDestruction(key, nextValue) {
        if (LADDER.indexOf(key) < 0) return;
        if (!holds(key)) return;
        let nextOk = false;
        if (typeof nextValue === "string" && nextValue !== "") {
            try {
                nextOk = verify(nextValue) === true;
            } catch (e) {
                nextOk = false;
            }
        }
        if (nextOk) return;
        for (let i = 0; i < LADDER.length; i++) {
            if (LADDER[i] !== key && holds(LADDER[i])) return;
        }
        violations.push({ key: key, kind: nextValue === null ? "removed" : "overwritten" });
    }

    return {
        data: data,
        violations: violations,
        setVerify: function (fn) { verify = fn; },
        snapshot: function () {
            const out = {};
            for (const key in data) {
                if (has(data, key)) out[key] = data[key];
            }
            return out;
        },
        getItem: function (key) {
            return has(data, key) ? data[key] : null;
        },
        setItem: function (key, value) {
            const current = step++;
            if (dead) return;
            let stored = String(value);
            if (current === plan.step) {
                if (plan.mode === "throw") throw new Error("QuotaExceededError");
                if (plan.mode === "die") { dead = true; return; }
                if (plan.mode === "truncate") stored = truncatePayload(stored, plan.keepPercent);
            }
            noteDestruction(key, stored);
            data[key] = stored;
        },
        removeItem: function (key) {
            const current = step++;
            if (dead) return;
            if (current === plan.step) {
                if (plan.mode === "throw") throw new Error("QuotaExceededError");
                if (plan.mode === "die") { dead = true; return; }
            }
            noteDestruction(key, null);
            delete data[key];
        },
    };
}

const crashScenarioArb = fc.record({
    plan: fc.record({
        // The save sequence performs at most four mutations (stage, promote,
        // commit, clear); steps past that leave the sequence uninterrupted.
        step: fc.integer({ min: 0, max: 6 }),
        mode: fc.constantFrom("none", "throw", "truncate", "die"),
        keepPercent: fc.integer({ min: 0, max: 95 }),
    }),
    // The known-good prior payload the committed key already holds, so recovery
    // always has something to find. Zero entries still verifies (index-empty).
    priorEntries: fc.array(entryArb, { maxLength: 4 }),
    priorKey: validityKeyArb,
    nextEntries: fc.array(entryArb, { maxLength: 5 }),
    nextKey: validityKeyArb,
    seedStaging: fc.constantFrom("absent", "good", "corrupt"),
    stagingEntries: fc.array(entryArb, { minLength: 1, maxLength: 3 }),
    seedPrev: fc.constantFrom("absent", "good", "corrupt"),
    prevEntries: fc.array(entryArb, { minLength: 1, maxLength: 3 }),
});

function runCrashScenario(scenario) {
    const store = createCrashStore(scenario.plan);
    const realm = createRealm({ localStorage: store });
    const context = realm.context;
    store.setVerify(function (payload) { return payloadVerifies(context, payload); });

    // Seed the store directly (not through setItem) so the step counter starts at
    // the first mutation the save itself performs.
    store.data[INDEX_KEY] = realmIndex(context, scenario.priorEntries, scenario.priorKey).serialize();
    if (scenario.seedStaging === "good") {
        store.data[INDEX_STAGING_KEY] = realmIndex(context, scenario.stagingEntries, "stale-staging").serialize();
    } else if (scenario.seedStaging === "corrupt") {
        store.data[INDEX_STAGING_KEY] = '{"version":1,"validityKey":null,"entries":';
    }
    if (scenario.seedPrev === "good") {
        store.data[INDEX_PREV_KEY] = realmIndex(context, scenario.prevEntries, "previous-good").serialize();
    } else if (scenario.seedPrev === "corrupt") {
        store.data[INDEX_PREV_KEY] = "not json at all";
    }

    const nextIndex = realmIndex(context, scenario.nextEntries, scenario.nextKey);
    context.getLibraryIndex = function () { return nextIndex; };

    let threw = null;
    try {
        context.saveLibraryIndex();
    } catch (e) {
        threw = e;
    }

    const storeAfterSave = store.snapshot();
    const verifyingKeys = LADDER.filter(function (key) {
        return payloadVerifies(context, storeAfterSave[key]);
    });
    const accepted = ladderAcceptedKey(context, storeAfterSave);

    // Load with a fresh singleton so the entries observed are exactly the ones
    // this load consumed.
    const fresh = new context.LibraryIndex();
    context.getLibraryIndex = function () { return fresh; };
    let loaded = null;
    try {
        loaded = context.loadLibraryIndex();
    } catch (e) {
        if (threw === null) threw = e;
    }

    let expectedEntries = null;
    let expectedValidityKey = null;
    let expectedReason = null;
    if (accepted.key !== null) {
        const res = context.LibraryIndex.tryParse(storeAfterSave[accepted.key]);
        expectedEntries = res.index._entries;
        expectedValidityKey = res.index.validityKey;
        if (accepted.key === INDEX_STAGING_KEY) expectedReason = "recovered-staging";
        else if (accepted.key === INDEX_PREV_KEY) expectedReason = "recovered-previous";
        else expectedReason = expectedEntries.length > 0 ? "index-parsed" : "index-empty";
    }

    return {
        threw: threw,
        violations: store.violations,
        verifyingKeys: verifyingKeys,
        acceptedKey: accepted.key,
        storeAfterSave: storeAfterSave,
        storeAfterLoad: store.snapshot(),
        reason: context.getLastLibraryIndexLoadReason(),
        loadedEntries: loaded ? loaded._entries : null,
        loadedValidityKey: loaded ? loaded.validityKey : undefined,
        expectedEntries: expectedEntries,
        expectedValidityKey: expectedValidityKey,
        expectedReason: expectedReason,
    };
}

describe("Index_Store crash safety", () => {
    // Feature: panel-reopen-startup, Property 15: A verifying index payload survives any crash point
    // **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8**
    test("Property 15: a verifying index payload survives any crash point", () => {
        fc.assert(
            fc.property(crashScenarioArb, (scenario) => {
                const outcome = runCrashScenario(scenario);

                // No exception escapes either path (Requirement 9.14).
                expect(outcome.threw).toBe(null);

                // At least one key of Index_Store still holds a verifying payload,
                // whatever the interruption was (Requirements 9.1-9.5).
                expect(outcome.verifyingKeys.length).toBeGreaterThanOrEqual(1);

                // No verifying payload was removed or overwritten while it was the
                // only verifying payload present (Requirement 9.8).
                expect(outcome.violations).toEqual([]);

                // loadLibraryIndex accepts the newest verifying candidate along the
                // INDEX -> STAGING -> PREV ladder (Requirement 9.6) ...
                expect(outcome.acceptedKey).not.toBe(null);
                expect(outcome.loadedEntries).toEqual(outcome.expectedEntries);
                expect(outcome.loadedValidityKey).toBe(outcome.expectedValidityKey);

                // ... and the reported reason names the key it recovered from
                // (Requirement 9.7).
                expect(outcome.reason).toBe(outcome.expectedReason);

                // A load consumes payloads, it never rewrites the store.
                expect(outcome.storeAfterLoad).toEqual(outcome.storeAfterSave);
                return true;
            }),
            { numRuns: 15, seed: 91001, verbose: 2 }
        );
    });

    test("the Index_Store key names under test are the module's own", () => {
        const persistence = require("../../js/core/persistence.js");
        expect(persistence.INDEX_KEY).toBe(INDEX_KEY);
        expect(persistence.INDEX_STAGING_KEY).toBe(INDEX_STAGING_KEY);
        expect(persistence.INDEX_PREV_KEY).toBe(INDEX_PREV_KEY);
    });

    test("a clean save commits, clears staging, and keeps the prior payload as previous-good", () => {
        const outcome = runCrashScenario({
            plan: { step: 9, mode: "none", keepPercent: 0 },
            priorEntries: [{ id: "old", name: "old", folderPath: "C:/lib/comp/a/old" }],
            priorKey: "old-key",
            nextEntries: [{ id: "new", name: "new", folderPath: "C:/lib/comp/a/new" }],
            nextKey: "new-key",
            seedStaging: "absent",
            stagingEntries: [],
            seedPrev: "absent",
            prevEntries: [],
        });
        expect(outcome.acceptedKey).toBe(INDEX_KEY);
        expect(outcome.reason).toBe("index-parsed");
        expect(outcome.loadedValidityKey).toBe("new-key");
        expect(has(outcome.storeAfterSave, INDEX_STAGING_KEY)).toBe(false);
        expect(outcome.storeAfterSave[INDEX_PREV_KEY]).toContain("old-key");
    });

    test("a truncated commit recovers the promoted previous-good payload, never the truncated one", () => {
        // Step 2 is the commit write, and "truncate" is the SURVIVABLE host
        // failure: setItem silently stores a prefix and returns, so the sequence
        // runs on through step 4's `removeItem(STAGING)`. By then step 3 has
        // already promoted the verifying committed payload into PREV, so staging
        // is not the only verifying copy and clearing it is exactly the sequence
        // Requirement 9.4 prescribes, with Requirement 9.8 satisfied by PREV.
        // The recovery therefore lands on PREV, holding the prior payload.
        const outcome = runCrashScenario({
            plan: { step: 2, mode: "truncate", keepPercent: 40 },
            priorEntries: [{ id: "old", name: "old", folderPath: "C:/lib/comp/a/old" }],
            priorKey: "old-key",
            nextEntries: [{ id: "new", name: "new", folderPath: "C:/lib/comp/a/new" }],
            nextKey: "new-key",
            seedStaging: "absent",
            stagingEntries: [],
            seedPrev: "absent",
            prevEntries: [],
        });
        // The truncated payload never becomes the loaded index, and a full cold
        // scan is never the outcome: something verifying is always recovered.
        expect(outcome.threw).toBe(null);
        expect(outcome.verifyingKeys.indexOf(INDEX_KEY)).toBe(-1);
        expect(outcome.verifyingKeys).toContain(INDEX_PREV_KEY);
        expect(outcome.acceptedKey).toBe(INDEX_PREV_KEY);
        expect(outcome.reason).toBe("recovered-previous");
        expect(outcome.loadedValidityKey).toBe("old-key");
        expect(outcome.loadedEntries.length).toBe(1);
        expect(outcome.violations).toEqual([]);
    });

    test("a truncated commit falls back to previous-good once staging is cleared", () => {
        // Same truncated commit, but with a verifying previous-good copy present
        // the staging key may legitimately be cleared, so the ladder lands on PREV.
        const outcome = runCrashScenario({
            plan: { step: 2, mode: "truncate", keepPercent: 40 },
            priorEntries: [{ id: "old", name: "old", folderPath: "C:/lib/comp/a/old" }],
            priorKey: "old-key",
            nextEntries: [{ id: "new", name: "new", folderPath: "C:/lib/comp/a/new" }],
            nextKey: "new-key",
            seedStaging: "absent",
            stagingEntries: [],
            seedPrev: "good",
            prevEntries: [{ id: "prev", name: "prev", folderPath: "C:/lib/comp/a/prev" }],
        });
        expect(["recovered-staging", "recovered-previous"]).toContain(outcome.reason);
        expect(outcome.verifyingKeys.length).toBeGreaterThanOrEqual(1);
    });

    test("a quota throw on the staging write leaves the committed payload untouched", () => {
        const outcome = runCrashScenario({
            plan: { step: 0, mode: "throw", keepPercent: 0 },
            priorEntries: [{ id: "old", name: "old", folderPath: "C:/lib/comp/a/old" }],
            priorKey: "old-key",
            nextEntries: [{ id: "new", name: "new", folderPath: "C:/lib/comp/a/new" }],
            nextKey: "new-key",
            seedStaging: "absent",
            stagingEntries: [],
            seedPrev: "absent",
            prevEntries: [],
        });
        expect(outcome.threw).toBe(null);
        expect(outcome.acceptedKey).toBe(INDEX_KEY);
        expect(outcome.reason).toBe("index-parsed");
        expect(outcome.loadedValidityKey).toBe("old-key");
    });
});

// ─── Property 16 harness: the schema version fence ───────────────────────────

function createPlainStore(seed) {
    const data = {};
    if (seed) {
        for (const key in seed) {
            if (has(seed, key)) data[key] = seed[key];
        }
    }
    return {
        data: data,
        snapshot: function () {
            const out = {};
            for (const key in data) {
                if (has(data, key)) out[key] = data[key];
            }
            return out;
        },
        getItem: function (key) { return has(data, key) ? data[key] : null; },
        setItem: function (key, value) { data[key] = String(value); },
        removeItem: function (key) { delete data[key]; },
    };
}

const versionFenceArb = fc.record({
    // Real usable entries, so "consumed nothing" is never vacuously true.
    entries: fc.array(entryArb, { minLength: 1, maxLength: 5 }),
    validityKey: validityKeyArb,
    // Versions above and at/below the constant, plus the no-version envelope
    // (tryParse defaults it to this build's version, so it is consumable).
    delta: fc.integer({ min: -3, max: 4 }),
    omitVersion: fc.boolean(),
});

function runVersionFence(spec) {
    const store = createPlainStore();
    const realm = createRealm({ localStorage: store });
    const context = realm.context;

    const envelope = {
        version: context.LIBRARY_INDEX_VERSION + spec.delta,
        validityKey: spec.validityKey === undefined ? null : spec.validityKey,
        entries: spec.entries,
    };
    if (spec.omitVersion) delete envelope.version;
    const stored = JSON.stringify(envelope);
    store.data[INDEX_KEY] = stored;

    const fresh = new context.LibraryIndex();
    context.getLibraryIndex = function () { return fresh; };

    const protoBefore = Object.getOwnPropertyNames(context.LibraryIndex.prototype).slice().sort();

    let threw = null;
    let loaded = null;
    try {
        loaded = context.loadLibraryIndex();
    } catch (e) {
        threw = e;
    }

    const protoAfter = Object.getOwnPropertyNames(context.LibraryIndex.prototype).slice().sort();
    const expected = context.LibraryIndex.tryParse(stored);

    return {
        ahead: !spec.omitVersion && spec.delta > 0,
        threw: threw,
        reason: context.getLastLibraryIndexLoadReason(),
        entries: loaded ? loaded._entries : null,
        validityKey: loaded ? loaded.validityKey : undefined,
        storedBefore: stored,
        storeAfter: store.snapshot(),
        expectedEntries: expected.index._entries,
        expectedValidityKey: expected.index.validityKey,
        protoBefore: protoBefore,
        protoAfter: protoAfter,
        warnings: realm.warnings,
    };
}

describe("Index_Store schema version fence", () => {
    // Feature: panel-reopen-startup, Property 16: Schema versions are fenced in one direction only
    // **Validates: Requirements 9.9, 9.10, 9.14, 9.15**
    test("Property 16: versions ahead consume nothing, versions at or below are consumed", () => {
        fc.assert(
            fc.property(versionFenceArb, (spec) => {
                const outcome = runVersionFence(spec);

                // No exception escapes (Requirement 9.14) and the prototype is
                // untouched by either path (Requirement 9.15).
                expect(outcome.threw).toBe(null);
                expect(outcome.protoAfter).toEqual(outcome.protoBefore);

                // The stored string is left byte-identical, and the load adds no
                // key of its own (Requirement 9.9 "left in place").
                expect(outcome.storeAfter[INDEX_KEY]).toBe(outcome.storedBefore);
                expect(Object.keys(outcome.storeAfter).sort()).toEqual([INDEX_KEY]);

                if (outcome.ahead) {
                    // Requirement 9.9: no entries consumed, reason version-ahead.
                    expect(outcome.entries).toEqual([]);
                    expect(outcome.reason).toBe("version-ahead");
                } else {
                    // Requirement 9.10: consumed, with a reason from the existing set.
                    expect(outcome.entries).toEqual(outcome.expectedEntries);
                    expect(outcome.validityKey).toBe(outcome.expectedValidityKey);
                    expect(outcome.entries.length).toBeGreaterThan(0);
                    expect(outcome.reason).toBe(
                        outcome.expectedEntries.length > 0 ? "index-parsed" : "index-empty"
                    );
                }
                return true;
            }),
            { numRuns: 15, seed: 91002, verbose: 2 }
        );
    });

    test("a payload one version ahead is left in place with its entries unread", () => {
        const outcome = runVersionFence({
            entries: [
                { id: "a", name: "a", folderPath: "C:/lib/comp/x/a" },
                { id: "b", name: "b", folderPath: "C:/lib/comp/x/b" },
                { id: "c", name: "c", folderPath: "C:/lib/comp/x/c" },
            ],
            validityKey: "ahead-key",
            delta: 1,
            omitVersion: false,
        });
        expect(outcome.expectedEntries.length).toBe(3);
        expect(outcome.entries).toEqual([]);
        expect(outcome.reason).toBe("version-ahead");
        expect(outcome.storeAfter[INDEX_KEY]).toBe(outcome.storedBefore);
    });

    test("the same payload at the current version is consumed in full", () => {
        const outcome = runVersionFence({
            entries: [
                { id: "a", name: "a", folderPath: "C:/lib/comp/x/a" },
                { id: "b", name: "b", folderPath: "C:/lib/comp/x/b" },
                { id: "c", name: "c", folderPath: "C:/lib/comp/x/c" },
            ],
            validityKey: "current-key",
            delta: 0,
            omitVersion: false,
        });
        expect(outcome.entries.length).toBe(3);
        expect(outcome.reason).toBe("index-parsed");
        expect(outcome.validityKey).toBe("current-key");
    });
});

// ─── Property 17 harness: an interruptible filesystem ────────────────────────

/**
 * A filesystem double for Metadata_File writes.
 *
 *   rename: "succeed" — renameSync moves the temp file over the target
 *   rename: "throw"   — renameSync throws (cross-device / unsupported)
 *   rename: "absent"  — no renameSync member at all
 *
 * `crashAtWrite` picks the write that dies mid-flight: that write stores only a
 * prefix and the process is then dead, so no later write, rename, or unlink
 * happens. `writeFile` is present because the shipped guard is
 * `if (!fs || !fs.writeFile) return;`.
 */
function createFsDouble(config) {
    const files = {};
    const writes = [];
    const skipped = [];
    let dead = false;
    let writeIndex = 0;

    const api = {
        files: files,
        writes: writes,
        skipped: skipped,
        crashed: false,
        writeFile: function () { /* presence probe only */ },
        writeFileSync: function (filePath, data) {
            const current = writeIndex++;
            if (dead) {
                skipped.push({ path: filePath, reason: "dead" });
                return;
            }
            const intended = String(data);
            if (current === config.crashAtWrite) {
                const stored = truncatePayload(intended, config.keepPercent);
                files[filePath] = stored;
                dead = true;
                api.crashed = true;
                writes.push({ path: filePath, intended: intended, stored: stored, crashed: true });
                return;
            }
            files[filePath] = intended;
            writes.push({ path: filePath, intended: intended, stored: intended, crashed: false });
        },
        readFileSync: function (filePath) {
            if (config.readFails && config.readFails.indexOf(filePath) >= 0) {
                throw new Error("EACCES: " + filePath);
            }
            if (!has(files, filePath)) throw new Error("ENOENT: " + filePath);
            return files[filePath];
        },
        existsSync: function (filePath) {
            return has(files, filePath);
        },
        unlinkSync: function (filePath) {
            if (dead) return;
            delete files[filePath];
        },
    };

    if (config.rename === "succeed") {
        api.renameSync = function (from, to) {
            if (dead) return;
            if (!has(files, from)) throw new Error("ENOENT: " + from);
            files[to] = files[from];
            delete files[from];
        };
    } else if (config.rename === "throw") {
        api.renameSync = function () {
            if (dead) return;
            throw new Error("EXDEV: cross-device link not permitted");
        };
    }
    return api;
}

function metadataValueFor(seed, index) {
    return { payload: seed, slot: index };
}

function seedCache(context, root, tag, count, seed) {
    const cache = new context.MetadataCache();
    for (let j = 0; j < count; j++) {
        cache.put(root + "/comp/cat/" + tag + j, metadataValueFor(seed, j), "vk-" + tag + "-" + j);
    }
    return cache;
}

function snapshotFiles(files) {
    const out = {};
    for (const key in files) {
        if (has(files, key)) out[key] = files[key];
    }
    return out;
}

// loadMetadataCache's contract, read off the final file state (Requirement 9.13):
// the target when it carries entries, else the .tmp sibling when it carries
// entries, else nothing.
function expectedRecoveredEntries(context, files, target, tmp) {
    const targetEntries = has(files, target) ? context.MetadataCache.parse(files[target]).entries() : null;
    const tmpEntries = has(files, tmp) ? context.MetadataCache.parse(files[tmp]).entries() : null;
    if (targetEntries !== null && targetEntries.length > 0) return targetEntries;
    if (tmpEntries !== null && tmpEntries.length > 0) return tmpEntries;
    return [];
}

const metadataScenarioArb = fc.record({
    rootIds: fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 3 }),
    entryCounts: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 3, maxLength: 3 }),
    prevCounts: fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 3, maxLength: 3 }),
    metadataSeed: fc.oneof(
        fc.string({ maxLength: 8 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.boolean(),
        fc.constant(null),
        fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 3 })
    ),
    rename: fc.constantFrom("succeed", "throw", "absent"),
    crashAtWrite: fc.integer({ min: -1, max: 6 }),
    keepPercent: fc.integer({ min: 0, max: 95 }),
    seedTarget: fc.constantFrom("absent", "good", "corrupt"),
    seedTmp: fc.constantFrom("absent", "good"),
});

function runMetadataScenario(spec) {
    const roots = spec.rootIds.map(function (id) { return "C:/lib" + id; });
    const fsDouble = createFsDouble({
        rename: spec.rename,
        crashAtWrite: spec.crashAtWrite,
        keepPercent: spec.keepPercent,
        readFails: spec.readFails || null,
    });
    const realm = createRealm({ fsDouble: fsDouble, libraryPaths: roots });
    const context = realm.context;

    // Seed the previous on-disk state directly, so the write counter starts at the
    // first write saveMetadataCache itself performs.
    roots.forEach(function (root, i) {
        const target = root + METADATA_SUFFIX;
        const tmp = root + METADATA_TMP_SUFFIX;
        const prevCount = spec.prevCounts[i % spec.prevCounts.length];
        if (spec.seedTarget === "good") {
            fsDouble.files[target] = seedCache(context, root, "prev", prevCount, spec.metadataSeed).serialize();
        } else if (spec.seedTarget === "corrupt") {
            fsDouble.files[target] = '{"version":1,"entries":[{"folderPath":';
        }
        if (spec.seedTmp === "good") {
            fsDouble.files[tmp] = seedCache(context, root, "tmp", prevCount, spec.metadataSeed).serialize();
        }
    });
    const before = snapshotFiles(fsDouble.files);

    const live = new context.MetadataCache();
    roots.forEach(function (root, i) {
        const count = spec.entryCounts[i % spec.entryCounts.length];
        for (let j = 0; j < count; j++) {
            live.put(root + "/comp/cat/new" + j, metadataValueFor(spec.metadataSeed, j), "vk-new-" + j);
        }
    });
    context.getMetadataCache = function () { return live; };

    let saveThrew = null;
    try {
        context.saveMetadataCache();
    } catch (e) {
        saveThrew = e;
    }
    const afterSave = snapshotFiles(fsDouble.files);

    const recovered = new context.MetadataCache();
    context.getMetadataCache = function () { return recovered; };
    let loadThrew = null;
    try {
        context.loadMetadataCache();
    } catch (e) {
        loadThrew = e;
    }
    const recoveredEntries = recovered.entries();

    const perRoot = roots.map(function (root) {
        const target = root + METADATA_SUFFIX;
        const tmp = root + METADATA_TMP_SUFFIX;
        const mine = fsDouble.writes.filter(function (w) {
            return w.path === target || w.path === tmp;
        });
        const crashedHere = mine.filter(function (w) { return w.crashed === true; });
        const crashedOnTarget = crashedHere.filter(function (w) { return w.path === target; });
        return {
            root: root,
            target: target,
            tmp: tmp,
            wrote: mine.length > 0,
            crashedHere: crashedHere.length > 0,
            crashedOnTarget: crashedOnTarget.length > 0,
            crashedStored: crashedOnTarget.length > 0 ? crashedOnTarget[0].stored : null,
            // The full payload the module handed the filesystem for this root, so
            // "fully written with the new payload" is never a harness-built string.
            intended: mine.length > 0 ? mine[mine.length - 1].intended : null,
            prevContent: has(before, target) ? before[target] : null,
            targetAfter: has(afterSave, target) ? afterSave[target] : null,
            tmpSurvives: has(afterSave, tmp),
            recovered: recoveredEntries.filter(function (entry) {
                return String(entry.folderPath).indexOf(root + "/") === 0;
            }),
            expectedRecovered: expectedRecoveredEntries(context, afterSave, target, tmp),
        };
    });

    return {
        saveThrew: saveThrew,
        loadThrew: loadThrew,
        renameWorks: spec.rename === "succeed",
        warnings: realm.warnings,
        perRoot: perRoot,
        recoveredEntries: recoveredEntries,
        files: afterSave,
    };
}

function assertOnlyKnownWarnings(warnings) {
    for (let i = 0; i < warnings.length; i++) {
        const text = warnings[i];
        const known = text.indexOf(WARN_WRITE) === 0 || text.indexOf(WARN_LOAD) === 0;
        expect(known ? text : "unexpected console.warn: " + text).toBe(text);
        expect(known).toBe(true);
    }
}

describe("Metadata_File atomic writes", () => {
    // Feature: panel-reopen-startup, Property 17: Metadata cache writes are atomic or fall back cleanly
    // **Validates: Requirements 9.11, 9.12, 9.13, 9.14**
    test("Property 17: metadata cache writes are atomic or fall back cleanly", () => {
        fc.assert(
            fc.property(metadataScenarioArb, (spec) => {
                const outcome = runMetadataScenario(spec);

                // Requirement 9.14: no exception escapes either function, and the
                // only warnings are the two existing per-root texts.
                expect(outcome.saveThrew).toBe(null);
                expect(outcome.loadThrew).toBe(null);
                assertOnlyKnownWarnings(outcome.warnings);

                outcome.perRoot.forEach(function (root) {
                    if (root.crashedOnTarget) {
                        // The only way a crash can land ON the target is the
                        // documented Requirement 9.12 fallback: the direct write
                        // CompSaver already performs when renameSync is missing or
                        // fails. Assert the fallback really was in play, and that
                        // the result is today's truncated prefix and nothing worse.
                        expect(outcome.renameWorks).toBe(false);
                        expect(root.targetAfter).toBe(root.crashedStored);
                        expect(String(root.intended).indexOf(root.targetAfter)).toBe(0);
                    } else {
                        // Requirement 9.11: the target is whole — either fully
                        // written with the new payload, or unchanged with its
                        // previous payload. Never a partial write.
                        const acceptable = [root.prevContent];
                        if (root.intended !== null) acceptable.push(root.intended);
                        expect(acceptable).toContain(root.targetAfter);
                    }

                    // No temp file survives a save that ran to completion.
                    if (root.wrote && !root.crashedHere) {
                        expect(root.tmpSurvives).toBe(false);
                    }

                    // Requirement 9.13: the sibling is the recovery source when the
                    // target is absent or carries no entries.
                    expect(root.recovered).toEqual(root.expectedRecovered);
                });
                return true;
            }),
            { numRuns: 15, seed: 91003, verbose: 2 }
        );
    });

    test("a working renameSync commits the whole payload and leaves no temp file", () => {
        const outcome = runMetadataScenario({
            rootIds: [0],
            entryCounts: [2, 0, 0],
            prevCounts: [1, 1, 1],
            metadataSeed: "seed",
            rename: "succeed",
            crashAtWrite: -1,
            keepPercent: 0,
            seedTarget: "good",
            seedTmp: "absent",
        });
        const root = outcome.perRoot[0];
        expect(root.targetAfter).toBe(root.intended);
        expect(root.tmpSurvives).toBe(false);
        expect(root.recovered.length).toBe(2);
        expect(outcome.warnings).toEqual([]);
    });

    test("an absent renameSync degrades to the direct write and clears any temp sibling", () => {
        const outcome = runMetadataScenario({
            rootIds: [1],
            entryCounts: [2, 0, 0],
            prevCounts: [1, 1, 1],
            metadataSeed: 7,
            rename: "absent",
            crashAtWrite: -1,
            keepPercent: 0,
            seedTarget: "good",
            seedTmp: "good",
        });
        const root = outcome.perRoot[0];
        expect(root.targetAfter).toBe(root.intended);
        expect(root.tmpSurvives).toBe(false);
        expect(root.recovered.length).toBe(2);
    });

    test("a crash during the temp write leaves the previous payload in place", () => {
        const outcome = runMetadataScenario({
            rootIds: [2],
            entryCounts: [2, 0, 0],
            prevCounts: [2, 2, 2],
            metadataSeed: "seed",
            rename: "succeed",
            crashAtWrite: 0,
            keepPercent: 50,
            seedTarget: "good",
            seedTmp: "absent",
        });
        const root = outcome.perRoot[0];
        expect(root.targetAfter).toBe(root.prevContent);
        expect(root.recovered.length).toBe(2);
        expect(root.recovered[0].folderPath).toContain("/prev");
    });

    test("a crash on the fallback direct write leaves the full payload recoverable from the sibling", () => {
        const outcome = runMetadataScenario({
            rootIds: [3],
            entryCounts: [2, 0, 0],
            prevCounts: [1, 1, 1],
            metadataSeed: "seed",
            rename: "throw",
            crashAtWrite: 1,
            keepPercent: 50,
            seedTarget: "good",
            seedTmp: "absent",
        });
        const root = outcome.perRoot[0];
        expect(root.crashedOnTarget).toBe(true);
        expect(root.tmpSurvives).toBe(true);
        expect(root.recovered.length).toBe(2);
        expect(root.recovered[0].folderPath).toContain("/new");
    });

    test("an unreadable target recovers from the temp sibling and keeps the existing warn text", () => {
        const roots = ["C:/lib4"];
        const target = roots[0] + METADATA_SUFFIX;
        const outcome = runMetadataScenario({
            rootIds: [4],
            entryCounts: [0, 0, 0],
            prevCounts: [2, 2, 2],
            metadataSeed: "seed",
            rename: "succeed",
            crashAtWrite: -1,
            keepPercent: 0,
            seedTarget: "good",
            seedTmp: "good",
            readFails: [target],
        });
        const root = outcome.perRoot[0];
        expect(root.wrote).toBe(false);
        expect(root.recovered.length).toBe(2);
        expect(root.recovered[0].folderPath).toContain("/tmp");
        expect(outcome.warnings.length).toBe(1);
        expect(outcome.warnings[0].indexOf(WARN_LOAD)).toBe(0);
    });
});
