/**
 * Warm paint, bounded batching and deferred startup work — property suite
 * ======================================================================
 *
 * Feature: panel-reopen-startup
 *
 * What is under test
 * ------------------
 * The REAL startup front half of `js/templates/templates.js` (`startupWarmPaint`,
 * `renderCardsFirstBatch`, `queueStartupDeferredWork`, `scheduleStartupValidation`,
 * `rescanChangedRoots`) driven over:
 *
 *   - a REAL parsed DOM tree (tests/helpers/miniDom.js),
 *   - a REAL persisted `LibraryIndex` round-tripped through
 *     `serialize()` / `tryParse()` (js/core/persistence.js),
 *   - the REAL async validity key `deriveCombinedValidityKeyAsync`
 *     (js/core/persistence.js) over an in-memory asynchronous filesystem,
 *   - the REAL startup trace recorder in `js/core/observability.js`, loaded into
 *     the same vm realm so `window.__csStartupTrace` is the shipped report.
 *
 * Only the environment is substituted at the boundary: the CEP bridge
 * (`csInterface.evalScript`), the synchronous disk key `getCombinedDiskValidityKey`
 * (a counting stub — the warm path must never reach it), the idle queue, the
 * `AppLifecycle` handle registry, `updateCount`, and a monotonic clock.
 *
 * Structure
 * ---------
 * Every helper below the requires is module level and scenario driven so the
 * remaining properties of this suite (bounded batching, deferred phase ordering,
 * idle-scheduling equivalence) can be appended without touching the harness.
 */

"use strict";

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const { loadHelpers, REPO_ROOT } = require("../helpers/loadHelpers.js");
const { createMiniDocument, MiniElement } = require("../helpers/miniDom.js");
const {
    LibraryIndex,
    parseCombinedValidityKey,
    deriveCombinedValidityKeyAsync,
    getLastLibraryIndexLoadReason,
} = require("../../js/core/persistence.js");

const OBSERVABILITY_SOURCE = nodeFs.readFileSync(
    path.join(REPO_ROOT, "js", "core", "observability.js"),
    "utf8"
);

// Each property builds and drains at least one full startup world per run over
// 100 runs, which does not fit Jest's 5 s default.
jest.setTimeout(180000);

// The six card grids index.html defines; resolveSectionGridId() picks one of
// them from currentSection, so all six exist in the harness document.
const GRID_IDS = [
    "comp-list-container",
    "icon-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container",
];

// First_Batch as fixed by the design (Requirement 3.1).
const FIRST_BATCH = 60;

// Root_Signature (js/core/persistence.js) fingerprints the SEVEN SECTION FOLDERS
// of a root, never the root directory itself, so a file dropped loose in the root
// is invisible to it. The synthetic library therefore keeps its files where a real
// one does — inside a section folder — which is what makes a generated mutation a
// change the shipped validity key can actually see.
const SIGNATURE_SEED_FOLDER = "comp";

// ─── Real shared modules loaded once (pure lookup tables + pure helpers) ─────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
});
const SECTION_VALUES = Object.keys(SECTIONS).map(function (key) { return SECTIONS[key]; });

// ─── Bridge double: hex transport plus a recording evalScript ────────────────
function encodeHex(value) {
    return Buffer.from(String(value), "utf8").toString("hex");
}
function decodeHex(value) {
    return Buffer.from(String(value), "hex").toString("utf8");
}

// ─── Section folders, as ExtendScript sees them ──────────────────────────────
// The startup scan is chunked: templates.js issues one
// `getAllTemplates(rootHex, sectionHex)` per section folder rather than a single
// all-sections call, because one all-sections call blocks After Effects' main
// thread for the whole library. `jsx/core.jsx` answers each call with the
// records that live in that one folder, so the harness must too.
//
// The section -> folder map is stated here INDEPENDENTLY of the shipped
// `SECTION_SCAN_FOLDERS` table (two sections share a folder: `text_props` lives
// in `text`, `element` in `overlay`), so the harness is a real oracle for the
// second argument rather than a restatement of it.
const SCAN_FOLDER_FOR_SECTION = {
    comp: "comp",
    layer: "layer",
    text: "text",
    text_props: "text",
    footage: "footage",
    effect: "effect",
    icon: "icon",
    overlay: "overlay",
    element: "overlay",
};

/** The section folder ExtendScript would have found this record in. */
function scanFolderForRecord(record) {
    if (!record) return "";
    const section = typeof record.section === "string" && record.section
        ? record.section
        : record.type;
    const folder = SCAN_FOLDER_FOR_SECTION[section];
    return typeof folder === "string" ? folder : "";
}

/**
 * A recording `csInterface`. `getAllTemplates(<hex root>,<hex section>)` — the
 * chunked form the shipped scanner issues — resolves synchronously with the
 * records `recordsForRoot(root)` returns THAT LIVE IN THAT SECTION FOLDER; the
 * one-argument `getAllTemplates(<hex root>)` form still answers with the whole
 * root, so a caller that asks for everything is still served. Each call
 * remembers how many grid writes had already happened, which is what makes
 * "before the first grid write" observable.
 */
function createBridge(recordsForRoot, writes) {
    const calls = [];
    const scanCalls = [];
    const csInterface = {
        evalScript: function (script, callback) {
            const at = writes.length;
            const text = String(script);
            calls.push({ script: text, writeIndexAtCall: at });
            const scoped = /^getAllTemplates\("([0-9a-fA-F]*)","([0-9a-fA-F]*)"\)$/.exec(text);
            const all = scoped ? null : /^getAllTemplates\("([0-9a-fA-F]*)"\)$/.exec(text);
            if (!scoped && !all) {
                if (typeof callback === "function") callback("");
                return;
            }
            const root = decodeHex((scoped || all)[1]);
            const folder = scoped ? decodeHex(scoped[2]) : "";
            scanCalls.push({ root: root, section: folder, writeIndexAtCall: at });
            const records = recordsForRoot(root).filter(function (record) {
                return folder === "" || scanFolderForRecord(record) === folder;
            });
            if (typeof callback === "function") callback(encodeHex(JSON.stringify(records)));
        },
    };
    return {
        csInterface: csInterface,
        calls: calls,
        scanCalls: scanCalls,
        encodeBridge: encodeHex,
        decodeBridge: decodeHex,
    };
}

// ─── Controllable idle queue (requestIdleCallback present or absent) ─────────
/**
 * `mode === "idle"` exposes `requestIdleCallback`; `mode === "timeout"` exposes
 * only `setTimeout`, which is the Requirement 5.5 fallback. Both routes land in
 * the same ordered queue so a drain is deterministic either way.
 */
function createIdleQueue(mode) {
    const queue = [];
    let nextHandle = 1;
    let ran = 0;
    // Scheduling provenance, recorded for every unit ever queued (the queue
    // itself is consumed by drain, so this list outlives it): which primitive
    // scheduled the unit, and with which delay / idle options.
    const scheduled = [];

    function push(fn, kind) {
        const handle = nextHandle++;
        queue.push({ handle: handle, fn: fn, kind: kind });
        return handle;
    }
    function cancel(handle) {
        for (let i = 0; i < queue.length; i++) {
            if (queue[i].handle === handle) { queue.splice(i, 1); return true; }
        }
        return false;
    }

    const api = {
        mode: mode,
        pending: function () { return queue.length; },
        ran: function () { return ran; },
        /** Every unit ever queued: { via: "setTimeout"|"requestIdleCallback", delay, options }. */
        scheduled: scheduled,
        scheduledVia: function (via) {
            return scheduled.filter(function (entry) { return entry.via === via; });
        },
        setTimeout: function (fn, delay) {
            scheduled.push({ via: "setTimeout", delay: delay, options: null });
            return push(fn, "timeout");
        },
        clearTimeout: function (handle) { return cancel(handle); },
        /** Runs queued units until the queue drains; units may enqueue more. */
        drain: function (limit) {
            const guard = typeof limit === "number" ? limit : 2000;
            let steps = 0;
            while (queue.length > 0 && steps < guard) {
                const unit = queue.shift();
                steps++;
                ran++;
                unit.fn();
            }
            return steps;
        },
    };
    if (mode === "idle") {
        api.requestIdleCallback = function (fn, options) {
            scheduled.push({ via: "requestIdleCallback", delay: null, options: options });
            return push(fn, "idle");
        };
        api.cancelIdleCallback = function (handle) { return cancel(handle); };
    }
    return api;
}

// ─── AppLifecycle handle registry double ────────────────────────────────────
function createLifecycleRegistry() {
    const entries = [];
    let nextId = 1;
    const api = {
        entries: entries,
        live: function () {
            return entries.filter(function (entry) { return entry.active; }).length;
        },
        maxLive: 0,
        register: function (kind, handle, cancel) {
            const entry = { id: nextId++, kind: kind, handle: handle, cancel: cancel, active: true, disposals: 0 };
            entries.push(entry);
            if (api.live() > api.maxLive) api.maxLive = api.live();
            return {
                id: entry.id,
                dispose: function () {
                    if (!entry.active) return;
                    entry.active = false;
                    entry.disposals++;
                    if (typeof cancel === "function") cancel(handle);
                },
            };
        },
        onDispose: function (fn) { entries.push({ id: nextId++, kind: "disposer", fn: fn, active: true, disposals: 0 }); },
        disposeAll: function () {
            entries.forEach(function (entry) {
                if (!entry.active) return;
                entry.active = false;
                entry.disposals++;
                if (typeof entry.cancel === "function") entry.cancel(entry.handle);
                if (typeof entry.fn === "function") entry.fn();
            });
        },
    };
    return api;
}

// ─── Asynchronous in-memory filesystem for the real validity key ────────────
/**
 * Exposes only the callback-style `readdir`/`stat` pair
 * `deriveFolderValidityKeyAsync` uses, so the key under test is the real one.
 */
function createValidityFilesystem() {
    const dirs = {};
    function ensureDir(dir) {
        if (!dirs[dir]) dirs[dir] = { mtimeMs: 1000, files: {} };
        return dirs[dir];
    }
    return {
        dirs: dirs,
        addDirectory: ensureDir,
        addFile: function (dir, name, size, mtimeMs) {
            const node = ensureDir(dir);
            node.files[name] = { size: size, mtimeMs: mtimeMs };
            if (mtimeMs > node.mtimeMs) node.mtimeMs = mtimeMs;
        },
        fs: {
            readdir: function (dir, callback) {
                const node = dirs[dir];
                if (!node) { callback(new Error("ENOENT: " + dir)); return; }
                callback(null, Object.keys(node.files));
            },
            stat: function (target, callback) {
                const asDir = dirs[target];
                if (asDir) { callback(null, { size: 0, mtimeMs: asDir.mtimeMs }); return; }
                const at = String(target).lastIndexOf("/");
                const parent = dirs[String(target).substring(0, at)];
                const name = String(target).substring(at + 1);
                if (!parent || !parent.files[name]) { callback(new Error("ENOENT: " + target)); return; }
                callback(null, { size: parent.files[name].size, mtimeMs: parent.files[name].mtimeMs });
            },
        },
    };
}

// ─── Grid write instrumentation ─────────────────────────────────────────────
/**
 * Records every DOM write to a grid in order: `innerHTML` assignments (the full
 * replacement path warm paint takes once) and `beforeend` appends (the batch
 * path). Each record snapshots the observation counters as they stood when the
 * write happened, which is how "no disk or bridge work before the first grid
 * write" is decided.
 *
 * `insertAdjacentHTML` is installed per element rather than on miniDom's
 * prototype so the shared helper stays untouched; the cached `_innerHTML`
 * string miniDom keeps for its getter is extended so `grid.innerHTML` stays
 * coherent with the parsed children after an append.
 */
function instrumentGrid(document, element, writes, counters) {
    const descriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "innerHTML");

    function record(kind, markup) {
        writes.push({
            kind: kind,
            gridId: element.id,
            markupLength: String(markup).length,
            cardsBefore: element.children.length,
            scans: counters.scanCalls.length,
            evalScripts: counters.bridgeCalls.length,
            validityKeyCalls: counters.syncValidityKeyCalls(),
        });
    }

    Object.defineProperty(element, "innerHTML", {
        configurable: true,
        get: function () { return descriptor.get.call(element); },
        set: function (markup) {
            record("innerHTML", markup);
            descriptor.set.call(element, markup);
        },
    });

    element.insertAdjacentHTML = function (position, markup) {
        if (position !== "beforeend") throw new Error("harness supports beforeend only");
        record("append", markup);
        const holder = document.createElement("div");
        holder.innerHTML = markup;
        const moving = holder.children;
        for (let i = 0; i < moving.length; i++) element.appendChild(moving[i]);
        element._innerHTML = (typeof element._innerHTML === "string" ? element._innerHTML : "") + markup;
    };
}

// ─── Scenario → records ─────────────────────────────────────────────────────
/**
 * Turns the generated scenario into the persisted entry list. Every entry gets
 * a unique id and folderPath (LibraryIndex keys entries by folderPath) and a
 * `sourcePath` drawn from the library path set, which is what makes per-root
 * reconciliation observable.
 */
function buildEntries(scenario) {
    const roots = scenario.roots;
    const entries = [];
    scenario.matching.forEach(function (spec, index) {
        entries.push(makeEntry(spec, scenario.section, roots[index % roots.length], "m" + index));
    });
    scenario.others.forEach(function (spec, index) {
        entries.push(makeEntry(spec, spec.section, roots[index % roots.length], "o" + index));
    });
    return entries;
}

function makeEntry(spec, section, root, suffix) {
    return {
        id: "tpl-id-" + suffix,
        name: spec.name + "-" + suffix,
        category: spec.category,
        section: section,
        type: section,
        favorite: spec.favorite,
        folderPath: root + "/" + section + "/" + suffix,
        sourcePath: root,
        thumbnail: "",
    };
}

/** Persists the entries through the real serialize/tryParse round trip. */
function persistLibraryIndex(entries, validityKey) {
    const source = new LibraryIndex({ validityKey: validityKey });
    for (let i = 0; i < entries.length; i++) source.insertAtHead(entries[i]);
    const parsed = LibraryIndex.tryParse(source.serialize());
    return { ok: parsed.ok, index: parsed.index, serialized: source.serialize() };
}

// ─── The harness ────────────────────────────────────────────────────────────
/**
 * Builds one startup world: a fresh vm realm holding the real templates.js and
 * the real observability.js, a real parsed DOM, a persisted LibraryIndex, and
 * every observation point the properties read.
 */
function createStartupHarness(scenario) {
    const entries = buildEntries(scenario);

    // Disk state: one directory per library root, plus the generated mutations
    // applied AFTER the stored key was derived.
    const disk = createValidityFilesystem();
    scenario.roots.forEach(function (root, rootIndex) {
        disk.addDirectory(root);
        disk.addDirectory(root + "/" + SIGNATURE_SEED_FOLDER);
        for (let i = 0; i <= rootIndex; i++) {
            disk.addFile(root + "/" + SIGNATURE_SEED_FOLDER, "seed-" + i + ".aep", 1024 + i, 1000 + i);
        }
    });

    const writes = [];
    let syncValidityKeyCalls = 0;
    const counters = {
        bridgeCalls: [],
        scanCalls: [],
        syncValidityKeyCalls: function () { return syncValidityKeyCalls; },
    };

    function recordsForRoot(root) {
        const normalized = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
        return JSON.parse(JSON.stringify(entries.filter(function (entry) {
            return String(entry.sourcePath).replace(/\\/g, "/").replace(/\/+$/, "") === normalized;
        })));
    }

    const bridge = createBridge(recordsForRoot, writes);
    counters.bridgeCalls = bridge.calls;
    counters.scanCalls = bridge.scanCalls;

    const document = createMiniDocument();
    const grids = {};
    GRID_IDS.forEach(function (gridId) {
        const grid = document.createElement("div");
        grid.id = gridId;
        grid.className = "card-grid";
        document.body.appendChild(grid);
        instrumentGrid(document, grid, writes, counters);
        grids[gridId] = grid;
    });

    const idle = createIdleQueue(scenario.idleMode);
    const lifecycle = createLifecycleRegistry();
    const consoleCalls = [];
    const spies = { updateCount: 0, hoverAttach: 0, saveLibraryIndex: 0 };

    let clock = 0;
    const windowObject = {
        performance: { now: function () { clock += 1; return clock; } },
        Date: Date,
        console: {
            log: function (message) { consoleCalls.push({ channel: "log", message: message }); },
            warn: function (message) { consoleCalls.push({ channel: "warn", message: message }); },
            error: function (message) { consoleCalls.push({ channel: "error", message: message }); },
        },
    };

    const persistedIndex = { index: null };

    const sandbox = loadHelpers({
        file: path.join("js", "templates", "templates.js"),
        lenient: false,
        injected: {
            // Realm plumbing. observability.js publishes onto `window`, so the
            // trace really is read from window.__csStartupTrace.
            window: windowObject,
            console: windowObject.console,
            document: document,

            // Real pure helpers from the shipped modules.
            SECTIONS: SECTIONS,
            IMAGE_SECTIONS: IMAGE_SECTIONS,
            escapeAttr: utils.get("escapeAttr"),
            escapeHTML: utils.get("escapeHTML"),
            getTemplateSection: utils.get("getTemplateSection"),
            isTextSection: utils.get("isTextSection"),
            isImageSection: utils.get("isImageSection"),

            // Panel state templates.js reads and (for allTemplates) reassigns.
            allTemplates: [],
            currentSection: scenario.section,
            currentCategory: scenario.category,
            tmpBulkSelected: [],
            libraryPaths: scenario.roots.slice(),
            rootPath: scenario.roots[0],
            DOM: { "search-box": { value: "" } },

            // Persistence seam: the persisted index plus the REAL async key.
            getLibraryIndex: function () { return persistedIndex.index; },
            getLastLibraryIndexLoadReason: getLastLibraryIndexLoadReason,
            // The REAL versioned-key parser, as the panel has it alongside
            // templates.js.
            parseCombinedValidityKey: parseCombinedValidityKey,
            deriveCombinedValidityKeyAsync: function (paths, fsImpl, storedKey) {
                // The versioned (v2) key: templates.js hands its stored key
                // through as the third argument, and an absent stored key still
                // opts in with "", so both sides compare the same format.
                return deriveCombinedValidityKeyAsync(
                    paths, disk.fs, typeof storedKey === "string" ? storedKey : ""
                );
            },
            // Sync_Validity_Key: a counting stub. The warm path must never
            // reach it (Requirement 1.2).
            getCombinedDiskValidityKey: function () {
                syncValidityKeyCalls++;
                return "sync-key-must-not-be-used";
            },
            saveLibraryIndex: function () { spies.saveLibraryIndex++; },

            // Bridge seam.
            csInterface: bridge.csInterface,
            encodeBridge: bridge.encodeBridge,
            decodeBridge: bridge.decodeBridge,

            // Scheduling seam.
            requestIdleCallback: idle.requestIdleCallback,
            cancelIdleCallback: idle.cancelIdleCallback,
            setTimeout: idle.setTimeout,
            clearTimeout: idle.clearTimeout,
            AppLifecycle: lifecycle,

            // Collaborators outside templates.js.
            updateCount: function () { spies.updateCount++; },
            updateCustomSelect: function () { },
            Settings: { get: function () { return []; }, set: function () { } },
            TextAnim: { attachHoverPreviews: function () { spies.hoverAttach++; } },
            showToast: function () { throw new Error("warm paint must never toast"); },
            nfs: function () { return { existsSync: function () { return false; } }; },
        },
    });

    // The real trace recorder, in the same realm, publishing onto `window`.
    vm.runInContext(OBSERVABILITY_SOURCE, sandbox.context, { filename: "observability.js" });
    sandbox.context.PerfEvents = windowObject.PerfEvents;

    return {
        scenario: scenario,
        entries: entries,
        // Filled by seedPersistedIndex: the roots whose real disk key changed
        // after the index was persisted.
        mutatedRoots: [],
        storedKey: null,
        currentKey: null,
        persisted: null,
        disk: disk,
        document: document,
        grids: grids,
        writes: writes,
        bridge: bridge,
        idle: idle,
        lifecycle: lifecycle,
        spies: spies,
        consoleCalls: consoleCalls,
        window: windowObject,
        context: sandbox.context,
        PerfEvents: windowObject.PerfEvents,
        syncValidityKeyCalls: function () { return syncValidityKeyCalls; },
        activeGrid: function () { return grids[sandbox.context.resolveSectionGridId()]; },
        recordsForRoot: recordsForRoot,
        setIndex: function (index) { persistedIndex.index = index; },
        /** The card ids currently parsed into the active grid, in order. */
        renderedCardIds: function () {
            const grid = grids[sandbox.context.resolveSectionGridId()];
            return grid.querySelectorAll(".card").map(function (card) { return card.id; });
        },
    };
}

/**
 * Derives the stored key over the pre-mutation disk, persists the index, then
 * applies the generated mutations so the roots in `scenario.mutations` are the
 * only ones whose real key changed.
 */
async function seedPersistedIndex(harness) {
    const scenario = harness.scenario;
    const storedKey = await deriveCombinedValidityKeyAsync(scenario.roots, harness.disk.fs, "");
    const persisted = persistLibraryIndex(harness.entries, storedKey);
    harness.setIndex(persisted.index);
    harness.storedKey = storedKey;
    harness.persisted = persisted;

    scenario.mutations.forEach(function (rootIndex, order) {
        const root = scenario.roots[rootIndex % scenario.roots.length];
        // Inside a section folder, where Root_Signature looks.
        harness.disk.addFile(
            root + "/" + SIGNATURE_SEED_FOLDER,
            "changed-" + order + ".aep", 4096 + order, 5000 + order
        );
        if (harness.mutatedRoots.indexOf(root) === -1) harness.mutatedRoots.push(root);
    });
    harness.currentKey = await deriveCombinedValidityKeyAsync(scenario.roots, harness.disk.fs, storedKey);
    return harness;
}

/**
 * Models the Startup_Controller edits in js/main.js: open the trace, open
 * `startup.init`, run warm paint, close the span. No timing arithmetic happens
 * here — all of it lives in the recorder.
 */
function runWarmStartup(harness) {
    const trace = harness.PerfEvents.beginStartupTrace({ generation: harness.scenario.generation });
    const initPhase = trace.beginPhase("startup.init");
    const warmPaint = harness.context.startupWarmPaint(harness.context.getLibraryIndex());
    initPhase.end({ warmPainted: warmPaint && warmPaint.painted === true });
    return { trace: trace, warmPaint: warmPaint, report: harness.window.__csStartupTrace };
}

/**
 * Drains the deferred queue and lets the validity / reconcile chains settle.
 * Each pass yields through `setImmediate`, which flushes the pending microtasks
 * (the real async key and `LibraryIndex.reconcile`) and any timer the reconcile
 * scheduled, so the drain is complete rather than merely started.
 */
async function drainDeferredWork(harness) {
    for (let pass = 0; pass < 8; pass++) {
        harness.idle.drain();
        await new Promise(function (resolve) { setImmediate(resolve); });
    }
    return harness;
}

/**
 * The Requirement 3.5 oracle: the same records rendered by ONE unbatched
 * `renderCards` call, on a fresh harness with its own fresh grids.
 *
 * The model is prepared exactly as warm paint prepares it (the persisted entry
 * objects become `allTemplates`, `section` derived with `getTemplateSection`),
 * then the real `filterStartupRecords()` selects the records and the real
 * `renderCards()` paints all of them in a single pass. Nothing here is batched,
 * so the resulting card set is the reference the batched run must reproduce.
 */
async function renderUnbatchedReference(scenario) {
    const reference = createStartupHarness(scenario);
    await seedPersistedIndex(reference);

    const entries = reference.context.getLibraryIndex()._entries;
    reference.context.allTemplates = entries;
    for (let i = 0; i < entries.length; i++) {
        entries[i].section = reference.context.getTemplateSection(entries[i]);
    }

    const records = reference.context.filterStartupRecords();
    reference.context.renderCards(records);

    return {
        harness: reference,
        records: records,
        cardIds: reference.renderedCardIds(),
        writes: reference.writes,
    };
}

// ─── Generators ─────────────────────────────────────────────────────────────
const ROOT_POOL = ["C:/lib/alpha", "C:/lib/beta", "D:/shared/gamma", "E:/archive/delta"];

const entrySpecArb = fc.record({
    name: fc.constantFrom("Intro", "Lower Third", "Glow", "Kinetic", "Bars", "Logo"),
    category: fc.constantFrom("All", "Titles", "Transitions", "Uncategorized"),
    favorite: fc.boolean(),
    section: fc.constantFrom.apply(fc, SECTION_VALUES),
});

const scenarioArb = fc.record({
    generation: fc.integer({ min: 1, max: 9 }),
    section: fc.constantFrom.apply(fc, SECTION_VALUES),
    category: fc.oneof(
        { weight: 4, arbitrary: fc.constant("All") },
        { weight: 1, arbitrary: fc.constantFrom("Favorites", "Titles", "Transitions", "Uncategorized") }
    ),
    roots: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 1, maxLength: 3 }),
    // At least one persisted entry, as the property requires. Small libraries
    // stay inside First_Batch; large ones exceed it, so the idle append batches
    // are exercised too.
    matching: fc.oneof(
        { weight: 2, arbitrary: fc.array(entrySpecArb, { minLength: 1, maxLength: 14 }) },
        { weight: 1, arbitrary: fc.array(entrySpecArb, { minLength: 61, maxLength: 95, size: "max" }) }
    ),
    others: fc.array(entrySpecArb, { maxLength: 15 }),
    // Which roots changed on disk after the index was persisted.
    mutations: fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }),
    idleMode: fc.constantFrom("idle", "timeout"),
});

// ─── Properties ─────────────────────────────────────────────────────────────
describe("startup warm paint", function () {
    test("warm paint precedes all disk and bridge work", async function () {
        /**
         * Feature: panel-reopen-startup, Property 1: Warm paint precedes all disk and bridge work
         * **Validates: Requirements 1.1, 1.2, 4.7, 7.2**
         */
        await fc.assert(fc.asyncProperty(scenarioArb, async function (scenario) {
            const harness = createStartupHarness(scenario);
            await seedPersistedIndex(harness);

            // Precondition: a persisted index with at least one entry and a
            // non-empty library path set.
            expect(harness.persisted.ok).toBe(true);
            expect(harness.persisted.index._entries.length).toBeGreaterThan(0);
            expect(scenario.roots.length).toBeGreaterThan(0);

            const startup = runWarmStartup(harness);

            // Warm paint served the reopen from the persisted index.
            expect(startup.warmPaint.painted).toBe(true);
            expect(startup.warmPaint.reason).toBe("index-parsed");
            expect(startup.warmPaint.cards).toBe(Math.min(startup.warmPaint.records, FIRST_BATCH));

            // A grid write happened, and it is the warm paint's single
            // full-replacement write (Requirement 1.1).
            expect(harness.writes.length).toBeGreaterThanOrEqual(1);
            const firstWrite = harness.writes[0];
            expect(firstWrite.kind).toBe("innerHTML");

            // Nothing was scanned or stat-ed before that write: zero bridge
            // calls, zero templates.scan calls, zero Sync_Validity_Key calls
            // (Requirements 1.1, 1.2, 7.2).
            expect(firstWrite.evalScripts).toBe(0);
            expect(firstWrite.scans).toBe(0);
            expect(firstWrite.validityKeyCalls).toBe(0);

            // The real trace agrees (Requirements 4.7, 7.2).
            const report = harness.window.__csStartupTrace;
            expect(report).toBe(startup.trace.report());
            expect(report.bridgeScans.beforeWarmPaint).toBe(0);
            expect(report.cache).toEqual({ decision: "hit", reason: "index-parsed" });
            expect(Number.isFinite(report.firstVisibleTemplateMs)).toBe(true);
            expect(report.firstVisibleTemplateCards).toBe(startup.warmPaint.cards);

            // Draining every deferred unit keeps the ordering: the async key and
            // the changed-root scans all land after the first paint, and the
            // synchronous whole-tree key is never consulted at all.
            await drainDeferredWork(harness);

            expect(harness.syncValidityKeyCalls()).toBe(0);
            expect(report.bridgeScans.beforeWarmPaint).toBe(0);
            expect(report.bridgeScans.total).toBe(harness.bridge.scanCalls.length);
            harness.bridge.calls.forEach(function (call) {
                expect(call.writeIndexAtCall).toBeGreaterThanOrEqual(1);
            });

            // Non-vacuity: when a root really changed on disk, the background
            // pass did issue its scans — after the paint, never before it.
            if (harness.mutatedRoots.length > 0) {
                expect(harness.currentKey).not.toBe(harness.storedKey);
                expect(harness.bridge.scanCalls.length).toBeGreaterThan(0);
                expect(report.validity.decision).toBe("stale");
            } else {
                expect(harness.currentKey).toBe(harness.storedKey);
                expect(harness.bridge.scanCalls.length).toBe(0);
                expect(report.validity.decision).toBe("fresh");
            }

            // Warm paint never toasts and never logs an error.
            expect(harness.consoleCalls.filter(function (entry) {
                return entry.channel === "error";
            })).toEqual([]);

            return true;
        }), { numRuns: 15, seed: 20260722 });
    });

    test("bounded first pass, complete batched result", async function () {
        /**
         * Feature: panel-reopen-startup, Property 2: Bounded first pass, complete batched result
         * **Validates: Requirements 3.2, 3.3, 3.5**
         */
        await fc.assert(fc.asyncProperty(scenarioArb, async function (scenario) {
            const harness = createStartupHarness(scenario);
            await seedPersistedIndex(harness);
            expect(harness.persisted.ok).toBe(true);

            // The bounds are read from the shipped source constants rather than
            // restated by the test (Requirement 3.1).
            const firstBatch = harness.context.TEMPLATE_FIRST_BATCH;
            const appendBatch = harness.context.TEMPLATE_APPEND_BATCH;
            expect(firstBatch).toBe(FIRST_BATCH);
            expect(appendBatch).toBe(FIRST_BATCH);

            const startup = runWarmStartup(harness);
            const total = startup.warmPaint.records;
            const expectedFirstPass = Math.min(total, firstBatch);

            // Requirement 3.2: the first render pass is exactly min(n, 60)
            // cards, committed in one grid write and nothing more.
            expect(startup.warmPaint.cards).toBe(expectedFirstPass);
            expect(harness.renderedCardIds().length).toBe(expectedFirstPass);
            expect(harness.writes.length).toBe(1);
            expect(harness.writes[0].kind).toBe("innerHTML");

            // Requirement 3.3: the remainder arrives on later idle work units.
            // Stepping the queue one unit at a time makes each batch's effect on
            // the grid observable; the awaits let the async validity/reconcile
            // chains settle between units.
            let rendered = expectedFirstPass;
            const deltas = [];
            for (let step = 0; step < 24; step++) {
                if (harness.idle.pending() > 0) {
                    harness.idle.drain(1);
                    const count = harness.renderedCardIds().length;
                    deltas.push(count - rendered);
                    rendered = count;
                }
                await new Promise(function (resolve) { setImmediate(resolve); });
            }
            await drainDeferredWork(harness);

            // No single unit ever grew the grid by more than TEMPLATE_APPEND_BATCH.
            deltas.forEach(function (delta) {
                expect(delta).toBeLessThanOrEqual(appendBatch);
            });

            // The real trace agrees, per batch and in aggregate: every recorded
            // startup.batch-append unit stayed within the bound, and the batches
            // together carry exactly the records the first pass left out.
            const report = harness.window.__csStartupTrace;
            const appendPhases = report.phases.filter(function (phase) {
                return phase.name === "startup.batch-append";
            });
            appendPhases.forEach(function (phase) {
                expect(phase.fields.cards).toBeLessThanOrEqual(appendBatch);
            });
            expect(report.batches.cards).toBe(total - expectedFirstPass);

            // Non-vacuity: libraries larger than First_Batch really did batch,
            // and libraries that fit in it never scheduled an append.
            if (total > firstBatch) {
                expect(appendPhases.length).toBeGreaterThanOrEqual(1);
                expect(report.batches.count).toBeGreaterThanOrEqual(1);
            } else {
                expect(report.batches.count).toBe(0);
            }

            // Requirement 3.5: after every batch has drained, the rendered set
            // is exactly what a single unbatched renderCards over the same
            // records produces.
            const reference = await renderUnbatchedReference(scenario);
            expect(reference.writes.length).toBe(1);
            expect(reference.records.length).toBe(total);

            const finalIds = harness.renderedCardIds();
            expect(finalIds.length).toBe(total);
            expect(finalIds.slice().sort()).toEqual(reference.cardIds.slice().sort());

            return true;
        }), { numRuns: 15, seed: 20260723 });
    });

    test("everything expensive happens after the first paint", async function () {
        /**
         * Feature: panel-reopen-startup, Property 3: Everything expensive happens after the first paint
         * **Validates: Requirements 1.3, 3.4**
         */
        await fc.assert(fc.asyncProperty(scenarioArb, async function (scenario) {
            const harness = createStartupHarness(scenario);
            await seedPersistedIndex(harness);
            expect(harness.persisted.ok).toBe(true);

            // Every deferred phase named by Requirement 3.4 (plus the async
            // validity key of Requirement 1.3). Each one must open strictly
            // after the warm paint span closed.
            const DEFERRED = [
                "startup.category-build",
                "startup.batch-append",
                "startup.validity-key",
                "startup.reconcile",
            ];

            // The real span stream, read from the shipped emitter in the harness
            // realm: span(name) emits "<name>:start" then "<name>:end". Each
            // event also carries the grid-write count as it stood when it fired.
            const events = [];
            const unsubscribe = harness.PerfEvents.subscribe(function (event) {
                events.push({ name: String(event.name), writes: harness.writes.length });
            });

            // Explicit spies on the deferred category build. Both delegate to the
            // shipped implementations, so ordering is observed without changing
            // what runs.
            const categoryCalls = [];
            ["buildCategoryTabs", "buildCategoryPanel"].forEach(function (name) {
                const real = harness.context[name];
                expect(typeof real).toBe("function");
                harness.context[name] = function () {
                    categoryCalls.push({ name: name, writes: harness.writes.length });
                    return real.apply(this, arguments);
                };
            });

            const startup = runWarmStartup(harness);
            expect(startup.warmPaint.painted).toBe(true);

            // The first paint is a real grid write, and nothing deferred had run
            // when it happened (Requirement 3.4).
            expect(harness.writes.length).toBe(1);
            expect(harness.writes[0].kind).toBe("innerHTML");
            expect(categoryCalls).toEqual([]);

            await drainDeferredWork(harness);
            unsubscribe();

            const names = events.map(function (event) { return event.name; });
            const paintStart = names.indexOf("startup.warm-paint:start");
            const paintEnd = names.indexOf("startup.warm-paint:end");
            expect(paintStart).toBeGreaterThanOrEqual(0);
            expect(paintEnd).toBeGreaterThan(paintStart);
            // One warm paint per startup: no second span reopens it.
            expect(names.lastIndexOf("startup.warm-paint:end")).toBe(paintEnd);

            // Requirements 1.3 and 3.4: every deferred phase opens strictly after
            // the warm paint span closed, and every one of those opens is after
            // the grid already carried the first painted cards.
            const deferredStarts = {};
            events.forEach(function (event, index) {
                DEFERRED.forEach(function (phase) {
                    if (event.name !== phase + ":start") return;
                    expect(index).toBeGreaterThan(paintEnd);
                    expect(event.writes).toBeGreaterThanOrEqual(1);
                    deferredStarts[phase] = (deferredStarts[phase] || 0) + 1;
                });
            });

            // The category build itself ran once, both halves, after the paint.
            expect(categoryCalls.map(function (call) { return call.name; }))
                .toEqual(["buildCategoryTabs", "buildCategoryPanel"]);
            categoryCalls.forEach(function (call) {
                expect(call.writes).toBeGreaterThanOrEqual(1);
            });

            // Non-vacuity: the phases that must exist for this scenario really
            // were emitted, so the ordering assertions above had subjects.
            expect(deferredStarts["startup.category-build"]).toBe(1);
            expect(deferredStarts["startup.validity-key"]).toBe(1);

            const total = startup.warmPaint.records;
            if (total > harness.context.TEMPLATE_FIRST_BATCH) {
                expect(deferredStarts["startup.batch-append"]).toBeGreaterThanOrEqual(1);
            } else {
                expect(deferredStarts["startup.batch-append"]).toBeUndefined();
            }

            if (harness.mutatedRoots.length > 0) {
                expect(deferredStarts["startup.reconcile"]).toBeGreaterThanOrEqual(1);
            } else {
                expect(deferredStarts["startup.reconcile"]).toBeUndefined();
            }

            // The recorded report agrees with the span stream: every deferred
            // phase the trace kept is one the stream also opened after the paint.
            const report = harness.window.__csStartupTrace;
            report.phases.forEach(function (phase) {
                if (DEFERRED.indexOf(phase.name) === -1) return;
                expect(names.indexOf(phase.name + ":start")).toBeGreaterThan(paintEnd);
            });

            return true;
        }), { numRuns: 15, seed: 20260724 });
    });

    /**
     * Drives TWO harnesses to quiescence in lockstep, so neither scheduling mode
     * gets more chances to finish than the other. Each pass drains both idle
     * queues, then yields through `setImmediate` (flushing the microtask chains
     * of the real async validity key) and through a real timer tick (letting the
     * work-unit yields inside the real `LibraryIndex.reconcile` resume). The loop
     * stops as soon as both worlds report their queues empty and their appends
     * and reconciliation complete, so a world that never finishes is still
     * observed as unfinished rather than being papered over.
     */
    async function settleBothHarnesses(first, second) {
        function settled(harness) {
            const pending = harness.context._startupPending;
            if (harness.idle.pending() > 0) return false;
            return !!pending && pending.appendsDone === true && pending.reconcileDone === true;
        }
        for (let pass = 0; pass < 40; pass++) {
            first.idle.drain();
            second.idle.drain();
            await new Promise(function (resolve) { setImmediate(resolve); });
            await new Promise(function (resolve) { setTimeout(resolve, 0); });
            if (settled(first) && settled(second)) break;
        }
    }

    test("idle batching is equivalent without requestIdleCallback", async function () {
        /**
         * Feature: panel-reopen-startup, Property 11: Idle batching is equivalent without requestIdleCallback
         * **Validates: Requirements 5.5, 3.5**
         *
         * Two independent startup worlds are built from the SAME generated
         * scenario, differing only in which scheduling primitive the runtime
         * offers: one exposes `requestIdleCallback`, the other exposes only
         * `setTimeout` (the Requirement 5.5 fallback, where the injected
         * `requestIdleCallback` global is genuinely absent). Both are drained to
         * completion and compared.
         */
        await fc.assert(fc.asyncProperty(scenarioArb, async function (scenario) {
            const idleHarness = createStartupHarness(Object.assign({}, scenario, { idleMode: "idle" }));
            await seedPersistedIndex(idleHarness);
            const timeoutHarness = createStartupHarness(Object.assign({}, scenario, { idleMode: "timeout" }));
            await seedPersistedIndex(timeoutHarness);

            // The fallback world really lacks the idle API: the shipped
            // `typeof requestIdleCallback === "function"` probe cannot pass.
            expect(idleHarness.idle.mode).toBe("idle");
            expect(typeof idleHarness.context.requestIdleCallback).toBe("function");
            expect(timeoutHarness.idle.mode).toBe("timeout");
            expect(timeoutHarness.context.requestIdleCallback).toBeUndefined();
            expect(timeoutHarness.context.cancelIdleCallback).toBeUndefined();

            const idleStartup = runWarmStartup(idleHarness);
            const timeoutStartup = runWarmStartup(timeoutHarness);

            // Same warm paint on both sides, so the batching that follows starts
            // from the same cursor over the same record set.
            expect(idleStartup.warmPaint.painted).toBe(true);
            expect(timeoutStartup.warmPaint.painted).toBe(true);
            expect(timeoutStartup.warmPaint.records).toBe(idleStartup.warmPaint.records);
            expect(timeoutStartup.warmPaint.cards).toBe(idleStartup.warmPaint.cards);

            await settleBothHarnesses(idleHarness, timeoutHarness);

            const total = idleStartup.warmPaint.records;
            const firstPass = idleStartup.warmPaint.cards;
            const idleReport = idleHarness.window.__csStartupTrace;
            const timeoutReport = timeoutHarness.window.__csStartupTrace;

            // Requirement 3.5 — the same final card set, and it is the complete
            // one, whichever primitive drove the appends.
            const idleIds = idleHarness.renderedCardIds();
            const timeoutIds = timeoutHarness.renderedCardIds();
            expect(idleIds.length).toBe(total);
            expect(timeoutIds.length).toBe(total);
            expect(timeoutIds.slice().sort()).toEqual(idleIds.slice().sort());

            // The same batch count bound: identical number of append units, each
            // within TEMPLATE_APPEND_BATCH, carrying identical card totals.
            const appendBatch = timeoutHarness.context.TEMPLATE_APPEND_BATCH;
            function appendPhases(report) {
                return report.phases.filter(function (phase) {
                    return phase.name === "startup.batch-append";
                });
            }
            const idleAppends = appendPhases(idleReport);
            const timeoutAppends = appendPhases(timeoutReport);
            expect(timeoutAppends.length).toBe(idleAppends.length);
            expect(timeoutAppends.map(function (phase) { return phase.fields.cards; }))
                .toEqual(idleAppends.map(function (phase) { return phase.fields.cards; }));
            timeoutAppends.forEach(function (phase) {
                expect(phase.fields.cards).toBeLessThanOrEqual(appendBatch);
            });
            expect(timeoutReport.batches).toEqual(idleReport.batches);
            expect(timeoutReport.batches.cards).toBe(total - firstPass);

            // The same completion signal: appends done, reconciliation done, and
            // the single finalize decision resolved the same way.
            const idlePending = idleHarness.context._startupPending;
            const timeoutPending = timeoutHarness.context._startupPending;
            expect(idlePending).toBeTruthy();
            expect(timeoutPending).toBeTruthy();
            expect(idlePending.appendsDone).toBe(true);
            expect(timeoutPending.appendsDone).toBe(idlePending.appendsDone);
            expect(timeoutPending.reconcileDone).toBe(idlePending.reconcileDone);
            expect(timeoutPending.finalized === true).toBe(idlePending.finalized === true);
            expect(timeoutPending.cursor).toBe(idlePending.cursor);
            expect(timeoutReport.finalRerender).toBe(idleReport.finalRerender);
            expect(timeoutReport.validity.decision).toBe(idleReport.validity.decision);
            expect(timeoutReport.unavailable).toEqual(idleReport.unavailable);

            // Requirement 5.5 — the fallback world scheduled every startup unit
            // with setTimeout at delay 16 and never touched the idle API, while
            // the idle world used requestIdleCallback with { timeout: 200 } and
            // scheduled no startup unit through setTimeout. The two counts match,
            // which is what makes the drains above comparable.
            const idleRequests = idleHarness.idle.scheduledVia("requestIdleCallback");
            const idleFallbacks = idleHarness.idle.scheduledVia("setTimeout").filter(function (entry) {
                return entry.delay === 16;
            });
            const timeoutFallbacks = timeoutHarness.idle.scheduledVia("setTimeout").filter(function (entry) {
                return entry.delay === 16;
            });
            expect(timeoutHarness.idle.scheduledVia("requestIdleCallback")).toEqual([]);
            expect(idleFallbacks).toEqual([]);
            expect(idleRequests.length).toBeGreaterThanOrEqual(1);
            idleRequests.forEach(function (entry) {
                expect(entry.options).toEqual({ timeout: 200 });
            });
            expect(timeoutFallbacks.length).toBe(idleRequests.length);
            timeoutFallbacks.forEach(function (entry) {
                expect(entry.delay).toBe(16);
            });

            // Neither world leaked a startup-owned handle, and both released the
            // same number of them (Requirement 5.6 holds on the fallback path).
            expect(timeoutHarness.lifecycle.entries.length).toBe(idleHarness.lifecycle.entries.length);
            expect(timeoutHarness.idle.pending()).toBe(0);
            expect(idleHarness.idle.pending()).toBe(0);

            return true;
        }), { numRuns: 15, seed: 20260725 });
    });
});
