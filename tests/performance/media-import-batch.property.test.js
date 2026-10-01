"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Property 4 harness — frame-coalesced media refreshes
//
// What is under test
// ------------------
// The REAL frame coalescer owned by the REAL `MediaImportCoordinator` in
// js/core/fastMediaEngine.js. A real import batch runs end to end through the
// real discovery, optimistic card insertion, single commit, aggregate category
// count, and batch-idle callback; the engine's own refresh requests plus
// generated category/grid invalidations are then observed across generated
// frame boundaries and item completions.
//
// Frames are fake: `requestAnimationFrame` is a queue the harness drains one
// frame at a time, and when the rAF path is unavailable the harness advances a
// 16 ms clock so the engine's owned timer fallback is exercised instead.
// Promises inside the engine realm settle synchronously so one whole import
// happens inside a single synchronous predicate; nothing about which refresh
// the engine asks for changes with promise timing.
// ─────────────────────────────────────────────────────────────────────────────

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const ROOT = path.resolve(__dirname, "../..");
const ENGINE_SOURCE = nodeFs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8");
const ENGINE_SCRIPT = new vm.Script(ENGINE_SOURCE, { filename: "fastMediaEngine.js" });

const FRAME_MS = 16;
const SOURCE_FOLDER = "C:/originals";
const LIBRARY_ROOT = "C:/library";

/** Deterministic promise whose reactions run at settle time, with no microtask hop. */
function createSyncPromise() {
    function SyncPromise(executor) {
        const self = this;
        this._state = "pending";
        this._value = undefined;
        this._queue = [];
        function settle(state, value) {
            if (self._state !== "pending") return;
            if (state === "fulfilled" && value && (typeof value === "object" || typeof value === "function") &&
                typeof value.then === "function") {
                let adopted = false;
                try {
                    value.then(function (inner) { if (!adopted) { adopted = true; settle("fulfilled", inner); } },
                        function (error) { if (!adopted) { adopted = true; settle("rejected", error); } });
                } catch (error) {
                    if (!adopted) { adopted = true; settle("rejected", error); }
                }
                return;
            }
            self._state = state;
            self._value = value;
            const queue = self._queue.splice(0);
            for (let i = 0; i < queue.length; i++) queue[i]();
        }
        try {
            executor(function (value) { settle("fulfilled", value); }, function (error) { settle("rejected", error); });
        } catch (error) {
            settle("rejected", error);
        }
    }
    SyncPromise.prototype.then = function (onFulfilled, onRejected) {
        const self = this;
        return new SyncPromise(function (resolve, reject) {
            function run() {
                try {
                    if (self._state === "fulfilled") {
                        resolve(typeof onFulfilled === "function" ? onFulfilled(self._value) : self._value);
                    } else if (typeof onRejected === "function") {
                        resolve(onRejected(self._value));
                    } else {
                        reject(self._value);
                    }
                } catch (error) { reject(error); }
            }
            if (self._state === "pending") self._queue.push(run);
            else run();
        });
    };
    SyncPromise.prototype.catch = function (onRejected) { return this.then(undefined, onRejected); };
    SyncPromise.prototype.finally = function (handler) {
        return this.then(function (value) { handler(); return value; },
            function (error) { handler(); throw error; });
    };
    SyncPromise.resolve = function (value) {
        return value instanceof SyncPromise ? value : new SyncPromise(function (resolve) { resolve(value); });
    };
    SyncPromise.reject = function (error) {
        return new SyncPromise(function (ignore, reject) { reject(error); });
    };
    SyncPromise.all = function (values) {
        const list = Array.prototype.slice.call(values || []);
        return new SyncPromise(function (resolve, reject) {
            const results = new Array(list.length);
            let remaining = list.length;
            if (!remaining) { resolve(results); return; }
            for (let i = 0; i < list.length; i++) {
                (function (index) {
                    SyncPromise.resolve(list[index]).then(function (value) {
                        results[index] = value;
                        remaining--;
                        if (remaining === 0) resolve(results);
                    }, reject);
                })(i);
            }
        });
    };
    return SyncPromise;
}

/** Minimal asynchronous filesystem: only discovery of the generated source files is needed. */
function createDiscoveryFilesystem(SyncPromise, files) {
    const known = {};
    for (let i = 0; i < files.length; i++) known[files[i]] = true;
    function stats(isFile) {
        return {
            size: isFile ? 1024 : 0,
            isDirectory: function () { return !isFile; },
            isFile: function () { return isFile; },
        };
    }
    return {
        promises: {
            stat: function (target) {
                if (known[target]) return SyncPromise.resolve(stats(true));
                if (target === SOURCE_FOLDER) return SyncPromise.resolve(stats(false));
                return SyncPromise.reject(new Error("ENOENT: " + target));
            },
            readdir: function () {
                const names = [];
                for (let i = 0; i < files.length; i++) names.push(files[i].substring(SOURCE_FOLDER.length + 1));
                return SyncPromise.resolve(names);
            },
            mkdir: function () { return SyncPromise.resolve(); },
        },
    };
}

/** Fake frame source: one drainable rAF queue, or a 16 ms clock when rAF is unavailable. */
function createFrameEnvironment(useRaf) {
    const env = {
        useRaf: useRaf,
        frame: 0,
        now: 0,
        nextHandle: 1,
        rafQueue: [],
        timers: [],
        rafCalls: 0,
        timerCalls: 0,
        timerDelays: [],
        cancelledFrames: 0,
        clearedTimers: 0,
    };
    env.requestAnimationFrame = useRaf ? function (callback) {
        env.rafCalls++;
        const handle = env.nextHandle++;
        env.rafQueue.push({ handle: handle, callback: callback });
        return handle;
    } : null;
    env.cancelAnimationFrame = function (handle) {
        env.cancelledFrames++;
        env.rafQueue = env.rafQueue.filter(function (entry) { return entry.handle !== handle; });
    };
    env.setTimeout = function (callback, delay) {
        env.timerCalls++;
        env.timerDelays.push(delay);
        const handle = env.nextHandle++;
        env.timers.push({ handle: handle, callback: callback, due: env.now + (delay || 0) });
        return handle;
    };
    env.clearTimeout = function (handle) {
        env.clearedTimers++;
        env.timers = env.timers.filter(function (entry) { return entry.handle !== handle; });
    };
    env.pending = function () { return useRaf ? env.rafQueue.length : env.timers.length; };
    env.advanceFrame = function () {
        env.frame++;
        if (useRaf) {
            const due = env.rafQueue;
            env.rafQueue = [];
            for (let i = 0; i < due.length; i++) due[i].callback(env.now);
            return;
        }
        env.now += FRAME_MS;
        const ready = env.timers.filter(function (entry) { return entry.due <= env.now; });
        env.timers = env.timers.filter(function (entry) { return entry.due > env.now; });
        for (let j = 0; j < ready.length; j++) ready[j].callback();
    };
    return env;
}

function loadEngine(fakeFs, SyncPromise) {
    const context = {
        window: {
            rootPath: LIBRARY_ROOT,
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function () { throw new Error("refresh coalescing must not create media elements"); },
        },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
        Promise: SyncPromise, Date: Date, Buffer: Buffer,
        Image: function () { },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent: encodeURIComponent,
    };
    context.window.window = context.window;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.MediaImportCoordinator !== "function") {
        throw new Error("MediaImportCoordinator was not exposed by the media engine");
    }
    if (context.window.requestAnimationFrame !== undefined) {
        throw new Error("the engine realm must not provide its own requestAnimationFrame");
    }
    return context.window;
}

function stubScheduler() {
    return {
        enqueue: function () { return { id: "noop", promise: Promise.resolve({ ok: true }) }; },
        defer: function () { return { id: "noop-timer", cancel: function () { } }; },
        cancelByOwner: function () { return 0; },
        snapshot: function () { return { lanes: {} }; },
    };
}

/**
 * Runs one real import batch and then replays the generated invalidation, frame,
 * and item-completion events against the coordinator's real refresh path.
 */
function runRefreshScenario(scenario) {
    const SyncPromise = createSyncPromise();
    const files = [];
    for (let i = 0; i < scenario.itemCount; i++) {
        files.push(SOURCE_FOLDER + "/asset-" + i + (i % 2 === 0 ? ".png" : ".mp4"));
    }
    const fakeFs = createDiscoveryFilesystem(SyncPromise, files);
    const engine = loadEngine(fakeFs, SyncPromise);
    const env = createFrameEnvironment(scenario.useRaf);

    const refreshes = [];
    const committed = [];
    const categoryUpdates = [];
    let afterIdle = false;
    let idleCallback = null;

    const coordinator = new engine.MediaImportCoordinator({
        fs: fakeFs,
        rootPath: LIBRARY_ROOT,
        scheduler: stubScheduler(),
        repository: {
            snapshot: function () { return committed.slice(); },
            commitOptimisticBatch: function (entries) {
                for (let i = 0; i < entries.length; i++) committed.push(entries[i]);
                return { ok: true, entries: committed.slice() };
            },
            patchById: function () { return { ok: true }; },
        },
        cardHelper: {
            insertBatch: function (entries) { return { ok: true, inserted: entries.length }; },
            patchById: function () { return { ok: true }; },
        },
        // The real work coordinator is replaced so item completion and the single
        // pending-to-zero idle callback are driven by the generated event script.
        workCoordinator: {
            submitBatch: function (batch, onIdle) {
                idleCallback = onIdle;
                return { then: function () { return this; } };
            },
            cancelBatch: function () { return true; },
            dispose: function () { return true; },
        },
        updateCategoryCounts: function (counts) { categoryUpdates.push(counts); },
        reconcileAfterIdle: false,
        idFactory: function (sequence) { return "media-p4-" + sequence; },
        requestAnimationFrame: env.requestAnimationFrame,
        cancelAnimationFrame: env.cancelAnimationFrame,
        setTimeout: env.setTimeout,
        clearTimeout: env.clearTimeout,
        categoryRefresh: function () { refreshes.push({ kind: "category", frame: env.frame, afterIdle: afterIdle }); },
        gridRefresh: function () { refreshes.push({ kind: "grid", frame: env.frame, afterIdle: afterIdle }); },
    });

    const batchId = "batch-p4";
    let maxScheduled = 0;
    function observe() {
        maxScheduled = Math.max(maxScheduled, env.pending());
    }

    coordinator.importSelection(files.slice(), { section: "footage", category: "Imported", batchId: batchId });
    observe();
    if (!idleCallback) throw new Error("the import batch never reached the work coordinator");

    let pendingItems = files.length;
    function completeOne() {
        if (pendingItems === 0) return;
        pendingItems--;
        if (pendingItems > 0) return;
        // Exactly one pending-to-zero transition, exactly as the work coordinator reports it.
        afterIdle = true;
        idleCallback({ pendingCount: 0, inFlightCount: 0, terminalCount: files.length, idle: true });
    }

    for (let e = 0; e < scenario.events.length; e++) {
        const event = scenario.events[e];
        if (event === "frame") {
            env.advanceFrame();
        } else if (event === "complete") {
            completeOne();
        } else if (pendingItems > 0) {
            // Media invalidations only arrive while the batch still has pending items.
            coordinator._refresh.request(event === "category" || event === "both", event === "grid" || event === "both");
        }
        observe();
    }

    while (pendingItems > 0) {
        completeOne();
        observe();
    }
    let guard = 0;
    while (env.pending() > 0 && guard++ < 8) {
        env.advanceFrame();
        observe();
    }
    for (let f = 0; f < scenario.extraFrames; f++) {
        env.advanceFrame();
        observe();
    }

    return {
        env: env,
        refreshes: refreshes,
        maxScheduled: maxScheduled,
        snapshot: coordinator.snapshot(batchId),
        coalescer: coordinator._refresh,
        categoryUpdates: categoryUpdates,
        committedCount: committed.length,
        itemCount: files.length,
    };
}

function countKind(entries, kind) {
    return entries.filter(function (entry) { return entry.kind === kind; }).length;
}

function assertFrameCoalescedRefreshes(scenario, run) {
    const refreshes = run.refreshes;

    // Requirement 2.3: no frame ever performs more than one category and one grid refresh.
    const byFrame = {};
    refreshes.forEach(function (entry) {
        const bucket = byFrame[entry.frame] || (byFrame[entry.frame] = { category: 0, grid: 0 });
        bucket[entry.kind]++;
    });
    Object.keys(byFrame).forEach(function (frame) {
        expect(byFrame[frame].category).toBeLessThanOrEqual(1);
        expect(byFrame[frame].grid).toBeLessThanOrEqual(1);
    });

    // Requirement 2.8: the pending-to-zero transition adds at most one final refresh of each kind.
    const settled = refreshes.filter(function (entry) { return entry.afterIdle; });
    expect(countKind(settled, "category")).toBeLessThanOrEqual(1);
    expect(countKind(settled, "grid")).toBeLessThanOrEqual(1);

    // Only one coalescing callback is ever outstanding, on either the frame or the timer path.
    expect(run.maxScheduled).toBeLessThanOrEqual(1);
    if (scenario.useRaf) {
        expect(run.env.timerCalls).toBe(0);
        expect(run.env.rafCalls).toBe(run.coalescer.totals.frames);
    } else {
        expect(run.env.rafCalls).toBe(0);
        expect(run.env.timerCalls).toBe(run.coalescer.totals.frames);
        run.env.timerDelays.forEach(function (delay) { expect(delay).toBe(FRAME_MS); });
    }

    // Refresh work never exceeds the number of coalescing callbacks that actually ran.
    expect(run.coalescer.totals.category).toBe(countKind(refreshes, "category"));
    expect(run.coalescer.totals.grid).toBe(countKind(refreshes, "grid"));
    expect(run.coalescer.totals.category).toBeLessThanOrEqual(run.coalescer.totals.frames);
    expect(run.coalescer.totals.grid).toBeLessThanOrEqual(run.coalescer.totals.frames);

    // Coalescing delays refreshes, it never drops them: the batch's own grid and
    // category requests are delivered, and nothing stays dirty or scheduled once
    // the frames are drained.
    expect(countKind(refreshes, "category")).toBeGreaterThanOrEqual(1);
    expect(countKind(refreshes, "grid")).toBeGreaterThanOrEqual(1);
    expect(run.coalescer.categoryDirty).toBe(false);
    expect(run.coalescer.gridDirty).toBe(false);
    expect(run.coalescer.scheduled).toBe(false);
    expect(run.env.pending()).toBe(0);

    // The batch itself settled: no pending item and no coalescer-owned timer remains.
    expect(run.snapshot.pendingCount).toBe(0);
    expect(run.snapshot.idle).toBe(true);
    expect(run.snapshot.timerCount).toBe(0);
    expect(run.snapshot.refreshTotals.category).toBe(countKind(refreshes, "category"));
    expect(run.snapshot.refreshTotals.grid).toBe(countKind(refreshes, "grid"));
    expect(run.committedCount).toBe(run.itemCount);
}

const refreshScenarioArbitrary = fc.record({
    useRaf: fc.boolean(),
    itemCount: fc.integer({ min: 1, max: 5 }),
    events: fc.array(fc.constantFrom("category", "grid", "both", "frame", "complete"), { minLength: 1, maxLength: 24 }),
    extraFrames: fc.integer({ min: 0, max: 3 }),
});

describe("Media import batch refresh coalescing properties", function () {
    test("category and grid refreshes are coalesced to one per frame", function () {
        /**
         * Feature: media-engine-lag, Property 4: Refresh requests are frame-coalesced
         * **Validates: Requirements 2.3, 2.8**
         */
        fc.assert(fc.property(refreshScenarioArbitrary, function (scenario) {
            assertFrameCoalescedRefreshes(scenario, runRefreshScenario(scenario));
        }), { seed: 40823, numRuns: 100 });
    }, 180000);

    test("many invalidations inside one animation frame collapse into a single refresh pair", function () {
        const run = runRefreshScenario({
            useRaf: true,
            itemCount: 3,
            events: ["category", "grid", "both", "category", "grid", "frame", "complete", "complete", "complete", "frame"],
            extraFrames: 1,
        });
        expect(countKind(run.refreshes, "category")).toBe(2);
        expect(countKind(run.refreshes, "grid")).toBe(2);
        expect(run.env.rafCalls).toBe(2);
    });

    test("the owned 16 ms timer replaces the frame callback when rAF is unavailable", function () {
        const run = runRefreshScenario({
            useRaf: false,
            itemCount: 2,
            events: ["grid", "frame", "category", "complete", "complete", "frame"],
            extraFrames: 1,
        });
        expect(run.env.rafCalls).toBe(0);
        expect(run.env.timerDelays).toEqual([FRAME_MS, FRAME_MS]);
        expect(countKind(run.refreshes, "category")).toBe(2);
        expect(countKind(run.refreshes, "grid")).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 5 harness — exact aggregate category counts
//
// What is under test
// ------------------
// The REAL aggregate category-count path of the REAL `MediaImportCoordinator`
// in js/core/fastMediaEngine.js: a generated already-committed index snapshot
// is handed to the coordinator through the repository, a generated import batch
// (supported and unsupported extensions, slash variants, duplicate and
// already-imported paths) is imported for real, and every call the coordinator
// makes to `updateCategoryCounts` is recorded.
//
// The expected counts come from an independent reference model below that never
// touches engine code: it re-derives acceptance, canonicalization, deduplication
// and category assignment from the generated scenario alone.
// ─────────────────────────────────────────────────────────────────────────────

const REFERENCE_SUPPORTED_EXTENSIONS = {
    ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true,
    ".mp4": true, ".mov": true, ".webm": true, ".avi": true,
};

const CATEGORY_NAME_LIMIT = 30;

/** Independent path canonicalization for the reference model (no engine helpers). */
function referenceCanonicalPath(value) {
    let text = String(value === undefined || value === null ? "" : value).replace(/\\/g, "/");
    const drive = /^([A-Za-z]):\//.exec(text);
    let prefix = "";
    if (drive) {
        prefix = drive[1].toUpperCase() + ":";
        text = text.substring(2);
    }
    const segments = text.split("/").filter(function (segment) { return segment && segment !== "."; });
    return prefix ? prefix + "/" + segments.join("/") : segments.join("/");
}

/** Windows-style identity: canonical form, case-folded. */
function referenceIdentity(value) {
    return referenceCanonicalPath(value).toLowerCase();
}

function referenceExtension(canonicalPath) {
    const name = canonicalPath.substring(canonicalPath.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.substring(dot).toLowerCase();
}

function referenceBaseName(canonicalPath) {
    const name = canonicalPath.substring(canonicalPath.lastIndexOf("/") + 1);
    const extension = referenceExtension(canonicalPath);
    return extension ? name.substring(0, name.length - extension.length) : name;
}

function referenceCategoryKey(value) {
    return value === undefined || value === null ? "" : String(value);
}

/**
 * Reference count model: the exact per-category totals the Library_Index must
 * have once every membership change of the generated batch has been applied.
 */
function referenceCategoryModel(scenario) {
    const counts = {};
    function bump(category) {
        const key = referenceCategoryKey(category);
        counts[key] = (counts[key] || 0) + 1;
    }

    const takenIdentities = {};
    for (let i = 0; i < scenario.existing.length; i++) {
        bump(scenario.existing[i].category);
        if (scenario.existing[i].sourcePath) takenIdentities[referenceIdentity(scenario.existing[i].sourcePath)] = true;
    }

    const acceptedPaths = [];
    for (let f = 0; f < scenario.files.length; f++) {
        const canonical = referenceCanonicalPath(scenario.files[f].raw);
        if (!REFERENCE_SUPPORTED_EXTENSIONS[referenceExtension(canonical)]) continue;
        const identity = referenceIdentity(canonical);
        if (takenIdentities[identity]) continue;
        takenIdentities[identity] = true;
        acceptedPaths.push(canonical);
        const requested = scenario.category;
        bump(String(requested || referenceBaseName(canonical)).substring(0, CATEGORY_NAME_LIMIT));
    }

    return { counts: counts, acceptedCount: acceptedPaths.length, entryCount: scenario.existing.length + acceptedPaths.length };
}

/** Asynchronous filesystem that only knows the generated batch files (no folders). */
function createFileSetFilesystem(SyncPromise, canonicalFiles) {
    const known = {};
    for (let i = 0; i < canonicalFiles.length; i++) known[canonicalFiles[i]] = true;
    return {
        promises: {
            stat: function (target) {
                if (!known[target]) return SyncPromise.reject(new Error("ENOENT: " + target));
                return SyncPromise.resolve({
                    size: 2048,
                    isDirectory: function () { return false; },
                    isFile: function () { return true; },
                });
            },
            readdir: function () { return SyncPromise.reject(new Error("ENOTDIR")); },
            mkdir: function () { return SyncPromise.resolve(); },
        },
    };
}

/** Runs one real import batch against a generated committed snapshot. */
function runCategoryCountScenario(scenario) {
    const SyncPromise = createSyncPromise();
    const rawPaths = scenario.files.map(function (file) { return file.raw; });
    const fakeFs = createFileSetFilesystem(SyncPromise, rawPaths.map(referenceCanonicalPath));
    const engine = loadEngine(fakeFs, SyncPromise);
    const env = createFrameEnvironment(true);

    const committed = scenario.existing.map(function (entry, index) {
        const clone = { id: "existing-" + index, name: "existing-" + index, section: "footage", type: "media" };
        clone.category = entry.category;
        if (entry.sourcePath) clone.sourcePath = entry.sourcePath;
        return clone;
    });

    const categoryUpdates = [];
    let idleCallback = null;

    const coordinator = new engine.MediaImportCoordinator({
        fs: fakeFs,
        rootPath: LIBRARY_ROOT,
        scheduler: stubScheduler(),
        caseInsensitivePaths: true,
        repository: {
            snapshot: function () { return committed.slice(); },
            commitOptimisticBatch: function (entries) {
                for (let i = 0; i < entries.length; i++) committed.push(entries[i]);
                return { ok: true, entries: committed.slice() };
            },
            patchById: function () { return { ok: true }; },
        },
        cardHelper: {
            insertBatch: function (entries) { return { ok: true, inserted: entries.length }; },
            patchById: function () { return { ok: true }; },
        },
        workCoordinator: {
            submitBatch: function (batch, onIdle) {
                idleCallback = onIdle;
                return { then: function (resolve) { return resolve({ pendingCount: batch.items.length, idle: false }); } };
            },
            cancelBatch: function () { return true; },
            dispose: function () { return true; },
        },
        updateCategoryCounts: function (counts, batchId) {
            categoryUpdates.push({ counts: counts, batchId: batchId, frame: env.frame });
        },
        reconcileAfterIdle: false,
        idFactory: function (sequence) { return "media-p5-" + sequence; },
        requestAnimationFrame: env.requestAnimationFrame,
        cancelAnimationFrame: env.cancelAnimationFrame,
        setTimeout: env.setTimeout,
        clearTimeout: env.clearTimeout,
        categoryRefresh: function () { },
        gridRefresh: function () { },
    });

    let importResult = null;
    coordinator.importSelection(rawPaths.slice(), {
        section: "footage",
        category: scenario.category || undefined,
        batchId: "batch-p5",
    }).then(function (result) { importResult = result; });

    // Drain the coalescer and report the single pending-to-zero transition: neither
    // frame work nor batch idleness may add another aggregate count update.
    let guard = 0;
    while (env.pending() > 0 && guard++ < 8) env.advanceFrame();
    if (idleCallback) {
        idleCallback({ pendingCount: 0, inFlightCount: 0, terminalCount: importResult && importResult.batch ? importResult.batch.items.length : 0, idle: true });
    }
    guard = 0;
    while (env.pending() > 0 && guard++ < 8) env.advanceFrame();

    return {
        coordinator: coordinator,
        categoryUpdates: categoryUpdates,
        committed: committed,
        importResult: importResult,
        snapshot: coordinator.snapshot("batch-p5"),
        totals: coordinator.totals,
    };
}

function assertExactAggregateCategoryCounts(scenario, run) {
    const expected = referenceCategoryModel(scenario);

    if (expected.acceptedCount === 0) {
        // No membership change was applied, so no aggregate update may be performed.
        expect(run.categoryUpdates.length).toBe(0);
        expect(run.totals.categoryCountUpdates).toBe(0);
        expect(run.committed.length).toBe(scenario.existing.length);
        return;
    }

    // Requirement 2.7: exactly one aggregate category-count update for the batch.
    expect(run.categoryUpdates.length).toBe(1);
    expect(run.totals.categoryCountUpdates).toBe(1);
    expect(run.snapshot.categoryCountUpdates).toBe(1);
    expect(run.categoryUpdates[0].batchId).toBe("batch-p5");

    // Requirement 2.7: every category count equals the number of index entries in it.
    const reported = run.categoryUpdates[0].counts;
    expect(Object.keys(reported).sort()).toEqual(Object.keys(expected.counts).sort());
    Object.keys(expected.counts).forEach(function (category) {
        expect(reported[category]).toBe(expected.counts[category]);
    });

    // The reported totals describe the real committed index, entry for entry.
    const actualCounts = {};
    run.committed.forEach(function (entry) {
        const key = entry && entry.category !== undefined ? String(entry.category) : "";
        actualCounts[key] = (actualCounts[key] || 0) + 1;
    });
    expect(reported).toEqual(actualCounts);

    let reportedTotal = 0;
    Object.keys(reported).forEach(function (category) { reportedTotal += reported[category]; });
    expect(reportedTotal).toBe(expected.entryCount);
    expect(run.committed.length).toBe(expected.entryCount);
    expect(run.importResult.accepted.length).toBe(expected.acceptedCount);
}

const categoryCountScenarioArbitrary = fc.record({
    existing: fc.array(fc.record({
        category: fc.oneof(fc.constantFrom("Imported", "Footage", "", "Alpha"), fc.constant(undefined)),
        sourcePath: fc.oneof(
            fc.constant(""),
            fc.constantFrom(
                SOURCE_FOLDER + "/clip-a.mp4",
                SOURCE_FOLDER + "\\CLIP-A.mp4",
                SOURCE_FOLDER + "/photo 1.png"
            )
        ),
    }), { maxLength: 6 }),
    files: fc.array(fc.record({
        raw: fc.constantFrom(
            SOURCE_FOLDER + "/clip-a.mp4",
            SOURCE_FOLDER + "\\clip-a.mp4",
            SOURCE_FOLDER + "/Clip-A.mp4",
            SOURCE_FOLDER + "/clip-b.mov",
            SOURCE_FOLDER + "/photo 1.png",
            SOURCE_FOLDER + "/photo 2.png",
            SOURCE_FOLDER + "/notes.txt",
            SOURCE_FOLDER + "/sheet.pdf"
        ),
    }), { maxLength: 8 }),
    category: fc.oneof(
        fc.constant(""),
        fc.constantFrom("Imported", "Shots", "A category name that is definitely longer than thirty characters")
    ),
});

describe("Media import batch aggregate category count properties", function () {
    test("one aggregate update reports the exact per-category index totals", function () {
        /**
         * Feature: media-engine-lag, Property 5: Aggregate category counts are exact
         * **Validates: Requirements 2.7**
         */
        fc.assert(fc.property(categoryCountScenarioArbitrary, function (scenario) {
            assertExactAggregateCategoryCounts(scenario, runCategoryCountScenario(scenario));
        }), { seed: 51207, numRuns: 100 });
    }, 180000);
});
