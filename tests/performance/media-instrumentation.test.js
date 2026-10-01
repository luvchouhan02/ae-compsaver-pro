"use strict";
/*
 * Focused example coverage for media instrumentation and the harness-only
 * measurement protocol. Property coverage lives in
 * tests/performance/media-instrumentation.property.test.js.
 *
 * Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 8.8
 */
const path = require("path");
const PerfEvents = require(path.resolve(__dirname, "../../js/core/observability.js"));
const protocolUtilities = require(path.resolve(__dirname, "mediaMeasurementProtocol.js"));

const ALLOWED_PHASES = [
    "picker return",
    "discovery",
    "card insertion",
    "copy",
    "thumbnail generation",
    "proxy generation",
    "catalog rendering",
    "panel interaction",
];

/** Deterministic clock so recorded durations equal the advanced amounts exactly. */
function installClock() {
    const original = global.performance;
    const state = { value: 5000 };
    Object.defineProperty(global, "performance", {
        configurable: true,
        writable: true,
        value: { now: function () { return state.value; } },
    });
    return {
        advance: function (ms) { state.value += ms; },
        restore: function () {
            Object.defineProperty(global, "performance", {
                configurable: true,
                writable: true,
                value: original,
            });
        },
    };
}

/** Replaces a global with a stub and restores the original descriptor afterwards. */
function overrideGlobal(name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(global, name);
    Object.defineProperty(global, name, { configurable: true, writable: true, value: value });
    return function restore() {
        if (descriptor) Object.defineProperty(global, name, descriptor);
        else delete global[name];
    };
}

function installConsoleRecorder() {
    const channels = ["log", "info", "warn", "error", "debug", "trace"];
    const originals = {};
    const state = { calls: 0 };
    channels.forEach(function (channel) {
        originals[channel] = console[channel];
        console[channel] = function () { state.calls += 1; };
    });
    return {
        count: function () { return state.calls; },
        restore: function () { channels.forEach(function (channel) { console[channel] = originals[channel]; }); },
    };
}

/** Records one scenario run with the given per-stage durations. */
function recordRun(kind, stageDurations) {
    const clock = installClock();
    try {
        const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
        metrics.start(kind, protocolUtilities.PROTOCOL_VERSION);
        clock.advance(12);
        metrics.pickerResult();
        clock.advance(8);
        metrics.discoveryComplete();
        clock.advance(5);
        metrics.cardVisible("media-1");
        stageDurations.forEach(function (entry, index) {
            const mediaId = "media-" + (index + 1);
            metrics.stageStart(entry.stage, mediaId);
            clock.advance(entry.durationMs);
            metrics.stageEnd(entry.stage, mediaId, entry.outcome || "success");
        });
        const report = metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 });
        metrics.dispose();
        return report;
    } finally {
        clock.restore();
    }
}

describe("frozen measurement protocol snapshots", function () {
    test("the protocol snapshot freezes the five-run one-file and mixed-50 scenarios", function () {
        const protocol = protocolUtilities.createFrozenMeasurementProtocol({
            environment: { host: "AfterEffects", build: "24.0" },
            inputs: { oneFile: "sample.png", mixed50: "mixed-50" },
            restartSteps: ["close panel", "reopen panel"],
        });

        expect(protocol.version).toBe(protocolUtilities.PROTOCOL_VERSION);
        expect(protocol.scenarios.oneFile.runs).toBe(5);
        expect(protocol.scenarios.oneFile.input).toBe("one supported media file");
        expect(protocol.scenarios.mixed50.runs).toBe(5);
        expect(protocol.scenarios.mixed50.fileCount).toBe(50);
        expect(Object.isFrozen(protocol)).toBe(true);
        expect(Object.isFrozen(protocol.scenarios.mixed50)).toBe(true);
        expect(Object.isFrozen(protocol.environment)).toBe(true);
        expect(function () { protocol.scenarios.oneFile.runs = 99; }).toThrow();
        expect(protocol.scenarios.oneFile.runs).toBe(5);
        expect(protocol.environment).toEqual({ host: "AfterEffects", build: "24.0" });
    });

    test("the run plan holds exactly five one-file and five mixed-50 runs", function () {
        const protocol = protocolUtilities.createFrozenMeasurementProtocol({});
        const plan = protocolUtilities.createProtocolRunPlan(protocol, false);

        expect(plan.length).toBe(10);
        expect(plan.filter(function (item) { return item.kind === "oneFile"; }).length).toBe(5);
        expect(plan.filter(function (item) { return item.kind === "mixed50"; }).length).toBe(5);
        expect(plan.slice(0, 5).map(function (item) { return item.run; })).toEqual([1, 2, 3, 4, 5]);
    });

    test("the optional 500-record harness scenario adds render, scroll, and selection runs", function () {
        const protocol = protocolUtilities.createFrozenMeasurementProtocol({});
        const plan = protocolUtilities.createProtocolRunPlan(protocol, true);

        expect(protocol.scenarios.catalog500.optional).toBe(true);
        expect(protocol.scenarios.catalog500.harnessOnly).toBe(true);
        expect(protocol.scenarios.catalog500.recordCount).toBe(500);
        expect(plan.filter(function (item) { return item.kind === "catalog500.render"; }).length).toBe(5);
        expect(plan.filter(function (item) { return item.kind === "catalog500.scroll"; }).length).toBe(10);
        expect(plan.filter(function (item) { return item.kind === "catalog500.selection"; }).length).toBe(10);
        expect(plan.length).toBe(35);
    });

    test("the report compares baseline and change-set percentiles under one protocol", function () {
        const protocol = protocolUtilities.createFrozenMeasurementProtocol({});
        const baselineRuns = [
            recordRun("oneFile", [{ stage: "copy", durationMs: 100 }]),
            recordRun("oneFile", [{ stage: "copy", durationMs: 300 }]),
        ];
        const changeSetRuns = [
            recordRun("oneFile", [{ stage: "copy", durationMs: 50 }]),
            recordRun("oneFile", [{ stage: "copy", durationMs: 70 }]),
        ];
        const report = protocolUtilities.createMeasurementReport(protocol, baselineRuns, changeSetRuns, {
            changedFiles: ["js/core/observability.js"],
            residualCodecLimitations: "none observed",
        });

        const copy = report.comparisons["oneFile.stage.copy.duration"];
        expect(copy.baseline.values).toEqual([100, 300]);
        expect(copy.baseline.p50).toBe(100);
        expect(copy.baseline.p95).toBe(300);
        expect(copy.changeSet.values).toEqual([50, 70]);
        expect(copy.changeSet.p50).toBe(50);
        expect(copy.changeSet.p95).toBe(70);
        expect(report.protocol.version).toBe(protocolUtilities.PROTOCOL_VERSION);
        expect(report.evidence.changedFiles).toEqual(["js/core/observability.js"]);
        expect(report.evidence.residualCodecLimitations).toBe("none observed");
    });

    test("a report requires the frozen protocol version", function () {
        expect(function () { protocolUtilities.createMeasurementReport(null, [], []); })
            .toThrow(/frozen media-engine-lag measurement protocol/);
        expect(function () { protocolUtilities.createMeasurementReport({ version: "ad-hoc" }, [], []); })
            .toThrow(/frozen media-engine-lag measurement protocol/);
    });
});

describe("scenario measurement capture", function () {
    test("timestamps, stage durations, lane depth, process peak, and failed patches are recorded", function () {
        const clock = installClock();
        let report;
        try {
            const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
            metrics.start("mixed50", protocolUtilities.PROTOCOL_VERSION);
            clock.advance(20);
            expect(metrics.pickerResult()).toBe(20);
            clock.advance(10);
            expect(metrics.discoveryComplete()).toBe(30);
            clock.advance(40);
            expect(metrics.cardVisible("media-1")).toBe(70);
            // A later card does not overwrite the first visible card timestamp.
            clock.advance(15);
            expect(metrics.cardVisible("media-2")).toBe(70);

            metrics.stageStart("copy", "media-1");
            clock.advance(250);
            metrics.stageEnd("copy", "media-1", "success");
            metrics.stageStart("thumbnail", "media-1");
            clock.advance(90);
            metrics.stageEnd("thumbnail", "media-1", "success");
            metrics.stageStart("proxy", "media-1");
            clock.advance(1200);
            metrics.stageEnd("proxy", "media-1", "timeout", "ffmpeg timeout");

            metrics.observeLane("filesystem", 3, 2);
            metrics.observeLane("filesystem", 7, 2);
            metrics.observeLane("filesystem", 5, 1);
            metrics.observeLane("thumbnail", 2, 1);
            metrics.observeProcessCount(1);
            metrics.observeProcessCount(0);
            metrics.observeDecoderCount(1);
            metrics.recordCardPatch(true);
            metrics.recordCardPatch(false, "card missing");
            metrics.recordCardPatch(false, "duplicate thumbnail target");

            report = metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 });
            metrics.dispose();
        } finally {
            clock.restore();
        }

        expect(report.kind).toBe("mixed50");
        expect(report.pickerResultMs).toBe(20);
        expect(report.discoveryCompleteMs).toBe(30);
        expect(report.firstCardVisibleMs).toBe(70);
        expect(report.cardVisibility).toEqual([{ mediaId: "media-1", atMs: 70 }]);

        const durations = report.stages.reduce(function (result, stage) {
            result[stage.stage] = stage.durationMs;
            return result;
        }, {});
        expect(durations).toEqual({ copy: 250, thumbnail: 90, proxy: 1200 });
        const proxyStage = report.stages.filter(function (stage) { return stage.stage === "proxy"; })[0];
        expect(proxyStage.outcome).toBe("timeout");
        expect(proxyStage.reason).toBe("ffmpeg timeout");
        expect(proxyStage.startedMs).toBe(425);
        expect(proxyStage.endedMs).toBe(1625);

        expect(report.lanes.filesystem.maximumPendingDepth).toBe(7);
        expect(report.lanes.filesystem.maximumActiveCount).toBe(2);
        expect(report.lanes.thumbnail.maximumPendingDepth).toBe(2);
        expect(report.peaks.ffmpegProcesses).toBe(1);
        expect(report.peaks.videoDecoders).toBe(1);
        expect(report.peaks.postIdleChildProcesses).toBe(0);
        expect(report.peaks.postIdleVideoDecoders).toBe(0);
        expect(report.failedKeyedPatches).toBe(2);
        expect(report.failedKeyedPatchReasons).toEqual(["card missing", "duplicate thumbnail target"]);
    });

    test("long work is recorded with its allowed scenario phase", function () {
        const clock = installClock();
        let report;
        try {
            const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
            metrics.start("mixed50", protocolUtilities.PROTOCOL_VERSION);
            ALLOWED_PHASES.forEach(function (phaseName, index) {
                const result = metrics.phase(phaseName, function () {
                    clock.advance(60 + index);
                    return phaseName;
                });
                expect(result).toBe(phaseName);
            });
            // Work shorter than the long-task threshold is not reported as a long task.
            metrics.phase("copy", function () { clock.advance(10); });
            report = metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 });
            metrics.dispose();
        } finally {
            clock.restore();
        }

        expect(report.longTasks.length).toBe(ALLOWED_PHASES.length);
        expect(report.longTasks.map(function (task) { return task.phase; })).toEqual(ALLOWED_PHASES);
        report.longTasks.forEach(function (task, index) {
            expect(task.durationMs).toBe(60 + index);
            expect(task.source).toBe("phase span");
        });
    });

    test("an unknown phase tag is reported as unavailable and never recorded as a long task", function () {
        const clock = installClock();
        let report;
        try {
            const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
            metrics.start("oneFile", protocolUtilities.PROTOCOL_VERSION);
            const value = metrics.phase("mystery phase", function () {
                clock.advance(400);
                return "done";
            });
            expect(value).toBe("done");
            expect(metrics.recordLongWork("mystery phase", 400)).toBe(null);
            report = metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 });
            metrics.dispose();
        } finally {
            clock.restore();
        }

        expect(report.longTasks).toEqual([]);
        expect(report.unavailable.some(function (entry) {
            return entry.measurement === "phase.mystery phase" && entry.reason === "unknown phase";
        })).toBe(true);
        expect(report.unavailable.some(function (entry) {
            return entry.measurement === "long-task phase" && /unknown phase: mystery phase/.test(entry.reason);
        })).toBe(true);
    });
});

describe("unavailable measurement reporting", function () {
    test("a missing PerformanceObserver and missing memory API are reported with reasons and no substitutes", function () {
        const clock = installClock();
        const restoreObserver = overrideGlobal("PerformanceObserver", undefined);
        const originalMemoryUsage = process.memoryUsage;
        process.memoryUsage = function () { throw new Error("unsupported"); };
        let report;
        try {
            const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
            metrics.start("mixed50", protocolUtilities.PROTOCOL_VERSION);
            expect(metrics.observeMemory()).toBe(null);
            clock.advance(30);
            report = metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 });
            metrics.dispose();
        } finally {
            process.memoryUsage = originalMemoryUsage;
            restoreObserver();
            clock.restore();
        }

        const observerEntries = report.unavailable.filter(function (entry) {
            return entry.measurement === "long-task observer";
        });
        expect(observerEntries.length).toBe(1);
        expect(observerEntries[0].scenario).toBe("mixed50");
        expect(observerEntries[0].reason).toBe("PerformanceObserver unavailable");
        expect(report.longTasks).toEqual([]);

        ["memory.before", "memory.peak", "memory.postIdle"].forEach(function (measurement) {
            const entry = report.unavailable.filter(function (item) { return item.measurement === measurement; })[0];
            expect(entry).toBeDefined();
            expect(entry.scenario).toBe("mixed50");
            expect(entry.reason).toBe("memory API unavailable");
        });
        // No value is substituted for an unavailable measurement.
        expect(report.memory).toEqual({ before: null, peak: null, postIdle: null, source: null });
        expect(protocolUtilities.finiteValues(report.unavailable).length).toBe(0);
        expect(report.observations.some(function (item) {
            return item.measurement.indexOf("memory.") === 0;
        })).toBe(false);
    });

    test("uncapturable stage, lane, and resource measurements are reported and excluded", function () {
        const clock = installClock();
        let report;
        try {
            const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
            metrics.start("oneFile", protocolUtilities.PROTOCOL_VERSION);
            expect(metrics.stageEnd("copy", "media-1", "success")).toBe(null);
            expect(metrics.observeLane("filesystem", undefined, 1)).toBe(null);
            expect(metrics.observeProcessCount(NaN)).toBe(null);
            expect(metrics.observeDecoderCount("two")).toBe(null);
            clock.advance(25);
            report = metrics.finishScenario({ childProcesses: NaN, videoDecoders: null });
            metrics.dispose();
        } finally {
            clock.restore();
        }

        const reasons = report.unavailable.reduce(function (result, entry) {
            result[entry.measurement] = entry.reason;
            return result;
        }, {});
        expect(reasons["stage.copy.duration"]).toBe("stage end without stage start");
        expect(reasons["lane.filesystem.pending"]).toBe("lane pending depth unavailable");
        expect(reasons["ffmpeg process peak"]).toBe("resource count unavailable");
        expect(reasons["video decoder peak"]).toBe("resource count unavailable");
        expect(reasons["post-idle child processes"]).toBe("non-finite resource count");
        expect(reasons["post-idle video decoders"]).toBe("non-finite resource count");
        expect(report.stages).toEqual([]);
        expect(report.lanes.filesystem).toBeUndefined();
        expect(report.peaks.ffmpegProcesses).toBe(0);
        expect(Object.prototype.hasOwnProperty.call(report.peaks, "postIdleChildProcesses")).toBe(false);
        expect(protocolUtilities.observationsFromRun(report).some(function (item) {
            return item.measurement === "stage.copy.duration";
        })).toBe(false);
    });
});

describe("disabled recorder", function () {
    test("instrumentation that is not enabled is a complete no-op", function () {
        const recorder = installConsoleRecorder();
        const constructions = { count: 0 };
        const restoreObserver = overrideGlobal("PerformanceObserver", function FakeObserver() {
            constructions.count += 1;
            this.observe = function () { };
            this.disconnect = function () { };
        });
        const captured = [];
        const unsubscribe = PerfEvents.subscribe(function (event) { captured.push(event); });
        try {
            [
                PerfEvents.createMediaScenarioMetrics(),
                PerfEvents.createMediaScenarioMetrics({ enabled: false }),
            ].forEach(function (metrics) {
                expect(metrics.start("mixed50", protocolUtilities.PROTOCOL_VERSION)).toBe(null);
                expect(metrics.pickerResult()).toBe(null);
                expect(metrics.discoveryComplete()).toBe(null);
                expect(metrics.cardVisible("media-1")).toBe(null);
                expect(metrics.stageStart("copy", "media-1")).toBe(null);
                expect(metrics.stageEnd("copy", "media-1", "success")).toBe(null);
                expect(metrics.observeLane("filesystem", 4, 2)).toBe(null);
                expect(metrics.observeProcessCount(1)).toBe(null);
                expect(metrics.observeDecoderCount(1)).toBe(null);
                expect(metrics.recordCardPatch(false, "card missing")).toBe(null);
                expect(metrics.recordLongWork("copy", 400)).toBe(null);
                expect(metrics.markUnavailable("memory.peak", "disabled")).toBe(null);
                expect(metrics.observeMemory()).toBe(null);
                // Phase work still runs; only the recording is suppressed.
                let ran = 0;
                expect(metrics.phase("copy", function () { ran += 1; return "value"; })).toBe("value");
                expect(ran).toBe(1);
                expect(metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 })).toBe(null);
                expect(metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 })).toBe(null);
                expect(metrics.dispose()).toBe(null);
            });
        } finally {
            unsubscribe();
            restoreObserver();
            recorder.restore();
        }

        expect(captured).toEqual([]);
        expect(recorder.count()).toBe(0);
        expect(constructions.count).toBe(0);
    });
});
