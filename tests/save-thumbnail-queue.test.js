/**
 * Background thumbnail queue — serialization, timeout, and retry unit tests.
 *
 * Spec: save-performance-optimization — Task 5.2
 * Validates: Requirements 10.5, 10.6, 10.7
 *
 * What is under test
 * ------------------
 * The client-side background queue in js/textanim/textanim.js. Thumbnail jobs
 * (enqueueThumbnailRender) ride the SAME serialized `previewQueue` as preview
 * jobs (enqueuePreviewRender) so the two AE renders never overlap and run in
 * FIFO order (Req 10.7). A thumbnail job that fails or does not finish within
 * THUMBNAIL_TIMEOUT_MS (60s) is abandoned and the queue advances (Req 10.5),
 * and a failed thumbnail is retried up to three total attempts per the later
 * approved save-import-performance-redesign contract (THUMBNAIL_MAX_ATTEMPTS=3).
 *
 * How it is exercised
 * -------------------
 * textanim.js is a single browser-side IIFE with no module system that depends
 * on host globals (csInterface, encodeBridge/decodeBridge, markFolderBusy/
 * clearFolderBusy, showToast, require(...) for node fs/os/path/child_process).
 * The sibling engine tests load such sources into a `vm` sandbox and inject
 * fakes (see tests/helpers/loadHelpers.js). We reuse that loader here, inject
 * controllable fakes, and drive the queue entirely through the two PUBLIC
 * entry points on the returned TextAnim object. All host calls funnel through
 * a controllable `csInterface.evalScript`, and jest fake timers drive the 60s
 * timeout, so the queue's ordering and retry behavior are fully observable and
 * deterministic without After Effects.
 */

"use strict";

const path = require("path");
const { loadHelpers } = require("./helpers/loadHelpers");

const TEXTANIM_REL = path.join("js", "textanim", "textanim.js");

// Default host responses used when a test does not override them. Both job
// kinds funnel through csInterface.evalScript; we distinguish by the jsx call.
function defaultResponseFor(jsx) {
    if (jsx.indexOf("renderTemplateThumbnail") !== -1) {
        return { ok: true };
    }
    // Preview render (taRenderPresetPreview): a minimal one-frame success so a
    // preview job can complete cleanly and let the queue advance to the next.
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
 * fakes. Returns the module handle plus recorders and helpers for driving the
 * queue deterministically.
 */
function makeHarness() {
    // Ordered record of evalScript invocations. Each host render (thumbnail or
    // preview) parks here until the test resolves it, giving us total control
    // over completion timing and ordering.
    const evalCalls = [];
    // Ordered record of markFolderBusy/clearFolderBusy so we can prove that at
    // most one job is "running" (busy without a matching clear) at any moment.
    const busyLog = [];
    const toasts = [];

    // Node fakes. child_process makes ffmpeg "available" and encoding "succeed"
    // synchronously so a preview job reaches its evalScript and then completes;
    // fs/os/path satisfy the temp-dir + APNG bookkeeping without touching disk.
    const cp = {
        execFile: function () {
            const cb = arguments[arguments.length - 1];
            if (typeof cb === "function") cb(null, "", "");
        },
    };
    const fsFake = {
        mkdirSync: function () { },
        readdirSync: function () {
            return ["preview_00000.png"];
        },
        statSync: function () {
            return { isFile: function () { return true; } };
        },
        existsSync: function () {
            return false;
        },
        unlinkSync: function () { },
        rmdirSync: function () { },
        readFileSync: function () {
            return "{}";
        },
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

    // Responder decides, per evalScript call, whether to hold (park) the call
    // for the test to resolve, or answer immediately. Default: park everything
    // so nothing completes until the test explicitly drives it.
    let holdEval = true;

    const injected = {
        // Host bridge.
        csInterface: {
            evalScript: function (jsx, cb) {
                const call = { jsx: jsx, cb: cb, responded: false };
                evalCalls.push(call);
                if (!holdEval) {
                    call.responded = true;
                    cb(JSON.stringify(defaultResponseFor(jsx)));
                }
            },
            getSystemPath: function () { return "/ext"; },
        },
        SystemPath: { EXTENSION: "EXTENSION" },
        encodeBridge: function (s) { return String(s); },
        decodeBridge: function (s) { return String(s); },
        // Production loads js/core/utils.js before textanim.js; inject the
        // resolver so this harness tests queue semantics at the real boundary.
        resolveFfmpeg: function (cb) { cb("ffmpeg"); },
        markFolderBusy: function (folder) { busyLog.push({ op: "busy", folder: folder }); },
        clearFolderBusy: function (folder) { busyLog.push({ op: "clear", folder: folder }); },
        showToast: function (msg, kind) { toasts.push({ msg: msg, kind: kind }); },
        refreshFromDisk: function () { },
        loadTemplatesDebounced: function () { },
        // Node access.
        require: fakeRequire,
        // Host timers routed to the (jest-faked) test-realm global timers.
        setTimeout: function () { return global.setTimeout.apply(global, arguments); },
        clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
        setInterval: function () { return global.setInterval.apply(global, arguments); },
        clearInterval: function () { return global.clearInterval.apply(global, arguments); },
    };

    const handle = loadHelpers({ file: TEXTANIM_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;
    const TextAnim = handle.get("TextAnim");
    if (!TextAnim) throw new Error("TextAnim module did not load");

    /** Resolve the oldest still-parked evalScript with a success/override payload. */
    function completeNextEval(override) {
        for (let i = 0; i < evalCalls.length; i++) {
            const call = evalCalls[i];
            if (call.responded) continue;
            call.responded = true;
            const payload = override !== undefined
                ? override
                : defaultResponseFor(call.jsx);
            call.cb(JSON.stringify(payload));
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
        toasts: toasts,
        completeNextEval: completeNextEval,
        pendingEvalCount: pendingEvalCount,
        setHoldEval: function (v) { holdEval = v; },
    };
}

/**
 * Assert the busy/clear log never has two concurrently-running jobs: every
 * "busy" must occur while no other job is busy (active count peaks at 1).
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

// ────────────────────────────────────────────────────────────────────────
// Requirement 10.7 — serialized, FIFO, non-overlapping queue
// ────────────────────────────────────────────────────────────────────────
describe("queue serialization: FIFO order and no overlap (Req 10.7)", () => {
    test("only one job runs at a time; queued jobs wait until it completes", () => {
        const h = makeHarness();

        h.TextAnim.enqueueThumbnailRender("/t/a/project.aep", "/t/a/thumbnail.png", () => { });
        // First job started synchronously and parked at its host render.
        expect(h.evalCalls.length).toBe(1);
        expect(h.pendingEvalCount()).toBe(1);

        // Enqueue two more jobs while the first is still running.
        h.TextAnim.enqueueThumbnailRender("/t/b/project.aep", "/t/b/thumbnail.png", () => { });
        h.TextAnim.enqueueThumbnailRender("/t/c/project.aep", "/t/c/thumbnail.png", () => { });

        // They must WAIT — no additional host render has started.
        expect(h.evalCalls.length).toBe(1);
        expect(h.pendingEvalCount()).toBe(1);
    });

    test("thumbnail and preview jobs interleave in strict FIFO order without overlapping", () => {
        const h = makeHarness();
        const order = [];

        h.TextAnim.enqueueThumbnailRender("/t/a/project.aep", "/t/a/thumbnail.png", () => order.push("a"));
        h.TextAnim.enqueuePreviewRender("/t/b/project.aep", "B", () => order.push("b"), true);
        h.TextAnim.enqueueThumbnailRender("/t/c/project.aep", "/t/c/thumbnail.png", () => order.push("c"));

        // Job 1 (thumbnail a) is running; the preview and third thumbnail wait.
        expect(h.evalCalls.length).toBe(1);
        expect(h.evalCalls[0].jsx).toContain("renderTemplateThumbnail");
        expect(h.evalCalls[0].jsx).toContain("/t/a/project.aep");

        // Complete job 1 → job 2 (preview b) starts next (FIFO).
        h.completeNextEval();
        expect(h.evalCalls.length).toBe(2);
        expect(h.evalCalls[1].jsx).toContain("taRenderPresetPreview");
        expect(h.evalCalls[1].jsx).toContain("/t/b/project.aep");

        // Complete job 2 → job 3 (thumbnail c) starts last.
        h.completeNextEval();
        expect(h.evalCalls.length).toBe(3);
        expect(h.evalCalls[2].jsx).toContain("renderTemplateThumbnail");
        expect(h.evalCalls[2].jsx).toContain("/t/c/project.aep");

        // Complete job 3 → all callbacks fired in enqueue order.
        h.completeNextEval();
        expect(order).toEqual(["a", "b", "c"]);

        // And at no point did two jobs run concurrently.
        assertNoOverlap(h.busyLog);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 10.5 — abandon-and-advance on the 60s timeout
// ────────────────────────────────────────────────────────────────────────
describe("thumbnail timeout: abandon after 60s and advance (Req 10.5)", () => {
    test("a thumbnail that never reports back is abandoned at 60s and the queue advances", () => {
        const h = makeHarness();
        const done = [];

        // Job 1: a thumbnail that will hang (we never resolve its evalScript).
        h.TextAnim.enqueueThumbnailRender("/t/hang/project.aep", "/t/hang/thumbnail.png", (err) => done.push({ job: "hang", err: err }));
        // Job 2: a following thumbnail waiting behind it.
        h.TextAnim.enqueueThumbnailRender("/t/next/project.aep", "/t/next/thumbnail.png", (err) => done.push({ job: "next", err: err }));

        expect(h.evalCalls.length).toBe(1);
        expect(done.length).toBe(0);

        // Just under 60s: still nothing abandoned.
        jest.advanceTimersByTime(59999);
        expect(done.length).toBe(0);
        expect(h.evalCalls.length).toBe(1);

        // Hitting 60s abandons attempt 1. Because a retry is allowed (Req 10.6),
        // the SAME job requeues at the back — so the queue advances to job 2
        // first, and job 1's terminal callback has NOT fired yet.
        jest.advanceTimersByTime(1);
        expect(h.evalCalls.length).toBe(2);
        expect(h.evalCalls[1].jsx).toContain("/t/next/project.aep");
        expect(done.filter((d) => d.job === "hang").length).toBe(0);
    });

    test("a late host callback arriving after the timeout is ignored", () => {
        const h = makeHarness();
        const done = [];
        h.TextAnim.enqueueThumbnailRender("/t/late/project.aep", "/t/late/thumbnail.png", (err) => done.push(err));

        // Trip the 60s timeout (abandons attempt 1, schedules the retry).
        jest.advanceTimersByTime(60000);
        const busyAfterTimeout = h.busyLog.length;

        // The original host render finally answers — must be a no-op.
        h.completeNextEval({ ok: true });
        expect(h.busyLog.length).toBe(busyAfterTimeout);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Later approved contract — retry a failed thumbnail up to 3 attempts
// ────────────────────────────────────────────────────────────────────────
describe("thumbnail retry: capped at three attempts", () => {
    test("a failing thumbnail uses three attempts, then reports failure", () => {
        const h = makeHarness();
        const done = [];
        h.TextAnim.enqueueThumbnailRender("/t/fail/project.aep", "/t/fail/thumbnail.png", (err) => done.push(err));

        expect(h.evalCalls.length).toBe(1);
        h.completeNextEval({ ok: false, error: "render blew up" });
        expect(h.evalCalls.length).toBe(2);
        expect(done.length).toBe(0);

        h.completeNextEval({ ok: false, error: "render blew up again" });
        expect(h.evalCalls.length).toBe(3);
        expect(h.evalCalls[2].jsx).toContain("/t/fail/project.aep");
        expect(done.length).toBe(0);

        h.completeNextEval({ ok: false, error: "render blew up finally" });
        expect(h.evalCalls.length).toBe(3);
        expect(done.length).toBe(1);
        expect(String(done[0])).toMatch(/thumbnail|render blew up/i);
    });

    test("three consecutive timeouts exhaust the three-attempt cap", () => {
        const h = makeHarness();
        const done = [];
        h.TextAnim.enqueueThumbnailRender("/t/to/project.aep", "/t/to/thumbnail.png", (err) => done.push(err));

        jest.advanceTimersByTime(60000);
        expect(h.evalCalls.length).toBe(2);
        expect(done.length).toBe(0);

        jest.advanceTimersByTime(60000);
        expect(h.evalCalls.length).toBe(3);
        expect(done.length).toBe(0);

        jest.advanceTimersByTime(60000);
        expect(h.evalCalls.length).toBe(3);
        expect(done.length).toBe(1);
        expect(String(done[0])).toMatch(/timed out/i);
    });

    test("a retried thumbnail that succeeds on attempt 2 reports success once", () => {
        const h = makeHarness();
        const done = [];
        h.TextAnim.enqueueThumbnailRender("/t/ok2/project.aep", "/t/ok2/thumbnail.png", (err) => done.push(err));

        h.completeNextEval({ ok: false, error: "transient" });
        expect(h.evalCalls.length).toBe(2);
        h.completeNextEval({ ok: true });

        expect(done.length).toBe(1);
        expect(done[0]).toBeFalsy();
        expect(h.evalCalls.length).toBe(2);
    });
});
