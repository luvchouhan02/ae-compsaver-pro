// ============================================================
// ui/toast.js - Toast_Engine (Req 8.11, 14.2-14.8, 14.12, 14.15)
// ------------------------------------------------------------
// CompSaverToast drives the single Shell surface #toast through a pure
// state machine (reduce). Keeps the globals every caller uses:
// showToast(msg, type) and clearToast(). At most one toast is visible;
// others queue (max 8, oldest dropped). Each toast fades in 150 ms, stays
// 2000 ms, fades out 150 ms. History keeps the last 20 displayed toasts
// for the Header notifications list. Messages are written with
// textContent only. Loaded right after the js/core scripts.
// ============================================================

var CompSaverToast = (function (root) {
    "use strict";

    var TYPES = ["success", "info", "warning", "error"];
    var ENTER_MS = 150;
    var DURATION_MS = 2000;
    var EXIT_MS = 150;
    var QUEUE_MAX = 8;
    var HISTORY_MAX = 20;
    var GLYPHS = { success: "\u2713", info: "\u2139", warning: "\u26a0", error: "\u2715" };
    var ICONS = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><polyline points="8 12.5 11 15.5 16 9.5"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
    };

    // ── pure helpers ─────────────────────────────────────────────
    function normalizeType(type) {
        for (var i = 0; i < TYPES.length; i++) if (TYPES[i] === type) return type;
        return "info";
    }

    function displayText(msg, type) {
        var text = msg === null || msg === undefined ? "" : String(msg);
        var glyph = GLYPHS[normalizeType(type)];
        if (text.charAt(0) === glyph) {
            text = text.slice(1);
            if (text.charAt(0) === "\ufe0f") text = text.slice(1);
            text = text.replace(/^ +/, "");
        }
        return text;
    }

    function ariaFor(type) {
        var t = normalizeType(type);
        return t === "warning" || t === "error" ? { role: "alert", live: "assertive" } : { role: "status", live: "polite" };
    }

    function initialState() { return { phase: "idle", current: null, queue: [] }; }

    function copyState(s) { return { phase: s.phase, current: s.current, queue: s.queue.slice(0) }; }

    /** Pure state machine: returns { state, effects }. */
    function reduce(state, event) {
        var s = copyState(state || initialState());
        var effects = [];
        var type = event && event.type;
        if (type === "show") {
            if (s.phase === "idle") {
                s.phase = "visible";
                s.current = event.entry;
                effects.push({ type: "display", entry: event.entry });
                effects.push({ type: "arm", timer: "dismiss", ms: ENTER_MS + DURATION_MS });
            } else {
                if (s.queue.length >= QUEUE_MAX) s.queue.shift();
                s.queue.push(event.entry);
            }
        } else if (type === "dismiss") {
            if (s.phase === "visible") {
                s.phase = "exiting";
                effects.push({ type: "hide" });
                effects.push({ type: "arm", timer: "exit", ms: EXIT_MS });
            }
        } else if (type === "exit") {
            if (s.phase === "exiting") {
                if (!s.queue.length) {
                    s.phase = "idle";
                    s.current = null;
                } else {
                    s.current = s.queue.shift();
                    s.phase = "visible";
                    effects.push({ type: "display", entry: s.current });
                    effects.push({ type: "arm", timer: "dismiss", ms: ENTER_MS + DURATION_MS });
                }
            }
        } else if (type === "clear") {
            s.queue = [];
            if (s.phase !== "idle") {
                s.phase = "idle";
                s.current = null;
                effects.push({ type: "cancel" });
                effects.push({ type: "hideInstant" });
            }
        }
        return { state: s, effects: effects };
    }

    // ── runtime ──────────────────────────────────────────────────
    var deps = {};
    var state = initialState();
    var history = [];
    var listeners = [];
    var timerId = null;
    var timerToken = null;
    var prefixes = [];

    function surface() {
        if (typeof deps.getSurface === "function") return deps.getSurface();
        var D = typeof DOM !== "undefined" ? DOM : root.DOM;
        return D && D.toast ? D.toast : null;
    }
    function now() { return typeof deps.now === "function" ? deps.now() : Date.now(); }
    function doc() { return deps.doc || (typeof document !== "undefined" ? document : null); }
    function setT(fn, ms) { return (deps.setTimeout || setTimeout)(fn, ms); }
    function clearT(id) { (deps.clearTimeout || clearTimeout)(id); }

    function cancelTimer() {
        if (timerToken && typeof timerToken.dispose === "function") {
            try { timerToken.dispose(); } catch (e) { /* ignore */ }
        } else if (timerId !== null) {
            clearT(timerId);
        }
        timerId = null;
        timerToken = null;
    }

    function arm(event, ms) {
        cancelTimer();
        var id = setT(function () {
            timerId = null;
            timerToken = null;
            dispatch({ type: event });
        }, ms);
        timerId = id;
        var lc = root.AppLifecycle;
        if (lc && typeof lc.register === "function" && !deps.setTimeout) {
            try { timerToken = lc.register("timer", id, deps.clearTimeout || clearTimeout); } catch (e) { timerToken = null; }
        }
    }

    function ensureChildren(el) {
        var icon = typeof el.querySelector === "function" ? el.querySelector(".cs-toast-surface__icon") : null;
        var text = typeof el.querySelector === "function" ? el.querySelector(".cs-toast-surface__text") : null;
        var d = doc();
        if ((!icon || !text) && d && typeof d.createElement === "function") {
            el.textContent = "";
            icon = d.createElement("span");
            icon.className = "cs-toast-surface__icon";
            icon.setAttribute("aria-hidden", "true");
            text = d.createElement("span");
            text.className = "cs-toast-surface__text";
            el.appendChild(icon);
            el.appendChild(text);
        }
        return { icon: icon, text: text };
    }

    function render(entry) {
        var el = surface();
        if (!el) return;
        var parts = ensureChildren(el);
        if (parts.text) parts.text.textContent = "";
        var aria = ariaFor(entry.type);
        el.setAttribute("role", aria.role);
        el.setAttribute("aria-live", aria.live);
        el.setAttribute("data-toast-type", entry.type);
        if (parts.icon) parts.icon.innerHTML = ICONS[entry.type];
        var shown = displayText(entry.message, entry.type);
        if (parts.text) parts.text.textContent = shown;
        else el.textContent = shown;
        if (el.classList) {
            el.classList.remove("cs-toast-surface--instant");
            el.classList.add("show");
        }
        var record = { message: entry.message, type: entry.type, at: now() };
        history.unshift(record);
        if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
        var snapshot = listeners.slice(0);
        for (var i = 0; i < snapshot.length; i++) {
            try { snapshot[i]({ message: record.message, type: record.type, at: record.at }); } catch (e) { /* ignore */ }
        }
    }

    function applyEffects(effects) {
        for (var i = 0; i < effects.length; i++) {
            var fx = effects[i];
            var el = surface();
            if (fx.type === "display") render(fx.entry);
            else if (fx.type === "arm") arm(fx.timer, fx.ms);
            else if (fx.type === "hide") { if (el && el.classList) el.classList.remove("show"); }
            else if (fx.type === "cancel") cancelTimer();
            else if (fx.type === "hideInstant") {
                if (el && el.classList) {
                    el.classList.add("cs-toast-surface--instant");
                    el.classList.remove("show");
                }
            }
        }
    }

    function dispatch(event) {
        var out = reduce(state, event);
        state = out.state;
        applyEffects(out.effects);
    }

    function takePrefix(message) {
        var text = message === null || message === undefined ? "" : String(message);
        for (var i = 0; i < prefixes.length; i++) {
            var p = prefixes[i];
            if (p.match === text || (p.match instanceof RegExp && p.match.test(text))) {
                prefixes.splice(i, 1);
                return p.prefix + text;
            }
        }
        return message;
    }

    function show(msg, type) {
        if (!surface()) return false;
        dispatch({ type: "show", entry: { message: takePrefix(msg), type: normalizeType(type) } });
        return true;
    }

    function clear() {
        if (!surface()) return false;
        dispatch({ type: "clear" });
        return true;
    }

    /**
     * Prefix the next toast whose message matches, within the current task:
     * lets the dispatcher name the action in ToolBridge's transport error.
     */
    function prefixNext(match, prefix) {
        var entry = { match: match, prefix: String(prefix) };
        prefixes.push(entry);
        var drop = function () {
            for (var i = 0; i < prefixes.length; i++) if (prefixes[i] === entry) { prefixes.splice(i, 1); break; }
        };
        if (typeof Promise === "function") Promise.resolve().then(drop);
        else setT(drop, 0);
        return drop;
    }

    function onDisplay(fn) {
        if (typeof fn !== "function") return function () { };
        listeners.push(fn);
        return function () {
            for (var i = 0; i < listeners.length; i++) if (listeners[i] === fn) { listeners.splice(i, 1); break; }
        };
    }

    function configure(options) {
        options = options || {};
        var keys = ["getSurface", "setTimeout", "clearTimeout", "now", "doc"];
        for (var i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(options, keys[i])) deps[keys[i]] = options[keys[i]];
        }
        return api;
    }

    var api = {
        TYPES: TYPES.slice(0),
        ENTER_MS: ENTER_MS,
        DURATION_MS: DURATION_MS,
        EXIT_MS: EXIT_MS,
        QUEUE_MAX: QUEUE_MAX,
        HISTORY_MAX: HISTORY_MAX,
        normalizeType: normalizeType,
        displayText: displayText,
        ariaFor: ariaFor,
        reduce: reduce,
        initialState: initialState,
        show: show,
        clear: clear,
        prefixNext: prefixNext,
        onDisplay: onDisplay,
        getState: function () { return copyState(state); },
        getHistory: function () { return history.slice(0); },
        configure: configure,
        _reset: function () { cancelTimer(); state = initialState(); history = []; listeners = []; prefixes = []; }
    };
    return api;
})(typeof window !== "undefined" ? window : this);

function showToast(msg, type) {
    return CompSaverToast.show(msg, type);
}

function clearToast() {
    return CompSaverToast.clear();
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = CompSaverToast;
    module.exports.showToast = showToast;
    module.exports.clearToast = clearToast;
}
