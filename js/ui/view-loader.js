// ============================================================
// ui/view-loader.js - View_Fragment manifest, reader and injection
// ------------------------------------------------------------
// CompSaverViews reads views/<name>.html synchronously (window.cep.fs,
// falling back to Node fs), strips a BOM, injects each fragment exactly once
// into its empty mount, runs whenMounted queues, and reports failures
// (missing, unreadable, empty, not-inserted) with one error toast per
// fragment. Nothing throws out of the loader and nothing is logged at error
// level. Req 4.6, 4.10, 4.11, 19.2, 19.6.
// The MANIFEST is also required by tests/helpers/static-analysis.js, so the
// runtime and the Composed_Markup share one source of truth.
// ============================================================
(function (root) {
    "use strict";

    function entry(name, route, label, mountId) {
        var e = { name: name, route: route, file: "views/" + name + ".html", mountId: mountId || ("cs-route-" + name), label: label };
        return typeof Object.freeze === "function" ? Object.freeze(e) : e;
    }

    var MANIFEST = [
        entry("overlays", null, "Dialogs", "cs-overlay-root"),
        entry("templates", "templates", "Templates"),
        entry("tools", "tools", "Workbench"),
        entry("colorflow", "colorflow", "Colors"),
        entry("effects", "effects", "Effects"),
        entry("easing", "easing", "Flow"),
        entry("text", "text", "Text"),
        entry("settings", "settings", "Settings")
    ];
    if (typeof Object.freeze === "function") Object.freeze(MANIFEST);

    var DEFERRED_ORDER = ["templates", "tools", "effects", "text", "easing", "colorflow", "settings"];
    var WATCHDOG_MS = 5000;
    var BOM = "\uFEFF";

    function createLoader() {
        var deps = {};
        var records = {};
        var mountedListeners = [];
        var heldFailures = [];
        var loader = { t0: null, watchdog: null, deferredStarted: false };
        var span = null;
        var perfUnsub = null;

        for (var i = 0; i < MANIFEST.length; i++) {
            records[MANIFEST[i].name] = { state: "pending", failure: null, queue: [] };
        }

        function byName(name) {
            for (var i = 0; i < MANIFEST.length; i++) if (MANIFEST[i].name === name) return MANIFEST[i];
            return null;
        }

        function perf() { return deps.perf || root.PerfEvents || null; }
        function emit(name, fields) {
            var p = perf();
            if (p && typeof p.emit === "function") {
                try { p.emit(name, fields); } catch (e) { /* ignore */ }
            }
        }
        function doc() { return deps.doc || (typeof document !== "undefined" ? document : null); }
        function lifecycle() { return deps.lifecycle || root.AppLifecycle || null; }
        function timer(fn, ms) {
            var st = deps.setTimeout || setTimeout;
            var id = st(fn, ms);
            var lc = lifecycle();
            if (lc && typeof lc.register === "function") {
                try { lc.register("timer", id, deps.clearTimeout || clearTimeout); } catch (e) { /* ignore */ }
            }
            return id;
        }
        function raf(fn) {
            var r = deps.raf || (typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame.bind(root) : null);
            if (r) return r(fn);
            return timer(fn, 16);
        }

        function extensionPath() {
            if (typeof deps.extensionPath === "string") return deps.extensionPath;
            try {
                var cs = root.csInterface;
                if (!cs && typeof root.CSInterface === "function") cs = new root.CSInterface();
                var sp = root.SystemPath;
                if (cs && typeof cs.getSystemPath === "function" && sp && sp.EXTENSION) {
                    return String(cs.getSystemPath(sp.EXTENSION)).replace(/\\/g, "/");
                }
            } catch (e) { /* fall through */ }
            return "";
        }

        // Default reader: { ok: true, text } or { ok: false, kind }.
        function defaultReadText(file) {
            var base = extensionPath();
            var full = base ? base.replace(/\/+$/, "") + "/" + file : file;
            var cep = root.cep;
            if (cep && cep.fs && typeof cep.fs.readFile === "function") {
                var result;
                try { result = cep.fs.readFile(full); } catch (e) { return { ok: false, kind: "unreadable" }; }
                if (!result) return { ok: false, kind: "unreadable" };
                if (result.err && result.err !== 0) {
                    var notFound = typeof cep.fs.ERR_NOT_FOUND !== "undefined" ? cep.fs.ERR_NOT_FOUND : 3;
                    return { ok: false, kind: result.err === notFound ? "missing" : "unreadable" };
                }
                return { ok: true, text: String(result.data == null ? "" : result.data) };
            }
            try {
                var req = typeof root.require === "function" ? root.require : (typeof require === "function" ? require : null);
                if (!req) return { ok: false, kind: "unreadable" };
                var fs = req("fs");
                return { ok: true, text: fs.readFileSync(full, "utf8") };
            } catch (err) {
                return { ok: false, kind: err && err.code === "ENOENT" ? "missing" : "unreadable" };
            }
        }

        function readFragment(e) {
            var reader = typeof deps.readText === "function" ? deps.readText : defaultReadText;
            var out;
            try { out = reader(e.file, e); } catch (err) {
                return { ok: false, kind: err && err.code === "ENOENT" ? "missing" : "unreadable" };
            }
            if (typeof out === "string") out = { ok: true, text: out };
            if (out === null || typeof out === "undefined") return { ok: false, kind: "missing" };
            return out;
        }

        function toastAvailable() {
            var D = root.DOM;
            return !!(D && D.toast) && typeof (deps.showToast || root.showToast) === "function";
        }

        function showFailureToast(e) {
            var msg = "\u2715 Couldn't load the " + e.label + " view. Reload the panel to try again.";
            if (toastAvailable()) {
                try { (deps.showToast || root.showToast)(msg, "error"); } catch (err) { heldFailures.push(msg); }
            } else {
                heldFailures.push(msg);
            }
        }

        function flushHeld() {
            if (!heldFailures.length || !toastAvailable()) return false;
            var list = heldFailures.slice(0);
            heldFailures = [];
            var fn = deps.showToast || root.showToast;
            for (var i = 0; i < list.length; i++) {
                try { fn(list[i], "error"); } catch (e) { /* ignore */ }
            }
            return true;
        }

        function settleCheck() {
            if (!span) return;
            for (var i = 0; i < MANIFEST.length; i++) if (records[MANIFEST[i].name].state === "pending") return;
            try { span.end({ fragments: MANIFEST.length }); } catch (e) { /* ignore */ }
            span = null;
        }

        function markFailed(name, kind) {
            var rec = records[name];
            if (!rec || rec.state !== "pending") return;
            rec.state = "failed";
            rec.failure = kind;
            rec.queue = [];
            var e = byName(name);
            emit("views.mount.failed", { name: name, kind: kind });
            showFailureToast(e);
            settleCheck();
        }

        function runCallback(name, fn, rootEl) {
            try { fn(rootEl, name); } catch (err) {
                emit("views.init.error", { name: name, error: String(err && err.message || err) });
            }
        }

        function mountSync(name) {
            var rec = records[name];
            var e = byName(name);
            if (!rec || !e) return false;
            if (rec.state === "mounted") return true;
            if (rec.state === "failed") return false;
            try {
                var d = doc();
                var mount = d && typeof d.getElementById === "function" ? d.getElementById(e.mountId) : null;
                if (!mount) { markFailed(name, "not-inserted"); return false; }
                var res = readFragment(e);
                if (!res || res.ok !== true) { markFailed(name, (res && res.kind) || "unreadable"); return false; }
                var text = String(res.text);
                if (text.charAt(0) === BOM) text = text.slice(1);
                if (!/\S/.test(text)) { markFailed(name, "empty"); return false; }
                mount.innerHTML = text;
                rec.state = "mounted";
                var queue = rec.queue;
                rec.queue = [];
                var listeners = mountedListeners.slice(0);
                for (var i = 0; i < listeners.length; i++) runCallback(name, function (el) { return listeners[i](name, el); }, mount);
                for (var j = 0; j < queue.length; j++) runCallback(name, queue[j], mount);
                emit("views.mounted", { name: name });
                settleCheck();
                return true;
            } catch (err) {
                if (rec.state === "pending") markFailed(name, "unreadable");
                return rec.state === "mounted";
            }
        }

        function ensureMounted(name) {
            var rec = records[name];
            if (!rec) return false;
            if (rec.state === "mounted") return true;
            if (rec.state === "failed") return false;
            return mountSync(name);
        }

        function whenMounted(name, fn) {
            var rec = records[name];
            if (!rec || typeof fn !== "function") return false;
            if (rec.state === "mounted") {
                var d = doc();
                var e = byName(name);
                runCallback(name, fn, d && d.getElementById ? d.getElementById(e.mountId) : null);
                return true;
            }
            if (rec.state === "failed") return false;
            rec.queue.push(fn);
            return true;
        }

        function onMounted(fn) {
            if (typeof fn !== "function") return function () { };
            mountedListeners.push(fn);
            return function () {
                for (var i = 0; i < mountedListeners.length; i++) {
                    if (mountedListeners[i] === fn) { mountedListeners.splice(i, 1); break; }
                }
            };
        }

        function watchdog() {
            loader.watchdog = null;
            for (var i = 0; i < MANIFEST.length; i++) {
                if (records[MANIFEST[i].name].state === "pending") markFailed(MANIFEST[i].name, "not-inserted");
            }
            flushHeld();
        }

        function begin(now) {
            if (loader.t0 !== null) return api;
            loader.t0 = typeof now === "number" ? now : Date.now();
            var p = perf();
            if (p && typeof p.span === "function") {
                try { span = p.span("startup.views", {}); } catch (e) { span = null; }
            }
            if (p && typeof p.subscribe === "function") {
                try {
                    perfUnsub = p.subscribe(function (ev) {
                        if (ev && ev.name === "lifecycle.transition" && ev.fields && ev.fields.state === "SHELL_VISIBLE") flushHeld();
                    });
                } catch (e) { perfUnsub = null; }
            }
            loader.watchdog = timer(watchdog, WATCHDOG_MS);
            return api;
        }

        function startDeferred() {
            flushHeld();
            if (loader.deferredStarted) return false;
            loader.deferredStarted = true;
            var queue = [];
            for (var i = 0; i < DEFERRED_ORDER.length; i++) {
                if (records[DEFERRED_ORDER[i]].state === "pending") queue.push(DEFERRED_ORDER[i]);
            }
            function next() {
                while (queue.length && records[queue[0]].state !== "pending") queue.shift();
                if (!queue.length) { flushHeld(); return; }
                mountSync(queue.shift());
                flushHeld();
                if (queue.length) timer(next, 0);
            }
            raf(function () { timer(next, 0); });
            return true;
        }

        function configure(options) {
            options = options || {};
            var keys = ["readText", "doc", "perf", "lifecycle", "setTimeout", "clearTimeout", "raf", "showToast", "extensionPath"];
            for (var i = 0; i < keys.length; i++) {
                if (Object.prototype.hasOwnProperty.call(options, keys[i])) deps[keys[i]] = options[keys[i]];
            }
            return api;
        }

        var api = {
            MANIFEST: MANIFEST,
            DEFERRED_ORDER: DEFERRED_ORDER,
            WATCHDOG_MS: WATCHDOG_MS,
            begin: begin,
            mountSync: mountSync,
            ensureMounted: ensureMounted,
            whenMounted: whenMounted,
            onMounted: onMounted,
            startDeferred: startDeferred,
            flushHeld: flushHeld,
            getState: function (name) { return records[name] ? records[name].state : null; },
            getFailure: function (name) { return records[name] ? records[name].failure : null; },
            getHeldFailures: function () { return heldFailures.slice(0); },
            entryFor: byName,
            configure: configure,
            dispose: function () { if (typeof perfUnsub === "function") perfUnsub(); perfUnsub = null; }
        };
        return api;
    }

    var CompSaverViews = createLoader();
    CompSaverViews.create = createLoader;
    root.CompSaverViews = CompSaverViews;
    if (typeof module !== "undefined" && module.exports) module.exports = CompSaverViews;
})(typeof window !== "undefined" ? window : globalThis);
