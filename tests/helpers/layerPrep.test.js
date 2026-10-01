// ============================================================
// tests/helpers/layerPrep.test.js
// Tests for the Layer_Prep_Helper (Req 4): captureLayerLockState,
// prepareLayerForEdit (Heavy), unlockLayerForEdit (Light), restoreLayerState.
//
// Feature: engine-robustness-hardening, Property 4
// Property 4: Layer prep normalizes attributes and lock-state round-trips
// Validates: Requirements 4.1, 4.2, 4.5, 4.6
//
// Plus example/spy tests (Task 5.3) for Heavy-vs-Light variant behavior and
// per-attribute guarding (Req 4.3, 4.4, 4.7).
// ============================================================

"use strict";

const fc = require("fast-check");
const { loadHelpers } = require("./loadHelpers");
const { createRecorder, createLayerFake, createCompFake } = require("./aeFakes");

// The four attributes that both prep variants normalize, paired with the value
// each is normalized to.
const NORMALIZED = {
    locked: false,
    shy: false,
    enabled: true,
    selected: true,
};

// ------------------------------------------------------------
// Property 4: normalization + lock-state round-trip
// ------------------------------------------------------------
describe("Layer prep normalization and lock-state round-trip (Property 4)", () => {
    test("both variants normalize attributes (where the setter succeeds), never throw, and capture->restore returns locked/shy", () => {
        const attrArb = fc.constantFrom("locked", "shy", "enabled", "selected");

        fc.assert(
            fc.property(
                // All initial {locked, shy, enabled, selected, hideShyLayers} combinations.
                fc.boolean(), // initial locked
                fc.boolean(), // initial shy
                fc.boolean(), // initial enabled
                fc.boolean(), // initial selected
                fc.boolean(), // initial comp.hideShyLayers
                // Subset of attribute *setters* that throw (folds in Req 4.7 failures).
                fc.uniqueArray(attrArb, { maxLength: 4 }),
                // Which prep variant to exercise.
                fc.constantFrom("heavy", "light"),
                (locked, shy, enabled, selected, hideShyLayers, throwAttrs, variant) => {
                    const { get } = loadHelpers({ injected: {} });
                    const prepareLayerForEdit = get("prepareLayerForEdit");
                    const unlockLayerForEdit = get("unlockLayerForEdit");
                    const restoreLayerState = get("restoreLayerState");

                    // Throwing setters only (getters stay readable so the capture
                    // reads the true initial locked/shy values).
                    const throwsMap = {};
                    for (const a of throwAttrs) throwsMap["set:" + a] = true;

                    const layer = createLayerFake({
                        locked: locked,
                        shy: shy,
                        enabled: enabled,
                        selected: selected,
                        throws: throwsMap,
                    });
                    const comp = createCompFake({ hideShyLayers: hideShyLayers });

                    const prep = variant === "heavy" ? prepareLayerForEdit : unlockLayerForEdit;

                    // Req 4.7 / never-throws: prep must not throw despite throwing setters.
                    let original;
                    expect(() => {
                        original = prep(layer, comp);
                    }).not.toThrow();

                    // Req 4.5: captured Original Layer State reflects the pre-mutation values.
                    expect(original.locked).toBe(locked);
                    expect(original.shy).toBe(shy);

                    // Req 4.1: normalization applies to every attribute whose setter succeeded.
                    for (const attr of ["locked", "shy", "enabled", "selected"]) {
                        if (throwAttrs.indexOf(attr) === -1) {
                            expect(layer[attr]).toBe(NORMALIZED[attr]);
                        }
                    }

                    // Req 4.2: comp shy layers revealed (its setter never throws here).
                    expect(comp.hideShyLayers).toBe(false);

                    // Req 4.6: restore returns locked and shy to the captured values.
                    // (Holds whether or not the setter throws: a throwing setter
                    // leaves the value at its untouched initial, which equals the
                    // captured value; a working setter writes it back explicitly.)
                    expect(() => restoreLayerState(layer, original)).not.toThrow();
                    expect(layer.locked).toBe(original.locked);
                    expect(layer.shy).toBe(original.shy);
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ------------------------------------------------------------
// Task 5.3: Heavy vs Light variant behavior + per-attribute guarding
// ------------------------------------------------------------
describe("Heavy vs Light prep variants (Req 4.3, 4.4)", () => {
    test("Heavy prep (prepareLayerForEdit) focuses the comp and opens it in the viewer", () => {
        const res = loadHelpers({ injected: {} });
        const prepareLayerForEdit = res.get("prepareLayerForEdit");

        // Spy on focusComp by overriding the in-context global (function
        // declarations resolve to the context property at call time).
        const focusSpy = jest.fn();
        res.context.focusComp = focusSpy;

        const recorder = createRecorder();
        const layer = createLayerFake({ recorder: recorder });
        const comp = createCompFake({ recorder: recorder });

        prepareLayerForEdit(layer, comp);

        // Req 4.3: Heavy prep wires focusComp + openInViewer.
        expect(focusSpy).toHaveBeenCalledTimes(1);
        expect(focusSpy).toHaveBeenCalledWith(comp);
        expect(recorder.byName("openInViewer").length).toBe(1);
    });

    test("Light prep (unlockLayerForEdit) does NOT focus the comp or open it in the viewer", () => {
        const res = loadHelpers({ injected: {} });
        const unlockLayerForEdit = res.get("unlockLayerForEdit");

        const focusSpy = jest.fn();
        res.context.focusComp = focusSpy;

        const recorder = createRecorder();
        const layer = createLayerFake({ recorder: recorder });
        const comp = createCompFake({ recorder: recorder });

        unlockLayerForEdit(layer, comp);

        // Req 4.4: Light prep triggers neither focusComp nor openInViewer.
        expect(focusSpy).not.toHaveBeenCalled();
        expect(recorder.byName("openInViewer").length).toBe(0);
    });

    test("openInViewer call count distinguishes Heavy (1) from Light (0) on the same comp fake", () => {
        const res = loadHelpers({ injected: {} });
        const prepareLayerForEdit = res.get("prepareLayerForEdit");
        const unlockLayerForEdit = res.get("unlockLayerForEdit");
        // Neutralize focusComp so it cannot contribute openInViewer calls of its own.
        res.context.focusComp = function () { };

        const heavyComp = createCompFake({});
        prepareLayerForEdit(createLayerFake({}), heavyComp);
        const heavyOpens = heavyComp.calls.filter((c) => c.name === "openInViewer").length;

        const lightComp = createCompFake({});
        unlockLayerForEdit(createLayerFake({}), lightComp);
        const lightOpens = lightComp.calls.filter((c) => c.name === "openInViewer").length;

        expect(heavyOpens).toBe(1);
        expect(lightOpens).toBe(0);
    });
});

describe("Per-attribute guarding continues normalization when a setter throws (Req 4.7)", () => {
    // Each case throws on exactly one attribute; the remaining attributes must
    // still be normalized by both prep variants.
    const cases = ["locked", "shy", "enabled", "selected"];

    for (const variantName of ["heavy", "light"]) {
        for (const throwing of cases) {
            test(`${variantName} prep: throwing set:${throwing} still sets the other three`, () => {
                const res = loadHelpers({ injected: {} });
                res.context.focusComp = function () { };
                const prep = res.get(
                    variantName === "heavy" ? "prepareLayerForEdit" : "unlockLayerForEdit"
                );

                const throwsMap = {};
                throwsMap["set:" + throwing] = true;
                // Start from the "wrong" values so a successful write is observable.
                const layer = createLayerFake({
                    locked: true,
                    shy: true,
                    enabled: false,
                    selected: false,
                    throws: throwsMap,
                });
                const comp = createCompFake({ hideShyLayers: true });

                expect(() => prep(layer, comp)).not.toThrow();

                // Every attribute except the throwing one is normalized (Req 4.7).
                for (const attr of cases) {
                    if (attr !== throwing) {
                        expect(layer[attr]).toBe(NORMALIZED[attr]);
                    }
                }
                // comp shy layers always revealed.
                expect(comp.hideShyLayers).toBe(false);
            });
        }
    }
});
