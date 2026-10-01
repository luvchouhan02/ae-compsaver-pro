// ============================================================
// tests/comp-selection-resolution.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.2)
//
// Property 5 — Selection Resolution Agreement.
//
//   For ANY selection state, getStrictSaveType reporting type:"comp" implies
//   resolveCompForSave returns ok:true, and the composition it returns is the
//   composition whose name getStrictSaveType put in `suggestedName`.
//
// Both functions are sliced into ONE realm (Harness A) so they walk the SAME
// `app.project` state — the two-realm alternative could not detect disagreement
// at all. The generated space is the one the task names:
//   {0, 1, 2+ timeline layers} x {precomp, non-precomp}
//   x {0, 1, 2+ project comps} x {0, n non-comp project items}
//   x {active comp present / absent}
//
// typeof-guard branches exercised
// ------------------------------
//   csResolveCompTarget — sliced IN, so getStrictSaveType takes its PRIMARY
//                         branch (the canonical alias) rather than the
//                         documented `resolveCompForSave()` fallback. Both route
//                         to one body, which is the point of F3: the fallback
//                         cannot be a second rule set.
//   classifyLayer / detectEffectsOnSelection / getLayerEffectCount — injected
//                         stubs; they live in other jsx files and are not part
//                         of the resolution rule under test.
//
// **Validates: Requirements 2.3, 2.4**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

// ─────────────────────────────────────────────────────────────
// Selection-state generators
//
// A layer's classifyLayer verdict and its DOM shape are generated together,
// because in production they are the same fact: classifyLayer answers "comp"
// exactly for an AVLayer whose source is a CompItem, which is exactly the shape
// resolveCompForSave tests for. Decoupling them would generate states After
// Effects cannot produce.
// ─────────────────────────────────────────────────────────────
const LAYER_KINDS = ["precomp", "text", "footage", "shape", "unknown"];

function makeLayer(kind, seq) {
    switch (kind) {
        case "precomp":
            return {
                __kind: "avlayer", __classify: "comp",
                name: "Precomp Layer " + seq,
                source: H.fakeComp("Nested Comp " + seq),
            };
        case "text":
            return { __kind: "textlayer", __classify: "text", name: "Text Layer " + seq, source: null };
        case "footage":
            return {
                __kind: "avlayer", __classify: "footage",
                name: "Footage Layer " + seq, source: { __kind: "footage", name: "clip" + seq + ".mp4" },
            };
        case "shape":
            return { __kind: "avlayer", __classify: "layer", name: "Shape Layer " + seq, source: null };
        default:
            return { __kind: "avlayer", __classify: "unknown", name: "Weird Layer " + seq, source: null };
    }
}

const arbTimelineLayers = fc
    .array(fc.constantFrom.apply(null, LAYER_KINDS), { minLength: 0, maxLength: 3 })
    .map((kinds) => kinds.map((k, i) => makeLayer(k, i + 1)));

// Project-panel selection: 0..2 comps plus 0..2 non-comp items, interleaved in a
// generated order so "the first comp is not the only comp" states are reached.
const arbProjectSelection = fc
    .array(fc.constantFrom("comp", "footage", "folder"), { minLength: 0, maxLength: 4 })
    .map((kinds) =>
        kinds.map((k, i) => {
            if (k === "comp") return H.fakeComp("Project Comp " + (i + 1));
            if (k === "folder") return { __kind: "folder", name: "Folder " + (i + 1) };
            return { __kind: "footage", name: "asset" + (i + 1) + ".png" };
        })
    );

// The viewer: an open composition, a non-comp active item, or nothing at all.
const arbActiveItem = fc.constantFrom("comp", "footage", "none");

function buildState(activeKind, layers, projectSelection) {
    let activeComp = null;
    if (activeKind === "comp") {
        activeComp = H.fakeComp("Active Comp");
        Object.defineProperty(activeComp, "selectedLayers", {
            configurable: true,
            get: function () { return layers; },
        });
    } else if (activeKind === "footage") {
        activeComp = { __kind: "footage", name: "active-footage.mov" };
    }
    return { activeComp: activeComp, selection: projectSelection };
}

/** Every composition reachable from a state, for the identity assertion. */
function reachableComps(state, layers) {
    const out = [];
    if (state.activeComp && state.activeComp.__kind === "comp") out.push(state.activeComp);
    layers.forEach((l) => { if (l.source && l.source.__kind === "comp") out.push(l.source); });
    (state.selection || []).forEach((s) => { if (s.__kind === "comp") out.push(s); });
    return out;
}

// ============================================================
describe("Property 5 — the two resolvers agree on capability and on the comp", () => {
    test("type === \"comp\" implies resolveCompForSave().ok, and suggestedName is the resolved comp's name", () => {
        fc.assert(
            fc.property(arbActiveItem, arbTimelineLayers, arbProjectSelection,
                (activeKind, layers, projectSelection) => {
                    const state = buildState(activeKind, layers, projectSelection);
                    const h = H.buildResolverRealm(state);

                    if (h.strict.type !== "comp") return; // the implication's antecedent is false

                    expect(h.resolved.ok).toBe(true);
                    expect(h.resolved.comp).toBeTruthy();
                    expect(h.strict.suggestedName).toBe(h.resolved.comp.name);
                    // The comp is one that actually exists in the state, not a
                    // name assembled from a different item.
                    expect(reachableComps(state, layers)).toContain(h.resolved.comp);
                }),
            { numRuns: 600 }
        );
    });

    test("the contrapositive: a refusing engine is never advertised as a comp save", () => {
        fc.assert(
            fc.property(arbActiveItem, arbTimelineLayers, arbProjectSelection,
                (activeKind, layers, projectSelection) => {
                    const h = H.buildResolverRealm(buildState(activeKind, layers, projectSelection));
                    if (h.resolved.ok) return;

                    // A refusal must never surface as an available COMP save. It
                    // may still surface as a different save type — a shape-layer
                    // selection is a legitimate `type:"layer"`, not a
                    // disagreement about comps — so only the comp claim is
                    // constrained here.
                    expect(h.strict.type).not.toBe("comp");
                    expect(typeof h.resolved.error).toBe("string");
                    expect(h.resolved.error.length).toBeGreaterThan(0);

                    // When the panel reports "error" for a state that offers no
                    // save at all, the reason it shows is the ENGINE's reason:
                    // one resolver, one message.
                    const noOtherSaveType = layers.length === 0;
                    if (noOtherSaveType) {
                        expect(h.strict.type).toBe("error");
                        expect(h.strict.message).toBe(h.resolved.error);
                    }
                }),
            { numRuns: 600 }
        );
    });

    test("resolution is deterministic: the same state resolves identically on repeated calls", () => {
        fc.assert(
            fc.property(arbActiveItem, arbTimelineLayers, arbProjectSelection,
                (activeKind, layers, projectSelection) => {
                    const h = H.buildResolverRealm(buildState(activeKind, layers, projectSelection));
                    const again = h.ctx.resolveCompForSave();
                    const strictAgain = JSON.parse(h.ctx.decodeBridge(h.ctx.getStrictSaveType()));
                    expect(again.ok).toBe(h.resolved.ok);
                    expect(again.comp).toBe(h.resolved.comp);
                    expect(strictAgain).toEqual(h.strict);
                }),
            { numRuns: 300 }
        );
    });

    test("the canonical alias and the entry point are the same body", () => {
        fc.assert(
            fc.property(arbActiveItem, arbTimelineLayers, arbProjectSelection,
                (activeKind, layers, projectSelection) => {
                    const h = H.buildResolverRealm(buildState(activeKind, layers, projectSelection));
                    const viaAlias = h.ctx.csResolveCompTarget();
                    expect(viaAlias.ok).toBe(h.resolved.ok);
                    expect(viaAlias.comp).toBe(h.resolved.comp);
                    expect(viaAlias.source).toBe(h.resolved.source);
                }),
            { numRuns: 200 }
        );
    });
});

// ============================================================
// The four states the design calls out by name (1.3 / 1.4), pinned so a
// regression names the case rather than only a shrunk generator path.
// ============================================================
describe("Property 5 — the named states", () => {
    test("empty selection with an open composition: both offer the active comp", () => {
        const h = H.buildResolverRealm(buildState("comp", [], []));
        expect(h.strict.type).toBe("comp");
        expect(h.resolved.ok).toBe(true);
        expect(h.resolved.source).toBe("active");
        expect(h.strict.suggestedName).toBe("Active Comp");
    });

    test("one project comp alongside a non-comp item: the announced comp IS the saved comp", () => {
        const projectComp = H.fakeComp("Comp A");
        const footage = { __kind: "footage", name: "logo.png" };
        const active = H.fakeComp("Comp B");
        Object.defineProperty(active, "selectedLayers", { get: function () { return []; } });

        const h = H.buildResolverRealm({ activeComp: active, selection: [projectComp, footage] });
        expect(h.strict.type).toBe("comp");
        expect(h.resolved.ok).toBe(true);
        expect(h.resolved.comp).toBe(projectComp);
        expect(h.strict.suggestedName).toBe("Comp A");
    });

    test("one precomp layer selected in the timeline: both target the nested comp", () => {
        const layers = [makeLayer("precomp", 7)];
        const h = H.buildResolverRealm(buildState("comp", layers, []));
        expect(h.strict.type).toBe("comp");
        expect(h.resolved.ok).toBe(true);
        expect(h.resolved.comp).toBe(layers[0].source);
        expect(h.strict.suggestedName).toBe("Nested Comp 7");
    });

    test("two project comps: both refuse, and the panel shows the engine's reason", () => {
        const active = H.fakeComp("Active Comp");
        Object.defineProperty(active, "selectedLayers", { get: function () { return []; } });
        const h = H.buildResolverRealm({
            activeComp: active,
            selection: [H.fakeComp("Comp A"), H.fakeComp("Comp B")],
        });
        expect(h.resolved.ok).toBe(false);
        expect(h.strict.type).toBe("error");
        expect(h.strict.message).toBe(h.resolved.error);
    });

    test("nothing open and nothing selected: both refuse with the shared message", () => {
        const h = H.buildResolverRealm(buildState("none", [], []));
        expect(h.resolved.ok).toBe(false);
        expect(h.strict.type).toBe("error");
        expect(h.strict.message).toBe(h.resolved.error);
        expect(h.resolved.error).toContain("open a composition");
    });
});
