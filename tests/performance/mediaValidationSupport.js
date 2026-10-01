"use strict";

const Protocol = require("./mediaMeasurementProtocol");

function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") {
        return Object.keys(value).reduce(function (copy, key) {
            copy[key] = clone(value[key]);
            return copy;
        }, {});
    }
    return value;
}

function normalizeChangedFiles(files) {
    const seen = Object.create(null);
    return (files || []).reduce(function (result, entry) {
        const raw = typeof entry === "string" ? entry : entry && (entry.path || entry.file);
        const file = String(raw || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
        if (file && !seen[file]) {
            seen[file] = true;
            result.push(file);
        }
        return result;
    }, []).sort();
}

function resultStatus(value) {
    if (value === undefined || value === true || value && value.ok === true) return "passed";
    if (value === false || value && value.ok === false) return "failed";
    const status = value && value.status;
    if (status === "pass" || status === "passed") return "passed";
    if (status === "unavailable" || status === "omitted") return status;
    return "failed";
}

async function runValidationItems(items) {
    const results = [];
    for (let index = 0; index < (items || []).length; index++) {
        const item = items[index] || {};
        let value;
        let error;
        try {
            if (typeof item.run !== "function") {
                value = { status: "omitted", reason: "validation item has no executable" };
            } else {
                value = await item.run();
            }
        } catch (caught) {
            error = caught;
            value = { status: "failed", reason: caught && caught.message || String(caught) };
        }
        const status = resultStatus(value);
        results.push({
            index,
            type: item.type || "test",
            name: item.name || "validation-item-" + (index + 1),
            command: item.command || null,
            required: item.required !== false,
            status,
            reason: value && value.reason || error && error.message || null,
            details: value && value.details !== undefined ? clone(value.details) : null,
        });
    }
    const failures = results.filter(function (result) {
        return result.required && result.status !== "passed";
    });
    return { results, failures, classification: failures.length ? "incomplete" : "complete" };
}
function maximum(values) {
    const available = (values || []).filter(finite);
    return available.length ? Math.max.apply(Math, available) : null;
}

function unavailableFor(run, measurement, fallbackReason) {
    const match = (run && run.unavailable || []).find(function (entry) {
        return entry.measurement === measurement;
    });
    return match && match.reason || fallbackReason;
}

function summarizeMemory(runs, label, unavailable) {
    return (runs || []).map(function (run, index) {
        const memory = run && run.memory || {};
        const available = finite(memory.before) && finite(memory.peak) && finite(memory.postIdle);
        if (!available) {
            unavailable.push({
                dataset: label,
                scenario: run && run.kind || "unknown",
                run: index + 1,
                measurement: "memory",
                reason: unavailableFor(run, "memory.before",
                    unavailableFor(run, "memory.peak",
                        unavailableFor(run, "memory.postIdle", "before, peak, or post-idle memory unavailable"))),
            });
        }
        return available ? {
            available: true,
            scenario: run.kind || "unknown",
            run: index + 1,
            before: memory.before,
            peak: memory.peak,
            postIdle: memory.postIdle,
            source: memory.source || "unknown",
        } : {
            available: false,
            scenario: run && run.kind || "unknown",
            run: index + 1,
            reason: unavailable[unavailable.length - 1].reason,
        };
    });
}

function resourceCount(runs, field, postIdleField, label, dataset, unavailable) {
    const peakValues = (runs || []).map(function (run) { return run && run.peaks && run.peaks[field]; });
    const idleValues = (runs || []).map(function (run) { return run && run.peaks && run.peaks[postIdleField]; });
    if (maximum(peakValues) === null) unavailable.push({
        dataset, scenario: "all", measurement: label + ".peak", reason: "resource peak unavailable",
    });
    if (maximum(idleValues) === null) unavailable.push({
        dataset, scenario: "all", measurement: label + ".postIdle", reason: "post-idle resource count unavailable",
    });
    return {
        peak: maximum(peakValues),
        postIdle: maximum(idleValues),
        peakValues: peakValues.filter(finite),
        postIdleValues: idleValues.filter(finite),
    };
}

function summarizeResources(runs, label, unavailable) {
    const laneNames = Object.create(null);
    (runs || []).forEach(function (run) {
        Object.keys(run && run.lanes || {}).forEach(function (name) { laneNames[name] = true; });
    });
    const lanes = Object.keys(laneNames).sort().reduce(function (result, name) {
        const records = (runs || []).map(function (run) { return run && run.lanes && run.lanes[name]; }).filter(Boolean);
        result[name] = {
            maximumPendingDepth: maximum(records.map(function (lane) { return lane.maximumPendingDepth; })),
            peakActiveCount: maximum(records.map(function (lane) { return lane.maximumActiveCount; })),
        };
        return result;
    }, {});
    const ffmpegValues = (runs || []).map(function (run) { return run && run.peaks && run.peaks.ffmpegProcesses; });
    if (maximum(ffmpegValues) === null) unavailable.push({
        dataset: label, scenario: "all", measurement: "ffmpegProcesses.peak", reason: "FFmpeg process peak unavailable",
    });
    return {
        lanes,
        ffmpegProcesses: { peak: maximum(ffmpegValues), values: ffmpegValues.filter(finite) },
        childProcesses: resourceCount(runs, "childProcesses", "postIdleChildProcesses", "childProcesses", label, unavailable),
        videoDecoders: resourceCount(runs, "videoDecoders", "postIdleVideoDecoders", "videoDecoders", label, unavailable),
        memory: summarizeMemory(runs, label, unavailable),
        failedKeyedCardUpdates: (runs || []).reduce(function (total, run) {
            return total + (finite(run && run.failedKeyedPatches) ? run.failedKeyedPatches : 0);
        }, 0),
    };
}
function longTaskSummary(runs) {
    const items = [];
    (runs || []).forEach(function (run, runIndex) {
        (run && run.longTasks || []).forEach(function (task) {
            items.push({
                scenario: run.kind || "unknown",
                run: runIndex + 1,
                phase: task.phase || "unattributed",
                durationMs: task.durationMs,
                source: task.source || "unknown",
            });
        });
    });
    return { count: items.length, items };
}

function codecResult(limitations) {
    if (!Array.isArray(limitations)) {
        return { status: "unavailable", noneObserved: false, limitations: [], reason: "residual codec result omitted" };
    }
    return limitations.length ? {
        status: "observed", noneObserved: false, limitations: clone(limitations),
    } : {
        status: "none-observed", noneObserved: true, limitations: [],
    };
}

function evidenceFailure(type, name, reason) {
    return { type: type, name: name, status: "unavailable", reason: reason, required: true };
}

function createValidationReport(input) {
    input = input || {};
    const baselineRuns = input.baselineRuns || [];
    const changeSetRuns = input.changeSetRuns || [];
    const measurementReport = Protocol.createMeasurementReport(
        input.protocol, baselineRuns, changeSetRuns, input.evidence
    );
    const unavailable = {
        baseline: measurementReport.unavailable.baseline.map(clone),
        changeSet: measurementReport.unavailable.changeSet.map(clone),
        resources: [],
    };
    const changedFiles = normalizeChangedFiles(input.changedFiles);
    const residualCodec = codecResult(input.residualCodecLimitations);
    const validation = input.validation || { results: [], failures: [], classification: "complete" };
    const failures = (validation.failures || []).map(clone);

    if (!Object.keys(measurementReport.comparisons).length) {
        failures.push(evidenceFailure("evidence", "measurements", "no baseline/change-set measurement results"));
    }
    if (!changedFiles.length) {
        failures.push(evidenceFailure("evidence", "changed-files", "complete changed-file list omitted"));
    }
    if (residualCodec.status === "unavailable") {
        failures.push(evidenceFailure("evidence", "residual-codec", residualCodec.reason));
        unavailable.changeSet.push({ scenario: "validation", measurement: "residual-codec", reason: residualCodec.reason });
    }
    if (input.manualChecksPassed !== true) {
        failures.push(evidenceFailure("evidence", "manual-validation", "manual validation did not report a passing result"));
    }

    const resources = {
        baseline: summarizeResources(baselineRuns, "baseline", unavailable.resources),
        changeSet: summarizeResources(changeSetRuns, "changeSet", unavailable.resources),
    };
    unavailable.resources.forEach(function (entry) {
        failures.push(evidenceFailure("evidence", entry.dataset + "." + entry.measurement, entry.reason));
    });
    unavailable.baseline.concat(unavailable.changeSet).forEach(function (entry) {
        failures.push(evidenceFailure("evidence", (entry.scenario || "unknown") + "." + entry.measurement, entry.reason));
    });

    return {
        protocol: measurementReport.protocol,
        measurements: {
            percentileMethod: "nearest-rank",
            comparisons: measurementReport.comparisons,
        },
        longTasks: {
            baseline: longTaskSummary(baselineRuns),
            changeSet: longTaskSummary(changeSetRuns),
        },
        resources,
        residualCodec,
        unavailableResults: unavailable,
        changedFiles,
        validation: {
            results: (validation.results || []).map(clone),
            failures,
        },
        evidence: measurementReport.evidence,
        classification: failures.length ? "incomplete" : "complete",
    };
}

module.exports = {
    normalizeChangedFiles,
    runValidationItems,
    createValidationReport,
};
