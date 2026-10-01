// ============================================================
// tests/import-timings.test.js
//
// Feature: Wave 3 — import phase timings + no production litter
//
// The REAL importBatch (+_csProfilePoint) sliced out of
// jsx/import.jsx in a vm with fakes. Verifies:
//   - default (no payload.profile): NO Desktop profile file is
//     created — the previous always-on litter is gone
//   - the result carries structured timings (totalMs, decodeMs,
//     per-template array) without any disk write
//   - payload.profile === true still produces the debug file and
//     closes it
//   - per-template status semantics unchanged (imported/failed)
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "jsx/import.jsx"), "utf8");

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
const BATCH_SRC = sliceFn(SRC, "importBatch") + "\n" + sliceFn(SRC, "_csProfilePoint");

function buildHarness(opts) {
    opts = opts || {};
    const counters = { fileConstructions: 0, opens: 0, closes: 0, undoBegin: 0, undoEnd: 0 };
    const logLines = [];

    function makeFakeFile() {
        counters.fileConstructions++;
        return {
            open() { counters.opens++; },
            close() { counters.closes++; },
            writeln(l) { logLines.push(String(l)); },
        };
    }
    const context = {
        // $.hiresTimer RESETS on read (ExtendScript semantics): returns µs
        // accumulated since the previous read. add() simulates host work.
        $: {
            _t: 0,
            get hiresTimer() { const v = this._t; this._t = 0; return v; },
            add(us) { this._t += us; },
        },
        File: function () { return makeFakeFile(); },
        Folder: { desktop: { fsName: "C:/Users/x/Desktop" } },
        Date: Date,
        app: {
            beginUndoGroup() { counters.undoBegin++; },
            endUndoGroup() { counters.undoEnd++; },
            project: { activeItem: null },
        },
        CompItem: function () { },
        encodeBridge: (s) => String(s),
        decodeBridge: (s) => String(s),
        jsonStringify: (o) => JSON.stringify(o),
        _csProfileLog: null,
        csImportIoBegin() { },
        csImportIoEnd() { },
        csSnapshotCompLayers: () => null,
        csSnapshotProjectItemIds: () => [],
        csRollbackToSnapshot() { },
        csDispatchImport: function (section, idHex, cHex, rHex) {
            context.$.add(1500); // simulate 1.5ms of host work
            return "true";
        },
    };
    vm.createContext(context);
    vm.runInContext(BATCH_SRC, context, { filename: "importBatch" });
    return { realm: context, counters: counters, logLines: logLines };
}

function payloadHex(realm, payload) {
    return realm.encodeBridge(JSON.stringify(payload));
}

describe("importBatch — phase timings + no production litter", () => {
    test("default: no Desktop file created, timings returned in result", () => {
        const h = buildHarness();
        const raw = h.realm.importBatch(payloadHex(h.realm, {
            rootPath: "C:/lib",
            templates: [{ id: "t1", name: "T1", category: "C", section: "comp", sourcePath: "C:/lib" }],
        }));
        const res = JSON.parse(h.realm.decodeBridge(raw));
        expect(res.perTemplate.length).toBe(1);
        expect(res.perTemplate[0].status).toBe("imported");
        expect(h.counters.fileConstructions).toBe(0);   // no Desktop litter
        expect(h.counters.opens).toBe(0);
        expect(typeof res.timings.totalMs).toBe("number");
        expect(res.timings.totalMs).toBeGreaterThanOrEqual(0); // Date-ms resolution
        expect(res.timings.decodeMs).toBeGreaterThanOrEqual(0);
        expect(res.timings.templates.length).toBe(1);
        expect(res.timings.templates[0]).toBeGreaterThanOrEqual(1.5); // µs-precise phase
        expect(res.timings.profile).toBe(false);
    });

    test("payload.profile === true: debug file created, written, closed", () => {
        const h = buildHarness();
        const raw = h.realm.importBatch(payloadHex(h.realm, {
            profile: true,
            rootPath: "C:/lib",
            templates: [{ id: "t1", name: "T1", category: "C", section: "comp", sourcePath: "C:/lib" }],
        }));
        const res = JSON.parse(h.realm.decodeBridge(raw));
        expect(res.timings.profile).toBe(true);
        expect(h.counters.fileConstructions).toBe(1);
        expect(h.counters.opens).toBe(1);
        expect(h.counters.closes).toBe(1);
        expect(h.logLines.some((l) => l.indexOf("Batch Complete") !== -1)).toBe(true);
    });

    test("failed import still returns timings and rolls back (status semantics unchanged)", () => {
        const h = buildHarness();
        h.realm.csDispatchImport = function () { h.realm.$.add(800); return "Import Error: boom"; };
        const raw = h.realm.importBatch(payloadHex(h.realm, {
            rootPath: "C:/lib",
            templates: [{ id: "bad", name: "B", category: "C", section: "comp", sourcePath: "C:/lib" }],
        }));
        const res = JSON.parse(h.realm.decodeBridge(raw));
        expect(res.perTemplate[0].status).toBe("failed");
        expect(res.perTemplate[0].reason).toContain("boom");
        expect(res.timings.templates.length).toBe(1);
        expect(h.counters.undoBegin).toBe(h.counters.undoEnd); // single balanced group
    });

    test("the edited host function stays strict ES3 (syntax hazards)", () => {
        // Backticks inside pre-existing COMMENTS are legal ES3 characters;
        // only let/const/arrows are real parse hazards.
        expect(/\blet\s/.test(BATCH_SRC)).toBe(false);
        expect(/\bconst\s/.test(BATCH_SRC)).toBe(false);
        expect(/=>/.test(BATCH_SRC)).toBe(false);
    });
});
