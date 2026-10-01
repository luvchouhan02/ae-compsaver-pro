// Feature: save-import-performance-redesign, Property 2: At most two full-project writes per save
//
// Property test for the redesigned essential Save_Engine sequence
// (`runReduceFirstSave` in js/core/saveOrchestrator.js, Task 3.1 / 3.3).
//
// Design Property 2 (Validates: Requirements 2.5):
//   For any save context, across the success path and ALL failure branches, the
//   number of full-project write (`project.save`) calls performed by the
//   essential save sequence is AT MOST 2 — at most one protective write of the
//   live project and at most one write of the template — and the reopen is
//   performed AT MOST once.
//
// The harness injects a pure `app` spy that counts every `project.save`
// invocation (bucketed by whether its target is the protective/original file or
// the template/target file) and every `open` (reopen) invocation, then drives
// the sequence through every reachable path via failure injection.

const fc = require("fast-check");
const { runReduceFirstSave } = require("../js/core/saveOrchestrator.js");

// All failure-injection points, plus the clean success path ("none"). Together
// these cover every branch the sequence can take.
const ALL_SCENARIOS = [
    "none", // success path
    "throwOnProtectiveSave", // protective write #1 throws (abort before window)
    "throwOnBuild", // buildTempComp throws (pre-reduce failure)
    "nullTempComp", // buildTempComp returns null (pre-reduce failure)
    "throwOnReduce", // reduceProject throws (destructive-window failure)
    "throwOnTemplateSave", // template write #2 throws (destructive-window failure)
    "throwOnOpen", // reopen throws (restore/reopen failure)
];

/**
 * Build a pure `app` + `ctx` harness that counts full-project writes and
 * reopens. `save` is bucketed into `protective` (target === originalFile) and
 * `template` (target === targetFile) so we can assert the ≤1-each sub-bounds.
 */
function createHarness(scenario, opts) {
    opts = opts || {};
    const folderPath = opts.folderPath || "root/section/cat/id";
    const originalFile = { role: "original", path: "/user/live.aep" };
    const targetFile = { role: "target", path: folderPath + "/project.aep" };

    const counts = { save: 0, protectiveSaves: 0, templateSaves: 0, otherSaves: 0, open: 0 };

    const tempComp = {
        name: "temp",
        remove() { },
    };

    const app = {
        beginUndoGroup() { },
        endUndoGroup() { },
        beginSuppressDialogs() { },
        endSuppressDialogs() { },
        open() {
            counts.open++;
            if (scenario === "throwOnOpen") throw new Error("open failed");
        },
        project: {
            save(file) {
                // Count the write BEFORE any injected throw: the point of the
                // property is that the sequence never *attempts* a third write,
                // and the guard would surface as an extra counted call here.
                counts.save++;
                if (file === originalFile) {
                    counts.protectiveSaves++;
                    if (scenario === "throwOnProtectiveSave") throw new Error("protective failed");
                } else if (file === targetFile) {
                    counts.templateSaves++;
                    if (scenario === "throwOnTemplateSave") throw new Error("template failed");
                } else {
                    counts.otherSaves++;
                }
            },
            reduceProject() {
                if (scenario === "throwOnReduce") throw new Error("reduce failed");
            },
        },
    };

    const ctx = {
        undoLabel: opts.undoLabel || "Save Template",
        originalFile,
        targetFile,
        folderPath,
        buildTempComp() {
            if (scenario === "throwOnBuild") throw new Error("build failed");
            return scenario === "nullTempComp" ? null : tempComp;
        },
        collectFootageAssets() {
            return opts.assets || [];
        },
        needsThumbnail: opts.needsThumbnail,
        needsPreview: opts.needsPreview,
        // Inert queue so success paths exercise the real enqueue branch.
        enqueueBackgroundJob() { },
    };

    return { app, ctx, counts };
}

// Arbitraries vary the input space without changing which scenario runs.
const arbLabel = fc.string({ minLength: 0, maxLength: 40 });
const arbFolder = fc
    .array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join("/"));
const arbAssets = fc.array(fc.record({ fsPath: fc.string(), name: fc.string() }), {
    minLength: 0,
    maxLength: 6,
});
const arbScenario = fc.constantFrom(...ALL_SCENARIOS);
// Vary the render-job flags too, so enqueue-side branches never affect writes.
const arbNeedsThumbnail = fc.option(fc.boolean(), { nil: undefined });
const arbNeedsPreview = fc.option(fc.boolean(), { nil: undefined });

describe("Property 2: At most two full-project writes per save", () => {
    it("performs at most 2 project.save calls (≤1 protective, ≤1 template) and at most 1 reopen across every save path", () => {
        fc.assert(
            fc.property(
                arbScenario,
                arbLabel,
                arbFolder,
                arbAssets,
                arbNeedsThumbnail,
                arbNeedsPreview,
                (scenario, undoLabel, folderPath, assets, needsThumbnail, needsPreview) => {
                    const h = createHarness(scenario, {
                        undoLabel,
                        folderPath,
                        assets,
                        needsThumbnail,
                        needsPreview,
                    });
                    const res = runReduceFirstSave(h.app, h.ctx);

                    // (A) Core bound: at most two full-project writes, ever.
                    expect(h.counts.save).toBeLessThanOrEqual(2);

                    // (B) Sub-bounds: at most one protective write, at most one
                    // template write, and never a write to any other target.
                    expect(h.counts.protectiveSaves).toBeLessThanOrEqual(1);
                    expect(h.counts.templateSaves).toBeLessThanOrEqual(1);
                    expect(h.counts.otherSaves).toBe(0);

                    // (C) Reopen is performed at most once on every path.
                    expect(h.counts.open).toBeLessThanOrEqual(1);

                    // (D) The result's reported write/reopen tallies agree with
                    // the spy's observed counts (no hidden writes/reopens).
                    expect(res.writes).toBe(h.counts.save);
                    expect(res.reopened).toBe(h.counts.open);
                    expect(res.reopened).toBeLessThanOrEqual(1);
                }
            ),
            { numRuns: 200 }
        );
    });
});
