"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../..");
const MAIN = fs.readFileSync(path.join(ROOT, "js/main.js"), "utf8");
const FAST_MEDIA = fs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8");
const lifecycleModule = require(path.join(ROOT, "js/core/appLifecycle.js"));

function extractFunctionBody(source, marker) {
    const start = source.indexOf(marker);
    if (start < 0) return "";
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
            depth--;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    return "";
}

function countCalls(source, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (source.match(new RegExp("\\b" + escaped + "\\s*\\(", "g")) || []).length;
}

function extractFunctionExpression(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) throw new Error("Missing readiness marker: " + marker);
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
    throw new Error("Unterminated readiness callback");
}

function exerciseReadiness(input) {
    const transitions = [];
    const lifecycle = lifecycleModule.createAppLifecycle();
    const transition = lifecycle.transition;
    lifecycle.transition = function (state) {
        transitions.push(state);
        return transition(state);
    };
    lifecycle.transition("BOOTSTRAPPING");
    lifecycle.markWorkStart("startup", "default-library");
    lifecycle.transition("SHELL_VISIBLE");

    const templates = [];
    for (let index = 0; index < input.total; index++) {
        templates.push({ section: index < input.active ? "comp" : "icon" });
    }
    let timerCleared = false;
    let tokenDisposed = false;
    const firstCard = { querySelector: function () { return {}; } };
    const context = {
        allTemplates: templates,
        currentSection: "comp",
        currentMainModule: input.module,
        MODULES: { TEMPLATES: "templates", TOOLKIT: "toolkit", SETTINGS: "settings" },
        getTemplateSection: function (template) { return template.section; },
        document: {
            getElementById: function (id) {
                return id === "template-count" ? { textContent: input.badge } : null;
            },
            querySelector: function () { return firstCard; },
            querySelectorAll: function () { return [{ complete: true }]; },
        },
        AppLifecycle: lifecycle,
        clearInterval: function () { timerCleared = true; },
    };
    vm.createContext(context);
    const callback = extractFunctionExpression(MAIN, "var readinessTimer = setInterval(function () {");
    vm.runInContext(
        "var readinessChecks=0,readinessTimer=1," +
        "readinessTimerToken={dispose:function(){tokenDisposed=true;}}," +
        "lifecycleLibraryWorkId='default-library';(" + callback + ")();",
        Object.assign(context, {
            tokenDisposed: false,
        }),
        { filename: "main-readiness-callback.js" }
    );
    tokenDisposed = context.tokenDisposed;
    return {
        state: lifecycle.getState(),
        idle: lifecycle.isBackgroundIdle(),
        transitions,
        timerCleared,
        tokenDisposed,
    };
}

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

function executableStartupBoundary() {
    const calls = { loadSavedEffects: 0, switchMainModule: 0 };
    const errors = [];
    const listeners = {};
    const inert = inertValue();
    let nextTimer = 1;
    const lifecycle = lifecycleModule.createAppLifecycle();
    const classList = {
        add: function () { }, remove: function () { }, toggle: function () { return false; },
        contains: function () { return false; },
    };
    const body = {
        classList,
        style: {},
        offsetWidth: 1,
        getAttribute: function () { return null; },
        setAttribute: function () { },
    };
    const document = {
        body,
        documentElement: { style: {} },
        getElementById: function () { return null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        addEventListener: function () { },
    };
    function ResizeObserver() { }
    ResizeObserver.prototype.observe = function () { };
    ResizeObserver.prototype.disconnect = function () { };

    const backing = {
        Object, Array, JSON, Math, Date, String, Number, Boolean, RegExp, Error, Promise,
        console: {
            log: function () { }, warn: function () { },
            error: function () { errors.push(Array.prototype.join.call(arguments, " ")); },
        },
        document,
        FeatureFlags: { flags: { lifecycleV1: true, debugHostReload: false } },
        AppLifecycle: lifecycle,
        MODULES: { TEMPLATES: "templates", TOOLKIT: "toolkit", SETTINGS: "settings" },
        SECTIONS: { COMP: "comp", ICON: "icon", OVERLAY: "overlay", LAYER: "layer", TEXT: "text", FOOTAGE: "footage", EFFECT: "effect" },
        Settings: {
            get: function (key) {
                if (key === "ui.defaultTab") return "templates";
                if (key === "performance.pingInterval") return 30;
                if (/CardSize$/.test(key)) return "compact";
                return false;
            },
            onChange: function () { return function () { }; },
        },
        DOM: {}, libraryPaths: [], rootPath: "", savePath: "", allTemplates: [],
        currentMainModule: "templates", tmpBulkSelected: [],
        localStorage: { getItem: function () { return null; }, setItem: function () { } },
        csInterface: {
            evalScript: function (script, done) {
                if (typeof done === "function") {
                    if (script === "encodeBridge(getDefaultRootPath())") done("encoded-library");
                    else done("ok");
                }
            },
            getSystemPath: function () { return "C:/extension"; },
        },
        encodeBridge: function (value) { return "encoded:" + value; },
        decodeBridge: function (value) { return value === "encoded-library" ? "C:/library" : "ok"; },
        loadLibraryIndex: function () { return null; },
        loadSavedEffects: function () { calls.loadSavedEffects++; },
        switchMainModule: function () { calls.switchMainModule++; },
        ResizeObserver,
        setTimeout: function () { return nextTimer++; }, clearTimeout: function () { },
        setInterval: function () { return nextTimer++; }, clearInterval: function () { },
        requestAnimationFrame: function () { return nextTimer++; },
    };
    const sandbox = new Proxy(backing, {
        has: function () { return true; },
        get: function (target, key) {
            return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : inert;
        },
        set: function (target, key, value) { target[key] = value; return true; },
    });
    backing.window = sandbox;
    backing.globalThis = sandbox;
    backing.addEventListener = function (name, handler) { listeners[name] = handler; };
    backing.removeEventListener = function () { };
    backing.FastMedia = null;

    vm.createContext(sandbox);
    vm.runInContext(MAIN, sandbox, { filename: "main.js" });
    if (typeof backing.onload !== "function") throw new Error("main.js did not install executable window.onload");
    backing.onload();

    return {
        boundary: "full-main-js-vm-window-onload",
        effectsInitializationCount: calls.loadSavedEffects,
        initialModuleSelectionCount: calls.switchMainModule,
        startupCompletedWithoutError: errors.length === 0,
        registeredBeforeUnload: lifecycle.snapshotCounts(),
        beforeunloadRegistered: typeof listeners.beforeunload === "function",
    };
}

function observeStartupBoundary() {
    const init = extractFunctionBody(MAIN, "function init()");
    const bootstrapMarker = MAIN.includes("function bootstrapPanel(")
        ? "function bootstrapPanel(" : "window.onload = function";
    const bootstrap = extractFunctionBody(MAIN, bootstrapMarker);
    const unload = extractFunctionBody(MAIN, 'window.addEventListener("beforeunload"');
    const initDirectModule = (init.match(/^ {8}switchMainModule\s*\(/gm) || []).length;
    const bootstrapDirectModule = (bootstrap.match(/^ {12}switchMainModule\s*\(/gm) || []).length;
    const independentMediaBootstrap = /addEventListener\s*\(\s*["']DOMContentLoaded["']/.test(FAST_MEDIA);
    const runtime = executableStartupBoundary();

    return {
        effectsInitializationCount: countCalls(init, "loadSavedEffects"),
        initialModuleSelectionCount: initDirectModule + bootstrapDirectModule,
        unloadOwnsLifecycle: /AppLifecycle\.dispose\s*\(/.test(unload),
        mediaInitializationHasSoleOwner: !independentMediaBootstrap,
        readinessOwnedByLifecycle: /AppLifecycle\.markWorkStart\s*\(\s*["']startup["']/.test(init) &&
            /AppLifecycle\.transition\s*\(\s*["']FIRST_CARD_USABLE["']/.test(init) &&
            /AppLifecycle\.transition\s*\(\s*["']LIBRARY_READY["']/.test(init) &&
            /AppLifecycle\.markWorkEnd\s*\(\s*["']startup["']/.test(init),
        runtime,
        sourceBoundary: {
            bootstrapMarker,
            resizeObserverCreated: /new\s+(?:window\.)?ResizeObserver/.test(bootstrap),
            settingsSubscriptionCreated: /Settings\.onChange/.test(bootstrap),
            observerDisconnectedOnUnload: /disconnect\s*\(/.test(unload),
            independentMediaBootstrap,
        },
    };
}

function expectContainedStartup(observation) {
    const runtime = observation.runtime;
    const passes = observation.effectsInitializationCount === 1 &&
        observation.initialModuleSelectionCount === 1 && observation.unloadOwnsLifecycle &&
        observation.mediaInitializationHasSoleOwner && observation.readinessOwnedByLifecycle &&
        runtime.boundary === "full-main-js-vm-window-onload" &&
        runtime.effectsInitializationCount === 1 && runtime.initialModuleSelectionCount === 1 &&
        runtime.startupCompletedWithoutError && runtime.beforeunloadRegistered;
    if (!passes) {
        throw new Error("PHASE_1_STARTUP_COUNTEREXAMPLE\n" + JSON.stringify(observation, null, 2));
    }
}

describe("Phase 1 startup containment", function () {
    test("startup has one effects/module initialization and one disposable owner", function () {
        const observation = observeStartupBoundary();
        expectContainedStartup(observation);
        expect(observation.runtime.effectsInitializationCount).toBe(1);
        expect(observation.runtime.initialModuleSelectionCount).toBe(1);
    });

    test("readiness uses active-section cardinality for a 334-record repository", function () {
        const ready = exerciseReadiness({
            total: 334, active: 129, module: "templates", badge: "129",
        });
        expect(ready).toEqual({
            state: "BACKGROUND_IDLE",
            idle: true,
            transitions: ["BOOTSTRAPPING", "SHELL_VISIBLE", "FIRST_CARD_USABLE", "LIBRARY_READY"],
            timerCleared: true,
            tokenDisposed: true,
        });

        const repositoryWideBadge = exerciseReadiness({
            total: 334, active: 129, module: "templates", badge: "334",
        });
        expect(repositoryWideBadge.state).toBe("SHELL_VISIBLE");
        expect(repositoryWideBadge.idle).toBe(false);
    });

    test("Toolkit readiness ignores its non-numeric TK badge", function () {
        const ready = exerciseReadiness({
            total: 334, active: 129, module: "toolkit", badge: "TK",
        });
        expect(ready.state).toBe("BACKGROUND_IDLE");
        expect(ready.idle).toBe(true);
        expect(ready.transitions.slice(-2)).toEqual(["FIRST_CARD_USABLE", "LIBRARY_READY"]);
    });
});

/**
 * Behavior oracle: startup event cardinality and unload ownership, not UI text.
 * **Validates: Requirements 1.1, 1.8, 1.10, 1.13–1.16, 2.10, 2.11, 2.19, 2.31, 2.33**
 */
