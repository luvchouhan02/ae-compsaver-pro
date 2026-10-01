// Feature: save-import-performance-redesign, Property 3: Essential save schedules render work only as background jobs
//
// Property test for the redesigned essential Save_Engine sequence
// (`runReduceFirstSave` in js/core/saveOrchestrator.js, Task 3.1 / 3.4).
//
// Design Property 3 (Validates: Requirements 2.2, 4.1):
//   For any save request, the essential save sequence performs ZERO thumbnail
//   or preview render invocations directly, and every required render is
//   emitted ONLY as an enqueued Background_Queue job.
//
// The harness injects a pure `app` spy that also exposes every render-shaped
// method the sequence could conceivably reach (renderThumbnail / renderPreview /
// saveFrameToPng / renderQueue). Each render spy counts its invocations so we
// can assert the sequence never renders directly. A separate `enqueueBackgroundJob`
// spy captures every emitted job so we can assert renders are emitted only via
// the queue, tagged as background 'thumbnail'/'preview' jobs whose input is the
// SAVED template project.aep — never the live project.

const fc = require("fast-check");
const { runReduceFirstSave } = require("../js/core/saveOrchestrator.js");

// All failure-injection points, plus the clean success path ("none"). Together
// these cover every branch the sequence can take.
const ALL_SCENARIOS = [
    "none", // success path — the only path that emits render jobs
    "throwOnProtectiveSave", // protective write #1 throws (abort before window)
    "throwOnBuild", // buildTempComp throws (pre-reduce failure)
    "nullTempComp", // buildTempComp returns null (pre-reduce failure)
    "throwOnReduce", // reduceProject throws (destructive-window failure)
    "throwOnTemplateSave", // template write #2 throws (destructive-window failure)
    "throwOnOpen", // reopen throws (restore/reopen failure)
];

const RENDER_KINDS = ["thumbnail", "preview"];

/**
 * Build a pure `app` + `ctx` harness. The `app` spy carries render-shaped
 * methods (`renderCount` counts any of them) so we can prove the essential
 * sequence never renders directly. `enqueueBackgroundJob` records every job.
 */
function createHarness(scenario, opts) {
    opts = opts || {};
    const folderPath = opts.folderPath || "root/section/cat/id";
    const originalFile = { role: "original", path: "/user/live.aep" };
    const targetPath = folderPath + "/project.aep";
    const targetFile = { role: "target", path: targetPath };

    // Every direct-render observation increments renderCount. The property is
    // that this stays 0 on every path — the sequence holds no render function.
    const counts = { renderCount: 0, open: 0 };
    const enqueued = [];

    const tempComp = { name: "temp", remove() { } };

    // A render spy that also fails the property if ever invoked directly.
    function directRender() {
        counts.renderCount++;
    }

    const app = {
        beginUndoGroup() { },
        endUndoGroup() { },
        beginSuppressDialogs() { },
        endSuppressDialogs() { },
        open() {
            counts.open++;
            if (scenario === "throwOnOpen") throw new Error("open failed");
        },
        // Render-shaped surface the sequence must NEVER touch directly.
        renderThumbnail: directRender,
        renderPreview: directRender,
        saveFrameToPng: directRender,
        renderQueue: { render: directRender },
        project: {
            save(file) {
                if (file === originalFile && scenario === "throwOnProtectiveSave") {
                    throw new Error("protective failed");
                }
                if (file === targetFile && scenario === "throwOnTemplateSave") {
                    throw new Error("template failed");
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
        // The ONLY channel through which render work may leave the sequence.
        enqueueBackgroundJob(job) {
            enqueued.push(job);
        },
    };

    return { app, ctx, counts, enqueued, targetPath };
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
// Vary the render-job flags so both "emit thumbnail" and "emit preview" branches
// are exercised alongside the opt-out branches.
const arbNeedsThumbnail = fc.option(fc.boolean(), { nil: undefined });
const arbNeedsPreview = fc.option(fc.boolean(), { nil: undefined });

describe("Property 3: Essential save schedules render work only as background jobs", () => {
    it("never renders directly and emits every required render only as an enqueued Background_Queue job", () => {
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

                    // (A) CORE GUARANTEE — the essential sequence performs ZERO
                    // direct thumbnail/preview render invocations on every path.
                    expect(h.counts.renderCount).toBe(0);

                    // (B) Every emitted job is a background render job (thumbnail
                    // or preview) whose input is the SAVED template project.aep,
                    // never the live project (Req 4.3 alignment).
                    h.enqueued.forEach((job) => {
                        expect(RENDER_KINDS).toContain(job.kind);
                        expect(job.folderPath).toBe(folderPath);
                        expect(job.inputAepPath).toBe(h.targetPath);
                        expect(job.attempts).toBe(0);
                    });

                    if (res.ok) {
                        // (C) On success, the required renders — determined by the
                        // needsThumbnail/needsPreview flags — are emitted ONLY via
                        // the enqueue channel, matching the reported render jobs.
                        const wantThumb = needsThumbnail !== false;
                        const wantPreview = needsPreview === true;
                        const expectedKinds = [];
                        if (wantThumb) expectedKinds.push("thumbnail");
                        if (wantPreview) expectedKinds.push("preview");

                        expect(h.enqueued.map((j) => j.kind)).toEqual(expectedKinds);
                        expect(res.renderJobs.map((j) => j.kind)).toEqual(expectedKinds);
                        // The queue is the sole emission path: everything reported
                        // as a render job was actually enqueued.
                        expect(res.renderJobsEnqueued).toBe(h.enqueued.length);
                        expect(res.renderJobsEnqueued).toBe(expectedKinds.length);
                    } else {
                        // (D) On any failure path, no render work is scheduled at
                        // all — and (A) still guarantees nothing rendered directly.
                        expect(h.enqueued.length).toBe(0);
                    }
                }
            ),
            { numRuns: 200 }
        );
    });
});
