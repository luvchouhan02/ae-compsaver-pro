// ============================================================
// tests/comp-pipeline-preservation.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 2)
//
// Property 2 (Preservation) — "Non-Buggy Inputs Are Byte-For-Byte Unchanged".
//
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10,
// 3.11, 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.18, 3.19, 3.20, 3.21, 3.22, 3.23,
// 3.24, 3.25, 3.26, 3.27, 3.28, 3.29, 3.30**
//
// WHY THIS FILE EXISTS NOW
// -----------------------
// It is written and PASSING on the UNFIXED code. It records the baseline the
// twelve fixes (F1-F12) must not change. After a fix lands this observation can
// never be made again, which is why it runs before any production edit. Task 18
// re-runs this exact file against the fixed code and compares to the same
// recorded baseline.
//
// OBSERVATION-FIRST METHODOLOGY
// -----------------------------
// Every value in `PRE_FIX_BASELINE` below was OBSERVED by running the unfixed
// code, not derived from what the code ought to do. Each case runs the real
// engine over an input class for which `isBugCondition` (bugfix.md "Bug
// Condition") is FALSE, and asserts the observed output. Where the obvious input
// class straddled the buggy side, the class was NARROWED to the non-buggy side
// rather than the assertion weakened; every such narrowing is recorded in the
// case comment.
//
// The baseline snapshot is an inline frozen constant rather than a generated
// fixture (the convention of tests/helpers/generate-baseline.js) so the whole
// pre-fix observation lives in the one file task 18 re-runs.
//
// PROPERTY-BASED GENERATION
// -------------------------
// The preserved surface is broad (every save path, every import path, every
// string that crosses the Bridge, every already-safe name) and the regressions
// that matter are edge cases a fixed table would not reach: a name exactly 255
// characters, a payload that is a multiple of four AND corrupt, a batch where
// template 3 of 5 fails, a comp with `frameRate === 0`. fast-check reaches those
// combinations and shrinks a failure to a minimal counterexample.
//
// HARNESSES (both pre-existing; the builders below mirror
// tests/comp-pipeline-bug-exploration.test.js so the two suites observe the same
// engines through the same fakes)
// ---------------------------------------------------------------------------
// Harness A — function slicing into a `vm`: the `sliceFn(src, name)` brace-walk
//   from tests/save-window-invariants.test.js:27-38 (the same shape
//   tests/import-timings.test.js uses for importBatch). The REAL saveActiveComp /
//   coreSaveLayerType / importBatch / importCompDirect / importLayerTypeAep /
//   placeLayerAtPlayhead / renderTemplateThumbnail / the csIo layer are executed.
// Harness B — whole-file sandbox: tests/helpers/loadHelpers.js over jsx/core.jsx,
//   jsx/helpers.jsx and js/textanim/textanim.js, with tests/helpers/aeFakes.js.
//
// `jsonParse` is deliberately NOT sliced: its body contains "{" and "}" inside
// string literals, which a brace walk truncates. Every host caller already
// guards it with `typeof jsonParse === "function" ? jsonParse(x) : JSON.parse(x)`
// for exactly this kind of harness — the same fallback
// tests/import-timings.test.js relies on. Where a parse count matters, a
// counting `jsonParse` is injected into the realm instead.
//
// This file changes NO production code.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const { loadHelpers } = require("./helpers/loadHelpers");
const aeFakes = require("./helpers/aeFakes");
const panelBridge = require("../js/core/bridge.js");
const { importTemplates, parseHostBatchResult } = require("../js/core/importEngine.js");
const { runSaveController, defaultParseEssential } = require("../js/core/saveController.js");
const {
    LibraryIndex,
    normalizeFolderPath,
    LIBRARY_THUMB_PLACEHOLDER,
} = require("../js/core/persistence.js");
const pathBuilders = require("../js/core/pathBuilders.js");

const ROOT = path.resolve(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SAVE_SRC = readSrc("jsx/templates_save.jsx");
const CORE_SRC = readSrc("jsx/core.jsx");
const IMPORT_SRC = readSrc("jsx/import.jsx");
const PANEL_BRIDGE_SRC = readSrc("js/core/bridge.js");

// ─────────────────────────────────────────────────────────────
// THE RECORDED PRE-FIX BASELINE
// Every entry was observed by running the unfixed engines. No fix may change
// any of them; task 18 asserts the same constants against the fixed code.
// ─────────────────────────────────────────────────────────────
const EM_DASH = "\u2014";
const PRE_FIX_BASELINE = Object.freeze({
    // 3.4 — the reduce-first destructive-window protocol, as recorded.
    compSaveSequence: Object.freeze([
        "beginUndoGroup", "save(PROTECTIVE)", "reduceProject", "save(TARGET)",
        "endUndoGroup", "beginSuppressDialogs", "open", "endSuppressDialogs",
    ]),
    // coreSaveLayerType additionally builds the temp comp between the
    // protective save and the reduce.
    layerSaveSequence: Object.freeze([
        "beginUndoGroup", "save(PROTECTIVE)", "addComp", "reduceProject",
        "save(TARGET)", "endUndoGroup", "beginSuppressDialogs", "open",
        "endSuppressDialogs",
    ]),
    // UPDATED IN TASK 18 — required by requirements 2.9 and 2.10 (F1b).
    // saveActiveComp's result gained seven keys, all additive and all built from
    // the pre-window capture: `section` + `type` (2.10 — the panel keys its
    // meta.json / assetsDir branches off them, and their absence silently
    // dropped assetsDir from every comp save) and `width` / `height` /
    // `pixelAspect` / `frameRate` / `duration` (2.9 — the composition format,
    // so meta.json records it and no consumer opens the .aep to learn it).
    // Nothing was removed and nothing was reordered; the order below is the
    // order actually received from the fixed engine.
    compSaveResultKeys: Object.freeze([
        "ok", "templateId", "name", "category", "section", "type", "folderPath",
        "assetsList", "oldId", "needsThumbnail", "width", "height",
        "pixelAspect", "frameRate", "duration", "renderComp", "renderFrame",
    ]),
    // UPDATED IN TASK 18 — required by requirement 2.9 (F2c).
    // coreSaveLayerType's result gained the same five format fields, read from
    // its pre-reopen `capComp*` capture instead of from a comp the reduce
    // removed. `section` / `type` are not added here: this engine is already
    // called per section and its callers derive both from the request. Additive
    // and unreordered; the order below is the order actually received.
    layerSaveResultKeys: Object.freeze([
        "ok", "layerCount", "isAdjustment", "is3D", "blendMode", "label",
        "layerState", "assetsList", "folderPath", "needsThumbnail",
        "width", "height", "pixelAspect", "frameRate", "duration",
        "renderComp", "renderFrame",
    ]),
    // 3.1 / 3.5 — verbatim refusal messages.
    protectiveAbortMessage:
        "Protective save failed " + EM_DASH + " aborted, your project is untouched.",
    unsavedProjectMessage: "Please save your project first!",
    // 3.3 — the manual-reopen instruction, and the comp engine's
    // restore-succeeded suffix.
    manualReopenSuffix:
        " " + EM_DASH + " automatic restore failed; please reopen your project manually from disk.",
    compRestoredSuffix:
        " " + EM_DASH + " project restored from the protective-save snapshot.",
    layerPreWindowPrefix: "Save Error: ",
    layerTargetSaveFailedPrefix: "Template save failed: ",
    // 3.19 — the footage relink ladder, in order.
    relinkLadder: Object.freeze(["exact-decoded", "raw", "case-insensitive", "extension-agnostic", "none"]),
    // 3.25 / 3.26 / 3.27 — thumbnail behaviour.
    // UPDATED IN TASK 18 — required by requirement 2.11 (F6c).
    // renderTemplateThumbnail widened from (aepPathHex, outPngPathHex) to
    // (aepPathHex, outPngPathHex, compNameHex, frameHex) so the recorded
    // renderComp / renderFrame target is actually rendered instead of discarded.
    // Both new arguments are OPTIONAL by design, which is why
    // legacyThumbTimeFraction stays 0.3 below and Case 17's genuine two-argument
    // call still renders at 30% of the work area, unchanged.
    thumbnailArity: 4,
    legacyThumbTimeFraction: 0.3,
    isValidPngMinBytes: 65,
    thumbnailAttempts: 3,
    // 3.14 — the assets-folder fallback, last rung.
    assetsFallbackFolder: "_Assets",
    // 3.29 — the migration guard fires once per engine session.
    migrationCallsPerSession: 1,
});

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

// The real, pure host utilities every sliced engine depends on. Sliced (not
// stubbed) so the engines run against the encoder/sanitizer/serializer they ship.
const CORE_PURE = sliceAll(CORE_SRC, [
    "trimStr", "cleanStr", "getSafeName", "escapeJSON", "jsonStringify",
    "encodeBridge", "decodeBridge", "isHexChar", "safeDecode", "fsEntryName",
    "generateTemplateId", "getDeterministicTemplateId", "normalizeSectionName",
    "ensureDeepFolder",
]);

// Duck-typed AE constructors (cross-realm `instanceof` via Symbol.hasInstance,
// the trick tests/helpers/loadHelpers.js uses for CompItem).
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
        TextLayer: duckCtor("textlayer"),
    };
}
function buildRealm(source, injected) {
    const ctx = Object.assign({ console: { log: function () { } } }, makeCtors(), injected || {});
    ctx.global = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "comp-pipeline-preservation-slice" });
    return ctx;
}

// `seq` is the ordered journal of every instrumented `app` call — the recording
// case 1 asserts. `undoAttempts` counts calls, `undoBegin` groups that opened.
function newCounters() {
    return {
        seq: [], saveCalls: [], openCalls: [], reduceCalls: 0, addCompCalls: 0,
        undoAttempts: 0, undoBegin: 0, undoEnd: 0, suppressBegin: 0, suppressEnd: 0,
    };
}

function createSaveApp(counters, opts) {
    opts = opts || {};
    const projectFile = { fsName: "C:/proj/live.aep" };
    const project = {
        file: opts.noProjectFile ? null : projectFile,
        numItems: 0,
        activeItem: null,
        item: function () { return null; },
        save: function (file) {
            const isProtective = file === projectFile;
            counters.seq.push(isProtective ? "save(PROTECTIVE)" : "save(TARGET)");
            counters.saveCalls.push(isProtective ? "PROTECTIVE" : String((file && file.fsName) || file));
            if (isProtective && opts.protectiveSaveThrows) throw new Error("disk full");
            if (!isProtective) {
                if (opts.targetSaveThrows) throw new Error("target save failed");
                // AE re-points app.project.file at the file just written.
                project.file = file;
            }
        },
        reduceProject: function () {
            counters.seq.push("reduceProject");
            counters.reduceCalls++;
            if (opts.reduceThrows) throw new Error("reduce failed");
        },
        items: {
            addComp: function (name, w, h, pa, dur, fps) {
                counters.seq.push("addComp");
                counters.addCompCalls++;
                if (opts.addCompThrows) throw new Error("addComp failed");
                return {
                    __kind: "comp", name: name, numLayers: 2,
                    width: w, height: h, pixelAspect: pa, duration: dur, frameRate: fps,
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
            counters.seq.push("beginUndoGroup");
            counters.undoAttempts++;
            if (opts.undoBeginThrows) throw new Error("beginUndoGroup failed");
            counters.undoBegin++;
        },
        endUndoGroup: function () { counters.seq.push("endUndoGroup"); counters.undoEnd++; },
        beginSuppressDialogs: function () { counters.seq.push("beginSuppressDialogs"); counters.suppressBegin++; },
        endSuppressDialogs: function () { counters.seq.push("endSuppressDialogs"); counters.suppressEnd++; },
        open: function (file) {
            counters.seq.push("open");
            counters.openCalls.push(String((file && file.fsName) || file));
            if (opts.openThrows) throw new Error("app.open failed: the project file is locked");
        },
    };
}

function createFileCtor(rootPath) {
    return function File(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", { get: function () { return false; }, configurable: true });
    };
}

// R3's non-buggy side requires an ABSOLUTE library root whose target folder
// ALREADY EXISTS before the destructive window. This disk models exactly that:
// the root and every descendant of it exist, so `ensureDeepFolder` finds the
// target on its first probe and `creates` stays empty for every generated name.
function createFolderCtor(rootPath, creates) {
    return function Folder(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return norm === rootPath || norm.indexOf(rootPath + "/") === 0; },
        });
        this.create = function () { creates.push(norm); return true; };
        this.getFiles = function () { return []; };
    };
}

function buildCompSaveRealm(opts) {
    opts = opts || {};
    const rootPath = opts.rootPath || "C:/lib";
    const counters = newCounters();
    const creates = [];
    const app = createSaveApp(counters, opts);
    // A LIVE (non-invalidating) comp reference: the design lists "saves whose
    // reopen succeeds" as a preserved class, i.e. the reference the result reads
    // is still usable. Reference invalidation is bug condition 1.1/1.2 and is
    // exercised by the task-1 exploration suite, never here.
    const precomp = Object.assign({
        __kind: "comp", name: "Source Precomp",
        remove: function () { this.__removed = true; },
    }, opts.geometry || {
        width: 1920, height: 1080, pixelAspect: 1, duration: 10,
        frameRate: 25, workAreaStart: 0, workAreaDuration: 10,
    });
    const ctx = buildRealm([CORE_PURE, sliceFn(SAVE_SRC, "saveActiveComp")].join("\n"), {
        app: app,
        File: createFileCtor(rootPath),
        Folder: createFolderCtor(rootPath, creates),
        resolveCompForSave: function () { return { ok: true, comp: precomp }; },
    });
    return {
        ctx: ctx, app: app, counters: counters, creates: creates, precomp: precomp,
        rootPath: rootPath,
        run: function (name, cat) {
            const e = ctx.encodeBridge;
            return ctx.decodeBridge(ctx.saveActiveComp(
                e(name === undefined ? "My Title" : name),
                e(cat === undefined ? "Titles" : cat),
                e(rootPath), e("")
            ));
        },
    };
}

function buildLayerSaveRealm(opts) {
    opts = opts || {};
    const rootPath = opts.rootPath || "C:/lib";
    const counters = newCounters();
    const creates = [];
    const app = createSaveApp(counters, opts);
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
    const comp = Object.assign({
        __kind: "comp", name: "Live Comp", selectedLayers: [layer],
        remove: function () { this.__removed = true; },
    }, opts.geometry || {
        width: 1920, height: 1080, pixelAspect: 1, duration: 5, frameRate: 30,
        workAreaStart: 0, workAreaDuration: 5,
    });
    app.project.activeItem = comp;
    const ctx = buildRealm([CORE_PURE, sliceFn(SAVE_SRC, "coreSaveLayerType")].join("\n"), {
        app: app,
        File: createFileCtor(rootPath),
        Folder: createFolderCtor(rootPath, creates),
        captureLayerState: function () { return { switches: { enabled: true }, markers: [] }; },
        copySelectedLayersToTempComp: function () {
            if (opts.copyThrows) throw new Error("copy exploded");
            return 2;
        },
    });
    return {
        ctx: ctx, app: app, counters: counters, creates: creates, comp: comp,
        rootPath: rootPath,
        run: function (section, name, cat) {
            return ctx.coreSaveLayerType(
                name === undefined ? "Name" : name,
                cat === undefined ? "Cat" : cat,
                rootPath, "Layer", "", section || "layer", "id1"
            );
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Project model for the import realms (mirrors the exploration suite).
// Every addFolder / remove / parentFolder mutation is recorded.
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
            enumerable: true, configurable: true,
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
        comp.layers = { add: function (src) { return insertLayer(comp, src.name, 1, src); } };
        comp.openInViewer = function () { return comp; };
        return comp;
    }

    function insertLayer(comp, name, atIndex, source) {
        const layer = {
            __kind: "avlayer", name: name, __uid: nextUid++,
            selected: false, startTime: 0, inPoint: 0, source: source || null,
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
    Object.defineProperty(project, "numItems", { get: function () { return all.length; } });

    return {
        project: project, rootFolder: rootFolder, mutations: mutations, all: all,
        makeItem: makeItem, addFolder: addFolder, makeComp: makeComp, insertLayer: insertLayer,
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
    "importLayerTypeAep", "toolkitOrganizeTemplateImport", "cleanupImportedItems",
    "csNormPath", "csIoKey", "csMakeIoError", "csReadFileTextOnce",
    "csEnumerateFolderOnce", "csLookupSeededMeta", "csReadTemplateMeta",
    "csImportIoBegin", "csImportIoEnd", "csImportIoOwn", "csImportIoRelease",
    "csExistingNamesOnce", "csResolveName",
]);

function buildImportRealm(cfg) {
    cfg = cfg || {};
    const model = createProjectModel();
    const counters = newCounters();
    const anchorLog = [];
    const guardDuringImport = [];
    const applyLayerStateCalls = [];
    const disk = cfg.disk || { folders: {}, texts: {}, reads: [], enums: [], parses: [] };
    const hires = {
        _t: 0,
        get hiresTimer() { const v = this._t; this._t = 0; return v; },
        add: function (us) { this._t += us; },
    };

    const app = {
        project: model.project,
        beginUndoGroup: function () {
            counters.seq.push("beginUndoGroup");
            counters.undoAttempts++;
            if (cfg.undoBeginThrows) throw new Error("beginUndoGroup failed");
            counters.undoBegin++;
        },
        endUndoGroup: function () { counters.seq.push("endUndoGroup"); counters.undoEnd++; },
        beginSuppressDialogs: function () { counters.seq.push("beginSuppressDialogs"); counters.suppressBegin++; },
        endSuppressDialogs: function () { counters.seq.push("endSuppressDialogs"); counters.suppressEnd++; },
    };

    const src = [
        CORE_PURE,
        IMPORT_PRELUDE,
        IMPORT_REAL,
        sliceAll(CORE_SRC, ["deselectAllLayers", "getTopSelectedLayer"]),
        sliceFn(SAVE_SRC, "placeLayerAtPlayhead"),
    ].join("\n");

    function DiskFile(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return Object.prototype.hasOwnProperty.call(disk.texts, norm); },
        });
        this.open = function () { if (disk.reads) disk.reads.push(norm); return true; };
        this.read = function () { return disk.texts[norm] || ""; };
        this.close = function () { };
    }
    function DiskFolder(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return Object.prototype.hasOwnProperty.call(disk.folders, norm); },
        });
        this.getFiles = function () {
            if (disk.enums) disk.enums.push(norm);
            const kids = disk.folders[norm];
            if (!kids) return [];
            return kids.map(function (k) { return new DiskFile(norm + "/" + k); });
        };
    }

    const ctx = buildRealm(src, {
        app: app,
        $: hires,
        File: cfg.realDisk ? DiskFile : function File(p) {
            this.fsName = String(p).replace(/\\/g, "/");
            this.name = this.fsName.split("/").pop();
            this.exists = true;
        },
        Folder: cfg.realDisk ? DiskFolder : function Folder(p) {
            this.fsName = String(p).replace(/\\/g, "/");
            this.exists = false;
            this.getFiles = function () { return []; };
        },
        ImportOptions: function ImportOptions(f) { this.file = f; },
        __anchorLog: anchorLog,
        jsonParse: function (s) { if (disk.parses) disk.parses.push(s); return JSON.parse(s); },
        getAllProjectNamesLower: function () { return {}; },
        safeRenameAllImportedItems: function () { },
        forceCompViewerRefresh: function () { },
        applyLayerState: function (layer, st) {
            applyLayerStateCalls.push({ layer: layer && layer.name, state: st });
        },
        unlockLayerForEdit: function () { return null; },
        restoreLayerState: function () { },
        copyLayersToComp: cfg.copyLayersToComp || function () { },
        resolveTemplateFiles: cfg.resolveTemplateFiles || function () {
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
    // anchor each template used is observable by identity.
    vm.runInContext(
        "var __realGetTop = getTopSelectedLayer;" +
        "getTopSelectedLayer = function (c) { var t = __realGetTop(c); __anchorLog.push(t); return t; };",
        ctx
    );

    return {
        ctx: ctx, app: app, model: model, counters: counters, disk: disk,
        anchorLog: anchorLog, guardDuringImport: guardDuringImport,
        applyLayerStateCalls: applyLayerStateCalls, hires: hires,
    };
}

// ─────────────────────────────────────────────────────────────
// Generators. Every arbitrary is constrained to the NON-BUGGY side of
// `isBugCondition`; the narrowing is documented where it matters.
// ─────────────────────────────────────────────────────────────

// Names drawn from letters, digits, "_" and "-" ONLY. No whitespace, so the
// host's getSafeName and js/core/pathBuilders' sanitizer agree (R4's
// hostSanitize <> panelSanitize clause stays false); no dots, so the result is
// never ".", ".." or a trailing-dot segment; never empty.
const NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
const arbSafeName = fc
    .array(fc.integer({ min: 0, max: NAME_CHARS.length - 1 }), { minLength: 1, maxLength: 40 })
    .map((idx) => idx.map((i) => NAME_CHARS[i]).join(""));
// Boundary names a fixed table would not reach: exactly 255 characters, and the
// shortest legal name.
const arbBoundaryName = fc.constantFrom(
    "x",
    new Array(255 + 1).join("A"),        // exactly 255 characters
    new Array(254 + 1).join("B") + "9",  // 254 + 1
    "a-b_c-1"
);
const arbName = fc.oneof(arbSafeName, arbBoundaryName);
const arbCategory = fc.oneof(arbSafeName, fc.constantFrom("Titles", "Lower-Thirds", "x"));

// Comp geometry, including the degenerate values the fixes must survive:
// frameRate 0 (renderFrame math divides/multiplies by it) and duration 0.
const arbGeometry = fc.record({
    width: fc.integer({ min: 1, max: 7680 }),
    height: fc.integer({ min: 1, max: 4320 }),
    pixelAspect: fc.constantFrom(1, 0.9, 1.5),
    duration: fc.constantFrom(0, 0.04, 5, 3600),
    frameRate: fc.constantFrom(0, 1, 23.976, 25, 30, 120),
    workAreaStart: fc.constantFrom(0, 1.5),
    workAreaDuration: fc.constantFrom(0, 1, 10),
});

// The layer-family sections coreSaveLayerType serves.
const arbLayerSection = fc.constantFrom("layer", "text", "footage");

// Absolute library roots only — a non-absolute root is R3's bug condition.
const arbAbsoluteRoot = fc.constantFrom("C:/lib", "C:/Users/x/My Library", "D:/AE/Lib");

// ============================================================
// CASE 1 — Reduce-first ordering (3.4)
// **Validates: Requirements 3.4**
//
// Non-buggy class: an absolute root whose target folder already exists, a name
// both sanitizers agree on, a live comp reference, a reopen that succeeds. The
// recorded `app` call sequence must be byte-identical after F1/F2/F11.
// ============================================================
describe("Case 1 — reduce-first ordering is the recorded sequence (3.4)", () => {
    test("saveActiveComp: beginUndoGroup -> PROTECTIVE -> reduce -> TARGET -> endUndoGroup -> suppress/open/suppress", () => {
        fc.assert(
            fc.property(arbName, arbCategory, arbGeometry, arbAbsoluteRoot, (name, cat, geometry, root) => {
                const h = buildCompSaveRealm({ geometry: geometry, rootPath: root });
                const reply = h.run(name, cat);
                const res = JSON.parse(reply);

                expect(h.counters.seq).toEqual(PRE_FIX_BASELINE.compSaveSequence);
                expect(h.counters.saveCalls.length).toBe(2);
                expect(h.counters.saveCalls[0]).toBe("PROTECTIVE");
                expect(h.counters.reduceCalls).toBe(1);
                expect(h.counters.openCalls).toEqual(["C:/proj/live.aep"]);
                expect(h.counters.undoBegin).toBe(1);
                expect(h.counters.undoEnd).toBe(1);
                expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                // The target folder already existed, so nothing was created.
                expect(h.creates).toEqual([]);

                // The success payload's recorded shape and derived values.
                expect(Object.keys(res)).toEqual(PRE_FIX_BASELINE.compSaveResultKeys.slice());
                expect(res.ok).toBe(true);
                expect(res.folderPath).toBe(root + "/comp/" + cat + "/" + name);
                expect(res.templateId).toBe(name);
                expect(res.needsThumbnail).toBe(true);
                expect(res.renderComp).toBe(name);
                expect(res.renderFrame).toBe(
                    Math.round((geometry.workAreaStart + geometry.workAreaDuration * 0.3) * geometry.frameRate)
                );
                expect(h.counters.saveCalls[1]).toBe(res.folderPath + "/project.aep");
            }),
            { numRuns: 60 }
        );
    });

    test("coreSaveLayerType: the same protocol with the temp comp built before the reduce", () => {
        fc.assert(
            fc.property(arbLayerSection, arbName, arbCategory, arbGeometry, arbAbsoluteRoot,
                (section, name, cat, geometry, root) => {
                    const h = buildLayerSaveRealm({ geometry: geometry, rootPath: root });
                    const out = h.run(section, name, cat);

                    expect(typeof out).toBe("object");
                    expect(h.counters.seq).toEqual(PRE_FIX_BASELINE.layerSaveSequence);
                    expect(h.counters.saveCalls.length).toBe(2);
                    expect(h.counters.reduceCalls).toBe(1);
                    expect(h.counters.addCompCalls).toBe(1);
                    expect(h.counters.openCalls).toEqual(["C:/proj/live.aep"]);
                    expect(h.counters.undoBegin).toBe(1);
                    expect(h.counters.undoEnd).toBe(1);
                    expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                    expect(h.creates).toEqual([]);

                    expect(Object.keys(out)).toEqual(PRE_FIX_BASELINE.layerSaveResultKeys.slice());
                    expect(out.ok).toBe(true);
                    expect(out.needsThumbnail).toBe(true);
                    expect(out.folderPath).toBe(root + "/" + section + "/" + cat + "/id1");
                    expect(out.renderComp).toBe(name);
                    expect(out.renderFrame).toBe(
                        Math.round((geometry.workAreaStart + geometry.workAreaDuration * 0.3) * geometry.frameRate)
                    );
                }),
            { numRuns: 60 }
        );
    });
});

// ============================================================
// CASE 2 — Protective-save abort (3.1)
// **Validates: Requirements 3.1**
// ============================================================
describe("Case 2 — a failed protective save aborts before any destructive op (3.1)", () => {
    test("both engines: zero reduces, zero reopens, undo balanced, verbatim message", () => {
        fc.assert(
            fc.property(arbName, arbCategory, arbLayerSection, arbAbsoluteRoot,
                (name, cat, section, root) => {
                    const c = buildCompSaveRealm({ protectiveSaveThrows: true, rootPath: root });
                    const compReply = c.run(name, cat);
                    expect(compReply.indexOf("Error:")).toBe(0);
                    expect(compReply).toContain(PRE_FIX_BASELINE.protectiveAbortMessage);
                    expect(c.counters.reduceCalls).toBe(0);
                    expect(c.counters.openCalls).toEqual([]);
                    expect(c.counters.undoEnd).toBe(c.counters.undoBegin);
                    expect(c.counters.undoBegin).toBe(1);
                    expect(c.counters.saveCalls).toEqual(["PROTECTIVE"]);
                    expect(c.counters.seq).toEqual(["beginUndoGroup", "save(PROTECTIVE)", "endUndoGroup"]);

                    const l = buildLayerSaveRealm({ protectiveSaveThrows: true, rootPath: root });
                    const layerOut = l.run(section, name, cat);
                    expect(typeof layerOut).toBe("string");
                    expect(layerOut).toBe(PRE_FIX_BASELINE.protectiveAbortMessage);
                    expect(l.counters.reduceCalls).toBe(0);
                    expect(l.counters.openCalls).toEqual([]);
                    expect(l.counters.undoEnd).toBe(l.counters.undoBegin);
                    expect(l.counters.addCompCalls).toBe(0);
                }),
            { numRuns: 40 }
        );
    });
});

// ============================================================
// CASE 3 — Reopen invariants (3.2, 3.3)
// **Validates: Requirements 3.2, 3.3**
//
// Observed nuance, recorded rather than assumed: the engines treat a THROWN
// `reduceProject` as a restorable window entry (both call their
// RESTORE_AND_RETURN handler), so "before reduceProject succeeds" splits into
// "before reduceProject is attempted" -> ZERO reopens and "reduceProject threw"
// -> exactly ONE. Never more than one, on any injection point.
//
// `openThrows` is only combined with a path that already returns a failure: a
// thrown reopen on the SUCCESS path is bug condition 1.5 and belongs to the
// task-1 exploration suite.
// ============================================================
const COMP_INJECTIONS = [
    { name: "protectiveSaveThrows", opts: { protectiveSaveThrows: true }, opens: 0, contains: PRE_FIX_BASELINE.protectiveAbortMessage },
    { name: "reduceThrows", opts: { reduceThrows: true }, opens: 1, contains: "Reduce failed:", suffix: PRE_FIX_BASELINE.compRestoredSuffix },
    { name: "reduceThrows+openThrows", opts: { reduceThrows: true, openThrows: true }, opens: 1, contains: "Reduce failed:", suffix: PRE_FIX_BASELINE.manualReopenSuffix },
    { name: "targetSaveThrows", opts: { targetSaveThrows: true }, opens: 1, contains: "Template save failed:", suffix: PRE_FIX_BASELINE.compRestoredSuffix },
    { name: "targetSaveThrows+openThrows", opts: { targetSaveThrows: true, openThrows: true }, opens: 1, contains: "Template save failed:", suffix: PRE_FIX_BASELINE.manualReopenSuffix },
];
const LAYER_INJECTIONS = [
    { name: "copyThrows (before reduce is attempted)", opts: { copyThrows: true }, opens: 0, prefix: PRE_FIX_BASELINE.layerPreWindowPrefix },
    { name: "protectiveSaveThrows", opts: { protectiveSaveThrows: true }, opens: 0, exact: PRE_FIX_BASELINE.protectiveAbortMessage },
    { name: "addCompThrows (before reduce is attempted)", opts: { addCompThrows: true }, opens: 0, prefix: PRE_FIX_BASELINE.layerPreWindowPrefix },
    { name: "reduceThrows", opts: { reduceThrows: true }, opens: 1, contains: "Reduce failed:" },
    { name: "targetSaveThrows", opts: { targetSaveThrows: true }, opens: 1, contains: PRE_FIX_BASELINE.layerTargetSaveFailedPrefix },
    { name: "targetSaveThrows+openThrows", opts: { targetSaveThrows: true, openThrows: true }, opens: 1, contains: PRE_FIX_BASELINE.layerTargetSaveFailedPrefix, suffix: PRE_FIX_BASELINE.manualReopenSuffix },
];

describe("Case 3 — reopen invariants over every failure-injection point (3.2, 3.3)", () => {
    test("saveActiveComp: zero reopens before the window, exactly one after, manual-reopen instruction on a failed restore", () => {
        fc.assert(
            fc.property(fc.constantFrom(...COMP_INJECTIONS), arbName, arbCategory, arbAbsoluteRoot,
                (inj, name, cat, root) => {
                    const h = buildCompSaveRealm(Object.assign({ rootPath: root }, inj.opts));
                    const reply = h.run(name, cat);
                    expect(h.counters.openCalls.length).toBe(inj.opens);
                    expect(h.counters.openCalls.length).toBeLessThanOrEqual(1);
                    expect(reply.indexOf("Error:")).toBe(0);
                    expect(reply).toContain(inj.contains);
                    if (inj.suffix) {
                        expect(reply.slice(-inj.suffix.length)).toBe(inj.suffix);
                    }
                    // The undo group is closed exactly once on every path.
                    expect(h.counters.undoEnd).toBe(1);
                    expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                }),
            { numRuns: 60 }
        );
    });

    test("coreSaveLayerType: the same invariants, with its own message conventions", () => {
        fc.assert(
            fc.property(fc.constantFrom(...LAYER_INJECTIONS), arbLayerSection, arbName, arbAbsoluteRoot,
                (inj, section, name, root) => {
                    const h = buildLayerSaveRealm(Object.assign({ rootPath: root }, inj.opts));
                    const out = h.run(section, name);
                    expect(typeof out).toBe("string");
                    expect(h.counters.openCalls.length).toBe(inj.opens);
                    if (inj.exact) expect(out).toBe(inj.exact);
                    if (inj.prefix) expect(out.indexOf(inj.prefix)).toBe(0);
                    if (inj.contains) expect(out).toContain(inj.contains);
                    if (inj.suffix) expect(out.slice(-inj.suffix.length)).toBe(inj.suffix);
                    expect(h.counters.undoEnd).toBe(1);
                    expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                }),
            { numRuns: 60 }
        );
    });
});

// ============================================================
// CASE 4 — Unsaved project (3.5)
// **Validates: Requirements 3.5**
// ============================================================
describe("Case 4 — an unsaved project is refused before anything is touched (3.5)", () => {
    test("every section: the verbatim refusal, zero saves / reduces / reopens / undo groups / folder creates", () => {
        fc.assert(
            fc.property(arbName, arbCategory, arbLayerSection, arbAbsoluteRoot,
                (name, cat, section, root) => {
                    const c = buildCompSaveRealm({ noProjectFile: true, rootPath: root });
                    const compReply = c.run(name, cat);
                    expect(compReply).toContain(PRE_FIX_BASELINE.unsavedProjectMessage);
                    expect(compReply.indexOf("Error:")).toBe(0);
                    expect(c.counters.saveCalls).toEqual([]);
                    expect(c.counters.reduceCalls).toBe(0);
                    expect(c.counters.openCalls).toEqual([]);
                    expect(c.counters.undoAttempts).toBe(0);
                    expect(c.counters.seq).toEqual([]);
                    expect(c.creates).toEqual([]);

                    const l = buildLayerSaveRealm({ noProjectFile: true, rootPath: root });
                    const layerOut = l.run(section, name, cat);
                    expect(layerOut).toBe(PRE_FIX_BASELINE.unsavedProjectMessage);
                    expect(l.counters.saveCalls).toEqual([]);
                    expect(l.counters.reduceCalls).toBe(0);
                    expect(l.counters.openCalls).toEqual([]);
                    expect(l.counters.undoAttempts).toBe(0);
                    expect(l.counters.seq).toEqual([]);
                    expect(l.creates).toEqual([]);
                }),
            { numRuns: 40 }
        );
    });
});

// ============================================================
// CASE 5 — Hex round-trip on BOTH implementations (3.6, 3.7, 3.29)
// **Validates: Requirements 3.6, 3.7, 3.29**
//
// Non-buggy class: WELL-FORMED payloads only. A malformed payload decoding to
// two different strings is bug condition 1.15 (R7) and belongs to the task-1
// exploration suite; here the payload is always the output of encodeBridge.
// ============================================================
const hostBridge = loadHelpers({
    file: path.join("jsx", "core.jsx"),
    injected: { app: {}, File: function () { }, Folder: function () { }, $: { hiresTimer: 0 } },
});

// BMP code units, including lone surrogates (0xD800-0xDFFF on their own).
const arbBmpString = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { minLength: 0, maxLength: 120 })
    .map((codes) => codes.map((c) => String.fromCharCode(c)).join(""));
// Curated real-world text: CJK, accents, emoji (full surrogate pairs), RTL.
const arbRealWorldString = fc
    .array(
        fc.constantFrom(
            "a", "Z", "0", " ", "\t", "\n", "\r", '"', "\\", "/",
            "é", "ü", "ñ", "ß", "ç",
            "日", "本", "語", "中", "文", "한", "글",
            "Ω", "π", "Я", "ب", "ع",
            "\uD83D\uDE00", "\uD83C\uDF08", "\uD83D\uDCC1",  // astral pairs
            "\u0000", "\u001f", "\u007f", "\uFFFD"
        ),
        { minLength: 0, maxLength: 80 }
    )
    .map((parts) => parts.join(""));

describe("Case 5 — hex round-trip is byte-for-byte on both implementations (3.6, 3.7, 3.29)", () => {
    const hostEncode = hostBridge.get("encodeBridge");
    const hostDecode = hostBridge.get("decodeBridge");

    test("decodeBridge(encodeBridge(s)) === s for generated CJK / accents / surrogates on both sides", () => {
        fc.assert(
            fc.property(fc.oneof(arbBmpString, arbRealWorldString), (s) => {
                const hostHex = hostEncode(s);
                const panelHex = panelBridge.encodeBridge(s);
                // The two encoders agree byte-for-byte...
                expect(panelHex).toBe(hostHex);
                // ...and every cross combination round-trips.
                expect(hostDecode(hostHex)).toBe(s);
                expect(panelBridge.decodeBridge(panelHex)).toBe(s);
                expect(hostDecode(panelHex)).toBe(s);
                expect(panelBridge.decodeBridge(hostHex)).toBe(s);
                // Well-formed by construction: 4 hex chars per code unit.
                expect(hostHex.length).toBe(s.length * 4);
            }),
            { numRuns: 200 }
        );
    });

    test("a payload larger than 1 MB crosses without truncation on both sides", () => {
        // 300k code units -> 1.2 MB of hex.
        const chunk = "Ω日本語-abc\uD83D\uDE00 ";
        let big = "";
        while (big.length < 300000) big += chunk;
        big = big.slice(0, 300000);

        const hostHex = hostEncode(big);
        expect(hostHex.length).toBe(1200000);
        expect(hostHex.length).toBeGreaterThan(1024 * 1024);
        expect(hostDecode(hostHex)).toBe(big);
        expect(panelBridge.decodeBridge(hostHex)).toBe(big);
        expect(panelBridge.encodeBridge(big)).toBe(hostHex);
    });

    test("the measured string-append encoding is preserved: no array + join in either codec", () => {
        const sources = [
            sliceFn(CORE_SRC, "encodeBridge"),
            sliceFn(CORE_SRC, "decodeBridge"),
            sliceFn(PANEL_BRIDGE_SRC, "encodeBridge"),
            sliceFn(PANEL_BRIDGE_SRC, "decodeBridge"),
        ];
        sources.forEach((src) => {
            expect(src.indexOf("join(")).toBe(-1);
            expect(/\bpush\s*\(/.test(src)).toBe(false);
        });
    });
});

// ─────────────────────────────────────────────────────────────
// Batch driver shared by cases 6, 7, 8 and 11.
// ─────────────────────────────────────────────────────────────
function makeBatchPayload(n, extra) {
    const templates = [];
    for (let i = 1; i <= n; i++) {
        templates.push(Object.assign({
            id: "t" + i, name: "T" + i, category: "Cat",
            section: "comp", sourcePath: "C:/lib",
        }, extra || {}));
    }
    return { rootPath: "C:/lib", templates: templates };
}

/**
 * Run the REAL importBatch over `n` templates.
 *  failPositions — 1-based positions whose importFile returns null ("Import failed!")
 *  emptyPositions — 1-based positions that import items but no comp ("No comp found!"),
 *                   i.e. a failure AFTER project items were created.
 */
function runRealBatch(n, failPositions, emptyPositions, cfg) {
    const h = buildImportRealm(cfg || {});
    const comp = h.model.makeComp("Active Comp");
    const preLayer = h.model.appendLayer(comp, "Pre-existing");
    h.model.project.activeItem = comp;
    const preExistingIds = h.model.itemIds();
    const createdByTemplate = {};
    let seq = 0;
    h.model.project.__importer = function () {
        seq++;
        h.counters.seq.push("importFile");
        if (failPositions.indexOf(seq) !== -1) return null;
        const folder = h.model.makeItem("folder", "T" + seq + " Folder");
        createdByTemplate[seq] = [folder.id];
        if (emptyPositions.indexOf(seq) !== -1) {
            const foot = h.model.makeItem("footage", "clip" + seq + ".mp4", folder);
            createdByTemplate[seq].push(foot.id);
            return folder;                      // footage but no comp
        }
        const c = h.model.makeComp("Template " + seq, folder);
        createdByTemplate[seq].push(c.id);
        return folder;
    };
    const raw = h.ctx.importBatch(h.ctx.encodeBridge(JSON.stringify(makeBatchPayload(n))));
    const result = JSON.parse(h.ctx.decodeBridge(raw));
    return { h, result, preExistingIds, preLayer, createdByTemplate, comp };
}

// ============================================================
// CASE 6 — Batch envelope (3.8, 3.9)
// **Validates: Requirements 3.8, 3.9**
// ============================================================
describe("Case 6 — one balanced undo group per batch, one per standalone import (3.8, 3.9)", () => {
    test("batches of 1-20 templates with arbitrary failure positions: undoBegin === undoEnd === 1", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 20 }).chain((n) =>
                    fc.record({
                        n: fc.constant(n),
                        fails: fc.uniqueArray(fc.integer({ min: 1, max: n }), { minLength: 0, maxLength: n }),
                    })
                ),
                ({ n, fails }) => {
                    const { h, result } = runRealBatch(n, fails, []);

                    // ONE host execution, ONE undo group, guaranteed close.
                    expect(h.counters.undoAttempts).toBe(1);
                    expect(h.counters.undoBegin).toBe(1);
                    expect(h.counters.undoEnd).toBe(1);
                    // The per-section routines are no-ops while the guard is on:
                    // no second beginUndoGroup for any of the N templates.
                    expect(h.counters.seq.filter((s) => s === "beginUndoGroup").length).toBe(1);
                    expect(h.counters.seq.filter((s) => s === "endUndoGroup").length).toBe(1);
                    expect(h.guardDuringImport.length).toBe(n);
                    expect(h.guardDuringImport.every((g) => g === true)).toBe(true);
                    // The guard is released after the batch.
                    expect(h.ctx.__CS_IMPORT_BATCH_ACTIVE).toBe(false);

                    // Statuses follow the injected failure positions exactly.
                    const expected = [];
                    for (let i = 1; i <= n; i++) expected.push(fails.indexOf(i) !== -1 ? "failed" : "imported");
                    expect(result.perTemplate.map((e) => e.status)).toEqual(expected);
                }
            ),
            { numRuns: 30 }
        );
    });

    test("a standalone importCompDirect opens and closes exactly one undo group", () => {
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        h.model.project.activeItem = comp;
        h.model.project.__importer = function () {
            const folder = h.model.makeItem("folder", "T Folder");
            h.model.makeComp("Template", folder);
            return folder;
        };
        const e = h.ctx.encodeBridge;
        const reply = h.ctx.decodeBridge(h.ctx.importCompDirect(e("T1"), e("Cat"), e("C:/lib"), "comp"));
        expect(reply).toBe("true");
        expect(h.counters.undoBegin).toBe(1);
        expect(h.counters.undoEnd).toBe(1);
        expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
    });
});

// ============================================================
// CASE 7 — Rollback scoping (3.10)
// **Validates: Requirements 3.10**
//
// The failing template imports items and THEN fails ("No comp found!"), so
// rollback has something to undo. F9's cleanup must not widen this.
// ============================================================
describe("Case 7 — a mid-batch failure removes only that template's additions (3.10)", () => {
    test("pre-existing items/layers and previously imported templates survive", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 3, max: 6 }).chain((n) =>
                    fc.record({ n: fc.constant(n), bad: fc.integer({ min: 2, max: n }) })
                ),
                ({ n, bad }) => {
                    const { h, result, preExistingIds, preLayer, createdByTemplate, comp } =
                        runRealBatch(n, [], [bad]);
                    const after = h.model.itemIds();

                    // Only the failed template is marked failed.
                    result.perTemplate.forEach((entry, i) => {
                        expect(entry.status).toBe(i + 1 === bad ? "failed" : "imported");
                    });
                    expect(result.perTemplate[bad - 1].reason).toBe("No comp found!");

                    // (a) every pre-existing project item survives
                    preExistingIds.forEach((id) => expect(after.indexOf(id)).not.toBe(-1));
                    // (b) the pre-existing layer survives
                    expect(comp.__layers.indexOf(preLayer)).not.toBe(-1);
                    // (c) every SUCCESSFUL template's items survive
                    Object.keys(createdByTemplate).forEach((k) => {
                        if (Number(k) === bad) return;
                        createdByTemplate[k].forEach((id) => expect(after.indexOf(id)).not.toBe(-1));
                    });
                    // (d) only the FAILED template's items are gone
                    createdByTemplate[bad].forEach((id) => expect(after.indexOf(id)).toBe(-1));
                    // (e) one layer per successful template, plus the pre-existing one
                    expect(comp.__layers.length).toBe(n - 1 + 1);
                }
            ),
            { numRuns: 30 }
        );
    });
});

// ============================================================
// CASE 8 — Result totality (3.11)
// **Validates: Requirements 3.11**
// ============================================================
describe("Case 8 — the batch result is total over the requested templates (3.11)", () => {
    test("host importBatch: all-success, all-failure and mixed all yield one entry per input in input order", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 12 }).chain((n) =>
                    fc.record({
                        n: fc.constant(n),
                        fails: fc.uniqueArray(fc.integer({ min: 1, max: n }), { minLength: 0, maxLength: n }),
                        empties: fc.uniqueArray(fc.integer({ min: 1, max: n }), { minLength: 0, maxLength: n }),
                    })
                ),
                ({ n, fails, empties }) => {
                    const onlyEmpties = empties.filter((p) => fails.indexOf(p) === -1);
                    const { result } = runRealBatch(n, fails, onlyEmpties);
                    expect(result.perTemplate.length).toBe(n);
                    const ids = [];
                    for (let i = 1; i <= n; i++) ids.push("t" + i);
                    expect(result.perTemplate.map((e) => e.id)).toEqual(ids);
                    result.perTemplate.forEach((e) => {
                        expect(e.status === "imported" || e.status === "failed").toBe(true);
                        if (e.status === "failed") expect(typeof e.reason).toBe("string");
                    });
                }
            ),
            { numRuns: 30 }
        );
    });

    test("a catastrophic mid-batch throw still returns one entry per input template", () => {
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        h.model.project.activeItem = comp;
        h.model.project.__importer = function () {
            const folder = h.model.makeItem("folder", "TF");
            h.model.makeComp("TC", folder);
            return folder;
        };
        // Blow up a read the per-template try does NOT cover, so the batch-level
        // catch is what has to keep the result total.
        let reads = 0;
        Object.defineProperty(h.hires, "hiresTimer", {
            configurable: true,
            get: function () { reads++; if (reads > 8) throw new Error("hires exploded"); return 0; },
        });
        const raw = h.ctx.importBatch(h.ctx.encodeBridge(JSON.stringify(makeBatchPayload(4))));
        const result = JSON.parse(h.ctx.decodeBridge(raw));

        expect(result.perTemplate.length).toBe(4);
        expect(result.perTemplate.map((e) => e.id)).toEqual(["t1", "t2", "t3", "t4"]);
        expect(result.perTemplate[result.perTemplate.length - 1].reason).toContain("Batch error:");
        expect(h.counters.undoBegin).toBe(1);
        expect(h.counters.undoEnd).toBe(1);
    });

    // Narrowing: the payloads below all decode to CONTROL-FREE text that is not
    // JSON. A payload that decodes to a C0 character (e.g. "00" -> U+0000) makes
    // the host embed that raw character in its own error document, which
    // escapeJSON does not escape — that is bug condition 1.16 (R7's
    // `NOT isValidJSON(jsonStringify(input))`) and belongs to the task-1 suite.
    test("a whole-call decode failure returns no per-template entries and an error, opening no undo group", () => {
        fc.assert(
            fc.property(fc.constantFrom("ZZZZ-not-hex", "", "zzzz", "0068", "00680065"), (badHex) => {
                const h = buildImportRealm({});
                const result = JSON.parse(h.ctx.decodeBridge(h.ctx.importBatch(badHex)));
                expect(result.perTemplate).toEqual([]);
                expect(typeof result.error).toBe("string");
                expect(result.error.length).toBeGreaterThan(0);
                expect(h.counters.undoBegin).toBe(0);
                expect(h.counters.undoEnd).toBe(0);
            }),
            { numRuns: 10 }
        );
    });

    test("the panel Import_Engine is total over the request on a decode failure and on a transport timeout", async () => {
        // (a) a host reply the panel cannot parse: every uncached template is
        //     reported failed, one entry each, in input order.
        // Narrowing: template ids are drawn from the safe-name class. An id that
        // collides with an Object.prototype member ("toString", "constructor", ...)
        // resolves through the prototype chain of the engine's plain-object result
        // map and produces a malformed entry — a latent quirk no bug condition in
        // this spec covers, so it is not part of the preserved surface.
        const arbTemplateId = arbSafeName.map((s) => "id-" + s);
        await fc.assert(
            fc.asyncProperty(
                fc.uniqueArray(arbTemplateId, { minLength: 1, maxLength: 10 }),
                fc.constantFrom("", "not json at all", "{ half", "true", "false"),
                async (ids, hostReply) => {
                    const templates = ids.map((id) => ({ id: id, section: "comp" }));
                    let result = null;
                    importTemplates(
                        {
                            callHost: (hex, cb) => cb(hostReply),
                            resolveCached: () => null,
                            encode: (s) => s,
                            decode: (s) => s,
                        },
                        { rootPath: "C:/lib", templates: templates },
                        (r) => { result = r; }
                    );
                    expect(result).not.toBeNull();
                    expect(result.perTemplate.length).toBe(templates.length);
                    expect(result.perTemplate.map((e) => e.id)).toEqual(ids.map(String));
                    result.perTemplate.forEach((e) => expect(e.status).toBe("failed"));
                }
            ),
            { numRuns: 40 }
        );

        // (b) a transport that never returns: the timeout-guarded callHost still
        //     settles, so the assembled result stays total.
        const never = { evalScript: function () { /* never invokes the callback */ } };
        const outcome = await panelBridge.callHost('importBatch("00")', { csInterface: never, timeoutMs: 20 });
        expect(outcome.ok).toBe(false);
        expect(outcome.timedOut).toBe(true);

        const templates = [{ id: "a" }, { id: "b" }, { id: "c" }];
        let timedOutResult = null;
        importTemplates(
            {
                callHost: function (hex, cb) {
                    panelBridge.callHost('importBatch("' + hex + '")', { csInterface: never, timeoutMs: 20 })
                        .then((r) => cb(r.ok ? r.result : ""));
                },
                resolveCached: () => null,
                encode: (s) => s,
                decode: (s) => s,
            },
            { rootPath: "C:/lib", templates: templates },
            (r) => { timedOutResult = r; }
        );
        await new Promise((r) => setTimeout(r, 120));
        expect(timedOutResult).not.toBeNull();
        expect(timedOutResult.perTemplate.length).toBe(3);
        expect(timedOutResult.perTemplate.map((e) => e.id)).toEqual(["a", "b", "c"]);
        timedOutResult.perTemplate.forEach((e) => expect(e.status).toBe("failed"));
    });

    test("parseHostBatchResult propagates a whole-call reason to every entry", () => {
        const parsed = parseHostBatchResult(JSON.stringify({ perTemplate: [], error: "boom" }));
        expect(parsed.map).toEqual({});
        let result = null;
        importTemplates(
            {
                callHost: (hex, cb) => cb(JSON.stringify({ perTemplate: [], error: "boom" })),
                resolveCached: () => null,
                encode: (s) => s,
                decode: (s) => s,
            },
            { rootPath: "C:/lib", templates: [{ id: "x" }, { id: "y" }] },
            (r) => { result = r; }
        );
        expect(result.perTemplate.length).toBe(2);
        result.perTemplate.forEach((e) => expect(e.status).toBe("failed"));
    });
});

// ============================================================
// CASE 9 — Cache-first metadata (3.12)
// **Validates: Requirements 3.12**
// ============================================================
describe("Case 9 — a seeded entry reads nothing; a miss reads and parses once per folder (3.12)", () => {
    function metaDisk(folders) {
        const disk = { folders: {}, texts: {}, reads: [], enums: [], parses: [] };
        folders.forEach((f) => {
            disk.folders[f.path] = ["meta.json"];
            disk.texts[f.path + "/meta.json"] = f.text;
        });
        return disk;
    }

    test("a Metadata_Cache-seeded folder costs zero reads and zero parses, however often it is asked", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 5 }),
                fc.integer({ min: 1, max: 4 }),
                (folderCount, lookups) => {
                    const folders = [];
                    for (let i = 0; i < folderCount; i++) {
                        folders.push({ path: "C:/lib/comp/Cat/T" + i, text: '{"name":"disk-' + i + '"}' });
                    }
                    const disk = metaDisk(folders);
                    const h = buildImportRealm({ realDisk: true, disk: disk });
                    const seeded = {};
                    folders.forEach((f, i) => { seeded[f.path] = { name: "seeded-" + i }; });

                    h.ctx.csImportIoBegin(seeded);
                    folders.forEach((f, i) => {
                        for (let k = 0; k < lookups; k++) {
                            const meta = h.ctx.csReadTemplateMeta(new h.ctx.Folder(f.path));
                            expect(meta).toEqual({ name: "seeded-" + i });
                        }
                    });
                    h.ctx.csImportIoEnd();

                    expect(disk.reads).toEqual([]);
                    expect(disk.parses).toEqual([]);
                }
            ),
            { numRuns: 30 }
        );
    });

    test("a cache miss reads meta.json exactly once and parses it exactly once per folder per import", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 5 }),
                fc.integer({ min: 1, max: 4 }),
                fc.boolean(),
                (folderCount, lookups, unparseable) => {
                    const folders = [];
                    for (let i = 0; i < folderCount; i++) {
                        folders.push({
                            path: "C:/lib/comp/Cat/T" + i,
                            text: unparseable ? "{not json" : '{"name":"disk-' + i + '"}',
                        });
                    }
                    const disk = metaDisk(folders);
                    const h = buildImportRealm({ realDisk: true, disk: disk });

                    h.ctx.csImportIoBegin({});
                    folders.forEach((f, i) => {
                        for (let k = 0; k < lookups; k++) {
                            const meta = h.ctx.csReadTemplateMeta(new h.ctx.Folder(f.path));
                            if (unparseable) expect(meta).toBe(null);
                            else expect(meta).toEqual({ name: "disk-" + i });
                        }
                    });
                    h.ctx.csImportIoEnd();

                    // Exactly one read and one parse per folder, regardless of how
                    // many times the metadata was asked for.
                    expect(disk.reads.length).toBe(folderCount);
                    expect(disk.parses.length).toBe(folderCount);
                    folders.forEach((f) => {
                        expect(disk.reads.filter((p) => p === f.path + "/meta.json").length).toBe(1);
                    });
                }
            ),
            { numRuns: 30 }
        );
    });

    test("csEnumerateFolderOnce enumerates a folder once per import and reuses the result", () => {
        const disk = { folders: { "C:/lib/comp/Cat/T/assets": ["a.png", "b.png"] }, texts: {}, reads: [], enums: [], parses: [] };
        const h = buildImportRealm({ realDisk: true, disk: disk });
        h.ctx.csImportIoBegin({});
        const folder = new h.ctx.Folder("C:/lib/comp/Cat/T/assets");
        const first = h.ctx.csEnumerateFolderOnce(folder, null);
        const second = h.ctx.csEnumerateFolderOnce(new h.ctx.Folder("C:/lib/comp/Cat/T/assets"), null);
        h.ctx.csImportIoEnd();
        expect(first.length).toBe(2);
        expect(second).toBe(first);
        expect(disk.enums.length).toBe(1);
    });
});

// ============================================================
// CASE 10 — Fallback ladder (3.13, 3.14)
// **Validates: Requirements 3.13, 3.14**
//
// Non-buggy class: folder contents where the ladder's choice does NOT depend on
// enumeration order. Two `*.aep` candidates with no `project.aep` is bug
// condition 1.25 (R11's `NOT deterministic(...)`) and belongs to the task-1
// exploration suite.
// ============================================================
describe("Case 10 — the documented fallback ladder and the degraded record (3.13, 3.14)", () => {
    function resolveWith(fileNames, metaText) {
        const folderPath = "C:/lib/comp/Cat/T1";
        function FileFake(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.fsName = norm;
            this.name = norm.split("/").pop();
            const self = this;
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () {
                    if (norm === folderPath + "/meta.json") return metaText !== null;
                    return norm.indexOf(folderPath + "/") === 0 && fileNames.indexOf(self.name) !== -1;
                },
            });
        }
        function FolderFake(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.fsName = norm;
            this.name = norm.split("/").pop();
            Object.defineProperty(this, "exists", {
                configurable: true, get: function () { return norm === folderPath; },
            });
            this.getFiles = function (mask) {
                if (!mask) return fileNames.map((n) => new FileFake(norm + "/" + n));
                const ext = String(mask).replace("*", "").toLowerCase();
                return fileNames
                    .filter((n) => n.toLowerCase().slice(-ext.length) === ext)
                    .map((n) => new FileFake(norm + "/" + n));
            };
        }
        const handle = loadHelpers({
            file: path.join("jsx", "core.jsx"),
            injected: { app: {}, File: FileFake, Folder: FolderFake, $: { hiresTimer: 0 } },
        });
        // csReadTemplateMeta lives in jsx/import.jsx; wire the real parser from
        // THIS realm so a missing/unparseable document behaves as in production.
        handle.context.csReadTemplateMeta = function () {
            if (metaText === null) return null;
            try { return handle.context.jsonParse(metaText); } catch (e) { return null; }
        };
        return handle.get("resolveTemplateFiles")("C:/lib", "Cat", "T1", "comp");
    }

    const IMG_ORDER = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"];

    // Scenarios, each unambiguous under the documented ladder.
    const arbLadderScenario = fc.oneof(
        // 1. meta.mainFile names a file that exists.
        fc.record({ rung: fc.constant("meta.mainFile"), extra: fc.constantFrom([], ["z.aep"], ["a.png"]) })
            .map(({ extra }) => ({
                files: ["chosen.aep", "project.aep", "meta.json"].concat(extra),
                meta: '{"mainFile":"chosen.aep"}',
                expected: "chosen.aep",
            })),
        // 2. no meta.mainFile at all -> the "project.aep" default, which exists.
        //    (A meta naming an ABSENT mainFile drops to the `*.aep` rung, where
        //    two candidates make the pick enumeration-order dependent — bug
        //    condition 1.25, excluded here and covered by the task-1 suite.)
        fc.constantFrom("{}", "{not json", null).map((meta) => ({
            files: ["project.aep", "extra.aep", "meta.json", "thumbnail.png"],
            meta: meta,
            expected: "project.aep",
        })),
        // 3. exactly one *.aep and no project.aep — reached either with no meta
        //    or with a meta naming a mainFile that is not on disk.
        fc.tuple(
            fc.constantFrom("only.aep", "Zed.aep", "a-b_c.aep"),
            fc.constantFrom("{}", '{"mainFile":"absent.aep"}', null)
        ).map(([n, meta]) => ({
            files: [n, "thumbnail.png", "meta.json"],
            meta: meta,
            expected: n,
        })),
        // 4. no *.aep, exactly one *.cseffect.
        fc.constantFrom("fx.cseffect", "My-Effect.cseffect").map((n) => ({
            files: [n], meta: null, expected: n,
        })),
        // 5. images: "source.*" preferred inside the winning extension group.
        fc.constantFrom("png", "jpg", "gif").map((ext) => ({
            files: ["zzz." + ext, "source." + ext, "aaa." + ext],
            meta: null,
            expected: "source." + ext,
        })),
        // 6. images: the extension order decides which group wins.
        fc.tuple(fc.constantFrom(0, 1, 2, 3), fc.constantFrom(4, 5, 6)).map(([lo, hi]) => ({
            files: ["b." + IMG_ORDER[hi], "a." + IMG_ORDER[lo]],
            meta: null,
            expected: "a." + IMG_ORDER[lo],
        })),
        // 7. an empty folder: the non-existent project.aep handle is returned.
        fc.constant({ files: [], meta: null, expected: "project.aep" })
    );

    test("the resolved file matches the ladder and is invariant under enumeration order", () => {
        fc.assert(
            fc.property(arbLadderScenario, fc.boolean(), (scenario, reversed) => {
                const files = reversed ? scenario.files.slice().reverse() : scenario.files.slice();
                const res = resolveWith(files, scenario.meta);
                expect(res).not.toBe(null);
                expect(res.mainFile.name).toBe(scenario.expected);
            }),
            { numRuns: 30 }
        );
    });

    test("a missing or unparseable meta.json still yields a degraded record, never null", () => {
        fc.assert(
            fc.property(fc.constantFrom(null, "{not json", "", "[]", "null"), (meta) => {
                const res = resolveWith(["project.aep", "meta.json"], meta);
                expect(res).not.toBe(null);
                expect(Object.keys(res)).toEqual(["folder", "meta", "mainFile", "assetsFolder"]);
                expect(res.folder.fsName).toBe("C:/lib/comp/Cat/T1");
                expect(res.mainFile.name).toBe("project.aep");
                // Last rung of the assets-folder fallback when none exists.
                expect(res.assetsFolder.fsName).toBe(
                    "C:/lib/comp/Cat/T1/" + PRE_FIX_BASELINE.assetsFallbackFolder
                );
            }),
            { numRuns: 10 }
        );
    });

    test("an absent template folder resolves to null (the caller's error path)", () => {
        const handle = loadHelpers({
            file: path.join("jsx", "core.jsx"),
            injected: {
                app: {},
                File: function () { this.exists = false; },
                Folder: function (p) { this.fsName = String(p); this.exists = false; this.getFiles = () => []; },
                $: { hiresTimer: 0 },
            },
        });
        handle.context.csReadTemplateMeta = () => null;
        expect(handle.get("resolveTemplateFiles")("C:/nope", "Cat", "T1", "comp")).toBe(null);
    });
});

// ============================================================
// CASE 11 — Suppression around importFile (3.15)
// **Validates: Requirements 3.15**
// ============================================================
describe("Case 11 — beginSuppressDialogs still brackets importFile on the success path (3.15)", () => {
    test("the recorded call order is begin -> importFile -> end, counters balanced, for every batch size", () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 8 }), (n) => {
                const { h, result } = runRealBatch(n, [], []);
                expect(result.perTemplate.every((e) => e.status === "imported")).toBe(true);

                // One bracketed importFile per template, in order.
                const relevant = h.counters.seq.filter(
                    (s) => s === "beginSuppressDialogs" || s === "importFile" || s === "endSuppressDialogs"
                );
                const expected = [];
                for (let i = 0; i < n; i++) {
                    expected.push("beginSuppressDialogs", "importFile", "endSuppressDialogs");
                }
                expect(relevant).toEqual(expected);
                expect(h.counters.suppressBegin).toBe(n);
                expect(h.counters.suppressEnd).toBe(n);
            }),
            { numRuns: 30 }
        );
    });
});

// ============================================================
// CASE 12 — Utility Pre-Comp (3.16)
// **Validates: Requirements 3.16**
// ============================================================
describe("Case 12 — a Utility Pre-Comp import places ONE reference layer, sweeps the wrappers, re-applies layerState (3.16)", () => {
    test("for any inner layer count and wrapper count the reference layer is the original pre-comp", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 4 }),   // layers inside the pre-comp
                fc.integer({ min: 1, max: 2 }),   // leftover wrapper comps
                fc.boolean(),                     // a selected anchor layer or not
                (innerLayers, wrappers, withAnchor) => {
                    const layerState = { switches: { enabled: true, shy: false, label: 7 }, markers: [{ t: 1 }] };
                    const h = buildImportRealm({
                        resolveTemplateFiles: function () {
                            return {
                                folder: { fsName: "C:/lib/layer/Cat/T", exists: true },
                                meta: { assetKind: "precomp", layerState: layerState },
                                mainFile: { fsName: "C:/lib/layer/Cat/T/project.aep", name: "project.aep", exists: true },
                                assetsFolder: { fsName: "C:/lib/layer/Cat/T/assets", exists: false },
                            };
                        },
                    });
                    const active = h.model.makeComp("Active Comp");
                    active.time = 4;
                    let anchor = null;
                    if (withAnchor) {
                        anchor = h.model.appendLayer(active, "UniqueAnchor");
                        anchor.selected = true;
                    }
                    h.model.project.activeItem = active;

                    let inner = null;
                    const wrapperComps = [];
                    h.model.project.__importer = function () {
                        const folder = h.model.makeItem("folder", "Imported");
                        inner = h.model.makeComp("Utility Pre-Comp", folder);
                        for (let i = 0; i < innerLayers; i++) h.model.insertLayer(inner, "inner-" + i, i + 1);
                        for (let w = 0; w < wrappers; w++) {
                            const wrap = h.model.makeComp("_CSPC_wrapper_" + w, folder);
                            h.model.insertLayer(wrap, "ref" + w, 1, inner);
                            wrapperComps.push(wrap);
                        }
                        return folder;
                    };

                    const e = h.ctx.encodeBridge;
                    const reply = h.ctx.decodeBridge(
                        h.ctx.importLayerTypeAep(e("T1"), e("Cat"), e("C:/lib"), "layer")
                    );

                    expect(reply).toBe("true");
                    // Exactly ONE layer was added, and it REFERENCES the original
                    // pre-comp (never flattened into copied layers).
                    const added = active.__layers.filter((l) => l.source === inner);
                    expect(added.length).toBe(1);
                    expect(active.__layers.length).toBe(withAnchor ? 2 : 1);
                    expect(added[0].source.numLayers).toBe(innerLayers);
                    // The leftover wrapper comps are gone; the pre-comp survives.
                    wrapperComps.forEach((w) => expect(w.__removed).toBe(true));
                    expect(inner.__removed).not.toBe(true);
                    // layerState is re-applied to the reference layer, once.
                    expect(h.applyLayerStateCalls.length).toBe(1);
                    expect(h.applyLayerStateCalls[0].state).toEqual(layerState);
                    expect(h.applyLayerStateCalls[0].layer).toBe(inner.name);
                    // Balance is untouched.
                    expect(h.counters.undoBegin).toBe(1);
                    expect(h.counters.undoEnd).toBe(1);
                    expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                }
            ),
            { numRuns: 30 }
        );
    });
});

// ============================================================
// CASE 13 — Timing math (3.17, 3.18)
// **Validates: Requirements 3.17, 3.18**
//
// Non-buggy class for the anchor: layer names are UNIQUE. Duplicate names make
// the by-name anchor scan ambiguous, which is bug condition 1.21.
// ============================================================
describe("Case 13 — a trimmed in-point lands on the captured playhead; a multi-layer import shifts by one delta (3.17, 3.18)", () => {
    test("placeLayerAtPlayhead: startTime === playhead - inPoint, and the layer lands above the selected anchor", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0, max: 600, noNaN: true }),
                fc.double({ min: 0, max: 60, noNaN: true }),
                fc.integer({ min: 1, max: 4 }),
                (playhead, inPoint, anchorDepth) => {
                    const h = buildImportRealm({});
                    const comp = h.model.makeComp("Active");
                    const names = [];
                    for (let i = 0; i < anchorDepth; i++) names.push("Layer-" + i);
                    const layers = names.map((n) => h.model.appendLayer(comp, n));
                    const anchor = layers[layers.length - 1];
                    anchor.selected = true;

                    const newLayer = h.model.insertLayer(comp, "Imported-Unique", 1);
                    newLayer.inPoint = inPoint;
                    h.ctx.placeLayerAtPlayhead(comp, newLayer, playhead, anchor);

                    expect(newLayer.startTime).toBeCloseTo(playhead - inPoint, 9);
                    // Placed directly above the anchor that was actually selected.
                    expect(newLayer.index).toBe(anchor.index - 1);
                    expect(newLayer.selected).toBe(true);
                }
            ),
            { numRuns: 60 }
        );
    });

    test("importLayerTypeAep: every copied layer moves by ONE uniform delta derived from the top layer", () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        inPoint: fc.double({ min: 0, max: 30, noNaN: true }),
                        startTime: fc.double({ min: -10, max: 30, noNaN: true }),
                    }),
                    { minLength: 2, maxLength: 6 }
                ),
                fc.double({ min: 0, max: 120, noNaN: true }),
                (specs, playhead) => {
                    const holder = {};
                    const h = buildImportRealm({
                        resolveTemplateFiles: function () {
                            return {
                                folder: { fsName: "C:/lib/layer/Cat/T", exists: true },
                                meta: {},
                                mainFile: { fsName: "C:/lib/layer/Cat/T/project.aep", name: "project.aep", exists: true },
                                assetsFolder: { fsName: "C:/lib/layer/Cat/T/assets", exists: false },
                            };
                        },
                        copyLayersToComp: function (layersArray, targetComp) {
                            // Insert so specs[0] ends up at index 1 (the top layer).
                            for (let i = specs.length - 1; i >= 0; i--) {
                                const l = holder.model.insertLayer(targetComp, "new-" + i, 1);
                                l.inPoint = specs[i].inPoint;
                                l.startTime = specs[i].startTime;
                            }
                        },
                    });
                    holder.model = h.model;
                    const active = h.model.makeComp("Active");
                    active.time = playhead;
                    h.model.project.activeItem = active;
                    h.model.project.__importer = function () {
                        const folder = h.model.makeItem("folder", "Imported");
                        const innerComp = h.model.makeComp("Inner", folder);
                        for (let i = 0; i < specs.length; i++) h.model.insertLayer(innerComp, "src-" + i, i + 1);
                        return folder;
                    };

                    const e = h.ctx.encodeBridge;
                    const reply = h.ctx.decodeBridge(
                        h.ctx.importLayerTypeAep(e("T1"), e("Cat"), e("C:/lib"), "layer")
                    );
                    expect(reply).toBe("true");
                    expect(active.__layers.length).toBe(specs.length);

                    const delta = (playhead - specs[0].inPoint) - specs[0].startTime;
                    active.__layers.forEach((l, i) => {
                        expect(l.startTime).toBeCloseTo(specs[i].startTime + delta, 6);
                        expect(l.selected).toBe(true);
                    });
                    // The top layer's trimmed in-point lands on the playhead.
                    expect(active.__layers[0].startTime + active.__layers[0].inPoint)
                        .toBeCloseTo(playhead, 6);
                }
            ),
            { numRuns: 40 }
        );
    });
});

// ============================================================
// CASE 14 — Relink ladder + name resolution (3.19, 3.20)
// **Validates: Requirements 3.19, 3.20**
// ============================================================
describe("Case 14 — the footage relink ladder order and csResolveName determinism (3.19, 3.20)", () => {
    function relinkProbe(assetNames, footageFileName, decodedName) {
        const replaced = [];
        const h = buildImportRealm({
            resolveTemplateFiles: function () {
                return {
                    folder: { fsName: "C:/lib/comp/Cat/T", exists: true },
                    meta: {},
                    mainFile: { fsName: "C:/lib/comp/Cat/T/project.aep", name: "project.aep", exists: true },
                    assetsFolder: { fsName: "C:/lib/comp/Cat/T/assets", exists: true },
                };
            },
        });
        // An asset file exists exactly when its basename is in assetNames.
        h.ctx.File = function File(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.fsName = norm;
            this.name = norm.split("/").pop();
            const self = this;
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () { return assetNames.indexOf(self.name) !== -1; },
            });
        };
        h.ctx.csEnumerateFolderOnce = function () {
            return assetNames.map((n) => new h.ctx.File("C:/lib/comp/Cat/T/assets/" + n));
        };
        h.ctx.fsEntryName = function () { return decodedName; };

        const active = h.model.makeComp("Active");
        h.model.project.activeItem = active;
        h.model.project.__importer = function () {
            const folder = h.model.makeItem("folder", "IF");
            h.model.makeComp("IC", folder);
            const foot = h.model.makeItem("footage", "logo", folder);
            foot.file = { fsName: "X:/orig/" + footageFileName, name: footageFileName };
            foot.replace = function (f) { replaced.push(f.name); };
            return folder;
        };
        const e = h.ctx.encodeBridge;
        const reply = h.ctx.decodeBridge(h.ctx.importCompDirect(e("T1"), e("Cat"), e("C:/lib"), "comp"));
        expect(reply).toBe("true");
        return replaced;
    }

    test("decoded name -> raw name -> case-insensitive -> extension-agnostic, in that order", () => {
        fc.assert(
            fc.property(arbSafeName, fc.constantFrom("png", "jpg", "mov"), (stem, ext) => {
                const decoded = stem + "." + ext;
                const raw = stem + "-raw." + ext;

                // rung 1 — the exact decoded name wins over every other candidate
                expect(relinkProbe([decoded, decoded.toUpperCase(), raw, stem + ".tif"], raw, decoded))
                    .toEqual([decoded]);
                // rung 2 — decoded absent, the raw file name is tried next
                expect(relinkProbe([raw], raw, decoded)).toEqual([raw]);
                // rung 3 — neither exact name present, a case-differing match is used
                expect(relinkProbe([decoded.toUpperCase()], "absent." + ext, decoded))
                    .toEqual([decoded.toUpperCase()]);
                // rung 4 — extension-agnostic match on the stem
                expect(relinkProbe([stem + ".tiff"], "absent." + ext, decoded))
                    .toEqual([stem + ".tiff"]);
                // no rung matches — nothing is relinked, the import still succeeds
                expect(relinkProbe(["totally-different.bin"], "absent." + ext, decoded)).toEqual([]);
            }),
            { numRuns: 12 }
        );
    });

    test("csResolveName is deterministic and collision-free, over a name set computed once per import", () => {
        fc.assert(
            fc.property(
                arbSafeName,
                fc.boolean(),
                fc.uniqueArray(arbSafeName, { minLength: 0, maxLength: 6 }),
                (rawName, isComp, taken) => {
                    const h = buildImportRealm({});
                    const used = {};
                    taken.forEach((t) => { used[t.toLowerCase()] = true; });
                    // Snapshot the set as it ACTUALLY is, rather than assuming
                    // one key per generated name. `taken` is unique under `===`
                    // but `used` is keyed lowercased, so a generated set such as
                    // ["D","d"] is two names and one key — comparing against
                    // taken.length made this case seed-dependent. The snapshot
                    // asserts the same thing (csResolveName mutated nothing)
                    // without dropping case-differing sets from the input space.
                    const usedKeysBefore = Object.keys(used).sort();

                    const first = h.ctx.csResolveName(rawName, isComp, used);
                    const second = h.ctx.csResolveName(rawName, isComp, used);
                    // Identical input -> identical output.
                    expect(second).toBe(first);
                    // Collision-free against the supplied set.
                    expect(used[first.toLowerCase()]).toBeUndefined();
                    // Pure: the set was not mutated.
                    expect(Object.keys(used).sort()).toEqual(usedKeysBefore);

                    // The existing-name set is computed ONCE per import and the
                    // SAME object is handed back for the rest of it.
                    let computed = 0;
                    h.ctx.getAllProjectNamesLower = function () { computed++; return { seed: true }; };
                    h.ctx.csImportIoBegin({});
                    const setA = h.ctx.csExistingNamesOnce();
                    const setB = h.ctx.csExistingNamesOnce();
                    h.ctx.csImportIoEnd();
                    expect(computed).toBe(1);
                    expect(setB).toBe(setA);
                }
            ),
            { numRuns: 40 }
        );
    });
});

// ============================================================
// CASE 15 — Save controller (3.21, 3.22)
// **Validates: Requirements 3.21, 3.22**
// ============================================================
describe("Case 15 — exitLoading fires exactly once before any background scheduling (3.21, 3.22)", () => {
    const arbEssentialOutcome = fc.oneof(
        fc.constant({ ok: true, result: JSON.stringify({ ok: true, folderPath: "C:/lib/comp/C/T", needsThumbnail: true }) }),
        fc.constant({ ok: true, result: "true" }),
        fc.string({ minLength: 1, maxLength: 12 }).map((e) => ({ ok: false, error: e })),
        fc.constant({ ok: false, timedOut: true }),
        fc.constant({ ok: true, result: "" }),
        fc.constant({ ok: true, result: "false" }),
        // F1/F2's reopen-failure string must classify as an ESSENTIAL failure:
        // the panel's existing bare-error branch already does that today.
        fc.constant({
            ok: true,
            result: "Error: [start] -> Template save failed: Error: x " + EM_DASH +
                " automatic restore failed; please reopen your project manually from disk.",
        })
    );
    const arbBackground = fc.constantFrom("none", "settle", "failThenSettle", "neverSettle", "throw");

    test("for any essential outcome and any background scenario the loading exit is invariant", async () => {
        await fc.assert(
            fc.asyncProperty(arbEssentialOutcome, arbBackground, async (outcome, bg) => {
                const order = [];
                let exits = 0, schedules = 0, bgActivity = 0;
                const errors = [];
                const deps = {
                    callHost: () => outcome,
                    exitLoading: () => { exits++; order.push("exit"); },
                    setError: (m) => errors.push(m),
                    setBackgroundError: () => { },
                    onEssentialSuccess: () => { },
                    showBackgroundActivity: () => { bgActivity++; },
                    hideBackgroundActivity: () => { },
                };
                if (bg !== "none") {
                    deps.scheduleBackground = function (result, hooks) {
                        schedules++;
                        order.push("schedule");
                        if (bg === "settle") hooks.onAllSettled();
                        if (bg === "failThenSettle") {
                            hooks.onWorkFailed("thumbnail", new Error("render failed"));
                            hooks.onAllSettled();
                        }
                        if (bg === "throw") throw new Error("scheduling blew up");
                    };
                }
                const state = await runSaveController(deps, { scriptCall: "saveActiveComp(\"00\")" });
                const parsed = defaultParseEssential(outcome.ok ? outcome.result : null);
                const succeeded = !!(outcome.ok && parsed && parsed.ok);

                expect(state.loadingExited).toBe(true);
                expect(exits).toBe(1);
                expect(order.indexOf("exit")).toBe(0);   // before any scheduling
                if (succeeded) {
                    expect(state.essentialOk).toBe(true);
                    if (bg !== "none") expect(schedules).toBe(1);
                } else {
                    expect(state.essentialOk).toBe(false);
                    expect(typeof state.essentialError).toBe("string");
                    expect(errors.length).toBeGreaterThanOrEqual(1);
                    expect(schedules).toBe(0);      // no background work on essential failure
                    expect(bgActivity).toBe(0);
                    expect(state.essentialResult).toBeNull();
                }
            }),
            { numRuns: 80 }
        );
    });
});

// ============================================================
// CASE 16 — Optimistic card (3.23)
// **Validates: Requirements 3.23**
// ============================================================
describe("Case 16 — re-saving a template replaces one entry at the head instead of duplicating (3.23)", () => {
    const arbFolderPath = fc
        .array(fc.constantFrom("lib", "comp", "Titles", "T1", "T2", "Cat"), { minLength: 2, maxLength: 5 })
        .map((parts) => "C:/" + parts.join("/"));

    test("insertAtHead is idempotent in count and always leaves the re-saved entry first", () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(arbFolderPath, { minLength: 1, maxLength: 8 }),
                fc.integer({ min: 0, max: 7 }),
                (paths, pick) => {
                    const idx = new LibraryIndex({ validityKey: "k" });
                    paths.forEach((p, i) => {
                        expect(idx.insertAtHead({ folderPath: p, name: "n" + i, category: "c" })).toBe(true);
                    });
                    const before = idx.entries().map((e) => e.folderPath);
                    expect(before.length).toBe(paths.length);

                    const target = paths[pick % paths.length];
                    expect(idx.insertAtHead({ folderPath: target, name: "re-saved", category: "c" })).toBe(true);
                    const after = idx.entries().map((e) => e.folderPath);

                    // No duplicate, same count, the re-saved entry at the head.
                    expect(after.length).toBe(before.length);
                    expect(after[0]).toBe(normalizeFolderPath(target));
                    expect(after.filter((p) => p === normalizeFolderPath(target)).length).toBe(1);
                    // The other entries keep their relative order.
                    const others = after.slice(1);
                    const expectedOthers = before.filter((p) => p !== normalizeFolderPath(target));
                    expect(others).toEqual(expectedOthers);
                    // Replacing in place is not a failed update: no rescan flagged.
                    expect(idx.needsFullScan()).toBe(false);
                    expect(idx.entries()[0].name).toBe("re-saved");
                }
            ),
            { numRuns: 60 }
        );
    });
});

// ============================================================
// CASE 17 — Thumbnail behaviour (3.24, 3.25, 3.26, 3.27)
// **Validates: Requirements 3.24, 3.25, 3.26, 3.27**
// ============================================================
describe("Case 17 — thumbnail rendering stays non-destructive, aerender-first and strict about PNGs (3.24-3.27)", () => {
    // ── 3.27 — renderTemplateThumbnail never touches the live project ──
    function runThumbnail(cfg) {
        const touched = [];
        const rendered = [];
        const removed = [];
        let depth = cfg.startDepth;
        const importedFolder = { __kind: "folder", name: "scratch", remove() { removed.push("importedFolder"); } };
        const srcComp = {
            __kind: "comp", name: "Src Comp",
            width: cfg.width, height: 1080, pixelAspect: 1,
            duration: 10, frameRate: 25,
            workAreaStart: cfg.workAreaStart, workAreaDuration: cfg.workAreaDuration,
        };
        let wrapper = null;
        const project = {
            get bitsPerChannel() { return depth; },
            set bitsPerChannel(v) { touched.push("bitsPerChannel=" + v); depth = v; },
            get file() { touched.push("READ app.project.file"); return { fsName: "C:/live.aep" }; },
            set file(v) { touched.push("WRITE app.project.file"); },
            importFile: function () {
                if (cfg.importThrows) throw new Error("import blew up");
                return importedFolder;
            },
            reduceProject: function () { touched.push("reduceProject"); },
            items: {
                addComp: function (name, w, h, pa, dur, fps) {
                    wrapper = {
                        __kind: "comp", name: name, width: w, height: h,
                        pixelAspect: pa, duration: dur, frameRate: fps,
                        workAreaStart: 0, workAreaDuration: 0,
                        layers: {
                            add: function () {
                                return {
                                    property: function () {
                                        return { property: function () { return { setValue: function () { } }; } };
                                    },
                                };
                            },
                        },
                        remove: function () { removed.push("wrapper"); },
                    };
                    return wrapper;
                },
            },
        };
        const app = {
            project: project,
            open: function () { touched.push("app.open"); },
            beginSuppressDialogs: function () { touched.push("beginSuppressDialogs"); },
            endSuppressDialogs: function () { touched.push("endSuppressDialogs"); },
        };
        const ctx = buildRealm([CORE_PURE, sliceFn(SAVE_SRC, "renderTemplateThumbnail")].join("\n"), {
            app: app,
            File: function File(p) {
                this.fsName = String(p).replace(/\\/g, "/");
                this.name = this.fsName.split("/").pop();
                this.exists = true;
            },
            ImportOptions: function (f) { this.file = f; },
            findCompItemInFolder: function () { return srcComp; },
            renderFrameToPng: function (comp, time) {
                rendered.push({ comp: comp.name, time: time });
                return cfg.renderOk ? { success: true } : { success: false, error: "no valid PNG" };
            },
        });
        const e = ctx.encodeBridge;
        const reply = ctx.decodeBridge(ctx.renderTemplateThumbnail(
            e("C:/lib/comp/Cat/T/project.aep"), e("C:/lib/comp/Cat/T/thumbnail.png")
        ));
        return { reply, touched, rendered, removed, depth, srcComp, wrapper, arity: ctx.renderTemplateThumbnail.length };
    }

    test("(3.27) no app.project.file access, no app.open, no reduce, and the scratch import is always removed", () => {
        fc.assert(
            fc.property(
                fc.constantFrom(120, 320, 321, 1920, 3840),   // below / at / above the 320px bound
                fc.boolean(),                                 // render succeeds or fails
                fc.constantFrom(8, 16, 32),                    // project bit depth to restore
                fc.constantFrom(0, 1.5),                       // workAreaStart
                fc.constantFrom(0, 4, 10),                     // workAreaDuration
                (width, renderOk, startDepth, workAreaStart, workAreaDuration) => {
                    const r = runThumbnail({
                        width, renderOk, startDepth, workAreaStart, workAreaDuration,
                    });

                    // The live project is never touched.
                    expect(r.touched.indexOf("app.open")).toBe(-1);
                    expect(r.touched.indexOf("READ app.project.file")).toBe(-1);
                    expect(r.touched.indexOf("WRITE app.project.file")).toBe(-1);
                    expect(r.touched.indexOf("reduceProject")).toBe(-1);
                    // Dialog suppression is balanced and the depth is restored.
                    expect(r.touched.filter((t) => t === "beginSuppressDialogs").length).toBe(1);
                    expect(r.touched.filter((t) => t === "endSuppressDialogs").length).toBe(1);
                    expect(r.depth).toBe(startDepth);
                    // The scratch import (and the wrapper, when one was built) is gone.
                    expect(r.removed.indexOf("importedFolder")).not.toBe(-1);
                    if (width > 320) {
                        expect(r.wrapper).not.toBe(null);
                        expect(r.wrapper.width).toBe(320);
                        expect(r.removed.indexOf("wrapper")).not.toBe(-1);
                    } else {
                        expect(r.wrapper).toBe(null);
                    }
                    // The legacy 2-argument signature and the 30%-of-work-area rule.
                    expect(r.arity).toBe(PRE_FIX_BASELINE.thumbnailArity);
                    expect(r.rendered.length).toBe(1);
                    expect(r.rendered[0].time).toBeCloseTo(
                        workAreaStart + workAreaDuration * PRE_FIX_BASELINE.legacyThumbTimeFraction, 9
                    );
                    // The reply mirrors the render result, never a false success.
                    expect(JSON.parse(r.reply).ok).toBe(renderOk);
                }
            ),
            { numRuns: 40 }
        );
    });

    test("(3.26) a missing, empty or sub-64-byte PNG is a failure, never a false success", () => {
        const helpers = loadHelpers({
            file: path.join("jsx", "helpers.jsx"),
            injected: { app: aeFakes.createAppFake({}) },
        });
        const isValidPng = helpers.get("isValidPng");
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 200 }), fc.boolean(), (length, exists) => {
                const verdict = isValidPng(aeFakes.createFileFake({ exists: exists, length: length }));
                expect(verdict).toBe(exists && length >= PRE_FIX_BASELINE.isValidPngMinBytes);
            }),
            { numRuns: 60 }
        );
        expect(isValidPng(null)).toBe(false);
        expect(isValidPng(undefined)).toBe(false);
        expect(isValidPng({ exists: true, length: 64 })).toBe(false);
        expect(isValidPng({ exists: true, length: 65 })).toBe(true);
    });

    test("(3.26) renderFrameToPng reports failure on a thrown render and keeps suppression balanced", () => {
        const recorder = aeFakes.createRecorder();
        const app = aeFakes.createAppFake({ recorder: recorder });
        const helpers = loadHelpers({ file: path.join("jsx", "helpers.jsx"), injected: { app: app } });
        const renderFrameToPng = helpers.get("renderFrameToPng");

        const throwing = aeFakes.createCompFake({ time: 0 });
        throwing.saveFrameToPng = function () { throw new Error("render failed"); };
        const res = renderFrameToPng(throwing, 1, aeFakes.createFileFake({ exists: false, length: 0 }));
        expect(res.success).toBe(false);
        expect(typeof res.error).toBe("string");
        expect(app.suppressDepth()).toBe(0);

        const ok = aeFakes.createCompFake({ time: 0 });
        ok.saveFrameToPng = function () { };
        const res2 = renderFrameToPng(ok, 1, aeFakes.createFileFake({ exists: true, length: 4096 }));
        expect(res2.success).toBe(true);
        expect(app.suppressDepth()).toBe(0);
    });

    // ── 3.25 — the isolated aerender path is still preferred ──
    function makeTextAnim(aerenderBehaviour) {
        const evalCalls = [];
        const aerenderCalls = [];
        const injected = {
            console: { log: function () { } },
            csInterface: {
                evalScript: function (jsx, cb) { evalCalls.push(jsx); if (cb) cb(""); },
                getSystemPath: function () { return "/ext"; },
            },
            SystemPath: { EXTENSION: "EXTENSION" },
            encodeBridge: function (s) { return String(s); },
            decodeBridge: function (s) { return String(s); },
            resolveFfmpeg: function (cb) { cb("ffmpeg"); },
            markFolderBusy: function () { },
            clearFolderBusy: function () { },
            showToast: function () { },
            refreshFromDisk: function () { },
            loadTemplatesDebounced: function () { },
            require: function (name) {
                if (name === "child_process") {
                    return { execFile: function () { const cb = arguments[arguments.length - 1]; if (cb) cb(null, "", ""); } };
                }
                if (name === "fs") {
                    return {
                        mkdirSync() { }, readdirSync() { return []; },
                        statSync() { return { isFile: function () { return true; } }; },
                        existsSync() { return false; }, unlinkSync() { }, rmdirSync() { },
                        readFileSync() { return "{}"; }, writeFileSync() { },
                    };
                }
                if (name === "os") return { tmpdir: function () { return "/tmp"; } };
                if (name === "path") {
                    return {
                        join: function () { return Array.prototype.slice.call(arguments).join("/"); },
                        dirname: function (p) { return String(p).replace(/\/[^/]*$/, ""); },
                    };
                }
                return null;
            },
            setTimeout: function () { return global.setTimeout.apply(global, arguments); },
            clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
            setInterval: function () { return global.setInterval.apply(global, arguments); },
            clearInterval: function () { return global.clearInterval.apply(global, arguments); },
        };
        if (aerenderBehaviour) {
            injected.AerenderRunner = {
                renderThumbnail: function (opts, cb) { aerenderCalls.push(opts); aerenderBehaviour(opts, cb); },
            };
        }
        const handle = loadHelpers({
            file: path.join("js", "textanim", "textanim.js"),
            injected: injected, lenient: false,
        });
        if (handle.error) throw handle.error;
        return { TextAnim: handle.get("TextAnim"), evalCalls: evalCalls, aerenderCalls: aerenderCalls };
    }

    test("(3.25) aerender is preferred when a comp name is known, and every failure falls back in-project", async () => {
        // (a) comp name present + aerender available -> aerender only, no host call.
        const okRun = makeTextAnim(function (opts, cb) { cb({ ok: true, durationMs: 3 }); });
        await new Promise((resolve) => {
            okRun.TextAnim.enqueueThumbnailRender(
                "/lib/t/project.aep", "/lib/t/thumbnail.png",
                function (err) {
                    expect(err).toBe(null);
                    expect(okRun.aerenderCalls.length).toBe(1);
                    expect(okRun.aerenderCalls[0]).toEqual({
                        aepPath: "/lib/t/project.aep",
                        compName: "Recorded Comp",
                        frame: 42,
                        outPngPath: "/lib/t/thumbnail.png",
                    });
                    expect(okRun.evalCalls).toEqual([]);
                    resolve();
                },
                "Recorded Comp", 42
            );
        });

        // (b) aerender fails -> the in-project renderer is used as the fallback.
        const failRun = makeTextAnim(function (opts, cb) { cb({ ok: false, error: "no binary" }); });
        await new Promise((resolve) => {
            failRun.TextAnim.enqueueThumbnailRender(
                "/lib/t/project.aep", "/lib/t/thumbnail.png",
                function (err) {
                    expect(typeof err).toBe("string");
                    expect(failRun.aerenderCalls.length).toBe(PRE_FIX_BASELINE.thumbnailAttempts);
                    expect(failRun.evalCalls.length).toBe(PRE_FIX_BASELINE.thumbnailAttempts);
                    failRun.evalCalls.forEach((jsx) => {
                        expect(jsx.indexOf("renderTemplateThumbnail(")).toBe(0);
                    });
                    resolve();
                },
                "Recorded Comp", 42
            );
        });

        // (c) no comp name -> aerender is skipped entirely.
        const noNameRun = makeTextAnim(function (opts, cb) { cb({ ok: true }); });
        await new Promise((resolve) => {
            noNameRun.TextAnim.enqueueThumbnailRender(
                "/lib/t/project.aep", "/lib/t/thumbnail.png",
                function () {
                    expect(noNameRun.aerenderCalls).toEqual([]);
                    expect(noNameRun.evalCalls.length).toBe(PRE_FIX_BASELINE.thumbnailAttempts);
                    resolve();
                },
                null, 0
            );
        });
    });

    test("(3.24) a failed thumbnail badges exactly one card and leaves every other placeholder intact", () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 2, maxLength: 8 }),
                fc.integer({ min: 0, max: 7 }),
                (ids, pick) => {
                    const idx = new LibraryIndex({ validityKey: "k" });
                    const paths = ids.map((n) => "C:/lib/comp/Cat/T" + n);
                    paths.forEach((p, i) => idx.insertAtHead({ folderPath: p, name: "n" + i }));
                    // Every fresh entry starts on the placeholder artwork.
                    idx.entries().forEach((e) => expect(e.thumbStatus).toBe(LIBRARY_THUMB_PLACEHOLDER));

                    const target = normalizeFolderPath(paths[pick % paths.length]);
                    const before = idx.entries().map((e) => e.folderPath);
                    expect(idx.patchEntry(target, { thumbStatus: "failed", needsRegen: true })).toBe(true);
                    const after = idx.entries();

                    // Order and membership are unchanged: the entry is retained.
                    expect(after.map((e) => e.folderPath)).toEqual(before);
                    after.forEach((e) => {
                        if (e.folderPath === target) {
                            expect(e.thumbStatus).toBe("failed");
                            expect(e.needsRegen).toBe(true);
                        } else {
                            expect(e.thumbStatus).toBe(LIBRARY_THUMB_PLACEHOLDER);
                            expect(e.needsRegen).toBeUndefined();
                        }
                    });
                    expect(after.filter((e) => e.thumbStatus === "failed").length).toBe(1);
                    expect(idx.needsFullScan()).toBe(false);
                }
            ),
            { numRuns: 40 }
        );
    });
});

// ============================================================
// CASE 18 — Strict host parsing (3.28)
// **Validates: Requirements 3.28**
// ============================================================
describe("Case 18 — jsonParse remains the only host parser (3.28)", () => {
    const JSX_FILES = fs.readdirSync(path.join(ROOT, "jsx")).filter((f) => /\.jsx$/.test(f));

    // Strip line comments and block comments so a mention inside a comment is
    // never mistaken for a call.
    function codeOnly(src) {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split(/\r?\n/)
            .map((line) => line.replace(/\/\/.*$/, ""))
            .join("\n");
    }

    test("no jsx file calls eval(", () => {
        expect(JSX_FILES.length).toBeGreaterThan(0);
        JSX_FILES.forEach((f) => {
            const code = codeOnly(readSrc("jsx/" + f));
            expect(/(^|[^.\w])eval\s*\(/.test(code)).toBe(false);
        });
    });

    test("every JSON.parse in jsx/ sits behind the documented `typeof jsonParse === \"function\"` harness guard", () => {
        const unguarded = [];
        JSX_FILES.forEach((f) => {
            codeOnly(readSrc("jsx/" + f)).split(/\r?\n/).forEach((line, i) => {
                if (line.indexOf("JSON.parse") === -1) return;
                if (/typeof\s+jsonParse\s*===\s*"function"/.test(line)) return;
                unguarded.push(f + ":" + (i + 1) + " " + line.trim());
            });
        });
        expect(unguarded).toEqual([]);
    });

    test("no jsx file calls JSON.stringify, and jsonParse / jsonStringify are each defined exactly once", () => {
        JSX_FILES.forEach((f) => {
            expect(codeOnly(readSrc("jsx/" + f)).indexOf("JSON.stringify")).toBe(-1);
        });
        let parseDefs = 0, stringifyDefs = 0;
        JSX_FILES.forEach((f) => {
            const code = codeOnly(readSrc("jsx/" + f));
            parseDefs += (code.match(/function\s+jsonParse\s*\(/g) || []).length;
            stringifyDefs += (code.match(/function\s+jsonStringify\s*\(/g) || []).length;
        });
        expect(parseDefs).toBe(1);
        expect(stringifyDefs).toBe(1);
    });

    test("the strict parser accepts well-formed documents and rejects malformed ones without executing them", () => {
        const jsonParse = hostBridge.get("jsonParse");
        fc.assert(
            fc.property(
                fc.record({
                    name: arbSafeName,
                    n: fc.integer({ min: -1000, max: 1000 }),
                    flag: fc.boolean(),
                    list: fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 5 }),
                }),
                (obj) => {
                    const text = JSON.stringify(obj);
                    expect(jsonParse(text)).toEqual(obj);
                }
            ),
            { numRuns: 60 }
        );
        ["{", "{not json", "[1,", "undefined", "1 2", ""].forEach((bad) => {
            expect(() => jsonParse(bad)).toThrow();
        });
        // A document that would be code under eval is data under jsonParse.
        expect(() => jsonParse('{"a":(function(){return 1})()}')).toThrow();
    });
});

// ============================================================
// CASE 19 — Startup scan (3.29, 3.30)
// **Validates: Requirements 3.29, 3.30**
// ============================================================
describe("Case 19 — one section-chunked scan per root, one migration per session, incomplete never empty (3.29, 3.30)", () => {
    function buildScanHarness(disk) {
        const enumerated = [];
        const migrations = [];

        function ScanFile(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.__isFileFake = true;
            this.fsName = norm;
            this.name = norm.split("/").pop();
            this.modified = new Date(0);
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () { return Object.prototype.hasOwnProperty.call(disk.texts, norm); },
            });
        }
        Object.defineProperty(ScanFile, Symbol.hasInstance, { value: (o) => !!(o && o.__isFileFake) });

        function ScanFolder(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.__isFolderFake = true;
            this.fsName = norm;
            this.name = norm.split("/").pop();
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () { return Object.prototype.hasOwnProperty.call(disk.folders, norm); },
            });
            this.getFiles = function () {
                enumerated.push(norm);
                const kids = disk.folders[norm];
                if (!kids) return null;
                return kids.map(function (k) {
                    const child = norm + "/" + k;
                    return Object.prototype.hasOwnProperty.call(disk.folders, child)
                        ? new ScanFolder(child) : new ScanFile(child);
                });
            };
        }
        Object.defineProperty(ScanFolder, Symbol.hasInstance, { value: (o) => !!(o && o.__isFolderFake) });

        const handle = loadHelpers({
            file: path.join("jsx", "core.jsx"),
            injected: {
                app: {}, File: ScanFile, Folder: ScanFolder,
                $: { get hiresTimer() { return 0; } },
            },
        });
        handle.context.migrateOldStructure = function (p) { migrations.push(p); };
        handle.context.readFileText = function (f) { return disk.texts[f.fsName] || ""; };
        return {
            enumerated: enumerated,
            migrations: migrations,
            scan: function (root, section) {
                const raw = handle.get("getAllTemplates")(
                    handle.get("encodeBridge")(root),
                    handle.get("encodeBridge")(section)
                );
                return JSON.parse(handle.get("decodeBridge")(raw));
            },
        };
    }

    const SECTIONS = ["comp", "layer", "text", "footage", "effect", "icon", "overlay"];

    test("the section filter chunks the scan: only the requested section's tree is enumerated", () => {
        fc.assert(
            fc.property(
                fc.subarray(SECTIONS, { minLength: 1 }),
                fc.integer({ min: 1, max: 3 }),
                (sections, perSection) => {
                    const disk = { folders: { "C:/lib": sections.slice() }, texts: {} };
                    sections.forEach((s) => {
                        disk.folders["C:/lib/" + s] = ["Cat"];
                        const items = [];
                        for (let i = 0; i < perSection; i++) items.push("T" + i);
                        disk.folders["C:/lib/" + s + "/Cat"] = items;
                        items.forEach((it) => {
                            const base = "C:/lib/" + s + "/Cat/" + it;
                            disk.folders[base] = ["meta.json"];
                            disk.texts[base + "/meta.json"] =
                                '{"name":"' + s + "-" + it + '","type":"' + s + '","section":"' + s + '"}';
                        });
                    });

                    const target = sections[0];
                    const h = buildScanHarness(disk);
                    const records = h.scan("C:/lib", target);

                    expect(records.length).toBe(perSection);
                    records.forEach((r) => expect(r.section).toBe(target));
                    // Exactly ONE scan of the requested section root, and no other
                    // section root was enumerated at all.
                    expect(h.enumerated.filter((p) => p === "C:/lib/" + target).length).toBe(1);
                    SECTIONS.forEach((s) => {
                        if (s === target) return;
                        expect(h.enumerated.indexOf("C:/lib/" + s)).toBe(-1);
                    });
                }
            ),
            { numRuns: 25 }
        );
    });

    test("the migration guard runs once per engine session, however many scans follow", () => {
        const disk = {
            folders: {
                "C:/lib": ["comp"], "C:/lib/comp": ["Cat"], "C:/lib/comp/Cat": ["T"],
                "C:/lib/comp/Cat/T": ["meta.json"],
            },
            texts: { "C:/lib/comp/Cat/T/meta.json": '{"name":"T","type":"comp","section":"comp"}' },
        };
        const h = buildScanHarness(disk);
        h.scan("C:/lib", "comp");
        h.scan("C:/lib", "layer");
        h.scan("C:/lib", "");
        h.scan("C:/lib", "comp");
        expect(h.migrations.length).toBe(PRE_FIX_BASELINE.migrationCallsPerSession);
        expect(h.migrations[0]).toBe("C:/lib");
    });

    test("a missing or unparseable meta.json yields a degraded record, never an emptied library", () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 5 }),
                fc.uniqueArray(fc.integer({ min: 21, max: 40 }), { minLength: 1, maxLength: 5 }),
                (goodIds, badIds) => {
                    const items = goodIds.map((n) => "G" + n).concat(badIds.map((n) => "B" + n));
                    const disk = {
                        folders: { "C:/lib": ["comp"], "C:/lib/comp": ["Cat"], "C:/lib/comp/Cat": items },
                        texts: {},
                    };
                    goodIds.forEach((n) => {
                        disk.folders["C:/lib/comp/Cat/G" + n] = ["meta.json"];
                        disk.texts["C:/lib/comp/Cat/G" + n + "/meta.json"] =
                            '{"name":"good-' + n + '","type":"comp","section":"comp","dim":"1920x1080"}';
                    });
                    badIds.forEach((n, i) => {
                        // Half have no meta.json at all, half have an unparseable one.
                        if (i % 2 === 0) {
                            disk.folders["C:/lib/comp/Cat/B" + n] = [];
                        } else {
                            disk.folders["C:/lib/comp/Cat/B" + n] = ["meta.json"];
                            disk.texts["C:/lib/comp/Cat/B" + n + "/meta.json"] = "{not json";
                        }
                    });

                    const h = buildScanHarness(disk);
                    const records = h.scan("C:/lib", "comp");

                    // EVERY folder is still reported — the library is never emptied.
                    expect(records.length).toBe(items.length);
                    goodIds.forEach((n) => {
                        const rec = records.filter((r) => r.name === "good-" + n)[0];
                        expect(rec).toBeTruthy();
                        expect(rec.dim).toBe("1920x1080");
                    });
                    badIds.forEach((n) => {
                        const rec = records.filter((r) => r.id === "B" + n)[0];
                        expect(rec).toBeTruthy();     // a degraded record, not a hole
                        expect(rec.name).toBe("B" + n);
                        expect(rec.section).toBe("comp");
                        expect(rec.dim).toBe("");
                    });
                }
            ),
            { numRuns: 25 }
        );
    });

    test("a missing or unparseable persisted index is an INCOMPLETE set, not an empty library", () => {
        fc.assert(
            fc.property(
                fc.constantFrom(null, undefined, "", "not json", "{}", '{"entries":"nope"}', "[]"),
                fc.string({ maxLength: 8 }),
                (serialized, diskKey) => {
                    // Unparseable / absent: flagged for a full rescan, never silently empty.
                    const idx = LibraryIndex.parse(serialized, {});
                    expect(idx.needsFullScan()).toBe(true);
                    expect(LibraryIndex.fullScanRequired(serialized, diskKey, {})).toBe(true);
                    expect(LibraryIndex.tryParse(serialized, {}).ok).toBe(false);
                }
            ),
            { numRuns: 20 }
        );

        // A VALID index round-trips and is NOT flagged, unless the disk moved.
        fc.assert(
            fc.property(
                fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 6 }),
                fc.string({ minLength: 1, maxLength: 8 }),
                (ids, key) => {
                    const built = new LibraryIndex({ validityKey: key });
                    ids.forEach((n) => built.insertAtHead({ folderPath: "C:/lib/comp/Cat/T" + n, name: "n" + n }));
                    const serialized = built.serialize();
                    const reparsed = LibraryIndex.parse(serialized, {});
                    expect(reparsed.needsFullScan()).toBe(false);
                    expect(reparsed.size()).toBe(ids.length);
                    expect(reparsed.entries().map((e) => e.folderPath))
                        .toEqual(built.entries().map((e) => e.folderPath));
                    expect(LibraryIndex.fullScanRequired(serialized, key, {})).toBe(false);
                    expect(LibraryIndex.fullScanRequired(serialized, key + "-moved", {})).toBe(true);
                }
            ),
            { numRuns: 20 }
        );
    });
});

// ============================================================
// The two existing suites that already ARE the baseline
// ------------------------------------------------------------
// tests/save-window-invariants.test.js and tests/import-timings.test.js are the
// recorded baseline (call sequences, counters, the single balanced group,
// rollback scoping, result totality, and the ES3 static gate). They are run
// unchanged by the suite; this case pins the facts THEY assert so a change to
// them is visible from here too.
// ============================================================
describe("Baseline suites — the assertions no fix may alter", () => {
    test("the ES3 gate in tests/import-timings.test.js still applies to every edited host file", () => {
        const gate = readSrc("tests/import-timings.test.js");
        expect(gate).toContain("stays strict ES3");
        ["jsx/core.jsx", "jsx/templates_save.jsx", "jsx/import.jsx", "jsx/helpers.jsx", "jsx/text.jsx"]
            .forEach((rel) => {
                const src = readSrc(rel);
                expect(/\blet\s/.test(src)).toBe(false);
                expect(/\bconst\s/.test(src)).toBe(false);
                expect(/=>/.test(src)).toBe(false);
            });
    });

    test("tests/save-window-invariants.test.js still pins the recorded sequence and counters", () => {
        const src = readSrc("tests/save-window-invariants.test.js");
        expect(src).toContain("coreSaveLayerType");
        expect(src).toContain("Protective save failed");
        expect(src).toContain("Template save failed");
        // Its three invariants, unchanged.
        expect(src).toContain("expect(app._counters.openCalls).toEqual([]);");
        expect(src).toContain("expect(app._counters.reduceCalls).toBe(0);");
        expect(src).toContain("expect(app._counters.openCalls.length).toBe(1);");
    });

    test("tests/import-timings.test.js still pins the single balanced group and per-template semantics", () => {
        const src = readSrc("tests/import-timings.test.js");
        expect(src).toContain("expect(h.counters.undoBegin).toBe(h.counters.undoEnd)");
        expect(src).toContain('expect(res.perTemplate[0].status).toBe("imported")');
        expect(src).toContain('expect(res.perTemplate[0].status).toBe("failed")');
    });
});
