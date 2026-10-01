// Sole Phase 1 lifecycle and disposable-resource registry.
(function (root) {
    "use strict";
    var ORDER = {
        CREATED: 0, BOOTSTRAPPING: 1, SHELL_VISIBLE: 2, FIRST_CARD_USABLE: 3,
        LIBRARY_READY: 4, BACKGROUND_IDLE: 5, DEGRADED: 6, DISPOSING: 7, DISPOSED: 8
    };

    function createAppLifecycle() {
        var state = "CREATED", resources = [], work = {}, disposed = false, nextId = 1;
        function emit(name, fields) {
            if (root.PerfEvents && root.PerfEvents.emit) root.PerfEvents.emit(name, fields);
        }
        function tokenFor(entry) {
            return {
                id: entry.id, dispose: function () {
                    if (!entry.active) return;
                    entry.active = false;
                    try { entry.dispose(entry.resource); } catch (e) { emit("lifecycle.dispose.error", { kind: entry.kind, error: String(e) }); }
                }
            };
        }
        function register(kind, resource, dispose) {
            if (disposed) { if (typeof dispose === "function") dispose(resource); return { id: 0, dispose: function () { } }; }
            var entry = {
                id: nextId++, kind: kind || "resource", resource: resource,
                dispose: typeof dispose === "function" ? dispose : function () { }, active: true
            };
            resources.push(entry);
            return tokenFor(entry);
        }
        function listen(target, event, handler, options) {
            if (!target || !target.addEventListener) return register("listener", null);
            target.addEventListener(event, handler, options);
            return register("listener", target, function () { target.removeEventListener(event, handler, options); });
        }
        function subscribe(unsubscribe) { return register("subscription", unsubscribe, function (fn) { if (typeof fn === "function") fn(); }); }
        function onDispose(fn) { return register("cleanup", fn, function (cb) { if (typeof cb === "function") cb(); }); }
        function transition(next) {
            if (!Object.prototype.hasOwnProperty.call(ORDER, next) || state === "DISPOSED") return false;
            var idlePair = (state === "BACKGROUND_IDLE" && next === "LIBRARY_READY") ||
                (state === "LIBRARY_READY" && next === "BACKGROUND_IDLE");
            if (!idlePair && ORDER[next] < ORDER[state]) return false;
            if (next === state) return true;
            state = next; emit("lifecycle.transition", { state: state }); return true;
        }
        function workKey(owner, id) { return String(owner) + "::" + String(id); }
        function markWorkStart(owner, id) {
            if (disposed) return false;
            work[workKey(owner, id)] = true;
            if (state === "BACKGROUND_IDLE") transition("LIBRARY_READY");
            emit("lifecycle.work.start", { owner: owner, id: id });
            return true;
        }
        function hasActiveWork() { return Object.keys(work).length > 0; }
        function markWorkEnd(owner, id) {
            delete work[workKey(owner, id)];
            emit("lifecycle.work.end", { owner: owner, id: id });
            if (state === "LIBRARY_READY" && !hasActiveWork()) transition("BACKGROUND_IDLE");
            return true;
        }
        function isBackgroundIdle() { return state === "BACKGROUND_IDLE" && !hasActiveWork(); }
        function snapshotCounts() {
            var counts = {};
            for (var i = 0; i < resources.length; i++) {
                if (!resources[i].active) continue;
                counts[resources[i].kind] = (counts[resources[i].kind] || 0) + 1;
            }
            return counts;
        }
        function dispose(reason) {
            if (disposed) return false;
            transition("DISPOSING"); disposed = true;
            for (var i = resources.length - 1; i >= 0; i--) tokenFor(resources[i]).dispose();
            work = {}; state = "DISPOSED";
            emit("lifecycle.disposed", { reason: reason || "dispose" });
            return true;
        }
        return {
            register: register, listen: listen, subscribe: subscribe, onDispose: onDispose,
            transition: transition, markWorkStart: markWorkStart, markWorkEnd: markWorkEnd,
            isBackgroundIdle: isBackgroundIdle, dispose: dispose, snapshotCounts: snapshotCounts,
            getState: function () { return state; }
        };
    }

    var singleton = createAppLifecycle();
    singleton.createAppLifecycle = createAppLifecycle;
    root.AppLifecycle = singleton;
    if (typeof module !== "undefined" && module.exports) module.exports = singleton;
})(typeof window !== "undefined" ? window : globalThis);