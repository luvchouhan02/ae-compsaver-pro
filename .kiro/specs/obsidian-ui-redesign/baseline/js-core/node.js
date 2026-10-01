// ============================================================
// core/node.js — Effects engine Node.js module resolver
// ------------------------------------------------------------
// Lazily resolves CEP's Node integration (require / window.require)
// into shared fs/path/os singletons used by the Effects pipeline.
// Moved verbatim from main.js; nodeFs/nodePath/nodeOs and
// resolveNodeModules() resolve as globals via the scope chain.
//
// NOTE: TextAnim (req/nfs/getNodePath) and the clipboard-paste
// getSafeRequire() are separate, feature-local mechanisms and are
// intentionally NOT consolidated here yet (behavior-preserving move).
// ============================================================

// Node.js modules — resolved lazily at first use so CEP's Node.js
// integration (window.require) is guaranteed to be available.
var nodeFs = null, nodePath = null, nodeOs = null;

function resolveNodeModules() {
    if (nodeFs && nodePath) return true;
    var req = null;
    try { if (typeof require !== "undefined") req = require; } catch (e) { }
    if (!req) {
        try {
            if (typeof window !== "undefined" && typeof window.require !== "undefined") {
                req = window.require;
            }
        } catch (e) { }
    }
    if (!req) {
        console.warn("[Effects] Node require() not available — folder watch disabled");
        return false;
    }
    try { nodeFs = req("fs"); } catch (e) { console.warn("[Effects] require('fs') failed:", e.message); }
    try { nodePath = req("path"); } catch (e) { console.warn("[Effects] require('path') failed:", e.message); }
    try { nodeOs = req("os"); } catch (e) { /* os is optional */ }
    return !!(nodeFs && nodePath);
}

// Global convenience accessors for the resolved fs / path modules. Used by
// templates.js (the save pipeline) and available app-wide. NOTE: TextAnim has
// its OWN private nfs()/getNodePath() inside its IIFE closure; those shadow
// these globals within that module and are intentionally separate.
function nfs() {
    resolveNodeModules();
    return nodeFs;
}
function getNodePath() {
    resolveNodeModules();
    return nodePath;
}
