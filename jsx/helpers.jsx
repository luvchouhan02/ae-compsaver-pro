// ============================================================
// helpers.jsx - shared engine robustness/smoothness helpers
// ------------------------------------------------------------
// Backbone robustness/smoothness helpers ported from MNTOOLS
// (_ref/MNTOOLS/host/index.jsx). Shared engine layer for CompSaver.
// Included after core.jsx, before all consumers.
//
// (ExtendScript module - included by compSaver.jsx; functions are global)
//
// NOTE (Req 10.1): encodeBridge, decodeBridge, jsonStringify, ensureFolder,
// and ensureDeepFolder live in core.jsx and are REUSED here - they are NOT
// re-declared in this file.
// ============================================================

// =========================================================
// PROPERTY_HELPER (Req 1, Req 2)
// =========================================================

// Req 1: Walk the parentProperty chain from the target to the root, unhide
// each chain member in root->target order, then mark the target selected.
// Returns the number of chain levels processed (0 if prop falsy). Never throws.
// Ported from MNTOOLS ensurePropertyVisible (_ref/MNTOOLS/host/index.jsx).
function ensurePropertyVisible(prop) {
    // Req 1 (guard): nothing to process for a falsy target.
    if (!prop) return 0;

    // Req 1.1 / 1.5: collect the Property Chain by pushing the target then
    // repeatedly following parentProperty. Any access error stops collection
    // and we process only what has already been gathered.
    var chain = [];
    var p = prop;
    while (p) {
        chain.push(p);
        try {
            p = p.parentProperty;
        } catch (e) {
            break;
        }
    }

    // Req 1.2 / 1.3: unhide chain members in ROOT->target order (last collected
    // element is the root, index 0 is the target). Guard each member so one
    // failure does not abort the rest.
    for (var i = chain.length - 1; i >= 0; i--) {
        try {
            if (chain[i].hidden === true) chain[i].hidden = false;
        } catch (e2) { }
    }

    // Req 1.4: mark the target property as selected (guarded).
    try {
        prop.selected = true;
    } catch (e3) { }

    // Return the number of chain levels processed.
    return chain.length;
}

// Req 2: Ensure visibility first, optionally set comp.time, then write the value
// via the fallback chain setValueAtTime -> addKey/setValueAtKey -> setValue.
// Returns { success:Boolean, method:"valueAtTime"|"key"|"value"|"none", error?:String }.
// Ported from MNTOOLS setPropertyValueSafe (_ref/MNTOOLS/host/index.jsx).
function setPropertyValueSafe(prop, comp, time, value) {
    // Guard: nothing to write without a target property.
    if (!prop) return { success: false, method: "none", error: "No property" };

    // Req 2.1: make the property (and its whole parent chain) visible/editable
    // BEFORE attempting any write.
    try { ensurePropertyVisible(prop); } catch (eVis) { }

    // A time is "supplied" only when it is neither null nor undefined.
    var hasTime = (time !== null && time !== undefined);

    // Req 2.2: when a time is supplied, move the enclosing comp's current time to
    // the target time before writing (guarded so a rejected assignment does not
    // abort the write).
    if (hasTime && comp) {
        try { comp.time = time; } catch (eT) { }
    }

    if (hasTime) {
        // Req 2.3: attempt the keyed write via setValueAtTime first.
        try {
            prop.setValueAtTime(time, value);
            return { success: true, method: "valueAtTime" };
        } catch (e1) {
            // Req 2.4: setValueAtTime failed - fall back to addKey + setValueAtKey
            // when the property supports adding keys.
            if (prop.addKey) {
                try {
                    var keyIndex = prop.addKey(time);
                    prop.setValueAtKey(keyIndex, value);
                    return { success: true, method: "key" };
                } catch (e2) { }
            }
        }
    }

    // Req 2.5: no time supplied, or the keyed-write path was not applicable / also
    // failed - write with setValue.
    try {
        prop.setValue(value);
        return { success: true, method: "value" };
    } catch (e3) {
        // Total failure: every write path was rejected.
        return { success: false, method: "none", error: e3.toString() };
    }
}

// =========================================================
// THUMBNAIL HELPERS (Req 3)
// =========================================================

// Req 3.3/3.4: Pure predicate - a Valid PNG exists on disk and has byte length > 64.
// Guarded against a null/undefined file. Ported from MNTOOLS saveCompFramePng's
// validity tail. Returns true exactly when file is truthy AND file.exists AND
// file.length > 64; otherwise false.
function isValidPng(file) {
    return !!(file && file.exists && file.length > 64);
}

// Req 3.1/3.2: Suppress dialogs around saveFrameToPng, always restore suppression
// in a finally, then validate the output. Reports failure (never success) when the
// render throws. Returns { success:Boolean, error?:String }.
// Ported from MNTOOLS saveCompFramePng (_ref/MNTOOLS/host/index.jsx).
function renderFrameToPng(comp, time, outFile) {
    // Req 2.12: remember the composition's current time BEFORE any mutation and
    // restore it in the finally on both the success and the failure path. Most
    // callers pass a scratch/temp comp, but generateActiveFrameThumbnail passes
    // the LIVE composition, so focusing the frame used to move the user's
    // playhead permanently.
    var prevTime = null;
    var timeChanged = false;
    try { prevTime = comp.time; } catch (ePrev) { prevTime = null; }

    // Req 3.1: enable dialog suppression before rendering so a modal dialog can
    // never stall the render.
    app.beginSuppressDialogs();
    try {
        // Minimal prep as MNTOOLS does: focus the target frame when a time is
        // supplied. Guarded so a rejected time assignment does not abort render.
        if (time !== undefined && time !== null) {
            try { comp.time = time; timeChanged = true; } catch (eTime) { }
        }
        comp.saveFrameToPng(time, outFile);
    } catch (e) {
        // Req 3.2: a thrown render reports failure - never success.
        return { success: false, error: e.toString() };
    } finally {
        // Req 2.12: restore the playhead first, then release suppression. Each
        // step is independently guarded so one failure cannot skip the other or
        // change the reported result.
        if (timeChanged && prevTime !== null) {
            try { comp.time = prevTime; } catch (eRestore) { }
        }
        // Req 3.1/3.2: ALWAYS restore suppression, even when the render throws,
        // so dialog suppression can never get stuck on.
        try { app.endSuppressDialogs(false); } catch (eEnd) { }
    }
    // Req 3.3/3.4: success only when the output is a Valid PNG.
    return { success: isValidPng(outFile) };
}

// =========================================================
// LAYER_PREP_HELPER (Req 4)
// =========================================================

// Req 4.5: Capture the Original Layer State (locked + shy) BEFORE any mutation.
// Distinct from captureLayerState in templates_save.jsx (full switch/marker set).
// Each read is independently guarded and defaults to false so a rejected/absent
// attribute never aborts the capture or the surrounding prep. Never throws.
// Returns { locked:Boolean, shy:Boolean }.
// Ported from MNTOOLS prepareLayerForEdit/unlockLayerForEdit lock handling.
function captureLayerLockState(layer) {
    var state = { locked: false, shy: false };
    if (!layer) return state;
    // Read each attribute defensively BEFORE any mutation (Req 4.5). Coerce to a
    // real Boolean so the captured value round-trips cleanly on restore.
    try { state.locked = layer.locked === true; } catch (e1) { }
    try { state.shy = layer.shy === true; } catch (e2) { }
    return state;
}

// Req 4.1-4.7: Internal shared attribute normalization for both prep variants.
// Sets locked=false, shy=false, enabled=true, selected=true on the layer and
// hideShyLayers=false on the comp. Every individual assignment is independently
// try-guarded so one failing attribute does not abort the rest (Req 4.7).
function normalizeLayerForEdit(layer, comp) {
    // Req 4.1: unlock / unshy / enable / select - each guarded independently.
    try { layer.locked = false; } catch (e1) { }
    try { layer.shy = false; } catch (e2) { }
    try { layer.enabled = true; } catch (e3) { }
    try { layer.selected = true; } catch (e4) { }
    // Req 4.2: reveal shy layers on the enclosing comp (guarded).
    if (comp) {
        try { comp.hideShyLayers = false; } catch (e5) { }
    }
}

// Req 4.1-4.3/4.5/4.7: Heavy prep. Capture the Original Layer State BEFORE any
// mutation, normalize the layer's attributes (unlock/unshy/enable/select) and set
// comp.hideShyLayers=false, then additionally focusComp(comp) + comp.openInViewer()
// (the viewport repaint that distinguishes Heavy from Light prep). Each attribute
// assignment is independently guarded (Req 4.7). Returns captured Original Layer State.
// Ported from MNTOOLS prepareLayerForEdit (_ref/MNTOOLS/host/index.jsx).
function prepareLayerForEdit(layer, comp) {
    // Req 4.5: capture original locked+shy before touching the layer.
    var original = captureLayerLockState(layer);
    if (!layer) return original;

    // Req 4.1/4.2/4.7: shared attribute normalization.
    normalizeLayerForEdit(layer, comp);

    // Req 4.3: Heavy prep focuses the comp and opens it in the viewer (guarded so
    // a viewport failure does not abort or throw).
    if (comp) {
        try { focusComp(comp); } catch (e6) { }
        try { comp.openInViewer(); } catch (e7) { }
    }

    return original;
}

// Req 4.1-4.2/4.4/4.5/4.7: Light prep. Identical capture + attribute normalization
// as Heavy prep, but does NOT focus the comp or open it in the viewer, so it never
// triggers a viewport repaint (batch smoothness). Returns captured Original Layer State.
// Ported from MNTOOLS unlockLayerForEdit (_ref/MNTOOLS/host/index.jsx).
function unlockLayerForEdit(layer, comp) {
    // Req 4.5: capture original locked+shy before touching the layer.
    var original = captureLayerLockState(layer);
    if (!layer) return original;

    // Req 4.1/4.2/4.7: shared attribute normalization only (Req 4.4: no focus /
    // openInViewer).
    normalizeLayerForEdit(layer, comp);

    return original;
}

// Req 4.6: Restore the layer's locked and shy attributes from a captured Original
// Layer State. Each assignment is independently guarded; never throws. No-op when
// the layer or captured state is missing.
function restoreLayerState(layer, original) {
    if (!layer || !original) return;
    try { layer.locked = original.locked === true; } catch (e1) { }
    try { layer.shy = original.shy === true; } catch (e2) { }
}

// =========================================================
// FIT_HELPER (Req 5)
// =========================================================

// Req 5.4: Pure math extracted for testability. Returns [sx, sy] scale percentages.
// Horizontal scale = (compW / srcW) * 100, vertical scale = (compH / srcH) * 100.
// The two axes are computed independently. Ported from MNTOOLS fitLayerToComp.
function computeFitScale(compW, compH, srcW, srcH) {
    return [(compW / srcW) * 100, (compH / srcH) * 100];
}

// Req 5.1-5.6: Fit a single layer to a comp - anchor to source center, position to
// comp center only when unanimated, independent per-axis scale, preserve Z on 3D
// arrays. Reports failure and writes NOTHING when source dims are indeterminate.
// Returns { success:Boolean, error?:String }.
// Ported from MNTOOLS fitLayerToComp (_ref/MNTOOLS/host/index.jsx).
function fitLayerToComp(layer, comp) {
    // Guard: nothing to fit without both a layer and its enclosing comp.
    if (!layer || !comp) return { success: false };

    try {
        // Req 5.6: resolve the source dimensions. Prefer the layer's source
        // (layer.source.width/height) and only accept a COMPLETE non-zero pair;
        // otherwise fall back to the layer's own width/height. If neither path
        // yields a complete non-zero pair the dims are indeterminate: report
        // failure and write nothing (no transform group is even touched below).
        var sw = 0, sh = 0;

        var src = null;
        try { src = layer.source; } catch (eSrc) { src = null; }
        if (src) {
            var ssw = 0, ssh = 0;
            try { ssw = Number(src.width) || 0; } catch (eSW) { ssw = 0; }
            try { ssh = Number(src.height) || 0; } catch (eSH) { ssh = 0; }
            if (ssw > 0 && ssh > 0) { sw = ssw; sh = ssh; }
        }

        if (!(sw > 0 && sh > 0)) {
            var lsw = 0, lsh = 0;
            try { lsw = Number(layer.width) || 0; } catch (eLW) { lsw = 0; }
            try { lsh = Number(layer.height) || 0; } catch (eLH) { lsh = 0; }
            if (lsw > 0 && lsh > 0) { sw = lsw; sh = lsh; }
        }

        // Req 5.6: indeterminate dims -> fail and leave the layer unchanged.
        if (!(sw > 0 && sh > 0)) return { success: false };

        // Resolve the comp dimensions (guarded, default 0).
        var cw = 0, ch = 0;
        try { cw = Number(comp.width) || 0; } catch (eCW) { cw = 0; }
        try { ch = Number(comp.height) || 0; } catch (eCH) { ch = 0; }

        // Resolve the transform group and its anchor/position/scale properties.
        var tg = null;
        try { tg = layer.property("ADBE Transform Group"); } catch (eTG) { tg = null; }
        if (!tg) return { success: false };

        var anchor = null, position = null, scale = null;
        try { anchor = tg.property("ADBE Anchor Point"); } catch (eA) { anchor = null; }
        try { position = tg.property("ADBE Position"); } catch (eP) { position = null; }
        try { scale = tg.property("ADBE Scale"); } catch (eSc) { scale = null; }

        // Req 5.1 / 5.5: anchor -> source center [sw/2, sh/2], preserving the
        // Z component when the current anchor value is a 3D array.
        if (anchor) {
            var newAnchor = [sw / 2, sh / 2];
            var av = null;
            try { av = anchor.value; } catch (eAV) { av = null; }
            if (av && av.length === 3) newAnchor = [sw / 2, sh / 2, av[2]];
            try { anchor.setValue(newAnchor); } catch (eSetA) { }
        }

        // Req 5.2 / 5.3 / 5.5: position -> comp center, but ONLY when the
        // position has no expression AND no keyframes; otherwise leave it be.
        if (position) {
            var expr = true, keys = 1;
            try { expr = position.expressionEnabled; } catch (eEx) { expr = true; }
            try { keys = position.numKeys; } catch (eNK) { keys = 1; }
            if (expr === false && keys === 0) {
                var newPos = [cw / 2, ch / 2];
                var pv = null;
                try { pv = position.value; } catch (ePV) { pv = null; }
                if (pv && pv.length === 3) newPos = [cw / 2, ch / 2, pv[2]];
                try { position.setValue(newPos); } catch (eSetP) { }
            }
        }

        // Req 5.4 / 5.5: scale -> independent per-axis fit via computeFitScale,
        // preserving the Z component when the current scale value is 3D.
        if (scale) {
            var fit = computeFitScale(cw, ch, sw, sh);
            var newScale = [fit[0], fit[1]];
            var sv = null;
            try { sv = scale.value; } catch (eSV) { sv = null; }
            if (sv && sv.length === 3) newScale = [fit[0], fit[1], sv[2]];
            try { scale.setValue(newScale); } catch (eSetS) { }
        }

        return { success: true };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

// Req 5.7: Walk the nested precomp chain (source-as-CompItem), fitting each contained
// layer to its own enclosing composition, with a traversal depth guard to avoid
// infinite loops on circular precomps. Never throws. Delegates the single-level fit
// to fitLayerToComp per level. Returns { success:Boolean, levels:Number, error?:String }.
// Ported from MNTOOLS deepFitToComp (which reads the selection; here we take explicit args).
function deepFitLayerToComp(layer, comp) {
    // Traversal depth guard: caps recursion so a circular precomp reference
    // (a comp that eventually contains itself) can never loop forever.
    var MAX_DEPTH = 20;
    var levels = 0;

    try {
        // Iterative stack of { layer, comp, depth } frames to avoid deep JS
        // recursion in the ES3 engine. Each frame fits one layer to its own
        // enclosing comp, then queues that layer's source-comp layers.
        var stack = [{ layer: layer, comp: comp, depth: 0 }];

        while (stack.length > 0) {
            var frame = stack.pop();
            var lyr = frame.layer;
            var cmp = frame.comp;
            var depth = frame.depth;

            // Guard: stop descending once we hit the depth cap.
            if (depth >= MAX_DEPTH) continue;
            if (!lyr || !cmp) continue;

            // Req 5.7: fit this layer to its own enclosing composition.
            try { fitLayerToComp(lyr, cmp); } catch (eFit) { }
            levels++;

            // Descend: if this layer's source is a CompItem, queue each of the
            // source comp's contained layers paired with the source comp as
            // their enclosing composition.
            var src = null;
            try { src = lyr.source; } catch (eS) { src = null; }
            if (src && (src instanceof CompItem)) {
                var coll = null;
                try { coll = src.layers; } catch (eL) { coll = null; }
                if (coll) {
                    var n = 0;
                    try { n = Number(coll.length) || 0; } catch (eN) { n = 0; }
                    // AE LayerCollection is 1-based.
                    for (var i = 1; i <= n; i++) {
                        var child = null;
                        try { child = coll[i]; } catch (eC) { child = null; }
                        if (child) stack.push({ layer: child, comp: src, depth: depth + 1 });
                    }
                }
            }
        }

        return { success: true, levels: levels };
    } catch (e) {
        return { success: false, levels: levels, error: e.toString() };
    }
}

// =========================================================
// VIEWER_HELPER (Req 6)
// =========================================================

// Req 6.1/6.2/6.4: Record comp.time, nudge to a different time then restore it
// (guarded), then comp.openInViewer(). If nudging throws it still attempts
// openInViewer and never throws. Intentionally lighter than MNTOOLS (no
// solo/shy clearing) per design (Req 10 no-regression).
// Ported from MNTOOLS forceCompViewerRefresh (_ref/MNTOOLS/host/index.jsx).
function forceCompViewerRefresh(comp) {
    // Guard: nothing to refresh without a comp.
    if (!comp) return;

    // Req 6.1: nudge the current time to a different value then restore the
    // original, forcing AE to recompute/redraw the frame. Guarded as a whole so
    // a rejected time assignment (Req 6.4) still lets us reach openInViewer.
    try {
        var t = comp.time;
        // Nudge by one frame duration when available, else a tiny epsilon.
        var eps = 0.001;
        try { if (comp.frameDuration) eps = comp.frameDuration; } catch (eFD) { }
        comp.time = t + eps;
        comp.time = t;
    } catch (eT) { }

    // Req 6.2/6.4: always attempt to (re)open the comp in the viewer, even if the
    // time nudge above threw.
    try { comp.openInViewer(); } catch (eV) { }
}

// Req 6 (support): Set app.project.activeItem = comp (guarded) and
// comp.openInViewer() (guarded). No solo/shy clearing (lighter than MNTOOLS).
// Ported from MNTOOLS focusComp (_ref/MNTOOLS/host/index.jsx).
function focusComp(comp) {
    // Guard: nothing to focus without a comp.
    if (!comp) return;

    // Make the comp the active project item (guarded so a rejected assignment
    // does not abort or throw).
    try { app.project.activeItem = comp; } catch (e0) { }
    // Open the comp in the viewer (guarded).
    try { comp.openInViewer(); } catch (e1) { }
}

// =========================================================
// COMP_RESOLVER (Req 8)
// =========================================================

// Req 8.1-8.4: Return the active item when it is a CompItem; else the first comp in
// app.project.selection; else the sole comp when the project has exactly one; else null.
// Defensive throughout; never throws. Distinct from resolveCompForSave in core.jsx
// (save-oriented). Ported from MNTOOLS getActiveComp (_ref/MNTOOLS/host/index.jsx).
function resolveActiveComp() {
    // Guard: no project means nothing to resolve.
    var project = null;
    try { project = app.project; } catch (eP) { project = null; }
    if (!project) return null;

    // Req 8.1: the active item, when it is a CompItem, wins.
    try {
        var active = project.activeItem;
        if (active && (active instanceof CompItem)) return active;
    } catch (e1) { }

    // Req 8.2: otherwise, the first CompItem found in the project selection.
    try {
        var sel = project.selection;
        if (sel) {
            for (var i = 0; i < sel.length; i++) {
                try {
                    if (sel[i] instanceof CompItem) return sel[i];
                } catch (eSelItem) { }
            }
        }
    } catch (e2) { }

    // Req 8.3: otherwise, when the project contains exactly one CompItem, that
    // sole comp. Iterate the 1-based item list, counting comps.
    try {
        var found = null;
        var compCount = 0;
        var n = 0;
        try { n = Number(project.numItems) || 0; } catch (eNum) { n = 0; }
        for (var j = 1; j <= n; j++) {
            try {
                var it = project.item(j);
                if (it instanceof CompItem) {
                    compCount++;
                    found = it;
                }
            } catch (eItem) { }
        }
        if (compCount === 1) return found;
    } catch (e3) { }

    // Req 8.4: nothing resolvable.
    return null;
}
