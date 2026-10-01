// ============================================================
// tests/comp-pipeline-integration.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 16)
//
// The eight integration flows from the design's "Testing Strategy →
// Integration Tests". Each flow crosses SEVERAL fixes end to end, which is the
// point: the full comp save was broken by 1.1, 1.10 and 1.11 at three separate
// links, and a per-fix test can only ever see one link at a time.
//
// Nothing in this file changes production code. Where a flow uncovers a real
// production gap the flow says so out loud — see FLOW 4's `test.failing` case,
// which documents the layer/text/footage wrappers dropping the format fields
// `coreSaveLayerType` captures. `test.failing` is deliberate: it keeps the suite
// honest today AND fails loudly the moment the gap is closed, so it can never
// harden into a pinned bug.
//
// Harness provenance — reused, not reinvented
// -------------------------------------------
// `sliceFn` / `sliceAll` / `buildRealm` / `duckCtor` / `newCounters` /
// `createSaveApp` / `createFileCtor` / `createFolderCtor` / `buildCompSaveRealm`
// / `buildLayerSaveRealm` / `createProjectModel` / `buildImportRealm` /
// `buildScanHarness` are the shapes already established by
// tests/comp-pipeline-bug-exploration.test.js (task 1) and
// tests/comp-pipeline-preservation.property.test.js (task 2), which in turn come
// from tests/save-window-invariants.test.js:27-38. The panel harness is the one
// from tests/save-return-shape.test.js (real templates.js in a `vm` through
// tests/helpers/loadHelpers.js, real `runSaveController`, real
// `js/core/pathBuilders.js`), widened here to use the REAL hex codec + REAL
// `callHost` from js/core/bridge.js, a REAL `LibraryIndex` from
// js/core/persistence.js, and the REAL `renderOptimisticCard` instead of a
// recorder. tests/import-timings.test.js is the model for the import flows.
//
// `jsonParse` is deliberately NOT sliced anywhere here: its body contains "{"
// and "}" inside string literals, which a brace walk cannot survive. Every host
// caller already guards it with
// `typeof jsonParse === "function" ? jsonParse(x) : JSON.parse(x)` for exactly
// this kind of harness — the same fallback tests/import-timings.test.js relies
// on. Each flow states which guard branch it takes.
//
// typeof-guard branches exercised (production reaches cross-file siblings
// through `typeof fn === "function" ? fn(x) : <inline fallback>`; in an isolated
// realm the FALLBACK runs unless the sibling is wired in, so every flow that is
// meant to prove an integrated path wires the real sibling):
//
//   REAL sibling wired in — the INTEGRATED branch runs:
//     validateLibraryRoot + isAbsoluteLibraryRoot   saveActiveComp, coreSaveLayerType
//     decodeBridgeStrict                            host decodeBridge, importBatch
//                                                   (its module-level
//                                                   CS_BRIDGE_HEX_RE is injected
//                                                   by buildRealm — a brace walk
//                                                   cannot carry a `var`)
//     findCompItemInFolderByName                    renderTemplateThumbnail
//     csResolveImportAnchor,
//     csBatchAnchorBegin / csBatchAnchorEnd         importCompDirect, importBatch
//     cleanupImportedItems                          importCompDirect's finally
//     csFindOrCreateRootFolder                      toolkitOrganizeTemplateImport
//     csFindOrCreateSubFolder                       ditto (flow 5 only — a
//                                                   solid-only import needs no
//                                                   Assets subfolder)
//     csReadTemplateMeta, csEnumerateFolderOnce     resolveTemplateFiles (flow 8c
//                                                   evaluates jsx/import.jsx's
//                                                   I/O helpers into the same
//                                                   context). project.aep resolves
//                                                   on the ladder's FIRST rung
//                                                   there, so csListTemplateFiles
//                                                   is wired but not entered.
//     jsonParse                                     csReadTemplateMeta / parseMeta
//                                                   in flow 8 (whole-file core.jsx
//                                                   sandbox, so jsonParse exists)
//     getSafeName / generateTemplateId              panel side, the real
//                                                   js/core/pathBuilders.js
//   Documented FALLBACK branch runs:
//     jsonParse -> JSON.parse                       importBatch and itemExists in
//                                                   the SLICED realms (flows 3, 5)
//     CS_ASSETS_FOLDER_NAME -> "_CompSaver_Assets"   toolkitOrganizeTemplateImport
//                                                   (module-level `var`; the
//                                                   inline literal is the same
//                                                   value the constant holds)
//     resolveTemplateFiles                          injected in the import realms;
//                                                   its own on-disk resolution is
//                                                   proven by flow 8 instead
//     getMetadataCache absent                       importCurrentCardToTimeline's
//                                                   resolveCached returns null
//                                                   immediately (flow 6 is about
//                                                   the transport, not the cache)
//
// **Validates: Requirements 2.1, 2.5, 2.9, 2.10, 2.11, 2.13, 2.17, 2.18, 2.19,
// 2.20, 2.22**
// **Preservation: 3.11, 3.14, 3.21, 3.22, 3.23, 3.30**
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadHelpers } = require("./helpers/loadHelpers");
const panelBridge = require("../js/core/bridge.js");
const { importTemplates } = require("../js/core/importEngine.js");
const { runSaveController } = require("../js/core/saveController.js");
const { LibraryIndex, normalizeFolderPath } = require("../js/core/persistence.js");
const pathBuilders = require("../js/core/pathBuilders.js");

const ROOT = path.resolve(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SAVE_SRC = readSrc("jsx/templates_save.jsx");
const CORE_SRC = readSrc("jsx/core.jsx");
const IMPORT_SRC = readSrc("jsx/import.jsx");
const TEXT_SRC = readSrc("jsx/text.jsx");
const HELPERS_SRC = readSrc("jsx/helpers.jsx");
const TEXTANIM_JS = readSrc("js/textanim/textanim.js");
const TEMPLATES_JS = readSrc("js/templates/templates.js");

const TEMPLATES_REL = path.join("js", "templates", "templates.js");

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

// The real, pure host utilities every sliced engine depends on — the identical
// name list the task-1 and task-2 suites use, so the engines here run against
// the encoder / sanitizer / serializer they actually ship with.
const CORE_PURE = sliceAll(CORE_SRC, [
    "trimStr", "cleanStr", "getSafeName", "escapeJSON", "jsonStringify",
    "encodeBridge", "decodeBridge", "decodeBridgeStrict", "isWellFormedBridgeHex",
    "isHexChar", "safeDecode", "fsEntryName",
    "generateTemplateId", "getDeterministicTemplateId", "normalizeSectionName",
    "ensureDeepFolder", "isAbsoluteLibraryRoot", "validateLibraryRoot",
]);

// The canonical comp resolver (F3) — wired in so saveActiveComp resolves through
// the SAME function getStrictSaveType announces from, rather than through a stub.
const CORE_RESOLVER = sliceAll(CORE_SRC, ["csResolveCompTarget", "resolveCompForSave"]);

/** Split a host call like `fn("aabb","ccdd")` into its raw argument strings.
 *  Bridge payloads are pure hex, so they contain neither a comma nor a quote —
 *  a naive split is exact here and keeps the harness free of a parser. */
function hostArgs(scriptCall) {
    const inside = String(scriptCall).replace(/^[^(]*\(/, "").replace(/\)\s*$/, "");
    if (inside.replace(/\s/g, "") === "") return [];
    return inside.split(",").map((a) => a.replace(/^\s*"?/, "").replace(/"?\s*$/, ""));
}

/** Name of the host function a scriptCall invokes. */
function hostFnName(scriptCall) {
    const m = String(scriptCall).match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
    return m ? m[1] : "";
}

// ─────────────────────────────────────────────────────────────
// Duck-typed AE constructors (cross-realm `instanceof` via Symbol.hasInstance,
// the trick tests/helpers/loadHelpers.js uses for CompItem).
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
        TextLayer: duckCtor("textlayer"),
        FootageItem: duckCtor("footage"),
        FolderItem: duckCtor("folder"),
        SolidSource: duckCtor("solidSource"),
        PlaceholderSource: duckCtor("placeholderSource"),
    };
}

function buildRealm(source, injected) {
    const ctx = Object.assign(
        {
            console: { log() { }, warn() { }, error() { } },
            // Module-level constant a brace walk cannot carry: jsx/core.jsx
            // declares `var CS_BRIDGE_HEX_RE = /^[0-9a-fA-F]*$/` next to
            // isWellFormedBridgeHex. Injecting it (rather than omitting
            // decodeBridgeStrict) is what makes the REAL strict decoder — not
            // decodeBridge's inline fallback — the one these flows run.
            CS_BRIDGE_HEX_RE: /^[0-9a-fA-F]*$/,
        },
        makeCtors(), injected || {});
    ctx.global = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "comp-pipeline-integration-slice" });
    return ctx;
}

// ─────────────────────────────────────────────────────────────
// Save-engine fakes. `seq` is the ordered journal of every instrumented `app`
// call — the recorded destructive-window protocol flows 1-4 must not disturb.
// ─────────────────────────────────────────────────────────────
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
        selection: [],
        item: function () { return null; },
        save: function (file) {
            const isProtective = file === projectFile;
            counters.seq.push(isProtective ? "save(PROTECTIVE)" : "save(TARGET)");
            counters.saveCalls.push(isProtective ? "PROTECTIVE" : String((file && file.fsName) || file));
            if (isProtective && opts.protectiveSaveThrows) throw new Error("disk full");
            if (!isProtective) {
                if (opts.targetSaveThrows) throw new Error("target save failed");
                // AE re-points app.project.file at the file just written, which is
                // exactly why a failed reopen must never be reported as success.
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
                return {
                    __kind: "comp", name: name, numLayers: 2,
                    width: w, height: h, pixelAspect: pa, duration: dur, frameRate: fps,
                    workAreaStart: 0, workAreaDuration: dur,
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

function createFileCtor(fsSet) {
    return function File(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return fsSet[norm] === true; },
        });
    };
}

// The library root and every existing descendant are present, so
// ensureDeepFolder finds the target and `creates` records only genuinely new
// levels. `parent` is provided because the REAL validateLibraryRoot probes it.
function createFolderCtor(fsSet, creates) {
    return function Folder(p) {
        const norm = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
        const self = this;
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return fsSet[norm] === true; },
        });
        Object.defineProperty(this, "parent", {
            configurable: true,
            get: function () {
                const up = norm.replace(/\/[^/]*$/, "");
                return up && up !== norm ? new Folder(up) : null;
            },
        });
        this.create = function () {
            creates.push(norm);
            fsSet[norm] = true;
            return true;
        };
        this.getFiles = function () { return []; };
        this.toString = function () { return self.fsName; };
    };
}

// ─────────────────────────────────────────────────────────────
// Comp-save realm — the REAL saveActiveComp, the REAL validateLibraryRoot and
// the REAL resolveCompForSave, over a live (non-invalidating) comp reference.
// Flows 1-3.
// ─────────────────────────────────────────────────────────────
function buildCompSaveRealm(opts) {
    opts = opts || {};
    const rootPath = opts.rootPath || "C:/lib";
    const counters = newCounters();
    const creates = [];
    const fsSet = Object.assign({
        "C:/lib": true,
        "C:/lib/comp": true,
        "C:/lib/comp/Titles": true,
    }, opts.fsSet || {});
    const app = createSaveApp(counters, opts);
    const precomp = Object.assign({
        __kind: "comp", name: "Source Precomp",
        remove: function () { this.__removed = true; },
    }, opts.geometry || {
        width: 1920, height: 1080, pixelAspect: 1, duration: 10,
        frameRate: 25, workAreaStart: 0, workAreaDuration: 10,
    });
    // F3's Project-panel rule: ONE comp in the selection wins even when
    // non-comp items ride along. So this flow also crosses the canonical
    // resolver rather than stubbing it out.
    app.project.selection = [precomp, { __kind: "footage", name: "logo.png" }];

    const ctx = buildRealm([
        CORE_PURE,
        CORE_RESOLVER,
        sliceFn(SAVE_SRC, "saveActiveComp"),
    ].join("\n"), {
        app: app,
        File: createFileCtor(fsSet),
        Folder: createFolderCtor(fsSet, creates),
    });

    return {
        ctx, app, counters, creates, fsSet, precomp, rootPath,
        /** Run the real host entry point exactly as the panel calls it. */
        run: function (nameHex, catHex, rootHex, oldIdHex) {
            return ctx.saveActiveComp(nameHex, catHex, rootHex, oldIdHex);
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Layer-save realm — the REAL coreSaveLayerType behind the REAL saveActiveLayer
// wrapper, so flow 4 crosses the same boundary production does.
// ─────────────────────────────────────────────────────────────
function buildLayerSaveRealm(opts) {
    opts = opts || {};
    const rootPath = opts.rootPath || "C:/lib";
    const counters = newCounters();
    const creates = [];
    const fsSet = Object.assign({
        "C:/lib": true,
        "C:/lib/layer": true,
        "C:/lib/layer/Shapes": true,
    }, opts.fsSet || {});
    const app = createSaveApp(counters, opts);
    const layer = {
        __kind: "avlayer",
        matchName: "ADBE Shape Layer",
        name: "Spin Rig",
        source: null,
        adjustmentLayer: false, threeDLayer: true, blendingMode: 3, label: 9,
        numProperties: 2,
        property: function (n) {
            return n === "ADBE Effect Parade" ? { numProperties: 1 } : { numProperties: 0 };
        },
    };
    const comp = Object.assign({
        __kind: "comp", name: "Live Comp", selectedLayers: [layer],
        remove: function () { this.__removed = true; },
    }, opts.geometry || {
        width: 1280, height: 720, pixelAspect: 2, duration: 4, frameRate: 24,
        workAreaStart: 0, workAreaDuration: 4,
    });
    app.project.activeItem = comp;

    const ctx = buildRealm([
        CORE_PURE,
        sliceAll(SAVE_SRC, ["coreSaveLayerType", "saveActiveLayer"]),
    ].join("\n"), {
        app: app,
        File: createFileCtor(fsSet),
        Folder: createFolderCtor(fsSet, creates),
        // captureLayerState / copySelectedLayersToTempComp are the two host
        // siblings that touch the real AE property model; they are the harness
        // boundary in tests/save-window-invariants.test.js too.
        captureLayerState: function () { return null; },
        copySelectedLayersToTempComp: function () { return 2; },
        classifyLayer: function () { return "layer"; },
        hasLayerCustomContent: function () { return true; },
    });

    // The captured layerState must be built INSIDE the realm: jsonStringify tests
    // `obj instanceof Array`, and a `vm` context has its own Array intrinsic, so a
    // test-realm array would serialize as an object. ExtendScript has one realm,
    // so this is a harness artifact, not a production behaviour.
    const capturedState = vm.runInContext(
        '({ switches: { enabled: true, threeDLayer: true }, markers: [{ t: 0.5, comment: "hit" }] })',
        ctx
    );
    ctx.captureLayerState = function () { return capturedState; };

    return {
        ctx, app, counters, creates, comp, layer, rootPath, capturedState,
        /** The engine on its own, so the object result itself is observable.
         *  The panel-facing wrapper (saveActiveLayer) is driven by the panel
         *  harness's own scriptCall in FLOW 4. */
        runCore: function (name, cat, section) {
            return ctx.coreSaveLayerType(name, cat, rootPath, "Layer", "blackbg",
                section || "layer", ctx.generateTemplateId(name));
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Project model for the import realms (the exploration suite's shape).
// Every addFolder / remove / parentFolder mutation is recorded, so "the project
// is unmodified" and "template 3's items are gone" are directly observable.
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
    rootFolder.items = { addFolder: function (n) { return addFolder(n, rootFolder); } };

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
    Object.defineProperty(project, "numItems", { get: function () { return all.length; } });

    return {
        project, rootFolder, mutations, all, makeItem, addFolder, makeComp, insertLayer,
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
    "var __CS_IMPORT_BATCH_ANCHOR = null;",
    "var __CS_IMPORT_IO = null;",
    "var _csProfileLog = null;",
].join("\n");

// The REAL import engine plus every sibling the guards look for, so the flows
// take the integrated branch instead of each inline fallback: the anchor latch
// (F10), the fixed-name container helpers (F9b), cleanupImportedItems (F9a) and
// the per-import I/O context.
const IMPORT_REAL = sliceAll(IMPORT_SRC, [
    "csBeginUndoGroup", "csEndUndoGroup",
    "csBatchAnchorBegin", "csBatchAnchorReselect", "csBatchAnchorEnd", "csResolveImportAnchor",
    "csImportIoBegin", "csImportIoEnd", "csImportIoOwn", "csImportIoRelease",
    "csNormPath", "csIoKey", "csMakeIoError", "csEnumerateFolderOnce",
    "csItemKind", "csClassifyItemsOnce", "csExistingNamesOnce", "csResolveName",
    "csSnapshotProjectItemIds", "csSnapshotCompLayers", "csRollbackToSnapshot",
    "csDispatchImport", "_csProfilePoint", "importBatch", "importCompDirect",
    "cleanupImportedItems", "csFindOrCreateRootFolder", "csFindOrCreateSubFolder",
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
        beginUndoGroup: function (name) {
            counters.seq.push("beginUndoGroup:" + name);
            counters.undoAttempts++;
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
        sliceAll(CORE_SRC, ["deselectAllLayers", "getTopSelectedLayer", "getAllProjectNamesLower", "safeRenameAllImportedItems"]),
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
        forceCompViewerRefresh: function () { },
        // The template folder on disk is the harness boundary for the import
        // flows: resolveTemplateFiles' own on-disk resolution is proven by
        // FLOW 8 with the whole-file core.jsx sandbox.
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
    // anchor each template actually used is observable BY IDENTITY.
    vm.runInContext(
        "var __realGetTop = getTopSelectedLayer;" +
        "getTopSelectedLayer = function (c) { var t = __realGetTop(c); __anchorLog.push(t); return t; };",
        ctx
    );

    return { ctx, app, model, counters, anchorLog, guardDuringImport, hires };
}

// ─────────────────────────────────────────────────────────────
// Thumbnail chain — the REAL panel queue entry point + queue runner sliced out
// of js/textanim/textanim.js, and the REAL host renderTemplateThumbnail (with
// the REAL findCompItemInFolderByName and renderFrameToPng) behind it.
// ─────────────────────────────────────────────────────────────
function buildThumbnailHostRealm(cfg) {
    cfg = cfg || {};
    const rendered = [];
    const removed = [];
    const suppress = { begin: 0, end: 0 };
    const touched = [];

    // The .aep the save wrote holds MORE than one comp, and the recorded target
    // is NOT the one a first-comp scan returns. That is the whole point of 1.11.
    const decoyComp = {
        __kind: "comp", name: "Zz Decoy Comp",
        width: 320, height: 180, pixelAspect: 1, duration: 10, frameRate: cfg.frameRate || 25,
        workAreaStart: 0, workAreaDuration: 10, time: 0,
        saveFrameToPng: function () { throw new Error("the decoy comp must never be rendered"); },
    };
    const targetComp = {
        __kind: "comp", name: cfg.compName,
        width: 320, height: 180, pixelAspect: 1,
        duration: cfg.duration || 10, frameRate: cfg.frameRate || 25,
        workAreaStart: 0, workAreaDuration: cfg.duration || 10, time: 7,
        saveFrameToPng: function (t) { rendered.push({ comp: this.name, time: t }); },
    };
    // importFile hands back a FolderItem tree: decoy first, so a by-position
    // scan picks the wrong comp and a by-name walk picks the right one.
    const innerFolder = {
        __kind: "folder", name: "inner", numItems: 1,
        item: function () { return targetComp; },
    };
    const importedFolder = {
        __kind: "folder", name: "scratch", numItems: 2,
        item: function (i) { return i === 1 ? decoyComp : innerFolder; },
        remove: function () { removed.push("importedFolder"); },
    };

    const app = {
        project: {
            get bitsPerChannel() { return 16; },
            set bitsPerChannel(v) { touched.push("bitsPerChannel=" + v); },
            get file() { touched.push("READ app.project.file"); return { fsName: "C:/proj/live.aep" }; },
            set file(v) { touched.push("WRITE app.project.file"); },
            importFile: function () { return importedFolder; },
            items: { addComp: function () { throw new Error("no wrapper expected at 320px"); } },
        },
        open: function () { touched.push("app.open"); },
        beginSuppressDialogs: function () { suppress.begin++; },
        endSuppressDialogs: function () { suppress.end++; },
    };

    const ctx = buildRealm([
        CORE_PURE,
        sliceAll(HELPERS_SRC, ["isValidPng", "renderFrameToPng"]),
        sliceAll(TEXT_SRC, ["findCompItemInFolder", "findCompItemInFolderByName"]),
        sliceFn(SAVE_SRC, "renderTemplateThumbnail"),
    ].join("\n"), {
        app: app,
        File: function File(p) {
            const norm = String(p).replace(/\\/g, "/");
            this.fsName = norm;
            this.name = norm.split("/").pop();
            // The saved project.aep exists; the PNG "exists" after the render so
            // isValidPng reports success (>64 bytes).
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () { return /\.aep$/.test(norm) || rendered.length > 0; },
            });
            this.length = 4096;
        },
        ImportOptions: function ImportOptions(f) { this.file = f; },
    });

    return { ctx, rendered, removed, suppress, touched, targetComp, decoyComp };
}

/** The REAL panel-side thumbnail queue: enqueueThumbnailRender builds the job,
 *  runOneThumbnail issues the host call. AerenderRunner is deliberately left
 *  undefined so the guarded in-project branch (the 4-argument
 *  renderTemplateThumbnail call) is the one exercised. */
function buildThumbnailQueueRealm(evalScript) {
    const queue = [];
    const busy = [];
    const ctx = buildRealm([
        sliceAll(TEXTANIM_JS, ["enqueueThumbnailRender", "runOneThumbnail"]),
    ].join("\n"), {
        previewQueue: queue,
        // Pinned true so runOneThumbnail is driven explicitly by the flow rather
        // than by textanim's private drain loop.
        previewRunning: true,
        drainPreviewQueue: function () { throw new Error("the flow drives the queue"); },
        markFolderBusy: function (f) { busy.push({ op: "busy", folder: f }); },
        clearFolderBusy: function (f) { busy.push({ op: "clear", folder: f }); },
        THUMBNAIL_TIMEOUT_MS: 60000,
        encodeBridge: panelBridge.encodeBridge,
        decodeBridge: panelBridge.decodeBridge,
        csInterface: { evalScript: evalScript },
        setTimeout: function () { return global.setTimeout.apply(global, arguments); },
        clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
    });
    return { ctx, queue, busy };
}

// ─────────────────────────────────────────────────────────────
// Panel harness — the REAL js/templates/templates.js in a vm through
// tests/helpers/loadHelpers.js, driven through its PUBLIC confirmSave /
// importCurrentCardToTimeline entry points.
//
// Differences from tests/save-return-shape.test.js's harness, all in the
// direction of "less fake":
//   • the REAL hex codec and the REAL timeout-guarded callHost from
//     js/core/bridge.js (so a host reply really is encoded, decoded and
//     strict-validated on the way through),
//   • the REAL LibraryIndex from js/core/persistence.js behind
//     getLibraryIndex(), and the REAL renderOptimisticCard instead of a
//     recorder, so "exactly ONE card at the head of the index" is a fact about
//     production code,
//   • meta.json CONTENT is captured, not just the write call.
// ─────────────────────────────────────────────────────────────
function makeEl(props) {
    return Object.assign(
        {
            value: "",
            disabled: false,
            textContent: "",
            innerHTML: "",
            style: { cssText: "", transform: "" },
            className: "",
            classList: {
                add() { }, remove() { }, contains() { return false; }, toggle() { },
            },
            focus() { }, select() { }, setAttribute() { },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            appendChild() { }, removeChild() { },
        },
        props || {}
    );
}

function makePanelHarness(opts) {
    opts = opts || {};

    const thumbJobs = [];
    const previewJobs = [];
    const toasts = [];
    const hostCalls = [];        // every scriptCall, in order
    const fsCalls = [];          // every Node fs op the finalizer performs
    const writtenFiles = {};     // path -> content
    const confirms = [];
    const bgActivity = [];
    const cardRenders = [];      // what the REAL renderOptimisticCard returned
    const thumbRefreshes = [];
    const rerenders = [];

    const SECTIONS = {
        COMP: "comp", LAYER: "layer", TEXT: "text", TEXT_PROPS: "text_props",
        FOOTAGE: "footage", EFFECT: "effect", OVERLAY: "overlay", ICON: "icon",
    };

    const favPaths = opts.favPaths || [];

    const fsFake = {
        promises: {
            mkdir: async function () { },
            stat: async function () { return { size: 1 }; },
            copyFile: async function () { },
            writeFile: async function (p, content) {
                fsCalls.push({ op: "writeFile", path: p });
                writtenFiles[p] = content;
            },
            access: async function (p) {
                fsCalls.push({ op: "access", path: p });
                if (favPaths.indexOf(p) === -1) throw new Error("ENOENT: " + p);
            },
            rm: async function (p) { fsCalls.push({ op: "rm", path: p }); },
        },
        // The rendered thumbnail does NOT exist yet at optimistic-card time —
        // that is what makes the card a placeholder (Preservation 3.23).
        existsSync: function () { return false; },
        statSync: function () { throw new Error("no thumbnail yet"); },
    };
    const pathFake = {
        join: function () { return Array.prototype.slice.call(arguments).join("/"); },
        dirname: function (p) { return String(p).replace(/\/[^/]*$/, ""); },
    };

    const DOM = {
        "input-name": makeEl({ value: opts.name !== undefined ? opts.name : "My Title" }),
        "input-new-cat": makeEl({ value: "" }),
        "btn-confirm-save": makeEl({ disabled: false, textContent: "Save" }),
        "save-modal": makeEl({}),
        "cat-select-wrapper": makeEl({}),
        "search-box": makeEl({ value: "" }),
    };

    // ── The single host responder every round-trip funnels through ──────
    // validateSaveRequest answers "true"; itemExists and the save itself are
    // delegated to the flow, which answers with the reply the REAL host engine
    // produced in its own realm.
    function hostEval(scriptCall, cb) {
        const fn = hostFnName(scriptCall);
        const args = hostArgs(scriptCall);
        hostCalls.push({ fn: fn, scriptCall: scriptCall, args: args });
        if (fn === "validateSaveRequest") {
            cb(panelBridge.encodeBridge("true"));
            return;
        }
        if (fn === "itemExists") {
            cb(opts.onItemExists
                ? opts.onItemExists(args)
                : panelBridge.encodeBridge(JSON.stringify({ exists: false, section: "comp" })));
            return;
        }
        if (opts.onHostCall) { cb(opts.onHostCall(fn, args, scriptCall)); return; }
        cb(panelBridge.encodeBridge("true"));
    }

    const csFake = { evalScript: function (scriptCall, cb) { hostEval(scriptCall, cb); } };

    const libraryIndex = new LibraryIndex({ validityKey: "integration" });
    const allTemplates = [];

    const injected = {
        DOM: DOM,
        SECTIONS: SECTIONS,
        MODULES: { TEMPLATES: "templates", TOOLKIT: "toolkit" },
        IMAGE_SECTIONS: ["icon", "overlay"],
        allTemplates: allTemplates,
        selectedCatValue: opts.category !== undefined ? opts.category : "Titles",
        selectedSaveType: opts.selectedSaveType !== undefined ? opts.selectedSaveType : SECTIONS.COMP,
        currentSection: opts.currentSection !== undefined ? opts.currentSection : SECTIONS.COMP,
        currentCategory: opts.category !== undefined ? opts.category : "Titles",
        currentMainModule: "templates",
        savePath: opts.rootPath || "C:/lib",
        rootPath: opts.rootPath || "C:/lib",
        libraryPaths: [],

        // REAL transport codec + REAL timeout-guarded wrapper.
        encodeBridge: panelBridge.encodeBridge,
        decodeBridge: panelBridge.decodeBridge,
        callHost: function (scriptCall, options) {
            return panelBridge.callHost(scriptCall,
                Object.assign({}, options || {}, { csInterface: csFake }));
        },
        csInterface: csFake,

        // REAL canonical panel sanitizer (js/core/pathBuilders.js — the module
        // F5d added to index.html, so this IS the runtime rule set).
        getSafeName: pathBuilders.getSafeName,
        generateTemplateId: pathBuilders.generateTemplateId,
        cleanName: pathBuilders.cleanName,

        // REAL save controller.
        runSaveController: runSaveController,

        // REAL batching import engine (flow 6).
        importTemplates: importTemplates,

        // REAL library index singleton behind the accessor templates.js uses.
        getLibraryIndex: function () { return libraryIndex; },
        normalizeFolderPath: normalizeFolderPath,

        // Trivial classifiers (js/core/utils.js); not part of any chain under test.
        normalizeSectionName: function (s) {
            if (!s) return "";
            const v = String(s).toLowerCase();
            if (v === "transition") return "layer";
            if (v === "png" || v === "image") return "icon";
            return v;
        },
        getTemplateSection: function (t) {
            if (!t) return "";
            return String(t.section || t.type || "").toLowerCase();
        },
        isTextSection: function (s) { return s === SECTIONS.TEXT || s === SECTIONS.TEXT_PROPS; },
        isImageSection: function (s) { return s === SECTIONS.ICON || s === SECTIONS.OVERLAY; },
        getSaveTypeLabel: function () { return "Pre-Comp"; },

        showToast: function (msg, kind) { toasts.push({ msg: String(msg), kind: kind }); },
        Settings: {
            get: function (k) {
                if (k === "library.confirmOverwrite") return !!opts.confirmOverwrite;
                return false;
            },
            set: function () { },
        },
        FocusTrap: { activate() { }, deactivate() { } },
        confirm: function (msg) {
            confirms.push(String(msg));
            return opts.confirmAnswer !== undefined ? opts.confirmAnswer : true;
        },
        document: {
            body: makeEl({}),
            querySelectorAll: function () { return []; },
            querySelector: function () { return null; },
            createElement: function () { return makeEl({}); },
            getElementById: function () { return null; },
        },

        nfs: function () { return opts.nfsResult !== undefined ? opts.nfsResult : fsFake; },
        getNodePath: function () { return pathFake; },

        // Background render queue — RECORD only, so the enqueued job (including
        // the F6d compName/renderFrame arguments) stays observable and the flow
        // can hand it to the real queue runner itself.
        TextAnim: {
            enqueueThumbnailRender: function (aep, thumb, cb, compName, renderFrame) {
                thumbJobs.push({ aep, thumb, cb, compName, renderFrame });
            },
            enqueuePreviewRender: function (aep, name, cb, flag) {
                previewJobs.push({ aep, name, cb, flag });
            },
            attachHoverPreviews: function () { },
        },

        setTimeout: function () { return global.setTimeout.apply(global, arguments); },
        clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
        setInterval: function () { return global.setInterval.apply(global, arguments); },
        clearInterval: function () { return global.clearInterval.apply(global, arguments); },
    };

    const handle = loadHelpers({ file: TEMPLATES_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;

    // Neutralize the terminal fan-out: a full library scan / DOM grid render is
    // not part of any flow under test. renderOptimisticCard stays REAL.
    handle.context.loadTemplates = function () { };
    handle.context.filterAndRender = function () { rerenders.push("filterAndRender"); };
    handle.context.updateCount = function () { };
    handle.context.refreshCardThumbnail = function (folder, thumb) {
        thumbRefreshes.push({ folder, thumb });
    };
    handle.context.setBackgroundActivity = function (on, label) {
        bgActivity.push({ on: !!on, label: label });
    };
    const realRenderOptimisticCard = handle.context.renderOptimisticCard;
    handle.context.renderOptimisticCard = function (t) {
        const out = realRenderOptimisticCard(t);
        cardRenders.push({ input: t, output: out });
        return out;
    };

    return {
        handle,
        confirmSave: handle.get("confirmSave"),
        importCurrentCardToTimeline: handle.get("importCurrentCardToTimeline"),
        libraryIndex, allTemplates,
        thumbJobs, previewJobs, toasts, hostCalls, fsCalls, writtenFiles,
        confirms, bgActivity, cardRenders, thumbRefreshes, rerenders,
        DOM,
        saveCalls: function () {
            return hostCalls.filter((c) => c.fn !== "validateSaveRequest" && c.fn !== "itemExists");
        },
        metaJson: function (folderPath) {
            const raw = writtenFiles[folderPath + "/meta.json"];
            return raw === undefined ? null : JSON.parse(raw);
        },
        errorToasts: function () { return toasts.filter((t) => t.kind === "error"); },
    };
}

// ─────────────────────────────────────────────────────────────
// Library-scan harness — the preservation suite's shape (whole-file core.jsx
// sandbox over an in-memory disk). Flow 8.
// ─────────────────────────────────────────────────────────────
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
        const norm = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
        this.__isFolderFake = true;
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return Object.prototype.hasOwnProperty.call(disk.folders, norm); },
        });
        this.getFiles = function (mask) {
            enumerated.push(norm + (mask ? "|" + mask : ""));
            const kids = disk.folders[norm];
            if (!kids) return null;
            const out = [];
            for (let i = 0; i < kids.length; i++) {
                const child = norm + "/" + kids[i];
                const isFolder = Object.prototype.hasOwnProperty.call(disk.folders, child);
                const entry = isFolder ? new ScanFolder(child) : new ScanFile(child);
                if (mask && !isFolder) {
                    const ext = String(mask).replace(/^\*/, "").toLowerCase();
                    if (kids[i].toLowerCase().slice(-ext.length) !== ext) continue;
                }
                out.push(entry);
            }
            return out;
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
        handle, enumerated, migrations,
        scan: function (root, section) {
            const raw = handle.get("getAllTemplates")(
                handle.get("encodeBridge")(root),
                handle.get("encodeBridge")(section)
            );
            return JSON.parse(handle.get("decodeBridge")(raw));
        },
        resolve: function (root, cat, id, section) {
            return handle.get("resolveTemplateFiles")(root, cat, id, section);
        },
    };
}

/** The PRE-FIX panel derivation, deleted by F5c (js/core/utils.js:20-24): trim,
 *  then replace the illegal character class. No cleanStr, no trailing-dot strip,
 *  no reserved-name escape, no 255-character truncation. Reproduced here (and
 *  nowhere in production) so flow 8 can prove the canonical sanitizer does not
 *  re-key a folder the old panel already created. */
function preFixPanelSafeName(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/^\s+|\s+$/g, "").replace(/[\\/:*?"<>|]/g, "_");
}

// The recorded destructive-window protocol (tests/save-window-invariants.test.js
// and the task-2 preservation baseline). Flows 1-4 must not disturb it.
const COMP_SAVE_SEQUENCE = [
    "beginUndoGroup", "save(PROTECTIVE)", "reduceProject", "save(TARGET)",
    "endUndoGroup", "beginSuppressDialogs", "open", "endSuppressDialogs",
];
const LAYER_SAVE_SEQUENCE = [
    "beginUndoGroup", "save(PROTECTIVE)", "addComp", "reduceProject",
    "save(TARGET)", "endUndoGroup", "beginSuppressDialogs", "open",
    "endSuppressDialogs",
];

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// ============================================================
// FLOW 1 — full comp save → card → meta.json → thumbnail job → 4-arg render
//
// The chain 1.1 + 1.10 + 1.11 broke at three separate links:
//   1.1  the result was built from a reference app.open had invalidated, so a
//        completed save reported "Error: … Exception: …" and reopened twice;
//   1.10 the result carried no section/type/format, so meta.json recorded no
//        dim and no assetsDir;
//   1.11 renderTemplateThumbnail took two arguments, so the recorded
//        renderComp/renderFrame were discarded and whatever comp enumerated
//        first was rendered 30% into its work area.
// One flow, all three links, real code at every one of them.
// ============================================================
describe("FLOW 1 — comp save reaches the card, meta.json and the thumbnail target", () => {
    test("saveActiveComp → parseEssential → runSaveController → card → meta.json → 4-argument renderTemplateThumbnail", async () => {
        const host = buildCompSaveRealm({});
        let hostReplyHex = null;

        const panel = makePanelHarness({
            name: "My Title",
            category: "Titles",
            rootPath: "C:/lib",
            onHostCall: function (fn, args) {
                // The panel's OWN scriptCall drives the real host engine.
                expect(fn).toBe("saveActiveComp");
                hostReplyHex = host.run(args[0], args[1], args[2], args[3]);
                return hostReplyHex;
            },
        });

        panel.confirmSave();
        await jest.runAllTimersAsync();

        // ── Link 0: the destructive-window protocol is untouched ─────────
        expect(host.counters.seq).toEqual(COMP_SAVE_SEQUENCE);
        expect(host.counters.saveCalls.length).toBe(2);
        expect(host.counters.reduceCalls).toBe(1);
        expect(host.counters.openCalls.length).toBe(1);
        expect(host.counters.undoBegin).toBe(host.counters.undoEnd);
        expect(host.counters.suppressBegin).toBe(host.counters.suppressEnd);

        // ── Link 1 (1.1): a completed save is REPORTED as completed ──────
        const decoded = panelBridge.decodeBridge(hostReplyHex);
        expect(decoded.indexOf("Error:")).toBe(-1);
        const hostResult = JSON.parse(decoded);
        expect(hostResult.ok).toBe(true);
        expect(hostResult.folderPath).toBe("C:/lib/comp/Titles/My Title");
        expect(hostResult.renderComp).toBe("My Title");
        expect(hostResult.renderFrame).toBe(75);   // (0 + 10 * 0.3) * 25 fps
        expect(panel.errorToasts()).toEqual([]);

        // F5: the panel's OWN derivation of the same folder now agrees with the
        // host's, which is what makes the card and the metadata cache key on a
        // folder that exists.
        const panelDerived = "C:/lib/comp/" + pathBuilders.getSafeName("Titles") +
            "/" + pathBuilders.generateTemplateId("My Title");
        expect(panelDerived).toBe(hostResult.folderPath);

        // ── Link 2: the optimistic card, at the head of the REAL index ───
        expect(panel.cardRenders.length).toBe(1);
        const entries = panel.libraryIndex.entries();
        expect(entries.length).toBe(1);
        expect(entries[0].folderPath).toBe(normalizeFolderPath(hostResult.folderPath));
        expect(entries[0].thumbStatus).toBe("placeholder");   // 3.23
        expect(panel.allTemplates[0].folderPath).toBe(hostResult.folderPath);
        expect(panel.libraryIndex.needsFullScan()).toBe(false);
        // A re-render from memory, NOT a Library_Scan.
        expect(panel.rerenders).toEqual(["filterAndRender"]);

        // ── Link 3 (1.10): meta.json carries the format AND assetsDir ────
        const meta = panel.metaJson(hostResult.folderPath);
        expect(meta).not.toBeNull();
        expect(meta.schemaVersion).toBe(2);
        expect(meta.mainFile).toBe("project.aep");
        expect(meta.section).toBe("comp");
        expect(meta.type).toBe("comp");
        expect(meta.width).toBe(1920);
        expect(meta.height).toBe(1080);
        expect(meta.dim).toBe("1920x1080");
        expect(meta.pixelAspect).toBe(1);
        expect(meta.frameRate).toBe(25);
        expect(meta.duration).toBe(10);
        expect(meta.assetsDir).toBe("");    // no assets copied, but the key IS written

        // ── Link 4 (1.11a): the job carries the recorded render target ───
        expect(panel.thumbJobs.length).toBe(1);
        const job = panel.thumbJobs[0];
        expect(job.aep).toBe("C:/lib/comp/Titles/My Title/project.aep");
        expect(job.thumb).toBe("C:/lib/comp/Titles/My Title/thumbnail.png");
        expect(job.compName).toBe("My Title");
        expect(job.renderFrame).toBe(75);
        expect(panel.previewJobs.length).toBe(1);

        // ── Link 5 (1.11b): the host is called with FOUR arguments and
        //    renders the NAMED comp at renderFrame / frameRate ─────────────
        const thumbHost = buildThumbnailHostRealm({ compName: "My Title", frameRate: 25, duration: 10 });
        const issued = [];
        const queue = buildThumbnailQueueRealm(function (jsx, cb) {
            issued.push(jsx);
            const a = hostArgs(jsx);
            cb(thumbHost.ctx.renderTemplateThumbnail(a[0], a[1], a[2], a[3]));
        });

        // The REAL panel queue entry point builds the job from the panel's own
        // 5-argument enqueue call.
        queue.ctx.enqueueThumbnailRender(job.aep, job.thumb, job.cb, job.compName, job.renderFrame);
        expect(queue.queue.length).toBe(1);
        expect(queue.queue[0].compName).toBe("My Title");
        expect(queue.queue[0].renderFrame).toBe(75);

        // drainThumbnailJob's terminal-success path is exactly `job.cb(err)`.
        const queued = queue.queue[0];
        let thumbErr = "unset";
        queue.ctx.runOneThumbnail(queued, function (err) { thumbErr = err; if (queued.cb) queued.cb(err); });
        await jest.runAllTimersAsync();

        expect(issued.length).toBe(1);
        expect(hostFnName(issued[0])).toBe("renderTemplateThumbnail");
        const thumbArgs = hostArgs(issued[0]);
        expect(thumbArgs.length).toBe(4);
        expect(panelBridge.decodeBridge(thumbArgs[0])).toBe(job.aep);
        expect(panelBridge.decodeBridge(thumbArgs[1])).toBe(job.thumb);
        expect(panelBridge.decodeBridge(thumbArgs[2])).toBe("My Title");
        expect(panelBridge.decodeBridge(thumbArgs[3])).toBe("75");

        expect(thumbErr).toBe(null);
        expect(thumbHost.rendered.length).toBe(1);
        expect(thumbHost.rendered[0].comp).toBe("My Title");        // NOT the decoy
        expect(thumbHost.rendered[0].time).toBeCloseTo(3, 6);       // 75 / 25 fps
        // 3.26/3.27: the live project was never touched and the scratch import
        // was always discarded; 2.12: the borrowed playhead came back.
        expect(thumbHost.touched.filter((t) => /project\.file|app\.open/.test(t))).toEqual([]);
        expect(thumbHost.removed).toContain("importedFolder");
        expect(thumbHost.targetComp.time).toBe(7);
        expect(thumbHost.suppress.begin).toBe(thumbHost.suppress.end);
        // The template folder was marked busy for the render and released once.
        expect(queue.busy).toEqual([
            { op: "busy", folder: "C:/lib/comp/Titles/My Title" },
            { op: "clear", folder: "C:/lib/comp/Titles/My Title" },
        ]);

        // The card's placeholder is flipped for that ONE folder only.
        expect(panel.thumbRefreshes).toEqual([{
            folder: "C:/lib/comp/Titles/My Title",
            thumb: "C:/lib/comp/Titles/My Title/thumbnail.png",
        }]);
    });
});

// ============================================================
// FLOW 2 — a save whose reopen fails is reported as a failure (2.5, 3.21, 3.22)
//
// saveActiveComp answers with the STRUCTURED
// { ok:false, reopenFailed:true, folderPath, templateFile, error } envelope
// (task 5's choice, so the panel's parseEssential classifies it as an ESSENTIAL
// failure through its existing `{`-prefixed branch instead of being inferred
// from a bare string). coreSaveLayerType keeps the bare-string form because its
// callers branch on `typeof`.
// ============================================================
describe("FLOW 2 — a failing reopen surfaces as an error naming the template, with no background work", () => {
    test("the user sees the template path, no card is rendered, nothing is scheduled", async () => {
        const host = buildCompSaveRealm({ openThrows: true });

        const panel = makePanelHarness({
            name: "My Title",
            category: "Titles",
            rootPath: "C:/lib",
            onHostCall: function (fn, args) { return host.run(args[0], args[1], args[2], args[3]); },
        });

        panel.confirmSave();
        await jest.runAllTimersAsync();

        // The host really did leave the session pointed at the library template
        // — which is precisely why ok:true would be a lie.
        expect(host.app.project.file.fsName).toBe("C:/lib/comp/Titles/My Title/project.aep");
        expect(host.counters.openCalls.length).toBe(1);
        expect(host.counters.suppressBegin).toBe(host.counters.suppressEnd);

        // The structured envelope, classified as an essential failure.
        const errs = panel.errorToasts();
        expect(errs.length).toBeGreaterThanOrEqual(1);
        const joined = errs.map((t) => t.msg).join(" | ");
        expect(joined).toContain("C:/lib/comp/Titles/My Title/project.aep");
        expect(joined).toMatch(/reopen/i);

        // 3.21/3.22: loading exited exactly once, and NO background work ran.
        expect(panel.DOM["btn-confirm-save"].disabled).toBe(false);
        expect(panel.DOM["btn-confirm-save"].textContent).toBe("Save");
        expect(panel.cardRenders).toEqual([]);
        expect(panel.libraryIndex.entries()).toEqual([]);
        expect(panel.thumbJobs).toEqual([]);
        expect(panel.previewJobs).toEqual([]);
        expect(panel.fsCalls).toEqual([]);            // no meta.json, no .fav, no rm
        expect(panel.bgActivity).toEqual([]);         // no background indicator
        expect(panel.thumbRefreshes).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────
// itemExists realm — the REAL host itemExists over an in-memory library.
// jsonParse is absent by design (its body defeats a brace walk), so the
// documented `typeof jsonParse === "function" ? … : JSON.parse(…)` FALLBACK
// branch runs — the same fallback tests/import-timings.test.js relies on.
// ─────────────────────────────────────────────────────────────
function buildItemExistsRealm(disk) {
    const probes = [];

    function FolderFake(p) {
        const norm = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
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

    return {
        ctx, probes,
        /** Answer the panel's own itemExists scriptCall arguments. */
        answer: function (args) {
            probes.length = 0;
            return ctx.itemExists(args[0], args[1], args[2], args[3]);
        },
    };
}

// ============================================================
// FLOW 3 — re-save over an existing template (2.13, 2.14, 3.23)
//
// itemExists now answers with the encoded {exists,id,section} envelope and the
// panel passes the section as a FOURTH argument. That makes `oldId` real for the
// first time, which is what reaches the previously DEAD .fav-preservation and
// old-folder-removal branch (js/templates/templates.js:3412-3427).
// ============================================================
describe("FLOW 3 — itemExists envelope → prompt → real oldId → .fav preserved → old folder removed", () => {
    test("an existing folder under a DIFFERENT id is prompted for, carried as oldId, and swept", async () => {
        const existing = buildItemExistsRealm({
            folders: {
                "C:/lib/comp/Titles": ["My_Title_legacy"],
                "C:/lib/comp/Titles/My_Title_legacy": [],
            },
            texts: { "C:/lib/comp/Titles/My_Title_legacy/meta.json": '{"name":"My Title"}' },
        });
        const host = buildCompSaveRealm({});

        const panel = makePanelHarness({
            name: "My Title",
            category: "Titles",
            rootPath: "C:/lib",
            confirmOverwrite: true,
            confirmAnswer: true,
            favPaths: ["C:/lib/comp/Titles/My_Title_legacy/.fav"],
            onItemExists: function (args) { return existing.answer(args); },
            onHostCall: function (fn, args) { return host.run(args[0], args[1], args[2], args[3]); },
        });

        panel.confirmSave();
        await jest.runAllTimersAsync();

        // ── 2.14: the section actually being saved rides as the 4th argument ──
        const existsCall = panel.hostCalls.filter((c) => c.fn === "itemExists");
        expect(existsCall.length).toBe(1);
        expect(existsCall[0].args.length).toBe(4);
        expect(panelBridge.decodeBridge(existsCall[0].args[3])).toBe("comp");
        // …and that is the section the host actually searched: the FIRST folder
        // it probed is the requested section's category folder, and no other
        // section was swept (the sectionless legacy call sweeps all seven).
        expect(existing.probes[0]).toBe("C:/lib/comp/Titles");
        expect(existing.probes.filter((p) => p.indexOf("/comp/") === -1)).toEqual([]);

        // ── 2.13: exists === true, so the overwrite prompt appeared ───────
        expect(panel.confirms.length).toBe(1);
        expect(panel.confirms[0]).toContain("My Title");

        // …and the id of the folder that ACTUALLY exists rode to the host.
        const saveCalls = panel.saveCalls();
        expect(saveCalls.length).toBe(1);
        expect(saveCalls[0].fn).toBe("saveActiveComp");
        expect(panelBridge.decodeBridge(saveCalls[0].args[3])).toBe("My_Title_legacy");

        const meta = panel.metaJson("C:/lib/comp/Titles/My Title");
        expect(meta).not.toBeNull();

        // ── The previously DEAD branch actually ran, in order ─────────────
        const ops = panel.fsCalls.map((c) => c.op + " " + c.path);
        expect(ops).toContain("access C:/lib/comp/Titles/My_Title_legacy/.fav");
        expect(ops).toContain("writeFile C:/lib/comp/Titles/My Title/.fav");
        expect(ops).toContain("rm C:/lib/comp/Titles/My_Title_legacy");
        expect(ops.indexOf("access C:/lib/comp/Titles/My_Title_legacy/.fav"))
            .toBeLessThan(ops.indexOf("rm C:/lib/comp/Titles/My_Title_legacy"));

        // One card, at the head, for the NEW folder.
        const entries = panel.libraryIndex.entries();
        expect(entries.length).toBe(1);
        expect(entries[0].folderPath).toBe(normalizeFolderPath("C:/lib/comp/Titles/My Title"));
        expect(panel.errorToasts()).toEqual([]);
    });

    test("declining the overwrite prompt issues no save at all", async () => {
        const existing = buildItemExistsRealm({
            folders: { "C:/lib/comp/Titles": ["My Title"], "C:/lib/comp/Titles/My Title": [] },
            texts: { "C:/lib/comp/Titles/My Title/meta.json": '{"name":"My Title"}' },
        });
        const panel = makePanelHarness({
            name: "My Title", category: "Titles", rootPath: "C:/lib",
            confirmOverwrite: true, confirmAnswer: false,
            onItemExists: function (args) { return existing.answer(args); },
            onHostCall: function () { throw new Error("no save may be issued after a declined overwrite"); },
        });

        panel.confirmSave();
        await jest.runAllTimersAsync();

        expect(panel.confirms.length).toBe(1);
        expect(panel.saveCalls()).toEqual([]);
        expect(panel.libraryIndex.entries()).toEqual([]);
        expect(panel.DOM["btn-confirm-save"].disabled).toBe(false);
    });

    test("3.23 — re-saving the SAME id replaces one entry at the head instead of duplicating", async () => {
        const existing = buildItemExistsRealm({
            folders: { "C:/lib/comp/Titles": ["My Title"], "C:/lib/comp/Titles/My Title": [] },
            texts: { "C:/lib/comp/Titles/My Title/meta.json": '{"name":"My Title"}' },
        });
        const host = buildCompSaveRealm({});
        const panel = makePanelHarness({
            name: "My Title", category: "Titles", rootPath: "C:/lib",
            onItemExists: function (args) { return existing.answer(args); },
            onHostCall: function (fn, args) { return host.run(args[0], args[1], args[2], args[3]); },
        });

        // The library already holds this template plus two neighbours.
        const target = normalizeFolderPath("C:/lib/comp/Titles/My Title");
        panel.libraryIndex.insertAtHead({ folderPath: "C:/lib/comp/Titles/Other A", name: "Other A", category: "Titles" });
        panel.libraryIndex.insertAtHead({ folderPath: "C:/lib/comp/Titles/My Title", name: "My Title (old)", category: "Titles" });
        panel.libraryIndex.insertAtHead({ folderPath: "C:/lib/comp/Titles/Other B", name: "Other B", category: "Titles" });
        const before = panel.libraryIndex.entries().map((e) => e.folderPath);
        expect(before.length).toBe(3);

        panel.confirmSave();
        await jest.runAllTimersAsync();

        // exists:true with the SAME id, so oldId === templateId: nothing removed.
        expect(panelBridge.decodeBridge(panel.saveCalls()[0].args[3])).toBe("My Title");
        expect(panel.fsCalls.filter((c) => c.op === "rm")).toEqual([]);
        expect(panel.fsCalls.filter((c) => c.op === "access")).toEqual([]);

        const after = panel.libraryIndex.entries().map((e) => e.folderPath);
        expect(after.length).toBe(3);                                   // no duplicate
        expect(after[0]).toBe(target);                                  // at the head
        expect(after.filter((p) => p === target).length).toBe(1);       // exactly one
        expect(after.slice(1)).toEqual(before.filter((p) => p !== target));
        expect(panel.libraryIndex.needsFullScan()).toBe(false);
        expect(panel.errorToasts()).toEqual([]);
    });
});

// ============================================================
// FLOW 4 — layer save through coreSaveLayerType (2.9, and the F2c capture)
//
// The engine's OBJECT result must reach the panel (1.2 turned it into a
// "Save Error: …" string), meta.json must carry layerState, and the recorded
// destructive-window protocol must be untouched.
// ============================================================
describe("FLOW 4 — coreSaveLayerType's object result reaches the panel and meta.json", () => {
    test("the engine returns an object carrying layerState AND the pre-window format capture", () => {
        const core = buildLayerSaveRealm({});
        const res = core.runCore("Spin Rig", "Shapes", "layer");

        // 1.2: an object, not a "Save Error: …" string.
        expect(typeof res).toBe("object");
        expect(res.ok).toBe(true);
        expect(res.folderPath).toBe("C:/lib/layer/Shapes/Spin Rig");
        // The exact captured object flows through — identity, not a copy.
        expect(res.layerState).toBe(core.capturedState);
        expect(res.layerCount).toBe(1);     // one selected layer
        // F2c: the format, read from the pre-reopen capture rather than from a
        // comp reduceProject removed and app.open invalidated.
        expect(res.width).toBe(1280);
        expect(res.height).toBe(720);
        expect(res.pixelAspect).toBe(2);
        expect(res.frameRate).toBe(24);
        expect(res.duration).toBe(4);
        expect(res.renderComp).toBe("Spin Rig");
        expect(res.renderFrame).toBe(29);   // round((0 + 4 * 0.3) * 24)

        // The recorded protocol and counters, unchanged.
        expect(core.counters.seq).toEqual(LAYER_SAVE_SEQUENCE);
        expect(core.counters.saveCalls.length).toBe(2);
        expect(core.counters.reduceCalls).toBe(1);
        expect(core.counters.openCalls.length).toBe(1);
        expect(core.counters.undoBegin).toBe(core.counters.undoEnd);
        expect(core.counters.suppressBegin).toBe(core.counters.suppressEnd);
    });

    test("saveActiveLayer → panel → meta.json records layerState and the layer facts", async () => {
        const host = buildLayerSaveRealm({});
        const panel = makePanelHarness({
            name: "Spin Rig",
            category: "Shapes",
            rootPath: "C:/lib",
            selectedSaveType: "layer",
            currentSection: "layer",
            onHostCall: function (fn, args) {
                expect(fn).toBe("saveActiveLayer");
                return host.ctx.saveActiveLayer(args[0], args[1], args[2], args[3]);
            },
        });

        panel.confirmSave();
        await jest.runAllTimersAsync();

        expect(panel.errorToasts()).toEqual([]);
        // 2.14: the layer section — not a "comp" default — was checked.
        expect(panelBridge.decodeBridge(
            panel.hostCalls.filter((c) => c.fn === "itemExists")[0].args[3])).toBe("layer");

        const folderPath = "C:/lib/layer/Shapes/Spin Rig";
        const meta = panel.metaJson(folderPath);
        expect(meta).not.toBeNull();
        expect(meta.section).toBe("layer");
        expect(meta.type).toBe("layer");
        // Round-tripped through the host's jsonStringify and the panel's
        // JSON.parse, switches AND markers intact.
        expect(meta.layerState).toEqual({
            switches: { enabled: true, threeDLayer: true },
            markers: [{ t: 0.5, comment: "hit" }],
        });
        expect(meta.layerCount).toBe(1);
        expect(meta.isAdjustment).toBe(false);
        expect(meta.is3D).toBe(true);
        expect(meta.blendMode).toBe(3);
        expect(meta.label).toBe(9);
        expect(meta.mainFile).toBe("project.aep");
        expect(meta.schemaVersion).toBe(2);
        // 2.10 keys assetsDir off the comp section, so a layer save writes none.
        expect("assetsDir" in meta).toBe(false);

        // The destructive-window protocol is identical to the standalone run.
        expect(host.counters.seq).toEqual(LAYER_SAVE_SEQUENCE);
        expect(host.counters.reduceCalls).toBe(1);
        expect(host.counters.openCalls.length).toBe(1);
        expect(host.counters.undoBegin).toBe(host.counters.undoEnd);
        expect(host.counters.suppressBegin).toBe(host.counters.suppressEnd);

        // One card at the head of the real index.
        const entries = panel.libraryIndex.entries();
        expect(entries.length).toBe(1);
        expect(entries[0].folderPath).toBe(normalizeFolderPath(folderPath));
    });

    // ── PRODUCTION GAP, reported not patched ─────────────────────────────
    // coreSaveLayerType captures width/height/pixelAspect/frameRate/duration and
    // renderComp/renderFrame (proven above), but every wrapper that fronts it —
    // saveActiveLayer (jsx/templates_save.jsx:1391-1408), saveActiveText
    // (:1481-1493), saveActiveTextProperties (:1545-1557) and saveActiveFootage
    // (:1595-1607) — rebuilds its own resObj and copies only folderPath,
    // assetsList, layerCount and the layer switches. The five format fields,
    // renderComp, renderFrame and needsThumbnail are dropped at that boundary, so
    // the panel never sees them: a layer/text/footage meta.json carries no
    // width/height/dim, and no background thumbnail is ever enqueued for one.
    //
    // Requirement 2.9 is worded "WHEN a comp template is saved", so the comp path
    // (FLOW 1) satisfies the spec as written; this is the same class of defect as
    // 1.9/1.10 one section over, and F2c's capture is currently delivered nowhere.
    //
    // `test.failing` is deliberate: the suite stays green while the gap exists AND
    // fails loudly the moment a wrapper starts forwarding, so this can never
    // ossify into a pinned bug.
    test.failing(
        "PRODUCTION GAP — a layer save's meta.json carries the format fields coreSaveLayerType captured",
        async () => {
            const host = buildLayerSaveRealm({});
            const panel = makePanelHarness({
                name: "Spin Rig", category: "Shapes", rootPath: "C:/lib",
                selectedSaveType: "layer", currentSection: "layer",
                onHostCall: function (fn, args) {
                    return host.ctx.saveActiveLayer(args[0], args[1], args[2], args[3]);
                },
            });

            panel.confirmSave();
            await jest.runAllTimersAsync();

            const meta = panel.metaJson("C:/lib/layer/Shapes/Spin Rig");
            expect(meta.width).toBe(1280);
            expect(meta.height).toBe(720);
            expect(meta.dim).toBe("1280x720");
            expect(meta.pixelAspect).toBe(2);
            expect(meta.frameRate).toBe(24);
            expect(meta.duration).toBe(4);
            // …and the recorded render target reaches the background queue.
            expect(panel.thumbJobs.length).toBe(1);
            expect(panel.thumbJobs[0].compName).toBe("Spin Rig");
            expect(panel.thumbJobs[0].renderFrame).toBe(29);
        }
    );
});

// ============================================================
// FLOW 5 — a 5-template batch with template 3 failing
//   (2.18, 2.19, 2.20, 2.22, 3.11)
//
// The REAL batching client (js/core/importEngine.js) over the REAL host
// importBatch, so "exactly ONE Bridge_Call" and "one undo group" are the same
// fact measured from both sides of the transport.
// ============================================================
describe("FLOW 5 — batch import: one call, one group, total result, scoped rollback, one container", () => {
    test("template 3 fails; 1/2/4/5 land, its own items are gone, every template anchors to the ORIGINAL selection", async () => {
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        const top = h.model.appendLayer(comp, "BG");          // duplicate name, on purpose
        const chosen = h.model.appendLayer(comp, "BG");        // the layer the user selected
        const bottom = h.model.appendLayer(comp, "Bottom");
        chosen.selected = true;
        h.model.project.activeItem = comp;

        let seq = 0;
        const perTemplateItems = {};
        h.model.project.__importer = function () {
            seq++;
            const folder = h.model.makeItem("folder", "T" + seq + " Folder");
            const made = [folder];
            if (seq === 3) {
                // An .aep that yields footage but NO composition → the
                // "No comp found!" early return, which used to leak every item.
                made.push(h.model.makeItem("footage", "orphan.mp4", folder));
            } else {
                made.push(h.model.makeComp("Template " + seq, folder));
                made.push(h.model.makeItem("footage", "clip" + seq + ".mp4", folder));
            }
            perTemplateItems[seq] = made.map((it) => it.id);
            return folder;
        };

        const idsBefore = h.model.itemIds();

        // The REAL Import_Engine, with the host reached exactly the way
        // importCurrentCardToTimeline reaches it.
        const templates = [1, 2, 3, 4, 5].map((n) => ({
            id: "t" + n, name: "T" + n, category: "Cat", section: "comp", sourcePath: "C:/lib",
        }));
        let bridgeCalls = 0;
        const result = await new Promise((resolve) => {
            importTemplates(
                {
                    callHost: function (payloadHex, cb) {
                        bridgeCalls++;
                        cb(h.ctx.importBatch(payloadHex));
                    },
                    resolveCached: function () { return null; },
                    encode: panelBridge.encodeBridge,
                    decode: panelBridge.decodeBridge,
                    timeoutMs: 130000,
                },
                { rootPath: "C:/lib", templates: templates },
                resolve
            );
        });

        // ── ONE Bridge_Call ──────────────────────────────────────────────
        expect(bridgeCalls).toBe(1);
        expect(result.bridgeCalls).toBe(1);

        // ── ONE undo group for the whole action (3.8/3.9) ────────────────
        expect(h.counters.undoBegin).toBe(1);
        expect(h.counters.undoEnd).toBe(1);
        expect(h.counters.seq.filter((s) => s.indexOf("beginUndoGroup") === 0))
            .toEqual(["beginUndoGroup:CompSaver Import"]);
        // The per-section routines were suppressed because the batch owns the group.
        expect(h.guardDuringImport.every((g) => g === true)).toBe(true);
        // Suppression around importFile stayed balanced (3.15).
        expect(h.counters.suppressBegin).toBe(5);
        expect(h.counters.suppressEnd).toBe(5);

        // ── 3.11: total over the input, in INPUT ORDER ───────────────────
        expect(result.perTemplate.length).toBe(5);
        expect(result.perTemplate.map((e) => e.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
        expect(result.perTemplate.map((e) => e.status))
            .toEqual(["imported", "imported", "failed", "imported", "imported"]);
        expect(result.perTemplate[2].reason).toBe("No comp found!");

        // ── 2.18: template 3's items are gone, 1/2/4/5 intact ────────────
        const idsAfter = h.model.itemIds();
        perTemplateItems[3].forEach((id) => expect(idsAfter).not.toContain(id));
        [1, 2, 4, 5].forEach((n) => {
            perTemplateItems[n].forEach((id) => expect(idsAfter).toContain(id));
        });
        // Nothing pre-existing was touched.
        idsBefore.forEach((id) => expect(idsAfter).toContain(id));

        // ── 2.22: every template anchored to the layer the user selected ──
        // (getTopSelectedLayer is recorded by identity; the latch capture plus
        // one resolution per template.)
        expect(h.anchorLog.length).toBeGreaterThanOrEqual(5);
        h.anchorLog.forEach((a) => expect(a).toBe(chosen));
        // …and the imported layers really do sit directly above it.
        const importedLayers = comp.__layers.filter((l) => /^Template /.test(l.name));
        expect(importedLayers.length).toBe(4);

        // ── 2.19/2.20: ONE container, no empty folder at the panel root ───
        const rootFolderNames = h.model.rootFolders().map((f) => f.name);
        expect(rootFolderNames).toEqual(["_CompSaver_Assets"]);
        expect(h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);
        // Exactly one addFolder for the container across the whole batch.
        const containerAdds = h.model.mutations
            .filter((m) => m.op === "addFolder" && m.name === "_CompSaver_Assets");
        expect(containerAdds.length).toBe(1);

        // ── The user's pre-action selection is back at the end ────────────
        expect(chosen.selected).toBe(true);
        expect(top.selected).toBe(false);
        expect(bottom.selected).toBe(false);
        expect(comp.selectedLayers).toEqual([chosen]);
        // The latch is cleared, so a later standalone import is unaffected.
        expect(h.ctx.__CS_IMPORT_BATCH_ANCHOR).toBe(null);
        expect(h.ctx.__CS_IMPORT_BATCH_ACTIVE).toBe(false);
    });
});

// ============================================================
// FLOW 6 — a host that never returns (2.17)
//
// The REAL importCurrentCardToTimeline over the REAL timeout-guarded callHost.
// Before F8f this call site used csInterface.evalScript directly, so a
// never-returning host left `.importing` on the card forever, with no toast and
// no way to retry, and a CEP "EvalScript error." sentinel was fed to
// decodeBridge as if it were hex.
// ============================================================
describe("FLOW 6 — a never-returning host still settles, clears .importing and names the timeout", () => {
    function makeCardFake() {
        const classes = {};
        return {
            dataset: { file: "T1", cat: "Cat", folder: "C:/lib/comp/Cat/T1" },
            style: { transform: "" },
            classList: {
                add: function (c) { classes[c] = true; },
                remove: function (c) { delete classes[c]; },
                contains: function (c) { return classes[c] === true; },
            },
            __classes: classes,
        };
    }

    test("the transport's own timeout settles the action, the card is cleaned up and the project is untouched", async () => {
        const host = buildImportRealm({});
        const comp = host.model.makeComp("Active Comp");
        host.model.appendLayer(comp, "Existing");
        host.model.project.activeItem = comp;
        const idsBefore = host.model.itemIds();

        const card = makeCardFake();
        const evalCalls = [];
        const panel = makePanelHarness({
            rootPath: "C:/lib",
            // The host is never reached: evalScript records the call and never
            // invokes its callback.
            onHostCall: function () { throw new Error("unreachable in this flow"); },
        });
        // Swap in the never-returning transport for the import path only.
        panel.handle.context.callHost = function (scriptCall, options) {
            return panelBridge.callHost(scriptCall, Object.assign({}, options || {}, {
                csInterface: { evalScript: function (s) { evalCalls.push(s); } },
            }));
        };

        panel.importCurrentCardToTimeline(card);
        expect(card.classList.contains("importing")).toBe(true);   // instant feedback

        // The transport owns the 120s timeout; the engine's deps.timeoutMs
        // backstop sits at 130s so it never pre-empts a live call.
        await jest.advanceTimersByTimeAsync(119000);
        expect(card.classList.contains("importing")).toBe(true);
        await jest.advanceTimersByTimeAsync(2000);

        expect(evalCalls.length).toBe(1);
        expect(hostFnName(evalCalls[0])).toBe("importBatch");

        // The card is cleaned up and the user is told what happened.
        expect(card.classList.contains("importing")).toBe(false);
        expect(card.classList.contains("imported")).toBe(false);
        const errs = panel.errorToasts();
        expect(errs.length).toBe(1);
        expect(errs[0].msg).toMatch(/timed out/i);
        expect(errs[0].msg).toMatch(/After Effects did not respond/i);

        // The project is unmodified: the host never ran a single DOM operation.
        expect(host.model.itemIds()).toEqual(idsBefore);
        expect(host.model.mutations).toEqual([]);
        expect(host.counters.undoBegin).toBe(0);

        // The ordering the two timeouts depend on, as production wires it.
        expect(TEMPLATES_JS).toContain("{ timeoutMs: 120000 }");
        expect(TEMPLATES_JS).toContain("timeoutMs: 130000");

        await jest.advanceTimersByTimeAsync(20000);   // the 130s backstop window
        expect(panel.errorToasts().length).toBe(1);   // still exactly one outcome
    });

    test('a CEP "EvalScript error." sentinel is reported as a host error, not decoded as hex', async () => {
        const card = makeCardFake();
        const panel = makePanelHarness({ rootPath: "C:/lib" });
        panel.handle.context.callHost = function (scriptCall, options) {
            return panelBridge.callHost(scriptCall, Object.assign({}, options || {}, {
                csInterface: { evalScript: function (s, cb) { cb("EvalScript error."); } },
            }));
        };

        panel.importCurrentCardToTimeline(card);
        await jest.runAllTimersAsync();

        expect(card.classList.contains("importing")).toBe(false);
        const errs = panel.errorToasts();
        expect(errs.length).toBe(1);
        expect(errs[0].msg).toContain("EvalScript error.");
    });
});

// ============================================================
// FLOW 7 — a solid-only template import (2.19, 2.20)
//
// needsAssets used to gate the whole reparent block, so a template whose only
// footage is a solid left the emptied FolderItem that importFile created sitting
// at the Project-panel root.
// ============================================================
describe("FLOW 7 — a solid-only import leaves nothing loose at the Project-panel root", () => {
    test("the solid footage lives under _CompSaver_Assets and the root holds no empty folder", () => {
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        h.model.appendLayer(comp, "Existing");
        h.model.project.activeItem = comp;

        let importedFolder = null;
        let solidFootage = null;
        h.model.project.__importer = function () {
            importedFolder = h.model.makeItem("folder", "Solid Only Folder");
            h.model.makeComp("Solid Only", importedFolder);
            solidFootage = h.model.makeItem("footage", "Red Solid 1", importedFolder);
            solidFootage.mainSource = { __kind: "solidSource" };
            return importedFolder;
        };

        const enc = h.ctx.encodeBridge;
        const reply = h.ctx.decodeBridge(
            h.ctx.importCompDirect(enc("Solid Only"), enc("Cat"), enc("C:/lib"), "comp"));
        expect(reply).toBe("true");

        // Nothing loose at the root: only the fixed-name container.
        const rootFolderNames = h.model.rootFolders().map((f) => f.name);
        expect(rootFolderNames).toEqual(["_CompSaver_Assets"]);
        expect(h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);

        // The solid footage sits under the container (no Assets subfolder is
        // created for a solid-only import — a solid is not a relinkable asset).
        expect(solidFootage.parentFolder.name).toBe("_CompSaver_Assets");
        expect(h.model.rootFolder.__children.indexOf(solidFootage)).toBe(-1);

        // The FolderItem importFile created is REPARENTED under the container,
        // never removed: it is an item a SUCCESSFUL import created, and
        // Preservation 3.10 forbids removing those. It is simply no longer at
        // the Project-panel root, which is what 2.20 asks for.
        expect(importedFolder.__removed).toBeUndefined();
        expect(importedFolder.parentFolder.name).toBe("_CompSaver_Assets");

        // A standalone import still owns exactly one balanced undo group.
        expect(h.counters.undoBegin).toBe(1);
        expect(h.counters.undoEnd).toBe(1);
        expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
    });

    test("three successive solid-only imports still add exactly ONE root folder", () => {
        const h = buildImportRealm({});
        const comp = h.model.makeComp("Active Comp");
        h.model.project.activeItem = comp;

        let n = 0;
        h.model.project.__importer = function () {
            n++;
            const folder = h.model.makeItem("folder", "Solid Folder " + n);
            h.model.makeComp("Solid " + n, folder);
            const solid = h.model.makeItem("footage", "Red Solid " + n, folder);
            solid.mainSource = { __kind: "solidSource" };
            return folder;
        };

        const enc = h.ctx.encodeBridge;
        for (let i = 0; i < 3; i++) {
            expect(h.ctx.decodeBridge(
                h.ctx.importCompDirect(enc("Solid"), enc("Cat"), enc("C:/lib"), "comp"))).toBe("true");
        }

        expect(h.model.rootFolders().map((f) => f.name)).toEqual(["_CompSaver_Assets"]);
        expect(h.model.mutations.filter(
            (m) => m.op === "addFolder" && m.name === "_CompSaver_Assets").length).toBe(1);
        expect(h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);
    });
});

// ============================================================
// FLOW 8 — startup library scan after the fixes (3.14, 3.30, 2.9/2.10, 2.26)
//
// Three things have to hold at the same time on a real library:
//   (a) the scan is still section-chunked — one enumeration per root, and no
//       other section's tree is touched, with the migration guard firing once
//       per engine session;
//   (b) a library holding BOTH pre-F6a and post-F6a meta.json documents scans
//       identically — the new keys are additive and the old records still carry
//       their `dim`;
//   (c) folders whose names were produced by the PRE-FIX panel derivation still
//       resolve, because the canonical sanitizer was designed not to re-key an
//       existing folder.
// ============================================================
describe("FLOW 8 — the library scan after the fixes", () => {
    const SECTIONS = ["comp", "layer", "text", "footage", "effect", "icon", "overlay"];

    function libraryDisk() {
        const disk = { folders: { "C:/lib": SECTIONS.slice() }, texts: {} };
        SECTIONS.forEach((s) => {
            disk.folders["C:/lib/" + s] = ["Cat"];
            disk.folders["C:/lib/" + s + "/Cat"] = ["Item"];
            disk.folders["C:/lib/" + s + "/Cat/Item"] = ["meta.json"];
            disk.texts["C:/lib/" + s + "/Cat/Item/meta.json"] =
                '{"name":"' + s + '-item","type":"' + s + '","section":"' + s + '"}';
        });
        return disk;
    }

    test("(a) one section-chunked enumeration per root, and one migration per engine session", () => {
        const disk = libraryDisk();
        const h = buildScanHarness(disk);

        const compRecords = h.scan("C:/lib", "comp");
        expect(compRecords.length).toBe(1);
        expect(compRecords[0].section).toBe("comp");

        const roots = h.enumerated.filter((p) => /^C:\/lib\/[a-z]+$/.test(p));
        expect(roots).toEqual(["C:/lib/comp"]);          // exactly one, exactly once
        SECTIONS.filter((s) => s !== "comp").forEach((s) => {
            expect(h.enumerated.indexOf("C:/lib/" + s)).toBe(-1);
        });

        // A second chunk touches only ITS root; the migration guard does not re-fire.
        const before = h.enumerated.length;
        const layerRecords = h.scan("C:/lib", "layer");
        expect(layerRecords.length).toBe(1);
        expect(layerRecords[0].section).toBe("layer");
        expect(h.enumerated.slice(before).filter((p) => /^C:\/lib\/[a-z]+$/.test(p)))
            .toEqual(["C:/lib/layer"]);

        h.scan("C:/lib", "comp");
        h.scan("C:/lib", "");
        expect(h.migrations).toEqual(["C:/lib"]);        // once per engine session
    });

    test("(b) a library holding BOTH old and new meta.json documents scans identically", () => {
        // The pre-F6a document: no format keys at all, `dim` written by hand.
        const oldDoc = JSON.stringify({
            name: "Old Template", type: "comp", section: "comp",
            dim: "1920x1080", thumbnail: "thumbnail.png",
        });
        // The post-F6a document, exactly as FLOW 1 wrote it.
        const newDoc = JSON.stringify({
            schemaVersion: 2, id: "New Template", name: "New Template",
            section: "comp", type: "comp", category: "Cat",
            mainFile: "project.aep", thumbnail: "thumbnail.png",
            width: 3840, height: 2160, dim: "3840x2160",
            pixelAspect: 1, frameRate: 60, duration: 4.5,
            hasFrames: false, frameCount: 0, assetsDir: "assets/",
            createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
        });
        const disk = {
            folders: {
                "C:/lib": ["comp"],
                "C:/lib/comp": ["Cat"],
                "C:/lib/comp/Cat": ["Old Template", "New Template", "No Meta"],
                "C:/lib/comp/Cat/Old Template": ["meta.json", "thumbnail.png"],
                "C:/lib/comp/Cat/New Template": ["meta.json", "thumbnail.png"],
                "C:/lib/comp/Cat/No Meta": [],
            },
            texts: {
                "C:/lib/comp/Cat/Old Template/meta.json": oldDoc,
                "C:/lib/comp/Cat/Old Template/thumbnail.png": "png",
                "C:/lib/comp/Cat/New Template/meta.json": newDoc,
                "C:/lib/comp/Cat/New Template/thumbnail.png": "png",
            },
        };

        const records = buildScanHarness(disk).scan("C:/lib", "comp");
        expect(records.length).toBe(3);      // 3.30: never an emptied library

        const byName = {};
        records.forEach((r) => { byName[r.name] = r; });

        expect(byName["Old Template"].dim).toBe("1920x1080");
        expect(byName["Old Template"].section).toBe("comp");
        expect(byName["Old Template"].thumbnail).toBe("C:/lib/comp/Cat/Old Template/thumbnail.png");

        expect(byName["New Template"].dim).toBe("3840x2160");
        expect(byName["New Template"].section).toBe("comp");
        expect(byName["New Template"].type).toBe("comp");
        expect(byName["New Template"].thumbnail).toBe("C:/lib/comp/Cat/New Template/thumbnail.png");

        // 3.14: a folder with no meta.json is a DEGRADED record, not a hole.
        expect(byName["No Meta"]).toBeTruthy();
        expect(byName["No Meta"].dim).toBe("");
        expect(byName["No Meta"].section).toBe("comp");
    });

    test("(c) folders named by the PRE-FIX panel derivation still resolve", () => {
        // Names the pre-fix panel (js/core/utils.js:20-24 — trim + illegal-class
        // replacement, no cleanStr) and the canonical sanitizer agree on. This is
        // the no-re-keying guarantee F5 was designed around.
        const preserved = [
            "Lower Third",
            "Logo Reveal 2",
            "Title-Main",
            "v1.2 Build",
            "CamShake_alt",
            "Logo/Icon",          // -> "Logo_Icon" on BOTH rule sets
            "Wide:Screen",        // -> "Wide_Screen" on BOTH rule sets
            "  Padded Name  ",    // -> "Padded Name" on BOTH rule sets
        ];

        const disk = { folders: { "C:/lib": ["comp"], "C:/lib/comp": ["Titles"] }, texts: {} };
        const folderNames = preserved.map(preFixPanelSafeName);
        disk.folders["C:/lib/comp/Titles"] = folderNames;
        preserved.forEach((raw, i) => {
            const base = "C:/lib/comp/Titles/" + folderNames[i];
            disk.folders[base] = ["meta.json", "project.aep"];
            disk.texts[base + "/meta.json"] =
                '{"name":"' + raw.replace(/^\s+|\s+$/g, "") + '","type":"comp","section":"comp"}';
            disk.texts[base + "/project.aep"] = "aep";
        });

        const h = buildScanHarness(disk);
        // The REAL per-import I/O helpers from jsx/import.jsx, evaluated into the
        // SAME context, so resolveTemplateFiles uses the real csReadTemplateMeta
        // and the real csEnumerateFolderOnce instead of its typeof fallbacks. No
        // import context is opened: a startup scan has none, which is exactly the
        // documented degraded (direct-read) path.
        vm.runInContext([
            "var __CS_IMPORT_IO = null;",
            sliceAll(IMPORT_SRC, [
                "csNormPath", "csIoKey", "csMakeIoError", "csReadFileTextOnce",
                "csEnumerateFolderOnce", "csLookupSeededMeta", "csReadTemplateMeta",
                "csImportIoBegin", "csImportIoEnd",
            ]),
        ].join("\n"), h.handle.context);

        // 2.26: for every one of these names the two rule sets are byte-identical,
        // so the folder the old panel created is the folder the new panel derives.
        preserved.forEach((raw) => {
            expect(pathBuilders.generateTemplateId(raw)).toBe(preFixPanelSafeName(raw));
            expect(h.handle.get("generateTemplateId")(raw)).toBe(preFixPanelSafeName(raw));
            // Host and panel also agree with each other (F5's cross-implementation rule).
            expect(h.handle.get("generateTemplateId")(raw)).toBe(pathBuilders.generateTemplateId(raw));
        });

        // …and the host really finds each one on disk, with its project.aep.
        preserved.forEach((raw) => {
            const resolved = h.resolve("C:/lib", "Titles", raw, "comp");
            expect(resolved).not.toBeNull();
            expect(resolved.folder.fsName).toBe("C:/lib/comp/Titles/" + preFixPanelSafeName(raw));
            expect(resolved.mainFile.name).toBe("project.aep");
            expect(resolved.mainFile.exists).toBe(true);
        });

        // The scan reports all of them, keyed on the on-disk folder name.
        const records = h.scan("C:/lib", "comp");
        expect(records.length).toBe(preserved.length);
        const ids = records.map((r) => r.id).sort();
        expect(ids).toEqual(folderNames.slice().sort());

        // Where the two rule sets DO diverge, the old value was never addressable
        // on disk in the first place — Windows drops a trailing dot, and "." / ".."
        // are traversals, not folders — so the new value is a strict improvement
        // rather than a re-key of a usable folder.
        [".", "..", "name.", "CON"].forEach((raw) => {
            const now = pathBuilders.generateTemplateId(raw);
            expect(now).not.toBe(".");
            expect(now).not.toBe("..");
            expect(/[.\s]$/.test(now)).toBe(false);
            expect(now.length).toBeGreaterThan(0);
        });
    });
});
