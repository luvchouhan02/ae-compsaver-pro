// ============================================================
// ui/comp-monitor.js - Comp_Monitor (active composition readout)
// ------------------------------------------------------------
// CompMonitor queries the read-only Host function csActiveCompInfo()
// through callHost (2000 ms timeout, single flight) and renders
// "<name> · WxH @ fpsfps" into #monitor-active-comp with textContent.
// Automatic refreshes are dropped while startup gate G2 is closed; a click
// always runs (decision (g)). The global updateActiveCompMonitor() stays for
// existing callers and calls refresh("legacy").
// Req 8.2-8.8, 8.14, 8.16, 8.17, 19.4. Loaded before main.js.
// ============================================================

var CompMonitor = (function (root) {
    "use strict";

    var AUTOMATIC = { startup: true, toolkit: true, legacy: true };
    var TIMEOUT_MS = 2000;

    var deps = {};
    var inFlight = false;
    var state = { text: "Checking\u2026", dot: "pending", shown: false };
    var bound = false;

    function isInt(n, min, max) {
        return typeof n === "number" && isFinite(n) && Math.floor(n) === n && n >= min && n <= max;
    }

    /** Pure: decoded Host text to { kind: "comp" | "none" | "error" }. */
    function parseCompInfo(decoded) {
        if (typeof decoded !== "string" || decoded.indexOf("OK:") !== 0) return { kind: "error", reason: "malformed" };
        var obj;
        try { obj = JSON.parse(decoded.slice(3)); } catch (e) { return { kind: "error", reason: "malformed" }; }
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { kind: "error", reason: "malformed" };
        if (obj.comp === false) return { kind: "none" };
        if (obj.comp === true && typeof obj.name === "string" && isInt(obj.width, 1, 30000) &&
            isInt(obj.height, 1, 30000) && typeof obj.fps === "number" && isFinite(obj.fps) && obj.fps > 0) {
            return { kind: "comp", name: obj.name, width: obj.width, height: obj.height, fps: obj.fps };
        }
        return { kind: "error", reason: "malformed" };
    }

    /** Pure: at most 3 decimals, no trailing zeros or point. */
    function formatFps(fps) {
        return String(Number(Number(fps).toFixed(3)));
    }

    /** Pure: { name, meta }; the displayed text is name + meta. */
    function formatReadout(info) {
        return {
            name: info.name,
            meta: " \u00b7 " + info.width + "x" + info.height + " @ " + formatFps(info.fps) + "fps"
        };
    }

    /** Pure reducer over { text, dot, shown }. */
    function nextState(prev, outcome) {
        if (outcome && outcome.kind === "comp") {
            var r = formatReadout(outcome);
            return { text: r.name + r.meta, name: r.name, meta: r.meta, dot: "ok", shown: true };
        }
        if (outcome && outcome.kind === "none") {
            return { text: "No active comp", name: "No active comp", meta: "", dot: "ok", shown: true };
        }
        if (prev && prev.shown) {
            return { text: prev.text, name: prev.name, meta: prev.meta, dot: "warn", shown: true };
        }
        return { text: "No active comp", name: "No active comp", meta: "", dot: "warn", shown: false };
    }

    function doc() { return deps.doc || (typeof document !== "undefined" ? document : null); }
    function header() { return deps.header || (typeof CompSaverHeader !== "undefined" ? CompSaverHeader : null); }
    function gate() { return deps.gate || (typeof StartupGate !== "undefined" ? StartupGate : null); }
    function host() {
        if (deps.callHost) return deps.callHost;
        return typeof callHost === "function" ? callHost : null;
    }
    function monitorEl() {
        var d = doc();
        return d && typeof d.getElementById === "function" ? d.getElementById("monitor-active-comp") : null;
    }

    function render(el, s) {
        if (!el) return;
        var nameEl = typeof el.querySelector === "function" ? el.querySelector(".cs-comp-monitor__name") : null;
        var metaEl = typeof el.querySelector === "function" ? el.querySelector(".cs-comp-monitor__meta") : null;
        if (nameEl && metaEl) {
            nameEl.textContent = s.name || s.text;
            metaEl.textContent = s.meta || "";
        } else {
            el.textContent = s.text;
        }
        el.setAttribute("title", s.text);
        el.setAttribute("aria-label", "Active composition: " + s.text + ". Activate to refresh.");
        var h = header();
        if (h && typeof h.setStatus === "function") h.setStatus(s.dot);
    }

    function gateClosed() {
        var g = gate();
        return !!(g && typeof g.isOpen === "function" && g.isOpen("g2") === false);
    }

    function decodeResult(result) {
        if (!result || result.ok !== true || typeof result.result !== "string") return { kind: "error", reason: "host" };
        return parseCompInfo(result.result);
    }

    function refresh(reason) {
        if (inFlight) return false;
        var el = monitorEl();
        if (!el) return false;
        if (AUTOMATIC[reason] && gateClosed()) return false;
        var call = host();
        if (!call) return false;
        inFlight = true;
        var settle = function (result) {
            inFlight = false;
            state = nextState(state, decodeResult(result));
            render(monitorEl(), state);
        };
        var p;
        try { p = call("csActiveCompInfo()", { timeoutMs: TIMEOUT_MS }); } catch (e) { p = null; }
        if (p && typeof p.then === "function") {
            p.then(settle, function () { settle({ ok: false, error: "rejected" }); });
        } else {
            settle({ ok: false, error: "no transport" });
        }
        return true;
    }

    function bind() {
        if (bound) return false;
        var el = monitorEl();
        if (!el || typeof el.addEventListener !== "function") return false;
        bound = true;
        // A native <button>: Enter and Space fire click (Req 8.6, 18.8).
        el.addEventListener("click", function () { refresh("click"); });
        return true;
    }

    function configure(options) {
        options = options || {};
        var keys = ["callHost", "gate", "header", "doc"];
        for (var i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(options, keys[i])) deps[keys[i]] = options[keys[i]];
        }
        return api;
    }

    var api = {
        TIMEOUT_MS: TIMEOUT_MS,
        refresh: refresh,
        bind: bind,
        parseCompInfo: parseCompInfo,
        formatFps: formatFps,
        formatReadout: formatReadout,
        nextState: nextState,
        configure: configure,
        getState: function () { return { text: state.text, dot: state.dot, shown: state.shown, inFlight: inFlight }; },
        _reset: function () { inFlight = false; state = { text: "Checking\u2026", dot: "pending", shown: false }; bound = false; }
    };
    return api;
})(typeof window !== "undefined" ? window : this);

function updateActiveCompMonitor() {
    return CompMonitor.refresh("legacy");
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = CompMonitor;
    module.exports.updateActiveCompMonitor = updateActiveCompMonitor;
}
