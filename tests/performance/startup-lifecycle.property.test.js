"use strict";

// Startup lifecycle properties for feature panel-reopen-startup.
//
// The readiness callback under test is the real shipped source: it is extracted
// from js/main.js by the exact marker string the containment harness relies on
// (`var readinessTimer = setInterval(function () {`), brace-matched, and executed
// in a bare vm context that provides only the globals the callback is allowed to
// see. The lifecycle is the real one from js/core/appLifecycle.js, so transition
// ordering, work accounting, and token disposal semantics are not simulated.
//
// Properties 8 and 9 (tasks 6.4 and 6.5) are appended to this suite.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const ROOT = path.resolve(__dirname, "../..");
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, "js/main.js"), "utf8");
const lifecycleModule = require(path.join(ROOT, "js/core/appLifecycle.js"));

const READINESS_MARKER = "var readinessTimer = setInterval(function () {";
const BRIDGE_CALLBACK_MARKER = "connectDefaultLibrary(function () {";
const TEMPLATE_FIRST_BATCH = 60;
const SECTION_NAMES = ["comp", "icon", "text", "effect"];
const MODULE_NAMES = ["templates", "toolkit", "settings"];
const MODULES = { TEMPLATES: "templates", TOOLKIT: "toolkit", SETTINGS: "settings" };
const TIMER_HANDLE = 4242;

function extractFunctionExpression(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) throw new Error("Missing source marker: " + marker);
    const start = source.indexOf("function", markerIndex);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}") {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error("Unterminated function expression for marker: " + marker);
}

const READINESS_CALLBACK_SOURCE = extractFunctionExpression(MAIN_SOURCE, READINESS_MARKER);
const BRIDGE_CALLBACK_SOURCE = extractFunctionExpression(MAIN_SOURCE, BRIDGE_CALLBACK_MARKER);

function otherSection(activeSection) {
    for (let index = 0; index < SECTION_NAMES.length; index++) {
        if (SECTION_NAMES[index] !== activeSection) return SECTION_NAMES[index];
    }
    return activeSection;
}

// Executes the shipped readiness callback against a warm-painted grid, driving
// it through a faithful setInterval model: once the callback clears its handle
// the interval stops firing, exactly as it does in the panel.
function readinessWarmPathBoundary(input) {
    const lifecycle = lifecycleModule.createAppLifecycle();
    const attempted = [];
    const accepted = [];
    const baseTransition = lifecycle.transition;
    lifecycle.transition = function (state) {
        const ok = baseTransition(state);
        attempted.push(state);
        if (ok) accepted.push(state);
        return ok;
    };
    const workEnds = [];
    const baseWorkEnd = lifecycle.markWorkEnd;
    lifecycle.markWorkEnd = function (owner, id) {
        workEnds.push(String(owner) + "::" + String(id));
        return baseWorkEnd(owner, id);
    };

    lifecycle.transition("BOOTSTRAPPING");
    lifecycle.markWorkStart("startup", "default-library");
    lifecycle.transition("SHELL_VISIBLE");

    let timerLive = true;
    let intervalStops = 0;
    let clearIntervalCalls = 0;
    function clearIntervalStub(handle) {
        clearIntervalCalls++;
        if (handle === TIMER_HANDLE && timerLive) {
            timerLive = false;
            intervalStops++;
        }
    }

    // Real lifecycle token: dispose() is idempotent at the registry level, so a
    // disposal count above 1 means the readiness teardown ran more than once.
    let tokenDisposals = 0;
    const readinessToken = lifecycle.register("timer", TIMER_HANDLE, function (handle) {
        tokenDisposals++;
        clearIntervalStub(handle);
    });

    let bridgeResolutions = 0;
    const csInterface = {
        evalScript: function (script, done) {
            bridgeResolutions++;
            if (typeof done === "function") done("ok");
        },
    };

    const filler = otherSection(input.activeSection);
    const templates = [];
    for (let index = 0; index < input.total; index++) {
        templates.push({ section: index < input.active ? input.activeSection : filler });
    }
    const paintedCards = Math.min(input.active, TEMPLATE_FIRST_BATCH);
    const paintedImages = [];
    for (let index = 0; index < paintedCards; index++) paintedImages.push({ complete: true });
    const firstCard = { querySelector: function () { return {}; } };

    const context = {
        allTemplates: templates,
        currentSection: input.activeSection,
        currentMainModule: input.module,
        MODULES: MODULES,
        getTemplateSection: function (template) { return template.section; },
        document: {
            getElementById: function (id) {
                return id === "template-count" ? { textContent: input.badge } : null;
            },
            querySelector: function () { return paintedCards > 0 ? firstCard : null; },
            querySelectorAll: function () { return paintedImages; },
        },
        AppLifecycle: lifecycle,
        clearInterval: clearIntervalStub,
        csInterface: csInterface,
        __readinessToken: readinessToken,
    };
    vm.createContext(context);
    vm.runInContext(
        "var readinessChecks=0,readinessTimer=" + TIMER_HANDLE + "," +
        "readinessTimerToken=__readinessToken," +
        "lifecycleLibraryWorkId='default-library';" +
        "var __readinessTick=(" + READINESS_CALLBACK_SOURCE + ");",
        context,
        { filename: "main-readiness-warm-path.js" }
    );

    let deliveredTicks = 0;
    let readinessTick = -1;
    function tick() {
        if (!timerLive) return false;
        deliveredTicks++;
        context.__readinessTick();
        if (readinessTick < 0 && !timerLive) readinessTick = deliveredTicks - 1;
        return true;
    }

    tick();
    const bridgeResolutionsAtReadiness = bridgeResolutions;

    // Bridge work resolves only after readiness; the counter is live, so any
    // evalScript reached from the readiness path would show up above.
    csInterface.evalScript("getAllTemplates('root')", function () { });

    for (let index = 0; index < input.postArrivals; index++) tick();
    for (let index = 0; index < input.extraDisposals; index++) readinessToken.dispose();

    return {
        state: lifecycle.getState(),
        idle: lifecycle.isBackgroundIdle(),
        acceptedTransitions: accepted,
        firstCardUsableCount: accepted.filter(function (s) { return s === "FIRST_CARD_USABLE"; }).length,
        libraryReadyCount: accepted.filter(function (s) { return s === "LIBRARY_READY"; }).length,
        degradedAttempts: attempted.filter(function (s) { return s === "DEGRADED"; }).length,
        startupWorkEnds: workEnds.filter(function (key) { return key === "startup::default-library"; }).length,
        intervalStops: intervalStops,
        clearIntervalCalls: clearIntervalCalls,
        tokenDisposals: tokenDisposals,
        timerLive: timerLive,
        deliveredTicks: deliveredTicks,
        readinessTick: readinessTick,
        bridgeResolutionsAtReadiness: bridgeResolutionsAtReadiness,
        bridgeResolutionsTotal: bridgeResolutions,
        residualTimers: lifecycle.snapshotCounts().timer || 0,
        bridgeCallbackTouchesReadiness:
            /FIRST_CARD_USABLE|LIBRARY_READY|markWorkEnd/.test(BRIDGE_CALLBACK_SOURCE),
    };
}

const warmReadinessInput = fc.record({
    counts: fc.integer({ min: 1, max: 500 }).chain(function (total) {
        return fc.record({
            total: fc.constant(total),
            active: fc.integer({ min: 1, max: total }),
        });
    }),
    activeSection: fc.constantFrom.apply(fc, SECTION_NAMES),
    module: fc.constantFrom.apply(fc, MODULE_NAMES),
    badgeNoise: fc.constantFrom("TK", "SETTINGS", "", "0", "999", "—"),
    postArrivals: fc.integer({ min: 0, max: 6 }),
    extraDisposals: fc.integer({ min: 0, max: 3 }),
});

describe("panel-reopen-startup readiness", function () {
    test("a warm-painted 334-record repository reaches readiness on the first tick", function () {
        const observation = readinessWarmPathBoundary({
            total: 334, active: 129, activeSection: "comp", module: "templates",
            badge: "129", postArrivals: 5, extraDisposals: 2,
        });
        expect(observation.state).toBe("BACKGROUND_IDLE");
        expect(observation.readinessTick).toBe(0);
        expect(observation.bridgeResolutionsAtReadiness).toBe(0);
        expect(observation.firstCardUsableCount).toBe(1);
        expect(observation.libraryReadyCount).toBe(1);
        expect(observation.startupWorkEnds).toBe(1);
        expect(observation.intervalStops).toBe(1);
        expect(observation.tokenDisposals).toBe(1);
        expect(observation.residualTimers).toBe(0);
    });

    // Feature: panel-reopen-startup, Property 6: Readiness is warm-paint driven, idempotent, and torn down exactly once
    // **Validates: Requirements 2.3, 2.5, 2.8, 2.9, 2.10**
    test("readiness is warm-paint driven, idempotent, and torn down exactly once", function () {
        fc.assert(fc.property(warmReadinessInput, function (input) {
            const activeCount = input.counts.active;
            const badge = input.module === MODULES.TEMPLATES ? String(activeCount) : input.badgeNoise;
            const observation = readinessWarmPathBoundary({
                total: input.counts.total,
                active: activeCount,
                activeSection: input.activeSection,
                module: input.module,
                badge: badge,
                postArrivals: input.postArrivals,
                extraDisposals: input.extraDisposals,
            });

            // Req 2.3 / 2.8 / 2.9: warm paint plus a badge equal to active-section
            // cardinality (or a non-Templates module) satisfies readiness on the
            // first check, with zero evalScript resolutions behind it.
            expect(observation.readinessTick).toBe(0);
            expect(observation.deliveredTicks).toBe(1);
            expect(observation.bridgeResolutionsAtReadiness).toBe(0);
            expect(observation.bridgeResolutionsTotal).toBe(1);
            expect(observation.state).toBe("BACKGROUND_IDLE");
            expect(observation.idle).toBe(true);
            expect(observation.acceptedTransitions.slice(-2))
                .toEqual(["FIRST_CARD_USABLE", "LIBRARY_READY"]);
            expect(observation.degradedAttempts).toBe(0);

            // Req 2.5 / 2.10: every readiness effect happens exactly once across
            // any number of subsequent arrivals, and the bridge callback owns none
            // of them.
            expect(observation.firstCardUsableCount).toBe(1);
            expect(observation.libraryReadyCount).toBe(1);
            expect(observation.startupWorkEnds).toBe(1);
            expect(observation.intervalStops).toBe(1);
            expect(observation.tokenDisposals).toBe(1);
            expect(observation.timerLive).toBe(false);
            expect(observation.residualTimers).toBe(0);
            expect(observation.bridgeCallbackTouchesReadiness).toBe(false);
        }), { seed: 60301, numRuns: 15, verbose: 2 });
    });
});

/**
 * Property 6: readiness is driven by warm paint alone — no evalScript resolution
 * gates it — and FIRST_CARD_USABLE, LIBRARY_READY, markWorkEnd("startup", ...),
 * the interval stop, and the readiness-token disposal each happen exactly once
 * no matter how many further callback arrivals or disposals follow.
 *
 * **Validates: Requirements 2.3, 2.5, 2.8, 2.9, 2.10**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Property 8 harness: real startup handles on a real AppLifecycle
// ─────────────────────────────────────────────────────────────────────────────
//
// Property 8 needs handles that were really created by shipped code, so this
// half of the suite drives the REAL startup queue of `js/templates/templates.js`
// (`startupWarmPaint` → `queueStartupDeferredWork` → `scheduleStartupIdle` →
// `startupCategoryUnit` / `startupAppendUnit`) against:
//
//   - the REAL `AppLifecycle` from js/core/appLifecycle.js (one instance per
//     close/reopen cycle, exactly as a new CEF context gets one),
//   - a REAL persisted `LibraryIndex` round-tripped through
//     `serialize()` / `tryParse()` (js/core/persistence.js),
//   - the REAL async validity key `deriveCombinedValidityKeyAsync` over an
//     in-memory asynchronous filesystem, so the stale/fresh decision and any
//     background reconciliation are shipped code deciding from disk state,
//   - a REAL parsed DOM (tests/helpers/miniDom.js).
//
// Only the environment is substituted: the CEP bridge, the idle/timeout
// scheduling primitives (tracked so every handle the runtime handed out is
// observable), `updateCount`, and `saveLibraryIndex`.

const { loadHelpers, REPO_ROOT } = require("../helpers/loadHelpers.js");
const { createMiniDocument } = require("../helpers/miniDom.js");
const {
    LibraryIndex,
    LIBRARY_INDEX_VERSION,
    parseCombinedValidityKey,
    deriveCombinedValidityKeyAsync,
    getLastLibraryIndexLoadReason,
} = require("../../js/core/persistence.js");

const GRID_IDS = [
    "comp-list-container",
    "icon-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container",
];

const handleConstants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const HANDLE_SECTIONS = handleConstants.get("SECTIONS");
const HANDLE_IMAGE_SECTIONS = handleConstants.get("IMAGE_SECTIONS");
const handleUtils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: HANDLE_SECTIONS, IMAGE_SECTIONS: HANDLE_IMAGE_SECTIONS },
});
const HANDLE_SECTION_VALUES = Object.keys(HANDLE_SECTIONS).map(function (key) {
    return HANDLE_SECTIONS[key];
});
const ROOT_POOL = ["C:/lib/alpha", "D:/shared/beta"];
const BASELINE_KINDS = ["listener", "observer", "watcher", "timer", "subscription"];

function hex(value) {
    return Buffer.from(String(value), "utf8").toString("hex");
}
function unhex(value) {
    return Buffer.from(String(value), "hex").toString("utf8");
}

// ─── Section folders, as ExtendScript sees them ──────────────────────────────
// The startup scan is section-chunked: templates.js issues one
// `getAllTemplates(rootHex, sectionHex)` per section folder rather than a single
// all-sections call, because one all-sections call blocks After Effects' main
// thread for the whole library. `jsx/core.jsx` answers each call with the records
// of that one folder, so the harness bridges below must too.
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
 * Parses one `getAllTemplates` bridge script. Returns `{ root, section }` for the
 * chunked two-argument form the shipped scanner issues, `{ root, section: "" }`
 * for the one-argument all-sections form, and null for anything else.
 */
function parseScanScript(script) {
    const text = String(script);
    const scoped = /^getAllTemplates\("([0-9a-fA-F]*)","([0-9a-fA-F]*)"\)$/.exec(text);
    if (scoped) return { root: unhex(scoped[1]), section: unhex(scoped[2]) };
    const all = /^getAllTemplates\("([0-9a-fA-F]*)"\)$/.exec(text);
    if (all) return { root: unhex(all[1]), section: "" };
    return null;
}

/** The records of `list` an ExtendScript scan of `folder` would return ("" = all). */
function recordsInScanFolder(list, folder) {
    if (folder === "") return list;
    return list.filter(function (record) { return scanFolderForRecord(record) === folder; });
}

/**
 * The scheduling primitives, tracked. Every handle `requestIdleCallback` or
 * `setTimeout` hands out is remembered, and every cancel is counted per handle,
 * so "was this handle registered" and "was it released exactly once" are decided
 * from the raw runtime handles rather than from the registry's own bookkeeping.
 */
function createTrackedScheduler(mode) {
    const queue = [];
    const created = [];
    const cancels = {};
    let nextHandle = 1;
    let ran = 0;

    function push(fn, kind) {
        const handle = nextHandle++;
        created.push({ handle: handle, kind: kind });
        cancels[handle] = 0;
        queue.push({ handle: handle, fn: fn });
        return handle;
    }
    function cancel(handle) {
        cancels[handle] = (cancels[handle] || 0) + 1;
        for (let i = 0; i < queue.length; i++) {
            if (queue[i].handle === handle) { queue.splice(i, 1); return true; }
        }
        return false;
    }

    const api = {
        mode: mode,
        created: created,
        cancels: cancels,
        ran: function () { return ran; },
        pending: function () { return queue.length; },
        setTimeout: function (fn) { return push(fn, "timeout"); },
        clearTimeout: cancel,
        /** Runs at most `limit` queued units; units may enqueue more. */
        step: function (limit) {
            const max = typeof limit === "number" ? limit : 1;
            let steps = 0;
            while (queue.length > 0 && steps < max) {
                const unit = queue.shift();
                steps++;
                ran++;
                unit.fn();
            }
            return steps;
        },
    };
    if (mode === "idle") {
        api.requestIdleCallback = function (fn) { return push(fn, "idle"); };
        api.cancelIdleCallback = cancel;
    } else {
        api.requestIdleCallback = undefined;
        api.cancelIdleCallback = undefined;
    }
    return api;
}

/**
 * The real lifecycle plus a recording facade. Baseline (pre-startup) owners are
 * registered straight onto the lifecycle; only registrations that arrive through
 * the facade — the ones templates.js makes — count as startup owned.
 */
function createHandleOwner() {
    const lifecycle = lifecycleModule.createAppLifecycle();
    const rawRegister = lifecycle.register;
    const startupRegistrations = [];
    let maxLive = 0;

    function liveStartupHandles() {
        return startupRegistrations.filter(function (entry) { return entry.live; }).length;
    }
    function sample() {
        const live = liveStartupHandles();
        if (live > maxLive) maxLive = live;
        return live;
    }

    const facade = {
        register: function (kind, resource, dispose) {
            const record = { kind: kind, handle: resource, live: true, disposals: 0 };
            startupRegistrations.push(record);
            const token = rawRegister(kind, resource, function (handle) {
                record.disposals++;
                record.live = false;
                if (typeof dispose === "function") dispose(handle);
            });
            sample();
            return token;
        },
        onDispose: lifecycle.onDispose,
        listen: lifecycle.listen,
        subscribe: lifecycle.subscribe,
        transition: lifecycle.transition,
        markWorkStart: lifecycle.markWorkStart,
        markWorkEnd: lifecycle.markWorkEnd,
        isBackgroundIdle: lifecycle.isBackgroundIdle,
        snapshotCounts: lifecycle.snapshotCounts,
        getState: lifecycle.getState,
    };

    return {
        lifecycle: lifecycle,
        facade: facade,
        startupRegistrations: startupRegistrations,
        liveStartupHandles: liveStartupHandles,
        sample: sample,
        maxLive: function () { return maxLive; },
        registerBaseline: function (kind, id, onDispose) {
            return rawRegister(kind, { id: id }, onDispose);
        },
    };
}

/** Async filesystem the real combined validity key reads. */
function createHandleFilesystem() {
    const dirs = {};
    function ensureDir(dir) {
        if (!dirs[dir]) dirs[dir] = { mtimeMs: 1000, files: {} };
        return dirs[dir];
    }
    return {
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

function buildHandleEntries(scenario) {
    const entries = [];
    for (let index = 0; index < scenario.records; index++) {
        const root = scenario.roots[index % scenario.roots.length];
        entries.push({
            id: "h-" + index,
            name: "Handle " + index,
            category: "Titles",
            section: scenario.section,
            type: scenario.section,
            favorite: false,
            folderPath: root + "/" + scenario.section + "/" + index,
            sourcePath: root,
            thumbnail: "",
        });
    }
    return entries;
}

/**
 * One panel context: a fresh vm realm holding the real templates.js, a fresh
 * real `AppLifecycle`, a tracked scheduler, and a parsed DOM with the six grids
 * index.html defines.
 */
function createHandleWorld(scenario, cycle) {
    const entries = buildHandleEntries(scenario);

    const disk = createHandleFilesystem();
    scenario.roots.forEach(function (root, rootIndex) {
        disk.addDirectory(root);
        for (let i = 0; i <= rootIndex; i++) {
            disk.addFile(root, "seed-" + i + ".aep", 1024 + i, 1000 + i);
        }
    });

    const document = createMiniDocument();
    GRID_IDS.forEach(function (gridId) {
        const grid = document.createElement("div");
        grid.id = gridId;
        grid.className = "card-grid";
        document.body.appendChild(grid);
        grid.insertAdjacentHTML = function (position, markup) {
            if (position !== "beforeend") throw new Error("harness supports beforeend only");
            const holder = document.createElement("div");
            holder.innerHTML = markup;
            const moving = holder.children;
            for (let i = 0; i < moving.length; i++) grid.appendChild(moving[i]);
        };
    });

    const scheduler = createTrackedScheduler(cycle.idleMode);
    const owner = createHandleOwner();
    const scans = [];
    const spies = { updateCount: 0, saveLibraryIndex: 0 };
    const persisted = { index: null };

    function recordsForRoot(root) {
        const normalized = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
        return JSON.parse(JSON.stringify(entries.filter(function (entry) {
            return String(entry.sourcePath).replace(/\\/g, "/").replace(/\/+$/, "") === normalized;
        })));
    }

    const csInterface = {
        evalScript: function (script, callback) {
            const parsed = parseScanScript(script);
            if (!parsed) {
                if (typeof callback === "function") callback("");
                return;
            }
            scans.push({ root: parsed.root, section: parsed.section });
            const records = recordsInScanFolder(recordsForRoot(parsed.root), parsed.section);
            if (typeof callback === "function") {
                callback(hex(JSON.stringify(records)));
            }
        },
    };

    const consoleErrors = [];
    const windowObject = {
        Date: Date,
        console: {
            log: function () { },
            warn: function () { },
            error: function (message) { consoleErrors.push(String(message)); },
        },
    };

    const sandbox = loadHelpers({
        file: path.join("js", "templates", "templates.js"),
        lenient: false,
        injected: {
            window: windowObject,
            console: windowObject.console,
            document: document,

            SECTIONS: HANDLE_SECTIONS,
            IMAGE_SECTIONS: HANDLE_IMAGE_SECTIONS,
            escapeAttr: handleUtils.get("escapeAttr"),
            escapeHTML: handleUtils.get("escapeHTML"),
            getTemplateSection: handleUtils.get("getTemplateSection"),
            isTextSection: handleUtils.get("isTextSection"),
            isImageSection: handleUtils.get("isImageSection"),

            allTemplates: [],
            currentSection: scenario.section,
            currentCategory: "All",
            tmpBulkSelected: [],
            libraryPaths: scenario.roots.slice(),
            rootPath: scenario.roots[0],
            DOM: { "search-box": { value: "" } },

            getLibraryIndex: function () { return persisted.index; },
            getLastLibraryIndexLoadReason: getLastLibraryIndexLoadReason,
            // The REAL versioned-key parser: Wave 2's changedRootsFromKeys
            // recovers each root through it, exactly as the panel has it with
            // persistence.js loaded alongside templates.js. Without it the key
            // format cannot be decided and no root is ever named as changed.
            parseCombinedValidityKey: parseCombinedValidityKey,
            deriveCombinedValidityKeyAsync: function (paths, fsImpl, storedKey) {
                // templates.js hands its stored key through as the third
                // argument, and an absent stored key still opts in with "", so
                // the harness and the shipped stale/fresh decision compare keys
                // in the same versioned format.
                return deriveCombinedValidityKeyAsync(
                    paths, disk.fs, typeof storedKey === "string" ? storedKey : ""
                );
            },
            getCombinedDiskValidityKey: function () { return "sync-key-must-not-be-used"; },
            saveLibraryIndex: function () { spies.saveLibraryIndex++; },

            csInterface: csInterface,
            encodeBridge: hex,
            decodeBridge: unhex,

            // Scheduling and ownership seams: the only handles startup can make.
            requestIdleCallback: scheduler.requestIdleCallback,
            cancelIdleCallback: scheduler.cancelIdleCallback,
            setTimeout: scheduler.setTimeout,
            clearTimeout: scheduler.clearTimeout,
            AppLifecycle: owner.facade,

            updateCount: function () { spies.updateCount++; },
            updateCustomSelect: function () { },
            Settings: { get: function () { return []; }, set: function () { } },
            TextAnim: { attachHoverPreviews: function () { } },
            showToast: function () { throw new Error("warm paint must never toast"); },
            nfs: function () { return { existsSync: function () { return false; } }; },
        },
    });

    return {
        entries: entries,
        disk: disk,
        document: document,
        scheduler: scheduler,
        owner: owner,
        scans: scans,
        spies: spies,
        consoleErrors: consoleErrors,
        context: sandbox.context,
        setIndex: function (index) { persisted.index = index; },
        cardCount: function () {
            const grid = document.getElementById(sandbox.context.resolveSectionGridId());
            return grid.querySelectorAll(".card").length;
        },
    };
}

/** Persists the index against the pre-mutation disk, then applies the mutations. */
async function seedHandleWorld(world, scenario) {
    // Both keys are built in the Wave 2 versioned format ("" opts in for the
    // seed, the stored key itself for the post-mutation key), so the stored key
    // the index carries is comparable to the one startup derives.
    const storedKey = await deriveCombinedValidityKeyAsync(scenario.roots, world.disk.fs, "");
    const source = new LibraryIndex({ validityKey: storedKey });
    for (let i = 0; i < world.entries.length; i++) source.insertAtHead(world.entries[i]);
    const parsed = LibraryIndex.tryParse(source.serialize());
    world.setIndex(parsed.index);
    world.storedKey = storedKey;
    world.parsedOk = parsed.ok;

    scenario.mutations.forEach(function (rootIndex, order) {
        const root = scenario.roots[rootIndex % scenario.roots.length];
        world.disk.addFile(root, "changed-" + order + ".aep", 4096 + order, 5000 + order);
    });
    world.currentKey = await deriveCombinedValidityKeyAsync(
        scenario.roots, world.disk.fs, storedKey
    );
    return world;
}

/** Lets the async validity key and any reconcile chunks settle. */
async function settle() {
    await new Promise(function (resolve) { setImmediate(resolve); });
    await new Promise(function (resolve) { global.setTimeout(resolve, 0); });
}

/**
 * One close/reopen cycle: register the pre-startup owners, run warm paint, step
 * the deferred queue one unit at a time (sampling live startup handles between
 * units), then dispose the context the way `beforeunload` does.
 */
async function runHandleCycle(scenario, cycle) {
    const world = createHandleWorld(scenario, cycle);
    await seedHandleWorld(world, scenario);

    const owner = world.owner;
    const lifecycle = owner.lifecycle;
    const baselineDisposals = {};
    scenario.baselineOwners.forEach(function (kind, index) {
        const id = kind + ":" + index;
        baselineDisposals[id] = 0;
        owner.registerBaseline(kind, id, function () { baselineDisposals[id]++; });
    });

    lifecycle.transition("BOOTSTRAPPING");
    lifecycle.markWorkStart("startup", "default-library");
    lifecycle.transition("SHELL_VISIBLE");

    const preStartupCounts = lifecycle.snapshotCounts();
    const preStartupLive = totalLiveCounts(preStartupCounts);

    const warmPaint = world.context.startupWarmPaint(world.context.getLibraryIndex());
    owner.sample();

    // One unit per step, with a settle in between, so the live-handle count is
    // sampled at every point the queue can be observed from the outside.
    const liveSamples = [owner.liveStartupHandles()];
    let units = 0;
    for (let step = 0; step < 64; step++) {
        if (world.scheduler.pending() > 0) {
            world.scheduler.step(1);
            units++;
            liveSamples.push(owner.liveStartupHandles());
        }
        await settle();
        if (world.scheduler.pending() === 0 && step > 4) break;
    }
    await settle();
    await settle();

    const afterDrain = {
        counts: lifecycle.snapshotCounts(),
        live: totalLiveCounts(lifecycle.snapshotCounts()),
        startupLive: owner.liveStartupHandles(),
        cards: world.cardCount(),
    };

    // beforeunload.
    const disposed = lifecycle.dispose("beforeunload");
    const residual = totalLiveCounts(lifecycle.snapshotCounts());
    const repeatRejected = lifecycle.dispose("beforeunload-repeat") === false;

    // A late idle request after teardown must not leave a live handle behind:
    // the disposed registry releases the handle at registration time.
    const createdBeforeLate = world.scheduler.created.length;
    world.context.scheduleStartupIdle(function () { });
    const lateHandles = world.scheduler.created.length - createdBeforeLate;
    const lateLive = owner.liveStartupHandles();

    const registeredHandles = owner.startupRegistrations.map(function (entry) {
        return entry.handle;
    });
    const createdHandles = world.scheduler.created.map(function (entry) {
        return entry.handle;
    });

    return {
        idleMode: cycle.idleMode,
        launchState: cycle.launchState,
        warmPainted: warmPaint.painted,
        warmPaintReason: warmPaint.reason,
        records: warmPaint.records,
        cards: afterDrain.cards,
        units: units,
        stale: world.currentKey !== world.storedKey,
        scans: world.scans.length,

        preStartupCounts: preStartupCounts,
        preStartupLive: preStartupLive,
        afterDrainCounts: afterDrain.counts,
        afterDrainLive: afterDrain.live,
        startupLiveAfterDrain: afterDrain.startupLive,

        createdHandles: createdHandles,
        registeredHandles: registeredHandles,
        unregisteredHandles: createdHandles.filter(function (handle) {
            return registeredHandles.indexOf(handle) === -1;
        }),
        maxLiveStartupHandles: owner.maxLive(),
        liveSamples: liveSamples,
        cancelCounts: createdHandles.map(function (handle) {
            return world.scheduler.cancels[handle];
        }),
        startupDisposals: owner.startupRegistrations.map(function (entry) {
            return entry.disposals;
        }),
        baselineDisposals: Object.keys(baselineDisposals).map(function (id) {
            return baselineDisposals[id];
        }),
        registrationKinds: owner.startupRegistrations.map(function (entry) {
            return entry.kind;
        }),

        disposed: disposed,
        residual: residual,
        repeatRejected: repeatRejected,
        lateHandles: lateHandles,
        lateLive: lateLive,
        consoleErrors: world.consoleErrors.slice(),
        registrations: owner.startupRegistrations,
    };
}

function totalLiveCounts(snapshot) {
    return Object.keys(snapshot).reduce(function (sum, key) {
        return sum + (typeof snapshot[key] === "number" ? snapshot[key] : 0);
    }, 0);
}

const handleScenarioArb = fc.record({
    section: fc.constantFrom.apply(fc, HANDLE_SECTION_VALUES),
    roots: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 1, maxLength: 2 }),
    // Small libraries finish inside First_Batch (one deferred unit); large ones
    // schedule several append units, so the "at most one live handle" bound has
    // real subjects on both sides.
    records: fc.oneof(
        { weight: 2, arbitrary: fc.integer({ min: 1, max: 20 }) },
        { weight: 1, arbitrary: fc.integer({ min: 61, max: 140 }) }
    ),
    mutations: fc.uniqueArray(fc.integer({ min: 0, max: 1 }), { maxLength: 2 }),
    baselineOwners: fc.shuffledSubarray(BASELINE_KINDS, { minLength: 1, maxLength: 5 }),
    cycles: fc.array(fc.record({
        launchState: fc.constantFrom("cold", "warm", "same-session-reopen", "post-restart-reopen"),
        idleMode: fc.constantFrom("idle", "timeout"),
    }), { minLength: 2, maxLength: 4 }),
});

/** The per-cycle checks Property 8 makes; shared with the 10-cycle example. */
function assertHandleCycle(cycle, scenario) {
    // Non-vacuity: warm paint really served this cycle, so handles really were
    // created by the deferred queue rather than by nothing at all.
    expect(cycle.warmPainted).toBe(true);
    expect(cycle.warmPaintReason).toBe("index-parsed");
    expect(cycle.records).toBe(scenario.records);
    expect(cycle.units).toBeGreaterThanOrEqual(1);
    expect(cycle.createdHandles.length).toBeGreaterThanOrEqual(1);

    // Req 5.6: every handle the runtime handed out was registered with
    // AppLifecycle, and every registration is a timer handle.
    expect(cycle.unregisteredHandles).toEqual([]);
    expect(cycle.registeredHandles).toEqual(cycle.createdHandles);
    expect(cycle.registrationKinds.every(function (kind) { return kind === "timer"; })).toBe(true);

    // Req 2.11 / 5.6: at most one startup-owned handle is ever live, because
    // each unit disposes its own token before doing any work.
    expect(cycle.maxLiveStartupHandles).toBeLessThanOrEqual(1);
    cycle.liveSamples.forEach(function (live) {
        expect(live).toBeLessThanOrEqual(1);
    });

    // Req 6.8: once the queue drains, the live owner count is back to its
    // pre-startup value — per kind, not merely in total.
    expect(cycle.startupLiveAfterDrain).toBe(0);
    expect(cycle.afterDrainCounts).toEqual(cycle.preStartupCounts);
    expect(cycle.afterDrainLive).toBe(cycle.preStartupLive);
    expect(cycle.cards).toBe(scenario.records);

    // Req 6.8 / 7.6: dispose releases everything, each disposer runs exactly
    // once, and the released handles are the raw runtime handles.
    expect(cycle.disposed).toBe(true);
    expect(cycle.residual).toBe(0);
    expect(cycle.repeatRejected).toBe(true);
    expect(cycle.startupDisposals.every(function (count) { return count === 1; })).toBe(true);
    expect(cycle.baselineDisposals).toEqual(scenario.baselineOwners.map(function () { return 1; }));
    expect(cycle.cancelCounts.every(function (count) { return count === 1; })).toBe(true);

    // Req 2.11: a handle requested after teardown is released immediately, so no
    // timer can outlive the context that owns it.
    expect(cycle.lateHandles).toBe(1);
    expect(cycle.lateLive).toBe(0);
    expect(cycle.consoleErrors).toEqual([]);
}

describe("panel-reopen-startup startup handles", function () {
    test("ten close/reopen cycles hold owner counts constant and leave nothing live", async function () {
        const scenario = {
            section: HANDLE_SECTIONS.COMP,
            roots: ["C:/lib/alpha", "D:/shared/beta"],
            records: 134,
            mutations: [0],
            baselineOwners: ["listener", "observer", "watcher", "timer", "subscription"],
        };
        const cycles = [];
        for (let index = 0; index < 10; index++) {
            cycles.push(await runHandleCycle(scenario, {
                launchState: index === 0 ? "cold" : "same-session-reopen",
                idleMode: index % 2 === 0 ? "idle" : "timeout",
            }));
        }
        cycles.forEach(function (cycle) { assertHandleCycle(cycle, scenario); });
        expect(new Set(cycles.map(function (cycle) {
            return cycle.createdHandles.length;
        })).size).toBe(1);
        expect(new Set(cycles.map(function (cycle) {
            return JSON.stringify(cycle.afterDrainCounts);
        })).size).toBe(1);
        expect(cycles.every(function (cycle) { return cycle.residual === 0; })).toBe(true);

        // Every earlier context stays torn down: no prior-session handle is ever
        // resurrected by a later cycle (Requirement 7.6).
        cycles.forEach(function (cycle) {
            cycle.registrations.forEach(function (entry) {
                expect(entry.live).toBe(false);
                expect(entry.disposals).toBe(1);
            });
        });
    }, 60000);

    // Feature: panel-reopen-startup, Property 8: Every startup-owned handle is registered and released
    // **Validates: Requirements 2.11, 5.6, 6.8, 7.6**
    test("every startup-owned handle is registered and released", async function () {
        await fc.assert(fc.asyncProperty(handleScenarioArb, async function (scenario) {
            const observed = [];
            for (let index = 0; index < scenario.cycles.length; index++) {
                const cycle = await runHandleCycle(scenario, scenario.cycles[index]);
                assertHandleCycle(cycle, scenario);
                observed.push(cycle);

                // Requirement 7.6: every handle from an earlier cycle is still
                // dead, released exactly once, when a later cycle runs.
                observed.forEach(function (earlier) {
                    earlier.registrations.forEach(function (entry) {
                        expect(entry.live).toBe(false);
                        expect(entry.disposals).toBe(1);
                    });
                });
            }

            // Requirement 6.8: the counts are held constant across cycles — the
            // number of handles created, the deferred units that created them,
            // the per-kind live snapshot once the queue drained, and the zero
            // residual after dispose.
            const invariants = observed.map(function (cycle) {
                return JSON.stringify({
                    created: cycle.createdHandles.length,
                    units: cycle.units,
                    preStartup: cycle.preStartupCounts,
                    afterDrain: cycle.afterDrainCounts,
                    residual: cycle.residual,
                    cards: cycle.cards,
                });
            });
            expect(new Set(invariants).size).toBe(1);

            // Non-vacuity for the background half: when a root really changed on
            // disk the reconcile path ran, and it created no extra owner.
            observed.forEach(function (cycle) {
                if (cycle.stale) expect(cycle.scans).toBeGreaterThanOrEqual(1);
                else expect(cycle.scans).toBe(0);
            });

            return true;
        }), { numRuns: 15, seed: 60801, verbose: 2 });
    }, 900000);
});

/**
 * Property 8: every idle/timer handle startup creates is registered with the
 * real AppLifecycle, at most one of them is live at a time, the live owner count
 * returns to its pre-startup snapshot once the deferred queue drains, and
 * dispose releases everything exactly once — held constant across repeated
 * close/reopen cycles.
 *
 * **Validates: Requirements 2.11, 5.6, 6.8, 7.6**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Property 9 harness: degraded persisted inputs against real shipped code
// ─────────────────────────────────────────────────────────────────────────────
//
// Property 9 asks what happens when the persisted index cannot be used. Nothing
// about that decision is restated here: the REASON is produced by the shipped
// `loadLibraryIndex()` of js/core/persistence.js, evaluated in a vm realm whose
// only fake is `localStorage`, and read back through the shipped
// `getLastLibraryIndexLoadReason()`. The warm-paint decision is the real
// `startupWarmPaint` of js/templates/templates.js, the miss is recorded on a real
// startup trace built by `PerfEvents.createStartupTrace` (js/core/observability.js),
// and the fallback is the real cold `loadTemplates`.
//
// Everything the property measures is observed at the seams the panel really
// has: grid DOM writes are counted by intercepting `innerHTML` /
// `insertAdjacentHTML` on the six grid elements themselves, bridge calls are
// counted inside `csInterface.evalScript`, toasts inside `showToast`, and errors
// inside `console.error`.

const DEGRADED_PERSISTENCE_SOURCE = fs.readFileSync(
    path.join(ROOT, "js/core/persistence.js"),
    "utf8"
);
const { MiniElement: DegradedMiniElement } = require("../helpers/miniDom.js");
const DEGRADED_INNER_HTML = Object.getOwnPropertyDescriptor(
    DegradedMiniElement.prototype,
    "innerHTML"
);
const DegradedPerfEvents = require("../../js/core/observability.js");
const degradedGetTemplateSection = handleUtils.get("getTemplateSection");

// Non-JSON and wrong-shaped inputs. Each one makes `LibraryIndex.tryParse`
// report ok === false, which is what `loadLibraryIndex` turns into "corrupt".
const DEGRADED_CORRUPT_STRINGS = [
    "not json at all",
    '{"version":1,"validityKey":"k","entries":[{"folderPath":"a"',
    '{"version":1,"validityKey":"k","entries":"not-an-array"}',
    '{"version":1,"validityKey":"k","entries":{"0":{"folderPath":"a"}}}',
    "[]",
    "null",
    "42",
    '"a string, not an object"',
];

const DEGRADED_EXPECTED_REASON = {
    "absent": "absent",
    "corrupt": "corrupt",
    "index-empty": "index-empty",
    "no-index-object": "no-index-object",
    "no-library-paths": "no-library-paths",
    // Wave 2 forward-compatibility fence (Requirement 9.9): a payload written by
    // a newer CompSaver is a degraded input of its own class — its entries are
    // never consumed and the stored string is left in place.
    "version-ahead": "version-ahead",
};

function degradedEntries(spec) {
    const entries = [];
    for (let rootIndex = 0; rootIndex < spec.roots.length; rootIndex++) {
        const root = spec.roots[rootIndex];
        for (let index = 0; index < spec.recordsPerRoot; index++) {
            entries.push({
                id: "d-" + rootIndex + "-" + index,
                name: "Degraded " + rootIndex + "-" + index,
                category: index % 2 === 0 ? "Titles" : "Transitions",
                section: spec.section,
                type: spec.section,
                favorite: false,
                folderPath: root + "/" + spec.section + "/" + index,
                thumbnail: "",
            });
        }
    }
    return entries;
}

/** A healthy serialized index — used by the classes whose defect is elsewhere. */
function degradedHealthyStored(spec) {
    const index = new LibraryIndex({ validityKey: spec.storedKey });
    const entries = degradedEntries(spec);
    for (let i = 0; i < entries.length; i++) {
        index.insertAtHead(JSON.parse(JSON.stringify(entries[i])));
    }
    return index.serialize();
}

/** The persisted string for a degraded class, or null for "no stored string". */
function degradedStoredString(spec) {
    if (spec.kind === "absent") return null;
    if (spec.kind === "corrupt") {
        return DEGRADED_CORRUPT_STRINGS[spec.variant % DEGRADED_CORRUPT_STRINGS.length];
    }
    if (spec.kind === "index-empty") {
        // Two flavours of valid-but-zero-entry: a genuinely empty index, and one
        // whose every entry is unusable so tryParse drops them all (ok === true).
        //
        // The schema version is pinned at this build's version on purpose: the
        // defect under test here is the ENTRY SHAPE, so the payload must clear
        // the Wave 2 forward-compatibility fence (Requirement 9.10) and reach
        // the zero-entry verdict. The fence itself is exercised by the
        // "version-ahead" class below.
        if (spec.variant % 2 === 0) {
            return new LibraryIndex({ validityKey: spec.storedKey }).serialize();
        }
        return JSON.stringify({
            version: LIBRARY_INDEX_VERSION,
            validityKey: spec.storedKey,
            entries: [{ name: "no-folder-path" }, { folderPath: "" }, null, 7],
        });
    }
    if (spec.kind === "version-ahead") {
        // Requirement 9.9: valid JSON, right shape, real usable entries — the
        // ONLY thing wrong with it is that its version is ahead of this build,
        // so the entries must not be consumed.
        const payload = JSON.parse(degradedHealthyStored(spec));
        payload.version = LIBRARY_INDEX_VERSION + 1;
        return JSON.stringify(payload);
    }
    return degradedHealthyStored(spec);
}

/**
 * The real persistence module in its own realm: `loadLibraryIndex` reads the
 * fake `localStorage`, and `getLastLibraryIndexLoadReason` is the shipped
 * reason channel, so the reason under test is never restated by the harness.
 */
function createDegradedPersistenceRealm(stored, withSingleton) {
    const store = {};
    if (typeof stored === "string") store["compSaver_libraryIndex"] = stored;

    const errors = [];
    const context = {
        console: {
            log: function () { },
            warn: function () { },
            error: function (message) { errors.push(String(message)); },
        },
        module: { exports: {} },
        exports: {},
        localStorage: {
            getItem: function (key) {
                return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
            },
            setItem: function (key, value) { store[key] = String(value); },
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(DEGRADED_PERSISTENCE_SOURCE, context, { filename: "persistence.js" });

    if (withSingleton !== false) {
        const singleton = new context.LibraryIndex();
        context.getLibraryIndex = function () { return singleton; };
    }

    const li = context.loadLibraryIndex();
    const committed = Object.prototype.hasOwnProperty.call(store, "compSaver_libraryIndex")
        ? store["compSaver_libraryIndex"]
        : null;
    return {
        index: li,
        reason: context.getLastLibraryIndexLoadReason(),
        errors: errors,
        // The committed key as it stands once the load has run, so "the stored
        // payload is left in place" is read off the store rather than assumed.
        storedAfterLoad: committed,
        // The entries the load actually consumed, sampled before any startup work
        // can add to them.
        entriesAfterLoad: li ? li._entries.slice() : null,
    };
}

/**
 * One panel context holding the real templates.js, a real startup trace, an
 * instrumented DOM, and counted bridge/toast/console seams.
 */
function createDegradedWorld(spec) {
    const stored = degradedStoredString(spec);
    const realm = createDegradedPersistenceRealm(
        stored,
        spec.kind !== "no-index-object"
    );

    // The scan the cold path will see. This is the input the merged result is
    // compared against, so "unchanged cold behaviour" is decided by data the
    // harness handed the bridge, not by a copy of the merge logic.
    const scanned = {};
    const entries = degradedEntries(spec);
    spec.roots.forEach(function (root) {
        scanned[root] = entries.filter(function (entry) {
            return String(entry.folderPath).indexOf(root + "/") === 0;
        }).map(function (entry) {
            const copy = JSON.parse(JSON.stringify(entry));
            delete copy.sourcePath;
            return copy;
        });
    });

    // Grid DOM writes, counted on the grid elements themselves.
    const gridWrites = [];
    const document = createMiniDocument();
    GRID_IDS.forEach(function (gridId) {
        const grid = document.createElement("div");
        grid.id = gridId;
        grid.className = "card-grid";
        document.body.appendChild(grid);
        Object.defineProperty(grid, "innerHTML", {
            configurable: true,
            get: function () { return DEGRADED_INNER_HTML.get.call(grid); },
            set: function (markup) {
                gridWrites.push({ grid: gridId, kind: "innerHTML" });
                DEGRADED_INNER_HTML.set.call(grid, markup);
            },
        });
        grid.insertAdjacentHTML = function (position, markup) {
            if (position !== "beforeend") throw new Error("harness supports beforeend only");
            gridWrites.push({ grid: gridId, kind: "insertAdjacentHTML" });
            const holder = document.createElement("div");
            holder.innerHTML = markup;
            const moving = holder.children;
            for (let i = 0; i < moving.length; i++) grid.appendChild(moving[i]);
        };
    });

    const scheduler = createTrackedScheduler(spec.variant % 2 === 0 ? "idle" : "timeout");
    const owner = createHandleOwner();
    const bridgeCalls = [];
    const scans = [];
    const toasts = [];
    const consoleErrors = [];
    const spies = { updateCount: 0, saveLibraryIndex: 0, syncValidityKey: 0 };
    const trace = DegradedPerfEvents.createStartupTrace();

    const csInterface = {
        evalScript: function (script, callback) {
            bridgeCalls.push(String(script));
            const parsed = parseScanScript(script);
            if (!parsed) {
                if (typeof callback === "function") callback("");
                return;
            }
            scans.push({ root: parsed.root, section: parsed.section });
            const records = recordsInScanFolder(scanned[parsed.root] || [], parsed.section);
            if (typeof callback === "function") {
                callback(hex(JSON.stringify(records)));
            }
        },
    };

    const consoleObject = {
        log: function () { },
        warn: function () { },
        error: function (message) { consoleErrors.push(String(message)); },
    };
    const windowObject = { Date: Date, console: consoleObject };

    const usePaths = spec.kind !== "no-library-paths";
    const sandbox = loadHelpers({
        file: path.join("js", "templates", "templates.js"),
        lenient: false,
        injected: {
            window: windowObject,
            console: consoleObject,
            document: document,

            SECTIONS: HANDLE_SECTIONS,
            IMAGE_SECTIONS: HANDLE_IMAGE_SECTIONS,
            escapeAttr: handleUtils.get("escapeAttr"),
            escapeHTML: handleUtils.get("escapeHTML"),
            getTemplateSection: degradedGetTemplateSection,
            isTextSection: handleUtils.get("isTextSection"),
            isImageSection: handleUtils.get("isImageSection"),

            allTemplates: [],
            currentSection: spec.section,
            currentCategory: "All",
            tmpBulkSelected: [],
            libraryPaths: usePaths ? spec.roots.slice() : [],
            rootPath: usePaths ? spec.roots[0] : null,
            DOM: { "search-box": { value: "" } },

            getLibraryIndex: function () { return realm.index; },
            // The shipped reason channel, from the realm that produced it.
            getLastLibraryIndexLoadReason: function () { return realm.reason; },
            deriveCombinedValidityKeyAsync: function () {
                return { then: function () { return this; } };
            },
            getCombinedDiskValidityKey: function () {
                spies.syncValidityKey++;
                return "cold-disk-key";
            },
            saveLibraryIndex: function () { spies.saveLibraryIndex++; },

            csInterface: csInterface,
            encodeBridge: hex,
            decodeBridge: unhex,

            requestIdleCallback: scheduler.requestIdleCallback,
            cancelIdleCallback: scheduler.cancelIdleCallback,
            setTimeout: scheduler.setTimeout,
            clearTimeout: scheduler.clearTimeout,
            AppLifecycle: owner.facade,
            PerfEvents: {
                span: DegradedPerfEvents.span,
                startupTrace: function () { return trace; },
            },

            updateCount: function () { spies.updateCount++; },
            updateCustomSelect: function () { },
            Settings: { get: function () { return []; }, set: function () { } },
            TextAnim: { attachHoverPreviews: function () { } },
            showToast: function (message, severity) {
                toasts.push({ message: String(message), severity: String(severity) });
            },
            nfs: function () { return { existsSync: function () { return false; } }; },
        },
    });

    return {
        stored: stored,
        storedAfterLoad: realm.storedAfterLoad,
        entriesAfterLoad: realm.entriesAfterLoad,
        loadReason: realm.reason,
        index: realm.index,
        realmErrors: realm.errors,
        scanned: scanned,
        document: document,
        gridWrites: gridWrites,
        scheduler: scheduler,
        owner: owner,
        bridgeCalls: bridgeCalls,
        scans: scans,
        toasts: toasts,
        consoleErrors: consoleErrors,
        spies: spies,
        trace: trace,
        context: sandbox.context,
        cardCount: function () {
            const grid = document.getElementById(sandbox.context.resolveSectionGridId());
            return grid.querySelectorAll(".card").length;
        },
    };
}

/** Warm paint, then the cold fallback, each observed in isolation. */
function runDegradedStartup(spec) {
    const world = createDegradedWorld(spec);

    const warm = world.context.startupWarmPaint(world.index);
    const afterWarm = {
        gridWrites: world.gridWrites.slice(),
        bridgeCalls: world.bridgeCalls.slice(),
        toasts: world.toasts.slice(),
        consoleErrors: world.consoleErrors.slice(),
        handles: world.scheduler.created.length,
        syncValidityKey: world.spies.syncValidityKey,
        cards: world.cardCount(),
        allTemplates: world.context.allTemplates.slice(),
        cache: JSON.parse(JSON.stringify(world.trace.report().cache)),
        preWarmPaintScans: world.trace.report().bridgeScans.beforeWarmPaint,
        firstVisibleTemplateMs: world.trace.report().firstVisibleTemplateMs,
    };

    // The shipped cold path, on the very same context warm paint declined.
    world.context.loadTemplates();

    const merged = world.context.allTemplates.slice();
    const expectedMerge = [];
    spec.roots.forEach(function (root) {
        (world.scanned[root] || []).forEach(function (record) {
            const tagged = JSON.parse(JSON.stringify(record));
            tagged.sourcePath = root;
            tagged.section = degradedGetTemplateSection(tagged);
            expectedMerge.push(tagged);
        });
    });

    const sourcePathsByRoot = {};
    spec.roots.forEach(function (root) {
        sourcePathsByRoot[root] = merged.filter(function (record) {
            return record.sourcePath === root;
        }).map(function (record) { return record.name; });
    });

    return {
        kind: spec.kind,
        stored: world.stored,
        storedAfterLoad: world.storedAfterLoad,
        entriesAfterLoad: world.entriesAfterLoad,
        loadReason: world.loadReason,
        warmPainted: warm.painted,
        warmReason: warm.reason,
        warmCards: warm.cards,
        warmRecords: warm.records,
        afterWarm: afterWarm,

        coldScans: world.scans.slice(),
        // The shipped section list, read off the module so the expected call
        // count tracks the product instead of being pinned to a literal.
        scanSections: world.context.STARTUP_SCAN_SECTIONS.slice(),
        coldToasts: world.toasts.slice(),
        coldConsoleErrors: world.consoleErrors.slice(),
        realmErrors: world.realmErrors.slice(),
        merged: merged,
        expectedMerge: expectedMerge,
        sourcePathsByRoot: sourcePathsByRoot,
        expectedNamesByRoot: (function () {
            const out = {};
            spec.roots.forEach(function (root) {
                out[root] = (world.scanned[root] || []).map(function (r) { return r.name; });
            });
            return out;
        })(),
        coldCards: world.cardCount(),
        indexEntries: world.index ? world.index._entries.slice() : null,
        indexValidityKey: world.index ? world.index.validityKey : null,
        saves: world.spies.saveLibraryIndex,
    };
}

const degradedSpecArb = fc.record({
    kind: fc.constantFrom(
        "absent", "corrupt", "index-empty", "no-index-object", "no-library-paths",
        "version-ahead"
    ),
    variant: fc.integer({ min: 0, max: 7 }),
    storedKey: fc.integer({ min: 0, max: 999 }).map(function (n) { return "stored-key-" + n; }),
    section: fc.constantFrom.apply(fc, HANDLE_SECTION_VALUES),
    roots: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 1, maxLength: 2 }),
    recordsPerRoot: fc.integer({ min: 1, max: 6 }),
});

/** The roots the chunked scan visited, in first-visit order, deduplicated. */
function degradedScannedRoots(scans) {
    const seen = {};
    const roots = [];
    scans.forEach(function (call) {
        if (seen["r:" + call.root]) return;
        seen["r:" + call.root] = true;
        roots.push(call.root);
    });
    return roots;
}

/** The section folders the chunked scan asked one root for, in issue order. */
function degradedScannedSections(scans, root) {
    return scans
        .filter(function (call) { return call.root === root; })
        .map(function (call) { return call.section; });
}

/** The per-class checks Property 9 makes; shared with the example below. */
function assertDegradedStartup(observed, spec) {
    // ── Warm paint declined, for the exact shipped reason ────────────────────
    // Req 1.7 / 1.8: no warm paint for an absent, corrupt, wrong-shaped, or
    // zero-entry index, nor for an empty path set.
    expect(observed.warmPainted).toBe(false);
    expect(observed.warmReason).toBe(DEGRADED_EXPECTED_REASON[spec.kind]);
    expect(observed.warmCards).toBe(0);
    expect(observed.warmRecords).toBe(0);

    // The reason came from the shipped persistence channel, not from the test.
    if (spec.kind === "no-library-paths") {
        // The defect is the path set, so the index itself loaded cleanly: the
        // path guard is reached first (Req 1.8).
        expect(observed.loadReason).toBe("index-parsed");
        expect(observed.indexEntries.length).toBeGreaterThan(0);
    } else {
        expect(observed.loadReason).toBe(DEGRADED_EXPECTED_REASON[spec.kind]);
    }

    // Req 9.8 / 9.9: loading is non-destructive. Whatever string was persisted —
    // including a payload from a newer build, whose entries are deliberately not
    // consumed — is still on the committed key once the load has run.
    expect(observed.storedAfterLoad).toBe(observed.stored);

    // Req 9.9: the forward-compatibility fence consumed no entries, even though
    // the payload itself parses cleanly and holds usable records.
    if (spec.kind === "version-ahead") {
        expect(observed.entriesAfterLoad).toEqual([]);
        expect(JSON.parse(observed.stored).entries.length).toBeGreaterThan(0);
    }

    // ── The warm-paint attempt touched nothing ───────────────────────────────
    // Req 1.7 / 1.8 / 6.7 / 7.5: no DOM write, no bridge call, no toast, no
    // console error, no scheduled handle, and no synchronous validity key.
    expect(observed.afterWarm.gridWrites).toEqual([]);
    expect(observed.afterWarm.cards).toBe(0);
    expect(observed.afterWarm.bridgeCalls).toEqual([]);
    expect(observed.afterWarm.toasts).toEqual([]);
    expect(observed.afterWarm.consoleErrors).toEqual([]);
    expect(observed.afterWarm.handles).toBe(0);
    expect(observed.afterWarm.syncValidityKey).toBe(0);
    expect(observed.afterWarm.allTemplates).toEqual([]);

    // Req 4.6: the miss is recorded with its specific reason, and no bridge scan
    // preceded it.
    expect(observed.afterWarm.cache).toEqual({
        decision: "miss",
        reason: DEGRADED_EXPECTED_REASON[spec.kind],
    });
    expect(observed.afterWarm.preWarmPaintScans).toBe(0);
    expect(observed.afterWarm.firstVisibleTemplateMs).toBe(null);

    // ── The cold fallback is unchanged ───────────────────────────────────────
    expect(observed.coldConsoleErrors).toEqual([]);
    expect(observed.realmErrors).toEqual([]);

    if (spec.kind === "no-library-paths") {
        // Req 1.8: existing behaviour, unchanged — the frozen toast and no scan.
        expect(observed.coldScans).toEqual([]);
        expect(observed.coldToasts).toEqual([
            { message: "Library not connected", severity: "error" },
        ]);
        expect(observed.merged).toEqual([]);
        expect(observed.coldCards).toBe(0);
        expect(observed.saves).toBe(0);
        return;
    }

    // Req 1.7 / 7.5: recovery through the cold path — no toast, and cards on
    // screen. The cold scan is section-chunked, so each root costs one bridge
    // call per section folder rather than one call for the whole root: the active
    // section first (so the visible grid fills in that section's time alone),
    // then the remaining sections in the shipped fixed order. The section list is
    // read off the module, so this expectation tracks the product.
    expect(observed.coldToasts).toEqual([]);
    expect(observed.scanSections.length).toBeGreaterThan(0);
    expect(observed.coldScans.length)
        .toBe(spec.roots.length * observed.scanSections.length);
    expect(degradedScannedRoots(observed.coldScans)).toEqual(spec.roots);

    const activeFolder = SCAN_FOLDER_FOR_SECTION[spec.section];
    const expectedSectionOrder = [activeFolder].concat(
        observed.scanSections.filter(function (folder) { return folder !== activeFolder; })
    );
    spec.roots.forEach(function (root) {
        expect(degradedScannedSections(observed.coldScans, root)).toEqual(expectedSectionOrder);
    });

    expect(observed.coldCards).toBe(observed.expectedMerge.length);
    expect(observed.coldCards).toBeGreaterThan(0);

    // Req 1.9: sourcePath tagging per root and the multi-root merge match the
    // scanned input exactly, in scan-completion order.
    expect(observed.merged).toEqual(observed.expectedMerge);
    expect(observed.sourcePathsByRoot).toEqual(observed.expectedNamesByRoot);
    expect(observed.merged.every(function (record) {
        return spec.roots.indexOf(record.sourcePath) !== -1;
    })).toBe(true);

    // The cold path repopulates the cache for the next boot exactly as before.
    if (spec.kind === "no-index-object") {
        expect(observed.indexEntries).toBe(null);
        expect(observed.saves).toBe(0);
    } else {
        expect(observed.indexEntries).toEqual(observed.expectedMerge);
        expect(observed.indexValidityKey).toBe("cold-disk-key");
        expect(observed.saves).toBe(1);
    }
}

describe("panel-reopen-startup degraded inputs", function () {
    test("a corrupt index paints nothing and recovers through the cold path", function () {
        const spec = {
            kind: "corrupt", variant: 1, storedKey: "stored-key-7",
            section: HANDLE_SECTIONS.COMP, roots: ["C:/lib/alpha", "D:/shared/beta"],
            recordsPerRoot: 4,
        };
        const observed = runDegradedStartup(spec);
        assertDegradedStartup(observed, spec);
        expect(observed.merged.length).toBe(8);
    });

    test("an index from a newer build is fenced off, not consumed", function () {
        const spec = {
            kind: "version-ahead", variant: 2, storedKey: "stored-key-11",
            section: HANDLE_SECTIONS.COMP, roots: ["C:/lib/alpha", "D:/shared/beta"],
            recordsPerRoot: 3,
        };
        const observed = runDegradedStartup(spec);
        assertDegradedStartup(observed, spec);
        // Requirement 9.9, spelled out: six usable records were on disk, none of
        // them were consumed, and the payload is still there for the newer build.
        expect(JSON.parse(observed.stored).entries.length).toBe(6);
        expect(observed.entriesAfterLoad).toEqual([]);
        expect(observed.storedAfterLoad).toBe(observed.stored);
        expect(observed.merged.length).toBe(6);
    });

    test("an empty path set leaves cold behaviour untouched", function () {
        const spec = {
            kind: "no-library-paths", variant: 0, storedKey: "stored-key-1",
            section: HANDLE_SECTIONS.COMP, roots: ["C:/lib/alpha"], recordsPerRoot: 3,
        };
        assertDegradedStartup(runDegradedStartup(spec), spec);
    });

    // Feature: panel-reopen-startup, Property 9: Degraded inputs skip warm paint and fall back cleanly
    // **Validates: Requirements 1.7, 1.8, 6.7, 7.5**
    test("degraded inputs skip warm paint and fall back cleanly", function () {
        fc.assert(fc.property(degradedSpecArb, function (spec) {
            assertDegradedStartup(runDegradedStartup(spec), spec);
            return true;
        }), { numRuns: 15, seed: 60901, verbose: 2 });
    }, 600000);
});

/**
 * Property 9: for every absent, non-JSON, wrong-shaped, or zero-entry persisted
 * index, and for an empty path set, warm paint performs no DOM write and no
 * bridge call, records a cache miss carrying the exact shipped reason, raises no
 * console error and no toast — and the cold loadTemplates fallback still tags
 * sourcePath per root and merges every root exactly as the scanned input.
 *
 * **Validates: Requirements 1.7, 1.8, 6.7, 7.5**
 */
