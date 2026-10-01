// ============================================================
// tests/helpers/fit.test.js
// Property-based tests for the Fit_Helper (Req 5): computeFitScale,
// fitLayerToComp, and deepFitLayerToComp in jsx/helpers.jsx.
//
// Feature: engine-robustness-hardening
//
// Covers:
//   - Property 5 (task 6.2): fit transform sets anchor + scale, preserves Z,
//     fails and writes nothing on indeterminate source dims.
//     Validates Requirements 5.1, 5.4, 5.5, 5.6.
//   - Property 6 (task 6.3): position -> comp center only when unanimated.
//     Validates Requirements 5.2, 5.3.
//   - Property 7 (task 6.5): deep fit fits each nested level once, paired with
//     its enclosing comp, and stops at the traversal guard.
//     Validates Requirement 5.7.
//
// The tests exercise the real ExtendScript helpers loaded into a Node VM by the
// loadHelpers shim, against the inspectable AE-DOM fakes in aeFakes.js. Small
// local builders below model a transform group (a property whose .property(name)
// returns anchor/position/scale property fakes) and a 1-based AE LayerCollection.
// ============================================================

"use strict";

const fc = require("fast-check");
const { loadHelpers } = require("./loadHelpers");
const {
    createRecorder,
    createPropertyFake,
    createLayerFake,
    createCompFake,
} = require("./aeFakes");

// Matches the traversal guard inside deepFitLayerToComp.
const MAX_DEPTH = 20;

/**
 * Load the fit helpers fresh into a sandbox. No AE-DOM globals are needed for
 * the pure/branch logic here beyond the default duck-typed CompItem the shim
 * installs (comp fakes carry __isCompFake so `x instanceof CompItem` works).
 */
function loadFit() {
    const h = loadHelpers();
    if (h.error) throw h.error;
    return {
        computeFitScale: h.get("computeFitScale"),
        fitLayerToComp: h.get("fitLayerToComp"),
        deepFitLayerToComp: h.get("deepFitLayerToComp"),
    };
}

/**
 * Build a transform-group stand-in: a property-like object whose .property(name)
 * returns anchor/position/scale property fakes. It carries a no-op setValue so
 * createLayerFake returns it as-is (it is treated as an already-built property).
 */
function buildTransformGroup(recorder, opts) {
    opts = opts || {};
    const anchor = createPropertyFake({
        label: "anchor", recorder: recorder,
        value: opts.anchorValue !== undefined ? opts.anchorValue : [0, 0],
    });
    const position = createPropertyFake({
        label: "position", recorder: recorder,
        value: opts.positionValue !== undefined ? opts.positionValue : [0, 0],
        expressionEnabled: opts.expressionEnabled !== undefined ? opts.expressionEnabled : false,
        numKeys: opts.numKeys !== undefined ? opts.numKeys : 0,
    });
    const scale = createPropertyFake({
        label: "scale", recorder: recorder,
        value: opts.scaleValue !== undefined ? opts.scaleValue : [100, 100],
    });
    const map = {
        "ADBE Anchor Point": anchor,
        "ADBE Position": position,
        "ADBE Scale": scale,
    };
    return {
        setValue: function () { }, // marker so createLayerFake returns this as-is
        anchor: anchor,
        position: position,
        scale: scale,
        property: function (name) { return map[name] || null; },
    };
}

/** Build a 1-based AE-style LayerCollection over a JS array of layer fakes. */
function layersCollection(arr) {
    const coll = { length: arr.length };
    for (let i = 0; i < arr.length; i++) coll[i + 1] = arr[i];
    return coll;
}

describe("Fit_Helper", () => {
    // ------------------------------------------------------------------
    // Feature: engine-robustness-hardening, Property 5
    // Fit transform sets anchor and scale and preserves Z (fails on bad dims).
    // Validates: Requirements 5.1, 5.4, 5.5, 5.6
    // ------------------------------------------------------------------
    test("Property 5: fit sets anchor+scale, preserves Z, fails+no-write on indeterminate dims", () => {
        const { fitLayerToComp } = loadFit();

        fc.assert(
            fc.property(
                fc.record({
                    hasDims: fc.boolean(),
                    sw: fc.integer({ min: 1, max: 4000 }),
                    sh: fc.integer({ min: 1, max: 4000 }),
                    cw: fc.integer({ min: 1, max: 4000 }),
                    ch: fc.integer({ min: 1, max: 4000 }),
                    anchorDim: fc.constantFrom(2, 3),
                    scaleDim: fc.constantFrom(2, 3),
                    zAnchor: fc.integer({ min: -500, max: 500 }),
                    zScale: fc.integer({ min: -500, max: 500 }),
                    // How indeterminate dims manifest when hasDims is false.
                    zeroKind: fc.constantFrom("zero", "undef", "null"),
                }),
                (r) => {
                    const recorder = createRecorder();

                    const anchorValue = r.anchorDim === 3 ? [0, 0, r.zAnchor] : [0, 0];
                    const scaleValue = r.scaleDim === 3 ? [100, 100, r.zScale] : [100, 100];
                    const tg = buildTransformGroup(recorder, {
                        anchorValue: anchorValue,
                        scaleValue: scaleValue,
                        // Keep position unanimated so it never interferes; it is
                        // asserted separately in Property 6.
                        expressionEnabled: false,
                        numKeys: 0,
                    });

                    let layerOpts;
                    if (r.hasDims) {
                        layerOpts = {
                            properties: { "ADBE Transform Group": tg },
                            source: { width: r.sw, height: r.sh },
                        };
                    } else {
                        // No determinable dims via source OR layer.
                        let source = null;
                        let width, height;
                        if (r.zeroKind === "zero") {
                            source = null; width = 0; height = 0;
                        } else if (r.zeroKind === "undef") {
                            source = null; width = undefined; height = undefined;
                        } else {
                            source = { width: null, height: null }; width = undefined; height = undefined;
                        }
                        layerOpts = {
                            properties: { "ADBE Transform Group": tg },
                            source: source,
                            width: width,
                            height: height,
                        };
                    }

                    const layer = createLayerFake(layerOpts);
                    const comp = createCompFake({ width: r.cw, height: r.ch });

                    const result = fitLayerToComp(layer, comp);

                    if (r.hasDims) {
                        expect(result.success).toBe(true);

                        // Req 5.1: anchor -> source center.
                        expect(tg.anchor.valueHistory.length).toBe(1);
                        expect(tg.anchor.value[0]).toBeCloseTo(r.sw / 2, 6);
                        expect(tg.anchor.value[1]).toBeCloseTo(r.sh / 2, 6);
                        // Req 5.5: preserve Z on 3D, stay 2D otherwise.
                        if (r.anchorDim === 3) {
                            expect(tg.anchor.value.length).toBe(3);
                            expect(tg.anchor.value[2]).toBe(r.zAnchor);
                        } else {
                            expect(tg.anchor.value.length).toBe(2);
                        }

                        // Req 5.4: independent per-axis scale from comp/src.
                        expect(tg.scale.valueHistory.length).toBe(1);
                        expect(tg.scale.value[0]).toBeCloseTo((r.cw / r.sw) * 100, 6);
                        expect(tg.scale.value[1]).toBeCloseTo((r.ch / r.sh) * 100, 6);
                        // Req 5.5: preserve Z on 3D scale.
                        if (r.scaleDim === 3) {
                            expect(tg.scale.value.length).toBe(3);
                            expect(tg.scale.value[2]).toBe(r.zScale);
                        } else {
                            expect(tg.scale.value.length).toBe(2);
                        }
                    } else {
                        // Req 5.6: indeterminate dims -> failure, nothing written.
                        expect(result.success).toBe(false);
                        expect(tg.anchor.valueHistory.length).toBe(0);
                        expect(tg.scale.valueHistory.length).toBe(0);
                        expect(tg.position.valueHistory.length).toBe(0);
                    }
                }
            ),
            { numRuns: 100 }
        );
    });

    // ------------------------------------------------------------------
    // Feature: engine-robustness-hardening, Property 6
    // Fit sets position to comp center only when unanimated.
    // Validates: Requirements 5.2, 5.3
    // ------------------------------------------------------------------
    test("Property 6: position -> comp center only when no expression and zero keys", () => {
        const { fitLayerToComp } = loadFit();

        fc.assert(
            fc.property(
                fc.record({
                    expressionEnabled: fc.boolean(),
                    numKeys: fc.nat({ max: 10 }),
                    sw: fc.integer({ min: 1, max: 4000 }),
                    sh: fc.integer({ min: 1, max: 4000 }),
                    cw: fc.integer({ min: 1, max: 4000 }),
                    ch: fc.integer({ min: 1, max: 4000 }),
                    posDim: fc.constantFrom(2, 3),
                    zPos: fc.integer({ min: -500, max: 500 }),
                }),
                (r) => {
                    const recorder = createRecorder();

                    const positionValue = r.posDim === 3 ? [-1, -1, r.zPos] : [-1, -1];
                    const tg = buildTransformGroup(recorder, {
                        positionValue: positionValue,
                        expressionEnabled: r.expressionEnabled,
                        numKeys: r.numKeys,
                    });

                    const layer = createLayerFake({
                        properties: { "ADBE Transform Group": tg },
                        source: { width: r.sw, height: r.sh },
                    });
                    const comp = createCompFake({ width: r.cw, height: r.ch });

                    const result = fitLayerToComp(layer, comp);
                    expect(result.success).toBe(true);

                    const shouldSet = r.expressionEnabled === false && r.numKeys === 0;
                    if (shouldSet) {
                        // Req 5.2: position moved to comp center.
                        expect(tg.position.valueHistory.length).toBe(1);
                        expect(tg.position.value[0]).toBeCloseTo(r.cw / 2, 6);
                        expect(tg.position.value[1]).toBeCloseTo(r.ch / 2, 6);
                        if (r.posDim === 3) {
                            expect(tg.position.value.length).toBe(3);
                            expect(tg.position.value[2]).toBe(r.zPos);
                        } else {
                            expect(tg.position.value.length).toBe(2);
                        }
                    } else {
                        // Req 5.3: animated/expressioned position left unchanged.
                        expect(tg.position.valueHistory.length).toBe(0);
                        expect(tg.position.value).toEqual(positionValue);
                    }
                }
            ),
            { numRuns: 100 }
        );
    });

    // ------------------------------------------------------------------
    // Feature: engine-robustness-hardening, Property 7
    // Deep fit fits each nested level to its enclosing comp, stops at guard.
    // Validates: Requirement 5.7
    // ------------------------------------------------------------------
    test("Property 7: deep fit fits each level once paired with its enclosing comp, stops at guard", () => {
        const { deepFitLayerToComp } = loadFit();

        fc.assert(
            fc.property(
                // Chain length spans below, at, and beyond the traversal guard.
                fc.integer({ min: 1, max: 30 }),
                (length) => {
                    const recorder = createRecorder();

                    // Distinct comp dims per level so scale identifies the exact
                    // enclosing comp used for each level's fit.
                    const compW = [];
                    const compH = [];
                    for (let k = 0; k < length; k++) {
                        compW[k] = 200 + k * 13;
                        compH[k] = 120 + k * 7;
                    }

                    // comps[0] is the top comp (passed to deepFit). comps[k>=1] are
                    // the source precomps that enclose layer_k.
                    const comps = [];
                    for (let k = 0; k < length; k++) {
                        comps[k] = createCompFake({
                            label: "comp" + k, recorder: recorder,
                            width: compW[k], height: compH[k],
                        });
                    }

                    const layers = [];
                    const tgs = [];
                    // Per-level expected source dims used by the fit.
                    const srcW = [];
                    const srcH = [];

                    for (let k = 0; k < length; k++) {
                        const isDeepest = k === length - 1;
                        const tg = buildTransformGroup(recorder, {
                            anchorValue: [0, 0],
                            scaleValue: [100, 100],
                            expressionEnabled: false,
                            numKeys: 0,
                        });
                        tgs[k] = tg;

                        const layerOpts = {
                            label: "layer" + k,
                            recorder: recorder,
                            properties: { "ADBE Transform Group": tg },
                        };

                        if (!isDeepest) {
                            // Source is the next precomp; its dims drive the fit.
                            layerOpts.source = comps[k + 1];
                            srcW[k] = compW[k + 1];
                            srcH[k] = compH[k + 1];
                        } else {
                            // Deepest layer has a non-comp source -> layer dims.
                            layerOpts.source = null;
                            layerOpts.width = 50 + k;
                            layerOpts.height = 40 + k;
                            srcW[k] = 50 + k;
                            srcH[k] = 40 + k;
                        }

                        layers[k] = createLayerFake(layerOpts);
                    }

                    // Wire each precomp's 1-based LayerCollection so traversal
                    // finds layer_k inside comps[k] (its enclosing comp).
                    for (let k = 1; k < length; k++) {
                        comps[k].layers = layersCollection([layers[k]]);
                    }

                    // Deep fit the top layer against the top comp.
                    const result = deepFitLayerToComp(layers[0], comps[0]);

                    // Never throws; returns a result object.
                    expect(result).toBeDefined();
                    expect(result.success).toBe(true);

                    const expectedFits = Math.min(length, MAX_DEPTH);
                    expect(result.levels).toBe(expectedFits);

                    for (let k = 0; k < length; k++) {
                        const tg = tgs[k];
                        if (k < MAX_DEPTH) {
                            // Req 5.7: fit invoked exactly once for this level.
                            expect(tg.anchor.valueHistory.length).toBe(1);
                            expect(tg.anchor.value[0]).toBeCloseTo(srcW[k] / 2, 6);
                            expect(tg.anchor.value[1]).toBeCloseTo(srcH[k] / 2, 6);
                            // Paired with its own enclosing comp (comps[k] dims).
                            expect(tg.scale.value[0]).toBeCloseTo((compW[k] / srcW[k]) * 100, 6);
                            expect(tg.scale.value[1]).toBeCloseTo((compH[k] / srcH[k]) * 100, 6);
                        } else {
                            // Beyond the guard: never fitted.
                            expect(tg.anchor.valueHistory.length).toBe(0);
                            expect(tg.scale.valueHistory.length).toBe(0);
                        }
                    }
                }
            ),
            { numRuns: 100 }
        );
    });
});
