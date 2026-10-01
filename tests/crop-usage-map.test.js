// ============================================================
// tests/crop-usage-map.test.js
//
// Feature: Toolkit quality wave — Crop preflight cost + correctness
//
// What is under test
// ------------------
// The REAL host functions sliced out of jsx/text.jsx (strict ES3
// source, executed in a vm with minimal AE fakes):
//   - buildSourceUsageCountMap: one O(items x layers) pass that
//     replaces the per-layer full-project getSourceCompUsageCount
//     scans (a crop run used to walk the whole project 2N times).
//   - toolkitCheckSharedPrecomps: preflight must report shared=true
//     exactly when a selected precomp layer's source is used more
//     than once project-wide, using the single-pass map.
// Counting the fake project's layer() calls also proves the walk
// happens exactly once per project item.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const TEXT_JSX = fs.readFileSync(path.join(ROOT, "jsx/text.jsx"), "utf8");

function extractFunction(source, name) {
    const start = source.indexOf("function " + name + "(");
    if (start === -1) throw new Error("function not found: " + name);
    const next = source.indexOf("\nfunction ", start + 1);
    const end = next === -1 ? source.length : next;
    return source.slice(start, end);
}

const USAGE_MAP_SRC = extractFunction(TEXT_JSX, "buildSourceUsageCountMap");
const CHECK_SRC = extractFunction(TEXT_JSX, "toolkitCheckSharedPrecomps");

// ── Minimal AE fakes (only what the sliced functions touch) ─────────────
function CompItem() { }
function AVLayer() { }

function makeLayer(source) {
    const layer = new AVLayer();
    layer.source = source;
    return layer;
}

function makeComp(id, layerSources) {
    const comp = new CompItem();
    comp.id = id;
    comp.__layers = layerSources.map(makeLayer);
    comp.numLayers = comp.__layers.length;
    comp.layerCalls = 0;
    comp.layer = function (i) { this.layerCalls++; return this.__layers[i - 1]; };
    return comp;
}

function makeProject(items) {
    let layerCalls = 0;
    const project = {
        numItems: items.length,
        item: function (i) { return items[i - 1]; },
    };
    for (const item of items) {
        if (item instanceof CompItem) {
            const origLayer = item.layer;
            item.layer = function (i) { layerCalls++; return origLayer.call(this, i); };
        }
    }
    project.totalLayerCalls = function () { return layerCalls; };
    return project;
}

function buildRealm(project) {
    const context = {
        app: { project: project },
        CompItem: CompItem,
        AVLayer: AVLayer,
        encodeBridge: function (s) { return String(s); },   // identity — result parses directly
        escapeJSON: function (s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); },
    };
    vm.createContext(context);
    vm.runInContext(USAGE_MAP_SRC, context, { filename: "buildSourceUsageCountMap" });
    vm.runInContext(CHECK_SRC, context, { filename: "toolkitCheckSharedPrecomps" });
    return context;
}

describe("Crop preflight — single-pass usage map (ES3 host logic)", () => {
    test("counts project-wide comp usage correctly, walking each item exactly once", () => {
        // sharedChild is used by mainComp (twice) and by otherComp (once) -> 3 usages.
        // soloChild is used once. mainComp/otherComp themselves are unused as sources.
        const sharedChild = makeComp(101, []);
        const soloChild = makeComp(102, []);
        const mainComp = makeComp(1, [sharedChild, sharedChild, soloChild]);
        const otherComp = makeComp(2, [sharedChild]);
        const project = makeProject([mainComp, otherComp, sharedChild, soloChild]);

        const realm = buildRealm(project);
        const map = realm.buildSourceUsageCountMap();

        expect(map[101]).toBe(3);
        expect(map[102]).toBe(1);
        expect(map[1]).toBeUndefined();
        expect(map[2]).toBeUndefined();
        // One walk: 3 layer() reads in mainComp + 1 in otherComp, never a
        // second full-project pass per selected layer.
        expect(project.totalLayerCalls()).toBe(4);
    });

    test("preflight reports shared=true via the map and shared=false otherwise", () => {
        const sharedChild = makeComp(101, []);
        const mainComp = makeComp(1, [sharedChild]);
        const otherComp = makeComp(2, [sharedChild, makeComp(103, [])]);

        const project = makeProject([mainComp, otherComp, sharedChild]);
        const realm = buildRealm(project);
        realm.app.project.activeItem = Object.assign(Object.create(mainComp), {
            selectedLayers: [makeLayer(sharedChild)],
        });

        const res = JSON.parse(realm.toolkitCheckSharedPrecomps());
        expect(res.ok).toBe(true);
        expect(res.shared).toBe(true);

        const soloChild = makeComp(104, []);
        const soloComp = makeComp(3, [soloChild]);
        const project2 = makeProject([soloComp, soloChild]);
        const realm2 = buildRealm(project2);
        realm2.app.project.activeItem = Object.assign(Object.create(soloComp), {
            selectedLayers: [makeLayer(soloChild)],
        });
        const res2 = JSON.parse(realm2.toolkitCheckSharedPrecomps());
        expect(res2.ok).toBe(true);
        expect(res2.shared).toBe(false);
    });

    test("preflight validation: no comp / no selection", () => {
        const realm = buildRealm(makeProject([]));
        realm.app.project.activeItem = null;
        expect(JSON.parse(realm.toolkitCheckSharedPrecomps()).error).toContain("Open a composition");

        const comp = makeComp(1, []);
        realm.app.project.activeItem = Object.assign(Object.create(comp), { selectedLayers: [] });
        expect(JSON.parse(realm.toolkitCheckSharedPrecomps()).error).toContain("No layers selected");
    });

    test("the sliced host source stays ES3 (no let/const/arrows/template literals)", () => {
        const combined = USAGE_MAP_SRC + CHECK_SRC;
        expect(/\blet\s/.test(combined)).toBe(false);
        expect(/\bconst\s/.test(combined)).toBe(false);
        expect(/=>/.test(combined)).toBe(false);
        expect(/`/.test(combined)).toBe(false);
        expect(/JSON\.(parse|stringify)/.test(combined)).toBe(false);
    });
});
