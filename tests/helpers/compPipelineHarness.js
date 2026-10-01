// ============================================================
// tests/helpers/compPipelineHarness.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15)
//
// Shared harness for the thirteen new property suites. It is the SAME shape the
// two existing suites already use — tests/comp-pipeline-bug-exploration.test.js
// and tests/comp-pipeline-preservation.property.test.js — lifted into one module
// so thirteen files do not each carry a private copy of the realm builders.
// Neither of those two suites is modified; this module reproduces their harness
// contracts (`sliceFn`, `buildRealm`, `createProjectModel`, `buildCompSaveRealm`,
// `buildLayerSaveRealm`, `buildImportRealm`, `buildResolverRealm`, the
// invalidating-item fake, and the suppression/undo counters).
//
// Harness A — function slicing into a `vm`
// ----------------------------------------
// `sliceFn(src, name)` is the brace-walk from tests/save-window-invariants.test.js
// :27-38. The REAL host functions execute; nothing is re-implemented.
//
// KNOWN CONSTRAINT — `jsonParse` cannot be brace-walk sliced: its body contains
// "{" / "}" inside string literals, which a brace walk cannot survive. It is
// excluded from every slice list here and the host callers' documented
// `typeof jsonParse === "function" ? jsonParse(x) : JSON.parse(x)` guard supplies
// the strict built-in instead. This is the same fallback
// tests/import-timings.test.js relies on.
//
// Harness B — whole-file sandbox
// ------------------------------
// `loadHostCore()` / `loadHostHelpers()` wrap tests/helpers/loadHelpers.js, which
// evaluates a whole `.jsx` file. In that realm every cross-file sibling that
// lives in the SAME file is present, so the `typeof fn === "function"` guards
// take their PRIMARY branch. In a sliced realm a sibling from ANOTHER file is
// absent and the documented inline fallback runs; each suite states which branch
// it exercises.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadHelpers } = require("./loadHelpers");

const ROOT = path.resolve(__dirname, "..", "..");
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SAVE_SRC = readSrc(path.join("jsx", "templates_save.jsx"));
const CORE_SRC = readSrc(path.join("jsx", "core.jsx"));
const IMPORT_SRC = readSrc(path.join("jsx", "import.jsx"));
const TEMPLATES_JS = readSrc(path.join("js", "templates", "templates.js"));

// ─────────────────────────────────────────────────────────────
// Slicing
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

/** Brace-walk the object literal that follows a marker. */
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

/** Slice the verbatim source between two unique markers (endMarker excluded). */
function sliceRegion(src, startMarker, endMarker) {
    const a = src.indexOf(startMarker);
    if (a === -1) throw new Error("missing start marker: " + startMarker);
    const b = src.indexOf(endMarker, a);
    if (b === -1) throw new Error("missing end marker: " + endMarker);
    return src.slice(a, b);
}

// The real, pure host utilities every sliced engine depends on. Sliced (not
// stubbed) so the engines run against the encoder / sanitizer / serializer they
// actually ship with. `jsonParse` is deliberately absent — see the file header.
const CORE_PURE_NAMES = [
    "trimStr", "cleanStr", "getSafeName", "escapeJSON", "jsonStringify",
    "encodeBridge", "decodeBridge", "isHexChar", "safeDecode", "fsEntryName",
    "generateTemplateId", "getDeterministicTemplateId", "normalizeSectionName",
    "ensureDeepFolder",
];
const CORE_PURE = sliceAll(CORE_SRC, CORE_PURE_NAMES);

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
    const ctx = Object.assign({ console: { log: function () { } } }, makeCtors(), injected || {});
    ctx.global = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "comp-pipeline-harness-slice" });
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

// ─────────────────────────────────────────────────────────────
// Fakes (b) + (c) — configurable-throwing app methods, plus counters.
// `undoAttempts` counts CALLS to beginUndoGroup; `undoBegin` counts groups that
// actually OPENED. `undoEnd` counts endUndoGroup calls that returned. The
// distinction is what the batch-guard and balance assertions need.
// ─────────────────────────────────────────────────────────────
// Counter semantics, chosen so the balance invariant means what Property 12 says
// and not merely "two numbers matched":
//   undoAttempts / undoEndAttempts  every CALL, thrown or not
//   undoBegin                       groups that actually OPENED
//   undoEnd                         end calls that actually CLOSED an open group
//   undoSuperfluousEnd              end calls made with NO group open (AE throws
//                                   on these; the engines swallow it defensively)
//   undoDepth                       groups still open at the end — must be 0
// The suppression counters mirror that shape, and match the depth bookkeeping
// tests/helpers/aeFakes.js createAppFake already uses.
function newCounters() {
    return {
        seq: [], saveCalls: [], openCalls: [], reduceCalls: 0, addCompCalls: 0,
        undoAttempts: 0, undoBegin: 0, undoEndAttempts: 0, undoEnd: 0,
        undoSuperfluousEnd: 0, undoDepth: 0, undoMaxDepth: 0, undoBeginFailed: 0,
        suppressBeginAttempts: 0, suppressBegin: 0,
        suppressEndAttempts: 0, suppressEnd: 0,
        suppressSuperfluousEnd: 0, suppressDepth: 0, suppressBeginFailed: 0,
    };
}

/** Shared begin/end bookkeeping for both the save and the import app fakes. */
function makeUndoAndSuppress(counters, opts) {
    opts = opts || {};
    return {
        beginUndoGroup: function (name) {
            counters.seq.push("beginUndoGroup");
            counters.undoAttempts++;
            if (opts.shouldUndoBeginThrow && opts.shouldUndoBeginThrow(name)) {
                counters.undoBeginFailed++;
                throw new Error("beginUndoGroup failed");
            }
            counters.undoBegin++;
            counters.undoDepth++;
            if (counters.undoDepth > counters.undoMaxDepth) counters.undoMaxDepth = counters.undoDepth;
        },
        endUndoGroup: function () {
            counters.seq.push("endUndoGroup");
            counters.undoEndAttempts++;
            if (counters.undoDepth > 0) { counters.undoDepth--; counters.undoEnd++; }
            else { counters.undoSuperfluousEnd++; }
            // The call reached the host before it failed, so the group is treated
            // as closed; only the caller's error handling differs.
            if (opts.undoEndThrows) throw new Error("endUndoGroup failed");
        },
        beginSuppressDialogs: function () {
            counters.seq.push("beginSuppressDialogs");
            counters.suppressBeginAttempts++;
            if (opts.suppressBeginThrows) {
                counters.suppressBeginFailed++;
                throw new Error("beginSuppressDialogs failed");
            }
            counters.suppressBegin++;
            counters.suppressDepth++;
        },
        endSuppressDialogs: function () {
            counters.seq.push("endSuppressDialogs");
            counters.suppressEndAttempts++;
            if (counters.suppressDepth > 0) { counters.suppressDepth--; counters.suppressEnd++; }
            else { counters.suppressSuperfluousEnd++; }
            if (opts.suppressEndThrows) throw new Error("endSuppressDialogs failed");
        },
    };
}

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
            counters.seq.push(isProtective ? "save(PROTECTIVE)" : "save(TARGET)");
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
            counters.seq.push("reduceProject");
            counters.reduceCalls++;
            if (opts.reduceThrows) throw new Error("reduce failed");
        },
        items: {
            addComp: function (name, w, h, pa, dur, fps) {
                counters.seq.push("addComp");
                counters.addCompCalls++;
                if (opts.addCompThrows) throw new Error("addComp failed");
                if (opts.addCompReturnsNull) return null;
                return {
                    __kind: "comp", name: name, numLayers: 2,
                    width: w, height: h, pixelAspect: pa, duration: dur, frameRate: fps,
                    workAreaStart: 0, workAreaDuration: 1,
                    remove: function () { this.__removed = true; },
                };
            },
        },
    };
    return Object.assign(makeUndoAndSuppress(counters, {
        shouldUndoBeginThrow: opts.undoBeginThrows ? function () { return true; } : null,
        undoEndThrows: opts.undoEndThrows,
        suppressBeginThrows: opts.suppressBeginThrows,
        suppressEndThrows: opts.suppressEndThrows,
    }), {
        __projectFile: projectFile,
        project: project,
        open: function (file) {
            counters.seq.push("open");
            counters.openCalls.push(String((file && file.fsName) || file));
            if (opts.invalidateOnOpen && latch) latch.invalidated = true;
            if (opts.openThrows) {
                throw (typeof opts.openThrows === "object"
                    ? opts.openThrows
                    : new Error("app.open failed: the project file is locked"));
            }
        },
    });
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

// Fake (d), filesystem half: records every Folder.create() so "no folder was
// created before the rejection" is directly observable.
function createFolderCtor(fsSet, creates, opts) {
    opts = opts || {};
    return function Folder(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        const self = this;
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () {
                if (opts.everythingUnderRootExists && opts.rootPath) {
                    if (norm === opts.rootPath || norm.indexOf(opts.rootPath + "/") === 0) return true;
                }
                return fsSet[norm] === true;
            },
        });
        Object.defineProperty(this, "parent", {
            configurable: true,
            get: function () {
                const cut = norm.lastIndexOf("/");
                if (cut <= 0) return null;
                return new Folder(norm.substring(0, cut));
            },
        });
        this.create = function () {
            creates.push(norm);
            if (opts.createFails) return false;
            fsSet[norm] = true;
            return true;
        };
        this.getFiles = function () { return []; };
        this.toString = function () { return self.fsName; };
    };
}

// ─────────────────────────────────────────────────────────────
// Save-engine realms
// ─────────────────────────────────────────────────────────────
const DEFAULT_COMP_GEOMETRY = Object.freeze({
    width: 1920, height: 1080, pixelAspect: 1, duration: 10,
    frameRate: 25, workAreaStart: 0, workAreaDuration: 10,
});

/**
 * The REAL `saveActiveComp` in a vm.
 *
 * typeof-guard branches exercised: `validateLibraryRoot` lives in jsx/core.jsx
 * and is NOT in CORE_PURE, so the engine's documented inline absolute-path
 * branch runs unless `opts.injectValidateLibraryRoot` is set (which slices the
 * real one in and takes the PRIMARY branch).
 */
function buildCompSaveRealm(opts) {
    opts = opts || {};
    const counters = newCounters();
    const latch = { invalidated: false };
    const creates = [];
    const rootPath = opts.rootPath || "C:/lib";
    const fsSet = opts.fsSet || {
        "C:/lib": true,
        "C:/lib/comp": true,
        "C:/lib/comp/Titles": true,
        "C:/lib/comp/Titles/My Title": true,
    };
    const app = createSaveApp(counters, latch, opts);
    const geometry = opts.geometry || DEFAULT_COMP_GEOMETRY;
    const precomp = opts.liveReference
        ? Object.assign({ __kind: "comp", name: "Source Precomp", remove: function () { this.__removed = true; } }, geometry)
        : createInvalidatingItem(latch, "comp", Object.assign({ name: "Source Precomp" }, geometry));

    const injected = {
        app: app,
        File: createFileCtor(fsSet),
        Folder: createFolderCtor(fsSet, creates, {
            createFails: opts.createFails,
            everythingUnderRootExists: opts.everythingUnderRootExists,
            rootPath: rootPath,
        }),
        resolveCompForSave: function () {
            if (opts.resolveFails) return { ok: false, error: "Select a precomposition first." };
            return { ok: true, comp: precomp };
        },
    };

    const parts = [CORE_PURE];
    if (opts.injectValidateLibraryRoot) {
        parts.push(sliceAll(CORE_SRC, ["isAbsoluteLibraryRoot", "validateLibraryRoot"]));
    }
    parts.push(sliceFn(SAVE_SRC, "saveActiveComp"));

    const ctx = buildRealm(parts.join("\n"), injected);
    return {
        ctx: ctx, app: app, counters: counters, latch: latch, precomp: precomp,
        creates: creates, fsSet: fsSet, rootPath: rootPath,
        run: function (name, cat, root) {
            const e = ctx.encodeBridge;
            const hex = ctx.saveActiveComp(
                e(name === undefined ? "My Title" : name),
                e(cat === undefined ? "Titles" : cat),
                e(root === undefined ? rootPath : root),
                e("")
            );
            return ctx.decodeBridge(hex);
        },
    };
}

/** The REAL `coreSaveLayerType` in a vm. Same typeof-guard note as above. */
function buildLayerSaveRealm(opts) {
    opts = opts || {};
    const counters = newCounters();
    const latch = { invalidated: false };
    const creates = [];
    const rootPath = opts.rootPath || "C:/lib";
    const fsSet = opts.fsSet || {
        "C:/lib": true,
        "C:/lib/layer": true,
        "C:/lib/layer/Cat": true,
        "C:/lib/layer/Cat/id1": true,
        "C:/lib/text": true,
        "C:/lib/text/Cat": true,
        "C:/lib/text/Cat/id1": true,
        "C:/lib/footage": true,
        "C:/lib/footage/Cat": true,
        "C:/lib/footage/Cat/id1": true,
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
    const geometry = opts.geometry || {
        width: 1920, height: 1080, pixelAspect: 1, duration: 5, frameRate: 30,
        workAreaStart: 0, workAreaDuration: 5,
    };
    const comp = opts.liveReference
        ? Object.assign({
            __kind: "comp", name: "Live Comp", selectedLayers: [layer],
            remove: function () { this.__removed = true; },
        }, geometry)
        : createInvalidatingItem(latch, "comp", Object.assign(
            { name: "Live Comp", selectedLayers: [layer] }, geometry));
    app.project.activeItem = comp;

    const parts = [CORE_PURE];
    if (opts.injectValidateLibraryRoot) {
        parts.push(sliceAll(CORE_SRC, ["isAbsoluteLibraryRoot", "validateLibraryRoot"]));
    }
    parts.push(sliceFn(SAVE_SRC, "coreSaveLayerType"));

    const ctx = buildRealm(parts.join("\n"), {
        app: app,
        File: createFileCtor(fsSet),
        Folder: createFolderCtor(fsSet, creates, {
            createFails: opts.createFails,
            everythingUnderRootExists: opts.everythingUnderRootExists,
            rootPath: rootPath,
        }),
        captureLayerState: function () { return { switches: { enabled: true }, markers: [] }; },
        copySelectedLayersToTempComp: function () {
            if (opts.copyThrows) throw new Error("copy exploded");
            if (opts.copyReturnsZero) return 0;
            return 2;
        },
    });
    return {
        ctx: ctx, app: app, counters: counters, latch: latch, comp: comp,
        creates: creates, fsSet: fsSet, rootPath: rootPath,
        run: function (section, name, cat, root) {
            return ctx.coreSaveLayerType(
                name === undefined ? "Name" : name,
                cat === undefined ? "Cat" : cat,
                root === undefined ? rootPath : root,
                "Layer", "", section || "layer", "id1"
            );
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Selection-resolver realm — getStrictSaveType + resolveCompForSave in ONE
// realm, so both walk the SAME selection state.
//
// typeof-guard branch: `csResolveCompTarget` IS sliced in, so
// getStrictSaveType takes its PRIMARY branch (the canonical alias) rather than
// the documented `resolveCompForSave()` fallback.
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
        sliceAll(CORE_SRC, [
            "buildDetectionResult", "getStrictSaveType",
            "csResolveCompTarget", "resolveCompForSave",
        ]),
    ].join("\n");
    const ctx = buildRealm(src, {
        app: app,
        detectEffectsOnSelection: function () { return { mode: "none", effects: [], names: "" }; },
        classifyLayer: function (l) {
            try { return (l && l.__classify) || "unknown"; } catch (e) { return "unknown"; }
        },
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

/** A timeline layer. `classify` feeds the injected classifyLayer stub. */
function fakeLayer(name, classify, source) {
    return {
        __kind: "avlayer", name: name, __classify: classify,
        source: source === undefined ? null : source,
        index: 1,
    };
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
        comp.layers = {
            add: function (src) {
                if (comp.__layersAddThrows) throw new Error("layers.add failed");
                if (comp.__layersAddReturnsNull) return null;
                return insertLayer(comp, (src && src.name) || "Layer", 1);
            },
        };
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

// ─────────────────────────────────────────────────────────────
// Import realms
// ─────────────────────────────────────────────────────────────
const IMPORT_PRELUDE = [
    "var __CS_IMPORT_BATCH_ACTIVE = false;",
    "var __CS_IMPORT_IO = null;",
    "var __CS_IMPORT_BATCH_ANCHOR = null;",
    "var _csProfileLog = null;",
    'var CS_ASSETS_FOLDER_NAME = "_CompSaver_Assets";',
].join("\n");

// Everything the import routines need, sliced from the real file. The container
// helpers (csFindOrCreateRootFolder / csFindOrCreateSubFolder) and the batch
// anchor latch (csBatchAnchor* / csResolveImportAnchor) are INCLUDED, so
// toolkitOrganizeTemplateImport, importCompDirect and importBatch all take their
// PRIMARY typeof branch rather than the inline fallbacks.
const IMPORT_REAL_NAMES = [
    "csBeginUndoGroup", "csEndUndoGroup",
    "csBatchAnchorBegin", "csBatchAnchorReselect", "csBatchAnchorEnd",
    "csResolveImportAnchor",
    "csItemKind", "csClassifyItemsOnce",
    "csSnapshotProjectItemIds", "csSnapshotCompLayers", "csRollbackToSnapshot",
    "csDispatchImport", "_csProfilePoint", "importBatch", "importCompDirect",
    "importLayerTypeAep", "csFindOrCreateRootFolder", "csFindOrCreateSubFolder",
    "toolkitOrganizeTemplateImport", "cleanupImportedItems",
    "csNormPath", "csIoKey", "csMakeIoError", "csReadFileTextOnce",
    "csEnumerateFolderOnce", "csLookupSeededMeta", "csReadTemplateMeta",
    "csImportIoBegin", "csImportIoEnd", "csImportIoOwn", "csImportIoRelease",
    "csExistingNamesOnce", "csResolveName",
];

/**
 * `cfg`:
 *   undoBeginThrows   throw from app.beginUndoGroup. When `undoBeginScope` is a
 *                     string, only that group NAME throws — the exploration
 *                     suite scopes it to "CompSaver Import" so the per-section
 *                     groups can still succeed, which is what makes the F11a
 *                     consequence observable at all.
 *   containerHelpers  false -> omit csFindOrCreateRootFolder/SubFolder so
 *                     toolkitOrganizeTemplateImport runs its INLINE fallback.
 *   anchorLatch       false -> omit the csBatchAnchor* latch so importBatch runs
 *                     csBatchAnchorRestoreLocal and importCompDirect falls back
 *                     to a bare getTopSelectedLayer.
 */
function buildImportRealm(cfg) {
    cfg = cfg || {};
    const model = createProjectModel();
    const counters = newCounters();
    const anchorLog = [];
    const guardDuringImport = [];
    const applyLayerStateCalls = [];
    const hires = {
        _t: 0,
        get hiresTimer() { const v = this._t; this._t = 0; return v; },
        add: function (us) { this._t += us; },
    };

    const undoScope = cfg.undoBeginScope === undefined ? "CompSaver Import" : cfg.undoBeginScope;
    const app = Object.assign(makeUndoAndSuppress(counters, {
        // Scoping the throw to the BATCH group name is what makes the F11a
        // consequence observable at all: a blanket throw would make the
        // per-section undoBegin count structurally 0, so "at least one real
        // per-section group opened" would be unsatisfiable rather than false.
        shouldUndoBeginThrow: cfg.undoBeginThrows
            ? function (name) { return undoScope === null || name === undoScope; }
            : null,
        undoEndThrows: cfg.undoEndThrows,
        suppressBeginThrows: cfg.suppressBeginThrows,
        suppressEndThrows: cfg.suppressEndThrows,
    }), {
        project: model.project,
    });

    let names = IMPORT_REAL_NAMES;
    if (cfg.containerHelpers === false) {
        names = names.filter((n) => n !== "csFindOrCreateRootFolder" && n !== "csFindOrCreateSubFolder");
    }
    if (cfg.anchorLatch === false) {
        names = names.filter((n) => n.indexOf("csBatchAnchor") !== 0 && n !== "csResolveImportAnchor");
    }

    const src = [
        CORE_PURE,
        IMPORT_PRELUDE,
        sliceAll(IMPORT_SRC, names),
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
    // anchor each template actually used is observable BY IDENTITY.
    vm.runInContext(
        "var __realGetTop = getTopSelectedLayer;" +
        "getTopSelectedLayer = function (c) { var t = __realGetTop(c); __anchorLog.push(t); return t; };",
        ctx
    );

    return {
        ctx: ctx, app: app, model: model, counters: counters,
        anchorLog: anchorLog, guardDuringImport: guardDuringImport,
        applyLayerStateCalls: applyLayerStateCalls, hires: hires,
        /** Encode + run importBatch, returning the parsed result. */
        runBatch: function (payload) {
            const raw = ctx.importBatch(ctx.encodeBridge(JSON.stringify(payload)));
            return JSON.parse(ctx.decodeBridge(raw));
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Harness B — whole-file sandboxes
// ─────────────────────────────────────────────────────────────
function loadHostCore(extraInjected) {
    return loadHelpers({
        file: path.join("jsx", "core.jsx"),
        injected: Object.assign(
            { app: {}, File: function () { }, Folder: function () { }, $: { hiresTimer: 0 } },
            extraInjected || {}
        ),
    });
}

function loadHostHelpers(extraInjected) {
    return loadHelpers({
        file: path.join("jsx", "helpers.jsx"),
        injected: Object.assign({ app: {} }, extraInjected || {}),
    });
}

// ─────────────────────────────────────────────────────────────
// Path predicates shared by the containment / sanitizer suites
// ─────────────────────────────────────────────────────────────
/** Collapse "//" runs, unify separators, drop a trailing separator. */
function normalizePath(p) {
    let s = String(p === null || p === undefined ? "" : p).replace(/\\/g, "/");
    // Preserve a leading UNC "//" prefix, collapse every other run.
    const unc = s.indexOf("//") === 0;
    s = s.replace(/\/+/g, "/");
    if (unc) s = "/" + s;
    if (s.length > 1) s = s.replace(/\/+$/, "");
    return s;
}

/** A single path segment that Windows and POSIX can both address. */
function isSafeSegment(seg) {
    if (typeof seg !== "string") return false;
    if (seg === "." || seg === ".." || seg === "") return false;
    if (/[.\s]$/.test(seg)) return false;
    if (/[\\/:*?"<>|]/.test(seg)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(seg)) return false;
    if (seg.length > 255) return false;
    return true;
}

module.exports = {
    ROOT,
    SAVE_SRC, CORE_SRC, IMPORT_SRC, TEMPLATES_JS,
    readSrc,
    sliceFn, sliceAll, sliceObjectLiteral, sliceRegion,
    CORE_PURE, CORE_PURE_NAMES,
    duckCtor, makeCtors, buildRealm,
    createInvalidatingItem,
    newCounters, createSaveApp, createFileCtor, createFolderCtor,
    DEFAULT_COMP_GEOMETRY,
    buildCompSaveRealm, buildLayerSaveRealm,
    buildResolverRealm, fakeComp, fakeLayer,
    createProjectModel,
    IMPORT_PRELUDE, IMPORT_REAL_NAMES, buildImportRealm,
    loadHostCore, loadHostHelpers,
    normalizePath, isSafeSegment,
};
