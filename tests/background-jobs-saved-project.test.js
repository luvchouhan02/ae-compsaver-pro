/**
 * Background_Queue render jobs operate ONLY on the saved template project
 * ======================================================================
 * Feature: save-import-performance-redesign, Property 12: Background jobs operate only on the saved template project
 *
 * Exercises the generalized serialized job runner in js/textanim/textanim.js
 * (task 4.1), driven through its two PUBLIC entry points:
 *   - TextAnim.enqueueThumbnailRender(aepPath, outPngPath, onDone)
 *   - TextAnim.enqueuePreviewRender(presetPath, label, onDone, force)
 *
 * Property 12: For any scheduled render job, the job's input is the saved
 * template `project.aep` and the job issues no operation that modifies,
 * reduces, reopens, or reloads the user's live project.
 *
 * How it is validated
 * -------------------
 * textanim.js is a browser-side IIFE with no module system; it depends on host
 * globals (csInterface, encodeBridge/decodeBridge, markFolderBusy/clearFolderBusy,
 * require(...) for node fs/os/path/child_process). We load it into a `vm`
 * sandbox (tests/helpers/loadHelpers.js), inject controllable fakes, and drive
 * the queue entirely through the two public entry points.
 *
 * A distinguished LIVE_PROJECT path represents the user's live project. It is
 * NEVER enqueued as a job input. For an arbitrary FIFO sequence of render jobs
 * (each keyed to a SAVED template folder), we capture every host `evalScript`
 * the runner issues and every markFolderBusy target, then assert:
 *   1. Every issued host call is one of the allowed non-destructive render
 *      entry points (renderTemplateThumbnail / taRenderPresetPreview).
 *   2. Every render call's INPUT path is the saved template path that was
 *      enqueued for some job — the live project path never appears.
 *   3. No issued call contains an operation that modifies, reduces, reopens,
 *      or reloads the live project (no reduceProject / app.open / project.save
 *      / project.close / reopen / reload / importFile tokens).
 *   4. The runner only ever marks SAVED template folders busy, never the live
 *      project folder.
 *
 * Validates: Requirements 4.3
 */

"use strict";

const path = require("path");
const fc = require("fast-check");
const { loadHelpers } = require("./helpers/loadHelpers");

const TEXTANIM_REL = path.join("js", "textanim", "textanim.js");

// The user's live project. It is never used as a job input; if any host call
// or busy-marker references it, the runner touched the live project.
const LIVE_PROJECT = "/live/UserLiveProject.aep";
const LIVE_PROJECT_FOLDER = "/live";

// Allowed non-destructive render entry points the Background_Queue may call.
const ALLOWED_RENDER_CALLS = ["renderTemplateThumbnail", "taRenderPresetPreview"];

// Tokens that would indicate a live-project mutation/reduce/reopen/reload.
// None of these may appear in any host call issued by a render job.
const FORBIDDEN_OP_RE = /reduceProject|app\.open\b|\.close\s*\(|project\.save|reopenLiveProject|\breopen\b|\breload\b|importFile/i;

// Default host responses. Both job kinds funnel through csInterface.evalScript;
// we distinguish by the jsx call so each job can complete and advance the queue.
function defaultResponseFor(jsx) {
    if (jsx.indexOf("renderTemplateThumbnail") !== -1) {
        return { ok: true };
    }
    // Preview render (taRenderPresetPreview): a minimal one-frame success.
    return {
        ok: true,
        frameCount: 1,
        frameRate: 30,
        framePattern: "preview_%05d.png",
        keyframesFound: 1,
    };
}

/**
 * Build a fresh TextAnim instance in a vm sandbox with fully controllable
 * fakes. All host renders park in `evalCalls` until the test completes them.
 */
function makeHarness() {
    const evalCalls = [];
    const busyLog = [];

    const cp = {
        execFile: function () {
            const cb = arguments[arguments.length - 1];
            if (typeof cb === "function") cb(null, "", "");
        },
    };
    const fsFake = {
        mkdirSync: function () { },
        readdirSync: function () { return ["preview_00000.png"]; },
        statSync: function () {
            return { isFile: function () { return true; }, mtimeMs: 1 };
        },
        existsSync: function () { return false; },
        unlinkSync: function () { },
        rmdirSync: function () { },
        readFileSync: function () { return "{}"; },
        writeFileSync: function () { },
    };
    const osFake = { tmpdir: function () { return "/tmp"; } };
    const pathFake = {
        join: function () {
            return Array.prototype.slice.call(arguments).join("/");
        },
        dirname: function (p) {
            return String(p).replace(/\/[^/]*$/, "");
        },
    };
    function fakeRequire(name) {
        if (name === "child_process") return cp;
        if (name === "fs") return fsFake;
        if (name === "os") return osFake;
        if (name === "path") return pathFake;
        return null;
    }

    const injected = {
        csInterface: {
            evalScript: function (jsx, cb) {
                evalCalls.push({ jsx: jsx, cb: cb, responded: false });
            },
            getSystemPath: function () { return "/ext"; },
        },
        SystemPath: { EXTENSION: "EXTENSION" },
        // Identity codec so the raw path is directly observable in the jsx.
        encodeBridge: function (s) { return String(s); },
        decodeBridge: function (s) { return String(s); },
        // Production loads js/core/utils.js before textanim.js; inject that
        // approved boundary so preview jobs exercise their real host call.
        resolveFfmpeg: function (cb) { cb("ffmpeg"); },
        markFolderBusy: function (folder) { busyLog.push({ op: "busy", folder: folder }); },
        clearFolderBusy: function (folder) { busyLog.push({ op: "clear", folder: folder }); },
        showToast: function () { },
        refreshFromDisk: function () { },
        loadTemplatesDebounced: function () { },
        require: fakeRequire,
        setTimeout: function () { return global.setTimeout.apply(global, arguments); },
        clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
        setInterval: function () { return global.setInterval.apply(global, arguments); },
        clearInterval: function () { return global.clearInterval.apply(global, arguments); },
    };

    const handle = loadHelpers({ file: TEXTANIM_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;
    const TextAnim = handle.get("TextAnim");
    if (!TextAnim) throw new Error("TextAnim module did not load");

    /** Resolve the oldest still-parked evalScript with its default success payload. */
    function completeNextEval() {
        for (let i = 0; i < evalCalls.length; i++) {
            const call = evalCalls[i];
            if (call.responded) continue;
            call.responded = true;
            call.cb(JSON.stringify(defaultResponseFor(call.jsx)));
            return true;
        }
        return false;
    }

    return { TextAnim, evalCalls, busyLog, completeNextEval };
}

// A single render job keyed to a UNIQUE saved template folder so no dedup
// collapses distinct jobs. Each job's input is the SAVED template project.aep
// (thumbnail) or the SAVED preset/template path (preview) — never the live one.
const jobArb = fc.record({
    kind: fc.constantFrom("thumbnail", "preview"),
    name: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)),
});

// A FIFO batch of 1..8 render jobs with distinct saved-folder names.
const batchArb = fc
    .uniqueArray(jobArb, {
        minLength: 1,
        maxLength: 8,
        selector: (j) => j.name,
    });

/** Enqueue one job and return its saved input path + saved folder. */
function enqueueJob(TextAnim, job, idx) {
    const folder = "/library/tpl_" + idx + "_" + job.name;
    if (job.kind === "thumbnail") {
        const aep = folder + "/project.aep";
        const outPng = folder + "/thumbnail.png";
        TextAnim.enqueueThumbnailRender(aep, outPng, function () { });
        return { inputPath: aep, folder: folder };
    }
    const preset = folder + "/project.aep";
    // force=true bypasses the per-session dedup so every job is dispatched.
    TextAnim.enqueuePreviewRender(preset, "Preset " + idx, function () { }, true);
    return { inputPath: preset, folder: folder };
}

describe("Property 12: Background jobs operate only on the saved template project", () => {
    let logSpy;
    let warnSpy;

    beforeEach(() => {
        jest.useFakeTimers();
        // The runner logs verbose per-job progress and (in this DOM-less
        // sandbox) a benign, internally-caught refreshCardPreview warning on
        // the preview success path. Silence both to keep the suite output
        // focused on the property result.
        logSpy = jest.spyOn(console, "log").mockImplementation(() => { });
        warnSpy = jest.spyOn(console, "warn").mockImplementation(() => { });
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    test("every render job's host call targets the saved template project and never the live project", () => {
        fc.assert(
            fc.property(batchArb, (jobs) => {
                const h = makeHarness();

                // Enqueue the whole FIFO batch. Distinct saved folders; the live
                // project path is NEVER passed as a job input.
                const savedInputs = new Set();
                const savedFolders = new Set();
                jobs.forEach((job, idx) => {
                    const info = enqueueJob(h.TextAnim, job, idx);
                    savedInputs.add(info.inputPath);
                    savedFolders.add(info.folder);
                });

                // Drain the queue: each completed render dispatches the next
                // (success path advances synchronously). Cap iterations well
                // above the job count as a safety net against an infinite loop.
                let guard = 0;
                const maxDrains = jobs.length * 4 + 8;
                while (h.completeNextEval()) {
                    if (++guard > maxDrains) break;
                }
                expect(guard).toBeLessThanOrEqual(maxDrains);

                // Every render job must have issued at least one host call.
                expect(h.evalCalls.length).toBeGreaterThanOrEqual(jobs.length);

                // ── Assert Property 12 over every issued host call ──────────
                for (const call of h.evalCalls) {
                    const jsx = call.jsx;

                    // (1) Only allowed non-destructive render entry points.
                    const isAllowed = ALLOWED_RENDER_CALLS.some(
                        (fn) => jsx.indexOf(fn + "(") !== -1
                    );
                    expect(isAllowed).toBe(true);

                    // (2) The input path is a SAVED template path; the live
                    //     project path never appears anywhere in the call.
                    expect(jsx.indexOf(LIVE_PROJECT)).toBe(-1);

                    // The first quoted argument is the render input path.
                    const firstArg = /\("([^"]*)"/.exec(jsx);
                    expect(firstArg).not.toBeNull();
                    expect(savedInputs.has(firstArg[1])).toBe(true);

                    // (3) No live-project modify/reduce/reopen/reload operation.
                    expect(FORBIDDEN_OP_RE.test(jsx)).toBe(false);
                }

                // (4) The runner only marks SAVED template folders busy — never
                //     the live project folder.
                for (const entry of h.busyLog) {
                    const folder = String(entry.folder || "").replace(/\\/g, "/");
                    expect(folder).not.toBe(LIVE_PROJECT_FOLDER);
                    expect(folder.indexOf(LIVE_PROJECT)).toBe(-1);
                }
            }),
            { numRuns: 100 }
        );
    });
});
