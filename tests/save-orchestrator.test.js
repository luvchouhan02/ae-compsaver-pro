/**
 * Save Orchestrator — property / ordering tests
 * =============================================
 * Exercises the pure, app-injected `runReduceFirstSave(app, ctx)` sequence from
 * `js/core/saveOrchestrator.js` with a FAKE `app` that records a call log. Each
 * correctness property from the design document is its own fast-check case.
 *
 *   Property 1: Reduce-before-save ordering       (Validates: Requirements 1.1, 1.2, 1.3)
 *   Property 2: assetsList collected after reduce  (Validates: Requirements 8.1)
 *   Property 4: Exactly two full saves             (Validates: Requirements 2.1, 2.2)
 *   Property 5: Reopen exactly once                (Validates: Requirements 4.1, 4.2, 4.4)
 *   Property 6: No frame render in blocking path   (Validates: Requirements 5.1, 5.2)
 *   Property 7: Abort-before-destroy               (Validates: Requirements 3.1, 3.4)
 *   Property 8: Undo/suppress balance              (Validates: Requirements 7.1, 7.2, 7.3)
 */

const fc = require("fast-check");
const {
    runReduceFirstSave,
} = require("../js/core/saveOrchestrator.js");

// ─── Fake `app` + `ctx` harness ──────────────────────────────────────────────
// The fake records every meaningful operation into an ordered `log` and keeps
// per-op `counts`. Failure injection lets each property drive a specific path:
//   throwOnProtectiveSave — protective save #1 throws (abort path)
//   throwOnBuild          — buildTempComp throws (pre-reduce failure)
//   nullTempComp          — buildTempComp returns null (pre-reduce failure)
//   throwOnReduce         — reduceProject throws (destructive-window failure)
//   throwOnTemplateSave   — template save #2 throws (destructive-window failure)
//   throwOnOpen           — reopen throws (restore/reopen failure)
function createHarness(opts) {
    opts = opts || {};

    const log = [];
    const counts = {
        beginUndoGroup: 0,
        endUndoGroup: 0,
        beginSuppressDialogs: 0,
        endSuppressDialogs: 0,
        save: 0,
        reduceProject: 0,
        open: 0,
        saveFrameToPng: 0,
        renderFrameToPng: 0,
    };

    const folderPath = opts.folderPath || "root/section/cat/id";
    const originalFile = { role: "original", path: "/user/live.aep" };
    const targetFile = { role: "target", path: folderPath + "/project.aep" };

    const tempComp = {
        name: "temp",
        remove() {
            log.push({ op: "tempComp.remove" });
        },
    };

    const app = {
        beginUndoGroup(label) {
            counts.beginUndoGroup++;
            log.push({ op: "beginUndoGroup", label: label });
        },
        endUndoGroup() {
            counts.endUndoGroup++;
            log.push({ op: "endUndoGroup" });
        },
        beginSuppressDialogs() {
            counts.beginSuppressDialogs++;
            log.push({ op: "beginSuppressDialogs" });
        },
        endSuppressDialogs(showAlerts) {
            counts.endSuppressDialogs++;
            log.push({ op: "endSuppressDialogs", showAlerts: showAlerts });
        },
        open(file) {
            counts.open++;
            log.push({ op: "open", file: file });
            if (opts.throwOnOpen) throw new Error("open failed");
        },
        // If the orchestrator ever reached for a frame render, it would show up
        // in the log — Property 6 asserts it never does.
        saveFrameToPng() {
            counts.saveFrameToPng++;
            log.push({ op: "saveFrameToPng" });
        },
        renderFrameToPng() {
            counts.renderFrameToPng++;
            log.push({ op: "renderFrameToPng" });
        },
        project: {
            save(file) {
                counts.save++;
                let which = "unknown";
                if (file === originalFile) which = "protective";
                else if (file === targetFile) which = "template";
                log.push({ op: "save", which: which, file: file });
                if (which === "protective" && opts.throwOnProtectiveSave) {
                    throw new Error("protective save failed");
                }
                if (which === "template" && opts.throwOnTemplateSave) {
                    throw new Error("template save failed");
                }
            },
            reduceProject(comps) {
                counts.reduceProject++;
                log.push({ op: "reduceProject", comps: comps });
                if (opts.throwOnReduce) throw new Error("reduce failed");
            },
        },
    };

    const ctx = {
        undoLabel: opts.undoLabel || "Save Template",
        originalFile: originalFile,
        targetFile: targetFile,
        folderPath: folderPath,
        buildTempComp(a) {
            if (opts.throwOnBuild) throw new Error("build failed");
            log.push({ op: "buildTempComp" });
            return opts.nullTempComp ? null : tempComp;
        },
        collectFootageAssets(project) {
            log.push({ op: "collectFootageAssets" });
            return opts.assets || [];
        },
    };

    return {
        app: app,
        ctx: ctx,
        log: log,
        counts: counts,
        originalFile: originalFile,
        targetFile: targetFile,
    };
}

// Ordered list of op names, for index-based ordering assertions.
function ops(log) {
    return log.map((e) => e.op);
}
function idx(log, op) {
    return ops(log).indexOf(op);
}

// Arbitraries that vary the input space without changing the success path.
const arbLabel = fc.string({ minLength: 0, maxLength: 40 });
const arbFolder = fc
    .array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join("/"));
const arbAssets = fc.array(
    fc.record({ fsPath: fc.string(), name: fc.string() }),
    { minLength: 0, maxLength: 6 }
);

// ─── Property 1: Reduce-before-save ordering ─────────────────────────────────
// Validates: Requirements 1.1, 1.2, 1.3
describe("Property 1: reduce-before-save ordering", () => {
    it("records reduceProject before the single template save, once each, in the design order", () => {
        fc.assert(
            fc.property(arbLabel, arbFolder, arbAssets, (label, folderPath, assets) => {
                const h = createHarness({ undoLabel: label, folderPath, assets });
                const res = runReduceFirstSave(h.app, h.ctx);

                expect(res.ok).toBe(true);

                // reduce happens, and strictly before the template save (Req 1.2)
                const iReduce = idx(h.log, "reduceProject");
                const iBegin = idx(h.log, "beginUndoGroup");
                expect(iReduce).toBeGreaterThan(-1);

                // template save is the save whose target is the template file
                const iTemplateSave = h.log.findIndex(
                    (e) => e.op === "save" && e.which === "template"
                );
                const iProtectiveSave = h.log.findIndex(
                    (e) => e.op === "save" && e.which === "protective"
                );
                expect(iTemplateSave).toBeGreaterThan(-1);

                // Req 1.1 relative order: begin → protective save → reduce → template save
                expect(iBegin).toBeLessThan(iProtectiveSave);
                expect(iProtectiveSave).toBeLessThan(iReduce);
                expect(iReduce).toBeLessThan(iTemplateSave);

                // Req 1.3: reduce invoked exactly once regardless of inputs
                expect(h.counts.reduceProject).toBe(1);
            })
        );
    });
});

// ─── Property 2: assetsList collected after reduce ───────────────────────────
// Validates: Requirements 8.1
describe("Property 2: assetsList collected after reduce and before reopen", () => {
    it("records collectFootageAssets after reduceProject and before open", () => {
        fc.assert(
            fc.property(arbLabel, arbFolder, arbAssets, (label, folderPath, assets) => {
                const h = createHarness({ undoLabel: label, folderPath, assets });
                const res = runReduceFirstSave(h.app, h.ctx);

                expect(res.ok).toBe(true);

                const iReduce = idx(h.log, "reduceProject");
                const iAssets = idx(h.log, "collectFootageAssets");
                const iOpen = idx(h.log, "open");

                expect(iReduce).toBeGreaterThan(-1);
                expect(iAssets).toBeGreaterThan(iReduce);
                expect(iOpen).toBeGreaterThan(iAssets);

                // the collected list is returned untouched
                expect(res.assetsList).toEqual(assets);
            })
        );
    });
});

// ─── Property 4: Exactly two full saves ──────────────────────────────────────
// Validates: Requirements 2.1, 2.2
describe("Property 4: exactly two full project saves on success", () => {
    it("app.project.save is called exactly twice (one protective, one template)", () => {
        fc.assert(
            fc.property(arbLabel, arbFolder, arbAssets, (label, folderPath, assets) => {
                const h = createHarness({ undoLabel: label, folderPath, assets });
                const res = runReduceFirstSave(h.app, h.ctx);

                expect(res.ok).toBe(true);
                expect(h.counts.save).toBe(2);

                const saves = h.log.filter((e) => e.op === "save");
                const protective = saves.filter((e) => e.which === "protective");
                const template = saves.filter((e) => e.which === "template");
                expect(protective.length).toBe(1);
                expect(template.length).toBe(1);

                // Req 2.2: reopen is not counted as a full save
                expect(saves.some((e) => e.file === h.originalFile && e.which === "template")).toBe(
                    false
                );
            })
        );
    });
});

// ─── Property 5: Reopen exactly once ─────────────────────────────────────────
// Validates: Requirements 4.1, 4.2, 4.4
describe("Property 5: reopen originalFile exactly once", () => {
    it("success path opens originalFile exactly once", () => {
        fc.assert(
            fc.property(arbLabel, arbFolder, (label, folderPath) => {
                const h = createHarness({ undoLabel: label, folderPath });
                const res = runReduceFirstSave(h.app, h.ctx);

                expect(res.ok).toBe(true);
                expect(h.counts.open).toBe(1);
                const opens = h.log.filter((e) => e.op === "open");
                expect(opens[0].file).toBe(h.originalFile);
            })
        );
    });

    it("destructive-window failure (reduce throws) reopens exactly once, never zero after reduce", () => {
        fc.assert(
            fc.property(arbLabel, arbFolder, (label, folderPath) => {
                const h = createHarness({ undoLabel: label, folderPath, throwOnReduce: true });
                const res = runReduceFirstSave(h.app, h.ctx);

                expect(res.ok).toBe(false);
                expect(h.counts.reduceProject).toBe(1);
                expect(h.counts.open).toBe(1);
                expect(h.log.filter((e) => e.op === "open")[0].file).toBe(h.originalFile);
            })
        );
    });

    it("destructive-window failure (template save throws) reopens exactly once", () => {
        fc.assert(
            fc.property(arbLabel, arbFolder, (label, folderPath) => {
                const h = createHarness({ undoLabel: label, folderPath, throwOnTemplateSave: true });
                const res = runReduceFirstSave(h.app, h.ctx);

                expect(res.ok).toBe(false);
                expect(h.counts.reduceProject).toBe(1);
                expect(h.counts.open).toBe(1);
            })
        );
    });
});

// ─── Property 6: No frame render in the blocking path ────────────────────────
// Validates: Requirements 5.1, 5.2
describe("Property 6: no frame render in the blocking path", () => {
    it("never records saveFrameToPng / renderFrameToPng on any path", () => {
        const scenarios = [
            {},
            { throwOnProtectiveSave: true },
            { throwOnBuild: true },
            { nullTempComp: true },
            { throwOnReduce: true },
            { throwOnTemplateSave: true },
            { throwOnOpen: true },
        ];
        fc.assert(
            fc.property(
                arbLabel,
                arbFolder,
                fc.integer({ min: 0, max: scenarios.length - 1 }),
                (label, folderPath, sIdx) => {
                    const opts = Object.assign({ undoLabel: label, folderPath }, scenarios[sIdx]);
                    const h = createHarness(opts);
                    runReduceFirstSave(h.app, h.ctx);

                    expect(h.counts.saveFrameToPng).toBe(0);
                    expect(h.counts.renderFrameToPng).toBe(0);
                    expect(ops(h.log)).not.toContain("saveFrameToPng");
                    expect(ops(h.log)).not.toContain("renderFrameToPng");
                }
            )
        );
    });
});

// ─── Property 7: Abort-before-destroy ────────────────────────────────────────
// Validates: Requirements 3.1, 3.4
describe("Property 7: abort before destroy when protective save fails", () => {
    it("reduceProject and open are never called, result is aborted, endUndoGroup called once", () => {
        fc.assert(
            fc.property(arbLabel, arbFolder, (label, folderPath) => {
                const h = createHarness({
                    undoLabel: label,
                    folderPath,
                    throwOnProtectiveSave: true,
                });
                const res = runReduceFirstSave(h.app, h.ctx);

                expect(res.aborted).toBe(true);
                expect(res.ok).toBe(false);
                expect(res.reason).toBe("protective-save-failed");

                expect(h.counts.reduceProject).toBe(0);
                expect(h.counts.open).toBe(0);
                expect(h.counts.endUndoGroup).toBe(1);

                // no destructive ops recorded at all
                expect(ops(h.log)).not.toContain("reduceProject");
                expect(ops(h.log)).not.toContain("open");
            })
        );
    });
});

// ─── Property 8: Undo/suppress balance ───────────────────────────────────────
// Validates: Requirements 7.1, 7.2, 7.3
describe("Property 8: undo-group and suppress-dialogs balance on every path", () => {
    it("begin/end undo-group counts match and begin/end suppress-dialogs counts match", () => {
        const scenarios = [
            {}, // success
            { throwOnProtectiveSave: true }, // abort
            { throwOnBuild: true }, // pre-reduce failure
            { nullTempComp: true }, // pre-reduce failure
            { throwOnReduce: true }, // restore path
            { throwOnTemplateSave: true }, // restore path
            { throwOnOpen: true }, // restore path with failing reopen
        ];
        fc.assert(
            fc.property(
                arbLabel,
                arbFolder,
                fc.integer({ min: 0, max: scenarios.length - 1 }),
                (label, folderPath, sIdx) => {
                    const opts = Object.assign({ undoLabel: label, folderPath }, scenarios[sIdx]);
                    const h = createHarness(opts);
                    runReduceFirstSave(h.app, h.ctx);

                    // Req 7.1 + 7.3: opened undo groups == ended undo groups
                    expect(h.counts.beginUndoGroup).toBe(h.counts.endUndoGroup);
                    // Req 7.2 + 7.3: enabled suppress-dialogs == disabled suppress-dialogs
                    expect(h.counts.beginSuppressDialogs).toBe(h.counts.endSuppressDialogs);
                }
            )
        );
    });
});
