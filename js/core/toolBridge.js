// ============================================================
// core/toolBridge.js — bounded Toolkit bridge operations
// ------------------------------------------------------------
// UI-operation layer ON TOP of the existing raw evalScript
// transport. Owns lifecycle, not payload construction: callers
// build script strings exactly as before; this layer adds what
// every Toolkit tool was missing —
//   - per-key single-flight guard (rapid double-clicks and
//     overlapping tools cannot double-execute a host operation)
//   - busy state (button disabled + aria-busy) with a guaranteed
//     restore through ONE finalizer
//   - bounded timeout (AE hang => button never stays stuck)
//   - operation tokens (late callbacks after timeout/disposal
//     are suppressed)
//   - sentinel + malformed-result classification with actionable
//     messages ("EvalScript error." / "undefined" / empty)
//   - bridge timing on every result
// Depends on globals: csInterface, showToast (optional),
// decodeBridge (optional), AppLifecycle (optional, disposal
// awareness). Must load AFTER core/bridge.js, BEFORE toolkit
// files and ui/paste.js.
// ============================================================

var ToolBridge = (function () {
    "use strict";

    var DEFAULT_TIMEOUT_MS = 30000;
    var BUSY_TOAST_INTERVAL_MS = 1500;

    var inflight = {};          // key -> operation record
    var nextToken = 1;
    var disposed = false;
    var lastBusyToastAt = {};   // key -> epoch ms

    function now() {
        return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }

    function toast(message, kind) {
        try {
            if (typeof showToast === "function") showToast(message, kind);
        } catch (e) { /* toast must never break an operation */ }
    }

    function busyToastThrottled(key) {
        var t = Date.now();
        if (lastBusyToastAt[key] && (t - lastBusyToastAt[key]) < BUSY_TOAST_INTERVAL_MS) return;
        lastBusyToastAt[key] = t;
        toast("Already running — please wait for it to finish", "info");
    }

    function isSentinel(raw) {
        return raw === null || raw === undefined || raw === "" ||
            raw === "EvalScript error." || raw === "undefined";
    }

    function decodeSafe(raw) {
        if (typeof decodeBridge !== "function") return String(raw);
        try {
            return decodeBridge(raw);
        } catch (e) {
            return String(raw);
        }
    }

    function setBusy(button, busy, restoreDisabled) {
        if (!button || !button.setAttribute) return;
        if (busy) {
            button.setAttribute("aria-busy", "true");
            if (typeof button.disabled === "boolean") button.disabled = true;
        } else {
            button.removeAttribute("aria-busy");
            // Restore the pre-operation state: a button the app had already
            // disabled for other reasons must not be silently re-enabled.
            if (typeof button.disabled === "boolean") button.disabled = !!restoreDisabled;
        }
    }

    function finish(record, outcome) {
        if (record.done) return null;
        record.done = true;
        if (record.timer) { clearTimeout(record.timer); record.timer = null; }
        delete inflight[record.key];
        setBusy(record.button, false, record.wasDisabled);
        if (record.workOwner) {
            try { AppLifecycle.markWorkEnd(record.workOwner, record.id); } catch (e) { }
        }
        return outcome;
    }

    function call(options) {
        var key = options && options.key;
        var script = options && options.script;
        if (typeof key !== "string" || !key) return null;
        if (typeof script !== "string" || !script) return null;

        if (disposed) {
            return { status: "disposed", error: { code: "DISPOSED", message: "Panel is shutting down." } };
        }
        if (inflight[key]) {
            // Callers that browse (Flow preset clicks apply silently while the
            // user scrubs through presets) opt out of the busy toast: the
            // single-flight guard still drops the overlapping call, it just
            // does not narrate every dropped click.
            if (!options.silentBusy) busyToastThrottled(key);
            return { status: "busy", error: { code: "BUSY", message: "Operation already in progress." } };
        }

        var t0 = now();
        var record = {
            key: key,
            id: nextToken++,
            done: false,
            button: options.button || null,
            wasDisabled: options.button ? !!options.button.disabled : false,
            timer: null,
            workOwner: null
        };
        inflight[key] = record;

        setBusy(record.button, true);

        if (typeof AppLifecycle !== "undefined" && AppLifecycle && AppLifecycle.markWorkStart) {
            record.workOwner = "toolBridge";
            try { AppLifecycle.markWorkStart(record.workOwner, record.id); } catch (e) { record.workOwner = null; }
        }

        var timeoutMs = (typeof options.timeoutMs === "number" && options.timeoutMs > 0)
            ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

        record.timer = setTimeout(function () {
            var outcome = finish(record, {
                status: "timeout",
                error: {
                    code: "TIMEOUT",
                    message: "The After Effects operation timed out. Check that After Effects is responsive, then retry."
                },
                timing: { bridgeMs: now() - t0 }
            });
            if (outcome && options.onResult) options.onResult(outcome);
            if (outcome) toast(outcome.error.message, "error");
        }, timeoutMs);

        try {
            csInterface.evalScript(script, function (raw) {
                var outcome;
                if (isSentinel(raw)) {
                    outcome = finish(record, {
                        status: "error",
                        error: {
                            code: "HOST_ERROR",
                            message: "After Effects did not respond to this action. Check that AE is open and not busy, then retry."
                        },
                        raw: raw === null || raw === undefined ? "" : String(raw),
                        timing: { bridgeMs: now() - t0 }
                    });
                    if (outcome && options.onResult) options.onResult(outcome);
                    if (outcome) toast(outcome.error.message, "error");
                    return;
                }
                outcome = finish(record, {
                    status: "success",
                    raw: String(raw),
                    decoded: decodeSafe(raw),
                    timing: { bridgeMs: now() - t0 }
                });
                if (outcome && options.onResult) options.onResult(outcome);
            });
        } catch (e) {
            var outcome = finish(record, {
                status: "error",
                error: { code: "DISPATCH_ERROR", message: "Could not send the action to After Effects: " + (e && e.message ? e.message : String(e)) },
                timing: { bridgeMs: now() - t0 }
            });
            if (outcome && options.onResult) options.onResult(outcome);
            if (outcome) toast(outcome.error.message, "error");
        }

        return record;
    }

    // Panel teardown: kill pending timers and mark everything done so late
    // host callbacks cannot touch a disposed panel's UI.
    function dispose() {
        disposed = true;
        for (var key in inflight) {
            if (!Object.prototype.hasOwnProperty.call(inflight, key)) continue;
            var record = inflight[key];
            finish(record, { status: "disposed", error: { code: "DISPOSED", message: "Panel is shutting down." } });
        }
    }

    function busyKeys() {
        var keys = [];
        for (var key in inflight) {
            if (Object.prototype.hasOwnProperty.call(inflight, key)) keys.push(key);
        }
        return keys;
    }

    // Wire disposal to the shared lifecycle when it is available.
    try {
        if (typeof AppLifecycle !== "undefined" && AppLifecycle && AppLifecycle.onDispose) {
            AppLifecycle.onDispose(function () { dispose(); });
        }
    } catch (e) { }

    return {
        call: call,
        dispose: dispose,
        busyKeys: busyKeys,
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
    };
})();
