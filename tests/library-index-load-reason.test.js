/**
 * Library_Index — loadLibraryIndex() load-reason channel
 * ======================================================
 * Feature: panel-reopen-startup, task 2.2 (example tests, no property tests).
 *
 * Covers the reason channel added at the `loadLibraryIndex()` call site in
 * `js/core/persistence.js`: the function switched from `LibraryIndex.parse` to
 * `LibraryIndex.tryParse` so the failure mode is observable, and records WHY the
 * returned index looks the way it does in `getLastLibraryIndexLoadReason()`.
 *
 * Two things are asserted for every input class:
 *   1. the recorded reason (`absent`, `index-parsed`, `index-empty`, `corrupt`,
 *      `no-index-object`, plus the initial `not-loaded`), and
 *   2. that the fields copied onto the singleton (`_entries`, `version`,
 *      `validityKey`) are byte-identical to what the pre-change
 *      `LibraryIndex.parse` call site produced — including the deliberate
 *      pre-existing behaviour that `_needsFullScan` is NOT copied.
 *
 * `loadLibraryIndex` is not part of the CommonJS export tail (it is a bare
 * global for CEP <script> inclusion) and it reads the free globals
 * `localStorage` and `getLibraryIndex`. It is therefore loaded the same way the
 * other suites load a bare-global module: real source evaluated in a `vm`
 * context whose globals are the injected fakes. No mocks of the logic under
 * test — the real `LibraryIndex` runs inside that context.
 *
 * _Requirements: 1.7, 1.10_
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The required module gives the REFERENCE `LibraryIndex.parse` — the exact
// function the call site used before this wave — so "matches the pre-change
// parse behaviour" is asserted against the real thing, not a restatement.
const { LibraryIndex: ReferenceLibraryIndex } = require("../js/core/persistence.js");

const ROOT = path.resolve(__dirname, "..");
const PERSISTENCE_SOURCE = fs.readFileSync(
    path.join(ROOT, "js/core/persistence.js"),
    "utf8"
);

// ─── Harness ─────────────────────────────────────────────────────────────────
/**
 * Evaluate the real persistence source in a fresh sandbox.
 *
 * options:
 *   stored       string to serve from localStorage["compSaver_libraryIndex"],
 *                or omitted/null for "no stored string"
 *   noSingleton  when true, `getLibraryIndex` is never defined, so
 *                `loadLibraryIndex` sees no index object
 */
function loadPersistence(options) {
    options = options || {};

    const store = {};
    if (typeof options.stored === "string") {
        store["compSaver_libraryIndex"] = options.stored;
    }

    const context = {
        console: console,
        module: { exports: {} },
        exports: {},
        localStorage: {
            getItem: function (key) {
                return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
            },
            setItem: function (key, value) {
                store[key] = String(value);
            },
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(PERSISTENCE_SOURCE, context, { filename: "persistence.js" });

    // The singleton the panel owns. Built with the in-context constructor so the
    // whole exercise runs against one realm.
    let singleton = null;
    if (options.noSingleton !== true) {
        singleton = new context.LibraryIndex();
        context.getLibraryIndex = function () {
            return singleton;
        };
    }

    return {
        context: context,
        store: store,
        singleton: singleton,
        loadLibraryIndex: context.loadLibraryIndex,
        getLastLibraryIndexLoadReason: context.getLastLibraryIndexLoadReason,
    };
}

// A serialized index with several entries, written through the public mutation
// so normalization/de-duplication is the real one.
function serializedMultiEntryIndex() {
    const index = new ReferenceLibraryIndex({ validityKey: "12:4096:1700000000000" });
    index.insertAtHead({
        folderPath: "root/Titles/lower-third",
        id: "tpl-1",
        name: "Lower Third",
        category: "Titles",
        thumbStatus: "ready",
        favorite: false,
    });
    index.insertAtHead({
        folderPath: "root\\Transitions\\wipe\\",
        id: "tpl-2",
        name: "Wipe",
        category: "Transitions",
        thumbStatus: "placeholder",
        favorite: true,
    });
    index.insertAtHead({
        folderPath: "root/Titles/kinetic",
        id: "tpl-3",
        name: "Kinetic",
        category: "Titles",
    });
    return index.serialize();
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe("loadLibraryIndex() load-reason channel", () => {
    test("the reason is 'not-loaded' before any call", () => {
        const h = loadPersistence();
        expect(h.getLastLibraryIndexLoadReason()).toBe("not-loaded");
    });

    test("no stored string yields reason 'absent' and leaves the singleton untouched", () => {
        const h = loadPersistence(); // nothing in localStorage

        const li = h.loadLibraryIndex();

        expect(h.getLastLibraryIndexLoadReason()).toBe("absent");
        expect(li).toBe(h.singleton);
        expect(li._entries).toEqual([]);
        expect(li.validityKey).toBe(null);
    });

    test("a valid multi-entry index yields 'index-parsed' with fields identical to parse()", () => {
        const stored = serializedMultiEntryIndex();
        const h = loadPersistence({ stored: stored });

        const li = h.loadLibraryIndex();
        const reference = ReferenceLibraryIndex.parse(stored); // pre-change behaviour

        expect(h.getLastLibraryIndexLoadReason()).toBe("index-parsed");
        expect(li).toBe(h.singleton);
        expect(li._entries).toEqual(reference._entries);
        expect(li._entries.length).toBe(3);
        expect(li.version).toBe(reference.version);
        expect(li.validityKey).toBe(reference.validityKey);
        expect(li.validityKey).toBe("12:4096:1700000000000");
        // Head-first order and path normalization survive the load unchanged.
        expect(li._entries.map((e) => e.folderPath)).toEqual([
            "root/Titles/kinetic",
            "root/Transitions/wipe",
            "root/Titles/lower-third",
        ]);
    });

    test("a valid but zero-entry index yields reason 'index-empty'", () => {
        const stored = new ReferenceLibraryIndex({ validityKey: "0:0:0" }).serialize();
        const h = loadPersistence({ stored: stored });

        const li = h.loadLibraryIndex();
        const reference = ReferenceLibraryIndex.parse(stored);

        expect(h.getLastLibraryIndexLoadReason()).toBe("index-empty");
        expect(li._entries).toEqual([]);
        expect(li.version).toBe(reference.version);
        expect(li.validityKey).toBe("0:0:0");
    });

    test("invalid JSON yields reason 'corrupt' with an empty entry set and null validityKey", () => {
        const stored = '{"version":1,"validityKey":"k","entries":[{"folderPath":"a"';
        const h = loadPersistence({ stored: stored });

        const li = h.loadLibraryIndex();
        const reference = ReferenceLibraryIndex.parse(stored); // empty index, key null

        expect(h.getLastLibraryIndexLoadReason()).toBe("corrupt");
        expect(li._entries).toEqual([]);
        expect(li.validityKey).toBe(null);
        expect(li.version).toBe(reference.version);
        expect(li.validityKey).toBe(reference.validityKey);
        expect(li._entries).toEqual(reference._entries);
    });

    test("a wrong-shaped object yields reason 'corrupt' with the same outcome as parse()", () => {
        // Valid JSON, but `entries` is not an array — tryParse reports ok=false.
        const stored = '{"version":1,"validityKey":"k","entries":"not-an-array"}';
        const h = loadPersistence({ stored: stored });

        const li = h.loadLibraryIndex();
        const reference = ReferenceLibraryIndex.parse(stored);

        expect(h.getLastLibraryIndexLoadReason()).toBe("corrupt");
        expect(li._entries).toEqual([]);
        expect(li.validityKey).toBe(null);
        expect(li.version).toBe(reference.version);
        expect(li.validityKey).toBe(reference.validityKey);
        expect(li._entries).toEqual(reference._entries);
    });

    test("no index object yields reason 'no-index-object' and a null return", () => {
        const h = loadPersistence({ stored: serializedMultiEntryIndex(), noSingleton: true });

        const li = h.loadLibraryIndex();

        expect(li).toBe(null);
        expect(h.getLastLibraryIndexLoadReason()).toBe("no-index-object");
    });

    test("_needsFullScan is still not copied onto the singleton on corrupt input", () => {
        const stored = "not json at all";
        const h = loadPersistence({ stored: stored });

        const li = h.loadLibraryIndex();

        // parse() raises the flag on the index IT returns...
        expect(ReferenceLibraryIndex.parse(stored)._needsFullScan).toBe(true);
        // ...but loadLibraryIndex has never copied that field onto the singleton,
        // and this wave preserves that behaviour exactly.
        expect(h.getLastLibraryIndexLoadReason()).toBe("corrupt");
        expect(li._needsFullScan).toBe(false);
        expect(li.needsFullScan()).toBe(false);
    });

    test("_needsFullScan is not copied on a valid load either", () => {
        const h = loadPersistence({ stored: serializedMultiEntryIndex() });

        const li = h.loadLibraryIndex();

        expect(li._needsFullScan).toBe(false);
        expect(li.needsFullScan()).toBe(false);
    });

    test("the reason reflects only the most recent load", () => {
        const h = loadPersistence({ stored: serializedMultiEntryIndex() });

        h.loadLibraryIndex();
        expect(h.getLastLibraryIndexLoadReason()).toBe("index-parsed");

        delete h.store["compSaver_libraryIndex"];
        h.loadLibraryIndex();
        expect(h.getLastLibraryIndexLoadReason()).toBe("absent");
    });
});
