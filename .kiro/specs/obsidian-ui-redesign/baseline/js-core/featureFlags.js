// Phase 1 session-scoped, fail-closed feature flags.
(function (root) {
    "use strict";
    var KEY = "compSaver.featureFlags.v1";
    // lifecycleV1 defaults ON. It gates every resource-disposal registration in
    // the panel — the ping interval, the metadata/search/loadTemplates timers,
    // both ResizeObservers, the effects folder watcher, the TextAnim preview
    // lane, FastMedia.dispose, disposeSharedState and the readiness monitor.
    // Flags are read from sessionStorage, which is empty on every panel load, so
    // while the default was false those registrations could never run in a real
    // panel: AppLifecycle.dispose("beforeunload") always found an empty registry
    // and released nothing. Closed panels therefore left their pollers alive,
    // each still calling evalScript("compSaverPing()") into After Effects, which
    // is what made the host freeze and report "not responding" after repeated
    // reopens. Disposal must be the default, not an opt-in.
    var DEFAULTS = Object.freeze({ version: 1, lifecycleV1: true, debugHostReload: false });

    function load(storage) {
        var parsed = null;
        try {
            var raw = storage && storage.getItem ? storage.getItem(KEY) : null;
            parsed = raw ? JSON.parse(raw) : null;
        } catch (e) { parsed = null; }
        if (!parsed || parsed.version !== 1) return DEFAULTS;
        return Object.freeze({
            version: 1,
            // Explicit `false` is still honoured as an escape hatch, so the
            // legacy no-disposal path stays reachable for diagnosis; anything
            // else (absent key included) leaves disposal enabled.
            lifecycleV1: parsed.lifecycleV1 !== false,
            debugHostReload: parsed.debugHostReload === true
        });
    }

    var api = { KEY: KEY, defaults: DEFAULTS, load: load };
    try { api.flags = load(root.sessionStorage); } catch (e) { api.flags = DEFAULTS; }
    root.FeatureFlags = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);