// ============================================================
// ui/startup-gate.js - lifecycle-derived startup gates (Req 8.14, 8.17, 19.3, 19.4)
// ------------------------------------------------------------
// G1 "first paint": opens after the first paint of the active Route.
//   - active Route `templates`: the first transition to FIRST_CARD_USABLE,
//     LIBRARY_READY, BACKGROUND_IDLE or DEGRADED, or a
//     `templates.cold-scan.complete` event with templateCount 0.
//   - any other Route: the first animation frame after SHELL_VISIBLE.
// G2 "Host_Call_Gate": the first state at or after FIRST_CARD_USABLE in
//   lifecycle order, or a `templates.cold-scan.complete` with templateCount 0.
// With FeatureFlags.flags.lifecycleV1 === false both open on the first frame
// after bootstrap. A gate opens once; a callback registered after it opened
// runs at once. No DOM or Host access at load time.
// ============================================================
(function (root) {
    "use strict";

    var READY_STATES = { FIRST_CARD_USABLE: 1, LIBRARY_READY: 1, BACKGROUND_IDLE: 1, DEGRADED: 1 };
    var SHELL_OR_LATER = { SHELL_VISIBLE: 1, FIRST_CARD_USABLE: 1, LIBRARY_READY: 1, BACKGROUND_IDLE: 1, DEGRADED: 1 };

    function createStartupGate() {
        var deps = {};
        var gates = { g1: "closed", g2: "closed" };
        var queues = { g1: [], g2: [] };
        var armed = false;
        var unsubscribe = null;
        var frameRequested = false;

        function perf() { return deps.perf || root.PerfEvents || null; }
        function lifecycle() { return deps.lifecycle || root.AppLifecycle || null; }
        function flags() {
            if (deps.flags) return deps.flags;
            return root.FeatureFlags && root.FeatureFlags.flags ? root.FeatureFlags.flags : null;
        }
        function raf(fn) {
            var r = deps.raf || (typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame.bind(root) : null);
            if (r) return r(fn);
            return (deps.setTimeout || setTimeout)(fn, 16);
        }
        function activeRoute() {
            try {
                if (typeof deps.activeRoute === "function") return deps.activeRoute();
                if (typeof deps.activeRoute === "string") return deps.activeRoute;
            } catch (e) { /* fall through */ }
            return "templates";
        }

        function open(name) {
            if (gates[name] === "open") return;
            gates[name] = "open";
            var q = queues[name];
            queues[name] = [];
            for (var i = 0; i < q.length; i++) runSafe(q[i], name);
            var p = perf();
            if (p && typeof p.emit === "function") {
                try { p.emit("startup.gate.open", { gate: name }); } catch (e) { /* ignore */ }
            }
        }

        function runSafe(fn, name) {
            try { fn(); } catch (err) {
                var p = perf();
                if (p && typeof p.emit === "function") {
                    try { p.emit("startup.gate.callback.error", { gate: name, error: String(err && err.message || err) }); } catch (e) { /* ignore */ }
                }
            }
        }

        function openAfterFrame(names) {
            raf(function () {
                for (var i = 0; i < names.length; i++) open(names[i]);
            });
        }

        function onState(state) {
            if (READY_STATES[state]) {
                open("g2");
                if (activeRoute() === "templates") open("g1");
            }
            if (SHELL_OR_LATER[state] && activeRoute() !== "templates" && gates.g1 !== "open" && !frameRequested) {
                frameRequested = true;
                openAfterFrame(["g1"]);
            }
        }

        function onEvent(event) {
            if (!event || typeof event.name !== "string") return;
            if (event.name === "lifecycle.transition") {
                onState(event.fields && event.fields.state);
            } else if (event.name === "templates.cold-scan.complete") {
                var count = event.fields ? event.fields.templateCount : undefined;
                if (count === 0) {
                    open("g2");
                    if (activeRoute() === "templates") open("g1");
                }
            }
        }

        function arm(options) {
            if (options) configure(options);
            if (armed) return api;
            armed = true;
            var f = flags();
            if (f && f.lifecycleV1 === false) {
                openAfterFrame(["g1", "g2"]);
                return api;
            }
            var p = perf();
            if (p && typeof p.subscribe === "function") {
                unsubscribe = p.subscribe(onEvent);
                var lc = lifecycle();
                if (lc && typeof lc.subscribe === "function" && typeof unsubscribe === "function") {
                    try { lc.subscribe(unsubscribe); } catch (e) { /* ignore */ }
                }
            }
            var l = lifecycle();
            var state = l && typeof l.getState === "function" ? l.getState() : null;
            if (state) onState(state);
            return api;
        }

        function configure(options) {
            options = options || {};
            var keys = ["perf", "lifecycle", "raf", "flags", "activeRoute", "setTimeout"];
            for (var i = 0; i < keys.length; i++) {
                if (Object.prototype.hasOwnProperty.call(options, keys[i])) deps[keys[i]] = options[keys[i]];
            }
            return api;
        }

        function when(name, fn) {
            if (typeof fn !== "function") return;
            if (gates[name] === "open") runSafe(fn, name);
            else queues[name].push(fn);
        }

        var api = {
            arm: arm,
            configure: configure,
            onFirstPaint: function (fn) { when("g1", fn); },
            onHostCalls: function (fn) { when("g2", fn); },
            whenOpen: function (gate, fn) { if (gate === "g1" || gate === "g2") when(gate, fn); },
            isOpen: function (gate) { return gates[gate] === "open"; },
            getState: function () { return { g1: gates.g1, g2: gates.g2 }; },
            dispose: function () { if (typeof unsubscribe === "function") unsubscribe(); unsubscribe = null; }
        };
        return api;
    }

    var StartupGate = createStartupGate();
    StartupGate.create = createStartupGate;
    root.StartupGate = StartupGate;
    if (typeof module !== "undefined" && module.exports) module.exports = StartupGate;
})(typeof window !== "undefined" ? window : globalThis);
