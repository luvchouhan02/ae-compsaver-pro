/**
 * Property 11 — Background queue runs one job at a time in FIFO order.
 *
 * Feature: save-import-performance-redesign — Task 4.2
 * Validates: Requirements 4.2
 *
 * What is under test
 * ------------------
 * The generalized serialized Background_Queue in js/textanim/textanim.js
 * (task 4.1). Both thumbnail jobs (enqueueThumbnailRender) and preview jobs
 * (enqueuePreviewRender) ride the SAME serialized `previewQueue`. The design's
 * Property 11 states: for ANY sequence of enqueued jobs, the runner starts jobs
 * in first-in-first-out order and never has more than one job running at the
 * same time.
 *
 * How it is exercised
 * -------------------
 * textanim.js is a single browser-side IIFE with no module system that depends
 * on host globals. We load it into a `vm` sandbox with controllable fakes (the
 * same technique as tests/save-thumbnail-queue.test.js), inject a controllable
 * `csInterface.evalScript` that PARKS every host render until the test resolves
 * it, and drive the queue entirely through the two public entry points.
 *
 * fast-check generates a random sequence of thumbnail/preview jobs (min 100
 * iterations). For each sequence we prove:
 *   - one-at-a-time: at any moment exactly one host render is in flight while
 *     jobs remain, and the busy/clear log never has two concurrent jobs; and
 *   - FIFO: the i-th host render that STARTS belongs to the i-th enqueued job.
 */

"use strict";

const path = require("path");
const fc = require("fast-check");
const { loadHelpers } = require("./helpers/loadHelpers");

const TEXTANIM_REL = path.join("js", "textanim", "textanim.js");

// Default host responses. Both job kinds funnel through csInterface.evalScript;
// distinguish by the jsx call. Both resolve successfully so each job completes
// on its first attempt (no retry) and the runner advances to the next job.
function defaultResponseFor(jsx) {
    if (jsx.indexOf("renderTemplateThumbnail") !== -1) {
        return { ok: true };
    }
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
 * fakes. Every host render parks in `evalCalls` until the test resolves it.
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
            evalScript: function (jsx, cb) {
                // Always PARK the call so nothing completes until the test drives it.
                evalCalls.push({ jsx: jsx, cb: cb, responded: false });
            },
            getSystemPath: function () { return "/ext"; },
        },
        SystemPath: { EXTENSION: "EXTENSION" },
        encodeBridge: function (s) { return String(s); },
        decodeBridge: function (s) { return String(s); },
        markFolderBusy: function (folder) { busyLog.push({ op: "busy", folder: folder }); },
        clearFolderBusy: function (folder) { busyLog.push({ op: "clear", folder: folder }); },
        showToast: function () { },
        refreshFromDisk: function () { },
        refreshCardPreview: function () { },
        loadTemplatesDebounced: function () { },
        // resolveFfmpeg moved to a global in core/utils.js (loaded before
        // textanim.js in the panel). Without it the preview runner throws a
        // ReferenceError that drainPreviewQueue swallows as "job threw", so
        // no evalScript is ever dispatched. Inject the cached-hit path.
        resolveFfmpeg: function (cb) { cb("ffmpeg"); },
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

    function completeNextEval() {
        for (let i = 0; i < evalCalls.length; i++) {
            const call = evalCalls[i];
            if (call.responded) continue;
            call.responded = true;
            call.cb(JSON.stringify(defaultResponseFor(call.jsx)));
            return call;
        }
        throw new Error("no parked evalScript to complete");
    }

    function pendingEvalCount() {
        return evalCalls.filter(function (c) { return !c.responded; }).length;
    }

    return {
        TextAnim: TextAnim,
        evalCalls: evalCalls,
        busyLog: busyLog,
        completeNextEval: completeNextEval,
        pendingEvalCount: pendingEvalCount,
    };
}

/**
 * Assert the busy/clear log never has two concurrently-running jobs: the
 * count of active ("busy" without a matching "clear") jobs peaks at 1.
 */
function assertNoOverlap(busyLog) {
    let active = 0;
    let peak = 0;
    for (let i = 0; i < busyLog.length; i++) {
        if (busyLog[i].op === "busy") {
            active++;
            if (active > peak) peak = active;
        } else {
            active--;
        }
        expect(active).toBeGreaterThanOrEqual(0);
    }
    expect(peak).toBeLessThanOrEqual(1);
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

// Feature: save-import-performance-redesign, Property 11: Background queue runs one job at a time in FIFO order
describe("Property 11: Background queue runs one job at a time in FIFO order (Req 4.2)", () => {
    test("for any sequence of enqueued jobs, jobs start in FIFO order with no overlap", () => {
        const jobKindArb = fc.array(fc.constantFrom("thumbnail", "preview"), {
            minLength: 1,
            maxLength: 10,
        });

        fc.assert(
            fc.property(jobKindArb, (kinds) => {
                const h = makeHarness();

                // Unique, order-identifying path per job so a started host
                // render can be attributed to exactly one enqueued job. Preview
                // jobs use a non-.aep path so their success completion routes to
                // the injected no-op refreshFromDisk rather than card DOM code.
                const paths = kinds.map(function (kind, i) {
                    return kind === "thumbnail"
                        ? "/t/thumb_" + i + "/project.aep"
                        : "/t/prev_" + i + "/preset_" + i + ".ffx";
                });

                // Enqueue the whole sequence up front. Only the first job may
                // start (drain guarded by previewRunning); the rest must wait.
                for (let i = 0; i < kinds.length; i++) {
                    if (kinds[i] === "thumbnail") {
                        h.TextAnim.enqueueThumbnailRender(paths[i], "/t/thumb_" + i + "/thumbnail.png", null);
                    } else {
                        // force=true bypasses the preview dedup cache.
                        h.TextAnim.enqueuePreviewRender(paths[i], "LABEL_" + i, null, true);
                    }
                }

                // Exactly one job started, regardless of how many were enqueued.
                expect(h.evalCalls.length).toBe(1);
                expect(h.pendingEvalCount()).toBe(1);

                // Drive each job to completion, proving one-at-a-time + FIFO.
                for (let i = 0; i < kinds.length; i++) {
                    // One-at-a-time: exactly one host render is in flight.
                    expect(h.pendingEvalCount()).toBe(1);
                    // FIFO: the i-th started render belongs to the i-th job.
                    expect(h.evalCalls.length).toBe(i + 1);
                    expect(h.evalCalls[i].jsx).toContain(paths[i]);

                    h.completeNextEval();
                }

                // Queue drained: nothing running, one start per job (no retries,
                // no overlap-induced extra starts).
                expect(h.pendingEvalCount()).toBe(0);
                expect(h.evalCalls.length).toBe(kinds.length);

                // The busy/clear log never had two concurrent jobs.
                assertNoOverlap(h.busyLog);
            }),
            { numRuns: 200 }
        );
    });
});
