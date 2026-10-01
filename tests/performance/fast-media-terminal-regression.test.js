"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_FILE = path.join(ROOT, "js/core/fastMediaEngine.js");

function streamFs(events) {
    const promises = {
        mkdir: async function (target) { events.push(["mkdir", target]); },
        copyFile: async function (from, to) { events.push(["thumbnail", from, to]); },
        writeFile: async function (target) { events.push(["write", target]); },
    };
    return {
        promises,
        createReadStream: function (source) {
            return {
                on: function () { return this; },
                pipe: function (writer) {
                    events.push(["copy", source, writer.target]);
                    Promise.resolve().then(function () { writer.close(); });
                },
                destroy: function () { },
            };
        },
        createWriteStream: function (target) {
            return {
                target,
                close: function () { },
                on: function (event, handler) {
                    if (event === "close") this.close = handler;
                    return this;
                },
            };
        },
        statSync: function () { return { size: 4096 }; },
        existsSync: function () { return true; },
    };
}

function cardFor(schedule, events) {
    if (!schedule.cardPresent) return null;
    return {
        classList: { remove: function (name) { events.push(["class-remove", name]); } },
        setAttribute: function (name, value) { events.push(["attribute", name, value]); },
        querySelector: function () { return null; },
    };
}
function loadProcessBoundary(schedule, events, failures) {
    let source = fs.readFileSync(SOURCE_FILE, "utf8");
    const expose = "\nwindow.__phase1ProcessBackgroundCopy = processBackgroundCopy;\n";
    source = source.replace(/\}\)\(window, document\);\s*$/, expose + "})(window, document);");
    const fakeFs = streamFs(events);
    let clock = 0;
    const card = cardFor(schedule, events);
    const context = {
        window: {
            rootPath: "C:/isolated-library",
            MetadataCache: schedule.metadataCache ? {} : undefined,
            saveLibraryIndex: schedule.saveIndex ? function () { events.push(["save-index"]); } : undefined,
            addEventListener: function () { },
        },
        document: {
            getElementById: function () { return card; },
            querySelector: function () { return null; },
            createElement: function () { throw new Error("image success schedule must not create media elements"); },
        },
        performance: { now: function () { clock += 5; return clock; } },
        console: {
            log: function () { }, warn: function () { },
            error: function () { failures.push(Array.prototype.join.call(arguments, " ")); },
        },
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        showToast: function (message, kind) {
            events.push(["toast", kind, message]);
            if (kind === "error") failures.push(message);
        },
        getLibraryIndex: schedule.libraryIndex ? function () {
            return { insertAtHead: function () { events.push(["index-insert"]); } };
        } : function () { return null; },
        saveLibraryIndex: schedule.saveIndex ? function () { events.push(["save-index-global"]); } : undefined,
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, Date, Image: function () { }, btoa: function () { return ""; },
        unescape: function (value) { return value; }, encodeURIComponent,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "fastMediaEngine.js" });
    if (typeof context.window.__phase1ProcessBackgroundCopy !== "function") {
        throw new Error("Fast Media processing boundary was not exposed by the test harness");
    }
    return context.window.__phase1ProcessBackgroundCopy;
}

async function observeSuccessfulSchedule(schedule) {
    const events = [];
    const failures = [];
    const processBackgroundCopy = loadProcessBoundary(schedule, events, failures);
    const meta = {
        id: "media-1", name: "Still", category: "Imported", section: "footage",
        createdAt: "2025-01-01T00:00:00.000Z", _isPending: true,
    };
    await processBackgroundCopy(meta, "C:/source/still.png", "Imported", "still.png", false, ".png", "Still");
    const wroteMetadata = events.some(function (event) {
        return event[0] === "write" && /meta\.json$/i.test(event[1].replace(/\\/g, "/"));
    });
    return {
        schedule,
        committed: wroteMetadata && meta._isPending === false,
        terminalOutcomes: failures.length ? ["committed", "failed"] : ["committed"],
        falseFailure: failures.length > 0,
        failures,
        events,
        runtimeBoundary: "processBackgroundCopy completed copy, thumbnail, metadata, and state mutation",
    };
}
function assertSuccessfulTerminal(result) {
    const passes = result.committed && !result.falseFailure && result.terminalOutcomes.length === 1;
    if (!passes) {
        throw new Error("PHASE_1_FAST_MEDIA_COUNTEREXAMPLE\n" + JSON.stringify(result, null, 2));
    }
}

const successScheduleArbitrary = fc.record({
    metadataCache: fc.boolean(),
    saveIndex: fc.boolean(),
    libraryIndex: fc.boolean(),
    cardPresent: fc.boolean(),
});

describe("Phase 1 Fast Media success terminal behavior", function () {
    test("success schedules vary every optional post-copy integration", function () {
        const sample = fc.sample(successScheduleArbitrary, { seed: 52001, numRuns: 16 });
        ["metadataCache", "saveIndex", "libraryIndex", "cardPresent"].forEach(function (key) {
            expect(new Set(sample.map(function (entry) { return entry[key]; }))).toEqual(new Set([false, true]));
        });
    });

    test("successful processBackgroundCopy never falls through to failure", async function () {
        await fc.assert(fc.asyncProperty(successScheduleArbitrary, async function (schedule) {
            assertSuccessfulTerminal(await observeSuccessfulSchedule(schedule));
        }), { seed: 52002, numRuns: 30, verbose: 2 });
    });
});

/**
 * Property 1: a completed Fast Media copy has one successful terminal outcome.
 * **Validates: Requirements 1.6, 1.8, 1.10, 1.13–1.16, 2.16, 2.19, 2.31, 2.33**
 */
// ---------------------------------------------------------------------------
// Property 8 harness
// ---------------------------------------------------------------------------
// What is under test
// ------------------
// The REAL MediaWorkCoordinator from js/core/fastMediaEngine.js driving the REAL
// scheduler from js/core/scheduler.js. Only the three stage workers (copy,
// thumbnail/decode, FFmpeg), the repository, and the keyed card helper are fakes,
// so every ledger transition, compare-and-set terminal assignment, stale-callback
// guard, and idle check below is production code.

const schedulerModule = require(path.resolve(ROOT, "js/core/scheduler.js"));
const ENGINE_SCRIPT = new vm.Script(fs.readFileSync(SOURCE_FILE, "utf8"), { filename: "fastMediaEngine.js" });
const TERMINAL_STAGES = ["copy", "thumbnail", "ffmpeg", "completion"];

function inertFilesystem() {
    function unexpected() { throw new Error("Property 8 uses injected stage workers, not real filesystem work"); }
    return {
        promises: {
            mkdir: async function () { return undefined; },
            stat: async function () { return { size: 0 }; },
            unlink: async function () { return undefined; },
            writeFile: async function () { return undefined; },
            copyFile: async function () { return undefined; },
        },
        createReadStream: unexpected,
        createWriteStream: unexpected,
        existsSync: function () { return false; },
        statSync: function () { return { size: 0 }; },
    };
}

function loadCoordinatorEngine() {
    const context = {
        window: {
            rootPath: "C:/library",
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function () { throw new Error("terminal settlement must not create media elements"); },
        },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return inertFilesystem();
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
        Promise, Date, Buffer,
        Image: function () { },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent,
    };
    context.window.window = context.window;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.MediaWorkCoordinator !== "function") {
        throw new Error("MediaWorkCoordinator was not exposed by the media engine");
    }
    return context.window;
}

function createTimerRegistry() {
    const live = {};
    let next = 1;
    return {
        active: function () { return Object.keys(live).length; },
        set: function (callback, delay) {
            const id = next++;
            const token = { id: id };
            token.handle = setTimeout(function () { delete live[id]; callback(); }, delay);
            live[id] = token.handle;
            return token;
        },
        clear: function (token) {
            if (!token) return;
            clearTimeout(token.handle);
            delete live[token.id];
        },
        disposeAll: function () {
            Object.keys(live).forEach(function (id) { clearTimeout(live[id]); delete live[id]; });
        },
    };
}

function ticked(count, executor) {
    let chain = Promise.resolve();
    for (let i = 0; i < count; i++) chain = chain.then(function () { return null; });
    return chain.then(executor);
}

function flushTicks(count) {
    let chain = Promise.resolve();
    for (let i = 0; i < count; i++) {
        chain = chain.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
    }
    return chain;
}

function routesToFfmpeg(plan) {
    return plan.isVideo && (plan.thumbnail === "needs-ffmpeg" || plan.thumbnail === "unavailable-needs-ffmpeg");
}

// Reference model for the desired derivative outcome of a stage plan.
function desiredOutcome(plan) {
    if (plan.copy !== "ok") return "failed";
    if (!routesToFfmpeg(plan)) {
        return plan.thumbnail === "ok" || plan.thumbnail === "needs-ffmpeg" ? "available" : "derivative-unavailable";
    }
    if (plan.ffmpeg === "ok") return "available";
    if (plan.ffmpeg === "ok-no-thumbnail" && plan.thumbnail === "needs-ffmpeg") return "available";
    return "derivative-unavailable";
}

function expectedTerminal(plan, cancelled) {
    if (cancelled) return "failed";
    if (desiredOutcome(plan) === "failed") return "failed";
    return plan.commit === "ok" ? "ready" : "failed";
}

function expectedDerivativeStatus(plan, cancelled) {
    if (cancelled) return "cancelled";
    const desired = desiredOutcome(plan);
    if (desired === "failed") return "failed";
    return desired === "derivative-unavailable" ? "derivative-unavailable" : "available";
}

function expectedThumbStatus(plan, cancelled) {
    if (cancelled || plan.copy !== "ok") return "failed";
    if (routesToFfmpeg(plan) && plan.ffmpeg === "ok") return "ready";
    return plan.thumbnail === "ok" || plan.thumbnail === "needs-ffmpeg" ? "ready" : "failed";
}

// Completed stage results that must survive a later failure.
function expectedResults(plan, cancelled) {
    if (cancelled || plan.copy !== "ok") return "";
    const keys = ["copy"];
    if (plan.thumbnail !== "error") keys.push("thumbnail");
    if (routesToFfmpeg(plan) && plan.ffmpeg !== "error") keys.push("ffmpeg");
    return keys.sort().join(",");
}

function buildTerminalItems(plans) {
    return plans.map(function (plan, index) {
        const id = "media-terminal-" + index;
        const ext = plan.isVideo ? ".mp4" : ".png";
        const folder = "C:/library/footage/" + id;
        return {
            id: id,
            sourcePath: "C:/originals/" + id + ext,
            fileName: id + ext,
            safeName: id,
            isVideo: plan.isVideo,
            destinationFolder: folder,
            destinationMedia: folder + "/" + id + ext,
            destinationThumbnail: folder + "/thumb.jpg",
        };
    });
}

function observeBatch(coordinator, batchId, cards, repository, terminals, timers) {
    const snapshot = coordinator.snapshot(batchId);
    return {
        idle: snapshot.idle,
        pendingCount: snapshot.pendingCount,
        inFlightCount: snapshot.inFlightCount,
        terminalCount: snapshot.terminalCount,
        timerCount: snapshot.timerCount,
        liveTimers: timers.active(),
        items: snapshot.items.map(function (item) {
            return {
                id: item.id,
                terminalState: item.terminalState,
                processingState: item.processingState,
                results: Object.keys(item.completedResults).sort().join(","),
                stages: TERMINAL_STAGES.map(function (stage) { return stage + "=" + item.stages[stage].state; }).join("|"),
            };
        }),
        cardPatches: cards.patches.map(function (entry) {
            return [entry.id, entry.patch.terminalState, entry.patch.derivativeStatus,
            entry.patch.thumbStatus, String(entry.patch._isPending)].join(":");
        }),
        commits: repository.commits.map(function (entry) { return entry.id; }),
        store: JSON.stringify(repository.store),
        terminals: terminals.slice(),
    };
}

// Requirement 3.7: zero queued, active, and timer-backed jobs implies zero pending items.
function idleImplicationViolation(observation) {
    if (observation.pendingCount || observation.inFlightCount || observation.timerCount || observation.liveTimers) return null;
    const pending = observation.items.filter(function (item) { return item.terminalState === "pending"; });
    if (!pending.length) return null;
    return "batch reported zero jobs and timers while " + pending.length + " item(s) remained pending";
}

async function waitForOtherItems(coordinator, batchId, heldId, observe, violations, limit) {
    for (let attempt = 0; attempt < limit; attempt++) {
        const observation = observe();
        const violation = idleImplicationViolation(observation);
        if (violation) violations.push(violation);
        const others = observation.items.filter(function (item) { return item.id !== heldId; });
        const settled = others.every(function (item) { return item.terminalState !== "pending"; });
        if (settled) return true;
        await new Promise(function (resolve) { setImmediate(resolve); });
    }
    return false;
}

async function runTerminalSettlement(scenario) {
    const plans = scenario.items;
    const items = buildTerminalItems(plans);
    const byId = {};
    items.forEach(function (item, index) { byId[item.id] = plans[index]; });

    const heldIndex = scenario.staleIndex >= 0 && scenario.staleIndex < items.length ? scenario.staleIndex : -1;
    let held = null;
    if (heldIndex >= 0) {
        held = { id: items[heldIndex].id, resolve: null, settled: false };
        held.promise = new Promise(function (resolve) { held.resolve = resolve; });
    }

    const timers = createTimerRegistry();
    const cards = { patches: [] };
    cards.patchById = function (id, patch) { cards.patches.push({ id: id, patch: patch }); return true; };

    const repository = { store: {}, commits: [] };
    items.forEach(function (item) {
        repository.store[item.id] = {
            id: item.id, name: item.safeName, category: "Imported",
            sourcePath: item.sourcePath, _isPending: true,
        };
    });
    repository.patchById = function (id, fields) {
        const plan = byId[id];
        repository.commits.push({ id: id, fields: fields });
        if (plan.commit === "reject") return Promise.reject(new Error("commit rejected for " + id));
        if (plan.commit === "not-ok") return Promise.resolve({ ok: false, error: "commit refused for " + id });
        const entry = repository.store[id];
        Object.keys(fields).forEach(function (key) { entry[key] = fields[key]; });
        return Promise.resolve({ ok: true });
    };

    const scheduler = schedulerModule.createScheduler({ thumbnail: 2 });
    const engine = loadCoordinatorEngine();
    const terminals = [];
    const coordinator = new engine.MediaWorkCoordinator({
        scheduler: scheduler,
        repository: repository,
        cardHelper: cards,
        setTimeout: timers.set,
        clearTimeout: timers.clear,
        progressIntervalMs: 5,
        onTerminal: function (item, terminal) { terminals.push(item.id + ":" + terminal); },
        workers: {
            copy: function (item) {
                const plan = byId[item.id];
                if (held && item.id === held.id) return held.promise;
                return ticked(plan.copyTicks, function () {
                    if (plan.copy === "error") throw new Error("copy failed for " + item.id);
                    if (plan.copy === "cancelled") return { cancelled: true, reason: "copy cancelled" };
                    return { ok: true, fileSize: 1024 };
                });
            },
            thumbnail: function (item) {
                const plan = byId[item.id];
                return ticked(plan.thumbnailTicks, function () {
                    if (plan.thumbnail === "error") throw new Error("thumbnail failed for " + item.id);
                    if (plan.thumbnail === "unavailable") {
                        return { ok: false, status: "derivative-unavailable", reason: "decode-failed" };
                    }
                    if (plan.thumbnail === "unavailable-needs-ffmpeg") {
                        return { ok: false, status: "derivative-unavailable", reason: "decode-failed", needsFfmpeg: true };
                    }
                    if (plan.thumbnail === "needs-ffmpeg") {
                        return { ok: true, path: item.destinationThumbnail, status: "available", needsFfmpeg: true };
                    }
                    return { ok: true, path: item.destinationThumbnail, status: "available" };
                });
            },
            ffmpeg: function (item) {
                const plan = byId[item.id];
                return ticked(plan.ffmpegTicks, function () {
                    if (plan.ffmpeg === "error") throw new Error("ffmpeg failed for " + item.id);
                    if (plan.ffmpeg === "unavailable") {
                        return { ok: false, status: "derivative-unavailable", reason: "ffmpeg-unavailable" };
                    }
                    if (plan.ffmpeg === "ok-no-thumbnail") return { ok: true, proxyPath: item.destinationFolder + "/proxy.mp4" };
                    return {
                        ok: true,
                        thumbnailPath: item.destinationFolder + "/ffmpeg-thumb.jpg",
                        proxyPath: item.destinationFolder + "/proxy.mp4",
                    };
                });
            },
        },
    });

    const batchId = "terminal-batch";
    const violations = [];
    function observe() { return observeBatch(coordinator, batchId, cards, repository, terminals, timers); }

    try {
        const settled = coordinator.submitBatch({ id: batchId, items: items });
        if (held) {
            const ready = await waitForOtherItems(coordinator, batchId, held.id, observe, violations, 600);
            if (!ready) throw new Error("non-held items never settled");
            coordinator.cancelBatch(batchId, "panel disposal");
        }
        const idleSnapshot = await settled;
        const afterIdle = observe();
        const idleViolation = idleImplicationViolation(afterIdle);
        if (idleViolation) violations.push(idleViolation);

        // Late worker delivery for a cancelled item: the callback is stale by token.
        if (held) {
            held.settled = true;
            held.resolve({ ok: true, fileSize: 2048 });
            await flushTicks(8);
        }

        // Stale stage and completion callbacks replayed through the real entry points.
        const internal = coordinator._batches["$" + batchId];
        const staleReplay = [];
        items.forEach(function (item) {
            staleReplay.push(coordinator._afterStage(internal, item, "copy", item.token - 1, new Error("stale copy"), null));
            staleReplay.push(coordinator._afterStage(internal, item, "thumbnail", item.token, null, { ok: true, path: "stale-thumb" }));
            staleReplay.push(coordinator._afterStage(internal, item, "ffmpeg", item.token + 5, null, { ok: false }));
            staleReplay.push(coordinator._complete(item, internal, "failed", "stale completion"));
        });
        await flushTicks(6);
        const afterStale = observe();

        await scheduler.drain("filesystem");
        await scheduler.drain("thumbnail");
        await scheduler.drain("ffmpeg");
        const lanes = scheduler.snapshot().lanes;

        return {
            plans: plans, items: items, heldId: held ? held.id : null,
            idleSnapshotId: idleSnapshot ? idleSnapshot.id : null,
            afterIdle: afterIdle, afterStale: afterStale,
            staleReplay: staleReplay, violations: violations, lanes: lanes,
        };
    } finally {
        if (held && !held.settled) held.resolve({ cancelled: true, reason: "harness teardown" });
        coordinator.dispose("test complete");
        scheduler.dispose();
        timers.disposeAll();
    }
}

function assertTerminalSettlement(run) {
    const afterIdle = run.afterIdle;

    // Requirement 3.7: an idle batch has zero jobs, zero timers, and zero pending items.
    expect(run.violations).toEqual([]);
    expect(run.idleSnapshotId).toBe("terminal-batch");
    expect(afterIdle.idle).toBe(true);
    expect(afterIdle.pendingCount).toBe(0);
    expect(afterIdle.inFlightCount).toBe(0);
    expect(afterIdle.timerCount).toBe(0);
    expect(afterIdle.liveTimers).toBe(0);
    expect(afterIdle.terminalCount).toBe(run.items.length);
    expect(afterIdle.items.filter(function (item) { return item.terminalState === "pending"; })).toEqual([]);
    ["filesystem", "thumbnail", "ffmpeg"].forEach(function (lane) {
        expect(run.lanes[lane].active).toBe(0);
        expect(run.lanes[lane].pending).toBe(0);
    });

    run.items.forEach(function (item, index) {
        const plan = run.plans[index];
        const cancelled = run.heldId === item.id;
        const terminal = expectedTerminal(plan, cancelled);
        const observed = afterIdle.items[index];

        // Requirements 3.5 and 3.6: exactly one terminal transition, ready or visibly failed.
        expect(observed.terminalState).toBe(terminal);
        expect(observed.processingState).toBe(terminal);
        const notifications = afterIdle.terminals.filter(function (entry) { return entry.split(":")[0] === item.id; });
        // Batch cancellation settles the item and repaints its card without a work-completion
        // notification, so the observability hook is checked for at-most-once there and for
        // exactly-once on every stage-driven settlement.
        expect(notifications).toEqual(cancelled ? notifications.slice(0, 1) : [item.id + ":" + terminal]);
        notifications.forEach(function (entry) { expect(entry).toBe(item.id + ":" + terminal); });

        const patches = afterIdle.cardPatches.filter(function (entry) { return entry.split(":")[0] === item.id; });
        expect(patches).toEqual([[item.id, terminal, expectedDerivativeStatus(plan, cancelled),
        expectedThumbStatus(plan, cancelled), "false"].join(":")]);

        // Requirement 3.12: completed results and the committed entry survive a later failure.
        expect(observed.results).toBe(expectedResults(plan, cancelled));
        const entry = JSON.parse(afterIdle.store)[item.id];
        expect(entry).toBeTruthy();
        expect(entry.id).toBe(item.id);
        expect(entry.name).toBe(item.safeName);
        expect(entry.category).toBe("Imported");
        expect(entry.sourcePath).toBe(item.sourcePath);
        expect(afterIdle.commits.filter(function (id) { return id === item.id; }).length).toBe(1);
        if (plan.commit === "ok") expect(entry._isPending).toBe(false);
    });

    // Requirements 3.5-3.6: stale stage and completion callbacks cannot move terminal state.
    expect(run.staleReplay.filter(function (value) { return value !== false; })).toEqual([]);
    expect(run.afterStale).toEqual(afterIdle);
}

const terminalStagePlanArbitrary = fc.record({
    isVideo: fc.boolean(),
    copy: fc.constantFrom("ok", "ok", "ok", "ok", "error", "cancelled"),
    thumbnail: fc.constantFrom("ok", "error", "unavailable", "needs-ffmpeg", "unavailable-needs-ffmpeg"),
    ffmpeg: fc.constantFrom("ok", "ok-no-thumbnail", "unavailable", "error"),
    commit: fc.constantFrom("ok", "ok", "ok", "not-ok", "reject"),
    copyTicks: fc.integer({ min: 0, max: 3 }),
    thumbnailTicks: fc.integer({ min: 0, max: 3 }),
    ffmpegTicks: fc.integer({ min: 0, max: 3 }),
});

const terminalScenarioArbitrary = fc.record({
    items: fc.array(terminalStagePlanArbitrary, { minLength: 1, maxLength: 4 }),
    staleIndex: fc.integer({ min: -1, max: 3 }),
});

describe("Property 8: media items settle exactly once and idle batches hold no pending work", function () {
    // Feature: media-engine-lag, Property 8: Every item settles exactly once and idle has no pending work
    // **Validates: Requirements 3.5, 3.6, 3.7, 3.12**
    test("every stage plan and callback order settles each item exactly once", async function () {
        await fc.assert(fc.asyncProperty(terminalScenarioArbitrary, async function (scenario) {
            assertTerminalSettlement(await runTerminalSettlement(scenario));
        }), { numRuns: 120, verbose: 2 });
    }, 120000);
});

// ---------------------------------------------------------------------------
// Property 23 harness
// ---------------------------------------------------------------------------
// What is under test
// ------------------
// The REAL MediaWorkCoordinator from js/core/fastMediaEngine.js running its own
// DEFAULT stage workers (`_defaultCopy`, `_defaultThumbnail`, `_defaultFfmpeg`,
// i.e. copyFileStream, extractVideoFrame + generateFallbackThumbnail and
// runFfmpegFallback/resolveFfmpegExecutable) on the REAL scheduler from
// js/core/scheduler.js, committing through the REAL MediaEntryRepository /
// LibraryIndex from js/core/persistence.js and repainting through the REAL
// KeyedMediaCardHelper from js/core/keyedMediaCardHelper.js over the REAL card
// markup (renderTemplateCardMarkup) parsed into a real DOM tree.
//
// Only three things are substituted, and each one is an observation point:
//   * the filesystem, so the copied original can be inspected byte-for-byte;
//   * the <video>/<canvas> decode surface, which does not exist under jest's
//     "node" environment (the HTML5 decode always fails here, which is exactly
//     the path that asks FFmpeg for a derivative);
//   * `child_process`, which records every spawn attempt so the property can
//     prove no FFmpeg process is created when the resolver is unavailable.
// `window.resolveFfmpeg` is always an unavailable resolver.

const { MediaEntryRepository } = require(path.resolve(ROOT, "js/core/persistence.js"));
const { KeyedMediaCardHelper } = require(path.resolve(ROOT, "js/core/keyedMediaCardHelper.js"));
const { loadHelpers: loadP23Helpers } = require(path.resolve(ROOT, "tests/helpers/loadHelpers.js"));
const { createMiniDocument } = require(path.resolve(ROOT, "tests/helpers/miniDom.js"));

const p23Constants = loadP23Helpers({ file: path.join("js", "core", "constants.js") });
const p23Utils = loadP23Helpers({
    file: path.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: p23Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p23Constants.get("IMAGE_SECTIONS"),
    },
});
const p23Templates = loadP23Helpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: p23Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p23Constants.get("IMAGE_SECTIONS"),
        escapeAttr: p23Utils.get("escapeAttr"),
        escapeHTML: p23Utils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
});
const renderP23CardMarkup = p23Templates.get("renderTemplateCardMarkup");
if (typeof renderP23CardMarkup !== "function") {
    throw new Error("Property 23 requires renderTemplateCardMarkup from js/templates/templates.js");
}

function p23Key(target) {
    return String(target).replace(/\\/g, "/").toLowerCase();
}

// A filesystem that actually stores bytes, so the copied original can be
// compared with the untouched source file after the import settles.
function p23Filesystem(state) {
    function record(target, bytes) {
        state.files[p23Key(target)] = { bytes: bytes, mtimeMs: state.clock++ };
        state.writes.push(p23Key(target));
    }
    return {
        promises: {
            mkdir: function (target) { state.dirs[p23Key(target)] = true; return Promise.resolve(); },
            stat: function (target) {
                const entry = state.files[p23Key(target)];
                if (!entry) return Promise.reject(new Error("ENOENT: " + target));
                return Promise.resolve({ size: entry.bytes.length, mtimeMs: entry.mtimeMs });
            },
            unlink: function (target) {
                state.unlinked.push(p23Key(target));
                delete state.files[p23Key(target)];
                return Promise.resolve();
            },
            writeFile: function (target, data) { record(target, String(data)); return Promise.resolve(); },
            copyFile: function (from, to) {
                const entry = state.files[p23Key(from)];
                if (!entry) return Promise.reject(new Error("ENOENT: " + from));
                record(to, entry.bytes);
                return Promise.resolve();
            },
        },
        createReadStream: function (source) {
            const stream = {
                handlers: {},
                on: function (event, handler) { stream.handlers[event] = handler; return stream; },
                destroy: function () { },
                pipe: function (writer) {
                    Promise.resolve().then(function () {
                        const entry = state.files[p23Key(source)];
                        if (!entry) {
                            if (stream.handlers.error) stream.handlers.error(new Error("ENOENT: " + source));
                            return;
                        }
                        writer.deliver(entry.bytes);
                    });
                },
            };
            return stream;
        },
        createWriteStream: function (target) {
            const writer = {
                target: target,
                handlers: {},
                on: function (event, handler) { writer.handlers[event] = handler; return writer; },
                destroy: function () { },
                deliver: function (bytes) {
                    record(target, bytes);
                    if (writer.handlers.close) writer.handlers.close();
                },
            };
            return writer;
        },
        existsSync: function (target) { return !!state.files[p23Key(target)]; },
        statSync: function (target) {
            const entry = state.files[p23Key(target)];
            return { size: entry ? entry.bytes.length : 0 };
        },
    };
}

// The HTML5 decode surface. Under jest's "node" environment there is no media
// decoder, so the video element always reports an error, which is the branch
// that routes a video to the FFmpeg lane.
function p23VideoElement(plan, state) {
    const listeners = {};
    function emit(name) {
        const list = (listeners[name] || []).slice();
        for (let i = 0; i < list.length; i++) list[i]();
    }
    const video = {
        muted: false, crossOrigin: "", currentTime: 0,
        duration: 12, videoWidth: 640, videoHeight: 360, parentNode: null,
        addEventListener: function (name, handler) {
            listeners[name] = listeners[name] || [];
            listeners[name].push(handler);
        },
        removeEventListener: function (name, handler) {
            const list = listeners[name] || [];
            const at = list.indexOf(handler);
            if (at !== -1) list.splice(at, 1);
        },
        pause: function () { state.videoReleases.push("pause"); },
        load: function () { state.videoReleases.push("load"); },
        removeAttribute: function (name) { state.videoReleases.push("remove:" + name); },
    };
    Object.defineProperty(video, "src", {
        configurable: true,
        get: function () { return state.videoSources[state.videoSources.length - 1] || ""; },
        set: function (value) {
            state.videoSources.push(value);
            Promise.resolve().then(function () {
                if (plan.decode === "loadeddata-then-error") emit("loadeddata");
                emit("error");
            });
        },
    });
    return video;
}

function p23CanvasElement(plan, state) {
    return {
        width: 0, height: 0,
        getContext: function (kind) {
            state.canvasContexts.push(kind);
            if (plan.canvas === "no-context") return null;
            return {
                fillStyle: "", font: "", textAlign: "",
                fillRect: function () { }, beginPath: function () { }, moveTo: function () { },
                lineTo: function () { }, closePath: function () { }, fill: function () { },
                fillText: function () { }, drawImage: function () { },
            };
        },
        toDataURL: function () {
            if (plan.canvas === "encode-error") throw new Error("canvas encoding unavailable");
            return "data:image/png;base64,UExBQ0VIT0xERVI=";
        },
    };
}

// Every resolver form below reports "no FFmpeg executable".
function p23InstallResolver(engineWindow, plan, state) {
    if (plan.resolver === "missing") return;
    engineWindow.resolveFfmpeg = function (callback) {
        state.resolverCalls++;
        if (plan.resolver === "throws") throw new Error("FFmpeg resolver unavailable");
        if (plan.resolver === "empty") { callback(""); return; }
        if (plan.resolver === "null") { callback(null); return; }
        if (plan.resolver === "false") { callback(false); return; }
        if (plan.resolver === "async-empty") { setTimeout(function () { callback(""); }, 0); return; }
        callback();
    };
}

function loadMissingFfmpegEngine(plan, state) {
    const filesystem = p23Filesystem(state);
    const context = {
        window: {
            rootPath: "C:/library",
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function (tag) {
                const name = String(tag).toLowerCase();
                if (name === "video") return p23VideoElement(plan, state);
                if (name === "canvas") return p23CanvasElement(plan, state);
                throw new Error("Property 23 does not expect a <" + name + "> element");
            },
        },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            state.requires.push(name);
            if (name === "fs") return filesystem;
            if (name === "path") return path;
            if (name === "child_process") {
                return {
                    execFile: function (executable, args) {
                        state.spawns.push({ api: "execFile", executable: executable, args: args });
                        throw new Error("Property 23 forbids FFmpeg execution");
                    },
                    spawn: function (executable, args) {
                        state.spawns.push({ api: "spawn", executable: executable, args: args });
                        throw new Error("Property 23 forbids FFmpeg execution");
                    },
                };
            }
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
        Promise, Date, Buffer,
        Image: function () { throw new Error("Property 23 imports videos only"); },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent, encodeURI,
    };
    context.window.window = context.window;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.MediaWorkCoordinator !== "function") {
        throw new Error("MediaWorkCoordinator was not exposed by the media engine");
    }
    p23InstallResolver(context.window, plan, state);
    return context.window;
}

function buildMissingFfmpegItems(plan, state) {
    return plan.items.map(function (itemPlan, index) {
        const id = "media-p23-" + index;
        const folder = "C:/library/footage/" + id;
        const item = {
            id: id,
            sourcePath: "C:/originals/" + id + ".mp4",
            fileName: id + ".mp4",
            safeName: id,
            isVideo: true,
            destinationFolder: folder,
            destinationMedia: folder + "/" + id + ".mp4",
            destinationThumbnail: folder + "/thumbnail.png",
            displayName: itemPlan.name,
            categoryName: itemPlan.category,
        };
        state.files[p23Key(item.sourcePath)] = {
            bytes: new Array(itemPlan.sourceBytes + 1).join("v"),
            mtimeMs: state.clock++,
        };
        return item;
    });
}

function buildMissingFfmpegEntry(item) {
    return {
        id: item.id,
        name: item.displayName,
        displayName: item.displayName,
        category: item.categoryName,
        type: "media",
        mediaType: "video",
        section: "footage",
        folderPath: item.destinationFolder,
        sourcePath: item.sourcePath,
        thumbStatus: "placeholder",
        _isPending: true,
    };
}

async function runMissingFfmpegImport(plan) {
    const state = {
        files: {}, dirs: {}, writes: [], unlinked: [], requires: [], spawns: [],
        clock: 1, resolverCalls: 0, videoSources: [], videoReleases: [], canvasContexts: [],
        cardPatches: [], cardFailures: [], commits: [], persisted: [],
    };
    const items = buildMissingFfmpegItems(plan, state);
    const entries = items.map(buildMissingFfmpegEntry);
    const sourceBytes = {};
    items.forEach(function (item) { sourceBytes[item.id] = state.files[p23Key(item.sourcePath)].bytes; });

    const miniDocument = createMiniDocument();
    const grid = miniDocument.createElement("div");
    grid.className = "card-grid";
    miniDocument.body.appendChild(grid);
    const helper = new KeyedMediaCardHelper({
        document: miniDocument,
        renderCardMarkup: renderP23CardMarkup,
        onFailedUpdate: function (reason) { state.cardFailures.push(reason); },
    });
    const inserted = helper.insertBatch(entries, grid);

    const repository = new MediaEntryRepository({
        persist: function (serialized) { state.persisted.push(serialized); },
    });
    const seeded = repository.commitOptimisticBatch(entries);

    const timers = createTimerRegistry();
    const engine = loadMissingFfmpegEngine(plan, state);
    const terminals = [];
    const coordinator = new engine.MediaWorkCoordinator({
        scheduler: schedulerModule.createScheduler({ thumbnail: plan.thumbnailConcurrency }),
        repository: {
            patchById: function (id, fields) {
                state.commits.push({ id: id, fields: fields });
                return repository.patchById(id, fields);
            },
        },
        cardHelper: {
            patchById: function (id, patch) {
                const result = helper.patchById(id, patch);
                state.cardPatches.push({ id: id, patch: patch, ok: result.ok === true, reason: result.reason || null });
                return result;
            },
        },
        setTimeout: timers.set,
        clearTimeout: timers.clear,
        progressIntervalMs: 5,
        onTerminal: function (item, terminal) { terminals.push(item.id + ":" + terminal); },
    });
    const scheduler = coordinator._scheduler;

    try {
        const idleSnapshot = await coordinator.submitBatch({ id: "p23-batch", items: items });
        await flushTicks(4);
        const snapshot = coordinator.snapshot("p23-batch");
        await scheduler.drain("filesystem");
        await scheduler.drain("thumbnail");
        await scheduler.drain("ffmpeg");
        const lanes = scheduler.snapshot();

        return {
            plan: plan,
            state: state,
            items: items,
            entries: entries,
            inserted: inserted,
            seeded: seeded,
            sourceBytes: sourceBytes,
            idleSnapshot: idleSnapshot,
            snapshot: snapshot,
            lanes: lanes,
            liveTimers: timers.active(),
            terminals: terminals,
            cards: inserted.cards || [],
            document: miniDocument,
            grid: grid,
            repository: repository,
        };
    } finally {
        coordinator.dispose("test complete");
        scheduler.dispose();
        timers.disposeAll();
        helper.dispose();
    }
}

function assertMissingFfmpegFallback(run) {
    const state = run.state;
    const fallbackThumbnail = run.plan.canvas === "ok";

    // The harness itself has to be sound: seeded index, inserted cards, one
    // settled batch with no residual work or timers.
    expect(run.seeded.ok).toBe(true);
    expect(run.inserted.ok).toBe(true);
    expect(run.idleSnapshot.id).toBe("p23-batch");
    expect(run.snapshot.idle).toBe(true);
    expect(run.snapshot.pendingCount).toBe(0);
    expect(run.snapshot.inFlightCount).toBe(0);
    expect(run.snapshot.timerCount).toBe(0);
    expect(run.liveTimers).toBe(0);
    expect(run.snapshot.terminalCount).toBe(run.items.length);
    ["filesystem", "thumbnail", "ffmpeg"].forEach(function (lane) {
        expect(run.lanes.lanes[lane].active).toBe(0);
        expect(run.lanes.lanes[lane].pending).toBe(0);
    });

    // Requirement 7.3: FFmpeg-dependent generation was attempted and reported
    // unavailable without ever creating a process.
    expect(state.spawns).toEqual([]);
    expect(state.requires.indexOf("child_process")).toBe(-1);
    expect(run.lanes.processes).toBe(0);
    if (run.plan.resolver !== "missing") expect(state.resolverCalls).toBe(run.items.length);

    run.items.forEach(function (item, index) {
        const observed = run.snapshot.items[index];
        const entry = run.entries[index];

        // The FFmpeg stage ran and degraded instead of failing the item.
        expect(observed.stages.ffmpeg.state).toBe("derivative-unavailable");
        expect(observed.completedResults.ffmpeg.ok).toBe(false);
        expect(observed.completedResults.ffmpeg.reason).toBe("ffmpeg-unavailable");

        // Requirement 7.3: exactly one Terminal_State, and it is usable.
        expect(observed.terminalState).toBe("ready");
        expect(observed.processingState).toBe("ready");
        expect(run.terminals.filter(function (value) { return value.split(":")[0] === item.id; }))
            .toEqual([item.id + ":ready"]);

        // Requirement 7.3: the copied original media file is retained, byte for
        // byte, and the source file is left untouched.
        const copied = state.files[p23Key(item.destinationMedia)];
        expect(copied).toBeTruthy();
        expect(copied.bytes).toBe(run.sourceBytes[item.id]);
        expect(state.files[p23Key(item.sourcePath)].bytes).toBe(run.sourceBytes[item.id]);
        expect(state.unlinked.indexOf(p23Key(item.destinationMedia))).toBe(-1);
        expect(state.unlinked.indexOf(p23Key(item.sourcePath))).toBe(-1);

        // Requirement 7.3: the Library_Index entry is retained, committed once,
        // and keeps its identity and metadata.
        const persistedEntry = run.repository.getById(item.id);
        expect(persistedEntry).toBeTruthy();
        expect(persistedEntry.name).toBe(entry.name);
        expect(persistedEntry.category).toBe(entry.category);
        expect(persistedEntry.sourcePath).toBe(item.sourcePath);
        expect(persistedEntry.mediaFile).toBe(item.destinationMedia);
        expect(persistedEntry.mainFile).toBe(item.fileName);
        expect(persistedEntry.fileSize).toBe(run.sourceBytes[item.id].length);
        expect(persistedEntry._isPending).toBe(false);
        expect(persistedEntry.terminalState).toBe("ready");
        expect(persistedEntry.derivativeStatus).toBe("derivative-unavailable");
        expect(persistedEntry.proxyFile).toBeUndefined();
        expect(state.commits.filter(function (commit) { return commit.id === item.id; }).length).toBe(1);

        // Requirement 7.3: the card stays visible and selectable, and shows the
        // derivative-unavailable indication.
        const card = run.cards[index];
        expect(run.document.getElementById("tpl-" + item.id)).toBe(card);
        expect(card.parentNode).toBe(run.grid);
        const classes = card.className.split(/\s+/);
        expect(classes.indexOf("card")).toBeGreaterThan(-1);
        expect(classes.indexOf("media-pending")).toBe(-1);
        if (fallbackThumbnail) expect(classes.indexOf("thumb-failed")).toBe(-1);
        else expect(classes.indexOf("thumb-failed")).toBeGreaterThan(-1);
        expect(card.hasAttribute("hidden")).toBe(false);
        expect(card.getAttribute("style").indexOf("display: none")).toBe(-1);
        expect(card.getAttribute("style").indexOf("visibility: hidden")).toBe(-1);
        expect(card.getAttribute("data-file")).toBe(entry.name);
        expect(card.getAttribute("data-cat")).toBe(entry.category);
        expect(card.querySelectorAll(".card-check").length).toBe(1);
        expect(card.querySelectorAll(".thumb-img").length).toBe(1);
        expect(card.getAttribute("data-mediapath")).toBe(item.destinationMedia);
        expect(card.getAttribute("data-terminalstate")).toBe("ready");
        expect(card.getAttribute("data-derivativestatus")).toBe("derivative-unavailable");
        expect(card.getAttribute("data-thumbstatus")).toBe(fallbackThumbnail ? "ready" : "failed");

        // Exactly one successful card repaint for the item.
        const patches = state.cardPatches.filter(function (patch) { return patch.id === item.id; });
        expect(patches.length).toBe(1);
        expect(patches[0].ok).toBe(true);
        expect(patches[0].patch.terminalState).toBe("ready");
        expect(patches[0].patch.derivativeStatus).toBe("derivative-unavailable");
    });

    expect(state.cardFailures).toEqual([]);
}

const missingFfmpegItemArbitrary = fc.record({
    name: fc.constantFrom("clip", "take", "shot", "b-roll"),
    category: fc.constantFrom("Imported", "Footage", "Renders"),
    sourceBytes: fc.integer({ min: 1, max: 64 }),
});

const missingFfmpegPlanArbitrary = fc.record({
    items: fc.array(missingFfmpegItemArbitrary, { minLength: 1, maxLength: 3 }),
    // Every resolver form below means "FFmpeg is unavailable".
    resolver: fc.constantFrom("missing", "empty", "null", "undefined", "false", "throws", "async-empty"),
    decode: fc.constantFrom("error", "loadeddata-then-error"),
    canvas: fc.constantFrom("ok", "no-context", "encode-error"),
    thumbnailConcurrency: fc.integer({ min: 1, max: 3 }),
});

describe("Property 23: missing FFmpeg degrades to one usable terminal result", function () {
    // Feature: media-engine-lag, Property 23: Missing FFmpeg degrades to one usable terminal result
    // **Validates: Requirements 7.3**
    test("an unavailable FFmpeg resolver keeps the copied original, its index entry, and a visible selectable card while settling each item exactly once without spawning a process", async function () {
        await fc.assert(fc.asyncProperty(missingFfmpegPlanArbitrary, async function (plan) {
            assertMissingFfmpegFallback(await runMissingFfmpegImport(plan));
        }), { numRuns: 110, verbose: 2 });
    }, 180000);
});

// ---------------------------------------------------------------------------
// Property 10 harness
// ---------------------------------------------------------------------------
// What is under test
// ------------------
// The REAL FastMedia.dispose from js/core/fastMediaEngine.js tearing down the
// REAL MediaWorkCoordinator (running its DEFAULT copy/thumbnail/FFmpeg stage
// workers: copyFileStream, extractVideoFrame / generateImageThumbnail,
// runFfmpegFallback) and the REAL HoverPreviewController, all driving the REAL
// scheduler from js/core/scheduler.js.
//
// Four boundaries are substituted, and each one is an observation point:
//   * the filesystem, so every read/write stream and every partial-output
//     removal request is recorded;
//   * the HTML5 decode surface (<video>, <canvas>, Image), which does not exist
//     under jest's "node" environment, so every decode reference, listener and
//     release call is recorded;
//   * `child_process`, so every spawned FFmpeg process records its kill/exit;
//   * `window.URL`, so every job-created object URL and every revocation is
//     recorded.
// Every timer used by the engine, the scheduler, the coordinator and the hover
// controller comes from one shared registry, so residual timers are countable.

function p10Path(target) {
    return String(target).replace(/\\/g, "/").toLowerCase();
}

function p10Wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function p10Stream(state, kind, target) {
    const stream = {
        kind: kind,
        target: target,
        destroyed: false,
        handlers: {},
        on: function (event, handler) { stream.handlers[event] = handler; return stream; },
        destroy: function () { stream.destroyed = true; },
    };
    state.streams.push(stream);
    return stream;
}

// A filesystem where a copy either delivers its bytes or stalls forever, so a
// generated scenario can leave real filesystem-lane jobs holding open streams.
function p10Filesystem(state) {
    function record(target, bytes) {
        state.files[p10Path(target)] = { bytes: bytes, mtimeMs: state.clock++ };
        state.writes.push(p10Path(target));
    }
    return {
        promises: {
            mkdir: function () { return Promise.resolve(); },
            stat: function (target) {
                const entry = state.files[p10Path(target)];
                if (!entry) return Promise.reject(new Error("ENOENT: " + target));
                return Promise.resolve({ size: entry.bytes.length, mtimeMs: entry.mtimeMs });
            },
            unlink: function (target) {
                state.unlinked.push(p10Path(target));
                delete state.files[p10Path(target)];
                return Promise.resolve();
            },
            writeFile: function (target, data) { record(target, String(data)); return Promise.resolve(); },
            copyFile: function (from, to) {
                const entry = state.files[p10Path(from)];
                if (!entry) return Promise.reject(new Error("ENOENT: " + from));
                record(to, entry.bytes);
                return Promise.resolve();
            },
        },
        createReadStream: function (source) {
            const stream = p10Stream(state, "read", source);
            stream.pipe = function (writer) {
                if (state.copyPlans[p10Path(source)] !== "completes") return;
                Promise.resolve().then(function () { writer.deliver("media-bytes:" + p10Path(source)); });
            };
            return stream;
        },
        createWriteStream: function (target) {
            const writer = p10Stream(state, "write", target);
            writer.deliver = function (bytes) {
                record(target, bytes);
                if (writer.handlers.close) writer.handlers.close();
            };
            return writer;
        },
        existsSync: function (target) { return !!state.files[p10Path(target)]; },
        statSync: function (target) {
            const entry = state.files[p10Path(target)];
            return { size: entry ? entry.bytes.length : 0 };
        },
    };
}

// A decode surface that never completes, so thumbnail/hover jobs stay unfinished
// until disposal. Release calls (pause, removeAttribute("src"), load) and
// listener removal are recorded per element.
function p10MediaElement(state, role) {
    const element = {
        role: role,
        listenerCount: 0,
        paused: false,
        loaded: false,
        srcRemoved: false,
        sources: [],
        parentNode: null,
        muted: false,
        loop: false,
        playsInline: false,
        autoplay: false,
        crossOrigin: "",
        className: "",
        currentTime: 0,
        duration: 8,
        videoWidth: 1920,
        videoHeight: 1080,
        naturalWidth: 1920,
        naturalHeight: 1080,
        onload: null,
        onerror: null,
        _listeners: [],
        addEventListener: function (name, handler) {
            element._listeners.push({ name: name, handler: handler });
            element.listenerCount++;
        },
        removeEventListener: function (name, handler) {
            for (let i = element._listeners.length - 1; i >= 0; i--) {
                if (element._listeners[i].name === name && element._listeners[i].handler === handler) {
                    element._listeners.splice(i, 1);
                    element.listenerCount--;
                }
            }
        },
        setAttribute: function () { },
        removeAttribute: function (name) { if (String(name) === "src") element.srcRemoved = true; },
        pause: function () { element.paused = true; },
        load: function () { element.loaded = true; },
        emit: function (name) {
            const handlers = element._listeners
                .filter(function (entry) { return entry.name === name; })
                .map(function (entry) { return entry.handler; });
            for (let i = 0; i < handlers.length; i++) handlers[i]({ type: name });
        },
    };
    Object.defineProperty(element, "src", {
        configurable: true,
        get: function () { return element.sources.length ? element.sources[element.sources.length - 1] : ""; },
        set: function (value) {
            element.sources.push(String(value));
            if (element.onSrc) element.onSrc(String(value));
        },
    });
    if (role === "image") state.images.push(element);
    else state.videos.push(element);
    return element;
}

function p10Canvas(state) {
    const canvas = {
        width: 0,
        height: 0,
        getContext: function () {
            return {
                fillStyle: "", font: "", textAlign: "",
                fillRect: function () { }, beginPath: function () { }, moveTo: function () { },
                lineTo: function () { }, closePath: function () { }, fill: function () { },
                fillText: function () { }, drawImage: function () { },
            };
        },
        toDataURL: function () { return "data:image/png;base64,UExBQ0VIT0xERVI="; },
    };
    state.canvases.push(canvas);
    return canvas;
}

// Child processes that stay alive until they are killed, then close like a real
// terminated FFmpeg process so the owning job can release its handle.
function p10ChildProcess(state) {
    function spawnChild(api, executable, args, callback) {
        const child = {
            api: api,
            executable: executable,
            args: args,
            killCount: 0,
            exited: false,
            listeners: {},
            on: function (event, handler) {
                child.listeners[event] = child.listeners[event] || [];
                child.listeners[event].push(handler);
                return child;
            },
            removeListener: function (event, handler) {
                const list = child.listeners[event] || [];
                const at = list.indexOf(handler);
                if (at !== -1) list.splice(at, 1);
                return child;
            },
            emit: function (event) {
                const list = (child.listeners[event] || []).slice();
                for (let i = 0; i < list.length; i++) list[i](0, null);
            },
            kill: function () {
                child.killCount++;
                if (child.exited) return true;
                Promise.resolve().then(function () {
                    if (child.exited) return;
                    child.exited = true;
                    child.emit("close");
                    if (callback) callback(new Error("ffmpeg terminated"));
                });
                return true;
            },
        };
        child.once = child.on;
        state.children.push(child);
        return child;
    }
    return {
        execFile: function (executable, args, options, callback) {
            return spawnChild("execFile", executable, args, typeof options === "function" ? options : callback);
        },
        spawn: function (executable, args) { return spawnChild("spawn", executable, args, null); },
    };
}

function p10Document(state) {
    const fakeDocument = {
        body: { nodeName: "BODY" },
        listeners: [],
        getElementById: function () { return null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        addEventListener: function (name, handler) { fakeDocument.listeners.push({ name: name, handler: handler }); },
        removeEventListener: function (name, handler) {
            for (let i = fakeDocument.listeners.length - 1; i >= 0; i--) {
                if (fakeDocument.listeners[i].name === name && fakeDocument.listeners[i].handler === handler) {
                    fakeDocument.listeners.splice(i, 1);
                }
            }
        },
        createElement: function (tag) {
            const name = String(tag).toLowerCase();
            if (name === "video") return p10MediaElement(state, "decode");
            if (name === "canvas") return p10Canvas(state);
            throw new Error("Property 10 does not expect a <" + name + "> element");
        },
    };
    return fakeDocument;
}

function loadDisposalEngine(state, timers) {
    const filesystem = p10Filesystem(state);
    const fakeDocument = p10Document(state);
    const context = {
        window: {
            rootPath: "C:/library",
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: {
                createObjectURL: function () {
                    const url = "blob:media-p10-" + (state.createdUrls.length + 1);
                    state.createdUrls.push(url);
                    return url;
                },
                revokeObjectURL: function (url) { state.revokedUrls.push(String(url)); },
            },
        },
        document: fakeDocument,
        performance: { now: function () { return state.clock++; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            state.requires.push(name);
            if (name === "fs") return filesystem;
            if (name === "path") return path;
            if (name === "child_process") return p10ChildProcess(state);
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout: timers.set,
        clearTimeout: timers.clear,
        setInterval: setInterval,
        clearInterval: clearInterval,
        setImmediate: setImmediate,
        Promise: Promise,
        Date: Date,
        Buffer: Buffer,
        Image: function () { return p10MediaElement(state, "image"); },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent: encodeURIComponent,
        encodeURI: encodeURI,
        decodeURI: decodeURI,
    };
    context.window.window = context.window;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);
    if (!context.window.FastMedia || typeof context.window.FastMedia.dispose !== "function") {
        throw new Error("FastMedia.dispose was not exposed by the media engine");
    }
    return { window: context.window, document: fakeDocument, context: context };
}

// Media-owned work that is already holding resources when disposal begins.
function p10EnqueueAuxiliary(scheduler, engine, state, timers, specs) {
    return specs.map(function (spec, index) {
        const options = {
            owner: "fast-media",
            stage: spec.lane === "filesystem" ? "copy" : "thumbnail",
            mediaId: "media-p10-aux-" + index,
            sourcePath: "C:/originals/aux-" + index + ".mp4",
        };
        function worker(control) {
            state.auxStarted.push(index);
            for (let i = 0; i < spec.urlCount; i++) {
                control.registerObjectUrl(engine.URL.createObjectURL({}), engine.URL.revokeObjectURL);
            }
            control.registerStream(p10Stream(state, "aux", "aux-" + index));
            control.registerVideo(p10MediaElement(state, "aux"));
            control.registerTimer(timers.set(function () { }, 60000), timers.clear);
            return new Promise(function () { });
        }
        return spec.deferMs > 0 ?
            scheduler.defer(spec.lane, spec.deferMs, worker, options) :
            scheduler.enqueue(spec.lane, worker, options);
    });
}

function p10Card(id) {
    const thumbBox = {
        children: [],
        appendChild: function (node) {
            if (node.parentNode && node.parentNode !== thumbBox && typeof node.parentNode.removeChild === "function") {
                node.parentNode.removeChild(node);
            }
            node.parentNode = thumbBox;
            thumbBox.children.push(node);
            return node;
        },
        removeChild: function (node) {
            const at = thumbBox.children.indexOf(node);
            if (at !== -1) thumbBox.children.splice(at, 1);
            node.parentNode = null;
            return node;
        },
    };
    const attributes = {
        "data-media-id": id,
        "data-folder": "C:/library/footage/" + id,
        "data-mediapath": "C:/library/footage/" + id + "/" + id + ".mp4",
        "data-file": id,
        "data-type": "media",
        "data-mediatype": "video",
    };
    return {
        id: "tpl-" + id,
        isConnected: true,
        thumbBox: thumbBox,
        getAttribute: function (name) {
            return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
        },
        querySelector: function (selector) { return selector === ".thumb-box" ? thumbBox : null; },
    };
}

function p10MediaElementReleased(element) {
    return element.paused && element.srcRemoved && element.loaded && element.listenerCount === 0;
}

function p10ImageReleased(image) {
    return image.listenerCount === 0 && image.src === "" && image.onload === null && image.onerror === null;
}

function p10Describe(element) {
    return [element.role, "paused=" + element.paused, "srcRemoved=" + element.srcRemoved,
    "loaded=" + element.loaded, "listeners=" + element.listenerCount].join(":");
}

async function runDisposalQuiescence(scenario) {
    const timers = createTimerRegistry();
    const state = {
        files: {}, copyPlans: {}, unlinked: [], writes: [], streams: [], videos: [], images: [],
        canvases: [], children: [], createdUrls: [], revokedUrls: [], auxStarted: [], requires: [],
        clock: 1, hoverPlan: "hang",
    };
    const scheduler = schedulerModule.createScheduler({
        thumbnail: scenario.thumbnailConcurrency,
        setTimeout: timers.set,
        clearTimeout: timers.clear,
    });
    const loaded = loadDisposalEngine(state, timers);
    const engine = loaded.window;
    // The engine cancels media-owned scheduler work through the ambient scheduler.
    loaded.context.Scheduler = scheduler;
    engine.Scheduler = scheduler;
    engine.resolveFfmpeg = function (callback) { callback("C:/tools/ffmpeg.exe"); };

    const items = scenario.items.map(function (plan, index) {
        const id = "media-p10-" + index;
        const ext = plan.isVideo ? ".mp4" : ".png";
        const folder = "C:/library/footage/" + id;
        const item = {
            id: id,
            sourcePath: "C:/originals/" + id + ext,
            fileName: id + ext,
            safeName: id,
            isVideo: plan.isVideo,
            destinationFolder: folder,
            destinationMedia: folder + "/" + id + ext,
            destinationThumbnail: folder + "/thumbnail.png",
        };
        state.files[p10Path(item.sourcePath)] = { bytes: "source:" + id, mtimeMs: state.clock++ };
        state.copyPlans[p10Path(item.sourcePath)] = plan.copy;
        return item;
    });

    const repository = {
        patches: [],
        patchById: function (id, fields) {
            repository.patches.push({ id: id, fields: fields });
            return Promise.resolve({ ok: true });
        },
    };
    const cards = {
        patches: [],
        patchById: function (id, patch) { cards.patches.push({ id: id, patch: patch }); return { ok: true }; },
    };

    const coordinator = engine.FastMedia.createWorkCoordinator({
        scheduler: scheduler,
        repository: repository,
        cardHelper: cards,
        setTimeout: timers.set,
        clearTimeout: timers.clear,
        progressIntervalMs: 40,
    });
    const hover = engine.FastMedia.createHoverPreviewController({
        document: loaded.document,
        scheduler: scheduler,
        setTimeout: timers.set,
        clearTimeout: timers.clear,
        intentDelayMs: 0,
        activationTimeoutMs: 5000,
        MutationObserver: null,
        createVideo: function () {
            const video = p10MediaElement(state, "hover");
            video.play = function () { return undefined; };
            video.onSrc = function () {
                if (state.hoverPlan !== "error") return;
                Promise.resolve().then(function () { video.emit("error"); });
            };
            return video;
        },
    });
    hover.init();

    const auxiliaryHandles = p10EnqueueAuxiliary(scheduler, engine, state, timers, scenario.auxiliary);
    const batchPromise = coordinator.submitBatch({ id: "p10-batch", items: items });
    batchPromise.then(function () { }, function () { });

    const hoverCards = [];
    for (let i = 0; i < scenario.hoverErrors; i++) {
        hoverCards.push({ plan: "error", node: p10Card("hover-error-" + i) });
    }
    if (scenario.hoverHangs) hoverCards.push({ plan: "hang", node: p10Card("hover-hang") });

    try {
        for (let i = 0; i < hoverCards.length; i++) {
            state.hoverPlan = hoverCards[i].plan;
            hover.request(hoverCards[i].node);
            await p10Wait(6);
        }
        await p10Wait(8);

        const preScheduler = scheduler.snapshot();
        const preBatch = coordinator.snapshot("p10-batch");
        const before = {
            totalJobs: preScheduler.active + preScheduler.pending,
            processes: preScheduler.processes,
            hover: hover.snapshot(),
            activeCopies: preBatch.items
                .filter(function (item) { return item.stages.copy.state === "active"; })
                .map(function (item) { return item.id; }),
            children: state.children.length,
            createdUrls: state.createdUrls.length,
            liveTimers: timers.active(),
        };

        // Disposal, then the settle window every cleanup path is allowed.
        const disposed = engine.FastMedia.dispose();
        const disposedAgain = engine.FastMedia.dispose();
        await flushTicks(4);
        await scheduler.drain("filesystem");
        await scheduler.drain("thumbnail");
        await scheduler.drain("ffmpeg");
        await flushTicks(8);

        const idleSnapshot = await batchPromise;
        const admission = await engine.FastMedia.importFile("C:/originals/media-p10-late.mp4", "footage");
        const afterScheduler = scheduler.snapshot();

        return {
            scenario: scenario,
            items: items,
            before: before,
            disposed: disposed,
            disposedAgain: disposedAgain,
            afterScheduler: afterScheduler,
            jobStates: auxiliaryHandles.map(function (handle) { return handle.state; }),
            batch: coordinator.snapshot("p10-batch"),
            idleSnapshotId: idleSnapshot ? idleSnapshot.id : null,
            hoverAfter: hover.snapshot(),
            documentListeners: loaded.document.listeners.length,
            liveTimers: timers.active(),
            liveStreams: state.streams
                .filter(function (stream) { return !stream.destroyed; })
                .map(function (stream) { return stream.kind + ":" + stream.target; }),
            liveDecoders: state.videos.filter(function (video) { return !p10MediaElementReleased(video); }).map(p10Describe),
            liveImages: state.images.filter(function (image) { return !p10ImageReleased(image); }).map(p10Describe),
            liveCanvases: state.canvases
                .filter(function (canvas) { return canvas.width !== 0 || canvas.height !== 0; })
                .map(function (canvas) { return canvas.width + "x" + canvas.height; }),
            liveChildren: state.children
                .filter(function (child) { return child.killCount === 0 || !child.exited; })
                .map(function (child) { return child.api + ":kills=" + child.killCount + ":exited=" + child.exited; }),
            unrevokedUrls: state.createdUrls.filter(function (url) { return state.revokedUrls.indexOf(url) === -1; }),
            createdUrlCount: state.createdUrls.length,
            // Every started media job created exactly its planned object URLs.
            plannedUrlCount: state.auxStarted.reduce(function (total, index) {
                return total + scenario.auxiliary[index].urlCount;
            }, 0),
            missingRemovals: before.activeCopies.filter(function (id) {
                const item = items.filter(function (candidate) { return candidate.id === id; })[0];
                return state.unlinked.indexOf(p10Path(item.destinationMedia)) === -1;
            }),
            admission: admission,
            state: state,
        };
    } finally {
        coordinator.dispose("test complete");
        hover.dispose();
        scheduler.dispose();
        timers.disposeAll();
    }
}

function assertDisposalQuiescence(run) {
    // The scenario really had media work and media resources in flight.
    expect(run.before.totalJobs).toBeGreaterThan(0);
    if (run.scenario.hoverErrors > 0) expect(run.before.children).toBeGreaterThan(0);
    if (run.scenario.hoverHangs) expect(run.before.hover.activeDecoderCount).toBe(1);

    // Disposal is idempotent and completes.
    expect(run.disposed).toBe(true);
    expect(run.disposedAgain).toBe(false);

    // Requirement 3.10: every queued, deferred, and active media job is cancelled.
    expect(run.jobStates.filter(function (jobState) {
        return jobState !== "cancelled" && jobState !== "settled";
    })).toEqual([]);
    ["filesystem", "thumbnail", "ffmpeg"].forEach(function (name) {
        const lane = run.afterScheduler.lanes[name];
        expect(lane.active).toBe(0);
        expect(lane.queued).toBe(0);
        expect(lane.deferred).toBe(0);
        expect(lane.pending).toBe(0);
        expect(lane.cleaning).toBe(0);
        expect(lane.ownedResources).toBe(0);
        expect(lane.processes).toBe(0);
    });
    expect(run.afterScheduler.active).toBe(0);
    expect(run.afterScheduler.pending).toBe(0);
    expect(run.afterScheduler.timers).toBe(0);
    expect(run.batch.idle).toBe(true);
    expect(run.batch.pendingCount).toBe(0);
    expect(run.batch.inFlightCount).toBe(0);
    expect(run.batch.timerCount).toBe(0);
    expect(run.idleSnapshotId).toBe("p10-batch");
    expect(run.batch.items.filter(function (item) { return item.terminalState === "pending"; })).toEqual([]);
    expect(run.liveTimers).toBe(0);

    // Requirement 3.10: cleanup is requested for every active stream, including
    // asynchronous removal of the partial destination of an interrupted copy.
    expect(run.liveStreams).toEqual([]);
    expect(run.missingRemovals).toEqual([]);
    expect(run.state.unlinked.indexOf(p10Path(run.items[0].sourcePath))).toBe(-1);

    // Requirement 3.11: zero media-owned child processes remain.
    expect(run.liveChildren).toEqual([]);
    expect(run.afterScheduler.processes).toBe(0);

    // Requirement 4.6: every decode reference is dropped and every job-created
    // object URL is revoked, leaving zero active decoders.
    expect(run.createdUrlCount).toBe(run.plannedUrlCount);
    expect(run.unrevokedUrls).toEqual([]);
    expect(run.liveDecoders).toEqual([]);
    expect(run.liveImages).toEqual([]);
    expect(run.liveCanvases).toEqual([]);
    expect(run.hoverAfter.activeDecoderCount).toBe(0);
    expect(run.hoverAfter.ownsVideo).toBe(false);
    expect(run.hoverAfter.attachedVideoCount).toBe(0);
    expect(run.hoverAfter.intentTimerCount).toBe(0);
    expect(run.hoverAfter.activationTimerCount).toBe(0);
    expect(run.hoverAfter.listenerCount).toBe(0);
    expect(run.hoverAfter.documentListenerCount).toBe(0);
    expect(run.hoverAfter.disposed).toBe(true);
    expect(run.documentListeners).toBe(0);

    // Disposal stops admission of new media work.
    expect(run.admission.ok).toBe(false);
    expect(run.admission.cancelled).toBe(true);
}

const disposalScenarioArbitrary = fc.record({
    items: fc.array(fc.record({
        isVideo: fc.boolean(),
        // A stalled copy keeps the filesystem lane and its streams open; a
        // completed copy hands the item to an unfinished thumbnail decode.
        copy: fc.constantFrom("hangs", "completes"),
    }), { minLength: 1, maxLength: 3 }),
    auxiliary: fc.array(fc.record({
        lane: fc.constantFrom("thumbnail", "filesystem"),
        deferMs: fc.constantFrom(0, 0, 4000),
        urlCount: fc.integer({ min: 1, max: 2 }),
    }), { minLength: 1, maxLength: 3 }),
    hoverErrors: fc.integer({ min: 0, max: 2 }),
    hoverHangs: fc.boolean(),
    thumbnailConcurrency: fc.integer({ min: 1, max: 2 }),
});

describe("Property 10: disposal leaves media resources quiescent", function () {
    // Feature: media-engine-lag, Property 10: Disposal leaves media resources quiescent
    // **Validates: Requirements 3.10, 3.11, 4.6**
    test("disposal cancels every queued and deferred media job, releases every stream, decoder, object URL, and child process, and leaves the media engine quiescent", async function () {
        await fc.assert(fc.asyncProperty(disposalScenarioArbitrary, async function (scenario) {
            assertDisposalQuiescence(await runDisposalQuiescence(scenario));
        }), { numRuns: 105, verbose: 2 });
    }, 300000);
});
