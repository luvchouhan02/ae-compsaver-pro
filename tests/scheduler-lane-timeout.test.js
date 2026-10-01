/**
 * Scheduler per-lane timeouts (M3).
 *
 * The scheduler arms a watchdog timeout per lane instead of hard-coding the
 * "ffmpeg" lane: the ffmpeg lane keeps its legacy 60s budget byte-for-byte
 * (precedence options.ffmpegTimeoutMs > options.timeoutMs > default, cancel
 * reason "ffmpeg timeout"), the ae lane is armed with AE_LANE_TIMEOUT_MS
 * (180s) as a lane-level default, and any lane/job can be protected via a
 * per-job `timeoutMs` option. On breach the job is cancelled with reason
 * "<lane> timeout" and the lane is released for the next queued job.
 */
"use strict";

const path = require("path");
const schedulerModule = require(path.resolve(__dirname, "../js/core/scheduler.js"));

function flush(times) {
    let chain = Promise.resolve();
    for (let i = 0; i < times; i++) {
        chain = chain.then(function () { return undefined; });
    }
    return chain;
}

// Manual clock: the scheduler's timers are injected, so tests advance time
// deterministically. Timers fire in time order; microtasks settle after each.
function createFakeTimers() {
    const state = { now: 0, nextId: 1, timers: new Map() };
    return {
        state: state,
        setTimeout: function (handler, delay) {
            const id = state.nextId++;
            state.timers.set(id, { at: state.now + Math.max(0, Number(delay) || 0), handler: handler });
            return id;
        },
        clearTimeout: function (id) { state.timers.delete(id); },
        advance: async function (ms) {
            const target = state.now + ms;
            for (;;) {
                let due = null;
                for (const entry of state.timers) {
                    if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
                }
                if (!due) break;
                state.now = Math.max(state.now, due[1].at);
                state.timers.delete(due[0]);
                due[1].handler();
                await flush(8);
            }
            state.now = target;
        },
    };
}

function createTimedScheduler(configuration) {
    const timers = createFakeTimers();
    configuration = Object.assign({
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    }, configuration || {});
    const scheduler = schedulerModule.createScheduler(configuration);
    return { timers: timers, scheduler: scheduler };
}

function neverSettlingJob() {
    return function () { return new Promise(function () { /* holds forever */ }); };
}

describe("scheduler per-lane timeout (M3)", function () {
    let harness;

    afterEach(function () {
        if (harness) harness.scheduler.dispose();
        harness = null;
    });

    test("exposes the named timeout constants and lane defaults", function () {
        expect(schedulerModule.FFMPEG_TIMEOUT_MS).toBe(60000);
        expect(schedulerModule.AE_LANE_TIMEOUT_MS).toBe(180000);
        harness = createTimedScheduler();
        expect(harness.scheduler.lanes.ae.timeoutMs).toBe(schedulerModule.AE_LANE_TIMEOUT_MS);
        // Lanes without a lane-level default stay unprotected.
        expect(harness.scheduler.lanes.filesystem.timeoutMs).toBe(null);
        expect(harness.scheduler.lanes.thumbnail.timeoutMs).toBe(null);
    });

    test("ae lane timeout fires on a hung hold and releases the lane", async function () {
        harness = createTimedScheduler();
        const scheduler = harness.scheduler;

        const hold = scheduler.enqueue("ae", neverSettlingJob());
        await flush(8);
        expect(hold.state).toBe("active");

        // One millisecond before the breach the hold is still alive.
        await harness.timers.advance(schedulerModule.AE_LANE_TIMEOUT_MS - 1);
        expect(hold.state).toBe("active");

        await harness.timers.advance(1);
        await flush(12);
        await expect(hold.promise).resolves.toEqual({ cancelled: true, reason: "ae timeout" });

        // The lane is free: the next queued ae job starts and completes.
        let ranAfter = false;
        const next = scheduler.enqueue("ae", function () { ranAfter = true; return "done"; });
        await scheduler.drain("ae");
        expect(ranAfter).toBe(true);
        await expect(next.promise).resolves.toBe("done");
    });

    test("per-job timeoutMs option overrides the ae lane default", async function () {
        harness = createTimedScheduler();
        const hold = harness.scheduler.enqueue("ae", neverSettlingJob(), { timeoutMs: 500 });
        await flush(8);
        await harness.timers.advance(500);
        await flush(12);
        await expect(hold.promise).resolves.toEqual({ cancelled: true, reason: "ae timeout" });
    });

    test("a job finishing just before the breach wins the race", async function () {
        harness = createTimedScheduler();
        let resolveJob;
        const hold = harness.scheduler.enqueue("ae", function () {
            return new Promise(function (resolve) { resolveJob = resolve; });
        });
        await flush(8);

        await harness.timers.advance(schedulerModule.AE_LANE_TIMEOUT_MS - 1);
        resolveJob("finished");
        await flush(12);
        await expect(hold.promise).resolves.toBe("finished");

        // Completion cleared the watchdog: no armed timer survives the breach.
        expect(harness.timers.state.timers.size).toBe(0);
        await harness.timers.advance(5000);
        expect(hold.state).toBe("settled");
    });

    test("ffmpeg lane keeps its legacy 60s budget and reason byte-for-byte", async function () {
        harness = createTimedScheduler();
        const scheduler = harness.scheduler;

        const hold = scheduler.enqueue("ffmpeg", neverSettlingJob());
        await flush(8);
        await harness.timers.advance(schedulerModule.FFMPEG_TIMEOUT_MS);
        await flush(12);
        await expect(hold.promise).resolves.toEqual({ cancelled: true, reason: "ffmpeg timeout" });
    });

    test("ffmpeg precedence is unchanged: ffmpegTimeoutMs beats timeoutMs", async function () {
        harness = createTimedScheduler();
        const scheduler = harness.scheduler;

        // options.ffmpegTimeoutMs wins over options.timeoutMs...
        const a = scheduler.enqueue("ffmpeg", neverSettlingJob(), { ffmpegTimeoutMs: 1000, timeoutMs: 99999 });
        await flush(8);
        await harness.timers.advance(1000);
        await flush(12);
        await expect(a.promise).resolves.toEqual({ cancelled: true, reason: "ffmpeg timeout" });

        // ...and options.timeoutMs is the fallback for the ffmpeg lane.
        const b = scheduler.enqueue("ffmpeg", neverSettlingJob(), { timeoutMs: 2000 });
        await flush(8);
        await harness.timers.advance(2000);
        await flush(12);
        await expect(b.promise).resolves.toEqual({ cancelled: true, reason: "ffmpeg timeout" });
    });

    test("configuration.ffmpegTimeoutMs overrides the ffmpeg default", async function () {
        harness = createTimedScheduler({ ffmpegTimeoutMs: 5000 });
        const hold = harness.scheduler.enqueue("ffmpeg", neverSettlingJob());
        await flush(8);
        await harness.timers.advance(5000);
        await flush(12);
        await expect(hold.promise).resolves.toEqual({ cancelled: true, reason: "ffmpeg timeout" });
    });

    test("unprotected lanes can hold indefinitely", async function () {
        harness = createTimedScheduler();
        const hold = harness.scheduler.enqueue("thumbnail", neverSettlingJob());
        await flush(8);
        await harness.timers.advance(600000);
        await flush(12);
        expect(hold.state).toBe("active");
    });
});
