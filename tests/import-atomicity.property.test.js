// ============================================================
// tests/import-atomicity.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.8)
//
// Property 10 — Import Atomicity.
//
//   For ANY import that fails at any point after app.project.importFile has run,
//   whether standalone or inside a batch, the multiset of project item ids after
//   the attempt SHALL equal the multiset before it; and for any sequence of
//   successful comp imports, the number of root-level Project-panel folders added
//   SHALL be at most ONE in total, not one per import.
//
// The REAL importCompDirect / importLayerTypeAep / importBatch /
// toolkitOrganizeTemplateImport / csRollbackToSnapshot run in a `vm` over a
// project model that records every addFolder / remove / parentFolder mutation and
// can report its item-id multiset on demand.
//
// Failure-injection points, all five the task names:
//   importFileThrows  app.project.importFile throws
//   zeroItems         importFile returns nothing -> "Import failed!"
//   noComp            an .aep that yields footage but no composition
//   recursive         the imported comp IS the active comp
//   layersAddFails    activeComp.layers.add returns null / throws
// crossed with { standalone, in a batch } and with the layer-family engine.
//
// typeof-guard branches exercised
// ------------------------------
//   PRIMARY  — csFindOrCreateRootFolder / csFindOrCreateSubFolder are sliced in,
//              so toolkitOrganizeTemplateImport uses them rather than its inline
//              fallback; csResolveImportAnchor and the csBatchAnchor* latch are
//              sliced in, so importBatch and importCompDirect take their primary
//              anchor branch; cleanupImportedItems is sliced in, so
//              importCompDirect's scope-exit calls it rather than inlining the
//              removal loop.
//   FALLBACK — one dedicated test re-runs the container property with
//              containerHelpers:false, which is the branch the two baseline
//              suites exercise, to prove the inline fallback is the same rule.
//   jsonParse — NOT sliced (its body has braces inside string literals), so
//              importBatch decodes its payload through the documented
//              `typeof jsonParse === "function" ? ... : JSON.parse(...)` guard's
//              FALLBACK branch. decodeBridgeStrict is likewise absent, so the
//              payload decode also takes its documented inline branch.
//
// **Validates: Requirements 2.18, 2.19, 2.20, 3.10**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

const FAILURE_MODES = ["importFileThrows", "zeroItems", "noComp", "recursive", "layersAddFails"];
// The modes whose failure point is reached BEFORE toolkitOrganizeTemplateImport
// has created the reusable container. See the REPORTED FINDING block below for
// why `layersAddFails` is excluded from the standalone total-restoration clause.
const PRE_ORGANIZE_MODES = ["importFileThrows", "zeroItems", "noComp", "recursive"];

const arbFailureMode = fc.constantFrom.apply(null, FAILURE_MODES);
const arbPreOrganizeMode = fc.constantFrom.apply(null, PRE_ORGANIZE_MODES);
const arbSection = fc.constantFrom("comp", "layer");
const arbBatchSize = fc.integer({ min: 1, max: 6 });
const arbFootageCount = fc.integer({ min: 0, max: 3 });
const arbNestedFolders = fc.integer({ min: 0, max: 2 });

/** A copyLayersToComp that really adds one layer per source layer, AE-style (top). */
function realCopyLayersToComp(layers, target) {
    for (let i = 0; i < layers.length; i++) {
        target.layers.add({ name: layers[i].name });
    }
}

/**
 * Build an import realm with pre-existing project state, and install an importer
 * whose behavior is driven by `plan(seq)` -> failure mode for template `seq`.
 */
function makeScene(cfg) {
    cfg = cfg || {};
    const h = H.buildImportRealm({
        containerHelpers: cfg.containerHelpers,
        copyLayersToComp: realCopyLayersToComp,
    });

    // Pre-existing project state that every failure must leave untouched (3.10).
    const active = h.model.makeComp("Active Comp");
    const keepLayerA = h.model.appendLayer(active, "Pre-existing A");
    const keepLayerB = h.model.appendLayer(active, "Pre-existing B");
    keepLayerB.selected = true;
    const keepFolder = h.model.addFolder("User Folder");
    const keepFootage = h.model.makeItem("footage", "user-clip.mov", keepFolder);
    const keepComp = h.model.makeComp("User Comp");
    h.model.project.activeItem = active;

    let seq = 0;
    h.model.project.__importer = function () {
        seq++;
        const mode = cfg.plan ? cfg.plan(seq) : null;
        if (mode === "importFileThrows") throw new Error("importFile exploded");
        if (mode === "zeroItems") return null;

        const folder = h.model.makeItem("folder", "Imported Folder " + seq);
        for (let f = 0; f < (cfg.footage || 0); f++) {
            h.model.makeItem("footage", "clip" + seq + "-" + f + ".mp4", folder);
        }
        let parent = folder;
        for (let d = 0; d < (cfg.nested || 0); d++) {
            parent = h.model.makeItem("folder", "Nested " + seq + "-" + d, parent);
            h.model.makeItem("footage", "deep" + seq + "-" + d + ".png", parent);
        }
        if (mode === "noComp") return folder;

        const comp = h.model.makeComp("Template Comp " + seq, folder);
        h.model.insertLayer(comp, "inner " + seq, 1);
        if (mode === "recursive") comp.id = active.id;
        return folder;
    };

    return {
        h: h, active: active,
        keep: {
            layers: [keepLayerA, keepLayerB],
            items: [keepFolder, keepFootage, keepComp],
        },
        setLayersAddFailure: function (throws) {
            if (throws) active.__layersAddThrows = true;
            else active.__layersAddReturnsNull = true;
        },
    };
}

function runStandalone(scene, section) {
    const e = scene.h.ctx.encodeBridge;
    const fn = section === "comp" ? "importCompDirect" : "importLayerTypeAep";
    return scene.h.ctx.decodeBridge(
        scene.h.ctx[fn](e("T"), e("Cat"), e("C:/lib"), section)
    );
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

function assertPreExistingSurvives(scene) {
    scene.keep.items.forEach((it) => {
        expect(it.__removed).not.toBe(true);
        expect(scene.h.model.all).toContain(it);
    });
    scene.keep.layers.forEach((l) => {
        expect(scene.active.__layers).toContain(l);
    });
}

// ============================================================
// Standalone imports — every failure point before the container is created
// ============================================================
describe("Property 10 — a failed standalone import restores the item-id multiset", () => {
    test("importCompDirect: every pre-organize failure point leaves the project exactly as it was", () => {
        fc.assert(
            fc.property(arbPreOrganizeMode, arbFootageCount, arbNestedFolders,
                (mode, footage, nested) => {
                    const scene = makeScene({ plan: () => mode, footage: footage, nested: nested });
                    const before = scene.h.model.itemIds();
                    const reply = runStandalone(scene, "comp");

                    expect(reply).not.toBe("true");
                    expect(scene.h.model.itemIds()).toEqual(before);
                    assertPreExistingSurvives(scene);
                    // No layer was added to the user's comp.
                    expect(scene.active.__layers.length).toBe(2);
                    // Balanced envelope on every failure path.
                    expect(scene.h.counters.undoBegin).toBe(scene.h.counters.undoEnd);
                    expect(scene.h.counters.suppressBegin).toBe(scene.h.counters.suppressEnd);
                }),
            { numRuns: 250 }
        );
    });

    test("importLayerTypeAep: every pre-organize failure point leaves the project exactly as it was", () => {
        fc.assert(
            fc.property(arbPreOrganizeMode, arbFootageCount, arbNestedFolders,
                (mode, footage, nested) => {
                    const scene = makeScene({ plan: () => mode, footage: footage, nested: nested });
                    const before = scene.h.model.itemIds();
                    const reply = runStandalone(scene, "layer");

                    expect(reply).not.toBe("true");
                    expect(scene.h.model.itemIds()).toEqual(before);
                    assertPreExistingSurvives(scene);
                    expect(scene.active.__layers.length).toBe(2);
                    expect(scene.h.counters.undoBegin).toBe(scene.h.counters.undoEnd);
                    expect(scene.h.counters.suppressBegin).toBe(scene.h.counters.suppressEnd);
                }),
            { numRuns: 250 }
        );
    });

    test("a pre-organize failure leaves no empty folder at the Project-panel root", () => {
        // `layersAddFails` is excluded: it is the one failure point that is
        // reached AFTER the organizer created the container, and the container is
        // outside the F9a cleanup scope. See the REPORTED FINDING block below,
        // which asserts that path directly.
        fc.assert(
            fc.property(arbPreOrganizeMode, arbSection, arbFootageCount, arbNestedFolders,
                (mode, section, footage, nested) => {
                    const scene = makeScene({ plan: () => mode, footage: footage, nested: nested });
                    runStandalone(scene, section);
                    const emptyRoots = scene.h.model.rootFolders()
                        .filter((f) => f.numItems === 0)
                        .map((f) => f.name);
                    expect(emptyRoots).toEqual([]);
                }),
            { numRuns: 300 }
        );
    });
});

// ============================================================
// Batch imports — the path the panel actually uses (one Bridge_Call)
// ============================================================
describe("Property 10 — a failed import inside a batch restores the item-id multiset", () => {
    test("an all-failing batch of any size and any failure point restores the project exactly", () => {
        fc.assert(
            fc.property(arbFailureMode, arbSection, arbBatchSize, fc.boolean(), arbFootageCount,
                (mode, section, n, throws, footage) => {
                    const scene = makeScene({ plan: () => mode, footage: footage });
                    if (mode === "layersAddFails") scene.setLayersAddFailure(throws);
                    const before = scene.h.model.itemIds();

                    const res = scene.h.runBatch(batchPayload(n, section));

                    // Result totality is preserved (3.11).
                    expect(res.perTemplate.length).toBe(n);
                    res.perTemplate.forEach((entry, i) => {
                        expect(entry.id).toBe("t" + (i + 1));
                        expect(entry.status).toBe("failed");
                    });

                    // csRollbackToSnapshot restores the WHOLE multiset, including
                    // any container folder the organizer created.
                    expect(scene.h.model.itemIds()).toEqual(before);
                    expect(scene.h.model.rootFolders().map((f) => f.name)).toEqual(["User Folder"]);
                    assertPreExistingSurvives(scene);
                    expect(scene.active.__layers.length).toBe(2);
                    // Exactly ONE undo group for the whole batch.
                    expect(scene.h.counters.undoBegin).toBe(1);
                    expect(scene.h.counters.undoEnd).toBe(1);
                    expect(scene.h.counters.suppressBegin).toBe(scene.h.counters.suppressEnd);
                }),
            { numRuns: 400 }
        );
    });

    test("a mid-batch failure removes ONLY the failed template's additions", () => {
        fc.assert(
            fc.property(arbFailureMode, arbSection, fc.integer({ min: 2, max: 6 }), fc.boolean(),
                (mode, section, n, throws) => {
                    const failAt = 1 + (n >> 1); // an interior template
                    const scene = makeScene({
                        plan: (seq) => (seq === failAt ? mode : null),
                        footage: 2,
                    });
                    // `layersAddFails` cannot be scoped to one template (the flag
                    // lives on the active comp), so it is exercised by the
                    // all-failing test above instead.
                    fc.pre(mode !== "layersAddFails");
                    if (throws) { /* the flag is unused for the interior case */ }

                    const before = scene.h.model.itemIds();
                    const res = scene.h.runBatch(batchPayload(n, section));

                    expect(res.perTemplate.length).toBe(n);
                    res.perTemplate.forEach((entry, i) => {
                        expect(entry.id).toBe("t" + (i + 1));
                        expect(entry.status).toBe(i + 1 === failAt ? "failed" : "imported");
                    });

                    // Every pre-existing item and layer survives.
                    assertPreExistingSurvives(scene);
                    before.forEach((id) => expect(scene.h.model.itemIds()).toContain(id));
                    // The successful templates each contributed a layer; the
                    // failed one contributed none.
                    expect(scene.active.__layers.length).toBe(2 + (n - 1));
                    // No template comp from the failed template survives.
                    const names = scene.h.model.all.map((i) => i.name);
                    expect(names).not.toContain("Template Comp " + failAt);
                    expect(names).not.toContain("Imported Folder " + failAt);
                    // One container, one undo group.
                    expect(scene.h.model.rootFolders().map((f) => f.name).sort())
                        .toEqual(["User Folder", "_CompSaver_Assets"]);
                    expect(scene.h.counters.undoBegin).toBe(1);
                    expect(scene.h.counters.undoEnd).toBe(1);
                }),
            { numRuns: 300 }
        );
    });
});

// ============================================================
// One container, never one per import
// ============================================================
describe("Property 10 — N successful imports add at most ONE root folder", () => {
    test("N successive standalone comp imports add exactly one container and zero empty root folders", () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 8 }), arbFootageCount, arbNestedFolders,
                (n, footage, nested) => {
                    const scene = makeScene({ footage: footage, nested: nested });
                    const rootsBefore = scene.h.model.rootFolders().length;
                    for (let i = 0; i < n; i++) {
                        expect(runStandalone(scene, "comp")).toBe("true");
                    }
                    const roots = scene.h.model.rootFolders().map((f) => f.name);
                    expect(roots.length).toBe(rootsBefore + 1);
                    expect(roots).toContain("_CompSaver_Assets");
                    expect(scene.h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);
                    // Every template really did land in the timeline.
                    expect(scene.active.__layers.length).toBe(2 + n);
                }),
            { numRuns: 200 }
        );
    });

    test("a batch of N successful imports adds exactly one container and zero empty root folders", () => {
        fc.assert(
            fc.property(arbBatchSize, arbSection, arbFootageCount, (n, section, footage) => {
                const scene = makeScene({ footage: footage });
                const rootsBefore = scene.h.model.rootFolders().length;
                const res = scene.h.runBatch(batchPayload(n, section));
                res.perTemplate.forEach((e) => expect(e.status).toBe("imported"));
                const roots = scene.h.model.rootFolders().map((f) => f.name);
                expect(roots.length).toBe(rootsBefore + 1);
                expect(roots).toContain("_CompSaver_Assets");
                expect(scene.h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);
                // ONE addFolder for the container across the whole batch, however
                // many templates it carried.
                const containerAdds = scene.h.model.mutations
                    .filter((m) => m.op === "addFolder" && m.name === "_CompSaver_Assets");
                expect(containerAdds.length).toBe(1);
            }),
            { numRuns: 250 }
        );
    });

    test("a solid-only import leaves nothing loose at the Project-panel root", () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 4 }), (n) => {
                const h = H.buildImportRealm({ copyLayersToComp: realCopyLayersToComp });
                const active = h.model.makeComp("Active Comp");
                h.model.appendLayer(active, "Existing");
                h.model.project.activeItem = active;

                for (let i = 1; i <= n; i++) {
                    const folder = h.model.makeItem("folder", "Solid Folder " + i);
                    const comp = h.model.makeComp("Solid Only " + i, folder);
                    h.model.insertLayer(comp, "solid", 1);
                    const solid = h.model.makeItem("footage", "Red Solid " + i);
                    solid.mainSource = { __kind: "solidSource" };
                    h.ctx.toolkitOrganizeTemplateImport([folder, comp, solid], comp);
                    // The leftover importFile folder is REPARENTED under the
                    // container, never left at the root (2.20).
                    expect(folder.parentFolder).not.toBe(h.model.rootFolder);
                    expect(solid.parentFolder).not.toBe(h.model.rootFolder);
                    expect(folder.__removed).not.toBe(true);
                }
                const roots = h.model.rootFolders().map((f) => f.name);
                expect(roots).toEqual(["_CompSaver_Assets"]);
                expect(h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);
            }),
            { numRuns: 120 }
        );
    });

    test("the INLINE container fallback obeys the same one-container rule", () => {
        // The branch the two baseline suites exercise: csFindOrCreateRootFolder /
        // csFindOrCreateSubFolder are absent, so toolkitOrganizeTemplateImport
        // runs its inlined equivalents.
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 6 }), arbFootageCount, (n, footage) => {
                const scene = makeScene({ containerHelpers: false, footage: footage });
                const rootsBefore = scene.h.model.rootFolders().length;
                for (let i = 0; i < n; i++) {
                    expect(runStandalone(scene, "comp")).toBe("true");
                }
                const roots = scene.h.model.rootFolders().map((f) => f.name);
                expect(roots.length).toBe(rootsBefore + 1);
                expect(roots).toContain("_CompSaver_Assets");
                expect(scene.h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);
            }),
            { numRuns: 150 }
        );
    });
});

// ============================================================
// REPORTED FINDING — standalone `layers.add` failure leaves the container behind
// ------------------------------------------------------------
// `importCompDirect` runs toolkitOrganizeTemplateImport BEFORE
// `activeComp.layers.add(importedComp)`. The organizer creates the reusable
// `_CompSaver_Assets` container (and, when the template carries real assets, its
// `Assets` subfolder). Those two folders are NOT members of `allImportedItems`,
// so the F9a scope-exit `cleanupImportedItems(allImportedItems)` does not remove
// them: a standalone import that fails at "Cannot add comp to timeline." leaves
// the container pair behind, so the project is not byte-identical to its
// pre-import state.
//
// When the template carried no real assets the organizer creates no `Assets`
// subfolder either, so the container is left EMPTY at the Project-panel root —
// which is the situation Req 2.20 forbids for a successful import and which the
// atomicity clause forbids for a failed one.
//
// It is narrow, and the path the panel actually drives is unaffected: inside a
// batch, `csRollbackToSnapshot` removes EVERY item added since the pre-import
// snapshot, container included. "an all-failing batch ... restores the project
// exactly" above covers this failure mode explicitly, and the second test here
// pins that contrast so the batch guarantee cannot silently regress with it.
//
// Reported rather than patched: task 15 changes no production file. The first
// test asserts everything Property 10 requires that DOES hold on this path —
// every item importFile added is gone, no layer reached the user's comp, all
// pre-existing state survives, the envelope balances — and pins the residue to
// CompSaver bookkeeping folders only, so a future fix surfaces here.
// ============================================================
describe("Property 10 — standalone layers.add failure (reported gap)", () => {
    test("the imported items are all removed; only CompSaver container folders remain", () => {
        fc.assert(
            fc.property(fc.boolean(), arbFootageCount, arbNestedFolders, (throws, footage, nested) => {
                const scene = makeScene({ plan: () => "layersAddFails", footage: footage, nested: nested });
                scene.setLayersAddFailure(throws);
                const before = scene.h.model.itemIds();

                const reply = runStandalone(scene, "comp");
                expect(reply).toBe("Cannot add comp to timeline.");

                // Nothing importFile added survives.
                const names = scene.h.model.all.map((i) => i.name);
                expect(names).not.toContain("Template Comp 1");
                expect(names).not.toContain("Imported Folder 1");
                // No layer reached the user's composition.
                expect(scene.active.__layers.length).toBe(2);
                assertPreExistingSurvives(scene);
                expect(scene.h.counters.undoBegin).toBe(scene.h.counters.undoEnd);
                expect(scene.h.counters.suppressBegin).toBe(scene.h.counters.suppressEnd);

                // The residue, pinned: every item that survived and was not there
                // before is a CompSaver bookkeeping FOLDER — never a template's
                // comp, footage or importFile folder.
                const added = scene.h.model.itemIds().filter((id) => before.indexOf(id) === -1);
                expect(added.length).toBeGreaterThan(0); // the reported gap
                added.forEach((id) => {
                    const item = scene.h.model.all.filter((i) => i.id === id)[0];
                    expect(item.__kind).toBe("folder");
                    expect(["_CompSaver_Assets", "Assets"]).toContain(item.name);
                });
            }),
            { numRuns: 200 }
        );
    });

    test("the SAME failure inside a batch restores the project exactly, container included", () => {
        fc.assert(
            fc.property(fc.boolean(), arbFootageCount, arbBatchSize, (throws, footage, n) => {
                const scene = makeScene({ plan: () => "layersAddFails", footage: footage });
                scene.setLayersAddFailure(throws);
                const before = scene.h.model.itemIds();

                const res = scene.h.runBatch(batchPayload(n, "comp"));
                res.perTemplate.forEach((e) => expect(e.status).toBe("failed"));

                expect(scene.h.model.itemIds()).toEqual(before);
                expect(scene.h.model.rootFolders().map((f) => f.name)).toEqual(["User Folder"]);
                expect(scene.h.model.rootFolders().filter((f) => f.numItems === 0)).toEqual([]);
            }),
            { numRuns: 200 }
        );
    });
});
