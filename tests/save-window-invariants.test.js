// ============================================================
// tests/save-window-invariants.test.js
//
// Feature: Problem 6 — destructive-window invariants in the host save
//
// The REAL coreSaveLayerType sliced out of jsx/templates_save.jsx,
// executed in a vm with a fully instrumented fake `app`. Proves the
// three invariants the Problem 6 audit found violated:
//
//   1. Pre-window failure (throw between protective save and reduce):
//      NO reopen — the live project is intact in memory; undo group
//      ends exactly once.
//   2. In-window failure (template save throws after reduce): exactly
//      ONE suppress-balanced reopen from the protective snapshot.
//   3. Success: exactly 2 project writes, 1 reopen, balanced undo and
//      dialog suppression.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "jsx/templates_save.jsx"), "utf8");

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
const CORE_SRC = sliceFn(SRC, "coreSaveLayerType");

function makeApp(opts) {
    const c = {
        saveCalls: [], openCalls: [], reduceCalls: 0,
        undoBegin: 0, undoEnd: 0, suppressBegin: 0, suppressEnd: 0,
        addCompCalls: 0,
    };
    const tempComp = {
        removed: false,
        name: "temp",
        numLayers: 2,
        workAreaStart: 0, workAreaDuration: 1,
        remove() { this.removed = true; },
    };
    const projectFile = { fsName: "C:/proj/live.aep" };
    const app = {
        _counters: c,
        _tempComp: tempComp,
        beginUndoGroup() { c.undoBegin++; },
        endUndoGroup() { c.undoEnd++; },
        beginSuppressDialogs() { c.suppressBegin++; },
        endSuppressDialogs() { c.suppressEnd++; },
        open(file) {
            c.openCalls.push(String(file.fsName || file));
            if (opts && opts.openThrows) throw new Error("open failed");
        },
        project: {
            file: projectFile,
            numItems: 0,
            activeItem: null, // set by harness
            save(file) {
                c.saveCalls.push(file === projectFile ? "PROTECTIVE" : String(file.fsName || file));
                if (file !== projectFile && opts && opts.targetSaveThrows) throw new Error("target save failed");
            },
            reduceProject(list) { c.reduceCalls++; },
            items: {
                addComp() {
                    c.addCompCalls++;
                    if (opts && opts.addCompThrows) throw new Error("addComp failed");
                    return tempComp;
                },
            },
        },
    };
    return app;
}

function buildRealm(app, copyMode) {
    const layer = {
        matchName: "ADBE Shape Layer",
        selectedLayers: null,
        adjustmentLayer: false, threeDLayer: false, blendingMode: 1, label: 0,
        property(name) {
            if (name === "ADBE Effect Parade") return { numProperties: 1 };
            return { numProperties: 0 };
        },
        numProperties: 2,
    };
    const context = {
        app: app,
        CompItem: function CompItem() { },
        AVLayer: function AVLayer() { },
        FootageItem: function FootageItem() { },
        File: function File(p) { this.fsName = p; this.exists = true; },
        encodeBridge: (s) => String(s),
        decodeBridge: (s) => String(s),
        escapeJSON: (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
        getSafeName: (s) => String(s),
        fsEntryName: (f) => "asset.png",
        ensureDeepFolder: (p) => ({ fsName: "C:/lib/" + p, exists: true }),
        captureLayerState: () => null,
        copySelectedLayersToTempComp: function (c, layers, tc) {
            if (copyMode === "throw") throw new Error("copy exploded");
            return 2;
        },
    };
    vm.createContext(context);
    vm.runInContext(CORE_SRC, context, { filename: "coreSaveLayerType" });
    // The comp must pass `instanceof CompItem` inside the realm.
    const comp = vm.runInContext("new CompItem()", context);
    Object.assign(comp, {
        width: 1920, height: 1080, pixelAspect: 1, duration: 5, frameRate: 30,
        workAreaStart: 0, workAreaDuration: 5,
        selectedLayers: [layer],
    });
    app.project.activeItem = comp;
    return context;
}

describe("coreSaveLayerType — destructive-window invariants", () => {
    test("pre-window failure: NO reopen, undo ends once, only the protective write", () => {
        const app = makeApp();
        const realm = buildRealm(app, "throw"); // copy throws AFTER protective save, BEFORE reduce
        const out = realm.coreSaveLayerType("Name", "Cat", "C:/lib", "Layer", "", "layer", "id1");

        expect(typeof out).toBe("string");          // error string, not a result object
        expect(out).toContain("Save Error");
        expect(app._counters.saveCalls).toEqual(["PROTECTIVE"]);
        expect(app._counters.reduceCalls).toBe(0);
        expect(app._counters.openCalls).toEqual([]); // invariant: no reopen before the window
        expect(app._counters.undoBegin).toBe(1);
        expect(app._counters.undoEnd).toBe(1);
    });

    test("in-window failure: exactly ONE suppress-balanced reopen restores the live project", () => {
        const app = makeApp({ targetSaveThrows: true }); // template write fails after reduce
        const realm = buildRealm(app, "ok");
        const out = realm.coreSaveLayerType("Name", "Cat", "C:/lib", "Layer", "", "layer", "id1");

        expect(typeof out).toBe("string");
        expect(out).toContain("Template save failed");
        expect(app._counters.saveCalls).toEqual(["PROTECTIVE", "C:/lib/C:/lib/layer/Cat/id1/project.aep"]);
        expect(app._counters.reduceCalls).toBe(1);
        expect(app._counters.openCalls).toEqual(["C:/proj/live.aep"]); // exactly one reopen
        expect(app._counters.suppressBegin).toBe(app._counters.suppressEnd); // balanced
        expect(app._counters.undoBegin).toBe(1);
        expect(app._counters.undoEnd).toBe(1);
    });

    test("success: 2 writes, 1 reduce, 1 reopen, balanced undo/suppress, ok result", () => {
        const app = makeApp();
        const realm = buildRealm(app, "ok");
        const out = realm.coreSaveLayerType("Name", "Cat", "C:/lib", "Layer", "", "layer", "id1");

        expect(typeof out).toBe("object");
        expect(out.ok).toBe(true);
        expect(out.needsThumbnail).toBe(true);
        expect(app._counters.saveCalls.length).toBe(2);   // ≤2 full-project writes
        expect(app._counters.reduceCalls).toBe(1);
        expect(app._counters.openCalls.length).toBe(1);   // exactly one reopen
        expect(app._counters.undoBegin).toBe(app._counters.undoEnd);
        expect(app._counters.suppressBegin).toBe(app._counters.suppressEnd);
    });

    test("protective-save failure: abort with zero destructive ops", () => {
        const app = makeApp();
        app.project.save = function () { throw new Error("disk full"); };
        const realm = buildRealm(app, "ok");
        const out = realm.coreSaveLayerType("Name", "Cat", "C:/lib", "Layer", "", "layer", "id1");
        expect(out).toContain("Protective save failed");
        expect(app._counters.reduceCalls).toBe(0);
        expect(app._counters.openCalls).toEqual([]);
    });

    test("the edited host function stays strict ES3", () => {
        expect(/\blet\s/.test(CORE_SRC)).toBe(false);
        expect(/\bconst\s/.test(CORE_SRC)).toBe(false);
        expect(/=>/.test(CORE_SRC)).toBe(false);
        expect(/`/.test(CORE_SRC)).toBe(false);
    });
});
