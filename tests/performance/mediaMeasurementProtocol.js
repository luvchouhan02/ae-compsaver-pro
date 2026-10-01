"use strict";

/*
 * Harness-only protocol and report utilities. They are intentionally not
 * imported by product startup or rendering code.
 */

const PROTOCOL_VERSION = "media-engine-lag-v1";
const DEFAULT_SCENARIOS = {
    oneFile: { runs: 5, input: "one supported media file" },
    mixed50: { runs: 5, fileCount: 50, input: "the same ordered mixed-50 folder" },
    catalog500: {
        optional: true,
        harnessOnly: true,
        recordCount: 500,
        renderRuns: 5,
        scrollInteractions: 10,
        selectionInteractions: 10,
    },
};

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") {
        return Object.keys(value).reduce(function (result, key) {
            result[key] = clone(value[key]);
            return result;
        }, {});
    }
    return value;
}

function freeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { freeze(value[key]); });
    return Object.freeze(value);
}

function createFrozenMeasurementProtocol(input) {
    input = input || {};
    const protocol = {
        id: input.id || PROTOCOL_VERSION,
        version: PROTOCOL_VERSION,
        environment: clone(input.environment || {}),
        inputs: clone(input.inputs || {}),
        initialLibraryIndex: clone(input.initialLibraryIndex || null),
        cacheState: clone(input.cacheState || null),
        restartSteps: clone(input.restartSteps || []),
        scenarioOrder: clone(input.scenarioOrder || ["oneFile", "mixed50", "catalog500"]),
        instrumentation: clone(input.instrumentation || {}),
        scenarios: clone(DEFAULT_SCENARIOS),
    };
    return freeze(protocol);
}

function finiteValues(observations) {
    return (observations || []).reduce(function (values, observation) {
        const value = typeof observation === "number" ? observation : observation && observation.valueMs;
        const available = typeof observation === "number" || !observation || observation.available !== false;
        if (available && isFiniteNumber(value)) values.push(value);
        return values;
    }, []);
}

function nearestRank(values, percentile) {
    const sorted = (values || []).filter(isFiniteNumber).slice().sort(function (a, b) { return a - b; });
    if (!sorted.length) return null;
    const rank = Math.max(1, Math.ceil(percentile * sorted.length));
    return sorted[rank - 1];
}

function unavailableFromRun(run) {
    return (run && run.unavailable || []).map(function (entry) {
        return {
            scenario: entry.scenario || run.kind || "unknown",
            measurement: entry.measurement || "unknown",
            reason: entry.reason || "unavailable",
        };
    });
}

function observationsFromRun(run) {
    const observations = (run && run.observations || []).map(function (entry) {
        return clone(entry);
    });
    if (!run) return observations;
    [
        ["picker.result", run.pickerResultMs],
        ["discovery.complete", run.discoveryCompleteMs],
        ["card.first-visible", run.firstCardVisibleMs],
    ].forEach(function (pair) {
        if (isFiniteNumber(pair[1]) && !observations.some(function (entry) { return entry.measurement === pair[0]; })) {
            observations.push({ scenario: run.kind || "unknown", measurement: pair[0], valueMs: pair[1], available: true });
        }
    });
    (run.stages || []).forEach(function (stage) {
        const measurement = "stage." + stage.stage + ".duration";
        if (isFiniteNumber(stage.durationMs) && !observations.some(function (entry) {
            return entry.measurement === measurement && entry.mediaId === stage.mediaId;
        })) {
            observations.push({
                scenario: run.kind || "unknown", measurement,
                valueMs: stage.durationMs, available: true,
                mediaId: stage.mediaId, outcome: stage.outcome,
            });
        }
    });
    return observations;
}

function summarize(observations, unavailable) {
    const values = finiteValues(observations);
    return {
        availableCount: values.length,
        p50: nearestRank(values, 0.50),
        p95: nearestRank(values, 0.95),
        values: values.slice().sort(function (a, b) { return a - b; }),
        unavailable: (unavailable || []).map(clone),
    };
}

function addRuns(buckets, runs, label, unavailable) {
    (runs || []).forEach(function (run) {
        observationsFromRun(run).forEach(function (observation) {
            const key = (observation.scenario || run.kind || "unknown") + "." + observation.measurement;
            if (!buckets[key]) buckets[key] = { baseline: [], changeSet: [] };
            buckets[key][label].push(observation);
        });
        unavailableFromRun(run).forEach(function (entry) {
            const key = entry.scenario + "." + entry.measurement;
            if (!buckets[key]) buckets[key] = { baseline: [], changeSet: [] };
            unavailable[label].push(entry);
        });
    });
}

function createMeasurementReport(protocol, baselineRuns, changeSetRuns, evidence) {
    if (!protocol || protocol.version !== PROTOCOL_VERSION) {
        throw new Error("A frozen media-engine-lag measurement protocol is required");
    }
    const buckets = {};
    const unavailable = { baseline: [], changeSet: [] };
    addRuns(buckets, baselineRuns, "baseline", unavailable);
    addRuns(buckets, changeSetRuns, "changeSet", unavailable);
    const comparisons = Object.keys(buckets).sort().reduce(function (result, key) {
        result[key] = {
            baseline: summarize(buckets[key].baseline, unavailable.baseline.filter(function (entry) {
                return key.indexOf(entry.scenario + "." + entry.measurement) === 0;
            })),
            changeSet: summarize(buckets[key].changeSet, unavailable.changeSet.filter(function (entry) {
                return key.indexOf(entry.scenario + "." + entry.measurement) === 0;
            })),
        };
        return result;
    }, {});
    return {
        protocol: clone(protocol),
        comparisons,
        unavailable,
        evidence: clone(evidence || {}),
    };
}

function createProtocolRunPlan(protocol, includeCatalog) {
    if (!protocol || protocol.version !== PROTOCOL_VERSION) {
        throw new Error("A frozen media-engine-lag measurement protocol is required");
    }
    const plan = [];
    function push(kind, count, details) {
        for (let index = 0; index < count; index++) plan.push({ kind, run: index + 1, details: clone(details) });
    }
    push("oneFile", protocol.scenarios.oneFile.runs, protocol.scenarios.oneFile);
    push("mixed50", protocol.scenarios.mixed50.runs, protocol.scenarios.mixed50);
    if (includeCatalog === true) {
        push("catalog500.render", protocol.scenarios.catalog500.renderRuns, protocol.scenarios.catalog500);
        push("catalog500.scroll", protocol.scenarios.catalog500.scrollInteractions, protocol.scenarios.catalog500);
        push("catalog500.selection", protocol.scenarios.catalog500.selectionInteractions, protocol.scenarios.catalog500);
    }
    return plan;
}

module.exports = {
    PROTOCOL_VERSION,
    DEFAULT_SCENARIOS: freeze(clone(DEFAULT_SCENARIOS)),
    createFrozenMeasurementProtocol,
    createProtocolRunPlan,
    finiteValues,
    nearestRank,
    observationsFromRun,
    summarize,
    createMeasurementReport,
};
