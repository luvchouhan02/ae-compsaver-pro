// ============================================================
// tests/import-anchor-placement.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.9)
//
// Property 11 — Anchor Correctness Under Duplicate Names And Batching.
//
//   For ANY active composition containing two or more layers sharing the anchor's
//   name, the imported layer's index SHALL be exactly one less than the index of
//   the layer that was actually SELECTED; and for ANY batch of N templates, every
//   template's anchor SHALL be the layer that was selected before the batch began.
//
// The pre-fix defects this generalizes:
//   1.21  placeLayerAtPlayhead threw away the still-valid anchor REFERENCE and
//         re-found the anchor BY NAME, which is ambiguous by construction: with
//         two layers called "BG" the first match won and the imported layer
//         landed above the wrong one.
//   1.22  placeLayerAtPlayhead selects the layer it just inserted, so a
//         per-template getTopSelectedLayer anchored template n to the layer
//         template n-1 inserted.
//
// The real placeLayerAtPlayhead, importBatch, importCompDirect, getTopSelectedLayer
// and the csBatchAnchor* latch all run in a `vm`. The harness wraps the REAL
// getTopSelectedLayer so the anchor handed to each template is observable BY
// IDENTITY, not by name — which is the only way to tell a correct anchor from a
// same-named impostor.
//
// typeof-guard branches exercised
// ------------------------------
//   PRIMARY  — csResolveImportAnchor, csBatchAnchorBegin/Reselect/End are sliced
//              in, so importCompDirect resolves through the latch and importBatch
//              latches and restores through csBatchAnchorBegin/End rather than
//              through its inlined csBatchAnchorRestoreLocal.
//   FALLBACK — one test re-runs the batch property with anchorLatch:false, the
//              branch the two baseline suites exercise (bare getTopSelectedLayer
//              plus csBatchAnchorRestoreLocal), to prove the inline twin is the
//              same rule and not a second one.
//   jsonParse / decodeBridgeStrict — absent from the slice, so importBatch decodes
//              its payload through the documented inline fallbacks.
//
// **Validates: Requirements 2.21, 2.22**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

/** A copyLayersToComp that really adds one layer per source layer, AE-style (top). */
function realCopyLayersToComp(layers, target) {
    for (let i = 0; i < layers.length; i++) target.layers.add({ name: layers[i].name });
}

// ─────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────
// A layer-name list with DELIBERATE duplicates: the alphabet is tiny, so a
// 3..8 layer comp almost always shares names, and the anchor's own name is
// guaranteed to occur at least twice by the construction in makeCompWithDupes.
const arbLayerNames = fc.array(fc.constantFrom("BG", "FG", "Text", "BG"), { minLength: 2, maxLength: 7 });
const arbBatchSize = fc.integer({ min: 1, max: 10 });
const arbSection = fc.constantFrom("comp", "layer");

/**
 * Build an active comp whose layers carry `names`, then force at least TWO
 * layers to share the SELECTED layer's name and select the one at
 * `selectedIndex` (0-based over the layer list).
 */
function makeCompWithDupes(h, names, selectedIndex) {
    const active = h.model.makeComp("Active Comp");
    const layers = names.map((n) => h.model.appendLayer(active, n));
    const chosen = layers[selectedIndex % layers.length];
    // Guarantee ambiguity: give a DIFFERENT layer the chosen layer's name.
    const twinIndex = (layers.indexOf(chosen) + 1) % layers.length;
    if (layers.length > 1) layers[twinIndex].name = chosen.name;
    chosen.selected = true;
    h.model.project.activeItem = active;
    return { active: active, layers: layers, chosen: chosen, twin: layers[twinIndex] };
}

function installImporter(h) {
    let seq = 0;
    h.model.project.__importer = function () {
        seq++;
        const folder = h.model.makeItem("folder", "Imported " + seq);
        const comp = h.model.makeComp("Template " + seq, folder);
        h.model.insertLayer(comp, "inner " + seq, 1);
        return folder;
    };
}

function batchPayload(n, section) {
    const templates = [];
    for (let i = 1; i <= n; i++) {
        templates.push({
            id: "t" + i, name: "T" + i, category: "Cat",
            section: section, sourcePath: "C:/lib",
        });
    }
    return { rootPath: "C:/lib", templates: templates };
}

// ============================================================
// placeLayerAtPlayhead — the anchor REFERENCE, not its name
// ============================================================
describe("Property 11 — the new layer lands above the SELECTED layer", () => {
    test("with duplicate names, newLayer.index === anchor.index - 1 for every selection", () => {
        fc.assert(
            fc.property(arbLayerNames, fc.nat(), fc.double({ min: 0, max: 20, noNaN: true }),
                (names, pick, playhead) => {
                    const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                    const scene = makeCompWithDupes(h, names, pick);

                    // AE inserts an added layer at index 1.
                    const newLayer = scene.active.layers.add({ name: "Imported" });
                    h.ctx.placeLayerAtPlayhead(scene.active, newLayer, playhead, scene.chosen);

                    expect(newLayer.index).toBe(scene.chosen.index - 1);
                    // Directly above the SELECTED reference, not its same-named twin.
                    expect(scene.active.__layers[newLayer.index]).toBe(scene.chosen);
                    // The insert is the new selection (which is what made the
                    // per-template anchor drift possible in the first place).
                    expect(newLayer.selected).toBe(true);
                }),
            { numRuns: 500 }
        );
    });

    test("the same-named twin is never used as the anchor", () => {
        fc.assert(
            fc.property(arbLayerNames, fc.nat(), (names, pick) => {
                const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                const scene = makeCompWithDupes(h, names, pick);
                fc.pre(scene.twin !== scene.chosen);
                expect(scene.twin.name).toBe(scene.chosen.name);

                const newLayer = scene.active.layers.add({ name: "Imported" });
                h.ctx.placeLayerAtPlayhead(scene.active, newLayer, 3, scene.chosen);

                const landedAbove = scene.active.__layers[newLayer.index];
                expect(landedAbove).toBe(scene.chosen);
                expect(landedAbove).not.toBe(scene.twin);
            }),
            { numRuns: 400 }
        );
    });

    test("a STALE anchor reference degrades to the documented name scan instead of throwing", () => {
        fc.assert(
            fc.property(arbLayerNames, fc.nat(), (names, pick) => {
                const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                const scene = makeCompWithDupes(h, names, pick);
                const newLayer = scene.active.layers.add({ name: "Imported" });

                // Reading .index on an invalidated AE reference throws — that IS
                // the liveness probe the fix relies on.
                const stale = { name: scene.chosen.name };
                Object.defineProperty(stale, "index", {
                    get: function () { throw new Error("invalid object reference"); },
                });

                expect(() => h.ctx.placeLayerAtPlayhead(scene.active, newLayer, 3, stale)).not.toThrow();
                // Still a member of the comp, still selected, nothing corrupted.
                expect(scene.active.__layers).toContain(newLayer);
                expect(newLayer.selected).toBe(true);
            }),
            { numRuns: 300 }
        );
    });

    test("a null anchor, and an anchor that IS the new layer, are both no-ops", () => {
        fc.assert(
            fc.property(arbLayerNames, (names) => {
                [null, undefined, "self"].forEach((kind) => {
                    const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                    const scene = makeCompWithDupes(h, names, 0);
                    const newLayer = scene.active.layers.add({ name: "Imported" });
                    const anchor = kind === "self" ? newLayer : kind;
                    expect(() => h.ctx.placeLayerAtPlayhead(scene.active, newLayer, 2, anchor))
                        .not.toThrow();
                    // AE's insertion index is untouched when there is no anchor.
                    expect(newLayer.index).toBe(1);
                    expect(newLayer.selected).toBe(true);
                });
            }),
            { numRuns: 120 }
        );
    });
});

// ============================================================
// The batch: every template anchors to the PRE-ACTION selection
// ============================================================
describe("Property 11 — every template in a batch anchors to the pre-action selection", () => {
    test("for N = 1..10 templates, the anchor handed to each template IS the selected layer", () => {
        fc.assert(
            fc.property(arbBatchSize, arbSection, arbLayerNames, fc.nat(),
                (n, section, names, pick) => {
                    const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                    const scene = makeCompWithDupes(h, names, pick);
                    installImporter(h);

                    const res = h.runBatch(batchPayload(n, section));
                    res.perTemplate.forEach((e) => expect(e.status).toBe("imported"));

                    // The latch calls getTopSelectedLayer once for itself and once
                    // per template; EVERY resolution must hand back the same
                    // reference the user selected — never the previous insert.
                    expect(h.anchorLog.length).toBeGreaterThanOrEqual(n);
                    h.anchorLog.forEach((a) => expect(a).toBe(scene.chosen));

                    // The user's pre-action selection is restored at batch end.
                    expect(scene.chosen.selected).toBe(true);
                    const selected = scene.active.__layers.filter((l) => l.selected);
                    expect(selected).toEqual([scene.chosen]);
                }),
            { numRuns: 400 }
        );
    });

    test("every imported layer in the batch sits directly above the selected layer", () => {
        fc.assert(
            fc.property(arbBatchSize, arbSection, arbLayerNames, fc.nat(),
                (n, section, names, pick) => {
                    const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                    const scene = makeCompWithDupes(h, names, pick);
                    const preExisting = scene.active.__layers.slice();
                    installImporter(h);

                    const res = h.runBatch(batchPayload(n, section));
                    res.perTemplate.forEach((e) => expect(e.status).toBe("imported"));

                    // Inserted layers are identified BY IDENTITY (exclusion from the
                    // pre-action set), never by name — a name test would be exactly
                    // the ambiguity 1.21 was about.
                    const order = scene.active.__layers;
                    const inserted = order.filter((l) => preExisting.indexOf(l) === -1);
                    expect(inserted.length).toBe(n);

                    // They occupy the n contiguous slots immediately ABOVE the anchor.
                    const anchorAt = order.indexOf(scene.chosen);
                    expect(order.slice(anchorAt - n, anchorAt)).toEqual(inserted);
                    // Nothing landed at or below the anchor.
                    order.slice(anchorAt).forEach((l) => expect(preExisting).toContain(l));
                    // ...and every pre-existing layer survived, in its original order.
                    expect(order.filter((l) => preExisting.indexOf(l) !== -1)).toEqual(preExisting);
                }),
            { numRuns: 400 }
        );
    });

    test("an EMPTY pre-action selection keeps the anchor null for the whole batch", () => {
        fc.assert(
            fc.property(arbBatchSize, arbLayerNames, (n, names) => {
                const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                const active = h.model.makeComp("Active Comp");
                names.forEach((nm) => h.model.appendLayer(active, nm));
                h.model.project.activeItem = active;
                installImporter(h);

                const res = h.runBatch(batchPayload(n, "comp"));
                res.perTemplate.forEach((e) => expect(e.status).toBe("imported"));

                // No selection latched, so no template may borrow the previous
                // template's insert as an anchor.
                h.anchorLog.forEach((a) => expect(a).toBe(null));
                // ...and the empty selection is restored.
                expect(active.__layers.filter((l) => l.selected)).toEqual([]);
            }),
            { numRuns: 250 }
        );
    });

    test("a MULTI-layer pre-action selection latches the topmost and restores all of it", () => {
        fc.assert(
            fc.property(arbBatchSize, fc.integer({ min: 2, max: 5 }), (n, selCount) => {
                const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                const active = h.model.makeComp("Active Comp");
                const layers = [];
                for (let i = 0; i < 6; i++) layers.push(h.model.appendLayer(active, "BG"));
                const selected = layers.slice(6 - selCount);
                selected.forEach((l) => { l.selected = true; });
                const topmost = selected[0];
                h.model.project.activeItem = active;
                installImporter(h);

                h.runBatch(batchPayload(n, "comp"));

                // getTopSelectedLayer picks the lowest index among the selection.
                h.anchorLog.forEach((a) => expect(a).toBe(topmost));
                // The WHOLE pre-action selection comes back.
                const after = active.__layers.filter((l) => l.selected);
                expect(after.length).toBe(selCount);
                selected.forEach((l) => expect(after).toContain(l));
            }),
            { numRuns: 250 }
        );
    });

    test("a standalone import (no batch, no latch) anchors to the live selection", () => {
        fc.assert(
            fc.property(arbLayerNames, fc.nat(), arbSection, (names, pick, section) => {
                const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                const scene = makeCompWithDupes(h, names, pick);
                installImporter(h);

                const e = h.ctx.encodeBridge;
                const fn = section === "comp" ? "importCompDirect" : "importLayerTypeAep";
                expect(h.ctx.decodeBridge(h.ctx[fn](e("T"), e("Cat"), e("C:/lib"), section))).toBe("true");

                expect(h.anchorLog.length).toBe(1);
                expect(h.anchorLog[0]).toBe(scene.chosen);
                const newLayer = scene.active.__layers[scene.active.__layers.indexOf(scene.chosen) - 1];
                expect(newLayer).toBeTruthy();
                expect(newLayer.index).toBe(scene.chosen.index - 1);
            }),
            { numRuns: 300 }
        );
    });

    test("the INLINE latch fallback anchors every template to the pre-action selection too", () => {
        // anchorLatch:false removes csResolveImportAnchor and the csBatchAnchor*
        // helpers, so importBatch uses its inlined csBatchAnchorRestoreLocal and
        // the per-section routines fall back to a bare getTopSelectedLayer. The
        // inlined twin must produce the SAME anchoring.
        fc.assert(
            fc.property(arbBatchSize, arbLayerNames, fc.nat(), (n, names, pick) => {
                const h = H.buildImportRealm({
                    anchorLatch: false, copyLayersToComp: realCopyLayersToComp,
                });
                const scene = makeCompWithDupes(h, names, pick);
                installImporter(h);

                const res = h.runBatch(batchPayload(n, "comp"));
                res.perTemplate.forEach((e) => expect(e.status).toBe("imported"));

                expect(h.anchorLog.length).toBe(n);
                h.anchorLog.forEach((a) => expect(a).toBe(scene.chosen));
                expect(scene.chosen.selected).toBe(true);
            }),
            { numRuns: 300 }
        );
    });
});
