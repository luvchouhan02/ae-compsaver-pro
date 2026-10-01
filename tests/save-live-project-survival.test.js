// Feature: save-import-performance-redesign, Property 1: Live project survives every save path
//
// Property test for the redesigned essential Save_Engine sequence
// (`runReduceFirstSave` in js/core/saveOrchestrator.js, Task 3.1).
//
// Design Property 1 (Validates: Requirements 5.5, 5.6):
//   For any save context and any injected failure point in the save sequence,
//   after the sequence returns the user's live project ON DISK equals its
//   pre-save state — either untouched (failure BEFORE the destructive window)
//   or restored from the protective-save snapshot via a SINGLE reopen (failure
//   INSIDE or AFTER the destructive window) — with the reopen invoked EXACTLY
//   when the destructive window was entered.
//
// Rather than only counting operations, this harness models the actual project
// bytes on disk and in AE's memory so we can assert the *content* guarantee:
// the file the user re-opens is byte-identical to what it was before the save.

const fc = require("fast-check");
const { runReduceFirstSave } = require("../js/core/saveOrchestrator.js");

// A distinguished token representing the user's live project content before the
// save was triggered. The whole property is "the user still has THIS afterward".
const PRE_SAVE = "PRE_SAVE_LIVE_PROJECT";
// What reduceProject collapses the in-memory project down to (destructive).
const REDUCED = "REDUCED_TEMPLATE_PROJECT";

// The failure-injection points, grouped by where they fall relative to the
// destructive window (which is ENTERED at reduceProject).
const BEFORE_WINDOW = ["throwOnProtectiveSave", "throwOnBuild", "nullTempComp"];
const IN_OR_AFTER_WINDOW = ["throwOnReduce", "throwOnTemplateSave", "throwOnOpen", "none"];
const ALL_SCENARIOS = BEFORE_WINDOW.concat(IN_OR_AFTER_WINDOW);

/**
 * Build a modeled `app` + `ctx` where `disk` and `memory` hold project content.
 *
 * Disk model:
 *   - The original file already exists on disk holding PRE_SAVE (the project the
 *     user has right now).
 *   - `project.save(file)` writes the CURRENT in-memory content to that file's
 *     path on disk (this is how the protective snapshot is taken).
 *   - `open(file)` loads the on-disk content at that path back into memory.
 *   - `reduceProject(...)` destroys the in-memory project (memory -> REDUCED).
 */
function createModel(scenario, opts) {
    opts = opts || {};
    const folderPath = opts.folderPath || "root/section/cat/id";
    const originalPath = "/user/live.aep";
    const originalFile = { role: "original", path: originalPath };
    const targetFile = { role: "target", path: folderPath + "/project.aep" };

    // Disk starts with the user's real project already saved as PRE_SAVE.
    const disk = { [originalPath]: PRE_SAVE };
    // Memory starts as the loaded live project (== the on-disk pre-save state).
    const memory = { content: PRE_SAVE };

    const counts = { save: 0, reduceProject: 0, open: 0, endUndoGroup: 0 };

    const tempComp = {
        name: "temp",
        remove() { },
    };

    const app = {
        beginUndoGroup() { },
        endUndoGroup() {
            counts.endUndoGroup++;
        },
        beginSuppressDialogs() { },
        endSuppressDialogs() { },
        open(file) {
            counts.open++;
            if (scenario === "throwOnOpen") {
                // Reopen fails: memory is left destroyed, but disk is untouched
                // and still holds the protective snapshot (recoverable).
                throw new Error("open failed");
            }
            memory.content = disk[file.path];
        },
        project: {
            save(file) {
                // Protective save is the write whose target is the original file.
                const isProtective = file === originalFile;
                if (isProtective && scenario === "throwOnProtectiveSave") {
                    // Throw BEFORE mutating disk: the on-disk original is untouched.
                    throw new Error("protective save failed");
                }
                if (!isProtective && scenario === "throwOnTemplateSave") {
                    // Template write throws; the original snapshot already on disk.
                    throw new Error("template save failed");
                }
                counts.save++;
                disk[file.path] = memory.content;
            },
            reduceProject() {
                counts.reduceProject++;
                // Destructive: the in-memory live project is collapsed. Model the
                // worst case where memory is mutated even when the op then throws.
                memory.content = REDUCED;
                if (scenario === "throwOnReduce") {
                    throw new Error("reduce failed");
                }
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
        // Inert queue so success paths exercise the real enqueue branch without
        // affecting live-project safety.
        enqueueBackgroundJob() { },
    };

    return { app, ctx, disk, memory, counts, originalPath };
}

// Arbitraries that vary the input space without changing which scenario runs.
const arbLabel = fc.string({ minLength: 0, maxLength: 40 });
const arbFolder = fc
    .array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join("/"));
const arbAssets = fc.array(
    fc.record({ fsPath: fc.string(), name: fc.string() }),
    { minLength: 0, maxLength: 6 }
);
const arbScenario = fc.constantFrom(...ALL_SCENARIOS);

describe("Property 1: Live project survives every save path", () => {
    it("leaves the on-disk live project byte-identical to its pre-save state, with the reopen invoked exactly when the destructive window was entered", () => {
        fc.assert(
            fc.property(
                arbScenario,
                arbLabel,
                arbFolder,
                arbAssets,
                (scenario, undoLabel, folderPath, assets) => {
                    const m = createModel(scenario, { undoLabel, folderPath, assets });
                    const res = runReduceFirstSave(m.app, m.ctx);

                    // (A) CORE GUARANTEE — the user's live project ON DISK is
                    // always exactly its pre-save state, on every path.
                    expect(m.disk[m.originalPath]).toBe(PRE_SAVE);

                    // The destructive window is ENTERED iff reduceProject ran.
                    const destructiveEntered = m.counts.reduceProject >= 1;

                    // (B) Reopen is invoked EXACTLY when the window was entered:
                    // zero reopens before the window, exactly one on/after it.
                    const expectedReopen = destructiveEntered ? 1 : 0;
                    expect(m.counts.open).toBe(expectedReopen);
                    expect(res.reopened).toBe(expectedReopen);

                    // (C) Classify the outcome and check the modeled memory state.
                    if (!destructiveEntered) {
                        // Failure BEFORE the window: live project untouched in
                        // memory too — never reduced, never reopened.
                        expect(BEFORE_WINDOW).toContain(scenario);
                        expect(m.memory.content).toBe(PRE_SAVE);
                        expect(res.ok).toBe(false);
                    } else if (scenario === "throwOnOpen") {
                        // Window entered, reopen attempted but threw: memory is
                        // left un-restored, yet the on-disk snapshot (checked in
                        // A) guarantees the user can recover their exact project
                        // by re-opening it — no data loss (Req 5.5).
                        expect(m.memory.content).toBe(REDUCED);
                    } else {
                        // Window entered and reopen succeeded (success path or an
                        // in/after-window failure): memory is RESTORED from the
                        // protective snapshot to the exact pre-save state.
                        expect(m.memory.content).toBe(PRE_SAVE);
                    }

                    // (D) At most one reopen ever — never a double restore.
                    expect(res.reopened).toBeLessThanOrEqual(1);
                }
            ),
            { numRuns: 200 }
        );
    });
});
