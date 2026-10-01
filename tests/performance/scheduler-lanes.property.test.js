"use strict";
const path = require("path");
const fc = require("fast-check");
const schedulerModule = require(path.resolve(__dirname, "../../js/core/scheduler.js"));

function deferred() {
    let resolve;
    const promise = new Promise(function (done) { resolve = done; });
    return { promise, resolve };
}

describe("Phase 1 scheduler lane properties", function () {
    test("configured lanes enforce concurrency and FIFO admission", async function () {
        await fc.assert(fc.asyncProperty(
            fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 20 }),
            async function (values) {
                const scheduler = schedulerModule.createScheduler();
                const lanes = { filesystem: 2, ffmpeg: 1, ae: 1 };
                for (const name of Object.keys(lanes)) {
                    const gate = deferred(), starts = [];
                    let active = 0, peak = 0;
                    const handles = values.map(function (value, index) {
                        return scheduler.enqueue(name, async function () {
                            starts.push(index); active++; peak = Math.max(peak, active);
                            await gate.promise; active--; return value;
                        });
                    });
                    await Promise.resolve();
                    expect(peak).toBeLessThanOrEqual(lanes[name]);
                    gate.resolve();
                    await Promise.all(handles.map(function (handle) { return handle.promise; }));
                    expect(starts).toEqual(values.map(function (_, index) { return index; }));
                }
                scheduler.dispose();
            }
        ), { seed: 71001, numRuns: 30 });
    });
});

/**
 * Property 7: scheduler lanes are bounded and admit jobs in FIFO order.
 * **Validates: Requirements 2.10, 2.11, 2.16, 2.19, 2.31, 2.33**
 */

function flush() {
    // A macrotask boundary drains every pending scheduler microtask chain.
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function fakeChildProcess() {
    const listeners = {};
    const child = {
        killed: false,
        once: function (event, listener) {
            listeners[event] = (listeners[event] || []).concat([listener]);
            return child;
        },
        on: function (event, listener) { return child.once(event, listener); },
        removeListener: function (event, listener) {
            listeners[event] = (listeners[event] || []).filter(function (candidate) {
                return candidate !== listener;
            });
            return child;
        },
        kill: function () {
            child.killed = true;
            (listeners.close || []).slice(0).forEach(function (listener) { listener(0, null); });
            return true;
        }
    };
    return child;
}

const laneJobArbitrary = fc.record({
    lane: fc.constantFrom("filesystem", "thumbnail", "ffmpeg"),
    durationMs: fc.integer({ min: 0, max: 3 }),
    releaseProcessBeforeSettle: fc.boolean()
});

const laneWorkloadArbitrary = fc.array(laneJobArbitrary, { minLength: 1, maxLength: 8 })
    .chain(function (specs) {
        const indexes = specs.map(function (_, index) { return index; });
        return fc.record({
            specs: fc.constant(specs),
            completionOrder: fc.shuffledSubarray(indexes, {
                minLength: indexes.length,
                maxLength: indexes.length
            })
        });
    });

describe("Media lane concurrency bounds", function () {
    // Feature: media-engine-lag, Property 6: Scheduler lanes never exceed their limits
    // **Validates: Requirements 3.1, 3.2, 3.3**
    test("filesystem, thumbnail, and FFmpeg lanes never exceed their limits", async function () {
        await fc.assert(fc.asyncProperty(
            laneWorkloadArbitrary,
            fc.constantFrom(1, 2),
            async function (workload, thumbnailLimit) {
                const scheduler = schedulerModule.createScheduler(null, {
                    lanes: { thumbnail: thumbnailLimit }
                });
                const limits = { filesystem: 2, thumbnail: thumbnailLimit, ffmpeg: 1 };
                const active = { filesystem: 0, thumbnail: 0, ffmpeg: 0 };
                const peak = { filesystem: 0, thumbnail: 0, ffmpeg: 0 };
                const violations = [];
                const gates = workload.specs.map(function () { return deferred(); });
                const children = [];

                function observe() {
                    const snapshot = scheduler.snapshot();
                    Object.keys(limits).forEach(function (lane) {
                        const laneSnapshot = snapshot.lanes[lane];
                        if (laneSnapshot.active > limits[lane]) {
                            violations.push(lane + " snapshot active " + laneSnapshot.active);
                        }
                        if (active[lane] > limits[lane]) {
                            violations.push(lane + " observed active " + active[lane]);
                        }
                    });
                    if (snapshot.lanes.ffmpeg.processes > 1) {
                        violations.push("ffmpeg processes " + snapshot.lanes.ffmpeg.processes);
                    }
                    if (snapshot.processes > limits.ffmpeg + limits.filesystem + limits.thumbnail) {
                        violations.push("total processes " + snapshot.processes);
                    }
                }

                const handles = workload.specs.map(function (spec, index) {
                    return scheduler.enqueue(spec.lane, function (control) {
                        active[spec.lane] += 1;
                        peak[spec.lane] = Math.max(peak[spec.lane], active[spec.lane]);
                        observe();
                        let child = null;
                        if (spec.lane === "ffmpeg") {
                            child = control.registerChildProcess(fakeChildProcess());
                            children.push(child);
                            observe();
                        }
                        return wait(spec.durationMs).then(function () {
                            return gates[index].promise;
                        }).then(function () {
                            if (child && spec.releaseProcessBeforeSettle) control.releaseProcess(child);
                            active[spec.lane] -= 1;
                            return index;
                        });
                    });
                });

                await flush();
                observe();

                for (const index of workload.completionOrder) {
                    gates[index].resolve();
                    await flush();
                    observe();
                }

                await Promise.all(handles.map(function (handle) { return handle.promise; }));
                await scheduler.drain("filesystem");
                await scheduler.drain("thumbnail");
                await scheduler.drain("ffmpeg");
                await flush();

                const finalSnapshot = scheduler.snapshot();
                scheduler.dispose();

                expect(violations).toEqual([]);
                expect(peak.filesystem).toBeLessThanOrEqual(2);
                expect(peak.thumbnail).toBeLessThanOrEqual(thumbnailLimit);
                expect(peak.ffmpeg).toBeLessThanOrEqual(1);
                expect(finalSnapshot.lanes.thumbnail.limit).toBe(thumbnailLimit);
                expect(finalSnapshot.active).toBe(0);
                expect(finalSnapshot.pending).toBe(0);
                expect(finalSnapshot.processes).toBe(0);
                expect(children.length).toBe(workload.specs.filter(function (spec) {
                    return spec.lane === "ffmpeg";
                }).length);
            }
        ), { numRuns: 100, seed: 71006 });
    }, 60000);
});

const STAGE_LANES = { copy: "filesystem", thumbnail: "thumbnail", ffmpeg: "ffmpeg" };

function applyPathVariant(basePath, variant) {
    if (variant === "backslash") return basePath.replace(/\//g, "\\");
    if (variant === "trailing-slash") return basePath + "/";
    if (variant === "trailing-backslash") return basePath.replace(/\//g, "\\") + "\\";
    return basePath;
}

function createTimerHarness() {
    const timers = {};
    let nextTimerId = 1;
    return {
        setTimeout: function (callback, delayMs) {
            const id = nextTimerId++;
            timers[id] = { callback: callback, delayMs: Number(delayMs) || 0, order: id };
            return id;
        },
        clearTimeout: function (id) { delete timers[id]; },
        // Only short deferral timers are fired; long FFmpeg watchdogs stay pending.
        fireShortTimers: function (maxDelayMs) {
            const due = Object.keys(timers).map(function (id) { return timers[id]; })
                .filter(function (timer) { return timer.delayMs <= maxDelayMs; })
                .sort(function (a, b) { return (a.delayMs - b.delayMs) || (a.order - b.order); });
            due.forEach(function (timer) { delete timers[timer.order]; });
            due.forEach(function (timer) { timer.callback(); });
            return due.length;
        }
    };
}

const keyedRequestArbitrary = fc.record({
    stage: fc.constantFrom("copy", "thumbnail", "ffmpeg"),
    mediaId: fc.constantFrom("media-1", "media-2", "media-3"),
    basePath: fc.constantFrom("C:/media/one.mov", "C:/media/two.png", "D:/clips/three.mp4"),
    pathVariant: fc.constantFrom("plain", "backslash", "trailing-slash", "trailing-backslash"),
    deferredRequest: fc.boolean(),
    delayMs: fc.integer({ min: 0, max: 5 })
});

describe("Keyed scheduler operations", function () {
    // Feature: media-engine-lag, Property 7: Scheduler operation and timer keys are unique
    // **Validates: Requirements 3.4, 3.8**
    test("duplicate stage/id/path requests share one canonical handle, operation, and timer", async function () {
        await fc.assert(fc.asyncProperty(
            fc.array(keyedRequestArbitrary, { minLength: 1, maxLength: 10 }),
            fc.constantFrom(1, 2),
            async function (requests, thumbnailLimit) {
                const timerHarness = createTimerHarness();
                const scheduler = schedulerModule.createScheduler(null, {
                    lanes: { thumbnail: thumbnailLimit },
                    ffmpegTimeoutMs: 600000,
                    setTimeout: timerHarness.setTimeout,
                    clearTimeout: timerHarness.clearTimeout
                });
                const limits = { filesystem: 2, thumbnail: thumbnailLimit, ffmpeg: 1 };
                const gates = {};
                const executions = {};
                const startOrder = { filesystem: [], thumbnail: [], ffmpeg: [] };
                const canonical = {};
                const canonicalOrder = { filesystem: [], thumbnail: [], ffmpeg: [] };
                const deferredKeysByLane = { filesystem: 0, thumbnail: 0, ffmpeg: 0 };
                const handles = [];

                requests.forEach(function (request) {
                    const lane = STAGE_LANES[request.stage];
                    const expectedKey = request.stage + "|" + request.mediaId + "|" + request.basePath;
                    const sourcePath = applyPathVariant(request.basePath, request.pathVariant);
                    if (!gates[expectedKey]) gates[expectedKey] = deferred();
                    if (executions[expectedKey] === undefined) executions[expectedKey] = 0;

                    const job = function () {
                        executions[expectedKey] += 1;
                        startOrder[lane].push(expectedKey);
                        return gates[expectedKey].promise;
                    };
                    const options = {
                        stage: request.stage,
                        mediaId: request.mediaId,
                        sourcePath: sourcePath
                    };
                    const handle = request.deferredRequest ?
                        scheduler.defer(lane, request.delayMs, job, options) :
                        scheduler.enqueue(lane, job, options);

                    if (!canonical[expectedKey]) {
                        canonical[expectedKey] = { handle: handle, lane: lane, deferred: request.deferredRequest };
                        if (request.deferredRequest) deferredKeysByLane[lane] += 1;
                        else canonicalOrder[lane].push(expectedKey);
                    }
                    // Every request sharing the key must receive the canonical handle.
                    expect(handle).toBe(canonical[expectedKey].handle);
                    expect(handle.key).toBe(expectedKey);
                    expect(handle.lane).toBe(lane);
                    handles.push(handle);
                });

                const distinctKeys = Object.keys(canonical);
                const distinctHandleIds = {};
                handles.forEach(function (handle) { distinctHandleIds[handle.id] = true; });
                expect(Object.keys(distinctHandleIds).length).toBe(distinctKeys.length);

                await flush();

                const beforeTimers = scheduler.snapshot();
                let liveOperations = 0;
                Object.keys(limits).forEach(function (lane) {
                    const laneSnapshot = beforeTimers.lanes[lane];
                    liveOperations += laneSnapshot.active + laneSnapshot.pending;
                    expect(laneSnapshot.active).toBeLessThanOrEqual(limits[lane]);
                    // At most one owned timer per key means exactly one per deferred canonical key.
                    expect(laneSnapshot.deferred).toBe(deferredKeysByLane[lane]);
                    expect(laneSnapshot.timers).toBe(deferredKeysByLane[lane]);
                    // FIFO admission for distinct keys: starts follow submission order.
                    expect(startOrder[lane]).toEqual(
                        canonicalOrder[lane].slice(0, startOrder[lane].length)
                    );
                });
                expect(liveOperations).toBe(distinctKeys.length);

                timerHarness.fireShortTimers(50);
                await flush();

                const afterTimers = scheduler.snapshot();
                let operationsAfterTimers = 0;
                Object.keys(limits).forEach(function (lane) {
                    operationsAfterTimers += afterTimers.lanes[lane].active + afterTimers.lanes[lane].pending;
                    expect(afterTimers.lanes[lane].active).toBeLessThanOrEqual(limits[lane]);
                    expect(afterTimers.lanes[lane].deferred).toBe(0);
                });
                expect(operationsAfterTimers).toBe(distinctKeys.length);

                distinctKeys.forEach(function (key) { gates[key].resolve(); });
                await Promise.all(handles.map(function (handle) { return handle.promise; }));
                await scheduler.drain("filesystem");
                await scheduler.drain("thumbnail");
                await scheduler.drain("ffmpeg");
                await flush();

                const finalSnapshot = scheduler.snapshot();
                scheduler.dispose();

                distinctKeys.forEach(function (key) { expect(executions[key]).toBe(1); });
                expect(finalSnapshot.active).toBe(0);
                expect(finalSnapshot.pending).toBe(0);
                expect(finalSnapshot.timers).toBe(0);
            }
        ), { numRuns: 100, seed: 71007 });
    }, 60000);
});

function controllableGate() {
    let resolve, reject;
    const promise = new Promise(function (settle, fail) { resolve = settle; reject = fail; });
    return { promise: promise, resolve: resolve, reject: reject };
}

// Injected timer harness: FFmpeg watchdogs stay pending until the test fires them explicitly.
function createFfmpegTimerHarness() {
    const timers = {};
    let nextTimerId = 1;
    return {
        setTimeout: function (callback, delayMs) {
            const id = nextTimerId++;
            timers[id] = { id: id, callback: callback, delayMs: Number(delayMs) || 0 };
            return id;
        },
        clearTimeout: function (id) { delete timers[id]; },
        delaysAtLeast: function (minDelayMs) {
            return Object.keys(timers).map(function (id) { return timers[id].delayMs; })
                .filter(function (delayMs) { return delayMs >= minDelayMs; });
        },
        fireTimersAtLeast: function (minDelayMs) {
            const due = Object.keys(timers).map(function (id) { return timers[id]; })
                .filter(function (timer) { return timer.delayMs >= minDelayMs; })
                .sort(function (a, b) { return a.id - b.id; });
            due.forEach(function (timer) { delete timers[timer.id]; });
            due.forEach(function (timer) { timer.callback(); });
            return due.length;
        }
    };
}

// Fake child process that records termination, observed close, and handle detachment order.
function createFfmpegChild(index, events) {
    const listeners = {};
    const child = { index: index, killed: false, closed: false, detached: false, released: false };

    function markReleased(kind) {
        if (child.released) return;
        child.released = true;
        events.push({ kind: "release", index: index, via: kind });
    }

    child.once = function (event, listener) {
        listeners[event] = (listeners[event] || []).concat([listener]);
        return child;
    };
    child.on = function (event, listener) { return child.once(event, listener); };
    child.removeListener = function (event, listener) {
        listeners[event] = (listeners[event] || []).filter(function (candidate) {
            return candidate !== listener;
        });
        const remaining = Object.keys(listeners).reduce(function (total, name) {
            return total + listeners[name].length;
        }, 0);
        if (remaining === 0) {
            child.detached = true;
            markReleased("detached");
        }
        return child;
    };
    child.emitClose = function (code) {
        if (child.closed) return;
        child.closed = true;
        (listeners.close || []).slice(0).forEach(function (listener) {
            listener(code === undefined ? 0 : code, null);
        });
        markReleased("closed");
    };
    child.kill = function () {
        child.killed = true;
        child.emitClose(0);
        markReleased("killed");
        return true;
    };
    return child;
}

const ffmpegOutcomeArbitrary = fc.record({
    outcome: fc.constantFrom("success", "error", "cancel", "timeout"),
    releaseMode: fc.constantFrom("explicit-release", "observed-close", "scheduler-cleanup")
});

describe("FFmpeg process ownership", function () {
    // Feature: media-engine-lag, Property 9: FFmpeg ownership is released before lane reuse
    // **Validates: Requirements 3.9, 3.11**
    test("success, error, cancellation, and 60-second timeout release the process before lane reuse", async function () {
        await fc.assert(fc.asyncProperty(
            fc.array(ffmpegOutcomeArbitrary, { minLength: 1, maxLength: 5 }),
            async function (specs) {
                const harness = createFfmpegTimerHarness();
                const scheduler = schedulerModule.createScheduler(null, {
                    setTimeout: harness.setTimeout,
                    clearTimeout: harness.clearTimeout
                });
                const events = [];
                const violations = [];
                const children = [];
                const gates = specs.map(function () { return controllableGate(); });
                let peakProcesses = 0;

                const handles = specs.map(function (spec, index) {
                    const handle = scheduler.enqueue("ffmpeg", function (control) {
                        events.push({ kind: "start", index: index });
                        const beforeStart = scheduler.snapshot();
                        if (beforeStart.lanes.ffmpeg.active !== 1) {
                            violations.push("lane active " + beforeStart.lanes.ffmpeg.active + " at start " + index);
                        }
                        // No earlier FFmpeg handle may still be owned when this job begins.
                        if (beforeStart.lanes.ffmpeg.processes !== 0) {
                            violations.push("owned process survived into start " + index);
                        }
                        children.forEach(function (previous) {
                            if (!previous.released) {
                                violations.push("child " + previous.index + " still owned at start " + index);
                            }
                        });

                        const child = createFfmpegChild(index, events);
                        children.push(child);
                        control.registerChildProcess(child);
                        const afterRegister = scheduler.snapshot();
                        peakProcesses = Math.max(peakProcesses, afterRegister.lanes.ffmpeg.processes);
                        if (afterRegister.lanes.ffmpeg.processes > 1) {
                            violations.push("ffmpeg processes " + afterRegister.lanes.ffmpeg.processes);
                        }

                        function applyRelease() {
                            if (spec.releaseMode === "observed-close") child.emitClose(0);
                            else if (spec.releaseMode === "explicit-release") control.releaseProcess(child);
                        }
                        return gates[index].promise.then(function (value) {
                            applyRelease();
                            return value;
                        }, function (error) {
                            applyRelease();
                            throw error;
                        });
                    }, {
                        stage: "ffmpeg",
                        mediaId: "media-" + index,
                        sourcePath: "C:/media/clip-" + index + ".mov"
                    });
                    handle.promise.then(function () { return null; }, function () { return null; });
                    return handle;
                });

                for (let index = 0; index < specs.length; index++) {
                    await flush();
                    const activeSnapshot = scheduler.snapshot();
                    if (activeSnapshot.lanes.ffmpeg.active !== 1) {
                        violations.push("no single active ffmpeg job for " + index);
                    }
                    if (activeSnapshot.lanes.ffmpeg.processes !== 1) {
                        violations.push("job " + index + " owns " + activeSnapshot.lanes.ffmpeg.processes + " processes");
                    }
                    const watchdogs = harness.delaysAtLeast(1000);
                    if (watchdogs.length !== 1 || watchdogs[0] !== 60000) {
                        violations.push("watchdog delays [" + watchdogs.join(",") + "] for " + index);
                    }

                    const spec = specs[index];
                    if (spec.outcome === "success") gates[index].resolve("ok-" + index);
                    else if (spec.outcome === "error") gates[index].reject(new Error("ffmpeg failed " + index));
                    else if (spec.outcome === "cancel") handles[index].cancel("cancelled");
                    else harness.fireTimersAtLeast(60000);

                    await flush();
                    const child = children[index];
                    if (!child.released) violations.push("child " + index + " unreleased after " + spec.outcome);
                    if (spec.outcome === "cancel" || spec.outcome === "timeout") {
                        if (!child.killed && !child.closed) {
                            violations.push("child " + index + " not terminated after " + spec.outcome);
                        }
                    }
                    const afterSnapshot = scheduler.snapshot();
                    // Only a successor job admitted after this release may still own a handle.
                    const outstanding = children.filter(function (candidate) {
                        return !candidate.released;
                    }).length;
                    if (afterSnapshot.lanes.ffmpeg.processes !== outstanding) {
                        violations.push("owned " + afterSnapshot.lanes.ffmpeg.processes +
                            " vs outstanding " + outstanding + " after " + spec.outcome + " " + index);
                    }
                    if (afterSnapshot.lanes.ffmpeg.processes > 1) {
                        violations.push("multiple owned processes after " + spec.outcome + " " + index);
                    }
                }

                gates.forEach(function (gate, index) { gate.resolve("drained-" + index); });
                await Promise.all(handles.map(function (handle) {
                    return handle.promise.then(function () { return null; }, function () { return null; });
                }));
                await scheduler.drain("ffmpeg");
                await flush();

                const finalSnapshot = scheduler.snapshot();
                scheduler.dispose();

                expect(violations).toEqual([]);
                // Exactly one release between consecutive starts: ownership never overlaps a reuse.
                expect(events.map(function (event) { return event.kind; })).toEqual(
                    specs.reduce(function (kinds) { return kinds.concat(["start", "release"]); }, [])
                );
                expect(events.map(function (event) { return event.index; })).toEqual(
                    specs.reduce(function (indexes, _, index) { return indexes.concat([index, index]); }, [])
                );
                expect(peakProcesses).toBeLessThanOrEqual(1);
                expect(children.length).toBe(specs.length);
                children.forEach(function (child) { expect(child.released).toBe(true); });
                expect(finalSnapshot.lanes.ffmpeg.active).toBe(0);
                expect(finalSnapshot.lanes.ffmpeg.pending).toBe(0);
                expect(finalSnapshot.lanes.ffmpeg.processes).toBe(0);
                expect(finalSnapshot.processes).toBe(0);
            }
        ), { numRuns: 100, seed: 71009 });
    }, 120000);
});
