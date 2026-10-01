// ============================================================
// tests/comp-pipeline-bug-exploration.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 1)
//
// Property 1 (Bug Condition) — "Comp/Template Pipeline Operations Behave As
// Specified And Are Reported As They Happened".
//
// EVERY case in this file is EXPECTED TO FAIL on the unfixed code. A failure is
// the SUCCESS case: it produces one concrete counterexample per bug condition and
// confirms the root cause hypothesised in the design's "Hypothesized Root Cause"
// section. A case that PASSES here has REFUTED its hypothesis and the analysis for
// that condition must be redone.
//
// Nothing in this file may fix production code. It only observes and asserts.
//
// Harnesses
// ---------
// Harness A — function slicing into a `vm`: `sliceFn(src, name)` is the brace-walk
//   pattern from tests/save-window-invariants.test.js:27-38 (the same shape
//   tests/import-timings.test.js uses for importBatch). The REAL
//   saveActiveComp / coreSaveLayerType / getStrictSaveType / resolveCompForSave /
//   itemExists / toolkitOrganizeTemplateImport / importCompDirect /
//   placeLayerAtPlayhead / importBatch are executed, never re-implemented.
// Harness B — whole-file sandbox: tests/helpers/loadHelpers.js loads jsx/core.jsx
//   and jsx/helpers.jsx for the pure functions (getSafeName, escapeJSON /
//   jsonStringify, decodeBridge, renderFrameToPng, resolveTemplateFiles).
//
// Fakes (all four required kinds, layered on tests/helpers/aeFakes.js conventions)
//   (a) createInvalidatingItem — every property read THROWS once app.open() ran.
//       This is how After Effects reference invalidation is simulated.
//   (b) a configurable-throwing app.open (openThrows).
//   (c) counters for beginSuppressDialogs/endSuppressDialogs and
//       beginUndoGroup/endUndoGroup (attempts counted separately from successes).
//   (d) recorders for addFolder / remove / parentFolder mutations.
//
// Scope: each case is pinned to the concrete failing input named in the design
// ("Exploratory Bug Condition Checking"); these defects are deterministic, so
// broad generation belongs to the property suites in task 15.
//
// Note: conditions 1.26 and 1.27 are static / cross-implementation defects with no
// runtime counterexample to slice. They are proven by task 15's
// sanitizer-cross-implementation and panel-script-manifest suites instead.
//
// **Validates: Requirements 2.1-2.25**
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadHelpers } = require("./helpers/loadHelpers");
const aeFakes = require("./helpers/aeFakes");
const panelBridge = require("../js/core/bridge.js");
const { importTemplates } = require("../js/core/importEngine.js");

const ROOT = path.resolve(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SAVE_SRC = readSrc("jsx/templates_save.jsx");
const CORE_SRC = readSrc("jsx/core.jsx");
const IMPORT_SRC = readSrc("jsx/import.jsx");
const TEMPLATES_JS = readSrc("js/templates/templates.js");

// ─────────────────────────────────────────────────────────────
// Harness A — brace-walk slicing (save-window-invariants.test.js:27-38)
// ─────────────────────────────────────────────────────────────
function sliceFn(src, name) {
    const start = src.indexOf("function " + name + "(");
    if (start === -1) throw new Error("missing " + name);
    let depth = 0, began = false;
    for (let j = src.indexOf("{", start); j < src.length; j++) {
        if (src[j] === "{") { depth++; began = true; }
        else if (src[j] === "}") { depth--; if (began && depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced " + name);
}

function sliceAll(src, names) {
    return names.map((n) => sliceFn(src, n)).join("\n");
}

/** Brace-walk an object literal (used for the panel's meta.json key set). */
function sliceObjectLiteral(src, marker) {
    const at = src.indexOf(marker);
    if (at === -1) throw new Error("missing marker: " + marker);
    let depth = 0, began = false;
    for (let j = src.indexOf("{", at); j < src.length; j++) {
        if (src[j] === "{") { depth++; began = true; }
        else if (src[j] === "}") { depth--; if (began && depth === 0) return src.slice(at, j + 1); }
    }
    throw new Error("unbalanced literal after " + marker);
}

// The real, pure host utilities every sliced engine depends on. Sliced (not
// stubbed) so the engines run against the encoder/sanitizer/serializer they
// actually ship with.
//
// jsonParse is deliberately NOT sliced: its body contains "{" / "}" inside string
// literals, which a brace walk cannot survive. Every host caller already guards it
// with `typeof jsonParse === "function" ? jsonParse(x) : JSON.parse(x)` for exactly
// this kind of slice harness — the same fallback tests/import-timings.test.js uses.
const CORE_PURE = sliceAll(CORE_SRC, [
    "trimStr", "cleanStr", "getSafeName", "escapeJSON", "jsonStringify",
    "encodeBridge", "decodeBridge", "isHexChar", "safeDecode", "fsEntryName",
    "generateTemplateId", "getDeterministicTemplateId", "normalizeSectionName",
    "ensureDeepFolder",
]);

// ─────────────────────────────────────────────────────────────
// Counterexample ledger — every observation is recorded BEFORE the assertion so
// the run output documents each counterexample even though the expect() throws.
// ─────────────────────────────────────────────────────────────
const LEDGER = [];
function record(caseNo, conditions, observed, expected) {
    LEDGER.push({ caseNo, conditions, observed, expected });
    return observed;
}

afterAll(() => {
    if (!LEDGER.length) return;
    const lines = ["", "=== Bug-condition counterexamples observed on UNFIXED code ==="];
    LEDGER.forEach((e) => {
        lines.push("  [case " + e.caseNo + " | condition " + e.conditions + "]");
        lines.push("      observed: " + e.observed);
        lines.push("      expected: " + e.expected);
    });
    lines.push("=== " + LEDGER.length + " counterexample(s) ===", "");
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
});

// ─────────────────────────────────────────────────────────────
// Duck-typed AE constructors (cross-realm `instanceof` via Symbol.hasInstance,
// the same trick tests/helpers/loadHelpers.js uses for CompItem).
// ─────────────────────────────────────────────────────────────
function duckCtor(kind) {
    const C = function () { };
    Object.defineProperty(C, Symbol.hasInstance, {
        value: function (o) { try { return !!(o && o.__kind === kind); } catch (e) { return false; } },
    });
    return C;
}

function makeCtors() {
    return {
        CompItem: duckCtor("comp"),
        AVLayer: duckCtor("avlayer"),
        FootageItem: duckCtor("footage"),
        FolderItem: duckCtor("folder"),
        SolidSource: duckCtor("solidSource"),
        PlaceholderSource: duckCtor("placeholderSource"),
    };
}

function buildRealm(source, injected) {
    const ctx = Object.assign({ console: console }, makeCtors(), injected || {});
    ctx.global = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "comp-pipeline-slice" });
    return ctx;
}

// ─────────────────────────────────────────────────────────────
// Fake (a) — an item whose EVERY data property read/write throws once
// app.open() has been called. This is reference invalidation.
// ─────────────────────────────────────────────────────────────
function createInvalidatingItem(latch, kind, props) {
    const store = Object.assign({}, props);
    const item = { __kind: kind };
    Object.keys(store).forEach((key) => {
        Object.defineProperty(item, key, {
            enumerable: true,
            configurable: true,
            get: function () {
                if (latch.invalidated) {
                    throw new Error("After Effects error: invalid object reference (read '" + key + "')");
                }
                return store[key];
            },
            set: function (v) {
                if (latch.invalidated) {
                    throw new Error("After Effects error: invalid object reference (write '" + key + "')");
                }
                store[key] = v;
            },
        });
    });
    item.remove = function () {
        if (latch.invalidated) throw new Error("After Effects error: invalid object reference (remove)");
        item.__removed = true;
    };
    item.__store = store;
    return item;
}

function newCounters() {
    return {
        saveCalls: [], openCalls: [], reduceCalls: 0, addCompCalls: 0,
        undoAttempts: 0, undoBegin: 0, undoEnd: 0,
        suppressBegin: 0, suppressEnd: 0,
    };
}

// Fakes (b) + (c): configurable-throwing app.open, and undo / suppression
// counters. `undoAttempts` counts calls, `undoBegin` counts groups that actually
// opened — the distinction is what case 21 needs.
function createSaveApp(counters, latch, opts) {
    opts = opts || {};
    const projectFile = { fsName: "C:/proj/live.aep" };
    const project = {
        file: opts.noProjectFile ? null : projectFile,
        numItems: 0,
        activeItem: null,
        item: function () { return null; },
        save: function (file) {
            const isProtective = file === projectFile;
            counters.saveCalls.push(isProtective ? "PROTECTIVE" : String((file && file.fsName) || file));
            if (isProtective && opts.protectiveSaveThrows) throw new Error("disk full");
            if (!isProtective) {
                if (opts.targetSaveThrows) throw new Error("target save failed");
                // AE re-points app.project.file at the file just written. This is
                // exactly why a failed reopen must not be reported as success.
                project.file = file;
            }
        },
        reduceProject: function () {
            counters.reduceCalls++;
            if (opts.reduceThrows) throw new Error("reduce failed");
        },
        items: {
            addComp: function (name) {
                counters.addCompCalls++;
                return {
                    __kind: "comp", name: name, numLayers: 2,
                    workAreaStart: 0, workAreaDuration: 1,
                    remove: function () { this.__removed = true; },
                };
            },
        },
    };
    return {
        __projectFile: projectFile,
        project: project,
        beginUndoGroup: function () {
            counters.undoAttempts++;
            if (opts.undoBeginThrows) throw new Error("beginUndoGroup failed");
            counters.undoBegin++;
        },
        endUndoGroup: function () { counters.undoEnd++; },
        beginSuppressDialogs: function () { counters.suppressBegin++; },
        endSuppressDialogs: function () { counters.suppressEnd++; },
        open: function (file) {
            counters.openCalls.push(String((file && file.fsName) || file));
            if (opts.invalidateOnOpen) latch.invalidated = true;
            if (opts.openThrows) {
                throw (typeof opts.openThrows === "object"
                    ? opts.openThrows
                    : new Error("app.open failed: the project file is locked"));
            }
        },
    };
}

function createFileCtor(fsSet) {
    return function File(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            get: function () { return fsSet[norm] === true; },
            configurable: true,
        });
    };
}

// Fake (d), filesystem half: records every Folder.create() so "no folder was
// created before the rejection" is directly observable.
function createFolderCtor(fsSet, creates, opts) {
    opts = opts || {};
    return function Folder(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            get: function () { return fsSet[norm] === true; },
            configurable: true,
        });
        this.create = function () {
            creates.push(norm);
            if (opts.createFails) return false;
            fsSet[norm] = true;
            return true;
        };
        this.getFiles = function () { return []; };
    };
}

// ─────────────────────────────────────────────────────────────
// Save-engine realms
// ─────────────────────────────────────────────────────────────
function buildCompSaveRealm(opts) {
    opts = opts || {};
    const counters = newCounters();
    const latch = { invalidated: false };
    const creates = [];
    const fsSet = opts.fsSet || {
        "C:/lib": true,
        "C:/lib/comp": true,
        "C:/lib/comp/Titles": true,
        "C:/lib/comp/Titles/My Title": true,
    };
    const app = createSaveApp(counters, latch, opts);
    const precomp = createInvalidatingItem(latch, "comp", {
        name: "Source Precomp",
        width: 1920, height: 1080, pixelAspect: 1, duration: 10,
        frameRate: 25, workAreaStart: 0, workAreaDuration: 10,
    });
    const ctx = buildRealm([CORE_PURE, sliceFn(SAVE_SRC, "saveActiveComp")].join("\n"), {
        app: app,
        File: createFileCtor(fsSet),
        Folder: createFolderCtor(fsSet, creates, opts),
        resolveCompForSave: function () {
            if (opts.resolveFails) return { ok: false, error: "Select a precomposition first." };
            return { ok: true, comp: precomp };
        },
    });
    return {
        ctx: ctx, app: app, counters: counters, latch: latch, precomp: precomp,
        creates: creates, fsSet: fsSet,
        run: function (name, cat, root) {
            const enc = ctx.encodeBridge;
            const hex = ctx.saveActiveComp(enc(name), enc(cat), enc(root), enc(""));
            return ctx.decodeBridge(hex);
        },
    };
}

function buildLayerSaveRealm(opts) {
    opts = opts || {};
    const counters = newCounters();
    const latch = { invalidated: false };
    const creates = [];
    const fsSet = opts.fsSet || {
        "C:/lib": true,
        "C:/lib/layer": true,
        "C:/lib/layer/Cat": true,
        "C:/lib/layer/Cat/id1": true,
    };
    const app = createSaveApp(counters, latch, opts);
    const layer = {
        __kind: "avlayer",
        matchName: "ADBE Shape Layer",
        name: "Shape Layer 1",
        source: null,
        adjustmentLayer: false, threeDLayer: false, blendingMode: 1, label: 0,
        numProperties: 2,
        property: function (n) {
            return n === "ADBE Effect Parade" ? { numProperties: 1 } : { numProperties: 0 };
        },
    };
    const comp = createInvalidatingItem(latch, "comp", {
        name: "Live Comp",
        width: 1920, height: 1080, pixelAspect: 1, duration: 5, frameRate: 30,
        workAreaStart: 0, workAreaDuration: 5,
        selectedLayers: [layer],
    });
    app.project.activeItem = comp;
    const ctx = buildRealm([CORE_PURE, sliceFn(SAVE_SRC, "coreSaveLayerType")].join("\n"), {
        app: app,
        File: createFileCtor(fsSet),
        Folder: createFolderCtor(fsSet, creates, opts),
        captureLayerState: function () { return { switches: {}, markers: [] }; },
        copySelectedLayersToTempComp: function () { return 2; },
    });
    return {
        ctx: ctx, app: app, counters: counters, latch: latch, comp: comp,
        creates: creates, fsSet: fsSet,
        run: function () {
            return ctx.coreSaveLayerType("Name", "Cat", "C:/lib", "Layer", "", "layer", "id1");
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Selection-resolver realm (getStrictSaveType + resolveCompForSave, one realm so
// both walk the SAME selection state).
// ─────────────────────────────────────────────────────────────
function buildResolverRealm(state) {
    const app = {
        project: {
            activeItem: state.activeComp || null,
            selection: state.selection || [],
        },
    };
    const src = [
        CORE_PURE,
        sliceAll(CORE_SRC, ["buildDetectionResult", "getStrictSaveType", "resolveCompForSave"]),
    ].join("\n");
    const ctx = buildRealm(src, {
        app: app,
        detectEffectsOnSelection: function () { return { mode: "none", effects: [], names: "" }; },
        classifyLayer: function (l) { return (l && l.__classify) || "unknown"; },
        getLayerEffectCount: function () { return 0; },
    });
    return {
        ctx: ctx,
        strict: JSON.parse(ctx.decodeBridge(ctx.getStrictSaveType())),
        resolved: ctx.resolveCompForSave(),
    };
}

function fakeComp(name) {
    return { __kind: "comp", name: name, selectedLayers: [] };
}

// ─────────────────────────────────────────────────────────────
// Project model for the import realms.
// Fake (d): every addFolder / remove / parentFolder mutation is recorded.
// ─────────────────────────────────────────────────────────────
function createProjectModel() {
    const mutations = [];
    const all = [];
    let nextId = 1;
    let nextUid = 1;

    const rootFolder = {
        __kind: "folder", csKind: "folder", id: 0, name: "Root",
        parentFolder: null, __children: [],
    };
    Object.defineProperty(rootFolder, "numItems", {
        get: function () { return rootFolder.__children.length; },
    });
    rootFolder.item = function (i) { return rootFolder.__children[i - 1]; };

    function attach(item, parent) {
        let _parent = parent || rootFolder;
        if (_parent.__children) _parent.__children.push(item);
        Object.defineProperty(item, "parentFolder", {
            enumerable: true,
            configurable: true,
            get: function () { return _parent; },
            set: function (v) {
                mutations.push({ op: "parentFolder", item: item.name, to: v && v.name });
                if (_parent && _parent.__children) {
                    const i = _parent.__children.indexOf(item);
                    if (i >= 0) _parent.__children.splice(i, 1);
                }
                _parent = v;
                if (v && v.__children) v.__children.push(item);
            },
        });
    }

    function makeItem(kind, name, parent) {
        const item = { __kind: kind, csKind: kind, id: nextId++, name: name, __children: [] };
        attach(item, parent);
        item.remove = function () {
            mutations.push({ op: "remove", item: item.name });
            const idx = all.indexOf(item);
            if (idx >= 0) all.splice(idx, 1);
            if (item.parentFolder && item.parentFolder.__children) {
                const j = item.parentFolder.__children.indexOf(item);
                if (j >= 0) item.parentFolder.__children.splice(j, 1);
            }
            item.__removed = true;
        };
        if (kind === "folder") {
            Object.defineProperty(item, "numItems", {
                configurable: true,
                get: function () { return item.__children.length; },
            });
            item.item = function (i) { return item.__children[i - 1]; };
            item.items = { addFolder: function (n) { return addFolder(n, item); } };
        }
        if (kind === "footage") item.mainSource = { __kind: "fileSource" };
        all.push(item);
        return item;
    }

    function addFolder(name, parent) {
        mutations.push({ op: "addFolder", name: name, parent: (parent || rootFolder).name });
        return makeItem("folder", name, parent || rootFolder);
    }

    function makeComp(name, parent) {
        const comp = makeItem("comp", name, parent);
        comp.time = 3;
        comp.__layers = [];
        Object.defineProperty(comp, "numLayers", {
            configurable: true,
            get: function () { return comp.__layers.length; },
        });
        comp.layer = function (i) { return comp.__layers[i - 1]; };
        Object.defineProperty(comp, "selectedLayers", {
            configurable: true,
            get: function () { return comp.__layers.filter(function (l) { return l.selected; }); },
        });
        comp.layers = { add: function (src) { return insertLayer(comp, src.name, 1); } };
        comp.openInViewer = function () { return comp; };
        return comp;
    }

    function insertLayer(comp, name, atIndex) {
        const layer = {
            __kind: "avlayer", name: name, __uid: nextUid++,
            selected: false, startTime: 0, inPoint: 0, source: null,
        };
        Object.defineProperty(layer, "index", {
            configurable: true,
            get: function () { return comp.__layers.indexOf(layer) + 1; },
        });
        layer.moveBefore = function (other) {
            const from = comp.__layers.indexOf(layer);
            if (from >= 0) comp.__layers.splice(from, 1);
            const to = comp.__layers.indexOf(other);
            comp.__layers.splice(to < 0 ? 0 : to, 0, layer);
        };
        layer.remove = function () {
            const i = comp.__layers.indexOf(layer);
            if (i >= 0) comp.__layers.splice(i, 1);
        };
        const at = (atIndex || comp.__layers.length + 1) - 1;
        comp.__layers.splice(at, 0, layer);
        return layer;
    }

    const project = {
        rootFolder: rootFolder,
        activeItem: null,
        item: function (i) { return all[i - 1]; },
        items: {
            addFolder: function (n) { return addFolder(n, rootFolder); },
            addComp: function (n) { return makeComp(n, rootFolder); },
        },
        importFile: function (opts) { return project.__importer(opts); },
        __importer: function () { return null; },
    };
    Object.defineProperty(project, "numItems", {
        get: function () { return all.length; },
    });

    return {
        project: project,
        rootFolder: rootFolder,
        mutations: mutations,
        all: all,
        makeItem: makeItem,
        addFolder: addFolder,
        makeComp: makeComp,
        insertLayer: insertLayer,
        appendLayer: function (comp, name) { return insertLayer(comp, name, comp.__layers.length + 1); },
        itemIds: function () {
            return all.map(function (it) { return it.id; }).sort(function (a, b) { return a - b; });
        },
        rootFolders: function () {
            return rootFolder.__children.filter(function (c) { return c.__kind === "folder"; });
        },
    };
}

const IMPORT_PRELUDE = [
    "var __CS_IMPORT_BATCH_ACTIVE = false;",
    "var __CS_IMPORT_IO = null;",
    "var _csProfileLog = null;",
].join("\n");

const IMPORT_REAL = sliceAll(IMPORT_SRC, [
    "csBeginUndoGroup", "csEndUndoGroup", "csItemKind", "csClassifyItemsOnce",
    "csSnapshotProjectItemIds", "csSnapshotCompLayers", "csRollbackToSnapshot",
    "csDispatchImport", "_csProfilePoint", "importBatch", "importCompDirect",
    "toolkitOrganizeTemplateImport",
]);

function buildImportRealm(cfg) {
    cfg = cfg || {};
    const model = createProjectModel();
    const counters = newCounters();
    const anchorLog = [];
    const guardDuringImport = [];
    const hires = {
        _t: 0,
        get hiresTimer() { const v = this._t; this._t = 0; return v; },
        add: function (us) { this._t += us; },
    };

    const app = {
        project: model.project,
        // `undoBeginThrows` models the scenario req 2.24 describes: the BATCH's
        // own beginUndoGroup fails while the per-section routines can still open
        // theirs. Scoping the throw to the batch group name is what makes case 21
        // satisfiable — a blanket throw would make `undoBegin` structurally 0.
        beginUndoGroup: function (name) {
            counters.undoAttempts++;
            if (cfg.undoBeginThrows && name === "CompSaver Import") {
                throw new Error("beginUndoGroup failed");
            }
            counters.undoBegin++;
        },
        endUndoGroup: function () { counters.undoEnd++; },
        beginSuppressDialogs: function () { counters.suppressBegin++; },
        endSuppressDialogs: function () { counters.suppressEnd++; },
    };

    const src = [
        CORE_PURE,
        IMPORT_PRELUDE,
        IMPORT_REAL,
        sliceAll(CORE_SRC, ["deselectAllLayers", "getTopSelectedLayer"]),
        sliceFn(SAVE_SRC, "placeLayerAtPlayhead"),
    ].join("\n");

    const ctx = buildRealm(src, {
        app: app,
        $: hires,
        File: function File(p) {
            this.fsName = String(p).replace(/\\/g, "/");
            this.name = this.fsName.split("/").pop();
            this.exists = true;
        },
        Folder: function Folder(p) {
            this.fsName = String(p).replace(/\\/g, "/");
            this.exists = false;
            this.getFiles = function () { return []; };
        },
        ImportOptions: function ImportOptions(f) { this.file = f; },
        __anchorLog: anchorLog,
        csImportIoOwn: function () { return false; },
        csImportIoRelease: function () { },
        csImportIoBegin: function () { },
        csImportIoEnd: function () { },
        csExistingNamesOnce: function () { return {}; },
        csEnumerateFolderOnce: function () { return []; },
        safeRenameAllImportedItems: function () { },
        forceCompViewerRefresh: function () { },
        resolveTemplateFiles: function () {
            guardDuringImport.push(ctxHolder.ctx ? ctxHolder.ctx.__CS_IMPORT_BATCH_ACTIVE : null);
            return {
                folder: { fsName: "C:/lib/comp/Cat/T", exists: true },
                meta: {},
                mainFile: { fsName: "C:/lib/comp/Cat/T/project.aep", name: "project.aep", exists: true },
                assetsFolder: { fsName: "C:/lib/comp/Cat/T/assets", exists: false },
            };
        },
    });
    const ctxHolder = { ctx: ctx };

    // Keep the REAL getTopSelectedLayer and record what it hands back, so the
    // anchor each template actually used is observable by identity.
    vm.runInContext(
        "var __realGetTop = getTopSelectedLayer;" +
        "getTopSelectedLayer = function (c) { var t = __realGetTop(c); __anchorLog.push(t); return t; };",
        ctx
    );

    return {
        ctx: ctx, app: app, model: model, counters: counters,
        anchorLog: anchorLog, guardDuringImport: guardDuringImport, hires: hires,
    };
}

// ─────────────────────────────────────────────────────────────
// Harness B — whole-file sandboxes
// ─────────────────────────────────────────────────────────────
const hostCore = loadHelpers({
    file: path.join("jsx", "core.jsx"),
    injected: { app: {}, File: function () { }, Folder: function () { } },
});

function isSafeSegment(seg) {
    if (typeof seg !== "string") return false;
    if (seg === "." || seg === ".." || seg === "") return false;
    if (/[.\s]$/.test(seg)) return false;
    if (/[\\/:*?"<>|]/.test(seg)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(seg)) return false;
    return true;
}

// ============================================================
// R1 — a value read after the reference that produces it was destroyed
// ============================================================
describe("R1 — post-reopen reference invalidation and reopen-failure reporting", () => {
    test("Case 1 (1.1): a comp save whose project.aep IS on disk is reported as an error, with two app.open calls", () => {
        const h = buildCompSaveRealm({ invalidateOnOpen: true });
        const reply = h.run("My Title", "Titles", "C:/lib");

        const targetWritten = h.counters.saveCalls.some((s) => /My Title\/project\.aep$/.test(s));
        record("1", "1.1",
            'reply=' + JSON.stringify(reply.slice(0, 180)) +
            '; project.aep written=' + targetWritten +
            '; reduceCalls=' + h.counters.reduceCalls +
            '; app.open calls=' + JSON.stringify(h.counters.openCalls),
            "a JSON success payload and EXACTLY ONE app.open");

        // Narrative sanity: the destructive window ran and the template is complete.
        expect(h.counters.reduceCalls).toBe(1);
        expect(targetWritten).toBe(true);

        // The defect.
        expect(h.counters.openCalls.length).toBe(1);
        expect(reply.indexOf("Error:")).toBe(-1);
        expect(JSON.parse(reply).ok).toBe(true);
    });

    test("Case 2 (1.2): coreSaveLayerType returns a 'Save Error' string because renderFrame reads the reduced + invalidated comp", () => {
        const h = buildLayerSaveRealm({ invalidateOnOpen: true });
        const out = h.run();

        record("2", "1.2",
            'typeof result=' + typeof out +
            '; value=' + JSON.stringify(String(out).slice(0, 180)) +
            '; saveCalls=' + JSON.stringify(h.counters.saveCalls) +
            '; app.open calls=' + h.counters.openCalls.length,
            "typeof result === 'object' && result.ok === true, with exactly ONE app.open");

        expect(h.counters.reduceCalls).toBe(1);
        expect(h.counters.saveCalls.length).toBe(2);

        expect(typeof out).toBe("object");
        expect(out && out.ok).toBe(true);
        expect(h.counters.openCalls.length).toBe(1);
    });

    test("Case 3 (1.5): a failed post-window reopen is reported as ok:true while the session points at the library template", () => {
        const hostileOpen = new Error("app.open failed: the project file is locked");
        const h = buildCompSaveRealm({ openThrows: hostileOpen });
        const reply = h.run("My Title", "Titles", "C:/lib");

        let parsed = null;
        try { parsed = JSON.parse(reply); } catch (e) { parsed = null; }

        record("3", "1.5",
            'reply=' + JSON.stringify(reply.slice(0, 180)) +
            '; parsed.ok=' + (parsed && parsed.ok) +
            '; app.project.file now = "' + h.app.project.file.fsName + '"',
            "a reported FAILURE naming the template project.aep and warning that the live session is pointed at it");

        // The session really is pointed at the library template now.
        expect(h.app.project.file.fsName).toContain("My Title/project.aep");

        expect(parsed && parsed.ok === true).toBe(false);
        expect(reply).toContain("My Title/project.aep");
    });
});

// ============================================================
// R2 — two resolvers, one question
// ============================================================
describe("R2 — getStrictSaveType and resolveCompForSave disagree", () => {
    test("Case 4 (1.3): empty selection — the panel advertises a comp save the engine refuses", () => {
        const h = buildResolverRealm({ activeComp: fakeComp("Comp A"), selection: [] });

        record("4", "1.3",
            'getStrictSaveType -> type="' + h.strict.type + '" message="' + h.strict.message +
            '" suggestedName="' + h.strict.suggestedName + '"' +
            '; resolveCompForSave -> ok=' + h.resolved.ok + ' error="' + h.resolved.error + '"',
            "type 'comp' implies resolveCompForSave().ok === true (the save the panel enabled runs)");

        expect(h.strict.type).toBe("comp");
        expect(h.resolved.ok).toBe(true);
    });

    test("Case 5 (1.4): one project comp plus a non-comp — the announced comp is not the saved comp", () => {
        const compA = fakeComp("Comp A");
        const compB = fakeComp("Comp B");
        const footage = { __kind: "footage", name: "logo.png" };
        const h = buildResolverRealm({ activeComp: compB, selection: [compA, footage] });

        record("5", "1.4",
            'project selection = {Comp A, logo.png}, Comp B in the viewer' +
            '; getStrictSaveType announced "' + h.strict.suggestedName + '"' +
            '; resolveCompForSave returned "' + (h.resolved.comp && h.resolved.comp.name) + '"',
            "both resolvers resolve the SAME composition, and the message names it");

        expect(h.strict.type).toBe("comp");
        expect(h.resolved.ok).toBe(true);
        expect(h.resolved.comp.name).toBe(h.strict.suggestedName);
    });
});

// ============================================================
// R3 — an unvalidated prefix and a swallowed creation failure
// ============================================================
describe("R3 — library-root validation and ensureDeepFolder honesty", () => {
    test("Case 6 (1.6): an empty library root creates the template tree at the volume root", () => {
        const h = buildCompSaveRealm({ fsSet: {} });
        const reply = h.run("My Title", "Titles", "");

        record("6", "1.6",
            'libraryRoot="" -> Folder.create() called for ' + JSON.stringify(h.creates) +
            '; reduceProject calls=' + h.counters.reduceCalls +
            '; reply=' + JSON.stringify(reply.slice(0, 140)),
            "rejected with an explicit error BEFORE any folder is created and before the destructive window");

        expect(h.creates).toEqual([]);
        expect(h.counters.reduceCalls).toBe(0);
        expect(reply.indexOf("Error:")).toBe(0);
    });

    test("Case 7 (1.7): Folder.create() returning false still enters the destructive window", () => {
        const h = buildLayerSaveRealm({ fsSet: { "C:/lib": true }, createFails: true });
        const out = h.run();

        record("7", "1.7",
            'Folder.create() returned false for ' + JSON.stringify(h.creates) +
            '; ensureDeepFolder still returned a Folder (exists=false)' +
            '; reduceProject calls=' + h.counters.reduceCalls +
            '; result=' + JSON.stringify(String(out).slice(0, 140)),
            "the save aborts before reduceProject: reduceCalls === 0");

        expect(h.creates.length).toBeGreaterThan(0);
        expect(h.counters.reduceCalls).toBe(0);
    });
});

// ============================================================
// R4 — three sanitizers, one of them unreachable
// ============================================================
describe("R4 — getSafeName produces reserved / traversing folder names", () => {
    test("Case 8 (1.8): '.', '..' and a trailing dot survive sanitization untouched", () => {
        const getSafeName = hostCore.get("getSafeName");
        const observed = {
            ".": getSafeName("."),
            "..": getSafeName(".."),
            "...": getSafeName("..."),
            "name.": getSafeName("name."),
        };

        record("8", "1.8",
            'jsx/core.jsx getSafeName -> ' + JSON.stringify(observed) +
            ' (so <root>/comp/<cat>/".." resolves to the SECTION folder)',
            "a filesystem-safe, non-traversing segment for every one of them");

        expect(isSafeSegment(observed[".."])).toBe(true);
        expect(isSafeSegment(observed["."])).toBe(true);
        expect(isSafeSegment(observed["..."])).toBe(true);
        expect(isSafeSegment(observed["name."])).toBe(true);
    });
});

// ============================================================
// R5 — computed once, delivered nowhere
// ============================================================
describe("R5 — the comp format, the render target and the borrowed playhead", () => {
    test("Case 9 (1.9, 1.10): the host result carries no format and no section/type, so meta.json gets no dim/assetsDir", () => {
        const h = buildCompSaveRealm({});
        const reply = h.run("My Title", "Titles", "C:/lib");
        const res = JSON.parse(reply);

        const required = ["width", "height", "pixelAspect", "frameRate", "duration", "section", "type"];
        const missing = required.filter((k) => !(k in res));

        const metaLiteral = sliceObjectLiteral(TEMPLATES_JS, "var metaObj = {");
        const panelWritesDim = /\bdim\s*:/.test(metaLiteral);
        const panelWritesWidth = /\bwidth\s*:/.test(metaLiteral);
        const assetsDirGate = /if \(resObj\.section === "comp"\)/.test(TEMPLATES_JS);

        record("9", "1.9 + 1.10",
            'host result keys=[' + Object.keys(res).join(",") + ']' +
            '; missing=[' + missing.join(",") + ']' +
            '; panel metaObj writes dim=' + panelWritesDim + ' width=' + panelWritesWidth +
            '; assetsDir gated on resObj.section === "comp" (a field the host never sends)=' + assetsDirGate,
            "the host result carries the comp format plus section/type, and meta.json records width/height/dim/pixelAspect/frameRate/duration and assetsDir");

        expect(missing).toEqual([]);
        expect(panelWritesWidth).toBe(true);
        expect(panelWritesDim).toBe(true);
    });

    test("Case 10 (1.11): renderTemplateThumbnail takes 2 arguments and renders 30% of the work area of whatever comp comes first", () => {
        const rendered = [];
        const suppress = { begin: 0, end: 0 };
        const firstComp = {
            __kind: "comp", name: "First Comp In Folder",
            width: 320, height: 180, pixelAspect: 1, duration: 10, frameRate: 25,
            workAreaStart: 0, workAreaDuration: 10,
        };
        const recordedComp = {
            __kind: "comp", name: "Recorded Comp",
            width: 320, height: 180, pixelAspect: 1, duration: 10, frameRate: 25,
            workAreaStart: 0, workAreaDuration: 10,
        };
        const importedFolder = { __kind: "folder", name: "scratch", remove: function () { } };
        const app = {
            project: {
                bitsPerChannel: 8,
                importFile: function () { return importedFolder; },
                items: { addComp: function () { throw new Error("no wrapper expected at 320px"); } },
            },
            beginSuppressDialogs: function () { suppress.begin++; },
            endSuppressDialogs: function () { suppress.end++; },
        };
        const ctx = buildRealm([CORE_PURE, sliceFn(SAVE_SRC, "renderTemplateThumbnail")].join("\n"), {
            app: app,
            File: createFileCtor({ "C:/lib/comp/Cat/T/project.aep": true }),
            ImportOptions: function ImportOptions(f) { this.file = f; },
            findCompItemInFolder: function () { return firstComp; },
            findCompItemInFolderByName: function (folder, name) {
                return name === recordedComp.name ? recordedComp : null;
            },
            renderFrameToPng: function (comp, time) {
                rendered.push({ comp: comp.name, time: time });
                return { success: true };
            },
        });

        const enc = ctx.encodeBridge;
        // The save engine recorded renderComp="Recorded Comp" and renderFrame=50 at
        // 25 fps, i.e. t = 2s. The unfixed 2-arg signature discards both.
        ctx.renderTemplateThumbnail(
            enc("C:/lib/comp/Cat/T/project.aep"),
            enc("C:/lib/comp/Cat/T/thumbnail.png"),
            enc("Recorded Comp"),
            enc("50")
        );

        const arity = ctx.renderTemplateThumbnail.length;
        record("10", "1.11",
            'renderTemplateThumbnail.length=' + arity +
            '; rendered=' + JSON.stringify(rendered) +
            '; recorded target was comp "Recorded Comp" @ frame 50 (25 fps -> t=2s)',
            "the recorded comp rendered at renderFrame / frameRate = 2s");

        expect(arity).toBeGreaterThanOrEqual(4);
        expect(rendered[0].comp).toBe("Recorded Comp");
        expect(rendered[0].time).toBeCloseTo(2, 6);
    });

    test("Case 11 (1.12): renderFrameToPng permanently moves the composition's playhead", () => {
        const suppress = { begin: 0, end: 0 };
        const app = {
            beginSuppressDialogs: function () { suppress.begin++; },
            endSuppressDialogs: function () { suppress.end++; },
        };
        const helpers = loadHelpers({ file: path.join("jsx", "helpers.jsx"), injected: { app: app } });
        const renderFrameToPng = helpers.get("renderFrameToPng");

        const okComp = aeFakes.createCompFake({ time: 5 });
        okComp.saveFrameToPng = function () { };
        renderFrameToPng(okComp, 2, aeFakes.createFileFake({ exists: true, length: 4096 }));
        const timeAfterSuccess = okComp.time;

        const throwComp = aeFakes.createCompFake({ time: 7 });
        throwComp.saveFrameToPng = function () { throw new Error("render failed"); };
        renderFrameToPng(throwComp, 3, aeFakes.createFileFake({ exists: false, length: 0 }));
        const timeAfterThrow = throwComp.time;

        record("11", "1.12",
            'success path: comp.time 5 -> ' + timeAfterSuccess +
            '; throwing path: comp.time 7 -> ' + timeAfterThrow,
            "comp.time restored to its previous value on BOTH the success and the throwing path");

        expect(timeAfterSuccess).toBe(5);
        expect(timeAfterThrow).toBe(7);
    });
});

// ============================================================
// R6 — itemExists returns a folder name where the panel tests for "true"
// ============================================================
describe("R6 — the itemExists contract", () => {
    test("Case 12 (1.13, 1.14): the reply is a folder name, the panel's === \"true\" is false, and a 3-argument call searches comp for a layer save", () => {
        const disk = {
            folders: {
                "C:/lib/comp/Titles": ["My Title"],
                "C:/lib/comp/Titles/My Title": [],
                "C:/lib/layer/Titles": ["My_Title__layer"],
                "C:/lib/layer/Titles/My_Title__layer": [],
            },
            texts: {
                "C:/lib/comp/Titles/My Title/meta.json": '{"name":"My Title"}',
                "C:/lib/layer/Titles/My_Title__layer/meta.json": '{"name":"My Title"}',
            },
        };
        const probes = [];

        function FolderFake(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.fsName = norm;
            this.name = norm.split("/").pop();
            probes.push(norm);
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () { return Object.prototype.hasOwnProperty.call(disk.folders, norm); },
            });
            this.getFiles = function () {
                const kids = disk.folders[norm];
                if (!kids) return null;
                return kids.map(function (k) { return new FolderFake(norm + "/" + k); });
            };
        }

        const ctx = buildRealm([CORE_PURE, sliceFn(IMPORT_SRC, "itemExists")].join("\n"), {
            Folder: FolderFake,
            File: function File(p) {
                const norm = String(p).replace(/\\/g, "/");
                this.fsName = norm;
                this.name = norm.split("/").pop();
                Object.defineProperty(this, "exists", {
                    configurable: true,
                    get: function () { return Object.prototype.hasOwnProperty.call(disk.texts, norm); },
                });
            },
            readFileText: function (f) { return disk.texts[f.fsName] || ""; },
        });

        const enc = ctx.encodeBridge;
        probes.length = 0;
        // Exactly what js/templates/templates.js:3170 sends: THREE arguments, for a
        // save whose section is "layer".
        const reply = ctx.decodeBridge(
            ctx.itemExists(enc("My Title"), enc("Titles"), enc("C:/lib"))
        );
        const categoryProbe = probes[0];
        const panelSaysExists = reply === "true";
        let shaped = null;
        try { shaped = JSON.parse(reply); } catch (e) { shaped = null; }

        record("12", "1.13 + 1.14",
            '3-argument itemExists probed "' + categoryProbe + '" (section defaulted to comp)' +
            ' and returned ' + JSON.stringify(reply) +
            '; panel test decodeBridge(...) === "true" -> ' + panelSaysExists +
            ' so oldId is always "" and the .fav preservation / old-folder removal is dead code',
            'the section actually being saved is searched, and the reply is {exists:true,id:"…"}');

        expect(categoryProbe).toContain("/layer/");
        expect(shaped && shaped.exists).toBe(true);
        expect(shaped && typeof shaped.id).toBe("string");
    });
});

// ============================================================
// R7 — transport primitives that corrupt rather than report
// ============================================================
describe("R7 — decodeBridge divergence, invalid JSON, untimed import transport", () => {
    test("Case 13 (1.15): one malformed payload decodes to two different strings, and neither side reports", () => {
        const hostDecode = hostCore.get("decodeBridge");
        const panelDecode = panelBridge.decodeBridge;

        const truncated = "0048006";          // length % 4 === 3
        const nanChunk = "00480065ZZZZ00";    // 14 chars, one non-hex chunk

        const rows = [truncated, nanChunk].map(function (p) {
            return '"' + p + '": panel=' + JSON.stringify(panelDecode(p)) +
                " host=" + JSON.stringify(hostDecode(p));
        });

        record("13", "1.15",
            rows.join(" | ") +
            '; neither implementation validates the length nor reports a decode failure',
            "both implementations behave identically and surface a decode failure ({ok:false}) to the caller");

        expect(panelDecode(nanChunk)).toBe(hostDecode(nanChunk));
        expect(panelDecode(truncated)).toBe(hostDecode(truncated));
        expect(typeof panelBridge.decodeBridgeStrict).toBe("function");
        expect(hostCore.has("decodeBridgeStrict")).toBe(true);
    });

    test("Case 14 (1.16): escapeJSON emits invalid JSON for control characters and deletes \\r outright", () => {
        const jsonStringify = hostCore.get("jsonStringify");

        const ctrlDoc = jsonStringify({ e: "a\u0001b" });
        let ctrlError = null;
        try { JSON.parse(ctrlDoc); } catch (e) { ctrlError = e.message; }

        const crDoc = jsonStringify({ e: "a\r\nb" });
        let crValue = "<parse error>";
        try { crValue = JSON.parse(crDoc).e; } catch (e) { crValue = "<parse error>"; }

        record("14", "1.16",
            'jsonStringify({e:"a\\u0001b"}) = ' + JSON.stringify(ctrlDoc) +
            ' -> JSON.parse ' + (ctrlError ? "THREW: " + ctrlError : "ok") +
            '; "a\\r\\nb" round-tripped as ' + JSON.stringify(crValue),
            "valid JSON escapes (\\r, \\t, \\u00XX) so a host success payload always parses and round-trips");

        expect(ctrlError).toBe(null);
        expect(crValue).toBe("a\r\nb");
    });

    test("Case 15 (1.17): the card import transport never settles, .importing is never cleared, and a CEP sentinel is decoded as hex", async () => {
        const card = { classes: { importing: false } };
        let settled = false;

        const neverReturningCsInterface = { evalScript: function () { /* never invokes the callback */ } };
        const template = { id: "T1", name: "T1", category: "Cat", section: "comp", sourcePath: "C:/lib" };

        importTemplates(
            {
                // Exactly the transport js/templates/templates.js:2412-2415 injects:
                // csInterface.evalScript directly, bypassing the timeout-guarded callHost.
                callHost: function (payloadHex, cb) {
                    neverReturningCsInterface.evalScript('importBatch("' + payloadHex + '")', cb);
                },
                resolveCached: function () { return null; },
                onStarted: function () { card.classes.importing = true; },
                encode: panelBridge.encodeBridge,
                decode: panelBridge.decodeBridge,
            },
            { rootPath: "C:/lib", templates: [template] },
            function () { settled = true; card.classes.importing = false; }
        );

        await new Promise(function (r) { setTimeout(r, 250); });

        // Second half: the CEP "EvalScript error." sentinel fed to decodeBridge as hex.
        let sentinelReason = null;
        importTemplates(
            {
                callHost: function (payloadHex, cb) { cb("EvalScript error."); },
                resolveCached: function () { return null; },
                encode: panelBridge.encodeBridge,
                decode: panelBridge.decodeBridge,
            },
            { rootPath: "C:/lib", templates: [{ id: "T2", name: "T2", category: "Cat", section: "comp", sourcePath: "C:/lib" }] },
            function (res) { sentinelReason = res.perTemplate[0] && res.perTemplate[0].reason; }
        );

        record("15", "1.17",
            'after 250ms with a never-returning host: settled=' + settled +
            ', card.importing=' + card.classes.importing +
            '; CEP sentinel "EvalScript error." was hex-decoded and reported as ' +
            JSON.stringify(sentinelReason),
            "a settled failure result within the timeout, .importing always cleared, and the CEP sentinel recognised as an error");

        expect(settled).toBe(true);
        expect(card.classes.importing).toBe(false);
        expect(String(sentinelReason)).toMatch(/evalscript|timed out|timeout|host error/i);
    });
});

// ============================================================
// R8 — import cleanup at exit points, and per-comp Project-panel folders
// ============================================================
describe("R8 — import leaks and Project-panel folder accumulation", () => {
    test("Case 16 (1.18): the 'No comp found!' early return leaves every imported item in the project", () => {
        const h = buildImportRealm({});
        const activeComp = h.model.makeComp("Active Comp");
        h.model.appendLayer(activeComp, "Existing");
        h.model.project.activeItem = activeComp;

        // An .aep import that yields footage but no composition.
        h.model.project.__importer = function () {
            const folder = h.model.makeItem("folder", "T1 Folder");
            h.model.makeItem("footage", "clip.mp4", folder);
            h.model.makeItem("footage", "logo.png", folder);
            return folder;
        };

        const idsBefore = h.model.itemIds();
        const enc = h.ctx.encodeBridge;
        const reply = h.ctx.decodeBridge(
            h.ctx.importCompDirect(enc("T1"), enc("Cat"), enc("C:/lib"), "comp")
        );
        const idsAfter = h.model.itemIds();
        const leaked = idsAfter.filter(function (id) { return idsBefore.indexOf(id) === -1; });

        record("16", "1.18",
            'standalone importCompDirect returned ' + JSON.stringify(reply) +
            '; project item ids before=[' + idsBefore.join(",") + '] after=[' + idsAfter.join(",") + ']' +
            '; leaked=[' + leaked.join(",") + ']' +
            '; recorded mutations=' + JSON.stringify(h.model.mutations),
            "every item app.project.importFile added is removed — the id multiset is restored");

        expect(reply).toBe("No comp found!");
        expect(leaked).toEqual([]);
        expect(idsAfter).toEqual(idsBefore);
    });

    test("Case 17 (1.19, 1.20): N imports add N root folders, and a solid-only import strands an empty one", () => {
        // ── 1.19: three successive comp imports ──────────────────────────
        const acc = buildImportRealm({});
        const accComp = acc.model.makeComp("Active Comp");
        acc.model.project.activeItem = accComp;
        const before = acc.model.rootFolders().length;
        for (let n = 1; n <= 3; n++) {
            const folder = acc.model.makeItem("folder", "T Folder " + n);
            // safeRenameAllImportedItems has already uniquified the comp's name
            // against every existing item name, so the find-existing-folder scan
            // in toolkitOrganizeTemplateImport can never match.
            const comp = acc.model.makeComp(n === 1 ? "Name" : "Name " + n, folder);
            const footage = acc.model.makeItem("footage", "clip" + n + ".mp4", folder);
            acc.ctx.toolkitOrganizeTemplateImport([folder, comp, footage], comp);
        }
        const containers = acc.model.rootFolders().map(function (f) { return f.name; });
        const addFolderOps = acc.model.mutations
            .filter(function (m) { return m.op === "addFolder"; })
            .map(function (m) { return m.name; });

        // ── 1.20: a solid-only import ────────────────────────────────────
        const solid = buildImportRealm({});
        const solidActive = solid.model.makeComp("Active Comp");
        solid.model.project.activeItem = solidActive;
        const importedFolder = solid.model.makeItem("folder", "Solid Only Folder");
        const solidComp = solid.model.makeComp("Solid Only", importedFolder);
        const solidFootage = solid.model.makeItem("footage", "Red Solid 1");
        solidFootage.mainSource = { __kind: "solidSource" };
        solid.ctx.toolkitOrganizeTemplateImport(
            [importedFolder, solidComp, solidFootage], solidComp
        );
        const strandedAtRoot = importedFolder.parentFolder === solid.model.rootFolder &&
            !importedFolder.__removed;
        const emptyRootFolders = solid.model.rootFolders()
            .filter(function (f) { return f.numItems === 0; })
            .map(function (f) { return f.name; });

        record("17", "1.19 + 1.20",
            '3 imports: root folders before=' + before + ' after=[' + containers.join(", ") + ']' +
            ', addFolder calls=[' + addFolderOps.join(", ") + ']' +
            '; solid-only import: leftover importFile folder still at root=' + strandedAtRoot +
            ', empty root folders=[' + emptyRootFolders.join(", ") + ']',
            "ONE reused container folder (_CompSaver_Assets) across imports, and zero empty folders at the Project-panel root");

        expect(containers.length).toBe(1);
        expect(strandedAtRoot).toBe(false);
        expect(emptyRootFolders).toEqual([]);
    });
});

// ============================================================
// R9 — anchor resolved by name, and the batch anchor drift
// ============================================================
describe("R9 — layer placement anchoring", () => {
    test("Case 18 (1.21): with two layers named BG the imported layer lands above the wrong one", () => {
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        const upperBG = h.model.appendLayer(comp, "BG");
        const lowerBG = h.model.appendLayer(comp, "BG");
        lowerBG.selected = true; // the user selected the LOWER BG

        const newLayer = comp.layers.add({ name: "Imported" }); // AE inserts at index 1
        h.ctx.placeLayerAtPlayhead(comp, newLayer, 3, lowerBG);

        const order = comp.__layers.map(function (l) { return l.name + "#" + l.__uid; });
        const landedAbove = comp.__layers[comp.__layers.indexOf(newLayer) + 1];

        record("18", "1.21",
            'anchor was BG#' + lowerBG.__uid + ' (the selected reference)' +
            '; placeLayerAtPlayhead re-located the anchor BY NAME and the new layer landed above ' +
            (landedAbove ? landedAbove.name + "#" + landedAbove.__uid : "nothing") +
            '; final order=[' + order.join(", ") + ']' +
            '; newLayer.index=' + newLayer.index + ', selected anchor index=' + lowerBG.index,
            "the new layer sits directly above the SELECTED reference: newLayer.index === anchor.index - 1");

        expect(landedAbove).toBe(lowerBG);
        expect(newLayer.index).toBe(lowerBG.index - 1);
    });

    test("Case 19 (1.22): in a 3-template batch, templates 2 and 3 anchor to the previous insert", () => {
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        h.model.appendLayer(comp, "Top");
        const chosen = h.model.appendLayer(comp, "User Selected");
        chosen.selected = true;
        h.model.project.activeItem = comp;

        let seq = 0;
        h.model.project.__importer = function () {
            seq++;
            const folder = h.model.makeItem("folder", "T" + seq + " Folder");
            h.model.makeComp("Template " + seq, folder);
            return folder;
        };

        const payload = {
            rootPath: "C:/lib",
            templates: [1, 2, 3].map(function (n) {
                return { id: "t" + n, name: "T" + n, category: "Cat", section: "comp", sourcePath: "C:/lib" };
            }),
        };
        const raw = h.ctx.importBatch(h.ctx.encodeBridge(JSON.stringify(payload)));
        const result = JSON.parse(h.ctx.decodeBridge(raw));

        const anchors = h.anchorLog.map(function (a) {
            return a ? a.name + "#" + a.__uid : "null";
        });

        record("19", "1.22",
            'per-template statuses=' + JSON.stringify(result.perTemplate.map(function (e) { return e.status; })) +
            '; anchors handed to each template=[' + anchors.join(", ") + ']' +
            '; the user selected "User Selected"#' + chosen.__uid +
            '; original selection still selected at batch end=' + chosen.selected,
            "every template in the batch anchors to the layer the user selected, and that selection is restorable");

        expect(h.anchorLog.length).toBe(3);
        expect(h.anchorLog[0]).toBe(chosen);
        expect(h.anchorLog[1]).toBe(chosen);
        expect(h.anchorLog[2]).toBe(chosen);
        expect(chosen.selected).toBe(true);
    });
});

// ============================================================
// R10 — begin*/end* paired as sequential statements, and the batch-guard inversion
// ============================================================
describe("R10 — suppression / undo balance", () => {
    test("Case 20 (1.23): a throw between beginSuppressDialogs and endSuppressDialogs leaves suppression stuck on", () => {
        // ── Site 1: jsx/import.jsx:1452-1465 — _csProfilePoint sits OUTSIDE the
        // inner try, between the two suppression calls.
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        h.model.project.activeItem = comp;
        h.model.project.__importer = function () {
            const folder = h.model.makeItem("folder", "T Folder");
            h.model.makeComp("Template", folder);
            return folder;
        };
        h.ctx._csProfileLog = {
            writeln: function () { throw new Error("profile log write failed"); },
            close: function () { },
        };
        const enc = h.ctx.encodeBridge;
        const importReply = h.ctx.decodeBridge(
            h.ctx.importCompDirect(enc("T1"), enc("Cat"), enc("C:/lib"), "comp")
        );
        const importDelta = h.counters.suppressBegin - h.counters.suppressEnd;

        // ── Site 2: jsx/templates_save.jsx:944-950 — the restore handler's
        // `log(... + e.toString())` is itself a throw between the two calls.
        const unstringifiable = { toString: function () { throw new Error("unstringifiable host error"); } };
        const s = buildCompSaveRealm({ openThrows: unstringifiable });
        let saveThrew = null;
        try { s.run("My Title", "Titles", "C:/lib"); } catch (e) { saveThrew = String(e && e.message); }
        const saveDelta = s.counters.suppressBegin - s.counters.suppressEnd;

        record("20", "1.23",
            'importCompDirect (profile log write throws between the calls): reply=' + JSON.stringify(importReply) +
            ', beginSuppressDialogs=' + h.counters.suppressBegin +
            ', endSuppressDialogs=' + h.counters.suppressEnd +
            ' (delta ' + importDelta + ')' +
            '; saveActiveComp restore handler: threw=' + JSON.stringify(saveThrew) +
            ', beginSuppressDialogs=' + s.counters.suppressBegin +
            ', endSuppressDialogs=' + s.counters.suppressEnd +
            ' (delta ' + saveDelta + ')',
            "endSuppressDialogs(false) guaranteed by try/finally on every path: the counters always balance");

        expect(importDelta).toBe(0);
        expect(saveDelta).toBe(0);
    });

    test("Case 21 (1.24): when the batch's beginUndoGroup throws, the guard stays false so each per-section routine opens its own group and the user keeps a working undo", () => {
        const h = buildImportRealm({ undoBeginThrows: true });
        const comp = h.model.makeComp("Active Comp");
        h.model.project.activeItem = comp;
        let seq = 0;
        h.model.project.__importer = function () {
            seq++;
            const folder = h.model.makeItem("folder", "T" + seq + " Folder");
            h.model.makeComp("Template " + seq, folder);
            return folder;
        };

        const payload = {
            rootPath: "C:/lib",
            templates: [1, 2].map(function (n) {
                return { id: "t" + n, name: "T" + n, category: "Cat", section: "comp", sourcePath: "C:/lib" };
            }),
        };
        const raw = h.ctx.importBatch(h.ctx.encodeBridge(JSON.stringify(payload)));
        const result = JSON.parse(h.ctx.decodeBridge(raw));

        record("21", "1.24",
            'app.beginUndoGroup attempts=' + h.counters.undoAttempts +
            ' (the batch group "CompSaver Import" throws)' +
            ', groups actually opened=' + h.counters.undoBegin +
            ', endUndoGroup calls=' + h.counters.undoEnd +
            '; __CS_IMPORT_BATCH_ACTIVE during each template=' + JSON.stringify(h.guardDuringImport) +
            '; statuses=' + JSON.stringify(result.perTemplate.map(function (e) { return e.status; })),
            "a failed batch beginUndoGroup leaves the guard false, so each per-section routine opens its own group and the DOM mutations always sit inside a working undo");

        // The guard must be false for every template: with no batch group to own,
        // the per-section routines must NOT be suppressed.
        expect(h.guardDuringImport.every(function (g) { return g === false; })).toBe(true);
        // At least one real undo group covers the mutations (one per template here).
        expect(h.counters.undoBegin).toBeGreaterThanOrEqual(1);
    });
});

// ============================================================
// R11 — folder.getFiles("*.aep")[0]: selection from an unspecified order
// ============================================================
describe("R11 — resolveTemplateFiles fallback determinism", () => {
    function resolveWithOrder(order) {
        const folderPath = "C:/lib/comp/Cat/T1";
        const aepNames = order.slice();

        function FileFake(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.fsName = norm;
            this.name = norm.split("/").pop();
            const self = this;
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () { return aepNames.indexOf(self.name) !== -1; },
            });
        }
        function FolderFake(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.fsName = norm;
            this.name = norm.split("/").pop();
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () { return norm === folderPath; },
            });
            this.getFiles = function (mask) {
                if (mask !== "*.aep") return [];
                return aepNames.map(function (n) { return new FileFake(norm + "/" + n); });
            };
        }

        const handle = loadHelpers({
            file: path.join("jsx", "core.jsx"),
            injected: {
                app: {},
                File: FileFake,
                Folder: FolderFake,
                // meta.json names a mainFile that is NOT on disk, so the
                // getFiles("*.aep") fallback ladder is what selects the file.
                csReadTemplateMeta: function () { return { mainFile: "missing.aep" }; },
            },
        });
        return handle.get("resolveTemplateFiles")("C:/lib", "Cat", "T1", "comp");
    }

    test("Case 22 (1.25): the resolved .aep depends on the enumeration order", () => {
        const forward = resolveWithOrder(["b.aep", "project.aep"]);
        const reverse = resolveWithOrder(["project.aep", "b.aep"]);
        const forwardName = forward && forward.mainFile && forward.mainFile.name;
        const reverseName = reverse && reverse.mainFile && reverse.mainFile.name;

        record("22", "1.25",
            'getFiles("*.aep") order ["b.aep","project.aep"] resolved "' + forwardName + '"' +
            '; the reverse order resolved "' + reverseName + '"' +
            ' — aepFiles[0] from an unspecified enumeration order',
            'a documented precedence: "project.aep" for BOTH orders');

        expect(forwardName).toBe(reverseName);
        expect(forwardName).toBe("project.aep");
    });
});
