/**
 * Targeted startup examples — panel-reopen-startup
 * ================================================
 *
 * EXAMPLE tests only: no `fc.property`, no `fc.asyncProperty`. Four frozen
 * facts of the startup path, each read out of the shipped source rather than a
 * restatement of it:
 *
 *   1. `First_Batch` is a fixed source constant of 60 with no Settings key and
 *      no viewport measurement anywhere in the sizing path (Requirement 3.1,
 *      3.6).
 *   2. The startup trace prints exactly one console line, and the single
 *      `startupTrace.print()` call site in js/main.js is guarded by
 *      `__CS_DEBUG__` (Requirements 4.8, 4.9).
 *   3. The two frozen `connectDefaultLibrary` toasts, neither of which invokes
 *      the callback (Requirements 6.10, 6.11).
 *   4. The 1200-check readiness degrade boundary: one DEGRADED transition, one
 *      `markWorkEnd("startup", ...)`, interval cleared and token disposed
 *      (Requirement 2.7).
 *
 * **Validates: Requirements 3.1, 4.8, 4.9, 6.10, 6.11, 2.7**
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../..");
const MAIN = fs.readFileSync(path.join(ROOT, "js/main.js"), "utf8");
const TEMPLATES = fs.readFileSync(path.join(ROOT, "js/templates/templates.js"), "utf8");
const OBSERVABILITY = fs.readFileSync(path.join(ROOT, "js/core/observability.js"), "utf8");
const lifecycleModule = require(path.join(ROOT, "js/core/appLifecycle.js"));

// ─── Source extraction (same shape the existing harnesses use) ──────────────

/** Returns the full `function ... { ... }` text starting at `marker`. */
function extractFunctionExpression(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) throw new Error("Missing source marker: " + marker);
    const start = source.indexOf("function", markerIndex);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}") {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error("Unterminated function for marker: " + marker);
}

/** An inert stand-in for every host global the source may touch on load. */
function inertValue() {
    let proxy;
    const fn = function () { return proxy; };
    proxy = new Proxy(fn, {
        get: function () { return proxy; },
        apply: function () { return proxy; },
        construct: function () { return proxy; },
    });
    return proxy;
}

/**
 * Loads the real js/templates/templates.js into a vm realm whose unknown
 * globals resolve to inert values, so the module's own `var` declarations are
 * the only thing the test reads back.
 */
function loadTemplatesRealm() {
    const inert = inertValue();
    const backing = { Object, Array, JSON, Math, Date, String, Number, Boolean, RegExp, Error, Promise };
    backing.console = { log: function () { }, warn: function () { }, error: function () { } };
    const sandbox = new Proxy(backing, {
        has: function () { return true; },
        get: function (target, key) {
            return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : inert;
        },
        set: function (target, key, value) { target[key] = value; return true; },
    });
    backing.window = sandbox;
    backing.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(TEMPLATES, sandbox, { filename: "templates.js" });
    return backing;
}

// ─── 1. First_Batch is a fixed source constant of 60 ────────────────────────

const FIRST_BATCH_DECL = /^var TEMPLATE_FIRST_BATCH = (-?\d+);$/m;
const APPEND_BATCH_DECL = /^var TEMPLATE_APPEND_BATCH = (-?\d+);$/m;

/** Everything that participates in sizing a startup render pass. */
const SIZING_MARKERS = [
    "function renderCardsFirstBatch(",
    "function appendCardBatch(",
    "function queueStartupDeferredWork(",
    "function startupAppendUnit(",
];

/** Inputs that would make First_Batch dynamic if they appeared in sizing code. */
const DYNAMIC_SIZING_INPUTS = [
    /Settings\s*\.\s*get\s*\(/,
    /innerHeight/,
    /innerWidth/,
    /clientHeight/,
    /clientWidth/,
    /offsetHeight/,
    /offsetWidth/,
    /getBoundingClientRect/,
    /matchMedia/,
    /devicePixelRatio/,
    /getComputedStyle/,
    /scrollHeight/,
];

describe("First_Batch is a fixed source constant of 60", function () {
    test("the real templates.js realm exposes 60 for both batch constants", function () {
        const realm = loadTemplatesRealm();
        expect(realm.TEMPLATE_FIRST_BATCH).toBe(60);
        expect(realm.TEMPLATE_APPEND_BATCH).toBe(60);
    });

    test("both declarations are numeric literals in source", function () {
        const first = FIRST_BATCH_DECL.exec(TEMPLATES);
        const append = APPEND_BATCH_DECL.exec(TEMPLATES);
        expect(first).not.toBeNull();
        expect(append).not.toBeNull();
        expect(first[1]).toBe("60");
        expect(append[1]).toBe("60");
        // Exactly one declaration each: no later reassignment can resize it.
        expect((TEMPLATES.match(/TEMPLATE_FIRST_BATCH\s*=/g) || []).length).toBe(1);
        expect((TEMPLATES.match(/TEMPLATE_APPEND_BATCH\s*=/g) || []).length).toBe(1);
    });

    test("no Settings key and no viewport measurement sizes the batches", function () {
        const sizingSource = SIZING_MARKERS
            .map(function (marker) { return extractFunctionExpression(TEMPLATES, marker); })
            .join("\n");
        // Guard the extraction itself: the sizing source must really be the
        // code that reads the constants.
        expect(sizingSource).toContain("TEMPLATE_FIRST_BATCH");
        expect(sizingSource).toContain("TEMPLATE_APPEND_BATCH");

        const offenders = DYNAMIC_SIZING_INPUTS.filter(function (pattern) {
            return pattern.test(sizingSource);
        }).map(String);
        expect(offenders).toEqual([]);
    });
});

// ─── 2. The debug-flag print branches ───────────────────────────────────────

const CONSOLE_CHANNELS = ["log", "info", "warn", "error", "debug", "trace"];

/** Loads the real observability.js and returns the recorder plus console spy. */
function createRealTrace(generation) {
    const calls = [];
    const sandbox = { performance: { now: function () { return 1000; } }, console: {} };
    CONSOLE_CHANNELS.forEach(function (channel) {
        sandbox.console[channel] = function (message) { calls.push({ channel: channel, message: String(message) }); };
    });
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(OBSERVABILITY, sandbox, { filename: "observability.js" });
    return {
        trace: sandbox.PerfEvents.createStartupTrace({ generation: generation }),
        calls: calls,
    };
}

/** The exact `__CS_DEBUG__` declaration line from js/main.js. */
function debugFlagDeclaration() {
    const match = /^\s*var __CS_DEBUG__ = .*$/m.exec(MAIN);
    if (!match) throw new Error("Missing __CS_DEBUG__ declaration in js/main.js");
    return match[0].trim();
}

/** Every source line in js/main.js that calls `startupTrace.print(`. */
function printCallLines() {
    return MAIN.split(/\r?\n/).filter(function (line) {
        return /startupTrace\s*\.\s*print\s*\(/.test(line);
    });
}

/**
 * Runs the real declaration line plus the real print call line against a
 * FeatureFlags double, so the branch under test is shipped source.
 */
function runDebugBranch(flagValue, printLine) {
    let prints = 0;
    const context = {
        FeatureFlags: { flags: { debugHostReload: flagValue } },
        startupTrace: { print: function () { prints++; return "summary"; } },
    };
    vm.createContext(context);
    vm.runInContext(debugFlagDeclaration() + "\n" + printLine.trim(), context, {
        filename: "main-debug-branch.js",
    });
    return { prints: prints, flag: context.__CS_DEBUG__ };
}

describe("startup trace printing is debug-flag gated", function () {
    test("the real recorder's print() emits exactly one console.log", function () {
        const real = createRealTrace(3);
        const summary = real.trace.print();

        expect(typeof summary).toBe("string");
        expect(summary).toContain("startup trace gen 3");
        expect(real.calls.length).toBe(1);
        expect(real.calls[0].channel).toBe("log");
        expect(real.calls[0].message).toBe(summary);
    });

    test("js/main.js has one print call site and it is guarded by __CS_DEBUG__", function () {
        const lines = printCallLines();
        expect(lines.length).toBe(1);
        expect(lines[0]).toMatch(/if\s*\(\s*__CS_DEBUG__\s*\)\s*startupTrace\s*\.\s*print\s*\(\s*\)\s*;/);
        expect(debugFlagDeclaration()).toMatch(/FeatureFlags\.flags\.debugHostReload === true/);
    });

    test("the guarded call site prints only when debugHostReload is true", function () {
        const lines = printCallLines();

        const enabled = runDebugBranch(true, lines[0]);
        expect(enabled.flag).toBe(true);
        expect(enabled.prints).toBe(1);

        const disabled = runDebugBranch(false, lines[0]);
        expect(disabled.flag).toBe(false);
        expect(disabled.prints).toBe(0);
    });
});

// ─── 3. The two frozen connectDefaultLibrary toasts ─────────────────────────

/**
 * Runs the real `connectDefaultLibrary` from js/main.js against a bridge double.
 * `hexPath` is what `encodeBridge(getDefaultRootPath())` resolves with, and
 * `decoded` is what `decodeBridge` returns for it.
 */
function runConnectDefaultLibrary(hexPath, decoded) {
    const source = extractFunctionExpression(MAIN, "function connectDefaultLibrary(");
    const scripts = [];
    const toasts = [];
    const context = {
        callbackCalls: 0,
        csInterface: {
            evalScript: function (script, done) {
                scripts.push(String(script));
                if (typeof done !== "function") return;
                if (String(script) === "encodeBridge(getDefaultRootPath())") done(hexPath);
                else done("ok");
            },
        },
        showToast: function (message, severity) { toasts.push([message, severity]); },
        encodeBridge: function (value) { return "encoded:" + value; },
        decodeBridge: function () { return decoded; },
        rootPath: "",
        savePath: "",
        libraryPaths: [],
    };
    vm.createContext(context);
    vm.runInContext(source + "\nconnectDefaultLibrary(function () { callbackCalls++; });", context, {
        filename: "main-connect-default-library.js",
    });
    return {
        scripts: scripts,
        toasts: toasts,
        callbackCalls: context.callbackCalls,
        rootPath: context.rootPath,
        savePath: context.savePath,
        libraryPaths: context.libraryPaths,
    };
}

describe("connectDefaultLibrary failure toasts", function () {
    test("no hex path shows Cannot connect to AE and never invokes the callback", function () {
        const run = runConnectDefaultLibrary("", "C:/library");

        expect(run.toasts).toEqual([["Cannot connect to AE", "error"]]);
        expect(run.callbackCalls).toBe(0);
        // Only the discovery round trip happened: no ensureFolder.
        expect(run.scripts).toEqual(["encodeBridge(getDefaultRootPath())"]);
        expect(run.rootPath).toBe("");
        expect(run.libraryPaths).toEqual([]);
    });

    test("an empty decoded path shows Invalid library path and never invokes the callback", function () {
        const run = runConnectDefaultLibrary("6162", "");

        expect(run.toasts).toEqual([["Invalid library path", "error"]]);
        expect(run.callbackCalls).toBe(0);
        expect(run.scripts).toEqual(["encodeBridge(getDefaultRootPath())"]);
        expect(run.rootPath).toBe("");
        expect(run.libraryPaths).toEqual([]);
    });
});

// ─── 4. The 1200-check readiness degrade boundary ───────────────────────────

const READINESS_MARKER = "var readinessTimer = setInterval(function () {";

/**
 * Runs the real readiness callback once, with `startChecks` checks already
 * recorded and no usable card in the document, against the real AppLifecycle.
 */
function exerciseDegradeBoundary(startChecks) {
    const transitions = [];
    const workEnds = [];
    const lifecycle = lifecycleModule.createAppLifecycle();
    const transition = lifecycle.transition;
    const markWorkEnd = lifecycle.markWorkEnd;
    lifecycle.transition = function (state) {
        transitions.push(state);
        return transition(state);
    };
    lifecycle.markWorkEnd = function (owner, id) {
        workEnds.push([owner, id]);
        return markWorkEnd(owner, id);
    };
    lifecycle.transition("BOOTSTRAPPING");
    lifecycle.markWorkStart("startup", "default-library");
    lifecycle.transition("SHELL_VISIBLE");
    transitions.length = 0;

    let clearIntervalCalls = 0;
    let timerCancelCalls = 0;
    const token = lifecycle.register("timer", 1, function () { timerCancelCalls++; });
    let tokenDisposals = 0;

    const context = {
        allTemplates: [],
        currentSection: "comp",
        currentMainModule: "templates",
        MODULES: { TEMPLATES: "templates", TOOLKIT: "toolkit", SETTINGS: "settings" },
        getTemplateSection: function (template) { return template.section; },
        document: {
            getElementById: function (id) {
                return id === "template-count" ? { textContent: "0" } : null;
            },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
        },
        AppLifecycle: lifecycle,
        clearInterval: function () { clearIntervalCalls++; },
        __token: {
            dispose: function () { tokenDisposals++; token.dispose(); },
        },
    };
    vm.createContext(context);
    const callback = extractFunctionExpression(MAIN, READINESS_MARKER);
    vm.runInContext(
        "var readinessChecks=" + startChecks + ",readinessTimer=1," +
        "readinessTimerToken=__token," +
        "lifecycleLibraryWorkId='default-library';(" + callback + ")();",
        context,
        { filename: "main-readiness-callback.js" }
    );

    return {
        state: lifecycle.getState(),
        transitions: transitions,
        workEnds: workEnds,
        clearIntervalCalls: clearIntervalCalls,
        tokenDisposals: tokenDisposals,
        timerCancelCalls: timerCancelCalls,
        residualTimers: lifecycle.snapshotCounts().timer,
    };
}

describe("readiness degrades at exactly 1200 checks", function () {
    test("the readiness marker js/main.js exposes is unchanged", function () {
        expect(MAIN.indexOf(READINESS_MARKER)).toBeGreaterThan(-1);
        expect((MAIN.match(/readinessChecks >= 1200/g) || []).length).toBe(1);
    });

    test("check 1200 with no usable card transitions DEGRADED and ends startup once", function () {
        const degraded = exerciseDegradeBoundary(1199);

        expect(degraded.transitions).toEqual(["DEGRADED"]);
        expect(degraded.state).toBe("DEGRADED");
        expect(degraded.workEnds).toEqual([["startup", "default-library"]]);
        expect(degraded.clearIntervalCalls).toBe(1);
        expect(degraded.tokenDisposals).toBe(1);
        expect(degraded.timerCancelCalls).toBe(1);
        expect(degraded.residualTimers).toBeUndefined();
    });

    test("check 1199 keeps polling: no transition, no work end, no teardown", function () {
        const polling = exerciseDegradeBoundary(1198);

        expect(polling.transitions).toEqual([]);
        expect(polling.state).toBe("SHELL_VISIBLE");
        expect(polling.workEnds).toEqual([]);
        expect(polling.clearIntervalCalls).toBe(0);
        expect(polling.tokenDisposals).toBe(0);
        expect(polling.residualTimers).toBe(1);
    });
});
