"use strict";

const Support = require("./mediaValidationSupport");
const Protocol = require("./mediaMeasurementProtocol");

function protocol() {
    return Protocol.createFrozenMeasurementProtocol({ id: "task-11-1" });
}

function measuredRun(kind, value) {
    return {
        kind,
        observations: [{ scenario: kind, measurement: "picker-to-card", valueMs: value, available: true }],
        unavailable: [],
        longTasks: [{ phase: "card insertion", durationMs: 55 + value, source: "phase span" }],
        lanes: {
            filesystem: { maximumPendingDepth: 3, maximumActiveCount: 2 },
            thumbnail: { maximumPendingDepth: 2, maximumActiveCount: 1 },
            ffmpeg: { maximumPendingDepth: 1, maximumActiveCount: 1 },
        },
        peaks: {
            ffmpegProcesses: 1,
            childProcesses: 1,
            postIdleChildProcesses: 0,
            videoDecoders: 1,
            postIdleVideoDecoders: 0,
        },
        memory: { before: 100, peak: 180, postIdle: 110, source: "performance.memory" },
        failedKeyedPatches: value === 10 ? 1 : 0,
    };
}

describe("media validation support", function () {
    test("continues every test and evidence item and aggregates all required failures", async function () {
        const executed = [];
        const summary = await Support.runValidationItems([
            {
                type: "test", name: "targeted", command: "jest targeted", run: async function () {
                    executed.push("targeted");
                    throw new Error("targeted failed");
                }
            },
            {
                type: "evidence", name: "manual codec", run: function () {
                    executed.push("codec");
                    return { status: "unavailable", reason: "CEP runtime unavailable" };
                }
            },
            {
                type: "test", name: "direct module", run: function () {
                    executed.push("direct");
                    return { status: "passed", details: { suites: 2 } };
                }
            },
        ]);

        expect(executed).toEqual(["targeted", "codec", "direct"]);
        expect(summary.results.map(function (item) { return item.status; }))
            .toEqual(["failed", "unavailable", "passed"]);
        expect(summary.failures.map(function (item) { return item.name; }))
            .toEqual(["targeted", "manual codec"]);
        expect(summary.classification).toBe("incomplete");
    });
    test("reports measurements, changed files, codec result, long tasks, and resource peaks", async function () {
        const validation = await Support.runValidationItems([
            { type: "test", name: "targeted", run: function () { return true; } },
            { type: "evidence", name: "manual", run: function () { return true; } },
        ]);
        const report = Support.createValidationReport({
            protocol: protocol(),
            baselineRuns: [measuredRun("oneFile", 10), measuredRun("oneFile", 20)],
            changeSetRuns: [measuredRun("oneFile", 5), measuredRun("oneFile", 8)],
            changedFiles: ["tests\\z.test.js", "./js/core/a.js", "js/core/a.js"],
            residualCodecLimitations: [],
            validation,
            manualChecksPassed: true,
        });

        expect(report.changedFiles).toEqual(["js/core/a.js", "tests/z.test.js"]);
        expect(report.measurements.percentileMethod).toBe("nearest-rank");
        expect(report.measurements.comparisons["oneFile.picker-to-card"]).toMatchObject({
            baseline: { p50: 10, p95: 20 },
            changeSet: { p50: 5, p95: 8 },
        });
        expect(report.longTasks.baseline).toMatchObject({ count: 2 });
        expect(report.longTasks.baseline.items[0]).toMatchObject({
            scenario: "oneFile", phase: "card insertion", durationMs: 65,
        });
        expect(report.resources.baseline).toMatchObject({
            ffmpegProcesses: { peak: 1 },
            childProcesses: { peak: 1, postIdle: 0 },
            videoDecoders: { peak: 1, postIdle: 0 },
            failedKeyedCardUpdates: 1,
        });
        expect(report.resources.baseline.memory[0]).toMatchObject({
            available: true, before: 100, peak: 180, postIdle: 110,
        });
        expect(report.residualCodec).toEqual({
            status: "none-observed", noneObserved: true, limitations: [],
        });
        expect(report.unavailableResults).toEqual({ baseline: [], changeSet: [], resources: [] });
        expect(report.classification).toBe("complete");
    });
    test("retains unavailable evidence and classifies omitted required fields as incomplete", function () {
        const sparse = {
            kind: "mixed50",
            observations: [{ scenario: "mixed50", measurement: "copy", valueMs: 12, available: true }],
            unavailable: [{ scenario: "mixed50", measurement: "memory.before", reason: "memory API unavailable" }],
            lanes: {}, peaks: {}, memory: {}, longTasks: [], failedKeyedPatches: 0,
        };
        const report = Support.createValidationReport({
            protocol: protocol(),
            baselineRuns: [sparse],
            changeSetRuns: [sparse],
            validation: { results: [], failures: [], classification: "complete" },
        });

        expect(report.classification).toBe("incomplete");
        expect(report.residualCodec).toMatchObject({
            status: "unavailable", reason: "residual codec result omitted",
        });
        expect(report.unavailableResults.baseline).toContainEqual({
            scenario: "mixed50", measurement: "memory.before", reason: "memory API unavailable",
        });
        expect(report.unavailableResults.resources.some(function (entry) {
            return entry.dataset === "changeSet" && entry.measurement === "videoDecoders.peak";
        })).toBe(true);
        expect(report.validation.failures.map(function (failure) { return failure.name; }))
            .toEqual(expect.arrayContaining(["changed-files", "residual-codec", "manual-validation"]));
    });

    test("records observed residual codec limitations without losing structured details", function () {
        const limitation = { codec: "ProRes 4444", scenario: "fallback MOV", reason: "decoder unavailable" };
        const report = Support.createValidationReport({
            protocol: protocol(),
            baselineRuns: [measuredRun("oneFile", 10)],
            changeSetRuns: [measuredRun("oneFile", 7)],
            changedFiles: ["tests/performance/mediaValidationSupport.js"],
            residualCodecLimitations: [limitation],
            validation: { results: [], failures: [], classification: "complete" },
            manualChecksPassed: true,
        });

        expect(report.residualCodec).toEqual({
            status: "observed", noneObserved: false, limitations: [limitation],
        });
        expect(report.classification).toBe("complete");
    });
});
