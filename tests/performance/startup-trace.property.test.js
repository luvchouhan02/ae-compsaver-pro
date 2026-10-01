"use strict";

// Property suite for the startup trace recorder in js/core/observability.js.
// The real source is loaded into a vm context so the recorder under test is the
// shipped code, with only the clock, console, rAF queue and PerfEvents view
// substituted at the boundary.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const ROOT = path.resolve(__dirname, "../..");
const OBSERVABILITY_SOURCE = fs.readFileSync(path.join(ROOT, "js/core/observability.js"), "utf8");

/** The startup phase whitelist named by the design (Requirement 4.1). */
const WHITELISTED_PHASES = [
    "startup.init",
    "startup.settings-restore",
    "startup.index-load",
    "startup.warm-paint",
    "startup.category-build",
    "startup.batch-append",
    "startup.validity-key",
    "startup.reconcile",
    "startup.bridge-scan",
    "startup.root-discovery",
    "startup.readiness",
];

/** Names that must never be recorded as spans: media phases, typos, empties. */
const NON_WHITELISTED_PHASES = [
    "startup.unknown",
    "startup.warmpaint",
    "startup.INIT",
    "copy",
    "picker return",
    "thumbnail generation",
    "phase.startup.init",
    "",
];

const CACHE_REASONS = [
    "index-parsed",
    "absent",
    "corrupt",
    "index-empty",
    "no-index-object",
    "no-library-paths",
    "warm-paint-error",
];

const CONSOLE_CHANNELS = ["log", "info", "warn", "error", "debug", "trace"];

/** Loads the real observability module into a fresh vm context. */
function createObservabilityContext(options) {
    const clock = { value: 1000 };
    const consoleCalls = [];
    const frames = [];
    const sandbox = {
        performance: {
            now: function () { return clock.value; },
        },
        console: {},
    };
    CONSOLE_CHANNELS.forEach(function (channel) {
        sandbox.console[channel] = function (message) { consoleCalls.push({ channel: channel, message: message }); };
    });
    if (options && options.requestAnimationFrame === true) {
        sandbox.requestAnimationFrame = function (fn) { frames.push(fn); return frames.length; };
    }
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(OBSERVABILITY_SOURCE, sandbox, { filename: "observability.js" });
    return {
        sandbox: sandbox,
        PerfEvents: sandbox.PerfEvents,
        advance: function (ms) { clock.value += ms; },
        consoleCalls: consoleCalls,
        flushFrames: function () {
            while (frames.length) { frames.shift()(); }
        },
    };
}

/** Startup_Controller view of PerfEvents for the three availability cases (Requirement 4.10). */
function perfEventsView(real, availability) {
    if (availability === "missing") return undefined;
    if (availability === "no-span") {
        return {
            beginStartupTrace: real.beginStartupTrace,
            startupPhases: real.startupPhases,
            subscribe: real.subscribe,
        };
    }
    return real;
}

/** The inert recorder the Startup_Controller falls back to; every method is a no-op. */
function inertStartupTrace() {
    const inertPhase = { end: function () { return null; } };
    const noop = function () { return null; };
    return {
        beginPhase: function () { return inertPhase; },
        noteWarmPaint: noop,
        noteCache: noop,
        noteValidity: noop,
        countBridgeScan: noop,
        noteBatch: noop,
        noteReadiness: noop,
        markUnavailable: noop,
        report: function () { return null; },
        print: noop,
    };
}

/** Models the caller's guarded wrapper in js/main.js (design: beginStartupTrace). */
function beginStartupTraceModel(view, options) {
    if (view && typeof view.span === "function" && typeof view.beginStartupTrace === "function") {
        const trace = view.beginStartupTrace(options);
        if (trace && typeof trace.beginPhase === "function") return trace;
    }
    return inertStartupTrace();
}

/** Models warm paint: renders at most the first batch of records, no trace arithmetic. */
function modelWarmPaint(records, firstBatch) {
    const grid = [];
    const limit = Math.min(records.length, firstBatch);
    for (let index = 0; index < limit; index++) grid.push("tpl-" + records[index]);
    return { painted: grid.length > 0 || records.length === 0, cards: grid.length };
}

/** Runs one modelled startup against the resolved trace, mirroring the design's phase order. */
function runSimulatedStartup(context, view, scenario) {
    const trace = beginStartupTraceModel(view, { generation: scenario.generation });
    const initPhase = trace.beginPhase("startup.init");

    context.advance(scenario.stepMs);
    for (let scan = 0; scan < scenario.preWarmScans; scan++) {
        trace.countBridgeScan("C:/lib/pre-" + scan);
        context.advance(scenario.stepMs);
    }

    const warmPhase = trace.beginPhase("startup.warm-paint", { cards: scenario.warmPaintCards });
    const warmPaint = modelWarmPaint(scenario.records, 60);
    context.advance(scenario.stepMs);
    trace.noteWarmPaint(scenario.warmPaintNote);
    trace.noteCache(scenario.cacheDecision, scenario.cacheReason);
    warmPhase.end({ cards: warmPaint.cards });

    for (let index = 0; index < scenario.phaseNames.length; index++) {
        const phase = trace.beginPhase(scenario.phaseNames[index], { unit: index });
        context.advance(scenario.stepMs);
        phase.end({ unit: index });
    }

    trace.noteValidity(scenario.validityDecision, scenario.changedRoots);
    for (let scan = 0; scan < scenario.postWarmScans; scan++) {
        trace.countBridgeScan("C:/lib/post-" + scan);
        context.advance(scenario.stepMs);
    }
    for (let batch = 0; batch < scenario.batches.length; batch++) {
        trace.noteBatch(scenario.batches[batch]);
        context.advance(scenario.stepMs);
    }
    trace.noteReadiness(scenario.readinessState, scenario.readinessChecks);

    initPhase.end({ warmPainted: warmPaint.painted });
    context.flushFrames();
    if (scenario.debugFlag === true) trace.print();

    return { trace: trace, warmPaint: warmPaint, completed: true };
}

function isWhitelisted(name) { return WHITELISTED_PHASES.indexOf(name) >= 0; }
function baseEventName(name) { return name.replace(/:(start|end)$/, ""); }

describe("startup trace recorder", function () {
    test("the startup trace is complete, whitelisted, and flag-gated", function () {
        /**
         * Feature: panel-reopen-startup, Property 10: The startup trace is complete, whitelisted, and flag-gated
         * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 4.10**
         */
        fc.assert(fc.property(
            fc.record({
                generation: fc.integer({ min: 1, max: 25 }),
                phaseNames: fc.array(
                    fc.oneof(
                        { weight: 3, arbitrary: fc.constantFrom.apply(fc, WHITELISTED_PHASES) },
                        { weight: 1, arbitrary: fc.constantFrom.apply(fc, NON_WHITELISTED_PHASES) },
                        { weight: 1, arbitrary: fc.string({ maxLength: 18 }) }
                    ),
                    { minLength: 1, maxLength: 14 }
                ),
                records: fc.array(fc.integer({ min: 0, max: 4000 }), { maxLength: 180 }),
                warmPaintCards: fc.integer({ min: 0, max: 60 }),
                warmPaintNote: fc.oneof(
                    { weight: 4, arbitrary: fc.integer({ min: 0, max: 60 }) },
                    { weight: 1, arbitrary: fc.constantFrom(null, undefined, NaN, Infinity, "60") }
                ),
                cacheDecision: fc.constantFrom("hit", "miss", true, false, "unknown"),
                cacheReason: fc.constantFrom.apply(fc, CACHE_REASONS.concat(["key-mismatch", 42])),
                validityDecision: fc.constantFrom("fresh", "stale", "unknown", "sideways"),
                changedRoots: fc.array(fc.constantFrom("C:/lib/a", "C:/lib/b", "D:/shared"), { maxLength: 3 }),
                preWarmScans: fc.integer({ min: 0, max: 4 }),
                postWarmScans: fc.integer({ min: 0, max: 4 }),
                batches: fc.array(fc.integer({ min: 0, max: 60 }), { maxLength: 8 }),
                readinessState: fc.constantFrom("LIBRARY_READY", "DEGRADED"),
                readinessChecks: fc.integer({ min: 0, max: 1200 }),
                debugFlag: fc.boolean(),
                availability: fc.constantFrom("present", "missing", "no-span"),
                hasRequestAnimationFrame: fc.boolean(),
                stepMs: fc.integer({ min: 0, max: 25 }),
            }),
            function (scenario) {
                const context = createObservabilityContext({
                    requestAnimationFrame: scenario.hasRequestAnimationFrame,
                });
                const events = [];
                const unsubscribe = context.PerfEvents.subscribe(function (event) { events.push(event); });
                let outcome;
                try {
                    outcome = runSimulatedStartup(
                        context,
                        perfEventsView(context.PerfEvents, scenario.availability),
                        scenario
                    );
                } finally {
                    unsubscribe();
                }

                // Startup and warm paint complete for every availability case (Requirement 4.10).
                expect(outcome.completed).toBe(true);
                expect(outcome.warmPaint.painted).toBe(true);
                expect(outcome.warmPaint.cards).toBe(Math.min(scenario.records.length, 60));

                const report = outcome.trace.report();
                const traceIsLive = report !== null;
                expect(traceIsLive).toBe(scenario.availability === "present");

                if (!traceIsLive) {
                    // PerfEvents (or its span) absent: span recording is skipped entirely.
                    expect(events.length).toBe(0);
                    expect(context.sandbox.window.__csStartupTrace).toBeUndefined();
                    expect(context.consoleCalls.length).toBe(0);
                } else {
                    // Every emitted name is whitelisted and arrives as a start/end pair (Req 4.1, 4.2, 4.3).
                    const startNames = [];
                    const endEvents = [];
                    events.forEach(function (event) {
                        const base = baseEventName(event.name);
                        expect(isWhitelisted(base)).toBe(true);
                        expect(/:(start|end)$/.test(event.name)).toBe(true);
                        if (/:start$/.test(event.name)) startNames.push(base);
                        else endEvents.push(event);
                    });
                    const endNames = endEvents.map(function (event) { return baseEventName(event.name); });
                    expect(startNames.slice().sort()).toEqual(endNames.slice().sort());

                    // Recorded phases match the emitted end events one for one, with finite durations.
                    expect(report.phases.length).toBe(endEvents.length);
                    report.phases.forEach(function (phase, index) {
                        expect(isWhitelisted(phase.name)).toBe(true);
                        expect(Number.isFinite(phase.durationMs)).toBe(true);
                        expect(phase.durationMs).toBeGreaterThanOrEqual(0);
                        expect(phase.name).toBe(baseEventName(endEvents[index].name));
                        expect(phase.durationMs).toBe(endEvents[index].fields.durationMs);
                    });

                    // Whitelisted names are spans; only non-whitelisted names are unknown phases (Req 4.2).
                    const whitelistedRecorded = scenario.phaseNames.filter(isWhitelisted);
                    const unknownRecorded = scenario.phaseNames.filter(function (name) { return !isWhitelisted(name); });
                    expect(report.phases.length).toBe(2 + whitelistedRecorded.length);
                    const unknownPhaseEntries = report.unavailable.filter(function (entry) {
                        return entry.reason === "unknown phase";
                    });
                    expect(unknownPhaseEntries.length).toBe(unknownRecorded.length);
                    unknownPhaseEntries.forEach(function (entry) {
                        expect(entry.measurement.indexOf("phase.")).toBe(0);
                        expect(isWhitelisted(entry.measurement.slice("phase.".length))).toBe(false);
                    });
                    WHITELISTED_PHASES.forEach(function (name) {
                        expect(unknownPhaseEntries.some(function (entry) {
                            return entry.measurement === "phase." + name;
                        })).toBe(false);
                    });

                    // Time-to-first-visible-template, cache decision and bridge-scan count (Req 4.6).
                    expect(Number.isFinite(report.firstVisibleTemplateMs)).toBe(true);
                    expect(report.firstVisibleTemplateMs).toBeGreaterThanOrEqual(0);
                    expect(Number.isFinite(report.firstVisibleTemplateCards)).toBe(true);
                    expect(report.firstVisibleTemplateCards).toBeGreaterThanOrEqual(0);
                    expect(["hit", "miss"]).toContain(report.cache.decision);
                    expect(typeof report.cache.reason).toBe("string");
                    expect(report.cache.reason.length).toBeGreaterThan(0);
                    expect(Number.isInteger(report.bridgeScans.beforeWarmPaint)).toBe(true);
                    expect(report.bridgeScans.beforeWarmPaint).toBe(scenario.preWarmScans);
                    expect(Number.isInteger(report.bridgeScans.total)).toBe(true);
                    expect(report.bridgeScans.total).toBe(scenario.preWarmScans + scenario.postWarmScans);

                    // Spans are recorded with no flag required (Requirement 4.4).
                    expect(events.length).toBeGreaterThanOrEqual(4);
                    expect(report.batches.count).toBe(scenario.batches.length);
                    expect(["fresh", "stale", "unknown"]).toContain(report.validity.decision);
                    expect(report.readiness.state).toBe(scenario.readinessState);
                    if (scenario.hasRequestAnimationFrame) {
                        expect(Number.isFinite(report.firstFrameAfterPaintMs)).toBe(true);
                    } else {
                        expect(report.firstFrameAfterPaintMs).toBeNull();
                    }

                    // Exactly one trace is retained, and it is this startup's report (Requirement 4.5).
                    expect(context.sandbox.window.__csStartupTrace).toBe(report);
                    expect(context.PerfEvents.startupTrace().report()).toBe(report);

                    // Console output happens if and only if the debug flag is set (Req 4.8, 4.9).
                    if (scenario.debugFlag === true) {
                        expect(context.consoleCalls.length).toBe(1);
                        expect(context.consoleCalls[0].channel).toBe("log");
                        expect(typeof context.consoleCalls[0].message).toBe("string");
                    } else {
                        expect(context.consoleCalls.length).toBe(0);
                    }
                }

                // A later startup replaces the retained trace: last startup wins (Requirement 4.5).
                const nextTrace = context.PerfEvents.beginStartupTrace({ generation: scenario.generation + 1 });
                const nextReport = nextTrace.report();
                expect(context.sandbox.window.__csStartupTrace).toBe(nextReport);
                expect(context.PerfEvents.startupTrace()).toBe(nextTrace);
                if (traceIsLive) expect(context.sandbox.window.__csStartupTrace).not.toBe(report);
                return true;
            }
        ), { numRuns: 15, seed: 51204 });
    });
});
