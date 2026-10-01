/* Semantic route and restoration state for the adaptive CompSaver shell. */
(function (root) {
    "use strict";

    var ROUTES = ["templates", "tools", "effects", "text", "easing", "colorflow", "settings"];
    var RESPONSIVE_MODES = ["narrow", "compact", "expanded"];
    var CONTEXT_STATUSES = ["ready", "degraded", "unavailable"];
    var ADAPTER_METHODS = ["activate", "deactivate", "render", "handleAction", "getRestorationState", "restore", "getPrimaryAction"];
    var RESTORATION_SCHEMA = "compsaver.route-restoration/v1";
    var own = Object.prototype.hasOwnProperty;
    var objectTag = Object.prototype.toString;

    function fail(code, message) {
        var error = new Error(message);
        error.code = code;
        return error;
    }

    function contains(list, value) {
        for (var i = 0; i < list.length; i += 1) if (list[i] === value) return true;
        return false;
    }

    function assertRoute(routeId) {
        if (!contains(ROUTES, routeId)) throw fail("UNKNOWN_ROUTE", "Unknown CompSaver route: " + routeId);
    }

    function isPlainObject(value) {
        if (!value || objectTag.call(value) !== "[object Object]") return false;
        if (typeof Object.getPrototypeOf !== "function") return true;
        var prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function cloneSemantic(value, path, stack) {
        var valueType = typeof value;
        if (value === null || valueType === "string" || valueType === "boolean") return value;
        if (valueType === "number" && isFinite(value)) return value;
        if (valueType !== "object") throw fail("NON_SEMANTIC_STATE", path + " must contain JSON-safe semantic values");
        if (contains(stack, value)) throw fail("NON_SEMANTIC_STATE", path + " must not contain cycles");
        stack.push(value);
        var copy;
        if (Array.isArray(value)) {
            copy = [];
            for (var i = 0; i < value.length; i += 1) copy.push(cloneSemantic(value[i], path + "[" + i + "]", stack));
        } else {
            if (!isPlainObject(value)) throw fail("NON_SEMANTIC_STATE", path + " must not contain rendered or host objects");
            copy = {};
            Object.keys(value).forEach(function (key) {
                if (key === "__proto__" || key === "constructor" || key === "prototype") {
                    throw fail("UNSAFE_STATE_KEY", path + " contains unsafe key " + key);
                }
                copy[key] = cloneSemantic(value[key], path + "." + key, stack);
            });
        }
        stack.pop();
        return copy;
    }

    function semanticCopy(value, path) {
        return cloneSemantic(value, path || "state", []);
    }

    function validateSelectedIds(value) {
        if (!Array.isArray(value)) throw fail("INVALID_SELECTION", "selectedIds must be an array");
        var seen = {}, result = [];
        value.forEach(function (id) {
            var type = typeof id;
            if ((type !== "string" && type !== "number") || (type === "number" && !isFinite(id))) {
                throw fail("INVALID_SELECTION", "selectedIds must contain finite string or number identifiers");
            }
            var key = type + ":" + id;
            if (seen[key]) throw fail("INVALID_SELECTION", "selectedIds must not contain duplicates");
            seen[key] = true;
            result.push(id);
        });
        return result;
    }

    function validateToken(value, name, stringOnly) {
        if (value === null) return null;
        if (typeof value === "string") return value;
        if (!stringOnly && typeof value === "number" && isFinite(value)) return value;
        throw fail("INVALID_" + name.toUpperCase(), name + " must be " + (stringOnly ? "a string" : "a string or finite number") + " or null");
    }

    function normalizeRoutePatch(patch, requireComplete) {
        if (!isPlainObject(patch)) throw fail("INVALID_ROUTE_STATE", "Route state must be a plain object");
        var allowed = ["subsection", "selectedIds", "bulkMode", "drafts", "scrollToken", "focusToken"];
        Object.keys(patch).forEach(function (key) {
            if (!contains(allowed, key)) throw fail("UNKNOWN_ROUTE_STATE_FIELD", "Unknown route state field: " + key);
        });
        if (requireComplete) allowed.forEach(function (key) {
            if (!own.call(patch, key)) throw fail("INCOMPLETE_RESTORATION", "Restoration state is missing " + key);
        });
        var normalized = {};
        if (own.call(patch, "subsection")) {
            if (patch.subsection !== null && typeof patch.subsection !== "string") throw fail("INVALID_SUBSECTION", "subsection must be a string or null");
            normalized.subsection = patch.subsection;
        }
        if (own.call(patch, "selectedIds")) normalized.selectedIds = validateSelectedIds(patch.selectedIds);
        if (own.call(patch, "bulkMode")) {
            if (typeof patch.bulkMode !== "boolean") throw fail("INVALID_BULK_MODE", "bulkMode must be boolean");
            normalized.bulkMode = patch.bulkMode;
        }
        if (own.call(patch, "drafts")) {
            if (!isPlainObject(patch.drafts)) throw fail("INVALID_DRAFTS", "drafts must be a plain object");
            normalized.drafts = semanticCopy(patch.drafts, "drafts");
        }
        if (own.call(patch, "scrollToken")) normalized.scrollToken = validateToken(patch.scrollToken, "scrollToken", false);
        if (own.call(patch, "focusToken")) normalized.focusToken = validateToken(patch.focusToken, "focusToken", true);
        return normalized;
    }

    function makeRouteState() {
        return { subsection: null, selectedIds: [], bulkMode: false, drafts: {}, scrollToken: null, focusToken: null, revision: 0 };
    }

    function routeProjection(routeState) {
        return {
            subsection: routeState.subsection,
            selectedIds: routeState.selectedIds.slice(0),
            bulkMode: routeState.bulkMode,
            drafts: semanticCopy(routeState.drafts, "drafts"),
            scrollToken: routeState.scrollToken,
            focusToken: routeState.focusToken
        };
    }

    function assertResponsiveMode(mode) {
        if (!contains(RESPONSIVE_MODES, mode)) throw fail("UNKNOWN_RESPONSIVE_MODE", "Unknown responsive mode: " + mode);
    }

    function normalizeContextPatch(patch) {
        if (!isPlainObject(patch)) throw fail("INVALID_CONTEXT", "Context must be a plain object");
        var allowed = ["compName", "templateCount", "bridgeStatus"], normalized = {};
        Object.keys(patch).forEach(function (key) {
            if (!contains(allowed, key)) throw fail("UNKNOWN_CONTEXT_FIELD", "Unknown context field: " + key);
        });
        if (own.call(patch, "compName")) {
            if (typeof patch.compName !== "string") throw fail("INVALID_CONTEXT", "compName must be a string");
            normalized.compName = patch.compName;
        }
        if (own.call(patch, "templateCount")) {
            if (typeof patch.templateCount !== "number" || !isFinite(patch.templateCount) || patch.templateCount < 0 || Math.floor(patch.templateCount) !== patch.templateCount) {
                throw fail("INVALID_CONTEXT", "templateCount must be a non-negative integer");
            }
            normalized.templateCount = patch.templateCount;
        }
        if (own.call(patch, "bridgeStatus")) {
            if (!contains(CONTEXT_STATUSES, patch.bridgeStatus)) throw fail("UNKNOWN_CONTEXT_STATUS", "Unknown bridge status: " + patch.bridgeStatus);
            normalized.bridgeStatus = patch.bridgeStatus;
        }
        return normalized;
    }

    function create(options) {
        options = options || {};
        if (!isPlainObject(options)) throw fail("INVALID_OPTIONS", "Shell state options must be a plain object");
        Object.keys(options).forEach(function (key) {
            if (!contains(["activeRoute", "responsiveMode", "context"], key)) throw fail("UNKNOWN_OPTION", "Unknown shell state option: " + key);
        });
        var activeRoute = own.call(options, "activeRoute") ? options.activeRoute : "templates";
        var responsiveMode = own.call(options, "responsiveMode") ? options.responsiveMode : "compact";
        assertRoute(activeRoute);
        assertResponsiveMode(responsiveMode);
        var context = { compName: "", templateCount: 0, bridgeStatus: "ready" };
        var initialContext = normalizeContextPatch(options.context || {});
        Object.keys(initialContext).forEach(function (key) { context[key] = initialContext[key]; });
        var routeStates = {}, views = {}, activeView = null, transitioning = false;
        ROUTES.forEach(function (routeId) { routeStates[routeId] = makeRouteState(); });

        function assertIdle() {
            if (transitioning) throw fail("TRANSITION_IN_PROGRESS", "Shell state cannot be mutated during an adapter transition");
        }

        function commitPatch(routeId, normalized) {
            var current = routeStates[routeId];
            Object.keys(normalized).forEach(function (key) { current[key] = normalized[key]; });
            current.revision += 1;
        }

        function getRouteState(routeId) {
            assertRoute(routeId);
            var result = routeProjection(routeStates[routeId]);
            result.revision = routeStates[routeId].revision;
            return result;
        }

        function getRestorationState(routeId) {
            assertRoute(routeId);
            return {
                schema: RESTORATION_SCHEMA,
                routeId: routeId,
                revision: routeStates[routeId].revision,
                state: routeProjection(routeStates[routeId])
            };
        }

        function getState() {
            var routes = {};
            ROUTES.forEach(function (routeId) { routes[routeId] = getRouteState(routeId); });
            return {
                activeRoute: activeRoute,
                responsiveMode: responsiveMode,
                routes: routes,
                context: semanticCopy(context, "context"),
                activeAdapterRoute: activeView
            };
        }

        function updateRouteState(routeId, patch, expectedRevision) {
            assertIdle();
            assertRoute(routeId);
            if (typeof expectedRevision !== "undefined" && expectedRevision !== routeStates[routeId].revision) {
                throw fail("STALE_RESTORATION", "Route state revision is stale for " + routeId);
            }
            var normalized = normalizeRoutePatch(patch, false);
            if (Object.keys(normalized).length) commitPatch(routeId, normalized);
            return getRouteState(routeId);
        }

        function applyRestorationState(restoration) {
            assertIdle();
            if (!isPlainObject(restoration) || restoration.schema !== RESTORATION_SCHEMA) throw fail("UNKNOWN_RESTORATION_SCHEMA", "Unknown restoration schema");
            assertRoute(restoration.routeId);
            if (restoration.revision !== routeStates[restoration.routeId].revision) throw fail("STALE_RESTORATION", "Restoration state is stale for " + restoration.routeId);
            var normalized = normalizeRoutePatch(restoration.state, true);
            commitPatch(restoration.routeId, normalized);
            return getRouteState(restoration.routeId);
        }

        function setResponsiveMode(mode) {
            assertIdle();
            assertResponsiveMode(mode);
            responsiveMode = mode;
            return responsiveMode;
        }

        function setContext(patch) {
            assertIdle();
            var normalized = normalizeContextPatch(patch);
            Object.keys(normalized).forEach(function (key) { context[key] = normalized[key]; });
            return semanticCopy(context, "context");
        }

        function validateAdapter(adapter) {
            if (!isPlainObject(adapter)) throw fail("INVALID_ADAPTER", "View adapter must be a plain object");
            ADAPTER_METHODS.forEach(function (method) {
                if (typeof adapter[method] !== "function") throw fail("INVALID_ADAPTER", "View adapter is missing method " + method);
            });
        }

        function registerView(routeId, adapter) {
            assertIdle();
            assertRoute(routeId);
            validateAdapter(adapter);
            if (views[routeId]) throw fail("ADAPTER_ALREADY_REGISTERED", "A view adapter is already registered for " + routeId);
            views[routeId] = adapter;
            return adapter;
        }

        function unregisterView(routeId) {
            assertIdle();
            assertRoute(routeId);
            if (!views[routeId]) throw fail("UNKNOWN_ADAPTER", "No view adapter is registered for " + routeId);
            if (activeView === routeId) throw fail("ADAPTER_ACTIVE", "Deactivate the active adapter before unregistering " + routeId);
            delete views[routeId];
        }

        function adapterContext(routeId, options) {
            options = options || {};
            return {
                routeId: routeId,
                routeState: getRouteState(routeId),
                restorationState: getRestorationState(routeId),
                responsiveMode: responsiveMode,
                context: semanticCopy(context, "context"),
                source: typeof options.source === "string" ? options.source : "programmatic",
                restoreFocus: options.restoreFocus !== false
            };
        }

        function capturePatch(routeId, adapter) {
            var captured = adapter.getRestorationState();
            if (captured === null || typeof captured === "undefined") return null;
            return normalizeRoutePatch(captured, false);
        }

        function lifecycleFailure(code, routeId, original) {
            var error = fail(code, "View adapter lifecycle failed for " + routeId + ": " + (original && original.message ? original.message : original));
            error.originalError = original;
            return error;
        }

        function navigate(routeId, options) {
            assertIdle();
            assertRoute(routeId);
            if (!views[routeId]) throw fail("UNKNOWN_ADAPTER", "No view adapter is registered for " + routeId);
            if (activeView === routeId) return getState();
            var sourceRoute = activeView;
            var sourceAdapter = sourceRoute ? views[sourceRoute] : null;
            var targetAdapter = views[routeId];
            var sourcePatch = null;
            var sourceWasDeactivated = false;
            var targetWasActivated = false;
            transitioning = true;
            try {
                if (sourceAdapter) sourcePatch = capturePatch(sourceRoute, sourceAdapter);
                if (sourceAdapter) {
                    sourceAdapter.deactivate();
                    sourceWasDeactivated = true;
                }
                targetAdapter.activate(adapterContext(routeId, options));
                targetWasActivated = true;
                targetAdapter.restore(getRestorationState(routeId));
                if (sourcePatch && Object.keys(sourcePatch).length) commitPatch(sourceRoute, sourcePatch);
                activeRoute = routeId;
                activeView = routeId;
                return getState();
            } catch (error) {
                if (targetWasActivated) {
                    try { targetAdapter.deactivate(); } catch (ignoredTargetError) { /* preserve original lifecycle failure */ }
                }
                if (sourceWasDeactivated) {
                    try {
                        sourceAdapter.activate(adapterContext(sourceRoute, { source: "rollback", restoreFocus: true }));
                        sourceAdapter.restore(getRestorationState(sourceRoute));
                    } catch (ignoredRollbackError) { /* semantic state remains on the source route */ }
                }
                throw lifecycleFailure("ADAPTER_ACTIVATION_FAILED", routeId, error);
            } finally {
                transitioning = false;
            }
        }

        function deactivate(routeId) {
            assertIdle();
            if (!activeView) throw fail("NO_ACTIVE_ADAPTER", "No view adapter is active");
            if (typeof routeId !== "undefined") {
                assertRoute(routeId);
                if (routeId !== activeView) throw fail("ADAPTER_NOT_ACTIVE", "View adapter is not active for " + routeId);
            }
            var currentRoute = activeView;
            var adapter = views[currentRoute];
            transitioning = true;
            try {
                var patch = capturePatch(currentRoute, adapter);
                adapter.deactivate();
                if (patch && Object.keys(patch).length) commitPatch(currentRoute, patch);
                activeView = null;
                return getState();
            } catch (error) {
                throw lifecycleFailure("ADAPTER_DEACTIVATION_FAILED", currentRoute, error);
            } finally {
                transitioning = false;
            }
        }

        return {
            getState: getState,
            getRoute: function () { return activeRoute; },
            getRouteState: getRouteState,
            getRestorationState: getRestorationState,
            updateRouteState: updateRouteState,
            applyRestorationState: applyRestorationState,
            setResponsiveMode: setResponsiveMode,
            setContext: setContext,
            registerView: registerView,
            unregisterView: unregisterView,
            hasView: function (routeId) { assertRoute(routeId); return !!views[routeId]; },
            getRegisteredRoutes: function () { return ROUTES.filter(function (routeId) { return !!views[routeId]; }); },
            navigate: navigate,
            deactivate: deactivate
        };
    }

    var api = {
        schemaVersion: "1.0.0",
        restorationSchema: RESTORATION_SCHEMA,
        routes: ROUTES.slice(0),
        responsiveModes: RESPONSIVE_MODES.slice(0),
        contextStatuses: CONTEXT_STATUSES.slice(0),
        adapterMethods: ADAPTER_METHODS.slice(0),
        create: create
    };
    if (typeof Object.freeze === "function") {
        Object.freeze(api.routes);
        Object.freeze(api.responsiveModes);
        Object.freeze(api.contextStatuses);
        Object.freeze(api.adapterMethods);
        Object.freeze(api);
    }
    root.CompSaverShellState = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : this));