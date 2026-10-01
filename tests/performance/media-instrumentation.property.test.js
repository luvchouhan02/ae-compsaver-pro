"use strict";
const path = require("path");
const fc = require("fast-check");
const PerfEvents = require(path.resolve(__dirname, "../../js/core/observability.js"));
const protocolUtilities = require(path.resolve(__dirname, "mediaMeasurementProtocol.js"));

const STAGES = ["copy", "thumbnail", "proxy"];
const UNAVAILABLE_MEASUREMENTS = [
    "picker.result",
    "discovery.complete",
    "card.first-visible",
    "lane.filesystem.pending",
    "memory.peak",
];

/** Deterministic clock so recorded stage durations are exactly the generated values. */
function installClock() {
    const original = global.performance;
    const state = { value: 1000 };
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

/** Independent nearest-rank reference: sort ascending, take index ceil(p*n)-1. */
function referencePercentile(values, percentile) {
    if (!values.length) return null;
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const rank = Math.max(1, Math.ceil(percentile * sorted.length));
    return sorted[rank - 1];
}

function countMatching(entries, predicate) {
    return entries.filter(predicate).length;
}

describe("media instrumentation percentile reporting", function () {
    test("nearest-rank percentiles use only available observations", function () {
        /**
         * Feature: media-engine-lag, Property 1: Percentiles use only available observations
         * **Validates: Requirements 1.6, 1.8**
         */
        fc.assert(fc.property(
            fc.array(fc.record({
                stage: fc.constantFrom.apply(fc, STAGES),
                durationMs: fc.integer({ min: 0, max: 5000 }),
                available: fc.boolean(),
            }), { minLength: 1, maxLength: 12 }),
            fc.array(fc.record({
                measurement: fc.constantFrom.apply(fc, UNAVAILABLE_MEASUREMENTS),
                reason: fc.string({ minLength: 1, maxLength: 24 }),
            }), { maxLength: 5 }),
            fc.constantFrom("oneFile", "mixed50"),
            function (measurements, unavailableInputs, kind) {
                const clock = installClock();
                let report;
                try {
                    const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
                    metrics.start(kind, "media-engine-lag-v1");
                    measurements.forEach(function (measurement, index) {
                        const mediaId = "media-" + index;
                        if (measurement.available) metrics.stageStart(measurement.stage, mediaId);
                        clock.advance(measurement.durationMs);
                        metrics.stageEnd(measurement.stage, mediaId, "success");
                    });
                    unavailableInputs.forEach(function (entry) {
                        metrics.markUnavailable(entry.measurement, entry.reason);
                    });
                    report = metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 });
                    metrics.dispose();
                } finally {
                    clock.restore();
                }

                const observations = protocolUtilities.observationsFromRun(report);

                // Percentiles per measurement come only from available finite durations.
                STAGES.forEach(function (stage) {
                    const key = "stage." + stage + ".duration";
                    const expected = measurements
                        .filter(function (item) { return item.stage === stage && item.available; })
                        .map(function (item) { return item.durationMs; });
                    const summary = protocolUtilities.summarize(
                        observations.filter(function (item) { return item.measurement === key; }),
                        report.unavailable.filter(function (item) { return item.measurement === key; })
                    );
                    expect(summary.availableCount).toBe(expected.length);
                    expect(summary.values).toEqual(expected.slice().sort(function (a, b) { return a - b; }));
                    expect(summary.p50).toBe(referencePercentile(expected, 0.5));
                    expect(summary.p95).toBe(referencePercentile(expected, 0.95));
                });

                // Every excluded observation keeps its scenario, measurement, and reason.
                report.unavailable.forEach(function (entry) {
                    expect(entry.scenario).toBe(kind);
                    expect(typeof entry.measurement).toBe("string");
                    expect(entry.measurement.length).toBeGreaterThan(0);
                    expect(typeof entry.reason).toBe("string");
                    expect(entry.reason.length).toBeGreaterThan(0);
                });
                unavailableInputs.forEach(function (input) {
                    const expectedCount = countMatching(unavailableInputs, function (item) {
                        return item.measurement === input.measurement && item.reason === input.reason;
                    });
                    expect(countMatching(report.unavailable, function (entry) {
                        return entry.measurement === input.measurement && entry.reason === input.reason;
                    })).toBeGreaterThanOrEqual(expectedCount);
                });

                // Uncapturable stage measurements are reported with a reason and never substituted.
                measurements.forEach(function (measurement, index) {
                    if (measurement.available) return;
                    const key = "stage." + measurement.stage + ".duration";
                    expect(observations.some(function (item) {
                        return item.measurement === key && item.mediaId === "media-" + index;
                    })).toBe(false);
                    expect(report.unavailable.some(function (entry) {
                        return entry.measurement === key && entry.reason === "stage end without stage start";
                    })).toBe(true);
                });

                // Unavailable entries are excluded from the percentile input set entirely.
                expect(protocolUtilities.finiteValues(report.unavailable).length).toBe(0);
                return true;
            }
        ), { numRuns: 200, seed: 10206 });
    });
});

/** Counts every console channel a stray hover trace could use. */
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
        restore: function () {
            channels.forEach(function (channel) { console[channel] = originals[channel]; });
        },
    };
}

describe("media instrumentation aggregate emission", function () {
    test("scenario summary is emitted at most once and hover events emit nothing", function () {
        /**
         * Feature: media-engine-lag, Property 2: Scenario instrumentation emits once and ignores hover
         * **Validates: Requirements 1.7**
         */
        fc.assert(fc.property(
            fc.array(fc.oneof(
                fc.record({ kind: fc.constant("hoverEnter"), decoders: fc.integer({ min: 0, max: 1 }) }),
                fc.record({ kind: fc.constant("hoverMove"), decoders: fc.integer({ min: 0, max: 1 }) }),
                fc.record({ kind: fc.constant("hoverLeave"), decoders: fc.constant(0) }),
                fc.record({ kind: fc.constant("finish"), decoders: fc.integer({ min: 0, max: 1 }) }),
                fc.record({ kind: fc.constant("stage"), decoders: fc.constant(0) })
            ), { minLength: 1, maxLength: 16 }),
            fc.constantFrom("oneFile", "mixed50"),
            function (events, kind) {
                const recorder = installConsoleRecorder();
                const captured = [];
                const unsubscribe = PerfEvents.subscribe(function (event) { captured.push(event); });
                let hoverEventCount = 0;
                let finishCount = 0;
                try {
                    const metrics = PerfEvents.createMediaScenarioMetrics({ enabled: true });
                    metrics.start(kind, "media-engine-lag-v1");
                    events.forEach(function (event, index) {
                        const eventsBefore = captured.length;
                        const consoleBefore = recorder.count();
                        if (event.kind === "finish") {
                            finishCount += 1;
                            metrics.finishScenario({ childProcesses: 0, videoDecoders: event.decoders });
                            return;
                        }
                        if (event.kind === "stage") {
                            metrics.stageStart("thumbnail", "media-" + index);
                            metrics.stageEnd("thumbnail", "media-" + index, "success");
                            return;
                        }
                        // Individual pointer-hover events: observation only, never a trace or event.
                        hoverEventCount += 1;
                        metrics.observeDecoderCount(event.decoders);
                        metrics.observeLane("thumbnail", 0, event.decoders);
                        expect(captured.length).toBe(eventsBefore);
                        expect(recorder.count()).toBe(consoleBefore);
                    });
                    metrics.dispose();
                } finally {
                    unsubscribe();
                    recorder.restore();
                }

                const summaries = captured.filter(function (event) { return event.name === "media.scenario"; });
                // At most one aggregate scenario summary, regardless of repeated finish calls.
                expect(summaries.length).toBeLessThanOrEqual(1);
                expect(summaries.length).toBe(finishCount > 0 ? 1 : 0);
                // No event of any kind is produced by hover events, and none traced to console.
                expect(captured.length).toBe(summaries.length);
                expect(recorder.count()).toBe(0);
                if (summaries.length === 1) {
                    expect(summaries[0].fields.kind).toBe(kind);
                    expect(hoverEventCount).toBeGreaterThanOrEqual(0);
                }
                return true;
            }
        ), { numRuns: 200, seed: 40317 });
    });
});
