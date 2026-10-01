// ============================================================
// import.jsx - import engines + template & category ops + safe comp resolver
// (ExtendScript module - included by compSaver.jsx; functions are global)
// ============================================================

// =========================================================
// IMPORT — SINGLE-UNDO-GROUP BATCH GUARD
// ---------------------------------------------------------
// Feature: save-import-performance-redesign (Task 8.1)
//
// After Effects undo groups CANNOT be nested: a second beginUndoGroup while
// one is open closes the previous group (and a stray endUndoGroup raises an
// "Undo mismatch" warning). importBatch performs an ENTIRE user import action
// inside ONE undo group (Req 9.3), yet it reuses the per-section import
// routines (importCompDirect / importLayerTypeAep / importImageDirect /
// importTextProperties / importEffect) that each normally own their own undo
// group. To keep exactly one group for the whole batch, those routines call
// the guarded helpers below instead of app.begin/endUndoGroup directly: while
// a batch is active the guards are no-ops (the batch owns the single group);
// outside a batch they behave exactly like the raw calls, so every routine
// keeps working identically when invoked on its own.
// =========================================================

var __CS_IMPORT_BATCH_ACTIVE = false;

function csBeginUndoGroup(name) {
    if (__CS_IMPORT_BATCH_ACTIVE) return; // batch owns the single undo group
    try { app.beginUndoGroup(name); } catch (e) { }
}

function csEndUndoGroup() {
    if (__CS_IMPORT_BATCH_ACTIVE) return; // batch closes its group in finally
    try { app.endUndoGroup(); } catch (e) { }
}

// =========================================================
// IMPORT — BATCH-SCOPED ANCHOR / SELECTION LATCH
// ---------------------------------------------------------
// The anchor and the user's selection for an ENTIRE batch are the ones that
// existed before the action began. placeLayerAtPlayhead selects the layer it
// just inserted, so a per-template getTopSelectedLayer anchored template n to
// the layer template n-1 inserted instead of to the layer the user selected.
// Mirrors the __CS_IMPORT_BATCH_ACTIVE pattern: latched by importBatch, ignored
// entirely by a standalone import. Selection is not an undoable mutation, so
// re-applying it is safe inside the batch's single undo group.
// =========================================================

var __CS_IMPORT_BATCH_ANCHOR = null;

function csBatchAnchorBegin(comp) {
    __CS_IMPORT_BATCH_ANCHOR = null;
    if (!comp) return;
    var sel = [];
    try {
        var s = comp.selectedLayers;
        var i;
        for (i = 0; i < s.length; i++) sel.push(s[i]);
    } catch (eSel) { sel = []; }
    var anchor = null;
    try { anchor = getTopSelectedLayer(comp); } catch (eAnchor) { anchor = null; }
    var cid = null;
    try { cid = comp.id; } catch (eCid) { cid = null; }
    __CS_IMPORT_BATCH_ANCHOR = { compId: cid, anchor: anchor, selection: sel };
}

// Re-apply a latched selection. Touches ONLY layers captured from the
// pre-action selection, so it can never resurrect anything a rollback removed:
// a removed layer's reference throws on assignment and is skipped.
function csBatchAnchorReselect(comp, latch) {
    if (!comp || !latch) return;
    try { deselectAllLayers(comp); } catch (eDes) { }
    var i;
    for (i = 0; i < latch.selection.length; i++) {
        try { latch.selection[i].selected = true; } catch (eSelSet) { }
    }
}

// Restore the user's pre-action selection and clear the latch. Selection is not
// an undoable mutation, so this is safe inside the single undo group.
function csBatchAnchorEnd(comp) {
    var latch = __CS_IMPORT_BATCH_ANCHOR;
    __CS_IMPORT_BATCH_ANCHOR = null;
    csBatchAnchorReselect(comp, latch);
}

// Anchor resolver for every per-section import routine. Inside a batch it puts
// the latched pre-action selection back FIRST, so getTopSelectedLayer hands
// back the layer the user selected before the batch began -- by construction
// the latched anchor -- instead of the layer template n-1 inserted. When the
// user had nothing selected the restored selection is empty and the anchor
// stays null for the whole batch. Standalone it behaves exactly as before.
function csResolveImportAnchor(comp) {
    var latch = __CS_IMPORT_BATCH_ANCHOR;
    if (latch && comp) {
        var cid = null;
        try { cid = comp.id; } catch (eCid) { cid = null; }
        if (cid !== null && cid === latch.compId) csBatchAnchorReselect(comp, latch);
    }
    try { return getTopSelectedLayer(comp); } catch (eTop) { return null; }
}

// =========================================================
// IMPORT — DISK I/O MINIMIZATION + CACHE-FIRST METADATA
// ---------------------------------------------------------
// Feature: save-import-performance-redesign (Task 8.4)
//
// Requirements 8.1–8.6, 11.3, 11.4. During ONE import (single card or a whole
// batch) the host touches disk as little as possible:
//   • read each required file at most once                    (Req 8.1)
//   • enumerate each asset folder at most once                (Req 8.2)
//   • read metadata from the Metadata_Cache when its seeded,
//     validity-key-current entry is present — zero disk reads (Req 8.3, 11.3)
//   • otherwise read the metadata document from disk at most
//     once, PARSE it once, populate an import-scoped cache and
//     reuse it for the remainder of the import                (Req 8.4, 11.4)
//   • never read a file the import does not reference          (Req 8.5)
//   • on a required file read / folder enumeration failure,
//     STOP the affected import and surface an error NAMING the
//     offending file or folder                                 (Req 8.6)
//
// State lives in a single per-import object, __CS_IMPORT_IO. importBatch (the
// single-execution envelope) installs it once via csImportIoBegin(seededMeta)
// so the memoization + cache-first reads span every template in the batch, and
// tears it down with csImportIoEnd() (whose return value carries the metadata
// recomputed on cache misses so the CEP panel can persist it back to the
// Metadata_Cache). While NO context is active every helper degrades to a plain,
// direct read, so each per-section import routine behaves exactly as before
// when invoked on its own.
// =========================================================

var __CS_IMPORT_IO = null;

function csImportIoBegin(seededMetaByFolder) {
    __CS_IMPORT_IO = {
        fileReads: {},   // path key -> content string (each required file read at most once)
        folderEnum: {},  // folder+mask key -> File[] (each folder enumerated at most once)
        metaParsed: {},  // folder key -> parsed meta object (parsed at most once)
        metaFailed: {},  // folder key -> true (parse failed once; never retried)
        seededMeta: seededMetaByFolder || {}, // Metadata_Cache entries keyed by normalized folderPath
        recomputed: {},  // normalized folderPath -> meta recomputed on a cache miss (for CEP persist)
        existingNames: null, // Task 8.9: existing project item name set, computed once (Req 10.5)
        layerRefs: {},   // Task 8.9: located layer references, retained for reuse (Req 10.6)
        classification: null // Task 8.9: last single-pass item classification (Req 10.2)
    };
    return __CS_IMPORT_IO;
}

function csImportIoEnd() {
    var io = __CS_IMPORT_IO;
    __CS_IMPORT_IO = null;
    return io;
}

// Ensure a per-import disk-I/O context exists for the calling import entry
// point. Returns true when THIS call created the context (and therefore owns
// its teardown), false when a context is ALREADY active — which is exactly the
// batch case: importBatch installs one context via csImportIoBegin(seededMeta)
// so the memoization + cache-first reads span every template in the batch, and
// the per-section routines it reuses must NOT tear it down early. Standalone
// single imports (the routine called on its own) create and own their own
// context so "read each required file at most once / enumerate each asset
// folder at most once PER IMPORT" (Req 8.1/8.2) holds for them too.
function csImportIoOwn() {
    if (__CS_IMPORT_IO) return false;
    csImportIoBegin(null);
    return true;
}

// Tear down the per-import context only when the caller owns it (see
// csImportIoOwn). A no-op for routines running inside an active batch.
function csImportIoRelease(owned) {
    if (owned) csImportIoEnd();
}

function csNormPath(fsPath) {
    return ("" + fsPath).replace(/\\/g, "/");
}

function csIoKey(fsPath) {
    return csNormPath(fsPath).toLowerCase();
}

// Build the marker object thrown when a REQUIRED read/enumeration fails so the
// import routine can stop and return an error naming the path (Req 8.6). Detected
// downstream via `e.csIo === true`.
function csMakeIoError(kind, fsPath, cause) {
    var msg = (kind === "folder" ? "Could not read folder: " : "Could not read file: ") + csNormPath(fsPath);
    if (cause) msg += " (" + cause + ")";
    return { csIo: true, kind: kind, path: csNormPath(fsPath), message: msg, toString: function () { return msg; } };
}

// Read a file's text at most once per import (Req 8.1). Subsequent reads of the
// same path reuse the memoized content. `required` selects the Req 8.6 policy:
// when true a missing/unreadable file THROWS a csIo error naming the file; when
// false (an optional document such as meta.json, which the caller guards) it
// degrades to "" exactly like the legacy readFileText.
function csReadFileTextOnce(f, required) {
    if (!f) {
        if (required) throw csMakeIoError("file", "(missing handle)", "no file handle");
        return "";
    }
    var io = __CS_IMPORT_IO;
    var key = csIoKey(f.fsName);
    if (io && io.fileReads.hasOwnProperty(key)) return io.fileReads[key];

    if (!f.exists) {
        if (required) throw csMakeIoError("file", f.fsName, "file not found");
        if (io) io.fileReads[key] = "";
        return "";
    }

    var content = "";
    try {
        var opened = f.open("r");
        if (!opened) throw "open failed";
        content = f.read();
    } catch (e) {
        try { f.close(); } catch (eC) { }
        if (required) throw csMakeIoError("file", f.fsName, "" + e);
        if (io) io.fileReads[key] = "";
        return "";
    }
    try { f.close(); } catch (eC2) { }
    content = content || "";
    if (io) io.fileReads[key] = content;
    return content;
}

// Enumerate a folder's entries at most once per import (Req 8.2). Identical
// repeat enumerations (same folder + mask) reuse the first result. A genuine
// enumeration failure of an EXISTING folder throws a csIo error naming the
// folder (Req 8.6); a non-existent folder returns [] for the caller to handle.
function csEnumerateFolderOnce(folder, mask) {
    if (!folder) return [];
    var io = __CS_IMPORT_IO;
    var key = csIoKey(folder.fsName) + "|" + (mask ? mask : "*");
    if (io && io.folderEnum.hasOwnProperty(key)) return io.folderEnum[key];

    if (!folder.exists) {
        if (io) io.folderEnum[key] = [];
        return [];
    }

    var files = null;
    try {
        files = mask ? folder.getFiles(mask) : folder.getFiles();
    } catch (e) {
        throw csMakeIoError("folder", folder.fsName, "" + e);
    }
    // getFiles() returns [] for an empty (readable) folder and null only on error.
    if (files === null || files === undefined) {
        throw csMakeIoError("folder", folder.fsName, "enumeration returned no result");
    }
    if (io) io.folderEnum[key] = files;
    return files;
}

// Look up a template's metadata seeded from the Metadata_Cache for a current
// (validity-key-matched) entry. importBatch keys seededMeta by normalized
// folderPath; the lookup is tolerant of case and slash direction (Req 8.3).
function csLookupSeededMeta(folder) {
    var io = __CS_IMPORT_IO;
    if (!io || !io.seededMeta || !folder) return null;
    var norm = csNormPath(folder.fsName);
    if (io.seededMeta.hasOwnProperty(norm)) return io.seededMeta[norm];
    var low = norm.toLowerCase();
    if (io.seededMeta.hasOwnProperty(low)) return io.seededMeta[low];
    return null;
}

// Obtain a template's parsed meta.json CACHE-FIRST, reading + parsing at most
// once per import:
//   1. A current entry seeded from the Metadata_Cache is used with ZERO disk
//      reads (Req 8.3 / 11.3).
//   2. On a cache miss/stale entry the document is read from disk at most once
//      and parsed once; the parsed result is memoized AND recorded in
//      `recomputed` so the CEP panel can persist it back to the Metadata_Cache
//      (Req 8.4 / 11.4), then reused for the rest of the import.
//   3. A parse failure is recorded once and never retried; returns null.
// Returns the parsed metadata object, or null when the document is absent or
// unparseable. Falls back to a plain single read when no import context is active.
function csReadTemplateMeta(folder) {
    if (!folder) return null;
    var io = __CS_IMPORT_IO;
    var key = csIoKey(folder.fsName);

    if (io) {
        if (io.metaParsed.hasOwnProperty(key)) return io.metaParsed[key];
        if (io.metaFailed.hasOwnProperty(key)) return null;

        var seeded = csLookupSeededMeta(folder);
        if (seeded) {
            io.metaParsed[key] = seeded;
            return seeded;
        }
    }

    var metaFile = new File(folder.fsName + "/meta.json");
    if (!metaFile.exists) {
        if (io) io.metaParsed[key] = null;
        return null;
    }
    var content = csReadFileTextOnce(metaFile, false);
    var parsed = null;
    // Security (Phase 1): strict parser instead of eval — file content is
    // never executed. The typeof guard covers harnesses that run this file
    // without core.jsx (they provide the strict built-in JSON.parse); in
    // the AE host core.jsx is @included first and jsonParse is used.
    try { parsed = (typeof jsonParse === "function") ? jsonParse(content) : JSON.parse(content); } catch (e) { parsed = null; }

    if (io) {
        if (parsed) {
            io.metaParsed[key] = parsed;
            io.recomputed[csNormPath(folder.fsName)] = parsed;
        } else {
            io.metaFailed[key] = true;
        }
    }
    return parsed;
}

// =========================================================
// IMPORT — SINGLE-PASS CLASSIFICATION, COMPUTE-ONCE NAME SET,
// LAYER-REFERENCE REUSE, DETERMINISTIC COLLISION RESOLVER
// ---------------------------------------------------------
// Feature: save-import-performance-redesign (Task 8.9)
//
// These helpers eliminate repeated project scans and repeated traversals during
// an import (Req 10.1–10.6, 15.4). They cooperate with the per-import I/O context
// (__CS_IMPORT_IO): the existing-name set and located layer references are
// computed/retained once and reused for the remainder of the same import. When no
// context is active every helper still works (it just does not memoize across
// calls), so a standalone single import behaves exactly as before.
// =========================================================

// Classify ONE project item as "comp" | "footage" | "folder" | "other". Tolerant
// of a MODELED item (a plain object carrying a `csKind` string) so the single-pass
// classifier can be exercised against modeled project state without a live After
// Effects host; on real items it uses AE's instanceof, each guarded so a hostile
// getter never aborts the classification.
function csItemKind(item) {
    if (!item) return "other";
    try {
        if (typeof item.csKind === "string") {
            var k = item.csKind.toLowerCase();
            if (k === "comp" || k === "footage" || k === "folder") return k;
            return "other";
        }
    } catch (eKind) { }
    try { if (item instanceof CompItem) return "comp"; } catch (eC) { }
    try { if (item instanceof FolderItem) return "folder"; } catch (eF) { }
    try { if (item instanceof FootageItem) return "footage"; } catch (eFo) { }
    return "other";
}

// Traverse the imported item set EXACTLY ONCE and classify every item as a comp,
// footage, or folder (Req 10.1). The result is TOTAL over the input: every input
// item is placed in exactly one bucket and produces one `kindByIndex` entry, so
// comps.length + footage.length + folders.length + others.length === items.length
// and kindByIndex.length === items.length. The classification is retained so the
// rest of the import reuses it and never traverses the item set again (Req 10.2):
// callers read classified.comps / classified.footage / classified.folders /
// classified.renameTargets instead of re-scanning allImportedItems with instanceof.
function csClassifyItemsOnce(items) {
    var classified = {
        comps: [],
        footage: [],
        folders: [],
        others: [],
        renameTargets: [], // comps + folders in first-seen order (rename candidates)
        kindByIndex: [],
        total: 0
    };
    if (!items) return classified;
    var i;
    for (i = 0; i < items.length; i++) {
        var it = items[i];
        var kind = csItemKind(it);
        classified.kindByIndex.push(kind);
        if (kind === "comp") { classified.comps.push(it); classified.renameTargets.push(it); }
        else if (kind === "footage") { classified.footage.push(it); }
        else if (kind === "folder") { classified.folders.push(it); classified.renameTargets.push(it); }
        else { classified.others.push(it); }
    }
    classified.total = items.length;
    // Retain for reuse within this import (Req 10.2). The returned object is the
    // primary reuse path; this is the guaranteeing net against an accidental rescan.
    if (__CS_IMPORT_IO) __CS_IMPORT_IO.classification = classified;
    return classified;
}

// Compute the set of existing project item names EXACTLY ONCE per import and reuse
// it for every subsequent name lookup (Req 10.5). The first call computes the set
// via getAllProjectNamesLower(); later calls in the SAME import return the SAME
// object — which the collision resolver grows in place as it assigns names — so the
// project is never rescanned for names again during the import. With no active
// import context it degrades to a fresh computation (standalone legacy behavior).
function csExistingNamesOnce() {
    var io = __CS_IMPORT_IO;
    if (io && io.existingNames) return io.existingNames;
    var names = getAllProjectNamesLower();
    if (io) io.existingNames = names;
    return names;
}

// Deterministic, collision-free name resolver (Req 15.4). Given a raw item name,
// whether the item is a comp, and the set of already-used lowercased names, it
// returns a name that collides with NO name in that set, and returns the IDENTICAL
// result for identical inputs. This is the SAME rule the current engine applies in
// safeRenameAllImportedItems: strip a legacy cryptic prefix, fall back to a default
// base when the stripped name is empty, then append " 2", " 3", ... until the name
// is free. Pure: it does NOT mutate `existingNamesLower` — the caller registers the
// assigned name so a later resolution in the same import stays collision-free.
function csResolveName(rawName, isComp, existingNamesLower) {
    var used = existingNamesLower || {};
    var baseName = "" + (rawName || "");
    baseName = baseName.replace(/^(_csf_|_csc_|_CSPC_)[\d_]+/, "");
    if (baseName === "") baseName = (isComp ? "Template Comp" : "Template Assets");

    var newName = baseName;
    var attempt = 1;
    while (used[newName.toLowerCase()]) {
        attempt = attempt + 1;
        newName = baseName + " " + attempt;
    }
    return newName;
}

// Retain a located layer reference so later access to the SAME layer reuses the
// stored reference instead of re-enumerating the active composition (Req 10.6).
// Keyed by a caller-chosen string and scoped to the current import via the I/O
// context. A no-op lookup returns null when no context is active or the key is unset.
function csRememberLayer(key, layer) {
    var io = __CS_IMPORT_IO;
    if (io) {
        if (!io.layerRefs) io.layerRefs = {};
        io.layerRefs[key] = layer;
    }
    return layer;
}

function csRecallLayer(key) {
    var io = __CS_IMPORT_IO;
    if (io && io.layerRefs && io.layerRefs.hasOwnProperty(key)) return io.layerRefs[key];
    return null;
}

// =========================================================
// IMPORT — SINGLE-EXECUTION BATCH ENVELOPE (importBatch)
// ---------------------------------------------------------
// Feature: save-import-performance-redesign (Task 8.1)
//
// importBatch is the ONE host entry point the CEP Import_Engine calls for an
// entire user import action (1..500 templates) — see importCurrentCardToTimeline
// → importTemplates → callHost('importBatch(...)'). It decodes ONE JSON payload
// and performs ALL After Effects DOM work in this single host execution, issuing
// zero additional Bridge round trips (Req 9.3). The whole action runs inside
// exactly ONE undo group with a try/finally that guarantees endUndoGroup on
// every path — success, per-template failure, or a thrown error (Req 9.1/9.2).
//
// It reuses the existing per-section import routines (importCompDirect /
// importLayerTypeAep / importImageDirect / importTextProperties / importEffect)
// unchanged: while the batch is active __CS_IMPORT_BATCH_ACTIVE is true, so those
// routines' csBegin/csEndUndoGroup calls are no-ops (the batch owns the single
// group) and one seeded disk-I/O context (csImportIoBegin) spans every template
// so files/folders are read/enumerated at most once across the whole batch.
//
// Result contract (consumed by parseHostBatchResult in js/core/importEngine.js):
//   { perTemplate: [ { id, status: 'imported' | 'failed', reason? } ] }
// The result is TOTAL over the requested templates — exactly one entry per input
// template (Req 9.6). On whole-call failure or no result every requested template
// is marked failed and the project is left unchanged for those templates (Req 9.5).
// On any per-template failure that template's partial changes are rolled back to
// the exact pre-import state (Req 6.5); a successful import leaves the project
// modified only by the fully applied import (Req 6.6).
// =========================================================

// Snapshot the id set of every current project item so items added by a template
// import can be identified and removed on rollback. Items expose a stable `.id`.
function csSnapshotProjectItemIds() {
    var ids = {};
    try {
        var i;
        for (i = 1; i <= app.project.numItems; i++) {
            try { ids[app.project.item(i).id] = true; } catch (eItem) { }
        }
    } catch (e) { }
    return ids;
}

// Snapshot the layer references currently in a comp so layers added by a template
// import can be identified and removed on rollback. AE layer/item objects support
// identity comparison (the existing importLayerTypeAep already relies on `===`).
function csSnapshotCompLayers(comp) {
    var refs = [];
    if (!comp) return refs;
    try {
        var i;
        for (i = 1; i <= comp.numLayers; i++) {
            try { refs.push(comp.layer(i)); } catch (eLyr) { }
        }
    } catch (e) { }
    return refs;
}

// Roll one template's partial changes back to the exact pre-import state (Req 6.5):
// remove any layer added to the active comp and any project item added since the
// pre-import snapshot. Idempotent and defensive — the per-section routines already
// clean up on many of their own failure paths, so this is the guaranteeing net.
function csRollbackToSnapshot(comp, layerRefsBefore, itemIdsBefore) {
    // 1. Remove layers added to the active comp during this template's import.
    if (comp) {
        try {
            var li;
            for (li = comp.numLayers; li >= 1; li--) {
                var lyr = null;
                try { lyr = comp.layer(li); } catch (eGet) { continue; }
                var known = false;
                var k;
                for (k = 0; k < layerRefsBefore.length; k++) {
                    if (layerRefsBefore[k] === lyr) { known = true; break; }
                }
                if (!known) { try { lyr.remove(); } catch (eRem) { } }
            }
        } catch (eL) { }
    }
    // 2. Remove project items added during this template's import.
    try {
        var pi;
        for (pi = app.project.numItems; pi >= 1; pi--) {
            var item = null;
            try { item = app.project.item(pi); } catch (eGet2) { continue; }
            var id = null;
            try { id = item.id; } catch (eId) { continue; }
            if (id !== null && id !== undefined && !itemIdsBefore[id]) {
                try { item.remove(); } catch (eRem2) { }
            }
        }
    } catch (eP) { }
}

// Dispatch one template to the correct per-section import routine. Folder lookup
// (resolveTemplateFiles → findTemplateFolder) searches every section on disk, so
// the section only selects the IMPORT BEHAVIOR (comp reference vs. flattened
// layers vs. image footage vs. applied text/effect preset). Mirrors the legacy
// aliases (importLayer/importText/importFootage/importTransition → importLayerTypeAep,
// image sections → importImageDirect). Returns the routine's hex-encoded result.
function csDispatchImport(section, idHex, cHex, rHex, fHex) {
    var s = ("" + (section || "")).toLowerCase();
    if (s === "comp") return importCompDirect(idHex, cHex, rHex, s);
    if (s === "text_props" || s === "text_properties" || s === "textprops" || s === "text-properties") {
        return importTextProperties(idHex, cHex, rHex, s);
    }
    if (s === "effect") return importEffect(idHex, cHex, rHex, s);
    if (s === "icon" || s === "overlay" || s === "element" || s === "png" || s === "image") {
        return importImageDirect(idHex, cHex, rHex, s, fHex);
    }
    if (s === "footage") {
        // fHex is forwarded for the SAME reason importImageDirect needs it: a
        // FastMediaEngine folder segment is hex-derived from the display name,
        // so getSafeName(displayName) can never equal it and the name-based
        // findTemplateFolder lookup can never locate a media asset. The
        // absolute folderPath is the only locator that resolves.
        return importVideoDirect(idHex, cHex, rHex, s, fHex);
    }
    // layer, transition, text, footage, and any AEP-based default.
    return importLayerTypeAep(idHex, cHex, rHex, s);
}

var _csProfileLog = null;
function _csProfilePoint(stage) {
    if (!_csProfileLog) return;
    var t = $.hiresTimer;
    _csProfileLog.writeln(stage + ": " + (t / 1000).toFixed(2) + " ms");
}

function importBatch(payloadHex) {
    // Structured phase timings are returned IN the result (no disk writes in
    // production). The legacy Desktop profile file is only created when the
    // caller explicitly sends payload.profile === true (debug aid).
    var timings = { profile: false, totalMs: 0, decodeMs: 0, templates: [] };
    var tBatchStart = new Date().getTime();
    // NOTE: $.hiresTimer RESETS on every read (returns microseconds since the
    // previous read), so each phase duration below is a single fresh read —
    // never a subtraction of two reads.
    $.hiresTimer;
    // ── Decode the ONE JSON payload (Req 9.3) ───────────────────────────
    // A decode/parse failure is a WHOLE-CALL failure: we cannot know the
    // requested templates, so return an error with no per-template entries.
    // The CEP client marks every requested template failed (Req 9.5) and the
    // project is untouched because no DOM work has run.
    var payload = null;
    try {
        // Strict decode: a truncated or non-hex payload is REPORTED rather than
        // decoded into a corrupted string that then fails to parse for a reason
        // that names the wrong cause. The typeof guard follows the same
        // convention as the jsonParse guard below, so a slice-harness that
        // injects only decodeBridge still works and
        // tests/import-timings.test.js needs no harness change.
        var decodedPayload = (typeof decodeBridgeStrict === "function")
            ? decodeBridgeStrict(payloadHex)
            : { ok: true, value: decodeBridge(payloadHex) };
        if (!decodedPayload.ok) {
            return encodeBridge(jsonStringify({
                perTemplate: [],
                error: "Batch payload decode failed: " + decodedPayload.error
            }));
        }
        var jsonText = decodedPayload.value;
        // Security (Phase 1): strict parser instead of eval — the payload is
        // pure JSON from the panel and must never execute as code. The
        // typeof guard covers slice-harnesses without core.jsx (strict
        // built-in JSON.parse); the AE host uses jsonParse.
        payload = (typeof jsonParse === "function") ? jsonParse(jsonText) : JSON.parse(jsonText);
    } catch (eDecode) {
        return encodeBridge(jsonStringify({ perTemplate: [], error: "Batch payload decode failed: " + eDecode.toString() }));
    }
    timings.decodeMs = $.hiresTimer / 1000;
    $.hiresTimer; // reset for the template loop
    if (payload && payload.profile === true) {
        try {
            _csProfileLog = new File(Folder.desktop.fsName + "/CompSaver_Import_Profile.txt");
            _csProfileLog.open("w");
            _csProfileLog.writeln("=== Import Batch Profile ===");
            timings.profile = true;
        } catch (eProf) { }
    }
    if (!payload || !payload.templates || payload.templates.length === 0) {
        return encodeBridge(jsonStringify({ perTemplate: [], error: "No templates in batch." }));
    }

    var rootPath = ("" + (payload.rootPath || "")).replace(/\\/g, "/");
    var templates = payload.templates;

    // Seed the Metadata_Cache into the per-import I/O context (Req 8.3/11.3):
    // any template carrying pre-resolved metadata is served without a disk read.
    var seededMeta = {};
    var si;
    for (si = 0; si < templates.length; si++) {
        var seed = templates[si] || {};
        if (seed.metadata && seed.folderPath) {
            seededMeta[("" + seed.folderPath).replace(/\\/g, "/")] = seed.metadata;
        }
    }

    var perTemplate = [];

    // ── Single undo group + batch guard + seeded I/O context ────────────
    // Setting __CS_IMPORT_BATCH_ACTIVE makes the reused routines' undo-group
    // calls no-ops so this ONE group covers the whole action. The try/finally
    // guarantees endUndoGroup + guard/IO teardown on EVERY path (Req 9.1/9.2).
    var undoOpened = false;
    try { app.beginUndoGroup("CompSaver Import"); undoOpened = true; } catch (eUndo) { }
    // Task 12.1 (F11a, Req 2.24): set the guard ONLY when this batch actually
    // owns a group. It used to be set BEFORE the attempt, so a failed
    // beginUndoGroup left every per-section routine's csBeginUndoGroup a no-op
    // and the whole batch of DOM mutations ran with NO undo group at all. Now a
    // failed begin means N per-section groups instead of none -- strictly better
    // than an unundoable import. On the normal path beginUndoGroup succeeds, so
    // the guard is true exactly as before (Req 3.8/3.9).
    __CS_IMPORT_BATCH_ACTIVE = undoOpened;
    csImportIoBegin(seededMeta);

    // Latch the pre-action anchor + selection ONCE for the whole batch, so every
    // template anchors to the layer the user selected rather than to the layer
    // the previous template inserted (placeLayerAtPlayhead selects its own
    // insert). Selection-only, never an undoable DOM mutation.
    var batchAnchorComp = null;
    try {
        batchAnchorComp = app.project.activeItem;
        if (!(batchAnchorComp instanceof CompItem)) batchAnchorComp = null;
    } catch (eBatchComp) { batchAnchorComp = null; }
    var batchAnchorSel = [];
    if (batchAnchorComp) {
        try {
            var bSel = batchAnchorComp.selectedLayers;
            var bS;
            for (bS = 0; bS < bSel.length; bS++) batchAnchorSel.push(bSel[bS]);
        } catch (eBatchSel) { batchAnchorSel = []; }
    }
    if (typeof csBatchAnchorBegin === "function") csBatchAnchorBegin(batchAnchorComp);

    // Re-apply the captured selection. Local twin of csBatchAnchorReselect for
    // harnesses that load importBatch without its siblings in scope -- the SAME
    // implementation inlined, never a second rule set. Touches only layers
    // captured before the action, so it cannot resurrect a rolled-back layer.
    function csBatchAnchorRestoreLocal() {
        if (!batchAnchorComp) return;
        try {
            if (typeof deselectAllLayers === "function") {
                deselectAllLayers(batchAnchorComp);
            } else {
                var dz;
                for (dz = 1; dz <= batchAnchorComp.numLayers; dz++) {
                    try { batchAnchorComp.layer(dz).selected = false; } catch (eDz) { }
                }
            }
        } catch (eDesAll) { }
        var rz;
        for (rz = 0; rz < batchAnchorSel.length; rz++) {
            try { batchAnchorSel[rz].selected = true; } catch (eResel) { }
        }
    }

    try {
        var i;
        for (i = 0; i < templates.length; i++) {
            var t = templates[i] || {};
            var tid = (t.id !== null && t.id !== undefined) ? ("" + t.id) : "";
            var category = "" + (t.category || "");
            var tRoot = t.sourcePath ? ("" + t.sourcePath).replace(/\\/g, "/") : rootPath;

            // Pre-import snapshot for this template so a failure can be rolled
            // back to the EXACT pre-import state (Req 6.5).
            var comp = null;
            try {
                comp = app.project.activeItem;
                if (!(comp instanceof CompItem)) comp = null;
            } catch (eActive) { comp = null; }

            // Every template anchors to the selection the user made BEFORE the
            // batch, so put that selection back before dispatching: the previous
            // template's placeLayerAtPlayhead left its own insert selected.
            csBatchAnchorRestoreLocal();

            var tStartSnap = $.hiresTimer; // read (resets) — see note above
            var layerRefsBefore = csSnapshotCompLayers(comp);
            var itemIdsBefore = csSnapshotProjectItemIds();
            _csProfilePoint("[Template " + i + "] Snapshot");
            var resultStr = "";
            try {
                var idHex = encodeBridge(tid);
                var cHex = encodeBridge(category);
                var rHex = encodeBridge(tRoot);
                var fHex = encodeBridge(t.folderPath || "");
                resultStr = decodeBridge(csDispatchImport(t.section, idHex, cHex, rHex, fHex));
            } catch (eImport) {
                resultStr = "Import Error: " + eImport.toString();
            }

            if (resultStr === "true") {
                // Success: leave the project modified only by the fully applied
                // import (Req 6.6). Omit `reason` for imported entries.
                perTemplate.push({ id: tid, status: "imported" });
            } else {
                // Per-template failure: roll this template's partial changes back
                // to the exact pre-import state (Req 6.5) and record the reason.
                try { csRollbackToSnapshot(comp, layerRefsBefore, itemIdsBefore); } catch (eRoll) { }
                perTemplate.push({ id: tid, status: "failed", reason: resultStr || "Import failed" });
            }
            timings.templates.push($.hiresTimer / 1000);
        }
    } catch (eBatch) {
        // Catastrophic mid-batch failure: mark every not-yet-recorded template
        // failed so the result stays total over the input (Req 9.5/9.6).
        var f;
        for (f = perTemplate.length; f < templates.length; f++) {
            var ft = templates[f] || {};
            var fid = (ft.id !== null && ft.id !== undefined) ? ("" + ft.id) : "";
            perTemplate.push({ id: fid, status: "failed", reason: "Batch error: " + eBatch.toString() });
        }
    } finally {
        // Task 8.4 teardown (discard the recomputed-metadata context), restore
        // the user's pre-action selection, and close the single undo group on
        // EVERY path (Req 9.1/9.2).
        try { csImportIoEnd(); } catch (eIoEnd) { }
        // Restore the user's pre-action selection and clear the anchor latch.
        // Selection is not an undoable DOM mutation, so this runs INSIDE the
        // single group, before endUndoGroup.
        try {
            if (typeof csBatchAnchorEnd === "function") {
                csBatchAnchorEnd(batchAnchorComp);
            } else {
                csBatchAnchorRestoreLocal();
            }
        } catch (eAnchorEnd) { }
        __CS_IMPORT_BATCH_ACTIVE = false;
        if (undoOpened) { try { app.endUndoGroup(); } catch (eEnd) { } }
        try {
            if (_csProfileLog) {
                _csProfileLog.writeln("=== Batch Complete ===");
                _csProfileLog.close();
            }
        } catch (e) { }
        _csProfileLog = null;
        timings.totalMs = new Date().getTime() - tBatchStart;
    }

    return encodeBridge(jsonStringify({ perTemplate: perTemplate, timings: timings }));
}

// =========================================================
// IMPORT — TEXT PROPERTY HELPERS
// =========================================================

function getTextPropsGroup(layer) {
    try { return layer.property("ADBE Text Properties"); } catch (e) { }
    return null;
}

function getSourceTextProp(layer) {
    try {
        var textProps = getTextPropsGroup(layer);
        if (textProps) return textProps.property("ADBE Text Document");
    } catch (e) { }
    return null;
}

function setTextDocText(doc, textValue) {
    try {
        if (doc && textValue !== null && textValue !== undefined) doc.text = textValue;
    } catch (e) { }
    return doc;
}

function getCurrentTextValue(prop) {
    try {
        var v = prop.value;
        if (v && v.text !== undefined) return v.text;
    } catch (e) { }
    return "";
}

function copyPropertyKeySettings(src, dst, srcIndex, dstIndex) {
    try { dst.setInterpolationTypeAtKey(dstIndex, src.keyInInterpolationType(srcIndex), src.keyOutInterpolationType(srcIndex)); } catch (e) { }
    try { dst.setTemporalEaseAtKey(dstIndex, src.keyInTemporalEase(srcIndex), src.keyOutTemporalEase(srcIndex)); } catch (e2) { }
    try { dst.setTemporalContinuousAtKey(dstIndex, src.keyTemporalContinuous(srcIndex)); } catch (e3) { }
    try { dst.setTemporalAutoBezierAtKey(dstIndex, src.keyTemporalAutoBezier(srcIndex)); } catch (e4) { }
    try { dst.setSpatialTangentsAtKey(dstIndex, src.keyInSpatialTangent(srcIndex), src.keyOutSpatialTangent(srcIndex)); } catch (e5) { }
    try { dst.setSpatialContinuousAtKey(dstIndex, src.keySpatialContinuous(srcIndex)); } catch (e6) { }
    try { dst.setSpatialAutoBezierAtKey(dstIndex, src.keySpatialAutoBezier(srcIndex)); } catch (e7) { }
    try { dst.setRovingAtKey(dstIndex, src.keyRoving(srcIndex)); } catch (e8) { }
}

function clearPropertyKeys(prop) {
    try {
        var k;
        for (k = prop.numKeys; k >= 1; k--) {
            try { prop.removeKey(k); } catch (e) { }
        }
    } catch (e2) { }
}

function copySingleProperty(src, dst, preserveTargetText) {
    if (!src || !dst) return;
    var targetText = "";
    if (preserveTargetText) targetText = getCurrentTextValue(dst);

    clearPropertyKeys(dst);

    try {
        if (src.numKeys && src.numKeys > 0) {
            var k;
            for (k = 1; k <= src.numKeys; k++) {
                try {
                    var kv = src.keyValue(k);
                    if (preserveTargetText) kv = setTextDocText(kv, targetText);
                    dst.setValueAtTime(src.keyTime(k), kv);
                    try {
                        var dk = dst.nearestKeyIndex(src.keyTime(k));
                        copyPropertyKeySettings(src, dst, k, dk);
                    } catch (eK) { }
                } catch (e1) { }
            }
        } else {
            var v = src.value;
            if (preserveTargetText) v = setTextDocText(v, targetText);
            try { dst.setValue(v); } catch (e2) { }
        }
    } catch (e3) { }

    try {
        if (src.canSetExpression && dst.canSetExpression) {
            dst.expression = src.expression || "";
            dst.expressionEnabled = src.expressionEnabled;
        }
    } catch (e4) { }
}

function findMatchingChild(group, sourceChild) {
    if (!group || !sourceChild) return null;
    try {
        if (sourceChild.matchName) {
            var byMatch = group.property(sourceChild.matchName);
            if (byMatch) return byMatch;
        }
    } catch (e) { }
    try {
        if (sourceChild.name) {
            var byName = group.property(sourceChild.name);
            if (byName) return byName;
        }
    } catch (e2) { }
    return null;
}

function addMatchingChild(group, sourceChild) {
    if (!group || !sourceChild) return null;
    try {
        if (sourceChild.matchName && group.canAddProperty(sourceChild.matchName)) {
            return group.addProperty(sourceChild.matchName);
        }
    } catch (e) { }
    try {
        if (sourceChild.name && group.canAddProperty(sourceChild.name)) {
            return group.addProperty(sourceChild.name);
        }
    } catch (e2) { }
    return null;
}

function copyPropertyTree(srcGroup, dstGroup) {
    if (!srcGroup || !dstGroup) return;
    var i;
    for (i = 1; i <= srcGroup.numProperties; i++) {
        try {
            var srcChild = srcGroup.property(i);
            var dstChild = findMatchingChild(dstGroup, srcChild);
            if (!dstChild) dstChild = addMatchingChild(dstGroup, srcChild);
            if (!dstChild) continue;

            try { dstChild.name = srcChild.name; } catch (eN) { }

            if (srcChild.propertyType === PropertyType.PROPERTY) {
                copySingleProperty(srcChild, dstChild, false);
            } else {
                copyPropertyTree(srcChild, dstChild);
            }
        } catch (e) { }
    }
}

function clearIndexedGroup(group) {
    if (!group) return;
    var i;
    for (i = group.numProperties; i >= 1; i--) {
        try { group.property(i).remove(); } catch (e) { }
    }
}

function copyIndexedGroup(srcGroup, dstGroup) {
    if (!srcGroup || !dstGroup) return;
    clearIndexedGroup(dstGroup);
    var i;
    for (i = 1; i <= srcGroup.numProperties; i++) {
        try {
            var srcChild = srcGroup.property(i);
            var dstChild = addMatchingChild(dstGroup, srcChild);
            if (!dstChild) continue;
            try { dstChild.name = srcChild.name; } catch (eN) { }
            if (srcChild.propertyType === PropertyType.PROPERTY) {
                copySingleProperty(srcChild, dstChild, false);
            } else {
                copyPropertyTree(srcChild, dstChild);
            }
        } catch (e) { }
    }
}

function copyFixedTextGroup(srcTextProps, dstTextProps, matchName) {
    try {
        var srcGroup = srcTextProps.property(matchName);
        var dstGroup = dstTextProps.property(matchName);
        copyPropertyTree(srcGroup, dstGroup);
    } catch (e) { }
}

function applyTextPropertiesFromLayer(sourceLayer, targetLayer) {
    if (!isTextLayer(sourceLayer) || !isTextLayer(targetLayer)) return false;
    var srcTextProps = getTextPropsGroup(sourceLayer);
    var dstTextProps = getTextPropsGroup(targetLayer);
    if (!srcTextProps || !dstTextProps) return false;

    copySingleProperty(getSourceTextProp(sourceLayer), getSourceTextProp(targetLayer), true);
    copyFixedTextGroup(srcTextProps, dstTextProps, "ADBE Text Path Options");
    copyFixedTextGroup(srcTextProps, dstTextProps, "ADBE Text More Options");

    try {
        copyIndexedGroup(srcTextProps.property("ADBE Text Animators"), dstTextProps.property("ADBE Text Animators"));
    } catch (e) { }

    // Copy any dependent effects (e.g. Slider Controls, Color Controls used in expressions)
    try {
        var srcEffects = sourceLayer.property("ADBE Effect Parade");
        var dstEffects = targetLayer.property("ADBE Effect Parade");
        if (srcEffects && dstEffects && srcEffects.numProperties > 0) {
            for (var ei = 1; ei <= srcEffects.numProperties; ei++) {
                try {
                    var srcEff = srcEffects.property(ei);
                    var dstEff = dstEffects.property(srcEff.matchName) || dstEffects.property(srcEff.name);
                    if (!dstEff && dstEffects.canAddProperty(srcEff.matchName)) {
                        dstEff = dstEffects.addProperty(srcEff.matchName);
                    }
                    if (dstEff) {
                        try { dstEff.name = srcEff.name; } catch (eEffName) { }
                        copyPropertyTree(srcEff, dstEff);
                    }
                } catch (eEffSingle) { }
            }
        }
    } catch (eEff) { }

    return true;
}

function findFirstTextLayerInComp(comp) {
    if (!(comp instanceof CompItem)) return null;
    var i;
    for (i = 1; i <= comp.numLayers; i++) {
        try {
            var layer = comp.layer(i);
            if (isTextLayer(layer)) return layer;
        } catch (e) { }
    }
    return null;
}

function findImportedTextLayer(importedItems) {
    var bestComp = null;
    var i;
    for (i = 0; i < importedItems.length; i++) {
        try {
            if (importedItems[i] instanceof CompItem) {
                if (!bestComp || importedItems[i].numLayers > bestComp.numLayers) bestComp = importedItems[i];
            }
        } catch (e) { }
    }
    var layer = findFirstTextLayerInComp(bestComp);
    if (layer) return layer;
    for (i = 0; i < importedItems.length; i++) {
        try {
            if (importedItems[i] instanceof CompItem) {
                layer = findFirstTextLayerInComp(importedItems[i]);
                if (layer) return layer;
            }
        } catch (e2) { }
    }
    return null;
}

function cleanupImportedItems(importedItems) {
    var i;
    for (i = importedItems.length - 1; i >= 0; i--) {
        try { importedItems[i].remove(); } catch (e) { }
    }
}

// Task 10.2 (F9b, Req 2.19): ONE dedicated, reused container for every CompSaver
// import. The old version named the container after the imported comp -- but
// safeRenameAllImportedItems has already made that name unique against EVERY
// existing item name, folders included, so the "find existing folder" scan could
// provably never match and each import added another root-level folder
// -- Name, then Name 2, then Name 3. A FIXED name is findable by definition, so
// the container is created once and reused. Because the name is fixed,
// csResolveName is never asked to resolve it, so the once-per-import existing-name
// set is unchanged (Preservation 3.20).
var CS_ASSETS_FOLDER_NAME = "_CompSaver_Assets";

function csFindOrCreateRootFolder(folderName) {
    var i;
    for (i = 1; i <= app.project.numItems; i++) {
        var item = null;
        try { item = app.project.item(i); } catch (eItem) { item = null; }
        if (!item) continue;
        if (item instanceof FolderItem &&
            item.name === folderName &&
            item.parentFolder === app.project.rootFolder) {
            return item;
        }
    }
    var made = null;
    try { made = app.project.items.addFolder(folderName); } catch (eAdd) { made = null; }
    return made;
}

function csFindOrCreateSubFolder(parentFolder, folderName) {
    var i;
    for (i = 1; i <= parentFolder.numItems; i++) {
        var sub = null;
        try { sub = parentFolder.item(i); } catch (eSub) { sub = null; }
        if (sub && sub instanceof FolderItem && sub.name === folderName) return sub;
    }
    var made = null;
    try { made = parentFolder.items.addFolder(folderName); } catch (eAdd2) { made = null; }
    return made;
}

function toolkitOrganizeTemplateImport(allImportedItems, mainComp) {
    if (!mainComp) return;
    try {
        // The container name is fixed. Read from the module constant when it is in
        // scope; the literal keeps this function self-contained under the
        // function-slicing test harnesses.
        var containerName = (typeof CS_ASSETS_FOLDER_NAME === "string")
            ? CS_ASSETS_FOLDER_NAME
            : "_CompSaver_Assets";
        var i;

        // The typeof guards cover harnesses that load this function without its
        // siblings in scope; each fallback is the SAME implementation inlined,
        // never a second rule set.
        var rootFolder = null;
        if (typeof csFindOrCreateRootFolder === "function") {
            rootFolder = csFindOrCreateRootFolder(containerName);
        } else {
            for (i = 1; i <= app.project.numItems; i++) {
                var rItem = null;
                try { rItem = app.project.item(i); } catch (eRi) { rItem = null; }
                if (!rItem) continue;
                if (rItem instanceof FolderItem &&
                    rItem.name === containerName &&
                    rItem.parentFolder === app.project.rootFolder) {
                    rootFolder = rItem;
                    break;
                }
            }
            if (!rootFolder) {
                try { rootFolder = app.project.items.addFolder(containerName); } catch (eRa) { rootFolder = null; }
            }
        }
        if (!rootFolder) return;

        // Partition: real assets -- non-solid footage plus secondary comps -- want
        // an Assets subfolder; the FolderItems importFile created are containers,
        // never assets, and are swept separately below.
        var assetsToMove = [];
        var foldersSeen = [];
        var needsAssets = false;
        for (i = 0; i < allImportedItems.length; i++) {
            var imp = allImportedItems[i];
            if (!imp) continue;
            var impId = null;
            try { impId = imp.id; } catch (eId) { impId = null; }
            if (!impId || impId === mainComp.id || impId === rootFolder.id) continue;

            if (imp instanceof FolderItem) {
                foldersSeen.push(imp);
                continue;
            }
            if (imp instanceof FootageItem) {
                var isSolid = false;
                try { isSolid = (imp.mainSource instanceof SolidSource); } catch (eSrc) { }
                if (!isSolid) needsAssets = true;
            } else if (imp instanceof CompItem) {
                // Secondary comps also go into Assets
                needsAssets = true;
            }
            assetsToMove.push(imp);
        }

        try { mainComp.parentFolder = rootFolder; } catch (eMain) { }

        if (needsAssets && assetsToMove.length > 0) {
            var assetsFolder = null;
            if (typeof csFindOrCreateSubFolder === "function") {
                assetsFolder = csFindOrCreateSubFolder(rootFolder, "Assets");
            } else {
                for (i = 1; i <= rootFolder.numItems; i++) {
                    var subItem = null;
                    try { subItem = rootFolder.item(i); } catch (eSi) { subItem = null; }
                    if (subItem && subItem instanceof FolderItem && subItem.name === "Assets") {
                        assetsFolder = subItem;
                        break;
                    }
                }
                if (!assetsFolder) {
                    try { assetsFolder = rootFolder.items.addFolder("Assets"); } catch (eSa) { assetsFolder = null; }
                }
            }
            if (assetsFolder) {
                var m;
                for (m = 0; m < assetsToMove.length; m++) {
                    try { assetsToMove[m].parentFolder = assetsFolder; } catch (eMove) { }
                }
            }
        } else {
            // Task 10.2 (Req 2.20): a solid-only import still belongs under the
            // container, so nothing is left loose at the Project-panel root. The
            // old code skipped this entirely whenever needsAssets was false.
            var s;
            for (s = 0; s < assetsToMove.length; s++) {
                try { assetsToMove[s].parentFolder = rootFolder; } catch (eMove2) { }
            }
        }

        // Task 10.2 (Req 2.20): the FolderItem importFile created for the .aep is
        // swept UNCONDITIONALLY once its children were reparented above -- the old
        // code left it stranded at the root for every solid-only template, because
        // needsAssets gated the whole block.
        //
        // Req 2.20 allows the leftover folder to be "removed OR reparented"; it is
        // REPARENTED under the container, never removed. Removing it would delete a
        // project item that a SUCCESSFUL import created, which Preservation 3.10
        // forbids -- a template's own additions must survive its own success. Under
        // the container it is not at the Project-panel root, which is what 2.20
        // requires, and the container itself always holds mainComp so it is never
        // an empty root folder either.
        var fi;
        for (fi = foldersSeen.length - 1; fi >= 0; fi--) {
            try { foldersSeen[fi].parentFolder = rootFolder; } catch (eReparent) { }
        }
    } catch (err) { }
}

// =========================================================
// IMPORT — LAYER / TEXT / FOOTAGE (.aep based)
// =========================================================

function importLayerTypeAep(idHex, cHex, rHex, s) {
    var allImportedItems = [];
    // Task 8.4: own a per-import disk-I/O context (a no-op when a batch already
    // owns one) so every required file is read at most once and each asset
    // folder enumerated at most once for THIS import, and so a cache miss reads
    // meta.json once then reuses the parsed result (Req 8.1/8.2/8.3/8.4/11.3/11.4).
    var ioOwned = csImportIoOwn();
    try {
        try {
            var id = cleanStr(decodeBridge(idHex));
            var c = cleanStr(decodeBridge(cHex));
            var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

            var resolvedFiles = resolveTemplateFiles(r, c, id, s);
            if (!resolvedFiles) return encodeBridge("Template folder not found!");

            var folder = resolvedFiles.folder;
            var mainFile = resolvedFiles.mainFile;
            if (!mainFile || !mainFile.exists) return encodeBridge("No main AEP file found!");

            var activeComp = app.project.activeItem;
            if (!(activeComp instanceof CompItem)) return encodeBridge("Open a composition first!");

            var playheadTime = activeComp.time;
            // Anchor by REFERENCE, latched per batch: inside a batch this is the
            // layer the user selected before the batch began, not the layer the
            // previous template inserted. The typeof guard covers harnesses that
            // load this function without its sibling in scope; the fallback is the
            // SAME resolution inlined, never a second rule set.
            var anchorLayer = (typeof csResolveImportAnchor === "function")
                ? csResolveImportAnchor(activeComp)
                : getTopSelectedLayer(activeComp);
            var activeCompId = activeComp.id;

            // Task 10.1 (F9a, Req 2.18): cleanup is owned by SCOPE EXIT, not by
            // individual exit points -- the same latch importCompDirect uses. It is
            // set on BOTH success returns: the Utility Pre-Comp branch and the normal
            // tail. Every other exit ("Import failed!", "Template has no layers.",
            // "Cannot import into itself!", "No layers were placed!", ...) used to
            // leave the imported items in the user's project on a standalone call.
            var importCommitted = false;
            csBeginUndoGroup("Import Template");
            // Req 9.1/9.2: try/finally guarantees the undo group ALWAYS closes, on
            // every early return and on any thrown error, so no open undo group leaks.
            // (csBegin/csEndUndoGroup are no-ops while a batch owns the single group.)
            try {

                // Task 8.9: compute the existing project-name set ONCE per import and
                // reuse it for every collision lookup (Req 10.5); within a batch the set
                // is grown in place as names are assigned rather than rescanned.
                var existingNamesLower = csExistingNamesOnce();
                var assetsFolder = resolvedFiles.assetsFolder;

                // Task 12.2 (F11b/F11c, Req 2.23): suppression is released by
                // try/finally on EVERY path. Written as bare sequential
                // statements, a throw between them -- e.g. the profile-point
                // write below -- left After Effects with dialog suppression on
                // for the rest of the session. Req 3.15: importFile stays
                // wrapped in suppression; only the RELEASE is now guaranteed.
                // This inner finally unwinds BEFORE the outer cleanup finally,
                // so an early return releases suppression first, then cleans up
                // and closes the undo group.
                var importedItem = null;
                var dlgSuppressed = false;
                try { app.beginSuppressDialogs(); dlgSuppressed = true; } catch (eSupB) { }
                try {
                    importedItem = app.project.importFile(new ImportOptions(mainFile));
                    _csProfilePoint("  importFile");
                } catch (importErr) {
                    return encodeBridge("File import failed: " + importErr.toString());
                } finally {
                    if (dlgSuppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
                }

                if (importedItem) {
                    if (importedItem instanceof FolderItem) {
                        allImportedItems.push(importedItem);
                        var folders = [importedItem];
                        while (folders.length > 0) {
                            var f = folders.shift();
                            var childCount = f.numItems;
                            var x;
                            for (x = 1; x <= childCount; x++) {
                                var child = f.item(x);
                                allImportedItems.push(child);
                                if (child instanceof FolderItem) {
                                    folders.push(child);
                                }
                            }
                        }
                    } else {
                        allImportedItems.push(importedItem);
                    }
                }

                if (allImportedItems.length === 0) {
                    return encodeBridge("Import failed!");
                }

                // Task 8.9: classify the imported items in a SINGLE pass (comp/footage/
                // folder), total over the set, and reuse that classification for renaming,
                // footage relinking, and comp selection below — no second traversal
                // (Req 10.1/10.2).
                var classified = csClassifyItemsOnce(allImportedItems);
                _csProfilePoint("  Classify");

                safeRenameAllImportedItems(classified.renameTargets, existingNamesLower);
                _csProfilePoint("  Rename");

                if (assetsFolder.exists) {
                    // Task 8.4: enumerate the asset folder at most once per import (Req 8.2);
                    // a genuine enumeration failure stops the import and names the folder (Req 8.6).
                    var assetsFiles = csEnumerateFolderOnce(assetsFolder, null);

                    // Task 8.9: reuse the single-pass classification (Req 10.2) — iterate
                    // only the footage subset instead of re-scanning allImportedItems.
                    var ai;
                    for (ai = 0; ai < classified.footage.length; ai++) {
                        try {
                            var item = classified.footage[ai];
                            if (item instanceof FootageItem) {
                                var isFileSource = true;
                                try {
                                    if (item.mainSource && (item.mainSource instanceof SolidSource || item.mainSource instanceof PlaceholderSource)) {
                                        isFileSource = false;
                                    }
                                } catch (eSource) { }

                                if (isFileSource) {
                                    var fileName = "";
                                    if (item.file) {
                                        fileName = fsEntryName(item.file);
                                        if (!fileName) fileName = item.file.name;
                                    }
                                    if (!fileName) {
                                        fileName = item.name;
                                    }

                                    var assetCandidate = new File(assetsFolder.fsName + "/" + fileName);
                                    if (!assetCandidate.exists && item.file) {
                                        assetCandidate = new File(assetsFolder.fsName + "/" + item.file.name);
                                    }
                                    if (!assetCandidate.exists && assetsFiles) {
                                        var fIdx;
                                        for (fIdx = 0; fIdx < assetsFiles.length; fIdx++) {
                                            if (assetsFiles[fIdx] instanceof File && assetsFiles[fIdx].name.toLowerCase() === fileName.toLowerCase()) {
                                                assetCandidate = assetsFiles[fIdx];
                                                break;
                                            }
                                        }
                                        if (!assetCandidate.exists) {
                                            var fileNameNoExt = fileName;
                                            var dotIdx = fileName.lastIndexOf(".");
                                            if (dotIdx !== -1) {
                                                fileNameNoExt = fileName.substring(0, dotIdx);
                                            }
                                            for (fIdx = 0; fIdx < assetsFiles.length; fIdx++) {
                                                if (assetsFiles[fIdx] instanceof File) {
                                                    var fNameLow = assetsFiles[fIdx].name.toLowerCase();
                                                    if (fNameLow === fileNameNoExt.toLowerCase() || fNameLow.indexOf(fileNameNoExt.toLowerCase() + ".") === 0) {
                                                        assetCandidate = assetsFiles[fIdx];
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if (assetCandidate && assetCandidate.exists) {
                                        try { item.replace(assetCandidate); } catch (eR) { }
                                    }
                                }
                            }
                        } catch (eA) { }
                    }
                }

                var importedComp = null;
                // Task 8.9: reuse the single-pass classification (Req 10.2) — the comp
                // subset is already known, so do NOT re-scan allImportedItems for comps.
                var compCandidates = classified.comps;

                if (compCandidates.length > 0) {
                    importedComp = compCandidates[0];
                    var ci;
                    for (ci = 1; ci < compCandidates.length; ci++) {
                        var candidate = compCandidates[ci];
                        if (candidate.numLayers > importedComp.numLayers) {
                            importedComp = candidate;
                        }
                    }
                    if (importedComp.numLayers === 0) {
                        for (ci = 0; ci < compCandidates.length; ci++) {
                            if (compCandidates[ci].numLayers > 0) {
                                importedComp = compCandidates[ci];
                                break;
                            }
                        }
                    }
                }

                if (!importedComp || importedComp.numLayers === 0) {
                    return encodeBridge("Template has no layers. Re-save the template.");
                }

                if (importedComp.id === activeCompId) {
                    return encodeBridge("Cannot import into itself!");
                }

                // ── Utility Pre-Comp import (Composition reference, NOT flattened) ──
                // A single-pre-comp Layer template stores a wrapper comp whose only layer
                // is the original pre-comp. Detect that (via meta assetKind, or structurally
                // for templates saved before the flag) and place the ORIGINAL pre-comp as
                // ONE reference layer — same as a Comp import. Name + inner layers/effects/
                // expressions/hierarchy are preserved because the whole comp is referenced.
                // Normal layer templates never match this and fall through unchanged.
                // Task 8.4 (Req 8.1/8.3/10.3): reuse the meta.json that resolveTemplateFiles
                // already read+parsed CACHE-FIRST — do NOT read the file a second time. The
                // saved switches/markers (layerState) restore onto the pre-comp reference layer.
                var isPrecompTemplate = false;
                var precompLayerState = null;
                try {
                    var tplMeta = resolvedFiles.meta;
                    if (tplMeta) {
                        if (tplMeta.assetKind === "precomp") isPrecompTemplate = true;
                        if (tplMeta.layerState) precompLayerState = tplMeta.layerState;
                    }
                } catch (eMetaP) { }

                var precompTarget = null;
                var wpi;
                for (wpi = 0; wpi < compCandidates.length; wpi++) {
                    var wrapCand = compCandidates[wpi];
                    try {
                        if (wrapCand.numLayers === 1) {
                            var onlyLyr = wrapCand.layer(1);
                            if (onlyLyr instanceof AVLayer && onlyLyr.source instanceof CompItem) {
                                precompTarget = onlyLyr.source; // the original Utility Pre-Comp
                                isPrecompTemplate = true;
                                break;
                            }
                        }
                    } catch (eWrap) { }
                }
                // Meta says pre-comp but wrapper not found → reference the inner comp directly.
                if (isPrecompTemplate && !precompTarget) precompTarget = importedComp;

                if (isPrecompTemplate && precompTarget && precompTarget.id !== activeCompId) {
                    toolkitOrganizeTemplateImport(allImportedItems, precompTarget);
                    _csProfilePoint("  Organize (precomp)");
                    activeComp.openInViewer();
                    var refLayer = null;
                    try { refLayer = activeComp.layers.add(precompTarget); } catch (eAddRef) { }
                    if (refLayer) {
                        // Remove leftover wrapper comp(s) that only referenced the target,
                        // so the Project panel stays clean (the reference layer keeps the
                        // target comp alive).
                        var rwi;
                        for (rwi = 0; rwi < compCandidates.length; rwi++) {
                            var wc = compCandidates[rwi];
                            if (wc === precompTarget) continue;
                            try {
                                if (wc.numLayers === 1 && wc.layer(1) instanceof AVLayer && wc.layer(1).source === precompTarget) {
                                    wc.remove();
                                }
                            } catch (eRmWrap) { }
                        }
                        placeLayerAtPlayhead(activeComp, refLayer, playheadTime, anchorLayer);
                        // Restore the ORIGINAL pre-comp layer's switches + markers onto the
                        // reference layer, so the imported layer looks exactly as saved.
                        if (precompLayerState) { try { applyLayerState(refLayer, precompLayerState); } catch (eLSp) { } }
                        // Req 6.3: force a single viewer refresh after the import edited the comp.
                        try { forceCompViewerRefresh(activeComp); } catch (eVR) { }
                        // Task 10.1: latched only AFTER this branch's own work is done
                        // (reference layer placed, wrappers swept, layerState re-applied),
                        // so Preservation 3.16 is untouched.
                        importCommitted = true;
                        return encodeBridge("true");
                    }
                    // If add() failed, fall through to the normal path below.
                }

                toolkitOrganizeTemplateImport(allImportedItems, importedComp);
                _csProfilePoint("  Organize (normal)");

                // Task 8.4 (Req 8.1): derive the layer flags from the SAME single
                // cache-first meta parse (resolvedFiles.meta) instead of re-reading and
                // re-parsing meta.json. Full timeline state (switches + markers) is applied
                // after placement for exact restore.
                var metaIsAdjustment = false;
                var metaIs3D = false;
                var metaBlendMode = -1;
                var metaLabel = -1;
                var metaLayerState = null;

                try {
                    var lyrMeta = resolvedFiles.meta;
                    if (lyrMeta) {
                        if (lyrMeta.isAdjustment === true) metaIsAdjustment = true;
                        if (lyrMeta.is3D === true) metaIs3D = true;
                        if (typeof lyrMeta.blendMode === "number" && !isNaN(lyrMeta.blendMode)) metaBlendMode = lyrMeta.blendMode;
                        if (typeof lyrMeta.label === "number" && !isNaN(lyrMeta.label)) metaLabel = lyrMeta.label;
                        if (lyrMeta.layerState) metaLayerState = lyrMeta.layerState;
                    }
                } catch (e) { }

                activeComp.openInViewer();
                deselectAllLayers(activeComp);

                var layerCountBefore = activeComp.numLayers;
                var importedCompLayers = [];
                var li;
                for (li = 1; li <= importedComp.numLayers; li++) {
                    try {
                        importedCompLayers.push(importedComp.layer(li));
                    } catch (e) { }
                }
                copyLayersToComp(importedCompLayers, activeComp);

                var addedCount = activeComp.numLayers - layerCountBefore;

                if (addedCount <= 0) {
                    return encodeBridge("No layers were placed!");
                }

                var newLayers = [];
                var nl;
                for (nl = 1; nl <= addedCount; nl++) {
                    try { newLayers.push(activeComp.layer(nl)); } catch (e) { }
                }

                try { importedComp.remove(); } catch (e) { }

                deselectAllLayers(activeComp);

                if (addedCount === 1) {
                    var newLayer = newLayers.length > 0 ? newLayers[0] : null;
                    if (!newLayer) {
                        return encodeBridge("Imported layer reference missing.");
                    }
                    try { if (metaIsAdjustment) newLayer.adjustmentLayer = true; } catch (e) { }
                    try { if (metaIs3D) newLayer.threeDLayer = true; } catch (e) { }
                    try { if (metaBlendMode > 0) newLayer.blendingMode = metaBlendMode; } catch (e) { }
                    try { if (metaLabel >= 0) newLayer.label = metaLabel; } catch (e) { }
                    placeLayerAtPlayhead(activeComp, newLayer, playheadTime, anchorLayer);
                    // Restore the complete timeline state (switches + markers) captured at
                    // save. Applied AFTER placement so marker offsets land relative to the
                    // final startTime. Overrides the legacy per-field re-applies above.
                    if (metaLayerState) { try { applyLayerState(newLayer, metaLayerState); } catch (eApp) { } }
                } else {
                    var topNewLayer = newLayers.length > 0 ? newLayers[0] : null;
                    if (topNewLayer) {
                        try {
                            // Shift all layers by a uniform delta based on the top layer's alignment
                            var targetStartTime = playheadTime - topNewLayer.inPoint;
                            var delta = targetStartTime - topNewLayer.startTime;

                            var nsi;
                            for (nsi = 0; nsi < newLayers.length; nsi++) {
                                try {
                                    var lyr = newLayers[nsi];
                                    // Req 4.6: LIGHT prep captures locked/shy (no viewport
                                    // repaint, for batch smoothness) before editing startTime,
                                    // then restore the captured state afterward.
                                    var lyrOrig = null;
                                    try { lyrOrig = unlockLayerForEdit(lyr, activeComp); } catch (ePrep) { }
                                    lyr.startTime += delta;
                                    try { restoreLayerState(lyr, lyrOrig); } catch (eRest) { }
                                } catch (eShift) { }
                            }
                        } catch (e) {
                            // Fallback to simple single-layer shift
                            try {
                                topNewLayer.startTime = 0;
                                topNewLayer.startTime = playheadTime - topNewLayer.inPoint;
                            } catch (e2) { }
                        }
                    }
                    var nsiSel;
                    for (nsiSel = 0; nsiSel < newLayers.length; nsiSel++) {
                        try { newLayers[nsiSel].selected = true; } catch (e) { }
                    }
                }

                // Req 6.3: force a single viewer refresh after the batch edited layers.
                try { forceCompViewerRefresh(activeComp); } catch (eVR) { }
                importCommitted = true;
                return encodeBridge("true");
            } finally {
                // Task 10.1 (Req 2.18): same contract as importCompDirect -- remove every
                // item this call's importFile added on any non-committed exit, BEFORE
                // csEndUndoGroup so the removals sit inside the group. Scoped to
                // allImportedItems only (Preservation 3.10) and individually guarded so a
                // second removal pass by csRollbackToSnapshot is a no-op (Preservation 3.11).
                if (!importCommitted) {
                    if (typeof cleanupImportedItems === "function") {
                        try { cleanupImportedItems(allImportedItems); } catch (eCleanup) { }
                    } else {
                        var ciDirect;
                        for (ciDirect = allImportedItems.length - 1; ciDirect >= 0; ciDirect--) {
                            try { allImportedItems[ciDirect].remove(); } catch (eCiD) { }
                        }
                    }
                }
                csEndUndoGroup();
            }
        } catch (e) {
            // Task 8.4 (Req 8.6): a required file read / asset folder enumeration failure
            // stops the affected import and surfaces an error NAMING the file or folder.
            if (e && e.csIo) return encodeBridge(e.message);
            return encodeBridge("Import Error: " + e.toString());
        }
    } finally {
        csImportIoRelease(ioOwned);
    }
}

function importLayer(nHex, cHex, rHex) { return importLayerTypeAep(nHex, cHex, rHex); }
function importTransition(nHex, cHex, rHex) { return importLayerTypeAep(nHex, cHex, rHex); }
function importText(nHex, cHex, rHex) { return importLayerTypeAep(nHex, cHex, rHex); }
function importFootage(nHex, cHex, rHex) { return importLayerTypeAep(nHex, cHex, rHex); }

function importTextProperties(idHex, cHex, rHex, s) {
    var allImportedItems = [];
    // Task 8.4: own a per-import disk-I/O context (a no-op when a batch already
    // owns one) so every required file is read at most once and each asset
    // folder enumerated at most once for THIS import (Req 8.1/8.2/8.3/8.4).
    var ioOwned = csImportIoOwn();
    try {
        try {
            var id = cleanStr(decodeBridge(idHex));
            var c = cleanStr(decodeBridge(cHex));
            var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

            var resolvedFiles = resolveTemplateFiles(r, c, id, s);
            if (!resolvedFiles) return encodeBridge("Template folder not found!");

            var mainFile = resolvedFiles.mainFile;
            if (!mainFile || !mainFile.exists) return encodeBridge("No main AEP file found!");

            var activeComp = app.project.activeItem;
            if (!(activeComp instanceof CompItem)) return encodeBridge("Open a composition first!");

            var targets = activeComp.selectedLayers;
            if (!targets || targets.length === 0) return encodeBridge("Select text layer(s) to apply properties.");

            var ti;
            for (ti = 0; ti < targets.length; ti++) {
                if (!isTextLayer(targets[ti])) return encodeBridge("Text Properties can apply only to Text layers.");
            }

            csBeginUndoGroup("Apply Text Properties");
            // Req 9.1/9.2: try/finally guarantees the undo group ALWAYS closes, on
            // every early return and on any thrown error, so no open undo group leaks.
            // (csBegin/csEndUndoGroup are no-ops while a batch owns the single group.)
            try {
                var existingIds = {};
                var bi;
                for (bi = 1; bi <= app.project.numItems; bi++) {
                    try { existingIds[app.project.item(bi).id] = true; } catch (e) { }
                }

                app.beginSuppressDialogs();
                try {
                    app.project.importFile(new ImportOptions(mainFile));
                } catch (importErr) {
                    app.endSuppressDialogs(false);
                    return encodeBridge("File import failed: " + importErr.toString());
                }
                app.endSuppressDialogs(false);

                var ni;
                for (ni = 1; ni <= app.project.numItems; ni++) {
                    try {
                        var nItem = app.project.item(ni);
                        if (!existingIds[nItem.id]) allImportedItems.push(nItem);
                    } catch (e2) { }
                }

                var sourceLayer = findImportedTextLayer(allImportedItems);
                if (!sourceLayer) {
                    cleanupImportedItems(allImportedItems);
                    return encodeBridge("Text property source not found. Re-save the preset.");
                }

                var applied = 0;
                for (ti = 0; ti < targets.length; ti++) {
                    try {
                        // Req 4.6: LIGHT prep captures the target layer's locked/shy state
                        // before editing its properties; restore it afterward.
                        var tgtOrig = null;
                        try { tgtOrig = unlockLayerForEdit(targets[ti], activeComp); } catch (ePrep) { }
                        if (applyTextPropertiesFromLayer(sourceLayer, targets[ti])) applied++;
                        try { restoreLayerState(targets[ti], tgtOrig); } catch (eRest) { }
                    } catch (eA) { }
                }

                cleanupImportedItems(allImportedItems);

                if (applied === 0) {
                    return encodeBridge("Could not apply text properties.");
                }

                // Req 6.3: force a single viewer refresh after the batch edited layers.
                try { forceCompViewerRefresh(activeComp); } catch (eVR) { }
                return encodeBridge("true");
            } finally {
                csEndUndoGroup();
            }
        } catch (e) {
            try { cleanupImportedItems(allImportedItems); } catch (eC) { }
            // Task 8.4 (Req 8.6): name the offending file/folder on a read/enumeration failure.
            if (e && e.csIo) return encodeBridge(e.message);
            return encodeBridge("Import Error: " + e.toString());
        }
    } finally {
        csImportIoRelease(ioOwned);
    }
}

// =========================================================
// IMPORT — COMP
// =========================================================

function importCompDirect(idHex, cHex, rHex, s) {
    var allImportedItems = [];
    // Task 8.4: own a per-import disk-I/O context (a no-op when a batch already
    // owns one) so every required file is read at most once and each asset
    // folder enumerated at most once for THIS import, and so a cache miss reads
    // meta.json once then reuses the parsed result (Req 8.1/8.2/8.3/8.4/11.3/11.4).
    var ioOwned = csImportIoOwn();
    try {
        try {
            var id = cleanStr(decodeBridge(idHex));
            var c = cleanStr(decodeBridge(cHex));
            var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

            var resolvedFiles = resolveTemplateFiles(r, c, id, s);
            if (!resolvedFiles) return encodeBridge("Comp folder not found!");

            var mainFile = resolvedFiles.mainFile;
            if (!mainFile || !mainFile.exists) return encodeBridge("No main AEP file found!");

            var activeComp = app.project.activeItem;
            if (!(activeComp instanceof CompItem)) return encodeBridge("Open a composition first!");

            var playheadTime = activeComp.time;
            // Anchor by REFERENCE, latched per batch (see importLayerTypeAep).
            var anchorLayer = (typeof csResolveImportAnchor === "function")
                ? csResolveImportAnchor(activeComp)
                : getTopSelectedLayer(activeComp);
            var activeCompId = activeComp.id;

            // Task 10.1 (F9a, Req 2.18): cleanup is owned by SCOPE EXIT, not by
            // individual exit points. The early returns below -- "Import failed!",
            // "No comp found!", "Cannot create recursive nesting!", "Cannot add comp
            // to timeline." -- used to leave the imported comp, footage and folders
            // in the user's project on every standalone call.
            var importCommitted = false;
            csBeginUndoGroup("Import Comp");
            // Req 9.1/9.2: try/finally guarantees the undo group ALWAYS closes, on
            // every early return and on any thrown error, so no open undo group leaks.
            // (csBegin/csEndUndoGroup are no-ops while a batch owns the single group.)
            try {

                // Task 8.9: compute the existing project-name set ONCE per import and
                // reuse it for every collision lookup (Req 10.5); within a batch the set
                // is grown in place as names are assigned rather than rescanned.
                var existingNamesLower = csExistingNamesOnce();

                // Task 12.2 (F11c, Req 2.23): suppression is released by
                // try/finally on EVERY path -- the throw path AND every early
                // return inside the block. _csProfilePoint used to sit OUTSIDE
                // the try, between the two bare calls, so a failed profile-log
                // write left dialog suppression stuck on for the whole session.
                // Req 3.15: importFile stays wrapped in suppression; only the
                // RELEASE is now guaranteed. This inner finally unwinds BEFORE
                // the outer cleanup finally (suppression off, then cleanup +
                // csEndUndoGroup).
                var importedItem = null;
                var tPreImport = $.hiresTimer;
                var dlgSuppressed = false;
                try { app.beginSuppressDialogs(); dlgSuppressed = true; } catch (eSupB) { }
                try {
                    importedItem = app.project.importFile(new ImportOptions(mainFile));
                    _csProfilePoint("  Native importFile");
                } catch (importErr) {
                    return encodeBridge("File import failed: " + importErr.toString());
                } finally {
                    if (dlgSuppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
                }

                if (importedItem) {
                    if (importedItem instanceof FolderItem) {
                        allImportedItems.push(importedItem);
                        var folders = [importedItem];
                        while (folders.length > 0) {
                            var f = folders.shift();
                            var childCount = f.numItems;
                            var x;
                            for (x = 1; x <= childCount; x++) {
                                var child = f.item(x);
                                allImportedItems.push(child);
                                if (child instanceof FolderItem) {
                                    folders.push(child);
                                }
                            }
                        }
                    } else {
                        allImportedItems.push(importedItem);
                    }
                }

                if (allImportedItems.length === 0) {
                    return encodeBridge("Import failed!");
                }

                // Task 8.9: classify the imported items in a SINGLE pass (comp/footage/
                // folder), total over the set, and reuse that classification for renaming,
                // footage relinking, and comp selection below — no second traversal
                // (Req 10.1/10.2).
                var tPreClassify = $.hiresTimer;
                var classified = csClassifyItemsOnce(allImportedItems);
                _csProfilePoint("  Classify items");

                safeRenameAllImportedItems(classified.renameTargets, existingNamesLower);
                _csProfilePoint("  Safe rename");

                var assetsFolder = resolvedFiles.assetsFolder;
                if (assetsFolder.exists) {
                    // Task 8.4: enumerate the asset folder at most once per import (Req 8.2);
                    // a genuine enumeration failure stops the import and names the folder (Req 8.6).
                    var assetsFiles = csEnumerateFolderOnce(assetsFolder, null);

                    // Task 8.9: reuse the single-pass classification (Req 10.2) — iterate
                    // only the footage subset instead of re-scanning allImportedItems.
                    var ax;
                    for (ax = 0; ax < classified.footage.length; ax++) {
                        try {
                            var itemA = classified.footage[ax];
                            if (itemA instanceof FootageItem) {
                                var isFileSource = true;
                                try {
                                    if (itemA.mainSource && (itemA.mainSource instanceof SolidSource || itemA.mainSource instanceof PlaceholderSource)) {
                                        isFileSource = false;
                                    }
                                } catch (eSource) { }

                                if (isFileSource) {
                                    var fileName = "";
                                    if (itemA.file) {
                                        fileName = fsEntryName(itemA.file);
                                        if (!fileName) fileName = itemA.file.name;
                                    }
                                    if (!fileName) {
                                        fileName = itemA.name;
                                    }

                                    var ac = new File(assetsFolder.fsName + "/" + fileName);
                                    if (!ac.exists && itemA.file) {
                                        ac = new File(assetsFolder.fsName + "/" + itemA.file.name);
                                    }
                                    if (!ac.exists && assetsFiles) {
                                        var fIdx;
                                        for (fIdx = 0; fIdx < assetsFiles.length; fIdx++) {
                                            if (assetsFiles[fIdx] instanceof File && assetsFiles[fIdx].name.toLowerCase() === fileName.toLowerCase()) {
                                                ac = assetsFiles[fIdx];
                                                break;
                                            }
                                        }
                                        if (!ac.exists) {
                                            var fileNameNoExt = fileName;
                                            var dotIdx = fileName.lastIndexOf(".");
                                            if (dotIdx !== -1) {
                                                fileNameNoExt = fileName.substring(0, dotIdx);
                                            }
                                            for (fIdx = 0; fIdx < assetsFiles.length; fIdx++) {
                                                if (assetsFiles[fIdx] instanceof File) {
                                                    var fNameLow = assetsFiles[fIdx].name.toLowerCase();
                                                    if (fNameLow === fileNameNoExt.toLowerCase() || fNameLow.indexOf(fileNameNoExt.toLowerCase() + ".") === 0) {
                                                        ac = assetsFiles[fIdx];
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if (ac && ac.exists) {
                                        try { itemA.replace(ac); } catch (eR) { }
                                    }
                                }
                            }
                        } catch (eAx) { }
                    }
                }

                var importedComp = null;
                // Task 8.9: reuse the single-pass classification (Req 10.2) — the comp
                // subset is already known, so do NOT re-scan allImportedItems for comps.
                var compCandidates = classified.comps;

                if (compCandidates.length > 0) {
                    importedComp = compCandidates[0];
                    var ci;
                    for (ci = 1; ci < compCandidates.length; ci++) {
                        if (compCandidates[ci].numLayers > importedComp.numLayers) importedComp = compCandidates[ci];
                    }
                }

                if (!importedComp) {
                    return encodeBridge("No comp found!");
                }

                if (importedComp.id === activeCompId) {
                    return encodeBridge("Cannot create recursive nesting!");
                }

                toolkitOrganizeTemplateImport(allImportedItems, importedComp);
                _csProfilePoint("  Organize (template)");

                activeComp.openInViewer();
                var newLayer = null;
                try { newLayer = activeComp.layers.add(importedComp); } catch (e1) { }

                if (!newLayer) {
                    // Task 10.1: the inline cleanup loop that used to sit here is gone
                    // -- the finally below owns it for this and every other exit.
                    return encodeBridge("Cannot add comp to timeline.");
                }

                placeLayerAtPlayhead(activeComp, newLayer, playheadTime, anchorLayer);
                // Req 6.3: force a single viewer refresh after the import edited the comp.
                try { forceCompViewerRefresh(activeComp); } catch (eVR) { }
                importCommitted = true;
                return encodeBridge("true");
            } finally {
                // Task 10.1 (Req 2.18): any exit that is not a committed import removes
                // every item this call's importFile added, leaving the project exactly as
                // it was. Runs BEFORE csEndUndoGroup so the removals sit INSIDE the group.
                // Scope is allImportedItems only, matching csRollbackToSnapshot's scoping
                // (Preservation 3.10); inside a batch rollback may remove the same items
                // and each removal is individually guarded, so the second pass is a no-op
                // and the batch result stays total (Preservation 3.11).
                if (!importCommitted) {
                    if (typeof cleanupImportedItems === "function") {
                        try { cleanupImportedItems(allImportedItems); } catch (eCleanup) { }
                    } else {
                        // The typeof guard covers function-slicing harnesses that load
                        // this engine without cleanupImportedItems in scope; the fallback
                        // is the SAME implementation inlined, never a second rule.
                        var ciDirect;
                        for (ciDirect = allImportedItems.length - 1; ciDirect >= 0; ciDirect--) {
                            try { allImportedItems[ciDirect].remove(); } catch (eCiD) { }
                        }
                    }
                }
                csEndUndoGroup();
            }
        } catch (e) {
            // Task 8.4 (Req 8.6): a required file read / asset folder enumeration failure
            // stops the affected import and surfaces an error NAMING the file or folder.
            if (e && e.csIo) return encodeBridge(e.message);
            return encodeBridge("Import Error: " + e.toString());
        }
    } finally {
        csImportIoRelease(ioOwned);
    }
}

function importTemplate(idHex, cHex, rHex) { return importCompDirect(idHex, cHex, rHex); }

// =========================================================
// IMPORT — IMAGE
// =========================================================

function getPNGSaveInfo(typeHex) {
    try {
        var itemType = "icon";
        if (typeHex) itemType = cleanStr(decodeBridge(typeHex));
        if (itemType !== "icon" && itemType !== "overlay" && itemType !== "element") itemType = "icon";

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            return encodeBridge("ERROR:Open a composition and select an image layer in the timeline.");
        }

        var selLayers = comp.selectedLayers;
        if (!selLayers || selLayers.length === 0) {
            return encodeBridge("ERROR:Select an image layer in the Timeline to save.");
        }

        var sourceFile = null;
        var sourceWidth = 0;
        var sourceHeight = 0;
        var si;
        for (si = 0; si < selLayers.length; si++) {
            var slx = selLayers[si];
            try {
                if (slx.source instanceof FootageItem && slx.source.file && slx.source.file.exists) {
                    if (isSupportedImageFileName(slx.source.file.name)) {
                        sourceFile = slx.source.file;
                        if (slx.source.width) sourceWidth = slx.source.width;
                        if (slx.source.height) sourceHeight = slx.source.height;
                        break;
                    }
                }
            } catch (eSlx) { }
        }

        if (!sourceFile || !sourceFile.exists) {
            return encodeBridge("ERROR:No image layer found in timeline selection. Select a PNG/JPG/etc layer in the Timeline (not the Project panel).");
        }

        var resObj = {
            fsPath: sourceFile.fsName,
            width: sourceWidth,
            height: sourceHeight
        };
        return encodeBridge(jsonStringify(resObj));
    } catch (e) {
        return encodeBridge("ERROR:Save Error: " + e.toString());
    }
}

function importVideoDirect(idHex, cHex, rHex, s, fHex) {
    var ioOwned = csImportIoOwn();
    // Declared at FUNCTION scope, not inside the direct-folder block, so the
    // diagnostic string below reads real values instead of relying on ES3 var
    // hoisting to hand it undefined.
    var directFolder = "";
    var df = null;
    var mf = null;
    try {
        try {
            var id = cleanStr(decodeBridge(idHex));
            var c = cleanStr(decodeBridge(cHex));
            var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

            // Absolute folderPath first, mirroring importImageDirect. A media
            // asset's on-disk folder segment is derived from the display name by
            // mediaIdFolderSegment, so the name-based findTemplateFolder lookup
            // can never match it - this branch is the only one that resolves.
            var resolvedFiles = null;
            if (fHex) {
                directFolder = cleanStr(decodeBridge(fHex)).replace(/\\/g, "/");
                if (directFolder) {
                    df = new Folder(directFolder);
                    if (df.exists) {
                        var metaObj = csReadTemplateMeta(df);
                        if (!metaObj) metaObj = {};
                        var mfName = metaObj.mainFile || "";
                        mf = mfName ? new File(df.fsName + "/" + mfName) : null;
                        if (!mf || !mf.exists) {
                            // Fallback: search for a video file in the folder.
                            // Extension list matches the host's own
                            // isSupportedVideoFileName regex in jsx/core.jsx.
                            mf = null;
                            var vidPatterns = ["*.mp4", "*.mov", "*.avi", "*.mkv", "*.webm", "*.m4v", "*.mpg", "*.mpeg", "*.wmv", "*.flv", "*.mxf"];
                            var vi;
                            for (vi = 0; vi < vidPatterns.length; vi++) {
                                var found = df.getFiles(vidPatterns[vi]);
                                if (found && found.length > 0) {
                                    // Prefer a "source.*" file, matching
                                    // importImageDirect and the image rung of
                                    // resolveTemplateFiles.
                                    var fi;
                                    for (fi = 0; fi < found.length; fi++) {
                                        if (("" + found[fi].name).toLowerCase().indexOf("source") === 0) { mf = found[fi]; break; }
                                    }
                                    if (!mf || !mf.exists) mf = found[0];
                                    break;
                                }
                            }
                        }
                        if (mf && mf.exists) {
                            resolvedFiles = { folder: df, meta: metaObj, mainFile: mf };
                        }
                    }
                }
            }

            // Standard name-based resolution only when the direct folder yielded
            // nothing - the pre-existing behaviour, unchanged.
            var dfDebugStr = (fHex ? "fHex_provided" : "no_fHex")
                + " dfExists:" + (df ? df.exists : "null")
                + " mfExists:" + (mf ? mf.exists : "null");
            if (!resolvedFiles) {
                resolvedFiles = resolveTemplateFiles(r, c, id, s);
            }
            if (!resolvedFiles) {
                return encodeBridge("Video folder not found! Debug: " + dfDebugStr + " r=" + r + " c=" + c + " id=" + id + " s=" + s);
            }

            var sourceFile = resolvedFiles.mainFile;
            if (!sourceFile || !sourceFile.exists) return encodeBridge("No video file found! Debug: " + dfDebugStr);

            var activeComp = app.project.activeItem;
            if (!(activeComp instanceof CompItem)) return encodeBridge("Open a composition first!");

            var playheadTime = activeComp.time;
            // Anchor by REFERENCE, latched per batch (see importLayerTypeAep).
            var anchorLayer = (typeof csResolveImportAnchor === "function")
                ? csResolveImportAnchor(activeComp)
                : getTopSelectedLayer(activeComp);

            csBeginUndoGroup("Import Video");
            try {
                app.beginSuppressDialogs();
                var importedFootage = null;
                try {
                    importedFootage = app.project.importFile(new ImportOptions(sourceFile));
                } catch (importErr) {
                    app.endSuppressDialogs(false);
                    return encodeBridge("Video import failed: " + importErr.toString());
                }
                app.endSuppressDialogs(false);

                if (!importedFootage) {
                    return encodeBridge("Video import failed: footage item not found in project.");
                }

                activeComp.openInViewer();
                var newLayer = activeComp.layers.add(importedFootage);
                if (!newLayer) {
                    return encodeBridge("Could not place video!");
                }
                placeLayerAtPlayhead(activeComp, newLayer, playheadTime, anchorLayer);
                try { forceCompViewerRefresh(activeComp); } catch (eVR) { }
            } finally {
                csEndUndoGroup();
            }
            return encodeBridge("true");
        } catch (innerE) {
            return encodeBridge("Video Import error: " + innerE.toString());
        }
    } finally {
        csImportIoRelease(ioOwned);
    }
}

function importImageDirect(idHex, cHex, rHex, s, fHex) {
    // Task 8.4: own a per-import disk-I/O context (a no-op when a batch already
    // owns one) so every required file is read at most once and each asset
    // folder enumerated at most once for THIS import (Req 8.1/8.2/8.3/8.4).
    var ioOwned = csImportIoOwn();
    try {
        try {
            var id = cleanStr(decodeBridge(idHex));
            var c = cleanStr(decodeBridge(cHex));
            var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

            // If a direct folderPath was provided (e.g. from card.dataset.folder
            // or the import batch payload), try it first — this bypasses the
            // name-based findTemplateFolder lookup that fails for hex-encoded
            // FastMediaEngine folder names.
            var resolvedFiles = null;
            if (fHex) {
                var directFolder = cleanStr(decodeBridge(fHex)).replace(/\\/g, "/");
                if (directFolder) {
                    var df = new Folder(directFolder);
                    if (df.exists) {
                        var metaObj = csReadTemplateMeta(df);
                        if (!metaObj) metaObj = {};
                        var mfName = metaObj.mainFile || "";
                        var mf = mfName ? new File(df.fsName + "/" + mfName) : null;
                        if (!mf || !mf.exists) {
                            // Fallback: search for image files in the folder
                            var imgPatterns = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.bmp", "*.tif", "*.tiff"];
                            for (var pi = 0; pi < imgPatterns.length; pi++) {
                                var found = df.getFiles(imgPatterns[pi]);
                                if (found && found.length > 0) {
                                    // Prefer source.* files
                                    for (var fi = 0; fi < found.length; fi++) {
                                        if (found[fi].name.indexOf("source") === 0) { mf = found[fi]; break; }
                                    }
                                    if (!mf || !mf.exists) mf = found[0];
                                    break;
                                }
                            }
                        }
                        if (mf && mf.exists) {
                            resolvedFiles = { folder: df, meta: metaObj, mainFile: mf };
                        }
                    }
                }
            }

            // Standard name-based resolution as fallback
            var dfDebugStr = (fHex ? "fHex_provided" : "no_fHex") + " dfExists:" + (df ? df.exists : "null") + " mfExists:" + (mf ? mf.exists : "null");
            if (!resolvedFiles) {
                resolvedFiles = resolveTemplateFiles(r, c, id, s);
            }
            if (!resolvedFiles) return encodeBridge("Image folder not found! Debug: " + dfDebugStr + " r=" + r + " c=" + c + " id=" + id + " s=" + s);

            var sourceFile = resolvedFiles.mainFile;
            if (!sourceFile || !sourceFile.exists) return encodeBridge("No image file found! Debug: " + dfDebugStr);

            var activeComp = app.project.activeItem;
            if (!(activeComp instanceof CompItem)) return encodeBridge("Open a composition first!");

            var playheadTime = activeComp.time;
            // Anchor by REFERENCE, latched per batch (see importLayerTypeAep).
            var anchorLayer = (typeof csResolveImportAnchor === "function")
                ? csResolveImportAnchor(activeComp)
                : getTopSelectedLayer(activeComp);

            csBeginUndoGroup("Import Image");
            // Req 9.1/9.2: try/finally guarantees the undo group ALWAYS closes, on
            // every early return and on any thrown error, so no open undo group leaks.
            // (csBegin/csEndUndoGroup are no-ops while a batch owns the single group.)
            try {
                app.beginSuppressDialogs();
                var importedFootage = null;
                try {
                    importedFootage = app.project.importFile(new ImportOptions(sourceFile));
                } catch (importErr) {
                    app.endSuppressDialogs(false);
                    return encodeBridge("Image import failed: " + importErr.toString());
                }
                app.endSuppressDialogs(false);

                if (!importedFootage) {
                    return encodeBridge("Image import failed: footage item not found in project.");
                }

                activeComp.openInViewer();
                var newLayer = activeComp.layers.add(importedFootage);
                if (!newLayer) {
                    return encodeBridge("Could not place image!");
                }
                placeLayerAtPlayhead(activeComp, newLayer, playheadTime, anchorLayer);

                // Restore saved layer transform from meta.json if available.
                // This preserves the visual size the user had when they saved,
                // adapting proportionally to the current comp dimensions.
                var meta = resolvedFiles.meta;
                if (meta && meta.layerTransform) {
                    var lt = meta.layerTransform;
                    try {
                        if (lt.scale && lt.savedCompWidth && lt.savedCompHeight) {
                            // Compute the visual pixel size in the original comp
                            var origVisualW = (lt.scale[0] / 100) * (importedFootage.width || 1);
                            var origVisualH = (lt.scale[1] / 100) * (importedFootage.height || 1);
                            // Compute what scale % produces the same visual size in this comp
                            var newScaleX = (origVisualW / (importedFootage.width || 1)) * 100;
                            var newScaleY = (origVisualH / (importedFootage.height || 1)) * 100;
                            var scaleVal = newLayer.property("ADBE Transform Group").property("ADBE Scale");
                            if (scaleVal) {
                                var sv = scaleVal.value;
                                if (sv && sv.length === 3) {
                                    scaleVal.setValue([newScaleX, newScaleY, sv[2]]);
                                } else {
                                    scaleVal.setValue([newScaleX, newScaleY]);
                                }
                            }
                        }
                    } catch (eTransform) { /* non-fatal: image still imports at native size */ }
                }

                // Req 6.3: force a single viewer refresh after the import edited the comp.
                try { forceCompViewerRefresh(activeComp); } catch (eVR) { }
                return encodeBridge("true");
            } finally {
                csEndUndoGroup();
            }
        } catch (e) {
            // Task 8.4 (Req 8.6): a required file read / asset folder enumeration failure
            // stops the affected import and surfaces an error NAMING the file or folder.
            if (e && e.csIo) return encodeBridge(e.message);
            return encodeBridge("Import Error: " + e.toString());
        }
    } finally {
        csImportIoRelease(ioOwned);
    }
}

// =========================================================
// TEMPLATE OPERATIONS
// =========================================================

function ensureFolder(pathHex) {
    try {
        var path = decodeBridge(pathHex).replace(/\\/g, "/");
        if (!path || path.length === 0) return encodeBridge("false");
        ensureDeepFolder(path);
        return encodeBridge("true");
    } catch (e) {
        return encodeBridge("false");
    }
}

function deleteTemplate(idHex, cHex, rHex, fHex) {
    try {
        var f = null;
        if (fHex) {
            var directFolder = cleanStr(decodeBridge(fHex)).replace(/\\/g, "/");
            if (directFolder) {
                var df = new Folder(directFolder);
                if (df.exists) f = df;
            }
        }
        if (!f) {
            var id = cleanStr(decodeBridge(idHex));
            var c = cleanStr(decodeBridge(cHex));
            var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
            f = findTemplateFolder(r, c, id);
        }
        if (f && f.exists) {
            var fsName = f.fsName;
            deleteFolderRecursive(f);
            var check = new Folder(fsName);
            if (check.exists) return encodeBridge("false");
            return encodeBridge("true");
        }
        // Folder does not exist on disk — idempotent success
        return encodeBridge("true");
    } catch (e) { return encodeBridge("false"); }
}

function deleteTemplatesBulk(idsHex, categoriesHex, rHex, foldersHex) {
    // Honest delete: after attempting removal we re-stat each folder with a
    // FRESH handle. On Windows a locked file (AE holding project.aep, an
    // in-flight preview render, AV scan) leaves the folder behind, so we must
    // confirm it actually went away rather than assume success. Returns a JSON
    // contract: { ok: <count successfully removed>, failed: [<ids still present>] }.
    var okCount = 0;
    var failed = [];
    try {
        var ids = decodeBridge(idsHex).split("||");
        var cats = decodeBridge(categoriesHex).split("||");
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var folders = (foldersHex !== undefined && foldersHex !== null && foldersHex !== "")
            ? decodeBridge(foldersHex).split("||")
            : [];

        for (var i = 0; i < ids.length; i++) {
            var id = cleanStr(ids[i]);
            var c = cleanStr(cats[i]);
            if (!id || !c) continue;

            var directPath = (folders && i < folders.length) ? cleanStr(folders[i]).replace(/\\/g, "/") : "";
            var f = null;
            if (directPath) {
                var df = new Folder(directPath);
                if (df.exists) f = df;
            }
            if (!f) {
                f = findTemplateFolder(r, c, id);
            }

            if (!f || !f.exists) {
                if (directPath && !new Folder(directPath).exists) {
                    // Direct path was provided and folder is genuinely not on disk — already gone
                    okCount++;
                    continue;
                }
                // If direct path was absent and findTemplateFolder failed to resolve the folder,
                // do NOT falsely claim okCount++.
                if (!directPath) {
                    failed.push(id);
                    continue;
                }
                okCount++;
                continue;
            }

            var fsName = f.fsName;
            deleteFolderRecursive(f);

            // Re-stat with a brand-new Folder handle to confirm it really went away.
            var check = new Folder(fsName);
            if (check.exists) {
                failed.push(id);
            } else {
                okCount++;
            }
        }
        return encodeBridge(jsonStringify({ ok: okCount, failed: failed }));
    } catch (e) {
        return encodeBridge(jsonStringify({ ok: okCount, failed: failed, error: String(e) }));
    }
}

function renameTemplatePath(idHex, newNHex, cHex, rHex) {
    try {
        var id = cleanStr(decodeBridge(idHex));
        var newN = cleanStr(decodeBridge(newNHex));
        var c = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

        var folder = findTemplateFolder(r, c, id);
        if (!folder || !folder.exists) return encodeBridge("false");

        var safeNewName = getSafeName(newN);
        if (safeNewName !== folder.name) {
            var targetFolderPath = folder.parent.fsName.replace(/\\/g, "/") + "/" + safeNewName;
            var targetFolder = new Folder(targetFolderPath);
            if (targetFolder.exists) {
                deleteFolderRecursive(targetFolder);
            }
            if (!folder.rename(safeNewName)) {
                return encodeBridge("false");
            }
            folder = new Folder(targetFolderPath);
        }

        var metaFile = new File(folder.fsName + "/meta.json");
        if (metaFile.exists) {
            var content = readFileText(metaFile);
            var metaObj = {};
            // Security (Phase 1): strict parser, never eval (see csReadTemplateMeta).
            try { metaObj = (typeof jsonParse === "function") ? jsonParse(content) : JSON.parse(content); } catch (e) { }
            metaObj.id = safeNewName;
            metaObj.name = newN;
            metaObj.updatedAt = getISOString();

            // Best-effort: the folder rename already succeeded on disk above.
            // File.open returns false (not throw) when it cannot open, and
            // write() on an unopened File throws — an unchecked write here
            // would turn an already-applied rename into a reported failure.
            if (metaFile.open("w")) {
                var wrote = metaFile.write(jsonStringify(metaObj));
                metaFile.close();
            }
        }
        return encodeBridge("true");
    } catch (e) { return encodeBridge("false"); }
}

function moveTemplatePath(idHex, oldCHex, newCHex, rHex) {
    try {
        var id = cleanStr(decodeBridge(idHex));
        var oldC = cleanStr(decodeBridge(oldCHex));
        var newC = cleanStr(decodeBridge(newCHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

        var oldFolder = findTemplateFolder(r, oldC, id);
        if (!oldFolder || !oldFolder.exists) return encodeBridge("false");

        var section = oldFolder.parent.parent.name;
        var newCatPath = r + "/" + section + "/" + getSafeName(newC);
        ensureDeepFolder(newCatPath);

        var newFolder = new Folder(newCatPath + "/" + id);

        // Hardening: copy into a unique TEMP sibling first and only swap it
        // into place once copied.success verifies. The previous code deleted
        // the pre-existing destination BEFORE copying, so a copy failure
        // degraded to "source preserved, destination wiped" instead of a
        // no-op. Folder.rename(newName) works on Folder objects in this host
        // (same pattern as renameTemplatePath and the core.jsx migration).
        var tempName = id + ".__csmove_" + String(Date.now());
        var tempFolder = new Folder(newCatPath + "/" + tempName);
        while (tempFolder.exists) {
            tempName = id + ".__csmove_" + String(Date.now()) + "_" + String(Math.floor(Math.random() * 100000));
            tempFolder = new Folder(newCatPath + "/" + tempName);
        }

        var copied = copyFolderRecursive(oldFolder, tempFolder);
        // Fix 1 follow-up: copyFolderRecursive returns an ALWAYS-truthy
        // {success, failedFiles} status object, so the truthiness gate it had
        // here never fired — a failed copy would fall through and delete the
        // source folder (data loss). Deleting oldFolder is only safe when
        // every file actually copied.
        if (copied && copied.success) {
            // Swap: only now, with the copy verified, is it safe to remove a
            // pre-existing destination.
            if (newFolder.exists) {
                deleteFolderRecursive(newFolder);
            }
            var swapped = tempFolder.rename(id);
            var finalFolder = new Folder(newCatPath + "/" + id);
            if (!swapped || !finalFolder.exists) {
                // Rename into place failed — restore the previous destination
                // from the intact source and clean up the temp copy. Neither
                // source nor original destination is lost.
                if (!newFolder.exists) {
                    copyFolderRecursive(oldFolder, newFolder);
                }
                deleteFolderRecursive(tempFolder);
                return encodeBridge("false");
            }
            var metaFile = new File(finalFolder.fsName + "/meta.json");
            if (metaFile.exists) {
                var content = readFileText(metaFile);
                var metaObj = {};
                // Security (Phase 1): strict parser, never eval (see csReadTemplateMeta).
                try { metaObj = (typeof jsonParse === "function") ? jsonParse(content) : JSON.parse(content); } catch (e) { }
                metaObj.category = newC;
                metaObj.updatedAt = getISOString();

                // Best-effort: the move itself is already complete on disk;
                // an unchecked write on an unopened File throws and would
                // flip this operation's result to failure after the fact.
                if (metaFile.open("w")) {
                    var wrote = metaFile.write(jsonStringify(metaObj));
                    metaFile.close();
                }
            }
            deleteFolderRecursive(oldFolder);
            return encodeBridge("true");
        }
        // Copy failed: source untouched; clean up the partial temp copy.
        deleteFolderRecursive(tempFolder);
        return encodeBridge("false");
    } catch (e) {
        // Unexpected failure mid-move: best-effort removal of an orphaned
        // temp copy (undefined/renamed-away handles are guarded). Source and
        // destination remain intact wherever the failure occurred.
        try { if (tempFolder && tempFolder.exists) deleteFolderRecursive(tempFolder); } catch (e2) { }
        return encodeBridge("false");
    }
}

function toggleFavTemplate(idHex, cHex, rHex) {
    try {
        var id = cleanStr(decodeBridge(idHex));
        var c = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

        var folder = findTemplateFolder(r, c, id);
        if (!folder || !folder.exists) return encodeBridge("false");

        var favFile = new File(folder.fsName + "/.fav");
        if (favFile.exists) {
            favFile.remove();
        } else {
            favFile.open("w");
            favFile.write("1");
            favFile.close();
        }
        return encodeBridge("true");
    } catch (e) { return encodeBridge("false"); }
}

// ONE contract both sides agree on. The reply is an encoded JSON envelope with
// an explicit exists flag, the id of the folder that already holds the name, and
// the section that was actually searched - plus an error string when the CHECK
// itself failed:
//     exists: Boolean, id: String, section: String, error: String
// The old version used the matched folder's NAME as its hit signal while the
// panel compared the decoded reply against the literal "true". A folder name is
// never "true", so exists was constant false: the overwrite prompt never
// appeared, oldId was always "", and the .fav preservation plus old-folder
// removal in the background finalizer were unreachable dead code. `id` is the
// folder that ACTUALLY exists, which is exactly what those two steps need, and
// `section` is echoed back so a section mismatch is diagnosable.
function itemExists(nHex, cHex, rHex, sHex) {
    var section = "comp";
    try {
        var name = cleanStr(decodeBridge(nHex));
        var c = getSafeName(cleanStr(decodeBridge(cHex)));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

        // Search the section actually being saved. The panel now always supplies
        // it. A legacy 3-argument caller supplies none, and answering such a call
        // from the comp section alone is precisely how a layer/text/footage/effect
        // save was checked against the wrong section - so a sectionless call
        // sweeps every section instead, the four the comp-only default
        // mis-answered first, then comp and the image sections. Whichever section
        // matched is the one reported back.
        var sections;
        if (sHex) {
            var sDecoded = normalizeSectionName(cleanStr(decodeBridge(sHex)));
            if (sDecoded) section = sDecoded;
            sections = [section];
        } else {
            sections = ["layer", "text", "footage", "effect", "comp", "icon", "overlay"];
        }

        if (!name) return encodeBridge(jsonStringify({ exists: false, section: section }));
        var nameLower = name.toLowerCase();

        var si, i;
        for (si = 0; si < sections.length; si++) {
            var sec = sections[si];
            var catFolder = new Folder(r + "/" + sec + "/" + c);
            if (!catFolder.exists) continue;

            var subfolders = catFolder.getFiles();
            if (!subfolders) continue;

            for (i = 0; i < subfolders.length; i++) {
                if (!(subfolders[i] instanceof Folder)) continue;
                var metaFile = new File(subfolders[i].fsName + "/meta.json");
                if (!metaFile.exists) continue;
                var mContent = readFileText(metaFile);
                var mObj = {};
                // Security (Phase 1): strict parser, never eval (see csReadTemplateMeta).
                try { mObj = (typeof jsonParse === "function") ? jsonParse(mContent) : JSON.parse(mContent); } catch (eParse) { mObj = {}; }
                if (mObj && mObj.name && ("" + mObj.name).toLowerCase() === nameLower) {
                    return encodeBridge(jsonStringify({
                        exists: true,
                        id: subfolders[i].name,
                        section: sec
                    }));
                }
            }
        }
        return encodeBridge(jsonStringify({ exists: false, section: section }));
    } catch (e) {
        // A failed CHECK must not silently claim "no existing template" - report
        // it so the caller can decide instead of overwriting blind.
        return encodeBridge(jsonStringify({
            exists: false,
            section: section,
            error: e.toString()
        }));
    }
}

function selectSaveFolder() {
    try {
        var f = Folder.selectDialog("Select Save Folder");
        if (!f) return encodeBridge("");
        return encodeBridge(f.fsName);
    } catch (e) { return encodeBridge(""); }
}

function compSaverPing() {
    return encodeBridge("ok");
}

// =========================================================
// CATEGORY OPERATIONS
// =========================================================

function renameCategory(oldCHex, newCHex, rHex) {
    try {
        var oldC = getSafeName(cleanStr(decodeBridge(oldCHex)));
        var newC = getSafeName(cleanStr(decodeBridge(newCHex)));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

        if (!oldC || !newC || oldC === newC) return encodeBridge("false");

        var oldFolder = new Folder(r + "/" + oldC);
        var newFolder = new Folder(r + "/" + newC);

        if (!oldFolder.exists) return encodeBridge("Category not found!");
        if (newFolder.exists) return encodeBridge("Name already taken!");

        newFolder.create();
        var items = oldFolder.getFiles();
        var i;
        for (i = 0; i < items.length; i++) {
            if (!(items[i] instanceof Folder)) continue;
            var destItem = new Folder(newFolder.fsName + "/" + fsEntryName(items[i]));
            // Fix 1 follow-up: the {success, failedFiles} status was ignored
            // here, and the old category folder was deleted unconditionally
            // afterwards — a copy failure meant data loss. On failure, roll
            // back the freshly created destination (it was verified absent
            // above, so nothing pre-existing is removed) and preserve the
            // source category, reporting through this function's existing
            // "Error: ..." string convention.
            var copyStatus = copyFolderRecursive(items[i], destItem);
            if (!copyStatus || !copyStatus.success) {
                deleteFolderRecursive(newFolder);
                return encodeBridge("Error: copy failed for '" + fsEntryName(items[i]) + "' (" +
                    ((copyStatus && copyStatus.failedFiles) ? copyStatus.failedFiles.join("; ") : "unknown") +
                    "). Source category preserved.");
            }
            var mf = new File(destItem.fsName.replace(/\\/g, "/") + "/meta.json");
            if (mf.exists) {
                var mc = readFileText(mf);
                mc = mc.replace(/"category"\s*:\s*"[^"]*"/, '"category":"' + escapeJSON(newC) + '"');
                mf.open("w"); mf.write(mc); mf.close();
            }
        }
        deleteFolderRecursive(oldFolder);
        return encodeBridge("true");
    } catch (e) { return encodeBridge("Error: " + e.toString()); }
}

function deleteCategory(cHex, rHex) {
    try {
        var c = getSafeName(cleanStr(decodeBridge(cHex)));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var folder = new Folder(r + "/" + c);
        if (folder.exists) deleteFolderRecursive(folder);
        return encodeBridge("true");
    } catch (e) { return encodeBridge("Error: " + e.toString()); }
}

// =========================================================
// CENTRALIZED SAFE COMPOSITION RESOLVER
// =========================================================

function getSafeActiveComp() {
    try {
        // 1. Try standard activeItem
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            return comp;
        }

        // 2. Try activeViewer composition activeItem
        if (app.activeViewer && app.activeViewer.type === ViewerType.VIEWER_COMPOSITION) {
            comp = app.activeViewer.activeItem;
            if (comp && comp instanceof CompItem) {
                return comp;
            }
        }

        // 3. Fallback: Search all project comps for active selected layers (CEP panel focused case)
        if (app.project && app.project.numItems > 0) {
            for (var i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (item instanceof CompItem) {
                    if (item.selectedLayers && item.selectedLayers.length > 0) {
                        return item;
                    }
                }
            }
        }

        // 4. Fallback: Try project selection
        var sel = app.project.selection;
        if (sel && sel.length > 0) {
            for (var j = 0; j < sel.length; j++) {
                if (sel[j] instanceof CompItem) {
                    return sel[j];
                }
            }
        }
    } catch (e) { }
    return null;
}

