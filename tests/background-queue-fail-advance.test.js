/**
 * Background_Queue — failed / timed-out job advances the queue (property test)
 * ============================================================================
 * Feature: save-import-performance-redesign, Property 13: A failed or timed-out job is marked failed and advances the queue without harming the live project
 *
 * Exercises the generalized serialized FIFO job runner in
 * `js/textanim/textanim.js` (task 4.1) through its two PUBLIC entry points
 * `enqueueThumbnailRender` / `enqueuePreviewRender`.
 *
 * Property 13: For any job that throws or exceeds the 60-second budget, the
 * runner marks that job failed, leaves the user's live project unchanged, and
 * starts the next queued job.
 *
 * How it is checked
 * -----------------
 * textanim.js is a browser-side IIFE with no module system that depends on host
 * globals (csInterface, encodeBridge/decodeBridge, markFolderBusy/clearFolderBusy,
 * showToast, require(...) for node fs/os/path/child_process). We load it into a
 * `vm` sandbox with controllable fakes (mirroring tests/save-thumbnail-queue.test.js)
 * and drive the queue deterministically:
 *
 *   - "error"   : the host render responds { ok:false } on every attempt.
 *   - "timeout" : the host render never responds; Jest fake timers advance the
 *                 60-second per-job budget so the runner abandons the job.
 *   - "throw"   : the job throws synchronously (markFolderBusy throws for that
 *                 folder) so the runner's try/catch path is exercised.
 *
 * For every generated scenario we assert the three guarantees of Property 13:
 *   (1) MARKED FAILED  — each failing job's terminal callback fires with a
 *                        truthy error (after its retries are exhausted).
 *   (2) QUEUE ADVANCES — a trailing success sentinel behind all the failing
 *                        jobs still runs to completion (falsy error), proving
 *                        no single bad job stalls the runner; the queue settles
 *                        idle with no lingering host calls or timers.
 *   (3) LIVE PROJECT UNCHANGED — every host call the runner issues targets one
 *                        of the jobs' own saved-template `project.aep` paths and
 *                        is a render call only (never a live-project write /
 *                        reduce / reopen); no call references the live project.
 *
 * Validates: Requirements 4.4
 */

"use strict";

const path = require("path");
const fc = require("fast-check");
const { loadHelpers } = require("./helpers/loadHelpers");

const TEXTANIM_REL = path.join("js", "textanim", "textanim.js");

// Sentinel path for the user's LIVE project. The Background_Queue must never
// reference it — jobs render only from a saved template project.aep.
const LIVE_PROJECT = "/live/user-active-project.aep";

// Per-job saved-template paths keyed by index. Each job owns a distinct folder
// so folder-busy bookkeeping and host-call matching stay unambiguous.
function folderFor(i) { return "/lib/j" + i; }
function aepFor(i) { return folderFor(i) + "/project.aep"; }
function pngFor(i) { return folderFor(i) + "/thumbnail.png"; }

/**
 * Build a fresh TextAnim instance in a vm sandbox with controllable fakes.
 * `throwFolders` is a set (plain object) of folder paths whose markFolderBusy
 * throws synchronously, modeling a job that throws.
 */
function makeHarness(throwFolders) {
    throwFolders = throwFolders || {};

    const evalCalls = [];   // ordered record of every host render invocation
    const busyLog = [];     // markFolderBusy / clearFolderBusy, for overlap proof
    const toasts = [];

    const cp = {
        execFile: function () {
            const cb = arguments[arguments.length - 1];
            if (typeof cb === "function") cb(null, "", "");
        },
    };
    const fsFake = {
        mkdirSync: function () { },
        readdirSync: function () { return ["preview_00000.png"]; },
        statSync: function () { return { isFile: function () { return true; } }; },
        existsSync: function () { return false; },
        unlinkSync: function () { },
        rmdirSync: function () { },
        readFileSync: function () { return "{}"; },
        writeFileSync: function () { },
    };
    const osFake = { tmpdir: function () { return "/tmp"; } };
    const pathFake = {
        join: function () { return Array.prototype.slice.call(arguments).join("/"); },
        dirname: function (p) { return String(p).replace(/\/[^/]*$/, ""); },
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
            // Every render parks here (holdEval-style) until the driver resolves
            // it, giving the test total control over completion timing.
            evalScript: function (jsx, cb) {
                evalCalls.push({ jsx: jsx, cb: cb, responded: false });
            },
            getSystemPath: function () { return "/ext"; },
        },
        SystemPath: { EXTENSION: "EXTENSION" },
        encodeBridge: function (s) { return String(s); },
        decodeBridge: function (s) { return String(s); },
        // Production loads js/core/utils.js before textanim.js; inject that
        // approved boundary so preview jobs reach the controllable host call.
        resolveFfmpeg: function (cb) { cb("ffmpeg"); },
        markFolderBusy: function (folder) {
            // A job that "throws": the runner's first act on a job is to mark
            // its folder busy, so throwing here models a synchronous job throw
            // before any host call. Throw BEFORE logging so the folder never
            // registers as running (it never actually ran).
            if (throwFolders[folder]) throw new Error("boom-busy:" + folder);
            busyLog.push({ op: "busy", folder: folder });
        },
        clearFolderBusy: function (folder) { busyLog.push({ op: "clear", folder: folder }); },
        showToast: function (msg, kind) { toasts.push({ msg: msg, kind: kind }); },
        refreshFromDisk: function () { },
        loadTemplatesDebounced: function () { },
        require: fakeRequire,
        // Route host timers to the (jest-faked) test-realm globals.
        setTimeout: function () { return global.setTimeout.apply(global, arguments); },
        clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
        setInterval: function () { return global.setInterval.apply(global, arguments); },
        clearInterval: function () { return global.clearInterval.apply(global, arguments); },
    };

    const handle = loadHelpers({ file: TEXTANIM_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;
    const TextAnim = handle.get("TextAnim");
    if (!TextAnim) throw new Error("TextAnim module did not load");

    function firstParked() {
        for (let i = 0; i < evalCalls.length; i++) {
            if (!evalCalls[i].responded) return evalCalls[i];
        }
        return null;
    }
    function pendingEvalCount() {
        return evalCalls.filter(function (c) { return !c.responded; }).length;
    }

    return {
        TextAnim: TextAnim,
        evalCalls: evalCalls,
        busyLog: busyLog,
        toasts: toasts,
        firstParked: firstParked,
        pendingEvalCount: pendingEvalCount,
    };
}

// Match a parked host call to the job index that owns it (its saved-project
// folder token appears verbatim in the jsx, since encodeBridge is identity).
function ownerIndexOf(jsx, jobCount) {
    for (let i = 0; i < jobCount; i++) {
        if (jsx.indexOf(folderFor(i) + "/") !== -1) return i;
    }
    return -1;
}

/**
 * Drive the queue to quiescence. For each parked host call, resolve it per its
 * owning job's mode; timeouts are tripped by advancing the 60s budget. Short
 * timers (setTimeout(0) advances, 600ms retry backoff) are flushed each turn.
 */
function driveToIdle(h, jobs) {
    let guard = 0;
    while (guard++ < 500) {
        const parked = h.firstParked();
        if (parked) {
            const idx = ownerIndexOf(parked.jsx, jobs.length);
            const mode = idx >= 0 ? jobs[idx].mode : "success";
            if (mode === "timeout") {
                // Trip the running job's 60s budget. The parked call then
                // becomes a stale late-reply; consume it (the runner's
                // _finished/finished latch makes it a no-op).
                jest.advanceTimersByTime(60000);
                if (!parked.responded) {
                    parked.responded = true;
                    try { parked.cb(JSON.stringify({ ok: true })); } catch (e) { /* ignored */ }
                }
            } else if (mode === "error") {
                parked.responded = true;
                parked.cb(JSON.stringify({ ok: false, error: "render blew up" }));
            } else {
                parked.responded = true;
                parked.cb(JSON.stringify({ ok: true, frameCount: 1, frameRate: 30, framePattern: "preview_%05d.png", keyframesFound: 1 }));
            }
            // Flush setTimeout(0) advances and the 600ms preview retry backoff
            // without tripping any parked job's 60s budget (700 << 60000).
            jest.advanceTimersByTime(700);
            continue;
        }
        // No parked call: flush pending short timers (throw-path setTimeout(0),
        // retry backoff). When none remain, the runner has settled.
        if (jest.getTimerCount() > 0) {
            jest.advanceTimersByTime(700);
            continue;
        }
        break;
    }
    if (guard >= 500) throw new Error("driver failed to reach idle — possible queue stall");
}

// Enqueue one job on the appropriate public entry point, recording its
// terminal callback outcome into `results[index]`.
function enqueue(h, job, index, results) {
    const cb = function (err) {
        results[index] = { fired: true, err: err };
    };
    if (job.kind === "thumbnail") {
        h.TextAnim.enqueueThumbnailRender(aepFor(index), pngFor(index), cb);
    } else {
        // force=true bypasses the preview dedupe so every generated job runs.
        h.TextAnim.enqueuePreviewRender(aepFor(index), "LABEL" + index, cb, true);
    }
}

/**
 * Assert the busy/clear log never shows two jobs running concurrently: active
 * count peaks at 1 and never goes negative (serialized, one-at-a-time).
 */
function assertNoOverlap(busyLog) {
    let active = 0;
    let peak = 0;
    for (let i = 0; i < busyLog.length; i++) {
        if (busyLog[i].op === "busy") { active++; if (active > peak) peak = active; }
        else { active--; }
        expect(active).toBeGreaterThanOrEqual(0);
    }
    expect(peak).toBeLessThanOrEqual(1);
}

// A failing job: throws, exceeds the 60s budget, or errors on every attempt.
const failingJobArb = fc.record({
    kind: fc.constantFrom("thumbnail", "preview"),
    mode: fc.constantFrom("throw", "timeout", "error"),
});

// A scenario: 1..4 failing jobs followed by one success sentinel that proves
// the queue kept advancing all the way to completion.
const scenarioArb = fc.record({
    failing: fc.array(failingJobArb, { minLength: 1, maxLength: 4 }),
    sentinelKind: fc.constantFrom("thumbnail", "preview"),
});

describe("Property 13: A failed or timed-out job is marked failed and advances the queue without harming the live project", () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

    test("every failing/timed-out job is marked failed, the queue advances, and the live project is untouched", () => {
        fc.assert(
            fc.property(scenarioArb, (scenario) => {
                // Build the full job list: failing jobs then a success sentinel.
                const jobs = scenario.failing.concat([{ kind: scenario.sentinelKind, mode: "success" }]);
                const sentinelIndex = jobs.length - 1;

                // Folders whose markFolderBusy must throw (throw-mode jobs).
                const throwFolders = {};
                for (let i = 0; i < jobs.length; i++) {
                    if (jobs[i].mode === "throw") throwFolders[folderFor(i)] = true;
                }

                const h = makeHarness(throwFolders);
                const results = jobs.map(function () { return { fired: false, err: undefined }; });

                // Enqueue all jobs (FIFO). Only the first triggers the runner;
                // the rest wait behind it.
                for (let i = 0; i < jobs.length; i++) enqueue(h, jobs[i], i, results);

                driveToIdle(h, jobs);

                // (1) MARKED FAILED: every failing job reported a truthy error,
                //     exactly once.
                for (let i = 0; i < jobs.length; i++) {
                    if (jobs[i].mode === "success") continue;
                    expect(results[i].fired).toBe(true);
                    expect(results[i].err).toBeTruthy();
                }

                // (2) QUEUE ADVANCES: the trailing sentinel behind all the
                //     failing jobs still ran to completion with no error, and
                //     the runner settled idle (no parked host calls, no timers).
                expect(results[sentinelIndex].fired).toBe(true);
                expect(results[sentinelIndex].err).toBeFalsy();
                expect(h.pendingEvalCount()).toBe(0);
                expect(jest.getTimerCount()).toBe(0);

                // (3) LIVE PROJECT UNCHANGED: every host call is a render call
                //     targeting one of the jobs' own saved project.aep paths;
                //     none references the live project, and no write/reduce/
                //     reopen host call was issued.
                for (let k = 0; k < h.evalCalls.length; k++) {
                    const jsx = h.evalCalls[k].jsx;
                    expect(jsx.indexOf(LIVE_PROJECT)).toBe(-1);
                    expect(jsx.indexOf("/live/")).toBe(-1);
                    const isRender =
                        jsx.indexOf("renderTemplateThumbnail") !== -1 ||
                        jsx.indexOf("taRenderPresetPreview") !== -1;
                    expect(isRender).toBe(true);
                    expect(ownerIndexOf(jsx, jobs.length)).toBeGreaterThanOrEqual(0);
                }

                // Serialized: one job at a time, never overlapping.
                assertNoOverlap(h.busyLog);
            }),
            { numRuns: 100 }
        );
    });
});
