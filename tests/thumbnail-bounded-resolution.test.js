// ============================================================
// tests/thumbnail-bounded-resolution.test.js
//
// Feature: Wave B — bounded thumbnail resolution (~320px)
//
// The REAL renderTemplateThumbnail sliced out of
// jsx/templates_save.jsx, executed in a vm with instrumented
// fakes. Verifies:
//   - large comps render through a 320-wide wrapper (aspect kept,
//     layer scaled, render targets the wrapper)
//   - comps already <= 320 render directly (passthrough)
//   - wrapper creation failure falls back to direct render
//   - the finally block removes wrapper + imported folder and
//     restores depth/suppression even when the render throws
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
const THUMB_SRC = sliceFn(SRC, "renderTemplateThumbnail");

function buildHarness(opts) {
    opts = opts || {};
    const log = { wrappers: [], renders: [], removedWrappers: 0, removedFolders: 0, depthRestored: null, suppress: 0, unsuppress: 0 };

    function makeLayer() {
        const scaleProp = { setValue(v) { log.lastScale = v; } };
        return {
            property() {
                return { property() { return scaleProp; } };
            },
        };
    }
    function makeComp(name, w, h) {
        return {
            name: name, width: w, height: h, pixelAspect: 1, duration: 5, frameRate: 30,
            workAreaStart: 0, workAreaDuration: 5,
            removed: false,
            layers: { add: () => makeLayer() },
            remove() { this.removed = true; log.removedWrappers++; },
        };
    }

    const srcComp = makeComp("Source", opts.compW || 1920, opts.compH || 1080);
    const importedFolder = { removed: false, remove() { this.removed = true; log.removedFolders++; } };

    const app = {
        _log: log,
        _srcComp: srcComp,
        _importedFolder: importedFolder,
        beginSuppressDialogs() { log.suppress++; },
        endSuppressDialogs() { log.unsuppress++; },
        project: {
            bitsPerChannel: 16,
            importFile() { return importedFolder; },
            items: {
                addComp(name, w, h, pa, dur, fr) {
                    if (opts.addCompThrows) throw new Error("addComp failed");
                    const c = makeComp(name, w, h);
                    log.wrappers.push({ name: name, w: w, h: h, comp: c });
                    return c;
                },
            },
        },
    };

    const context = {
        app: app,
        File: function File(p) { this.fsName = p; this.exists = opts.aepMissing ? false : true; },
        ImportOptions: function ImportOptions(f) { this.file = f; },
        encodeBridge: (s) => String(s),
        decodeBridge: (s) => String(s),
        escapeJSON: (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
        findCompItemInFolder: () => (opts.noComp ? null : srcComp),
        renderFrameToPng: (comp, time, outFile) => {
            log.renders.push({ comp: comp, time: time, out: outFile });
            if (opts.renderThrows) throw new Error("render exploded");
            return { success: true };
        },
    };
    Object.defineProperty(app.project, "bitsPerChannel", {
        get() { return this._depth === undefined ? 16 : this._depth; },
        set(v) {
            if (this._settingInitial) { this._depth = v; return; }
            log.depthRestored = v;
            this._depth = v;
        },
    });
    app.project._settingInitial = true;
    app.project.bitsPerChannel = 16;
    app.project._settingInitial = false;

    vm.createContext(context);
    vm.runInContext(THUMB_SRC, context, { filename: "renderTemplateThumbnail" });
    return { realm: context, log: log, app: app };
}

describe("renderTemplateThumbnail — bounded 320px resolution", () => {
    test("1920x1080 comp renders through a 320x180 wrapper with scaled layer", () => {
        const h = buildHarness();
        const out = JSON.parse(h.realm.renderTemplateThumbnail("C:/t/p.aep", "C:/t/th.png"));
        expect(out.ok).toBe(true);
        expect(h.log.wrappers.length).toBe(1);
        expect(h.log.wrappers[0].w).toBe(320);
        expect(h.log.wrappers[0].h).toBe(180);                     // aspect preserved
        expect(h.log.renders.length).toBe(1);
        expect(h.log.renders[0].comp.name).toBe("Source [Thumb]"); // renders the wrapper
        const expectedScale = (320 / 1920) * 100;
        expect(h.log.lastScale[0]).toBeCloseTo(expectedScale, 5);
        expect(h.log.removedWrappers).toBe(1);                      // wrapper cleaned up
        expect(h.log.removedFolders).toBe(1);                       // import cleaned up
        expect(h.log.suppress).toBe(h.log.unsuppress);              // balanced
    });

    test("small comp (<=320) renders directly — no wrapper", () => {
        const h = buildHarness({ compW: 320, compH: 240 });
        const out = JSON.parse(h.realm.renderTemplateThumbnail("C:/t/p.aep", "C:/t/th.png"));
        expect(out.ok).toBe(true);
        expect(h.log.wrappers.length).toBe(0);
        expect(h.log.renders[0].comp.name).toBe("Source");
        expect(h.log.removedWrappers).toBe(0);
        expect(h.log.removedFolders).toBe(1);
    });

    test("wrapper creation failure falls back to a direct render (thumbnail still succeeds)", () => {
        const h = buildHarness({ addCompThrows: true });
        const out = JSON.parse(h.realm.renderTemplateThumbnail("C:/t/p.aep", "C:/t/th.png"));
        expect(out.ok).toBe(true);
        expect(h.log.renders.length).toBe(1);
        expect(h.log.renders[0].comp.name).toBe("Source");
    });

    test("render throw still cleans up wrapper + folder and stays suppress-balanced", () => {
        const h = buildHarness({ renderThrows: true });
        const out = JSON.parse(h.realm.renderTemplateThumbnail("C:/t/p.aep", "C:/t/th.png"));
        expect(out.ok).toBe(false);
        expect(h.log.removedWrappers).toBe(1);
        expect(h.log.removedFolders).toBe(1);
        expect(h.log.suppress).toBe(h.log.unsuppress);
    });

    test("missing project.aep and no-comp cases report clean errors without side effects", () => {
        const h1 = buildHarness({ aepMissing: true });
        expect(JSON.parse(h1.realm.renderTemplateThumbnail("C:/x.aep", "C:/x.png")).error).toContain("missing");
        const h2 = buildHarness({ noComp: true });
        expect(JSON.parse(h2.realm.renderTemplateThumbnail("C:/t/p.aep", "C:/t/th.png")).error).toContain("No composition");
    });

    test("the edited host function stays strict ES3", () => {
        expect(/\blet\s/.test(THUMB_SRC)).toBe(false);
        expect(/\bconst\s/.test(THUMB_SRC)).toBe(false);
        expect(/=>/.test(THUMB_SRC)).toBe(false);
        expect(/`/.test(THUMB_SRC)).toBe(false);
    });
});
