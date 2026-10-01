/**
 * Cross-panel races — focused examples
 * ====================================
 *
 * Feature: Phase 1, M4 (task 30)
 *
 * What is under test
 * ------------------
 * (a) js/core/persistence.js `bumpRootGeneration` — the shared root manifest
 *     lives in storage visible to every open panel, so the bump must survive
 *     a concurrent panel writer: write, RE-READ, verify the stored generation
 *     is monotonic with the one written, and retry from the freshly read
 *     value a bounded number of times when a concurrent write clobbered it.
 * (b) js/core/fastMediaEngine.js default mediaId generation — two panels
 *     running in the same millisecond with equal sequence counters must mint
 *     DISTINCT ids (per-panel session nonce), so their mediaIdFolderSegment
 *     folders can never collide and two panels can never write into the same
 *     media folder simultaneously.
 *
 * Only the environment is faked: an in-memory localStorage with a setItem
 * interceptor that models the racing panel, and one vm realm per simulated
 * panel for the media engine.
 */

"use strict";

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadHelpers } = require("./helpers/loadHelpers.js");

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SCRIPT = new vm.Script(nodeFs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8"), {
    filename: "fastMediaEngine.js",
});

const quietConsole = { log: function () { }, warn: function () { }, error: function () { } };

// ─── (a) Root-generation compare-and-set under a simulated concurrent panel ──

function createSpyStorage() {
    const data = Object.create(null);
    const sets = [];
    return {
        data: data,
        sets: sets,
        getItem: function (key) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
        },
        setItem: function (key, value) {
            sets.push({ key: key, value: String(value) });
            data[key] = String(value);
        },
        removeItem: function (key) { delete data[key]; },
    };
}

// `interference` models the racing panel: whenever the committed manifest key
// is written and interference is armed, the racing panel's payload overwrites
// it immediately afterwards (its stale snapshot landing after our commit).
function loadPersistence(storage, interference) {
    const sandbox = loadHelpers({
        file: path.join("js", "core", "persistence.js"),
        lenient: false,
        injected: {
            console: quietConsole,
            localStorage: {
                getItem: function (key) { return storage.getItem(key); },
                setItem: function (key, value) {
                    storage.setItem(key, value);
                    if (interference && key === interference.key && interference.remaining > 0) {
                        interference.remaining--;
                        storage.data[interference.key] = interference.payload;
                    }
                },
                removeItem: function (key) { storage.removeItem(key); },
            },
            nfs: function () { return {}; },
        },
    });
    return {
        bumpRootGeneration: sandbox.get("bumpRootGeneration"),
        getRootGeneration: sandbox.get("getRootGeneration"),
        loadRootManifest: sandbox.get("loadRootManifest"),
        ROOT_MANIFEST_KEY: sandbox.context.ROOT_MANIFEST_KEY,
    };
}

describe("M4 (a) — bumpRootGeneration compare-and-set under a concurrent panel", function () {
    const LIB = "C:/library";

    function manifestPayload(root, gen) {
        const roots = {};
        roots[root] = gen;
        return JSON.stringify({ version: 1, roots: roots });
    }

    function committedWrites(storage, key) {
        return storage.sets.filter(function (entry) { return entry.key === key; });
    }

    it("without contention the bump stays exactly sequential", function () {
        const storage = createSpyStorage();
        const P = loadPersistence(storage, null);

        expect(P.getRootGeneration(LIB)).toBe(0);
        expect(P.bumpRootGeneration(LIB)).toBe(1);
        expect(P.bumpRootGeneration(LIB)).toBe(2);
        expect(P.getRootGeneration(LIB)).toBe(2);
        expect(committedWrites(storage, P.ROOT_MANIFEST_KEY).length).toBe(2);
    });

    it("retries from the fresh value when a stale concurrent write clobbers the bump", function () {
        const storage = createSpyStorage();
        const interference = { key: "", remaining: 0, payload: "" };
        const P = loadPersistence(storage, interference);
        interference.key = P.ROOT_MANIFEST_KEY;

        storage.data[P.ROOT_MANIFEST_KEY] = manifestPayload(LIB, 3);

        // The racing panel's stale snapshot (gen 3) lands right after our
        // first commit — clobbering our gen 4. The CAS re-read must catch the
        // regression and retry from the freshly read value.
        interference.payload = manifestPayload(LIB, 3);
        interference.remaining = 1;

        expect(P.bumpRootGeneration(LIB)).toBe(4);
        expect(P.getRootGeneration(LIB)).toBe(4);
        // One clobbered attempt plus one successful retry.
        expect(committedWrites(storage, P.ROOT_MANIFEST_KEY).length).toBe(2);
    });

    it("adopts a higher generation when another panel bumped afterwards", function () {
        const storage = createSpyStorage();
        const interference = { key: "", remaining: 0, payload: "" };
        const P = loadPersistence(storage, interference);
        interference.key = P.ROOT_MANIFEST_KEY;

        storage.data[P.ROOT_MANIFEST_KEY] = manifestPayload(LIB, 3);

        // After our gen-4 commit, the other panel's gen-5 bump lands. That is
        // monotonic — the caller must observe 5, never a stale 4.
        interference.payload = manifestPayload(LIB, 5);
        interference.remaining = 1;

        expect(P.bumpRootGeneration(LIB)).toBe(5);
        expect(P.getRootGeneration(LIB)).toBe(5);
        expect(committedWrites(storage, P.ROOT_MANIFEST_KEY).length).toBe(1);
    });

    it("bounds its retries under a continuously racing writer", function () {
        const storage = createSpyStorage();
        const interference = { key: "", remaining: 0, payload: "" };
        const P = loadPersistence(storage, interference);
        interference.key = P.ROOT_MANIFEST_KEY;

        storage.data[P.ROOT_MANIFEST_KEY] = manifestPayload(LIB, 3);

        // Every commit is immediately clobbered by a gen-1 stale snapshot.
        interference.payload = manifestPayload(LIB, 1);
        interference.remaining = 100;

        const result = P.bumpRootGeneration(LIB);
        // Bounded: exactly three attempts, then the best-effort contract
        // returns the value the last attempt wrote (1 + 1).
        expect(committedWrites(storage, P.ROOT_MANIFEST_KEY).length).toBe(3);
        expect(result).toBe(2);
    });
});

// ─── (b) mediaId uniqueness across panels ────────────────────────────────────

// A Date whose every instance reports the SAME millisecond, so two realms
// model two panels minting ids in the same instant.
function pinnedDate(fixedMs) {
    function FakeDate() { }
    FakeDate.now = function () { return fixedMs; };
    FakeDate.prototype.getTime = function () { return fixedMs; };
    FakeDate.prototype.toISOString = function () { return new Date(fixedMs).toISOString(); };
    return FakeDate;
}

// One vm realm == one panel session (fresh module state, fresh nonce).
function loadEngineRealm(fixedMs) {
    const fakeFs = {
        promises: {
            stat: function () { return Promise.reject(new Error("ENOENT")); },
            readdir: function () { return Promise.reject(new Error("ENOENT")); },
            mkdir: function () { return Promise.resolve(); },
            writeFile: function () { return Promise.resolve(); },
            unlink: function () { return Promise.resolve(); },
        },
    };
    const context = {
        window: {
            rootPath: "C:/library",
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function () { throw new Error("media id minting must not create elements"); },
        },
        performance: { now: function () { return 0; } },
        console: quietConsole,
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise,
        Date: pinnedDate(fixedMs),
        Buffer,
        Image: function () { },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent,
    };
    context.window.window = context.window;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.MediaImportCoordinator !== "function") {
        throw new Error("MediaImportCoordinator was not exposed by the media engine");
    }
    return context.window;
}

describe("M4 (b) — mediaId uniqueness across concurrent panels", function () {
    const FIXED_MS = 1780914133805;

    function makeCoordinator(realm) {
        return new realm.MediaImportCoordinator({
            repository: { snapshot: function () { return []; } },
        });
    }

    it("two panels in the same millisecond with equal counters mint distinct ids", function () {
        const panelA = loadEngineRealm(FIXED_MS);
        const panelB = loadEngineRealm(FIXED_MS);
        const coordinatorA = makeCoordinator(panelA);
        const coordinatorB = makeCoordinator(panelB);

        const idsA = [];
        const idsB = [];
        for (let i = 0; i < 10; i++) {
            idsA.push(coordinatorA._nextId({}));
            idsB.push(coordinatorB._nextId({}));
        }

        // Same millisecond, same sequence values — every id still unique.
        const all = idsA.concat(idsB);
        expect(new Set(all).size).toBe(all.length);
        for (let i = 0; i < idsA.length; i++) {
            expect(idsA[i]).not.toBe(idsB[i]);
        }
    });

    it("keeps the default id shape and its folder-segment expansion in budget", function () {
        const realm = loadEngineRealm(FIXED_MS);
        const id = makeCoordinator(realm)._nextId({});

        // time + 4-hex session nonce + sequence; nothing parses the shape,
        // but it stays lowercase alphanumeric with dash separators.
        expect(id).toMatch(/^media-[0-9a-z]+-[0-9a-f]{4}-[0-9a-z]+$/);
        // mediaIdFolderSegment expands each char to "-xxxx" (5x) after a
        // "media" prefix: 5 + 5 * len. Keep that modest so the M9 240-char
        // path budget stays reachable for normal library roots.
        expect(5 + 5 * id.length).toBeLessThanOrEqual(220);
    });

    it("custom idFactory output is untouched by the nonce (existing ids stay valid)", function () {
        const realm = loadEngineRealm(FIXED_MS);
        const coordinator = new realm.MediaImportCoordinator({
            repository: { snapshot: function () { return []; } },
            idFactory: function (sequence) { return "media-t79-" + sequence; },
        });
        expect(coordinator._nextId({})).toBe("media-t79-1");
    });
});
