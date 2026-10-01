// ============================================================
// ui/shell-router.js - Route adapters over CompSaverShellState
// ------------------------------------------------------------
// Creates the single Shell_State instance, registers the 7 route adapters
// built by makeAdapter, and is the only path for Route changes (Sidebar,
// Command_Palette and startup all call go()). Every dependency (views
// loader, Shell_State factory, legacy switchers, focus manager, document)
// is injectable so Jest runs the router without a DOM.
// Req 4.12, 7.2, 7.3, 7.4, 7.9, 7.10, 7.11, 9.5, 9.6.
// ============================================================
(function (root) {
    "use strict";

    var ROUTES = ["templates", "tools", "effects", "text", "easing", "colorflow", "settings"];
    var LABELS = {
        templates: "Templates", tools: "Workbench", effects: "Effects", text: "Text",
        easing: "Flow", colorflow: "Colors", settings: "Settings"
    };
    // Legacy toolkit sub-section per toolkit Route.
    var TOOLKIT_SUB = { tools: "tools", effects: "effects", text: "text-anim", easing: "graph", colorflow: "colorflow" };
    var RESPONSIVE_QUERIES = { narrow: "(max-width: 279.98px)", expanded: "(min-width: 550.02px)" };

    function contains(list, value) {
        for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
        return false;
    }

    function fail(code, message) {
        var err = new Error(message);
        err.code = code;
        return err;
    }

    function createRouter() {
        var deps = {};
        var state = null;
        var listeners = [];
        var hooks = {};
        var pendingFallback = {};
        var lastLegacyRoute = null;
        var beforeSettings = null;
        var started = false;
        var mqlTokens = [];

        // ── dependency lookups (lazy, so load order never matters) ──────
        function views() { return deps.views || root.CompSaverViews || null; }
        function focus() { return deps.focus || root.CompSaverFocus || null; }
        function doc() { return deps.doc || (typeof document !== "undefined" ? document : null); }
        function legacy() {
            if (deps.legacy) return deps.legacy;
            return {
                switchMainModule: root.switchMainModule,
                switchToolkitSubSection: root.switchToolkitSubSection,
                MODULES: root.MODULES,
                getMainModule: function () { return root.currentMainModule; },
                getToolkitSub: function () { return root.currentToolkitSubSection; }
            };
        }
        function shellStateFactory() { return deps.shellState || root.CompSaverShellState || null; }

        function modules() {
            var m = legacy().MODULES;
            return m || { TEMPLATES: "templates", TOOLKIT: "toolkit", SETTINGS: "settings" };
        }

        // ── legacy switches per Route ────────────────────────────────────
        function runLegacy(route) {
            var l = legacy();
            var M = modules();
            if (route === "templates") {
                if (typeof l.switchMainModule === "function") l.switchMainModule(M.TEMPLATES);
            } else if (route === "settings") {
                if (typeof l.switchMainModule === "function") l.switchMainModule(M.SETTINGS);
            } else {
                if (typeof l.switchMainModule === "function") l.switchMainModule(M.TOOLKIT);
                if (typeof l.switchToolkitSubSection === "function") l.switchToolkitSubSection(TOOLKIT_SUB[route]);
            }
        }

        function legacyShows(route) {
            var l = legacy();
            var M = modules();
            var main = typeof l.getMainModule === "function" ? l.getMainModule() : undefined;
            if (route === "templates") return main === M.TEMPLATES;
            if (route === "settings") return main === M.SETTINGS;
            var sub = typeof l.getToolkitSub === "function" ? l.getToolkitSub() : undefined;
            return main === M.TOOLKIT && sub === TOOLKIT_SUB[route];
        }

        function showOnlyMount(route) {
            var d = doc();
            if (!d || typeof d.getElementById !== "function") return;
            for (var i = 0; i < ROUTES.length; i++) {
                var el = d.getElementById("cs-route-" + ROUTES[i]);
                if (!el) continue;
                var hide = ROUTES[i] !== route;
                if (hide) {
                    el.hidden = true;
                    if (typeof el.setAttribute === "function") el.setAttribute("hidden", "");
                } else {
                    el.hidden = false;
                    if (typeof el.removeAttribute === "function") el.removeAttribute("hidden");
                }
            }
        }

        function viewUnavailable(route) {
            return fail("VIEW_UNAVAILABLE", "The " + LABELS[route] + " view is unavailable");
        }

        function ensureMounted(route) {
            var v = views();
            if (!v || typeof v.ensureMounted !== "function") return true;
            try { return v.ensureMounted(route) === true; } catch (e) { return false; }
        }

        // ── adapter factory ──────────────────────────────────────────────
        function makeAdapter(route) {
            return {
                activate: function (ctx) {
                    if (!ensureMounted(route)) throw viewUnavailable(route); // before any side effect
                    showOnlyMount(route);
                    var source = ctx && ctx.source;
                    var ranAtStartup = source === "startup" && legacyShows(route);
                    var unchanged = source === "rollback" && lastLegacyRoute === route;
                    if (ranAtStartup) lastLegacyRoute = route;
                    else if (!unchanged) { lastLegacyRoute = route; runLegacy(route); }
                    var h = hooks[route];
                    if (h && typeof h.onActivate === "function") h.onActivate(ctx);
                },
                deactivate: function () { },
                restore: function (r) {
                    var h = hooks[route];
                    if (!h || typeof h.onRestore !== "function") return null;
                    var result = h.onRestore(r && r.state ? r.state : {});
                    if (result && result.fellBack === true && typeof h.fallback !== "undefined") {
                        pendingFallback[route] = h.fallback;
                    }
                    return result;
                },
                getRestorationState: function () {
                    var h = hooks[route];
                    return h && typeof h.patch === "function" ? h.patch() : null;
                },
                render: function () { showOnlyMount(route); },
                handleAction: function (a) {
                    var h = hooks[route];
                    var actions = h && h.actions;
                    if (a && actions && typeof actions[a.type] === "function") return actions[a.type](a);
                    return false;
                },
                getPrimaryAction: function () { return null; }
            };
        }

        // ── public API ───────────────────────────────────────────────────
        function configure(options) {
            options = options || {};
            var keys = ["views", "focus", "doc", "legacy", "shellState", "matchMedia", "raf"];
            for (var i = 0; i < keys.length; i++) {
                if (Object.prototype.hasOwnProperty.call(options, keys[i])) deps[keys[i]] = options[keys[i]];
            }
            return api;
        }

        function ensureState(initialRoute) {
            if (state) return state;
            var factory = shellStateFactory();
            if (!factory || typeof factory.create !== "function") return null;
            state = factory.create({ activeRoute: initialRoute, responsiveMode: currentResponsiveMode() });
            for (var i = 0; i < ROUTES.length; i++) state.registerView(ROUTES[i], makeAdapter(ROUTES[i]));
            return state;
        }

        function registerHooks(route, spec) {
            if (!contains(ROUTES, route) || !spec) return false;
            hooks[route] = spec;
            return true;
        }

        function current() {
            if (!state || !started) return null;
            return state.getRoute();
        }

        function writeFallback(route) {
            if (!Object.prototype.hasOwnProperty.call(pendingFallback, route)) return;
            var value = pendingFallback[route];
            delete pendingFallback[route];
            try { state.updateRouteState(route, { subsection: value }); } catch (e) { /* no error, no toast */ }
        }

        function notify(route, previous, source) {
            var snapshot = listeners.slice(0);
            for (var i = 0; i < snapshot.length; i++) {
                try { snapshot[i](route, previous, source); } catch (e) { /* a listener never breaks navigation */ }
            }
        }

        function go(route, options) {
            var source = options && typeof options.source === "string" ? options.source : "programmatic";
            try {
                if (!contains(ROUTES, route)) return { ok: false, code: "UNKNOWN_ROUTE", message: "Unknown route: " + route };
                var s = ensureState(route);
                if (!s) return { ok: false, code: "ROUTER_UNAVAILABLE", message: "Shell state is unavailable" };
                var previous = started ? s.getRoute() : null;
                if (started && previous === route) return { ok: true, route: route };
                s.navigate(route, { source: source });
                started = true;
                if (route === "settings" && previous && previous !== "settings") beforeSettings = previous;
                writeFallback(route);
                notify(route, previous, source);
                var f = focus();
                if (f && typeof f.check === "function") {
                    try { f.check("route"); } catch (e) { /* ignore */ }
                }
                return { ok: true, route: route };
            } catch (err) {
                var original = err && err.originalError ? err.originalError : err;
                var code = original && original.code ? original.code : (err && err.code) || "NAVIGATION_FAILED";
                var message = original && original.message ? original.message : String(original);
                delete pendingFallback[route];
                return { ok: false, code: code, message: message };
            }
        }

        function start(startRoute, options) {
            var result = go(startRoute, { source: (options && options.source) || "startup" });
            // Keep Shell_State responsiveMode in step with the @media modes.
            try { watchResponsiveMode(); } catch (e) { /* informational only */ }
            return result;
        }

        function back() {
            var target = beforeSettings && beforeSettings !== "settings" ? beforeSettings : "templates";
            return go(target, { source: "back" });
        }

        function onChange(fn) {
            if (typeof fn !== "function") return function () { };
            listeners.push(fn);
            var active = true;
            return function () {
                if (!active) return;
                active = false;
                for (var i = 0; i < listeners.length; i++) {
                    if (listeners[i] === fn) { listeners.splice(i, 1); break; }
                }
            };
        }

        function dispatch(route, action) {
            var result = go(route, { source: "dispatch" });
            if (!result.ok) return result;
            try {
                var handled = makeDispatch(route, action);
                return { ok: true, route: route, handled: handled };
            } catch (err) {
                return { ok: false, code: (err && err.code) || "ACTION_FAILED", message: err && err.message ? err.message : String(err) };
            }
        }

        function makeDispatch(route, action) {
            var h = hooks[route];
            var actions = h && h.actions;
            if (action && actions && typeof actions[action.type] === "function") return actions[action.type](action);
            return false;
        }

        function updateRouteState(route, patch) {
            if (!state) return null;
            return state.updateRouteState(route, patch);
        }

        function getShellState() { return state; }

        // ── responsive mode (Req 15.9) ───────────────────────────────────
        function matchMediaFn() {
            if (deps.matchMedia) return deps.matchMedia;
            return typeof root.matchMedia === "function" ? root.matchMedia.bind(root) : null;
        }

        function currentResponsiveMode() {
            var mm = matchMediaFn();
            if (!mm) return "compact";
            try {
                if (mm(RESPONSIVE_QUERIES.narrow).matches) return "narrow";
                if (mm(RESPONSIVE_QUERIES.expanded).matches) return "expanded";
            } catch (e) { /* fall through */ }
            return "compact";
        }

        function syncResponsiveMode() {
            if (!state) return;
            var mode = currentResponsiveMode();
            try {
                state.setResponsiveMode(mode);
            } catch (err) {
                if (err && err.code === "TRANSITION_IN_PROGRESS") {
                    var raf = deps.raf || (typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame.bind(root) : null);
                    if (raf) raf(syncResponsiveMode);
                }
            }
        }

        function watchResponsiveMode() {
            var mm = matchMediaFn();
            if (!mm || mqlTokens.length) return;
            var keys = ["narrow", "expanded"];
            for (var i = 0; i < keys.length; i++) {
                var mql;
                try { mql = mm(RESPONSIVE_QUERIES[keys[i]]); } catch (e) { mql = null; }
                if (!mql) continue;
                if (typeof mql.addEventListener === "function") mql.addEventListener("change", syncResponsiveMode);
                else if (typeof mql.addListener === "function") mql.addListener(syncResponsiveMode);
                mqlTokens.push(mql);
            }
            syncResponsiveMode();
        }

        var api = {
            ROUTES: ROUTES,
            LABELS: LABELS,
            configure: configure,
            registerHooks: registerHooks,
            start: start,
            current: current,
            go: go,
            back: back,
            onChange: onChange,
            dispatch: dispatch,
            updateRouteState: updateRouteState,
            getShellState: getShellState,
            watchResponsiveMode: watchResponsiveMode,
            currentResponsiveMode: currentResponsiveMode,
            labelFor: function (route) { return LABELS[route] || String(route); }
        };
        return api;
    }

    if (typeof Object.freeze === "function") {
        Object.freeze(ROUTES);
        Object.freeze(LABELS);
    }
    var CompSaverRouter = createRouter();
    CompSaverRouter.create = createRouter;
    root.CompSaverRouter = CompSaverRouter;
    if (typeof module !== "undefined" && module.exports) module.exports = CompSaverRouter;
})(typeof window !== "undefined" ? window : globalThis);
