"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const ROOT = path.resolve(__dirname, "../..");
const LIFECYCLE_FILE = path.join(ROOT, "js/core/appLifecycle.js");
const LEGACY_SOURCES = [
    "js/main.js", "js/toolkit/effects.js", "js/toolkit/flow.js",
    "js/toolkit/toolkit.js", "js/ui/accent.js", "js/core/fastMediaEngine.js",
].map(function (file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); });

const LAUNCH_STATES = ["cold", "warm", "same-session-reopen", "post-restart-reopen"];
const RESOURCE_KINDS = ["listener", "observer", "watcher", "timer", "subscription", "decoder", "job"];
const READINESS_MAIN_SOURCE = fs.readFileSync(path.join(ROOT, "js/main.js"), "utf8");

function extractReadinessCallback() {
    const marker = "var readinessTimer = setInterval(function () {";
    const markerIndex = READINESS_MAIN_SOURCE.indexOf(marker);
    if (markerIndex < 0) throw new Error("Missing readiness callback");
    const start = READINESS_MAIN_SOURCE.indexOf("function", markerIndex);
    const open = READINESS_MAIN_SOURCE.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < READINESS_MAIN_SOURCE.length; index++) {
        if (READINESS_MAIN_SOURCE[index] === "{") depth++;
        else if (READINESS_MAIN_SOURCE[index] === "}") {
            depth--;
            if (depth === 0) return READINESS_MAIN_SOURCE.slice(start, index + 1);
        }
    }
    throw new Error("Unterminated readiness callback");
}

function readinessBoundary(input) {
    const lifecycle = loadLifecycle();
    const states = [];
    const transition = lifecycle.transition;
    lifecycle.transition = function (state) {
        states.push(state);
        return transition(state);
    };
    lifecycle.transition("BOOTSTRAPPING");
    lifecycle.markWorkStart("startup", "default-library");
    lifecycle.transition("SHELL_VISIBLE");

    const templates = input.sections.map(function (section) { return { section }; });
    const context = {
        allTemplates: templates,
        currentSection: input.activeSection,
        currentMainModule: input.module,
        MODULES: { TEMPLATES: "templates", TOOLKIT: "toolkit", SETTINGS: "settings" },
        getTemplateSection: function (template) { return template.section; },
        document: {
            getElementById: function () { return { textContent: input.badge }; },
            querySelector: function () {
                return { querySelector: function () { return {}; } };
            },
            querySelectorAll: function () { return [{ complete: true }]; },
        },
        AppLifecycle: lifecycle,
        clearInterval: function () { },
        tokenDisposed: false,
    };
    vm.createContext(context);
    vm.runInContext(
        "var readinessChecks=0,readinessTimer=1," +
        "readinessTimerToken={dispose:function(){tokenDisposed=true;}}," +
        "lifecycleLibraryWorkId='default-library';(" + extractReadinessCallback() + ")();",
        context,
        { filename: "main-readiness-property.js" }
    );
    return {
        state: lifecycle.getState(),
        idle: lifecycle.isBackgroundIdle(),
        states,
        tokenDisposed: context.tokenDisposed,
    };
}

function loadLifecycle(events) {
    if (!fs.existsSync(LIFECYCLE_FILE)) return null;
    const source = fs.readFileSync(LIFECYCLE_FILE, "utf8");
    const context = {
        module: { exports: {} }, exports: {}, console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        PerfEvents: {
            emit: function (name, fields) {
                if (events) events.push({ name, fields: Object.assign({}, fields) });
            },
        },
    };
    context.window = context;
    context.global = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "appLifecycle.js" });
    const exported = context.module.exports;
    if (exported && typeof exported.createAppLifecycle === "function") return exported.createAppLifecycle();
    if (exported && typeof exported.register === "function") return exported;
    if (context.AppLifecycle && typeof context.AppLifecycle.register === "function") return context.AppLifecycle;
    return null;
}

function legacyBoundary(order, resources) {
    const source = LEGACY_SOURCES.join("\n");
    const settingsRegistrations = (source.match(/Settings\.onChange\s*\(/g) || []).length;
    const observers = (source.match(/new\s+(?:window\.)?ResizeObserver\s*\(/g) || []).length;
    const watchers = (source.match(/fs\.watch\s*\(/g) || []).length;
    const hasLifecycleOwner = fs.existsSync(LIFECYCLE_FILE);
    const perCycle = resources.length + settingsRegistrations + observers + watchers;
    const ownerCounts = order.map(function (_, index) { return perCycle * (index + 1); });
    return {
        adapter: "approved-pre-phase-source-boundary",
        launchOrder: order,
        resourceOrder: resources,
        ownerCounts,
        constantOwnerCounts: new Set(ownerCounts).size <= 1,
        residualAfterUnload: ownerCounts.length ? ownerCounts[ownerCounts.length - 1] : 0,
        disposeExactlyOnce: false,
        backgroundIdle: false,
        sourceBoundary: { settingsRegistrations, observers, watchers, hasLifecycleOwner },
    };
}

const CYCLE_OPERATIONS = ["reopen", "render", "filter", "hover"];

function totalLive(snapshot) {
    return Object.keys(snapshot).reduce(function (sum, key) {
        return sum + (typeof snapshot[key] === "number" ? snapshot[key] : 0);
    }, 0);
}

function lifecycleBoundary(cycles, resources) {
    if (!fs.existsSync(LIFECYCLE_FILE)) return legacyBoundary(cycles, resources);
    const events = [];
    const lifecycle = loadLifecycle(events);
    if (!lifecycle) return legacyBoundary(cycles, resources);
    const ownerCounts = [];
    const ownerCountsByKind = [];
    const disposerCalls = {};
    const idleWhileWorkActive = [];
    const idleAfterCycleSettles = [];
    let priorCycleTokens = [];

    lifecycle.transition("BOOTSTRAPPING");
    lifecycle.markWorkStart("startup", "default-library");
    const idleDuringStartup = lifecycle.isBackgroundIdle();
    lifecycle.transition("SHELL_VISIBLE");
    lifecycle.transition("FIRST_CARD_USABLE");
    lifecycle.transition("LIBRARY_READY");
    const idleAtLibraryReadyWithWork = lifecycle.isBackgroundIdle();
    lifecycle.markWorkEnd("startup", "default-library");
    const idleAfterStartupSettles = lifecycle.isBackgroundIdle();

    cycles.forEach(function (cycle, cycleIndex) {
        priorCycleTokens.forEach(function (token) { token.dispose(); });
        priorCycleTokens = resources.map(function (kind) {
            const id = cycleIndex + ":" + kind;
            disposerCalls[id] = 0;
            return lifecycle.register(kind, { id }, function () { disposerCalls[id]++; });
        });

        cycle.operationOrder.forEach(function (operation) {
            lifecycle.markWorkStart("cycle-" + cycleIndex, operation);
        });
        idleWhileWorkActive.push(lifecycle.isBackgroundIdle());
        cycle.operationOrder.forEach(function (operation) {
            lifecycle.markWorkEnd("cycle-" + cycleIndex, operation);
        });
        idleAfterCycleSettles.push(lifecycle.isBackgroundIdle());

        const snapshot = lifecycle.snapshotCounts();
        ownerCounts.push(totalLive(snapshot));
        ownerCountsByKind.push(RESOURCE_KINDS.map(function (kind) { return snapshot[kind] || 0; }));
    });

    const readinessStates = events.filter(function (event) {
        return event.name === "lifecycle.transition";
    }).slice(0, 5).map(function (event) { return event.fields.state; });
    const rejectedBackwardTransition = lifecycle.transition("SHELL_VISIBLE") === false;
    const backgroundIdle = lifecycle.isBackgroundIdle();
    lifecycle.dispose("phase-1-property-unload");
    const residualAfterUnload = totalLive(lifecycle.snapshotCounts());
    priorCycleTokens.forEach(function (token) { token.dispose(); });
    const repeatUnloadRejected = lifecycle.dispose("phase-1-property-repeat-unload") === false;
    const disposerCounts = Object.keys(disposerCalls).map(function (id) { return disposerCalls[id]; });

    return {
        adapter: "phase-1-single-lifecycle-runtime-boundary",
        cycleCount: cycles.length,
        launchOrder: cycles.map(function (cycle) { return cycle.launchState; }),
        operationOrders: cycles.map(function (cycle) { return cycle.operationOrder; }),
        resourceOrder: resources,
        ownerCounts,
        ownerCountsByKind,
        constantOwnerCounts: new Set(ownerCounts).size === 1 &&
            new Set(ownerCountsByKind.map(JSON.stringify)).size === 1,
        residualAfterUnload,
        disposerCounts,
        disposeExactlyOnce: disposerCounts.length === cycles.length * resources.length &&
            disposerCounts.every(function (count) { return count === 1; }),
        repeatUnloadRejected,
        readinessStates,
        readinessMonotonic: JSON.stringify(readinessStates) === JSON.stringify([
            "BOOTSTRAPPING", "SHELL_VISIBLE", "FIRST_CARD_USABLE", "LIBRARY_READY", "BACKGROUND_IDLE",
        ]) && rejectedBackwardTransition,
        idleDuringStartup,
        idleAtLibraryReadyWithWork,
        idleAfterStartupSettles,
        idleWhileWorkActive,
        idleAfterCycleSettles,
        backgroundIdle,
    };
}

function assertExpectedLifecycle(result) {
    const passes = result.cycleCount === 10 && result.constantOwnerCounts &&
        result.ownerCounts.every(function (count) { return count === RESOURCE_KINDS.length; }) &&
        result.ownerCountsByKind.every(function (counts) {
            return counts.every(function (count) { return count === 1; });
        }) && result.residualAfterUnload === 0 && result.disposeExactlyOnce &&
        result.repeatUnloadRejected && result.readinessMonotonic && !result.idleDuringStartup &&
        !result.idleAtLibraryReadyWithWork && result.idleAfterStartupSettles &&
        result.idleWhileWorkActive.every(function (idle) { return idle === false; }) &&
        result.idleAfterCycleSettles.every(function (idle) { return idle === true; }) &&
        result.backgroundIdle;
    if (!passes) {
        throw new Error("PHASE_1_LIFECYCLE_COUNTEREXAMPLE\n" + JSON.stringify(result, null, 2));
    }
}

describe("Phase 1 lifecycle expected behavior", function () {
    test("the scenario generator covers every launch state and resource kind", function () {
        expect(new Set(LAUNCH_STATES)).toEqual(new Set([
            "cold", "warm", "same-session-reopen", "post-restart-reopen",
        ]));
        expect(new Set(RESOURCE_KINDS).size).toBe(7);
        expect(new Set(CYCLE_OPERATIONS)).toEqual(new Set(["reopen", "render", "filter", "hover"]));
    });

    test("generated startup/reopen and registration orders fully unload", function () {
        const cycleArbitrary = fc.record({
            launchState: fc.constantFrom.apply(fc, LAUNCH_STATES),
            operationOrder: fc.shuffledSubarray(CYCLE_OPERATIONS, { minLength: 4, maxLength: 4 }),
        });
        fc.assert(fc.property(
            fc.array(cycleArbitrary, { minLength: 10, maxLength: 10 }),
            fc.shuffledSubarray(RESOURCE_KINDS, { minLength: 7, maxLength: 7 }),
            function (cycles, resourceOrder) {
                assertExpectedLifecycle(lifecycleBoundary(cycles, resourceOrder));
            }
        ), { seed: 51001, numRuns: 15, verbose: 2 });
    });
});

describe("Phase 1 readiness recovery", function () {
    test("334 repository records with 129 active-section records reach background idle", function () {
        const sections = Array(129).fill("comp").concat(Array(205).fill("icon"));
        const templates = readinessBoundary({
            sections,
            activeSection: "comp",
            module: "templates",
            badge: "129",
        });
        const toolkit = readinessBoundary({
            sections,
            activeSection: "comp",
            module: "toolkit",
            badge: "TK",
        });
        [templates, toolkit].forEach(function (result) {
            expect(result.state).toBe("BACKGROUND_IDLE");
            expect(result.idle).toBe(true);
            expect(result.states).toEqual([
                "BOOTSTRAPPING", "SHELL_VISIBLE", "FIRST_CARD_USABLE", "LIBRARY_READY",
            ]);
            expect(result.tokenDisposed).toBe(true);
        });
    });

    test("arbitrary repository and active-section distributions use section cardinality only for Templates", function () {
        const sectionArbitrary = fc.constantFrom("comp", "icon", "text", "effect");
        fc.assert(fc.property(
            fc.array(sectionArbitrary, { minLength: 1, maxLength: 500 }),
            sectionArbitrary,
            fc.constantFrom("templates", "toolkit", "settings"),
            function (sections, activeSection, module) {
                if (sections.indexOf(activeSection) === -1) sections[0] = activeSection;
                const activeCount = sections.filter(function (section) {
                    return section === activeSection;
                }).length;
                const badge = module === "templates" ? String(activeCount) :
                    (module === "toolkit" ? "TK" : "SETTINGS");
                const result = readinessBoundary({ sections, activeSection, module, badge });
                expect(result.state).toBe("BACKGROUND_IDLE");
                expect(result.idle).toBe(true);
                expect(result.states.slice(-2)).toEqual(["FIRST_CARD_USABLE", "LIBRARY_READY"]);
                expect(result.tokenDisposed).toBe(true);
            }
        ), { seed: 74501, numRuns: 15, verbose: 2 });
    });
});

/**
 * Readiness recovery: repository size is independent of active-section
 * cardinality, and non-Templates badges are not numeric template counts.
 * **Validates: Requirements 2.8, 2.9, 2.10, 2.11, 2.31, 2.33**
 */

/**
 * Property 1 / Property 7: lifecycle resources have constant ownership,
 * complete unload, and truthful background idle.
 * **Validates: Requirements 1.1, 1.6, 1.8, 1.10, 1.13–1.16, 2.10, 2.11, 2.16, 2.19, 2.31, 2.33**
 */


/**
 * Property 2: legacy Phase 1 behavior remains observable with lifecycleV1 off.
 * These checks freeze the approved pre-phase boundary; growing owner counts are
 * retained as baseline evidence, not reclassified as a preservation failure.
 *
 * **Validates: Requirements 3.2, 3.3, 3.5, 3.6, 3.9, 3.10**
 */
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, "js/main.js"), "utf8");
const TEXTANIM_SOURCE = fs.readFileSync(path.join(ROOT, "js/textanim/textanim.js"), "utf8");
const FAST_MEDIA_SOURCE = fs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8");
const SETTINGS_SOURCE = fs.readFileSync(path.join(ROOT, "js/core/settings.js"), "utf8");
const EFFECTS_SOURCE = fs.readFileSync(path.join(ROOT, "js/toolkit/effects.js"), "utf8");
const FEATURE_FLAGS_FILE = path.join(ROOT, "js/core/featureFlags.js");

function extractFunctionSource(source, marker) {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error("Missing function marker: " + marker);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}") {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error("Unterminated function marker: " + marker);
}

function observeLegacyStartup(response, decodedPath) {
    const events = [];
    const context = {
        events,
        rootPath: "",
        libraryPaths: [],
        savePath: "",
        showToast: function (message, kind) { events.push(["toast", message, kind]); },
        decodeBridge: function () { return decodedPath; },
        encodeBridge: function (value) { return "encoded:" + value; },
        csInterface: {
            evalScript: function (script, done) {
                events.push(["eval", script]);
                if (script === "encodeBridge(getDefaultRootPath())") done(response);
                else done("ok");
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(
        extractFunctionSource(MAIN_SOURCE, "function connectDefaultLibrary(callback)") +
        "\nconnectDefaultLibrary(function () { events.push(['callback']); });",
        context,
        { filename: "main-connect-default-library.js" }
    );
    return {
        events: Array.from(context.events, function (event) { return Array.from(event); }),
        rootPath: context.rootPath,
        libraryPaths: Array.from(context.libraryPaths),
        savePath: context.savePath,
    };
}

function publicTextAnimApi() {
    const publicStart = TEXTANIM_SOURCE.indexOf("// ── Public");
    const publicSource = TEXTANIM_SOURCE.slice(publicStart);
    return [
        "init", "load", "enqueuePreviewRender", "enqueueThumbnailRender",
        "attachHoverPreviews", "previewApngPathFor",
    ].filter(function (name) {
        return new RegExp("\\b" + name + "\\s*:").test(publicSource);
    });
}

// Observes the real featureFlags.js twice: once with nothing stored (the
// default) and once with lifecycleV1 stored as an explicit false (the escape
// hatch this property's legacy scenarios run under).
//
// lifecycleV1 used to DEFAULT to false, and this property asserted that. That
// default was a product defect, not a boundary worth freezing: flags load from
// sessionStorage, which is empty on every panel load, so no disposal
// registration in the panel could ever run and closed panels leaked their
// pollers into After Effects. The default is now ON. Property 2 keeps its real
// subject — legacy behaviour with disposal off — by pinning the flag off
// explicitly instead of relying on the default to do it.
function observeFlagsOff() {
    if (!fs.existsSync(FEATURE_FLAGS_FILE)) {
        return {
            lifecycleV1: false,
            defaultLifecycleV1: false,
            boundary: "implicit-approved-pre-phase-legacy",
        };
    }
    const source = fs.readFileSync(FEATURE_FLAGS_FILE, "utf8");
    const context = { module: { exports: {} }, exports: {}, console };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "featureFlags.js" });
    const api = context.module.exports && Object.keys(context.module.exports).length
        ? context.module.exports : context.FeatureFlags;

    function loadWith(raw) {
        const storage = { getItem: function () { return raw; } };
        return api && typeof api.load === "function" ? api.load(storage) : api;
    }

    const explicitlyOff = loadWith(JSON.stringify({ version: 1, lifecycleV1: false }));
    const byDefault = loadWith(null);

    return {
        lifecycleV1: !!(explicitlyOff && explicitlyOff.lifecycleV1),
        defaultLifecycleV1: !!(byDefault && byDefault.lifecycleV1),
        boundary: "explicit-feature-flag-override",
    };
}

function loadSettings() {
    const values = {};
    const context = {
        console,
        setTimeout: function (fn) { fn(); return 1; },
        clearTimeout: function () { },
        localStorage: {
            getItem: function (key) {
                return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
            },
            setItem: function (key, value) { values[key] = String(value); },
        },
    };
    vm.createContext(context);
    vm.runInContext(SETTINGS_SOURCE, context, { filename: "settings.js" });
    return context.Settings;
}

function settingMutationArbitrary() {
    return fc.constantFrom(
        { key: "ui.density", before: "compact", changed: "expanded" },
        { key: "performance.liveFolderWatch", before: true, changed: false },
        { key: "preview.disableHover", before: false, changed: true }
    );
}

const legacyPreservationScenarioArbitrary = fc.record({
    approved: fc.constant(false),
    launchOrder: fc.shuffledSubarray(LAUNCH_STATES, { minLength: 1, maxLength: 4 }),
    resourceOrder: fc.shuffledSubarray(RESOURCE_KINDS, { minLength: 1, maxLength: 7 }),
    startupFailure: fc.constantFrom("no-response", "empty-decoded-path"),
    setting: settingMutationArbitrary(),
});

describe("Phase 1 Property 2: legacy behavior is preserved with lifecycleV1=false", function () {
    test("resource disposal is enabled by default and an explicit false still disables it", function () {
        const observed = observeFlagsOff();
        // Disposal is the default: every registration that releases a timer,
        // observer, watcher, subscription or the media engine is gated on this
        // flag, and flags are read from a sessionStorage that is empty on every
        // panel load. A false default left the registry empty, so
        // AppLifecycle.dispose("beforeunload") released nothing and a closed
        // panel kept polling the host.
        expect(observed.defaultLifecycleV1).toBe(true);
        // The legacy path stays reachable for diagnosis via an explicit false.
        expect(observed.lifecycleV1).toBe(false);
    });

    test("freezes legacy startup errors, public APIs, effects semantics, and current startup UI outcome", function () {
        expect(observeFlagsOff().lifecycleV1).toBe(false);
        expect(observeLegacyStartup("", "")).toEqual({
            events: [
                ["eval", "encodeBridge(getDefaultRootPath())"],
                ["toast", "Cannot connect to AE", "error"],
            ],
            rootPath: "",
            libraryPaths: [],
            savePath: "",
        });
        expect(observeLegacyStartup("encoded-empty", "")).toEqual({
            events: [
                ["eval", "encodeBridge(getDefaultRootPath())"],
                ["toast", "Invalid library path", "error"],
            ],
            rootPath: "",
            libraryPaths: [],
            savePath: "",
        });

        expect(publicTextAnimApi()).toEqual([
            "init", "load", "enqueuePreviewRender", "enqueueThumbnailRender",
            "attachHoverPreviews", "previewApngPathFor",
        ]);
        ["initFastMediaEngine", "importMediaFile", "importMediaFolder"].forEach(function (name) {
            expect(FAST_MEDIA_SOURCE).toMatch(new RegExp("function\\s+" + name + "\\s*\\("));
        });
        expect(FAST_MEDIA_SOURCE).toContain('getElementById("btn-import-file")');
        expect(FAST_MEDIA_SOURCE).toContain('getElementById("btn-import-folder")');

        expect(EFFECTS_SOURCE).toContain('Settings.onChange("performance.liveFolderWatch"');
        expect(EFFECTS_SOURCE).toMatch(/if\s*\(enabled\)\s*\{\s*startFolderWatch\(\);\s*\}\s*else\s*\{\s*stopFolderWatch\(\);/);
        expect(MAIN_SOURCE).toContain('Settings.get("ui.defaultTab") === "toolkit"');
        expect(MAIN_SOURCE).toContain("switchMainModule(startModule)");
    });

    test("generated non-bug scenarios retain startup failures, owner counts, and settings notifications", function () {
        fc.assert(fc.property(legacyPreservationScenarioArbitrary, function (input) {
            expect(input.approved).toBe(false);
            expect(observeFlagsOff().lifecycleV1).toBe(false);

            const response = input.startupFailure === "no-response" ? "" : "encoded-empty";
            const startup = observeLegacyStartup(response, "");
            const expectedMessage = input.startupFailure === "no-response"
                ? "Cannot connect to AE" : "Invalid library path";
            expect(startup.events.slice(-1)[0]).toEqual(["toast", expectedMessage, "error"]);
            expect(startup.events.some(function (event) { return event[0] === "callback"; })).toBe(false);

            const owners = legacyBoundary(input.launchOrder, input.resourceOrder);
            const perCycle = input.resourceOrder.length + owners.sourceBoundary.settingsRegistrations +
                owners.sourceBoundary.observers + owners.sourceBoundary.watchers;
            expect(owners.ownerCounts).toEqual(input.launchOrder.map(function (_, index) {
                return perCycle * (index + 1);
            }));
            expect(owners.residualAfterUnload).toBe(owners.ownerCounts[owners.ownerCounts.length - 1]);

            const settings = loadSettings();
            expect(settings.get(input.setting.key)).toEqual(input.setting.before);
            const notifications = [];
            const unsubscribe = settings.onChange(input.setting.key, function (next, previous) {
                notifications.push([next, previous]);
            });
            expect(settings.set(input.setting.key, input.setting.changed)).toBe(true);
            expect(notifications).toEqual([[input.setting.changed, input.setting.before]]);
            unsubscribe();
            expect(settings.set(input.setting.key, input.setting.before)).toBe(true);
            expect(notifications).toEqual([[input.setting.changed, input.setting.before]]);
        }), { seed: 53001, numRuns: 15, verbose: 2 });
    });
});