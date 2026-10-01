// ============================================================
// core/saveOrchestrator.js — pure, app-injected essential save sequence
// ------------------------------------------------------------
// Feature: save-import-performance-redesign (Task 3.1)
//   supersedes the save-performance-optimization skeleton.
//
// Encodes the "reduce-first, single template save" call ordering as a pure,
// dependency-injected function so jest + fast-check can assert its correctness
// properties without After Effects, and so the ExtendScript host functions
// (coreSaveLayerType / saveActiveComp) can reuse the exact same sequence.
//
// The one and only ordering on the successful path is:
//
//     beginUndoGroup
//   → save(originalFile)          (protective full-project write #1)
//   → buildTempComp
//   → reduceProject([temp])       (ENTERS the "destructive window")
//   → save(targetFile)            (single template full-project write #2)
//   → collectFootageAssets        (after reduce, before reopen)
//   → endUndoGroup                (exactly once)
//   → open(originalFile)          (single reopen — the destructive window
//                                  was entered, so restoration is required)
//   → enqueueBackgroundJob(...)   (emit render work as Background_Queue jobs)
//
// ─ Guarantees enforced by this module (Task 3.1 / Requirements 2.2, 2.5,
//   4.1, 5.5, 5.6) ──────────────────────────────────────────────────────────
//
//   • At most ONE protective full-project write and at most ONE template
//     full-project write ⇒ at most 2 `project.save` calls per save, across the
//     success path and every failure branch (Req 2.5). A hard budget guard
//     (`writeFullProject`) throws if a third write is ever attempted.
//   • A SINGLE reopen, invoked exactly when — and only when — the destructive
//     window has been entered (Req 5.5). Failures before the window reopen
//     nothing (the live project is untouched on disk); failures in/after the
//     window always restore the live project from the protective snapshot.
//   • This module NEVER invokes thumbnail/preview rendering directly. Required
//     renders are emitted ONLY as enqueued Background_Queue jobs via the
//     injected `enqueueBackgroundJob` dependency (Req 2.2, 4.1). Enqueue
//     failure is non-fatal to the essential save.
//   • Live-project restoration from the protective-save snapshot is guaranteed
//     on any failure inside or after the destructive window (Req 5.5, 5.6).
// ============================================================

/**
 * @typedef {Object} BackgroundJob
 * @property {'thumbnail'|'preview'} kind
 * @property {string}  folderPath     Normalized template folder path.
 * @property {?string} inputAepPath   The SAVED template project.aep (never the live project).
 * @property {number}  attempts       Retry counter (0 at enqueue time).
 */

/**
 * @typedef {Object} SaveContext
 * @property {string}   undoLabel               Undo-group label.
 * @property {*}        originalFile            User's live project file (protective-save target + reopen target).
 * @property {*}        targetFile              Template project.aep target file.
 * @property {string}   folderPath              Normalized template folder path.
 * @property {function(*):*} buildTempComp      (app) -> temp comp | null. Runs AFTER the protective save.
 * @property {function(*):Array} [collectFootageAssets] (project) -> asset list. Runs AFTER reduce.
 * @property {function(BackgroundJob):*} [enqueueBackgroundJob] Emit a Non_Essential render job onto
 *   the Background_Queue. Injected so the pure sequence never renders directly (Req 2.2, 4.1).
 * @property {boolean}  [needsThumbnail]        Emit a thumbnail render job on success (default true).
 * @property {boolean}  [needsPreview]          Also emit a preview render job on success (default false).
 */

/**
 * Resolve a usable file-system path from an injected file value. Never throws.
 * Accepts a raw string, an ExtendScript File (`fsName`/`fullName`), or a fake
 * harness object exposing `path`.
 * @param {*} file
 * @returns {?string}
 */
function filePathOf(file) {
    if (!file) return null;
    if (typeof file === "string") return file;
    if (typeof file.fsName === "string") return file.fsName;
    if (typeof file.fullName === "string") return file.fullName;
    if (typeof file.path === "string") return file.path;
    return null;
}

/**
 * Remove a temp comp best-effort. Never throws.
 * @param {*} tempComp
 */
function removeTempCompSafe(tempComp) {
    if (tempComp && typeof tempComp.remove === "function") {
        try {
            tempComp.remove();
        } catch (e) {
            /* best-effort — the comp may already be gone after reduceProject */
        }
    }
}

/**
 * Reopen the user's project from disk exactly once, with dialog suppression
 * enabled before and disabled after (balanced on every path). Never throws.
 * @param {*} app
 * @param {*} originalFile
 * @returns {{ ok: boolean, error: * }}
 */
function reopenOriginal(app, originalFile) {
    var ok = true;
    var error = null;
    app.beginSuppressDialogs();
    try {
        app.open(originalFile);
    } catch (e) {
        ok = false;
        error = e;
    } finally {
        // Balance the suppression enabled above on this exact path.
        app.endSuppressDialogs(false);
    }
    return { ok: ok, error: error };
}

/**
 * Restore-and-return for a throw inside the destructive window (reduce or
 * template save). Ends the undo group once, reopens originalFile from the
 * protective-save snapshot on disk (suppress-balanced), and returns the
 * supplied failure result. Restoration is attempted even if temp-comp cleanup
 * or the undo-group close misbehaves (Req 5.5, 5.6).
 * @param {*} app
 * @param {*} originalFile
 * @param {*} tempComp
 * @param {Object} result  Failure result object to return.
 * @param {function():void} endUndoGroupOnce
 * @param {function():{ok:boolean,error:*}} reopenOnce
 * @returns {Object}
 */
function restoreAndReturn(app, originalFile, tempComp, result, endUndoGroupOnce, reopenOnce) {
    // Backward-compatible signature: when called directly (legacy callers /
    // tests) without the guarded closures, fall back to raw operations while
    // still guaranteeing a single reopen from the snapshot.
    if (typeof endUndoGroupOnce !== "function") {
        removeTempCompSafe(tempComp);
        try {
            app.endUndoGroup();
        } catch (e) {
            /* undo group already closed — restoration still proceeds */
        }
        var r = reopenOriginal(app, originalFile);
        if (!r.ok) {
            result.reopenFailed = true;
            result.reopenError = String(r.error);
        }
        result.reopened = 1;
        return result;
    }

    removeTempCompSafe(tempComp);
    endUndoGroupOnce();
    var reopen = reopenOnce();
    if (!reopen.ok) {
        result.reopenFailed = true;
        result.reopenError = String(reopen.error);
    }
    // The destructive window was entered, so exactly one reopen is performed.
    result.reopened = 1;
    return result;
}

/**
 * Build the render jobs a freshly-saved template requires. The input is always
 * the SAVED template project.aep — never the live project (Req 4.3).
 * @param {SaveContext} ctx
 * @returns {BackgroundJob[]}
 */
function buildRenderJobs(ctx) {
    var jobs = [];
    var inputAepPath = filePathOf(ctx.targetFile);
    // A fresh template always needs a thumbnail unless explicitly opted out.
    if (ctx.needsThumbnail !== false) {
        jobs.push({
            kind: "thumbnail",
            folderPath: ctx.folderPath,
            inputAepPath: inputAepPath,
            attempts: 0
        });
    }
    if (ctx.needsPreview === true) {
        jobs.push({
            kind: "preview",
            folderPath: ctx.folderPath,
            inputAepPath: inputAepPath,
            attempts: 0
        });
    }
    return jobs;
}

/**
 * Emit every required render as an enqueued Background_Queue job (Req 2.2,
 * 4.1). This module holds NO reference to any render function, so it cannot
 * render directly. Enqueue failure is recorded but never fails the essential
 * save (the essential result must survive background-scheduling errors).
 * @param {SaveContext} ctx
 * @param {Object} result  Success result to annotate.
 */
function emitRenderJobs(ctx, result) {
    var jobs = buildRenderJobs(ctx);
    result.renderJobs = jobs;
    result.renderJobsEnqueued = 0;

    var enqueue = ctx.enqueueBackgroundJob;
    if (typeof enqueue !== "function") {
        // No queue injected (e.g. host-side reuse): the return shape's
        // `needsThumbnail` flag drives client-side scheduling instead.
        return;
    }
    for (var i = 0; i < jobs.length; i++) {
        try {
            enqueue(jobs[i]);
            result.renderJobsEnqueued++;
        } catch (enqErr) {
            result.backgroundScheduleError = String(enqErr);
        }
    }
}

/**
 * Run the reduce-first, single-template-save sequence.
 *
 * @param {*} app  Injected After Effects application object. Must expose
 *   beginUndoGroup / endUndoGroup, beginSuppressDialogs / endSuppressDialogs,
 *   open(file), and project.save(file) / project.reduceProject([comp]).
 * @param {SaveContext} ctx
 * @returns {Object} Result object:
 *   success:            { ok:true, assetsList, folderPath, needsThumbnail:true,
 *                         writes, reopened, renderJobs, renderJobsEnqueued,
 *                         [reopenFailed, reopenError] }
 *   protective-save fail:{ ok:false, aborted:true, reason:"protective-save-failed", error, writes, reopened:0 }
 *   pre-reduce fail:    { ok:false, reason:"temp-comp-failed", error, writes, reopened:0 }
 *   destructive-window: { ok:false, reason:"destructive-window-failed", error, writes, reopened, [reopenFailed] }
 */
function runReduceFirstSave(app, ctx) {
    ctx = ctx || {};

    var originalFile = ctx.originalFile;
    var targetFile = ctx.targetFile;
    var undoLabel = ctx.undoLabel || "Save";
    var folderPath = ctx.folderPath;
    var buildTempComp = ctx.buildTempComp;
    var collectFootageAssets = ctx.collectFootageAssets;

    var tempComp = null;

    // ── Hard invariants tracked across every path ───────────────────────
    // writeCount enforces the ≤2 full-project-write bound (Req 2.5); the
    // destructive flag ties the single reopen to entering the window (Req 5.5).
    var writeCount = 0;
    var reopenCount = 0;
    var undoGroupOpen = false;
    var undoGroupEnded = false;

    // Guarded full-project write. Never permits a third write, so the ≤2 bound
    // holds structurally even under future edits (Req 2.5).
    function writeFullProject(file) {
        if (writeCount >= 2) {
            throw new Error("save-write-budget-exceeded: at most 2 full-project writes per save");
        }
        writeCount++;
        app.project.save(file);
    }

    // End the undo group at most once, even if a later path also tries to
    // close it, keeping begin/end balanced (Req: suppress/undo balance).
    function endUndoGroupOnce() {
        if (!undoGroupOpen || undoGroupEnded) return;
        undoGroupEnded = true;
        app.endUndoGroup();
    }

    // Reopen the live project from the protective snapshot at most once.
    function reopenOnce() {
        if (reopenCount >= 1) return { ok: true, error: null };
        reopenCount++;
        return reopenOriginal(app, originalFile);
    }

    // ── BEGIN UNDO GROUP ────────────────────────────────────────────────
    app.beginUndoGroup(undoLabel);
    undoGroupOpen = true;

    // ── PROTECTIVE SAVE (full-project write #1, abort-on-throw) ─────────
    // On failure: end the undo group once and abort. NO temp comp, NO reduce,
    // NO reopen — the destructive window was never entered, the live project
    // is 100% intact on disk and in memory (Req 5.6).
    var protectErr = null;
    try {
        writeFullProject(originalFile);
    } catch (saveErr) {
        protectErr = saveErr;
    }
    if (protectErr !== null) {
        endUndoGroupOnce();
        return {
            ok: false,
            aborted: true,
            reason: "protective-save-failed",
            error: String(protectErr),
            writes: writeCount,
            reopened: reopenCount
        };
    }

    // ── BUILD TEMP COMP (pre-reduce, non-destructive) ───────────────────
    // A failure here is BEFORE the destructive window: remove any temp comp,
    // end the undo group once, and return — no reduce, no reopen required.
    try {
        tempComp = buildTempComp ? buildTempComp(app) : null;
    } catch (buildErr) {
        removeTempCompSafe(tempComp);
        endUndoGroupOnce();
        return {
            ok: false,
            reason: "temp-comp-failed",
            error: String(buildErr),
            writes: writeCount,
            reopened: reopenCount
        };
    }
    if (!tempComp) {
        endUndoGroupOnce();
        return {
            ok: false,
            reason: "temp-comp-failed",
            error: "Could not create temp comp",
            writes: writeCount,
            reopened: reopenCount
        };
    }

    // ── DESTRUCTIVE WINDOW: reduce first, then the single template save ──
    // The window is ENTERED at reduceProject; from here the in-memory live
    // project is destroyed, so the sequence MUST restore it via exactly one
    // reopen on every exit — success or failure (Req 5.5).
    try {
        app.project.reduceProject([tempComp]);

        // Full-project write #2 (the single template write).
        writeFullProject(targetFile);

        var assetsList = collectFootageAssets ? collectFootageAssets(app.project) : [];

        endUndoGroupOnce();

        // ── REOPEN ONCE (suppress-balanced) — window was entered ─────────
        // The essential save succeeded, but if restoration of the live
        // project fails the caller must NEVER present a plain success: the
        // user's open project may still be the reduced/temp project. Surface
        // the failure with the exact same reopenFailed/reopenError shape the
        // destructive-window failure path uses (Bug C3).
        var reopen = reopenOnce();

        var result = {
            ok: true,
            assetsList: assetsList,
            folderPath: folderPath,
            needsThumbnail: ctx.needsThumbnail !== false,
            writes: writeCount,
            reopened: reopenCount
        };
        if (!reopen || !reopen.ok) {
            result.reopenFailed = true;
            result.reopenError = reopen ? String(reopen.error) : "reopen returned no result";
        }

        // Emit required renders ONLY as enqueued Background_Queue jobs; this
        // runs after restoration and never blocks/aborts the essential result.
        emitRenderJobs(ctx, result);

        return result;
    } catch (destructiveErr) {
        return restoreAndReturn(
            app,
            originalFile,
            tempComp,
            {
                ok: false,
                reason: "destructive-window-failed",
                error: String(destructiveErr),
                writes: writeCount
            },
            endUndoGroupOnce,
            reopenOnce
        );
    }
}

// Dual-load guard: CommonJS for jest, bare global for ExtendScript inclusion.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        runReduceFirstSave: runReduceFirstSave,
        reopenOriginal: reopenOriginal,
        restoreAndReturn: restoreAndReturn,
        removeTempCompSafe: removeTempCompSafe,
        buildRenderJobs: buildRenderJobs,
        emitRenderJobs: emitRenderJobs,
        filePathOf: filePathOf
    };
}
