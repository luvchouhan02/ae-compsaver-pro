// ============================================================
// tests/host-balance-invariants.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.10)
//
// Property 12 — Balance On Every Path.
//
//   For ANY save or import path, including every early return and every thrown
//   error, the number of beginSuppressDialogs calls SHALL equal the number of
//   endSuppressDialogs calls and the number of beginUndoGroup calls SHALL equal
//   the number of endUndoGroup calls; and whenever the batch guard is active, the
//   batch SHALL own exactly one open undo group.
//
// One deviation from the design's literal wording, forced by the fix itself:
// Property 12's last clause is stated as `__CS_IMPORT_BATCH_ACTIVE => undoOpened`.
// After F11a the guard is ASSIGNED from undoOpened
// (`__CS_IMPORT_BATCH_ACTIVE = undoOpened;` in jsx/import.jsx importBatch), so
// that implication is true BY CONSTRUCTION and asserting it tests nothing. This
// suite asserts the OBSERVABLE CONSEQUENCE instead: when the batch's
// beginUndoGroup throws, the guard is FALSE for every template AND at least one
// real per-section undo group opens, so the DOM mutations always sit inside a
// working undo. That is the behavior 2.24 requires and the behavior the pre-fix
// code got backwards (guard set BEFORE the attempt => zero undo groups for the
// whole batch).
//
// The `undoBeginThrows` fake is scoped to the BATCH group name "CompSaver Import",
// exactly as the exploration suite's harness scopes it. A blanket throw would make
// the per-section undoBegin count structurally zero, so "at least one real group
// opened" would be unsatisfiable rather than false.
//
// Counter semantics (tests/helpers/compPipelineHarness.js newCounters):
//   suppressBegin  suppressions that actually took EFFECT
//   suppressEnd    releases that actually CLEARED one
//   suppressDepth  suppressions still on at the end — must be 0
//   undoBegin      groups that actually OPENED
//   undoEnd        end calls that actually CLOSED an open group
//   undoDepth      groups still open at the end — must be 0
//   *SuperfluousEnd  end calls made with nothing open. AE throws on these and the
//                    engines swallow it; they are reported, never asserted away.
//
// typeof-guard branches exercised
// ------------------------------
//   validateLibraryRoot — asserted on BOTH branches (sliced in, and the engines'
//                         inline absolute-path fallback).
//   csFindOrCreate* / csBatchAnchor* / csResolveImportAnchor / cleanupImportedItems
//                       — sliced in, so the import routines take their PRIMARY
//                         branches.
//   jsonParse / decodeBridgeStrict — absent from the slice, so importBatch decodes
//                         through the documented inline fallbacks.
//
// **Validates: Requirements 2.23, 2.24, 3.8, 3.9**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

// ─────────────────────────────────────────────────────────────
// Injection points — every instrumented `app` method, plus the non-`app` throws
// that sit BETWEEN a begin/end pair and are what 1.23 was actually about.
// ─────────────────────────────────────────────────────────────
const SAVE_INJECTIONS = [
    "none",
    "protectiveSaveThrows", "reduceThrows", "targetSaveThrows", "openThrows",
    "addCompThrows", "addCompReturnsNull", "copyThrows", "copyReturnsZero",
    "undoBeginThrows", "undoEndThrows", "suppressBeginThrows", "suppressEndThrows",
    "createFails", "noProjectFile", "resolveFails",
];
const arbSaveInjection = fc.constantFrom.apply(null, SAVE_INJECTIONS);

const IMPORT_INJECTIONS = [
    "none", "suppressBeginThrows", "suppressEndThrows",
    "undoBeginThrows", "undoEndThrows",
];
const arbImportInjection = fc.constantFrom.apply(null, IMPORT_INJECTIONS);

const IMPORT_FAILURES = ["none", "importFileThrows", "zeroItems", "noComp", "profileLogThrows"];
const arbImportFailure = fc.constantFrom.apply(null, IMPORT_FAILURES);

const arbLayerSection = fc.constantFrom("layer", "text", "footage");
const arbImportSection = fc.constantFrom("comp", "layer");
const arbRoot = fc.constantFrom("C:/lib", "C:/Users/x/My Library", "", "MyLib", "./rel");
const arbBatchSize = fc.integer({ min: 1, max: 5 });
const arbPrimaryGuard = fc.boolean();

function saveOpts(injection, root, primary) {
    const o = {
        invalidateOnOpen: true,
        rootPath: root || "C:/lib",
        fsSet: { "C:/lib": true, "C:/Users/x/My Library": true },
        injectValidateLibraryRoot: primary,
    };
    if (injection !== "none") o[injection] = true;
    return o;
}

/** Property 12's two clauses, plus "nothing is left open". */
function assertBalanced(counters, label) {
    expect(counters.suppressBegin).toBe(counters.suppressEnd);
    expect(counters.undoBegin).toBe(counters.undoEnd);
    // The stronger statement the clauses exist to guarantee: after the call
    // returns, After Effects has no suppression on and no undo group open.
    expect(counters.suppressDepth).toBe(0);
    expect(counters.undoDepth).toBe(0);
    if (label) expect(typeof label).toBe("string");
}

function realCopyLayersToComp(layers, target) {
    for (let i = 0; i < layers.length; i++) target.layers.add({ name: layers[i].name });
}

function makeImportScene(cfg, failure) {
    const h = H.buildImportRealm(Object.assign({ copyLayersToComp: realCopyLayersToComp }, cfg));
    const active = h.model.makeComp("Active Comp");
    h.model.appendLayer(active, "Existing").selected = true;
    h.model.project.activeItem = active;

    let seq = 0;
    h.model.project.__importer = function () {
        if (failure === "importFileThrows") throw new Error("importFile exploded");
        if (failure === "zeroItems") return null;
        seq++;
        const folder = h.model.makeItem("folder", "Imported " + seq);
        if (failure === "noComp") {
            h.model.makeItem("footage", "clip.mp4", folder);
            return folder;
        }
        const comp = h.model.makeComp("Template " + seq, folder);
        h.model.insertLayer(comp, "inner " + seq, 1);
        return folder;
    };
    if (failure === "profileLogThrows") {
        // 1.23's real shape: _csProfilePoint used to sit OUTSIDE the inner try,
        // BETWEEN beginSuppressDialogs and endSuppressDialogs, so a failed
        // profile-log write left suppression on for the whole session.
        h.ctx._csProfileLog = {
            writeln: function () { throw new Error("profile log write failed"); },
            close: function () { },
        };
    }
    return { h: h, active: active };
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
// The save engines
// ============================================================
describe("Property 12 — the save engines balance on every path", () => {
    test("saveActiveComp: suppression and undo balance for every injection point and every root", () => {
        fc.assert(
            fc.property(arbSaveInjection, arbRoot, arbPrimaryGuard, (injection, root, primary) => {
                const h = H.buildCompSaveRealm(saveOpts(injection, root, primary));
                let threw = null;
                try { h.run("My Title", "Titles", root); } catch (e) { threw = e; }
                // No injection point may propagate an exception to the Bridge.
                expect(threw).toBe(null);
                assertBalanced(h.counters, injection);
            }),
            { numRuns: 600 }
        );
    });

    test("coreSaveLayerType: suppression and undo balance for every injection point and every section", () => {
        fc.assert(
            fc.property(arbSaveInjection, arbLayerSection, arbRoot, arbPrimaryGuard,
                (injection, section, root, primary) => {
                    const h = H.buildLayerSaveRealm(saveOpts(injection, root, primary));
                    let threw = null;
                    try { h.run(section); } catch (e) { threw = e; }
                    expect(threw).toBe(null);
                    assertBalanced(h.counters, injection);
                }),
            { numRuns: 600 }
        );
    });

    test("a throw between beginSuppressDialogs and endSuppressDialogs never leaves suppression on", () => {
        // 1.23, the saveActiveComp half: the restore handler's
        // `log(... + e.toString())` was itself a throw between the two calls. An
        // error object whose toString() throws reproduces that exactly.
        fc.assert(
            fc.property(arbRoot, arbPrimaryGuard, (root, primary) => {
                const hostile = { toString: function () { throw new Error("unstringifiable host error"); } };
                const opts = saveOpts("none", root, primary);
                opts.openThrows = hostile;
                const h = H.buildCompSaveRealm(opts);
                try { h.run("My Title", "Titles", root); } catch (e) { /* the throw escapes; the counters must not */ }
                expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                expect(h.counters.suppressDepth).toBe(0);
            }),
            { numRuns: 150 }
        );
    });

    test("a pre-window rejection opens nothing at all", () => {
        fc.assert(
            fc.property(fc.constantFrom("noProjectFile", "resolveFails", "createFails"),
                fc.constantFrom("", "MyLib", "./rel"), arbPrimaryGuard,
                (injection, badRoot, primary) => {
                    const h = H.buildCompSaveRealm(saveOpts(injection, badRoot, primary));
                    h.run("My Title", "Titles", badRoot);
                    expect(h.counters.undoAttempts).toBe(0);
                    expect(h.counters.suppressBeginAttempts).toBe(0);
                    assertBalanced(h.counters);
                }),
            { numRuns: 200 }
        );
    });

    test("at most ONE undo group is ever open at a time in either engine", () => {
        fc.assert(
            fc.property(arbSaveInjection, arbLayerSection, arbRoot, (injection, section, root) => {
                const c = H.buildCompSaveRealm(saveOpts(injection, root, true));
                c.run("My Title", "Titles", root);
                expect(c.counters.undoMaxDepth).toBeLessThanOrEqual(1);

                const l = H.buildLayerSaveRealm(saveOpts(injection, root, true));
                l.run(section);
                expect(l.counters.undoMaxDepth).toBeLessThanOrEqual(1);
            }),
            { numRuns: 400 }
        );
    });
});

// ============================================================
// The import routines
// ============================================================
describe("Property 12 — the import routines balance on every path", () => {
    test("a standalone import balances for every injection point x every failure point", () => {
        fc.assert(
            fc.property(arbImportInjection, arbImportFailure, arbImportSection,
                (injection, failure, section) => {
                    const cfg = {};
                    if (injection !== "none") cfg[injection] = true;
                    const scene = makeImportScene(cfg, failure);
                    const e = scene.h.ctx.encodeBridge;
                    const fn = section === "comp" ? "importCompDirect" : "importLayerTypeAep";

                    let threw = null;
                    try { scene.h.ctx[fn](e("T"), e("Cat"), e("C:/lib"), section); } catch (err) { threw = err; }
                    expect(threw).toBe(null);
                    assertBalanced(scene.h.counters, injection + "/" + failure);
                }),
            { numRuns: 600 }
        );
    });

    test("a batch balances for every injection point x every failure point x N = 1..5", () => {
        fc.assert(
            fc.property(arbImportInjection, arbImportFailure, arbImportSection, arbBatchSize,
                (injection, failure, section, n) => {
                    const cfg = {};
                    if (injection !== "none") cfg[injection] = true;
                    const scene = makeImportScene(cfg, failure);

                    let res = null;
                    let threw = null;
                    try { res = scene.h.runBatch(batchPayload(n, section)); } catch (err) { threw = err; }
                    expect(threw).toBe(null);
                    // Result totality survives every injection (3.11).
                    expect(res.perTemplate.length).toBe(n);
                    assertBalanced(scene.h.counters, injection + "/" + failure);
                }),
            { numRuns: 600 }
        );
    });

    test("a throw between beginSuppressDialogs and endSuppressDialogs inside importCompDirect never leaves suppression on", () => {
        // 1.23's other site: jsx/import.jsx's _csProfilePoint("  Native importFile")
        // used to sit outside the inner try.
        fc.assert(
            fc.property(arbImportSection, (section) => {
                const scene = makeImportScene({}, "profileLogThrows");
                const e = scene.h.ctx.encodeBridge;
                const fn = section === "comp" ? "importCompDirect" : "importLayerTypeAep";
                scene.h.ctx[fn](e("T"), e("Cat"), e("C:/lib"), section);
                expect(scene.h.counters.suppressBegin).toBe(scene.h.counters.suppressEnd);
                expect(scene.h.counters.suppressDepth).toBe(0);
                expect(scene.h.counters.undoDepth).toBe(0);
            }),
            { numRuns: 120 }
        );
    });

    test("a successful batch owns exactly ONE undo group and suppresses the per-section routines' own", () => {
        fc.assert(
            fc.property(arbBatchSize, arbImportSection, (n, section) => {
                const scene = makeImportScene({}, "none");
                const res = scene.h.runBatch(batchPayload(n, section));
                res.perTemplate.forEach((entry) => expect(entry.status).toBe("imported"));

                expect(scene.h.counters.undoBegin).toBe(1);
                expect(scene.h.counters.undoEnd).toBe(1);
                expect(scene.h.counters.undoMaxDepth).toBe(1);
                // The guard was ON for every template, so csBeginUndoGroup /
                // csEndUndoGroup were no-ops: no per-section group was opened.
                expect(scene.h.guardDuringImport.length).toBe(n);
                scene.h.guardDuringImport.forEach((g) => expect(g).toBe(true));
                // ...and the guard is cleared afterwards.
                expect(scene.h.ctx.__CS_IMPORT_BATCH_ACTIVE).toBe(false);
            }),
            { numRuns: 250 }
        );
    });

    test("a standalone import opens and closes exactly one group of its own", () => {
        fc.assert(
            fc.property(arbImportSection, arbImportFailure, (section, failure) => {
                const scene = makeImportScene({}, failure);
                const e = scene.h.ctx.encodeBridge;
                const fn = section === "comp" ? "importCompDirect" : "importLayerTypeAep";
                scene.h.ctx[fn](e("T"), e("Cat"), e("C:/lib"), section);
                expect(scene.h.counters.undoBegin).toBe(1);
                expect(scene.h.counters.undoEnd).toBe(1);
                expect(scene.h.counters.undoMaxDepth).toBe(1);
                // No batch is active, so the guard was false throughout.
                scene.h.guardDuringImport.forEach((g) => expect(g).toBe(false));
                expect(scene.h.ctx.__CS_IMPORT_BATCH_ACTIVE).toBe(false);
            }),
            { numRuns: 250 }
        );
    });
});

// ============================================================
// The batch guard — F11a's observable consequence (2.24)
// ============================================================
describe("Property 12 — a failed batch beginUndoGroup leaves the guard false", () => {
    test("the guard is FALSE for every template and at least one real per-section group opens", () => {
        fc.assert(
            fc.property(arbBatchSize, arbImportSection, (n, section) => {
                const scene = makeImportScene({ undoBeginThrows: true }, "none");
                const res = scene.h.runBatch(batchPayload(n, section));

                // The batch's own group really did fail to open.
                expect(scene.h.counters.undoBeginFailed).toBe(1);

                // 2.24: with no batch group to own, the per-section routines must
                // NOT be suppressed.
                expect(scene.h.guardDuringImport.length).toBe(n);
                expect(scene.h.guardDuringImport.every(function (g) { return g === false; })).toBe(true);

                // ...so at least one REAL undo group covers the DOM mutations.
                // Pre-fix this was zero: the whole batch ran unundoable.
                expect(scene.h.counters.undoBegin).toBeGreaterThanOrEqual(1);
                expect(scene.h.counters.undoBegin).toBe(n);
                // Still balanced, still nothing left open, still never nested.
                assertBalanced(scene.h.counters);
                expect(scene.h.counters.undoMaxDepth).toBe(1);
                // The work still happened.
                expect(res.perTemplate.length).toBe(n);
                res.perTemplate.forEach((entry) => expect(entry.status).toBe("imported"));
            }),
            { numRuns: 250 }
        );
    });

    test("the guard is cleared on every exit, including a mid-batch throw", () => {
        fc.assert(
            fc.property(arbImportInjection, arbImportFailure, arbBatchSize,
                (injection, failure, n) => {
                    const cfg = {};
                    if (injection !== "none") cfg[injection] = true;
                    const scene = makeImportScene(cfg, failure);
                    scene.h.runBatch(batchPayload(n, "comp"));
                    expect(scene.h.ctx.__CS_IMPORT_BATCH_ACTIVE).toBe(false);
                    expect(scene.h.ctx.__CS_IMPORT_BATCH_ANCHOR).toBe(null);
                }),
            { numRuns: 400 }
        );
    });

    test("when the batch group DOES open, the guard is true for every template (3.8, 3.9 preserved)", () => {
        fc.assert(
            fc.property(arbImportFailure, arbBatchSize, arbImportSection, (failure, n, section) => {
                const scene = makeImportScene({}, failure);
                scene.h.runBatch(batchPayload(n, section));
                expect(scene.h.counters.undoBeginFailed).toBe(0);
                if (scene.h.guardDuringImport.length > 0) {
                    scene.h.guardDuringImport.forEach((g) => expect(g).toBe(true));
                }
                expect(scene.h.counters.undoBegin).toBe(1);
                expect(scene.h.counters.undoEnd).toBe(1);
            }),
            { numRuns: 300 }
        );
    });
});
