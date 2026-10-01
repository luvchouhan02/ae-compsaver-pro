// ============================================================
// tests/helpers/harness.test.js
// Smoke tests for the test harness itself (AE-DOM fakes + loadHelpers shim).
// Feature: engine-robustness-hardening
//
// This is infrastructure verification only — it does NOT test any product
// helper logic (helpers.jsx is authored in later tasks). It confirms:
//   - the Jest runner executes,
//   - the fakes record call order and mutations,
//   - the loadHelpers shim tolerates a missing/empty/partial helpers.jsx,
//   - the shim strips ExtendScript directives and evaluates declarations
//     against injected fakes.
// ============================================================

"use strict";

const path = require("path");
const {
    createRecorder,
    createPropertyFake,
    createLayerFake,
    createCompFake,
    createAppFake,
    createFileFake,
} = require("./aeFakes");

const {
    loadHelpers,
    stripExtendScriptDirectives,
    createSandbox,
} = require("./loadHelpers");

describe("AE-DOM fakes", () => {
    test("property fake records call order and lands values", () => {
        const rec = createRecorder();
        const prop = createPropertyFake({ recorder: rec, label: "p" });

        prop.hidden = false;
        prop.selected = true;
        prop.setValueAtTime(1.0, [10, 20]);
        prop.setValue([30, 40]);

        expect(prop.value).toEqual([30, 40]);
        expect(prop.valueHistory).toEqual([[10, 20], [30, 40]]);
        // Ordered global sequence across the single object.
        expect(rec.sequence()).toEqual([
            "p.set:hidden",
            "p.set:selected",
            "p.setValueAtTime",
            "p.setValue",
        ]);
    });

    test("property fake can be made to throw on a specific method", () => {
        const prop = createPropertyFake({ throws: { setValueAtTime: true } });
        expect(() => prop.setValueAtTime(0, 1)).toThrow();
        // Fallback path still works.
        expect(() => prop.setValue(5)).not.toThrow();
        expect(prop.value).toBe(5);
    });

    test("addKey/setValueAtKey update keyframes and numKeys", () => {
        const prop = createPropertyFake({});
        const idx = prop.addKey(2.0);
        expect(idx).toBe(1);
        expect(prop.numKeys).toBe(1);
        prop.setValueAtKey(idx, 99);
        expect(prop.keyframes[0].value).toBe(99);
        expect(prop.value).toBe(99);
    });

    test("layer fake hands out recorded property fakes and shares recorder", () => {
        const rec = createRecorder();
        const layer = createLayerFake({
            recorder: rec,
            label: "L",
            locked: true,
            properties: { Position: { numKeys: 0, expressionEnabled: false } },
        });

        expect(layer.locked).toBe(true);
        layer.locked = false;
        const pos = layer.property("Position");
        pos.setValue([960, 540]);

        expect(pos.value).toEqual([960, 540]);
        const seq = rec.sequence();
        expect(seq).toContain("L.get:locked");
        expect(seq).toContain("L.set:locked");
        expect(seq).toContain("L.property");
    });

    test("comp fake is duck-typed as a CompItem and records openInViewer", () => {
        const rec = createRecorder();
        const comp = createCompFake({ recorder: rec, time: 3, width: 1280, height: 720 });
        expect(comp.__isCompFake).toBe(true);
        comp.time = 4;
        comp.openInViewer();
        expect(rec.byName("openInViewer").length).toBe(1);
    });

    test("app fake tracks undo balance and suppression depth", () => {
        const app = createAppFake({ numItems: 0 });
        app.beginUndoGroup("edit");
        expect(app.openUndoGroups()).toBe(1);
        app.endUndoGroup();
        expect(app.openUndoGroups()).toBe(0);

        app.beginSuppressDialogs();
        expect(app.suppressDepth()).toBe(1);
        app.endSuppressDialogs(false);
        expect(app.suppressDepth()).toBe(0);
    });

    test("file fake exposes exists/length for PNG validity checks", () => {
        const f = createFileFake({ exists: true, length: 65 });
        expect(f.exists).toBe(true);
        expect(f.length).toBe(65);
    });
});

describe("loadHelpers shim", () => {
    test("strips ExtendScript directives", () => {
        const src = [
            '//@include "core.jsx"',
            "#target aftereffects",
            "#targetengine \"main\"",
            "function foo() { return 1; }",
        ].join("\n");
        const stripped = stripExtendScriptDirectives(src);
        expect(stripped).not.toMatch(/@include/);
        expect(stripped).not.toMatch(/#target/);
        expect(stripped).toMatch(/function foo/);
    });

    test("tolerates a missing/empty helpers.jsx (empty sandbox, no throw)", () => {
        const result = loadHelpers({
            file: path.join("tests", "helpers", "__does_not_exist__.jsx"),
        });
        expect(result.error).toBeNull();
        expect(result.loaded).toEqual([]);
        expect(result.has("anything")).toBe(false);
    });

    test("evaluates injected fakes and declared functions in a sandbox", () => {
        // Simulate a partial helpers.jsx via an inline source through the
        // lower-level sandbox API, proving the injection wiring works before
        // helpers.jsx is authored.
        const app = createAppFake({});
        const ctx = createSandbox({ app });
        const vm = require("vm");
        vm.runInContext(
            "function usesApp() { app.beginUndoGroup('x'); app.endUndoGroup(); return app.openUndoGroups(); }",
            ctx
        );
        expect(typeof ctx.usesApp).toBe("function");
        expect(ctx.usesApp()).toBe(0);
    });

    test("reads jsx/helpers.jsx fresh each call (re-readable design)", () => {
        // Whether or not helpers.jsx exists yet, two sequential loads must not
        // throw and must return consistent structure.
        const a = loadHelpers({});
        const b = loadHelpers({});
        expect(Array.isArray(a.loaded)).toBe(true);
        expect(Array.isArray(b.loaded)).toBe(true);
        expect(a.error).toBeNull();
        expect(b.error).toBeNull();
    });

    test("CompItem instanceof works for comp fakes inside the sandbox", () => {
        const comp = createCompFake({});
        const ctx = createSandbox({ candidate: comp });
        const vm = require("vm");
        vm.runInContext("var isComp = (candidate instanceof CompItem);", ctx);
        expect(ctx.isComp).toBe(true);
    });
});
