// ============================================================
// tests/tool-bridge.test.js
//
// Feature: Toolkit quality wave — shared bounded tool operations
//
// What is under test
// ------------------
// The REAL ToolBridge from js/core/toolBridge.js, loaded into a vm
// with an injected csInterface whose callbacks are delivered by the
// test (never by AE). Verifies the lifecycle contract every Toolkit
// tool now depends on:
//   - busy state + guaranteed finalizer (button never stays disabled)
//   - sentinel classification ("EvalScript error." / "undefined" / empty)
//   - bounded timeout with actionable error
//   - late callbacks after timeout are suppressed
//   - per-key single-flight (rapid double-click = one host operation)
//   - different keys are independent
//   - panel disposal kills timers and rejects late callbacks
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "js/core/toolBridge.js"), "utf8");

function manualClock() {
    const timers = [];
    let nextId = 1;
    return {
        setTimeout: function (fn, ms) { timers.push({ id: nextId, fn, at: Number(ms) || 0, done: false }); return nextId++; },
        clearTimeout: function (handle) { const t = timers.find(function (x) { return x.id === handle; }); if (t) t.done = true; },
        advance: function () {
            const due = timers.filter(function (t) { return !t.done; });
            timers.length = 0;
            due.forEach(function (t) { if (!t.done) t.fn(); });
            return due.length;
        },
        pending: function () { return timers.filter(function (t) { return !t.done; }).length; },
    };
}

function buildHarness() {
    const clock = manualClock();
    const calls = [];        // { script, respond } — respond() delivers the host callback
    const toasts = [];       // { message, kind }
    const harness = {
        calls: calls,
        toasts: toasts,
        button: { disabled: false, attrs: {}, setAttribute: function (k, v) { this.attrs[k] = v; }, removeAttribute: function (k) { delete this.attrs[k]; } },
    };
    const context = {
        console: { log: function () { }, warn: function () { }, error: function () { } },
        performance: { now: function () { return Date.now(); } },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        showToast: function (message, kind) { toasts.push({ message: message, kind: kind }); },
        decodeBridge: function (raw) { return "decoded:" + raw; },
        csInterface: {
            evalScript: function (script, cb) {
                calls.push({ script: script, respond: function (value) { cb(value); } });
            },
        },
        AppLifecycle: null, // wired per-test
    };
    vm.createContext(context);
    vm.runInContext(SOURCE, context, { filename: "toolBridge.js" });
    harness.clock = clock;
    harness.context = context;
    harness.ToolBridge = context.ToolBridge;
    return harness;
}

function buildLifecycleHarness() {
    const h = buildHarness();
    const lifecycleSource = fs.readFileSync(path.join(ROOT, "js/core/appLifecycle.js"), "utf8");
    // AppLifecycle is captured at load time by toolBridge only via the
    // onDispose hook at the bottom — rebuild with lifecycle present first.
    const context2 = Object.assign({}, h.context);
    delete context2.ToolBridge;
    vm.createContext(context2);
    vm.runInContext(lifecycleSource, context2, { filename: "appLifecycle.js" });
    vm.runInContext(SOURCE, context2, { filename: "toolBridge.js" });
    return { context: context2, ToolBridge: context2.ToolBridge, calls: h.calls, toasts: h.toasts, clock: h.clock, button: h.button };
}

describe("ToolBridge — bounded toolkit operations", () => {
    test("success: classifies, decodes, restores busy state, reports timing", () => {
        const h = buildHarness();
        const results = [];
        h.ToolBridge.call({ key: "t", script: "doThing()", button: h.button, onResult: (r) => results.push(r) });

        expect(h.calls.length).toBe(1);
        expect(h.button.disabled).toBe(true);
        expect(h.button.attrs["aria-busy"]).toBe("true");

        h.calls[0].respond("4f4b");
        expect(results.length).toBe(1);
        expect(results[0].status).toBe("success");
        expect(results[0].decoded).toBe("decoded:4f4b");
        expect(typeof results[0].timing.bridgeMs).toBe("number");
        expect(h.button.disabled).toBe(false);
        expect(h.button.attrs["aria-busy"]).toBeUndefined();
        expect(h.toasts.length).toBe(0);
    });

    test.each(["EvalScript error.", "undefined", ""])("sentinel %p -> actionable error + finalizer", (sentinel) => {
        const h = buildHarness();
        const results = [];
        h.ToolBridge.call({ key: "t", script: "s()", button: h.button, onResult: (r) => results.push(r) });
        h.calls[0].respond(sentinel);
        expect(results[0].status).toBe("error");
        expect(results[0].error.code).toBe("HOST_ERROR");
        expect(h.button.disabled).toBe(false);
        expect(h.toasts.some((t) => t.kind === "error")).toBe(true);
    });

    test("timeout: finalizer runs, button restored, actionable message, late callback suppressed", () => {
        const h = buildHarness();
        const results = [];
        h.ToolBridge.call({ key: "t", script: "s()", button: h.button, timeoutMs: 5000, onResult: (r) => results.push(r) });

        expect(h.clock.advance()).toBe(1); // fire the timeout
        expect(results.length).toBe(1);
        expect(results[0].status).toBe("timeout");
        expect(results[0].error.code).toBe("TIMEOUT");
        expect(h.button.disabled).toBe(false);
        expect(h.toasts.some((t) => t.message.indexOf("timed out") !== -1)).toBe(true);

        h.calls[0].respond("4f4b"); // AE answers late
        expect(results.length).toBe(1); // suppressed — no double terminal state
    });

    test("single-flight: a second call with the same key dispatches nothing", () => {
        const h = buildHarness();
        const results = [];
        const first = h.ToolBridge.call({ key: "toolkit.anchor", script: "a()", onResult: (r) => results.push(r) });
        expect(first).not.toBeNull();
        const second = h.ToolBridge.call({ key: "toolkit.anchor", script: "a()", onResult: (r) => results.push(r) });
        expect(second.status).toBe("busy");
        expect(h.calls.length).toBe(1); // only ONE host operation
        h.calls[0].respond("4f4b");
        expect(results.length).toBe(1);

        // After the terminal state the key is free again.
        h.ToolBridge.call({ key: "toolkit.anchor", script: "a()", onResult: () => { } });
        expect(h.calls.length).toBe(2);
    });

    test("different keys are independent", () => {
        const h = buildHarness();
        h.ToolBridge.call({ key: "a", script: "a()", onResult: () => { } });
        const b = h.ToolBridge.call({ key: "b", script: "b()", onResult: () => { } });
        expect(b).not.toBeNull();
        expect(h.calls.length).toBe(2);
    });

    test("a button already disabled for other reasons is not silently re-enabled", () => {
        const h = buildHarness();
        h.button.disabled = true;
        h.ToolBridge.call({ key: "t", script: "s()", button: h.button, onResult: () => { } });
        h.calls[0].respond("4f4b");
        expect(h.button.disabled).toBe(true); // pre-existing state restored
    });

    test("disposal: pending timers die, late callbacks dead, new calls rejected", () => {
        const h = buildLifecycleHarness();
        const results = [];
        h.ToolBridge.call({ key: "t", script: "s()", button: h.button, onResult: (r) => results.push(r) });

        h.context.AppLifecycle.dispose("test");
        expect(h.clock.pending()).toBe(0);
        expect(h.button.disabled).toBe(false);

        h.calls[0].respond("4f4b");
        expect(results.length).toBe(0); // late callback after disposal is suppressed

        const after = h.ToolBridge.call({ key: "t2", script: "s()", onResult: () => { } });
        expect(after.status).toBe("disposed");
    });
});
