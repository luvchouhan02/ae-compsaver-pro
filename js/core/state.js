// ============================================================
// core/state.js — shared singletons + app state (single source of truth)
// ------------------------------------------------------------
// Centralizes the CSInterface bridge, the cached DOM map, and the
// navigation / save / bulk-selection state that the UI and feature
// modules read and write. Moved verbatim from main.js; every
// reference resolves here via the global scope chain (no call-site
// changes). Must load AFTER CSInterface.js (needs the CSInterface
// constructor) and core/constants.js (needs SECTIONS / MODULES).
// ============================================================

var csInterface = new CSInterface();
var rootPath = "";
var libraryPaths = [];
var savePath = "";
var allTemplates = [];
var currentMainModule = MODULES.TEMPLATES;
var tmpBulkMode = false;
var tmpBulkSelected = [];
var currentToolkitSubSection = "tools";
var currentSection = SECTIONS.COMP;
var currentImageSection = SECTIONS.ICON;
var currentTextSection = SECTIONS.TEXT;
var currentCategory = "All";
var renameTargetCard = null;
var moveTargetCard = null;
var selectedCatValue = "Uncategorized";
var selectedMoveCat = "";
var selectedSaveType = SECTIONS.COMP;
var detectedSaveType = "";
var saveCapabilities = null;
var searchDebounceTimer = null;
var pingInterval = null;

// Cached DOM lookups, populated by cacheDOM() in main.js on init.
var DOM = {};

// ── Folder busy-set ────────────────────────────────────────────────
// Tracks template folders that have a background preview render writing into
// them right now. Delete paths consult this so a card can't be wiped mid-render
// (which on Windows causes EPERM/EBUSY and orphaned folders). Shared by the
// preview pipeline (textanim) and the templates bulk-delete path.
var busyFolders = {};

function normFolderPath(p) {
    return ("" + (p || "")).replace(/\\/g, "/").replace(/\/+$/, "");
}
function markFolderBusy(p) {
    var k = normFolderPath(p);
    if (!k) return;
    busyFolders[k] = true;
    if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
        typeof AppLifecycle !== "undefined") AppLifecycle.markWorkStart("busy-folder", k);
}
function clearFolderBusy(p) {
    var k = normFolderPath(p);
    if (!k) return;
    delete busyFolders[k];
    if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
        typeof AppLifecycle !== "undefined") AppLifecycle.markWorkEnd("busy-folder", k);
}
// True if `folderPath` is currently rendering, contains a folder that is,
// or sits inside one that is (prefix match in both directions).
function isFolderBusy(folderPath) {
    var target = normFolderPath(folderPath);
    if (!target) return false;
    if (busyFolders[target]) return true;
    for (var b in busyFolders) {
        if (!busyFolders.hasOwnProperty(b)) continue;
        if (b === target) return true;
        if (b.indexOf(target + "/") === 0) return true; // busy render lives inside the target
        if (target.indexOf(b + "/") === 0) return true; // target lives inside a busy folder
    }
    return false;
}

// Templates-grid refresh hook (debounced). The real implementation is registered
// by main.js once the (private) loadTemplates is in scope; the shared preview
// pipeline calls this after an .aep template preview finishes rendering.
// Default no-op until registered.
var loadTemplatesDebounced = function () { };

// Toolkit sequencer stagger mode ("down"|"up"|...). Shared by resetToolkitStates
// (ui/header.js) and the sequencer controls (main.js).
var selectedStaggerMode = "down";

// ── Metadata_Cache (save/import performance redesign) ───────────────
// Persisted, validity-key-gated store of expensive per-template metadata
// (category, section, dimensions, asset list, thumbnail path, ...). The
// implementation lives in core/persistence.js (loaded AFTER this file), so
// the singleton is created lazily on first access. Import and library-load
// paths read through here to avoid rescanning template contents.
var metadataCache = null;
function getMetadataCache() {
    if (!metadataCache && typeof MetadataCache !== "undefined") {
        metadataCache = new MetadataCache();
    }
    return metadataCache;
}

// ── Library_Index (save/import performance redesign) ────────────────
// Persisted, incrementally-updated view of the template library. Backs
// `allTemplates` (above) so the panel can insert an optimistic card at the
// head, patch a single card on background-job completion, or remove one entry
// WITHOUT a full Library_Scan. Implementation lives in core/persistence.js
// (loaded AFTER this file), so the singleton is created lazily on first access.
var libraryIndex = null;
function getLibraryIndex() {
    if (!libraryIndex && typeof LibraryIndex !== "undefined") {
        libraryIndex = new LibraryIndex();
    }
    return libraryIndex;
}


// Lifecycle-only cleanup; legacy mode keeps the approved pre-Phase 1 behavior.
function disposeSharedState() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
    busyFolders = {};
    metadataCache = null;
    libraryIndex = null;
}
if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
    typeof AppLifecycle !== "undefined") AppLifecycle.onDispose(disposeSharedState);