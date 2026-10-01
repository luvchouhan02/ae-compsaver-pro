// ============================================================
// templates_save.jsx - save engines (comp/layer/text/footage/png) + effect ser-deser-save-import
// (ExtendScript module - included by compSaver.jsx; functions are global)
// ============================================================

// =========================================================
// PLACE LAYER
// =========================================================

function placeLayerAtPlayhead(activeComp, newLayer, playheadTime, anchorLayer) {
    try {
        newLayer.startTime = 0;
        var inPoint = newLayer.inPoint;
        newLayer.startTime = playheadTime - inPoint;
    } catch (e) {
        try { newLayer.startTime = playheadTime; } catch (e2) { }
    }

    // Move relative to the anchor REFERENCE. The old code threw the still-valid
    // reference away and re-found the anchor by NAME, which is ambiguous by
    // construction: with two layers sharing the anchor's name the first match
    // won and the imported layer landed above the wrong layer. Layer references
    // stay valid across insertions (only indices shift), so moveBefore on the
    // reference is both exact and cheaper. The name scan survives ONLY as the
    // fallback for a genuinely stale reference -- reading .index on an
    // invalidated reference throws, which is the liveness probe.
    if (anchorLayer) {
        var anchorUsable = false;
        try { anchorUsable = (anchorLayer !== newLayer && anchorLayer.index > 0); } catch (eIdx) { anchorUsable = false; }
        if (anchorUsable) {
            var moved = false;
            try { newLayer.moveBefore(anchorLayer); moved = true; } catch (eMove) { }
            if (!moved) {
                try {
                    var anchorName = anchorLayer.name;
                    var m;
                    for (m = 1; m <= activeComp.numLayers; m++) {
                        try {
                            var ml = activeComp.layer(m);
                            if (ml !== newLayer && ml.name === anchorName) {
                                if (newLayer.index !== m - 1) newLayer.moveBefore(ml);
                                break;
                            }
                        } catch (eLayer) { }
                    }
                } catch (eFallback) { }
            }
        }
    }

    try { deselectAllLayers(activeComp); } catch (e) { }
    try { newLayer.selected = true; } catch (e) { }
}

function copyLayersToComp(layersArray, targetComp) {
    var sorted = [];
    var i;
    for (i = 0; i < layersArray.length; i++) sorted.push(layersArray[i]);
    sorted.sort(function (a, b) { return b.index - a.index; });

    var originalParents = [];
    for (i = 0; i < sorted.length; i++) {
        var parentLyr = null;
        try { parentLyr = sorted[i].parent; } catch (e) { }
        originalParents.push(parentLyr);
        if (parentLyr) {
            try { sorted[i].parent = null; } catch (e) { }
        }
    }

    var copiedLayers = [];
    var copiedCount = 0;
    for (i = 0; i < sorted.length; i++) {
        try {
            sorted[i].copyToComp(targetComp);
            var copiedLyr = targetComp.layer(1);
            copiedLayers.push({
                original: sorted[i],
                copied: copiedLyr,
                originalParent: originalParents[i]
            });
            copiedCount++;
        } catch (e) { }
    }

    for (i = 0; i < sorted.length; i++) {
        if (originalParents[i]) {
            try { sorted[i].parent = originalParents[i]; } catch (e) { }
        }
    }

    for (i = 0; i < copiedLayers.length; i++) {
        var origParent = copiedLayers[i].originalParent;
        if (origParent) {
            var copiedParent = null;
            var j;
            for (j = 0; j < copiedLayers.length; j++) {
                if (copiedLayers[j].original === origParent) {
                    copiedParent = copiedLayers[j].copied;
                    break;
                }
            }
            if (copiedParent) {
                try { copiedLayers[i].copied.parent = copiedParent; } catch (e) { }
            }
        }
    }

    return copiedCount;
}

function copySelectedLayersToTempComp(comp, selectedLayers, tempComp) {
    return copyLayersToComp(selectedLayers, tempComp);
}

// =========================================================
// THUMBNAIL HELPERS
// =========================================================

function generateBlackBgThumbnail(comp, selectedLayers, thumbFile, r, section, effectDataObjects) {
    var tempPreviewComp = null;
    var oldDepth = null;
    var thumbSuccess = false;
    // Hoisted so the finally block can remove the project-scope footage item
    // imported below (Bug F: it used to leak into the user's live project).
    var mediaItem = null;
    try {
        oldDepth = app.project.bitsPerChannel;
        app.project.bitsPerChannel = 8;

        var thumbW = comp.width;
        var thumbH = comp.height;
        if (section === "effect") {
            thumbW = 1080;
            thumbH = 1080;
        }

        tempPreviewComp = app.project.items.addComp(
            "_CSThumbPreview_" + generateUniqueTimestamp(),
            thumbW, thumbH, comp.pixelAspect, comp.duration, comp.frameRate
        );

        if (section === "effect" && effectDataObjects) {
            var adjLayer = tempPreviewComp.layers.addSolid([1, 1, 1], "Adjustment Layer", thumbW, thumbH, 1);
            adjLayer.adjustmentLayer = true;
            for (var ej = 0; ej < effectDataObjects.length; ej++) {
                applyEffectData(adjLayer, effectDataObjects[ej]);
            }
        } else {
            copySelectedLayersToTempComp(comp, selectedLayers, tempPreviewComp);
        }

        var isLayerSection = (section === "layer" || section === "effect");
        var bgLayer = null;
        var hasCamera = false;

        if (isLayerSection) {
            var lIdx;
            for (lIdx = 1; lIdx <= tempPreviewComp.numLayers; lIdx++) {
                try {
                    if (tempPreviewComp.layer(lIdx) instanceof CameraLayer) {
                        hasCamera = true;
                        break;
                    }
                } catch (eCam) { }
            }

            var customMediaFile = null;
            if (r) {
                var rClean = r.replace(/\\/g, "/");
                var foldersToSearch = [
                    rClean + "/preview_assets",
                    rClean + "/preview"
                ];
                var fIdx;
                for (fIdx = 0; fIdx < foldersToSearch.length; fIdx++) {
                    try {
                        var folder = new Folder(foldersToSearch[fIdx]);
                        if (folder.exists) {
                            var files = folder.getFiles(function (file) {
                                if (file instanceof File) {
                                    var nameLower = file.name.toLowerCase();
                                    return (nameLower.slice(-4) === ".png" ||
                                        nameLower.slice(-4) === ".jpg" ||
                                        nameLower.slice(-5) === ".jpeg" ||
                                        nameLower.slice(-4) === ".mp4");
                                }
                                return false;
                            });
                            if (files && files.length > 0) {
                                customMediaFile = files[0];
                                break;
                            }
                        }
                    } catch (eFold) { }
                }

                if (!customMediaFile) {
                    var extensions = [".png", ".jpg", ".jpeg", ".mp4"];
                    var extIdx;
                    for (extIdx = 0; extIdx < extensions.length; extIdx++) {
                        try {
                            var f = new File(rClean + "/preview_media" + extensions[extIdx]);
                            if (f.exists) {
                                customMediaFile = f;
                                break;
                            }
                        } catch (eF) { }
                    }
                }
            }

            if (customMediaFile && customMediaFile.exists) {
                try {
                    mediaItem = app.project.importFile(new ImportOptions(customMediaFile));
                    // Enable looping if it's a video/footage item so it covers the thumbnail midpoint
                    if (mediaItem && mediaItem.mainSource && !mediaItem.mainSource.isStill) {
                        try {
                            mediaItem.mainSource.loop = 10;
                        } catch (eLoop) { }
                    }
                } catch (eMedia) { }
            }

            if (mediaItem) {
                try {
                    bgLayer = tempPreviewComp.layers.add(mediaItem);
                    bgLayer.moveToEnd();
                    var scaleX = (tempPreviewComp.width / bgLayer.width) * 100;
                    var scaleY = (tempPreviewComp.height / bgLayer.height) * 100;
                    var scale = Math.max(scaleX, scaleY);
                    bgLayer.property("ADBE Transform Group").property("ADBE Scale").setValue([scale, scale, 100]);
                    bgLayer.property("ADBE Transform Group").property("ADBE Position").setValue([tempPreviewComp.width / 2, tempPreviewComp.height / 2]);
                    if (hasCamera) {
                        bgLayer.threeDLayer = true;
                    }
                    // Extend outPoint so the background is visible at the midpoint
                    try {
                        bgLayer.outPoint = tempPreviewComp.duration;
                    } catch (eOut) { }
                } catch (eBgL) {
                    bgLayer = null;
                }
            }
        }

        if (!bgLayer) {
            var blackBg = tempPreviewComp.layers.addSolid([0.15, 0.15, 0.16], "__bg__", comp.width, comp.height, 1);
            blackBg.moveToEnd();
            if (isLayerSection && hasCamera) {
                try { blackBg.threeDLayer = true; } catch (e) { }
            }
            if (isLayerSection) {
                try {
                    var gridFx = blackBg.property("ADBE Effect Parade").addProperty("ADBE Grid");
                    gridFx.property("Size From").setValue(2);
                    gridFx.property("Width").setValue(tempPreviewComp.width / 8);
                    gridFx.property("Height").setValue(tempPreviewComp.width / 8);
                    gridFx.property("Border").setValue(2);
                    gridFx.property("Color").setValue([0.3, 0.3, 0.32]);
                } catch (eGrid) { }
            }
            bgLayer = blackBg;
        }

        if (isLayerSection && hasCamera) {
            var colors = [
                [0.85, 0.35, 0.35],
                [0.35, 0.75, 0.45],
                [0.35, 0.55, 0.85],
                [0.85, 0.75, 0.35]
            ];
            var positions = [
                [tempPreviewComp.width * 0.25, tempPreviewComp.height * 0.25, -200],
                [tempPreviewComp.width * 0.75, tempPreviewComp.height * 0.25, 200],
                [tempPreviewComp.width * 0.25, tempPreviewComp.height * 0.75, 100],
                [tempPreviewComp.width * 0.75, tempPreviewComp.height * 0.75, -100]
            ];
            var cIdx;
            for (cIdx = 0; cIdx < colors.length; cIdx++) {
                try {
                    var square = tempPreviewComp.layers.addSolid(colors[cIdx], "CS_Ref_Square_" + cIdx, 80, 80, 1);
                    square.moveToEnd();
                    if (bgLayer) {
                        square.moveBefore(bgLayer);
                    }
                    square.threeDLayer = true;
                    square.property("ADBE Transform Group").property("ADBE Position").setValue(positions[cIdx]);
                    square.property("ADBE Transform Group").property("ADBE Opacity").setValue(70);
                } catch (eSq) { }
            }
        }

        // Take the exact center/midpoint frame of the work area for the thumbnail
        var thumbTime = tempPreviewComp.workAreaStart + (tempPreviewComp.workAreaDuration / 2);
        // Req 3.1-3.5: route render through the shared suppress+validate tail so a
        // blocking dialog can never stall the render and a blank/corrupt PNG is
        // classified as failure rather than a false success.
        thumbSuccess = renderFrameToPng(tempPreviewComp, thumbTime, thumbFile).success;
    } catch (e) { } finally {
        try { if (tempPreviewComp) tempPreviewComp.remove(); } catch (eR) { }
        // Bug F: remove the preview footage item imported at PROJECT scope
        // (app.project.importFile above) so it never persists into the live
        // project / protective snapshot. Runs after tempPreviewComp.remove()
        // so no layer still references it. Guarded + try/catch: a cleanup
        // failure must never mask the save result or skip the depth restore.
        try { if (mediaItem) mediaItem.remove(); } catch (eMI) { }
        try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eD) { }
    }
    // Req 3.5: report success only when a Valid PNG was produced.
    return thumbSuccess;
}

function generateActiveFrameThumbnail(comp, thumbFile) {
    var oldDepth = null;
    var thumbSuccess = false;
    try {
        oldDepth = app.project.bitsPerChannel;
        app.project.bitsPerChannel = 8;
        var thumbTime = comp.workAreaStart + comp.workAreaDuration * 0.3;
        // Req 3.1-3.5: suppress dialogs around the render and validate the output PNG.
        thumbSuccess = renderFrameToPng(comp, thumbTime, thumbFile).success;
    } catch (e) { } finally {
        try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eD) { }
    }
    // Req 3.5: report success only when a Valid PNG was produced.
    return thumbSuccess;
}

function generateEffectThumbnail(comp, layer, thumbFile) {
    var oldDepth = null;
    var originalActiveItem = null;
    var thumbSuccess = false;
    try {
        oldDepth = app.project.bitsPerChannel;
        app.project.bitsPerChannel = 8;
        try {
            originalActiveItem = app.project.activeItem;
            comp.openInViewer();
        } catch (eV) { }
        var thumbTime = comp.workAreaStart + comp.workAreaDuration * 0.3;
        // Req 3.1-3.5: suppress dialogs around the render and validate the output PNG.
        thumbSuccess = renderFrameToPng(comp, thumbTime, thumbFile).success;
    } catch (e) { } finally {
        try {
            if (originalActiveItem && originalActiveItem !== comp && typeof originalActiveItem.openInViewer === "function") {
                originalActiveItem.openInViewer();
            }
        } catch (eVr) { }
        try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eD) { }
    }
    // Req 3.5: report success only when a Valid PNG was produced.
    return thumbSuccess;
}

// =========================================================
// BACKGROUND THUMBNAIL RENDERER (Req 10.3, 11.2)
// ---------------------------------------------------------
// Non-destructive host entry point invoked by the client background queue
// (js/textanim/textanim.js `runOneThumbnail`) AFTER the blocking save has
// returned. It imports the already-saved template `project.aep` into the
// current project as a scratch import (the exact pattern used by
// taRenderPresetPreview), picks the first comp, renders a single frame at
// workAreaStart + workAreaDuration * 0.3 via the shared renderFrameToPng
// tail, then discards the scratch import.
//
// It NEVER touches app.project.file, never calls app.open, and never reduces
// or reloads the user's live project — the only mutation is the temporary
// imported folder, which is always removed before returning.
//
// Returns encodeBridge(JSON{ ok:Boolean, error?:String }) to match the
// client's JSON.parse contract in runOneThumbnail.
// =========================================================
function renderTemplateThumbnail(aepPathHex, outPngPathHex, compNameHex, frameHex) {
    var importedFolder = null;
    var wrapperComp = null;
    var oldDepth = null;
    var dlgSuppressed = false;
    try {
        var aepPath = decodeBridge(aepPathHex || "");
        var outPng = decodeBridge(outPngPathHex || "");
        // Req 2.11: the comp name + frame the save engine recorded pre-reopen.
        // Both optional: absent means "first comp, 30% into the work area",
        // which is exactly the previous behavior (back-compat for a 2-arg call).
        var wantComp = compNameHex ? decodeBridge(compNameHex) : "";
        var wantFrame = -1;
        if (frameHex) {
            var frameRaw = decodeBridge(frameHex);
            if (frameRaw !== "") {
                var frameNum = parseInt(frameRaw, 10);
                if (!isNaN(frameNum) && frameNum >= 0) wantFrame = frameNum;
            }
        }

        if (!aepPath) return encodeBridge('{"ok":false,"error":"No project.aep path"}');
        if (!outPng) return encodeBridge('{"ok":false,"error":"No output png path"}');

        var aepFile = new File(("" + aepPath).replace(/\\/g, "/"));
        if (!aepFile.exists) {
            return encodeBridge('{"ok":false,"error":"Template project.aep missing: ' +
                escapeJSON(aepFile.fsName) + '"}');
        }
        var outFile = new File(("" + outPng).replace(/\\/g, "/"));

        // Force 8-bit for a fast, predictable PNG render; restore in finally.
        try { oldDepth = app.project.bitsPerChannel; app.project.bitsPerChannel = 8; } catch (eD) { }

        // Suppress any modal dialogs (e.g. missing-footage prompts) that the
        // scratch import could raise so the background render never stalls.
        try { app.beginSuppressDialogs(); dlgSuppressed = true; } catch (eSup) { }

        // ── Non-destructive scratch import (taRenderPresetPreview pattern) ──
        var srcComp = null;
        try {
            importedFolder = app.project.importFile(new ImportOptions(aepFile));
            // Req 2.11: target the comp the save engine recorded; only fall back
            // to the first comp when no name was supplied, the name-targeted
            // lookup is out of scope, or the name is not in this .aep.
            if (wantComp && typeof findCompItemInFolderByName === "function") {
                srcComp = findCompItemInFolderByName(importedFolder, wantComp);
            }
            if (!srcComp) srcComp = findCompItemInFolder(importedFolder);
        } catch (eImport) {
            return encodeBridge('{"ok":false,"error":"Importing project.aep failed: ' +
                escapeJSON("" + eImport) + '"}');
        }

        if (!srcComp) {
            return encodeBridge('{"ok":false,"error":"No composition found in project.aep"}');
        }

        // ── Bounded thumbnail resolution ─────────────────────────────────
        // Cards display ~320px wide; rendering a 4K comp at full size wastes
        // (pixels-worth of) render time and memory for pixels that are never
        // shown. Large comps render through a downsized wrapper comp (aspect
        // preserved, layer scaled) so the frame raster itself is capped;
        // comps already at/below the bound render directly.
        var THUMB_TARGET_W = 320;
        var renderComp = srcComp;
        if (srcComp.width > THUMB_TARGET_W) {
            var thumbScale = THUMB_TARGET_W / srcComp.width;
            var thumbH = Math.max(1, Math.round(srcComp.height * thumbScale));
            try {
                wrapperComp = app.project.items.addComp(
                    srcComp.name + " [Thumb]",
                    THUMB_TARGET_W, thumbH,
                    srcComp.pixelAspect, srcComp.duration, srcComp.frameRate);
                var wrapLayer = wrapperComp.layers.add(srcComp);
                wrapLayer.property("ADBE Transform Group").property("ADBE Scale")
                    .setValue([thumbScale * 100, thumbScale * 100]);
                try { wrapperComp.workAreaStart = srcComp.workAreaStart; } catch (eWAS) { }
                try { wrapperComp.workAreaDuration = srcComp.workAreaDuration; } catch (eWAD) { }
                renderComp = wrapperComp;
            } catch (eWrap) {
                // Wrapper creation failed — fall back to rendering the source
                // comp directly rather than failing the thumbnail.
                wrapperComp = null;
                renderComp = srcComp;
            }
        }

        // Req 2.11: render the recorded frame so the in-project fallback produces
        // the SAME frame the isolated aerender path produces. Clamped into the
        // comp so a stale frame index can never push the time past the end.
        // Without a recorded frame, the previous representative frame (30% into
        // the work area) is used. Either way the shared suppress+validate tail
        // reports a blank/corrupt PNG as failure rather than a false success.
        var thumbTime;
        if (wantFrame >= 0 && renderComp.frameRate > 0) {
            thumbTime = wantFrame / renderComp.frameRate;
            var maxTime = renderComp.duration - (1 / renderComp.frameRate);
            if (!(maxTime > 0)) maxTime = 0;
            if (thumbTime > maxTime) thumbTime = maxTime;
            if (!(thumbTime >= 0)) thumbTime = 0;
        } else {
            thumbTime = renderComp.workAreaStart + renderComp.workAreaDuration * 0.3;
        }
        var res = renderFrameToPng(renderComp, thumbTime, outFile);

        if (res && res.success) {
            return encodeBridge('{"ok":true}');
        }
        return encodeBridge('{"ok":false,"error":"' +
            escapeJSON((res && res.error) ? res.error : "thumbnail render produced no valid PNG") +
            '"}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON("" + e) + '"}');
    } finally {
        // Discard the scratch import so the user's live project is untouched.
        // The wrapper goes FIRST: it lives inside the imported folder's tree
        // scope-wise but is a project item of its own.
        try { if (wrapperComp) wrapperComp.remove(); } catch (eWC) { }
        try { if (importedFolder) importedFolder.remove(); } catch (eIF) { }
        try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eDR) { }
        if (dlgSuppressed) { try { app.endSuppressDialogs(false); } catch (eES) { } }
    }
}

// =========================================================
// DIRECT COMP FRAME EXPORT (<100ms, no import overhead)
// Fast native frame export directly from the active AE instance.
// =========================================================
function exportCompFrame(compNameHex, outPngPathHex, timeSecHex) {
    var oldDepth = null;
    var dlgSuppressed = false;
    try {
        var compName = decodeBridge(compNameHex || "");
        var outPng = decodeBridge(outPngPathHex || "");
        var timeSec = 0;
        if (timeSecHex) {
            var rawTime = parseFloat(decodeBridge(timeSecHex));
            if (!isNaN(rawTime) && rawTime >= 0) timeSec = rawTime;
        }
        if (!outPng) return encodeBridge('{"ok":false,"error":"No output png path"}');

        var targetComp = null;
        if (compName && app.project && app.project.items) {
            for (var i = 1; i <= app.project.items.length; i++) {
                var item = app.project.items[i];
                if ((item instanceof CompItem) && item.name === compName) {
                    targetComp = item;
                    break;
                }
            }
        }
        if (!targetComp && app.project && (app.project.activeItem instanceof CompItem)) {
            targetComp = app.project.activeItem;
        }
        if (!targetComp) {
            return encodeBridge('{"ok":false,"error":"Composition not found in active project"}');
        }

        try { oldDepth = app.project.bitsPerChannel; app.project.bitsPerChannel = 8; } catch (eD) { }
        try { app.beginSuppressDialogs(); dlgSuppressed = true; } catch (eSup) { }

        var outFile = new File(("" + outPng).replace(/\\/g, "/"));
        var res = renderFrameToPng(targetComp, timeSec, outFile);
        if (res && res.success) {
            return encodeBridge('{"ok":true}');
        }
        return encodeBridge('{"ok":false,"error":"' + escapeJSON((res && res.error) ? res.error : "Export produced no valid PNG") + '"}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON("" + e) + '"}');
    } finally {
        if (oldDepth !== null) { try { app.project.bitsPerChannel = oldDepth; } catch (eDR) { } }
        if (dlgSuppressed) { try { app.endSuppressDialogs(false); } catch (eES) { } }
    }
}

// =========================================================
// LAYER TIMELINE STATE (switches + markers)
// ---------------------------------------------------------
// copyToComp does not reliably survive the save/.aep/import round-trip for
// every layer switch, so we serialize the full timeline state at save and
// re-apply it at import. Each read/write is guarded because a switch is only
// valid for certain layer types. Marker times are stored RELATIVE to the
// layer start so they land at the same spot wherever the layer is placed.
// =========================================================

function captureLayerState(layer) {
    var st = { switches: {}, markers: [] };
    function grab(key, fn) { try { st.switches[key] = fn(); } catch (e) { } }
    grab("enabled", function () { return !!layer.enabled; });
    grab("solo", function () { return !!layer.solo; });
    grab("shy", function () { return !!layer.shy; });
    grab("motionBlur", function () { return !!layer.motionBlur; });
    grab("adjustmentLayer", function () { return !!layer.adjustmentLayer; });
    grab("threeDLayer", function () { return !!layer.threeDLayer; });
    grab("effectsActive", function () { return !!layer.effectsActive; });
    grab("collapseTransformation", function () { return !!layer.collapseTransformation; });
    grab("guideLayer", function () { return !!layer.guideLayer; });
    grab("frameBlendingType", function () { return layer.frameBlendingType; });
    grab("blendingMode", function () { return layer.blendingMode; });
    grab("label", function () { return layer.label; });
    grab("quality", function () { return layer.quality; });
    grab("samplingQuality", function () { return layer.samplingQuality; });
    grab("autoOrient", function () { return layer.autoOrient; });

    try {
        var mp = layer.property("Marker");
        if (mp && mp.numKeys > 0) {
            var start = 0;
            try { start = layer.startTime; } catch (eS) { }
            var mi;
            for (mi = 1; mi <= mp.numKeys; mi++) {
                var mv = mp.keyValue(mi);
                var m = { t: mp.keyTime(mi) - start };
                try { m.comment = mv.comment; } catch (e) { }
                try { m.chapter = mv.chapter; } catch (e) { }
                try { m.url = mv.url; } catch (e) { }
                try { m.frameTarget = mv.frameTarget; } catch (e) { }
                try { m.cuePointName = mv.cuePointName; } catch (e) { }
                try { m.duration = mv.duration; } catch (e) { }
                try { m.label = mv.label; } catch (e) { }
                st.markers.push(m);
            }
        }
    } catch (eM) { }
    return st;
}

function applyLayerState(layer, st) {
    if (!layer || !st) return;
    var sw = st.switches || {};
    function setSw(key, fn) { if (sw.hasOwnProperty(key) && sw[key] !== null) { try { fn(sw[key]); } catch (e) { } } }
    setSw("threeDLayer", function (v) { layer.threeDLayer = v; });
    setSw("adjustmentLayer", function (v) { layer.adjustmentLayer = v; });
    setSw("motionBlur", function (v) { layer.motionBlur = v; });
    setSw("effectsActive", function (v) { layer.effectsActive = v; });
    setSw("collapseTransformation", function (v) { layer.collapseTransformation = v; });
    setSw("guideLayer", function (v) { layer.guideLayer = v; });
    setSw("shy", function (v) { layer.shy = v; });
    setSw("solo", function (v) { layer.solo = v; });
    setSw("enabled", function (v) { layer.enabled = v; });
    setSw("frameBlendingType", function (v) { layer.frameBlendingType = v; });
    setSw("blendingMode", function (v) { layer.blendingMode = v; });
    setSw("label", function (v) { layer.label = v; });
    setSw("quality", function (v) { layer.quality = v; });
    setSw("samplingQuality", function (v) { layer.samplingQuality = v; });
    setSw("autoOrient", function (v) { layer.autoOrient = v; });

    // Markers: clear any copied markers first (avoid duplicates), then restore.
    try {
        var mk = st.markers || [];
        var mp = layer.property("Marker");
        if (mp) {
            try { while (mp.numKeys > 0) mp.removeKey(1); } catch (eClr) { }
            var start = 0;
            try { start = layer.startTime; } catch (eS) { }
            var i;
            for (i = 0; i < mk.length; i++) {
                var m = mk[i];
                var mv = new MarkerValue(m.comment || "");
                try { if (m.chapter != null) mv.chapter = m.chapter; } catch (e) { }
                try { if (m.url != null) mv.url = m.url; } catch (e) { }
                try { if (m.frameTarget != null) mv.frameTarget = m.frameTarget; } catch (e) { }
                try { if (m.cuePointName != null) mv.cuePointName = m.cuePointName; } catch (e) { }
                try { if (m.duration != null) mv.duration = m.duration; } catch (e) { }
                try { if (m.label != null) mv.label = m.label; } catch (e) { }
                try { mp.setValueAtTime(start + (m.t || 0), mv); } catch (eSet) { }
            }
        }
    } catch (eMA) { }
}

// =========================================================
// CORE SAVE FOR LAYER TYPES
// =========================================================

function coreSaveLayerType(name, cat, r, saveTypeStr, thumbnailMode, section, templateId) {
    var originalFile = null;
    var tempComp = null;
    // True exactly after reduceProject succeeds (the destructive window is
    // entered). Only then is a reopen — and only ONE — permitted.
    var windowEntered = false;

    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return "Open a composition first!";

        var selectedLayers = comp.selectedLayers;
        if (!selectedLayers || selectedLayers.length === 0) return "Please select at least 1 layer.";

        // ── LAYER SECTION VALIDATION GUARDRAIL ────────────────────────────
        // Only allow: Shape, Solid, Adjustment, Camera, Null layers.
        // Block: Text layers, Video/Image footage layers.
        // Additionally: layer must have at least 1 keyframe OR 1 effect (no empty layers).
        if (section === "layer") {
            for (var vi = 0; vi < selectedLayers.length; vi++) {
                var vl = selectedLayers[vi];

                // Block Text layers
                if (vl.matchName === "ADBE Text Layer") {
                    return "Text layers cannot be saved in the Layer section. Use the Text tab instead.";
                }

                // Block footage/image layers (AVLayer with a source that is FootageItem and not a solid)
                try {
                    if (vl.source && (vl.source instanceof FootageItem)) {
                        var ms = vl.source.mainSource;
                        if (ms && !(ms instanceof SolidSource)) {
                            return "Video/Image footage layers cannot be saved in the Layer section. Use the Footage tab instead.";
                        }
                    }
                } catch (eVS) { }

                // Utility Pre-Comp: a pre-comp layer is a valid reusable building
                // block whose content lives inside the nested comp. Do NOT require
                // keyframes/effects on the pre-comp layer itself, and impose no
                // limit on its internal layer count — classify by purpose.
                if (vl.source && (vl.source instanceof CompItem)) {
                    continue;
                }

                // Guard: must have at least 1 keyframe OR 1 effect
                var hasContent = false;
                try {
                    var fxGroup = vl.property("ADBE Effect Parade");
                    if (fxGroup && fxGroup.numProperties > 0) hasContent = true;
                } catch (eFx) { }
                if (!hasContent) {
                    try {
                        function scanForKeys(prop) {
                            if (hasContent) return;
                            try {
                                if (prop.numProperties) {
                                    for (var pi = 1; pi <= prop.numProperties; pi++) {
                                        scanForKeys(prop.property(pi));
                                        if (hasContent) return;
                                    }
                                } else if (prop.canVaryOverTime && prop.numKeys > 0) {
                                    hasContent = true;
                                }
                            } catch (e) { }
                        }
                        for (var pp = 1; pp <= vl.numProperties; pp++) {
                            scanForKeys(vl.property(pp));
                            if (hasContent) break;
                        }
                    } catch (eK) { }
                }
                if (!hasContent) {
                    return "Layer has no keyframes or effects. Add animation or effects before saving.";
                }
            }
        }

        originalFile = app.project.file;
        if (!originalFile) return "Please save your project first!";

        // Check project dirty state (unsaved modifications in memory)
        var isDirty = false;
        try { isDirty = !!app.project.dirty; } catch (eDirty) { }

        // Check for missing footage dependencies on selected layers before reduce
        var hasMissingDependencies = false;
        try {
            for (var dli = 0; dli < selectedLayers.length; dli++) {
                var chkLayer = selectedLayers[dli];
                if (chkLayer.source && chkLayer.source.footageMissing) {
                    hasMissingDependencies = true;
                    break;
                }
            }
        } catch (eDep) { }

        var layerCount = selectedLayers.length;

        var isAdjustment = false;
        var is3D = false;
        var blendMode = -1;
        var label = -1;
        var layerState = null;
        if (layerCount === 1) {
            try { isAdjustment = !!selectedLayers[0].adjustmentLayer; } catch (e) { }
            try { is3D = !!selectedLayers[0].threeDLayer; } catch (e) { }
            try { blendMode = selectedLayers[0].blendingMode; } catch (e) { }
            try { label = selectedLayers[0].label; } catch (e) { }
            // Full timeline state (switches + markers) captured from the ORIGINAL
            // layer BEFORE the save reopens the project (which invalidates refs).
            try { layerState = captureLayerState(selectedLayers[0]); } catch (eLS) { layerState = null; }
        }

        // ── CAPTURE EVERY VALUE DERIVED FROM THE SOURCE COMP (1.2) ────────
        // Everything derived from the SOURCE comp, captured before the
        // destructive window. reduceProject([tempComp]) removes the source comp
        // from the project and app.open then invalidates the reference, so reading
        // comp.workAreaStart / workAreaDuration / frameRate at result-build time
        // threw and reported a successful save as a failure. Same pattern as the
        // layerState capture immediately above.
        var capCompWidth = 0;
        var capCompHeight = 0;
        var capCompPixelAspect = 1;
        var capCompFrameRate = 0;
        var capCompDuration = 0;
        var capCompFrame = 0;
        try { capCompWidth = comp.width; } catch (eCW) { }
        try { capCompHeight = comp.height; } catch (eCH) { }
        try { capCompPixelAspect = comp.pixelAspect; } catch (eCP) { }
        try { capCompFrameRate = comp.frameRate; } catch (eCR) { }
        try { capCompDuration = comp.duration; } catch (eCD) { }
        try {
            capCompFrame = Math.round(
                (comp.workAreaStart + comp.workAreaDuration * 0.3) * comp.frameRate);
        } catch (eCF) { capCompFrame = 0; }
        if (!(capCompFrame >= 0)) capCompFrame = 0; // NaN-safe floor

        // ── LIBRARY ROOT VALIDATION (1.6) ─────────────────────────────────
        // Same rule and same reasoning as saveActiveComp: validated before the
        // path is derived, before ensureDeepFolder and before app.beginUndoGroup,
        // so a bad root is a pre-window rejection. validateLibraryRoot lives in
        // jsx/core.jsx; the inline branch keeps the absolute-path rule in force
        // when this engine is executed on its own.
        var rNorm = (r === null || r === undefined)
            ? "" : ("" + r).replace(/\\/g, "/").replace(/^\s+|\s+$/g, "");
        var rootCheck = (typeof validateLibraryRoot === "function")
            ? validateLibraryRoot(rNorm)
            : (/^([A-Za-z]:\/|\/)/.test(rNorm)
                ? { ok: true, path: rNorm.replace(/\/+$/, "") }
                : { ok: false, error: "Library root is not an absolute path: " + rNorm });
        if (!rootCheck.ok) return "Save Error: " + rootCheck.error;
        if (!name) return "Please enter a template name.";

        var safeCat = getSafeName(cat);
        var targetFolderPath = rootCheck.path + "/" + section + "/" + safeCat + "/" + templateId;
        var f = ensureDeepFolder(targetFolderPath);
        // Verified BEFORE app.beginUndoGroup and before the protective save, so
        // this is a pre-window failure (1.7): no undo group to leak, no reopen,
        // the live project untouched in memory and on disk.
        if (!f || !f.exists) {
            return "Save Error: Failed to create folder: " + targetFolderPath;
        }

        // ── RESTORE_AND_RETURN (destructive-window failure handler) ───────
        // Called only AFTER reduceProject has run (the "destructive window"),
        // where the in-memory project is compromised. Best-effort remove the
        // temp comp, end the undo group exactly once, reopen originalFile from
        // the on-disk snapshot written by the protective save (suppress-dialogs
        // balanced), and return the failure message string.
        function RESTORE_AND_RETURN(origFile, message) {
            try { if (tempComp) tempComp.remove(); } catch (eR) { }
            try { app.endUndoGroup(); } catch (eR2) { }
            // Task 12.2, Req 2.23: suppression is released by try/finally on
            // EVERY path, so a throw inside app.open can never leave it stuck
            // on for the session. Sequence unchanged (Req 3.1/3.2/3.3):
            // remove temp comp, end the undo group once, ONE suppress-balanced
            // reopen, return the message.
            var reopenOk = true;
            var suppressed = false;
            try { app.beginSuppressDialogs(); suppressed = true; } catch (eSupB) { }
            try {
                app.open(origFile);
            } catch (eR3) {
                reopenOk = false;
            } finally {
                if (suppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
            }
            if (!reopenOk) {
                return message + " — automatic restore failed; please reopen your project manually from disk.";
            }
            return message;
        }

        app.beginUndoGroup("Save " + saveTypeStr);

        // ── PROTECTIVE SAVE (abort-on-failure) ────────────────────────────
        // If the protective save fails we abort BEFORE any destructive op:
        // end the undo group once and return. No temp comp, no reduce, no
        // reopen — the live project is 100% intact.
        var protectOk = true;
        try {
            app.project.save(originalFile);
        } catch (saveErr) {
            protectOk = false;
        }
        if (!protectOk) {
            app.endUndoGroup();
            return "Protective save failed — aborted, your project is untouched.";
        }

        // ── BUILD TEMP COMP (pre-reduce, non-destructive) ─────────────────
        var tempCompName = name + " [Temp]";
        tempComp = app.project.items.addComp(tempCompName, comp.width, comp.height, comp.pixelAspect, comp.duration, comp.frameRate);

        if (!tempComp) {
            app.endUndoGroup();
            return "Could not create temp comp!";
        }

        try {
            tempComp.workAreaStart = comp.workAreaStart;
            tempComp.workAreaDuration = comp.workAreaDuration;
        } catch (e) { }

        var copied = copySelectedLayersToTempComp(comp, selectedLayers, tempComp);

        if (copied === 0 || tempComp.numLayers === 0) {
            try { tempComp.remove(); } catch (e) { }
            app.endUndoGroup();
            return "Layer copy failed!";
        }

        var targetFile = new File(f.fsName.replace(/\\/g, "/") + "/project.aep");

        // ── DESTRUCTIVE WINDOW: reduce first, then the single template save ─
        try {
            app.project.reduceProject([tempComp]);
            windowEntered = true;
        } catch (reduceErr) {
            return RESTORE_AND_RETURN(originalFile, "Reduce failed: " + reduceErr.toString());
        }

        try { tempComp.name = name; } catch (e) { }

        try {
            app.project.save(targetFile);
        } catch (saveErr2) {
            return RESTORE_AND_RETURN(originalFile, "Template save failed: " + saveErr2.toString());
        }

        // ── COLLECT ASSETS (after reduce, before reopen) ──────────────────
        var assetsList = [];
        var ii;
        for (ii = app.project.numItems; ii >= 1; ii--) {
            try {
                var item = app.project.item(ii);
                if (item instanceof FootageItem && item.file && item.file.exists) {
                    assetsList.push({
                        fsPath: item.file.fsName,
                        name: fsEntryName(item.file) || item.file.name
                    });
                }
            } catch (e) { }
        }

        app.endUndoGroup();

        // ── REOPEN ONCE (suppress-balanced via try/finally) ───────────────
        // Invariant preserved: exactly ONE reopen, and only because the
        // destructive window was entered.
        var reopenOk = true;
        var reopenErr = "";
        var reopenSuppressed = false;
        try { app.beginSuppressDialogs(); reopenSuppressed = true; } catch (eSupB) { }
        try {
            app.open(originalFile);
        } catch (eReopen) {
            reopenOk = false;
            reopenErr = eReopen.toString();
        } finally {
            if (reopenSuppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
        }

        // A FAILED reopen is NOT a success: app.project.save(targetFile) above
        // reassigned app.project.file to the library template, so the user's
        // next Ctrl+S would overwrite the template with their own project (1.5).
        // A string return is this function's failure protocol — the callers
        // already branch on typeof.
        if (!reopenOk) {
            return "Template written to " + targetFolderPath.replace(/\\/g, "/") +
                ", but reopening your project failed: " + reopenErr +
                " — After Effects is still pointed at the template's project.aep." +
                " Do NOT save; reopen your project manually from disk first.";
        }

        return {
            ok: true,
            layerCount: layerCount,
            isAdjustment: isAdjustment,
            is3D: is3D,
            blendMode: blendMode,
            label: label,
            layerState: layerState,
            assetsList: assetsList,
            folderPath: targetFolderPath.replace(/\\/g, "/"),
            needsThumbnail: true,
            // Composition format, captured pre-reopen, so meta.json can record
            // it and no consumer has to open the .aep to learn it.
            width: capCompWidth,
            height: capCompHeight,
            pixelAspect: capCompPixelAspect,
            frameRate: capCompFrameRate,
            duration: capCompDuration,
            // tempComp was renamed to name before the reduce, so that IS the
            // comp name inside project.aep. The frame comes from the pre-window
            // capture — reading it from the source comp here throws.
            renderComp: name,
            renderFrame: capCompFrame
        };
    } catch (e) {
        if (windowEntered) {
            // The destructive window was entered: restore from the
            // protective snapshot (suppress-balanced, one reopen).
            try { if (tempComp) tempComp.remove(); } catch (eR) { }
            try { app.endUndoGroup(); } catch (eR2) { }
            // Task 12.2, Req 2.23: suppression released by try/finally on every
            // path. Sequence unchanged (Req 3.1/3.2/3.3).
            var reopenOkOuter = true;
            var suppressedOuter = false;
            try { app.beginSuppressDialogs(); suppressedOuter = true; } catch (eSupB) { }
            try {
                app.open(originalFile);
            } catch (eR3) {
                reopenOkOuter = false;
            } finally {
                if (suppressedOuter) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
            }
            if (!reopenOkOuter) {
                return "Save Error: " + e.toString() +
                    " — automatic restore failed; please reopen your project manually from disk.";
            }
            return "Save Error: " + e.toString();
        }
        // Pre-window failure (folder/temp-comp/copy): the live project is
        // intact on disk AND in memory. End the undo group once and return.
        // NO reopen — reloading would discard the user's undo context for
        // no restorative benefit (invariant: reopen only after the window).
        try { if (tempComp) tempComp.remove(); } catch (eTmp) { }
        try { app.endUndoGroup(); } catch (e3) { }
        return "Save Error: " + e.toString();
    }
}

// =========================================================
// SAVE COMP
// =========================================================

function saveActiveComp(nHex, cHex, rHex, oldIdHex) {
    var originalFile = null;
    var logMsg = "";
    // True exactly after reduceProject succeeds (the destructive window is
    // entered). Only then is a reopen — and only ONE — permitted.
    var windowEntered = false;

    function log(step) {
        logMsg += "[" + step + "] ";
    }

    try {
        log("start");
        var name = cleanStr(decodeBridge(nHex));
        var cat = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var oldId = "";
        if (oldIdHex) oldId = cleanStr(decodeBridge(oldIdHex));
        log("decoded: name=" + name + ", cat=" + cat + ", r=" + r + ", oldId=" + oldId);

        log("resolving comp");
        var resolved = resolveCompForSave();
        if (!resolved.ok) {
            log("resolve failed: " + resolved.error);
            return encodeBridge("Error: " + logMsg + " -> " + (resolved.error || "Cannot resolve comp."));
        }

        var precomp = resolved.comp;
        if (!precomp) {
            log("comp null");
            return encodeBridge("Error: " + logMsg + " -> No comp.");
        }
        log("resolved: " + precomp.name);

        originalFile = app.project.file;
        if (!originalFile) {
            log("no project file");
            return encodeBridge("Error: " + logMsg + " -> Please save your project first!");
        }
        log("original file: " + originalFile.fsName);

        // Check project dirty state (unsaved modifications in memory)
        var isDirty = false;
        try { isDirty = !!app.project.dirty; } catch (eDirty) { }
        if (isDirty) log("project has unsaved edits — protective snapshot will persist current state");

        // Check for missing footage dependencies in comp before reduce
        try {
            for (var cmi = 1; cmi <= precomp.numLayers; cmi++) {
                var chkCompLayer = precomp.layer(cmi);
                if (chkCompLayer && chkCompLayer.source && chkCompLayer.source.footageMissing) {
                    log("Warning: layer " + cmi + " has missing footage: " + chkCompLayer.name);
                }
            }
        } catch (eFm) { }

        // ── EMPTY-NAME GUARD ──────────────────────────────────────────────
        // Sits next to the project-file guard so it is a pre-window rejection:
        // without it an empty name derives "<root>/comp/<cat>/" and project.aep
        // plus meta.json land in the CATEGORY folder, corrupting the scan.
        if (!name) {
            log("empty name");
            return encodeBridge("Error: " + logMsg + " -> Please enter a template name.");
        }

        // ── LIBRARY ROOT VALIDATION (1.6) ─────────────────────────────────
        // Runs BEFORE the path is derived, before ensureDeepFolder and before
        // app.beginUndoGroup, so an empty or relative root is a pre-window
        // rejection: nothing is created, no undo group to leak, no reopen, the
        // live project untouched. Without it "<root>/comp/<cat>/<id>" collapses
        // to "/comp/<cat>/<id>" and the tree is created at the volume root.
        // validateLibraryRoot lives in jsx/core.jsx; the inline branch is the
        // same defensive shape the jsonParse call sites use, so the absolute-path
        // rule still applies when this engine runs on its own (only the on-disk
        // resolvable-parent probe is skipped).
        var rNorm = (r === null || r === undefined)
            ? "" : ("" + r).replace(/\\/g, "/").replace(/^\s+|\s+$/g, "");
        var rootCheck = (typeof validateLibraryRoot === "function")
            ? validateLibraryRoot(rNorm)
            : (/^([A-Za-z]:\/|\/)/.test(rNorm)
                ? { ok: true, path: rNorm.replace(/\/+$/, "") }
                : { ok: false, error: "Library root is not an absolute path: " + rNorm });
        if (!rootCheck.ok) {
            log("invalid library root");
            return encodeBridge("Error: " + logMsg + " -> " + rootCheck.error);
        }

        var templateId = generateTemplateId(name);
        var targetFolderPath = rootCheck.path + "/comp/" + getSafeName(cat) + "/" + templateId;
        log("ensuring deep folder: " + targetFolderPath);
        var f = ensureDeepFolder(targetFolderPath);
        if (!f || !f.exists) {
            log("deep folder ensure failed");
            return encodeBridge("Error: " + logMsg + " -> Failed to create folder: " + targetFolderPath);
        }

        // ── RESTORE_AND_RETURN_HEX (destructive-window failure handler) ───
        // Called only AFTER reduceProject has run (the "destructive window"),
        // where the in-memory project is compromised. Best-effort remove the
        // precomp, end the undo group exactly once, reopen originalFile from
        // the on-disk snapshot written by the protective save (suppress-dialogs
        // balanced), and return the encodeBridge-wrapped failure string.
        function RESTORE_AND_RETURN_HEX(origFile, message) {
            try { if (precomp) precomp.remove(); } catch (eR) { }
            try { app.endUndoGroup(); } catch (eR2) { }
            // Task 12.2, Req 2.23: suppression is released by try/finally on
            // EVERY path, so a throw inside app.open can never leave it stuck
            // on for the session. Sequence unchanged (Req 3.1/3.2/3.3):
            // remove precomp, end the undo group once, ONE suppress-balanced
            // reopen, return the encodeBridge-wrapped message.
            var reopenOk = true;
            var suppressed = false;
            try { app.beginSuppressDialogs(); suppressed = true; } catch (eSupB) { }
            try {
                app.open(origFile);
            } catch (eR3) {
                reopenOk = false;
            } finally {
                if (suppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
            }
            if (!reopenOk) {
                return encodeBridge("Error: " + logMsg + " -> " + message +
                    " — automatic restore failed; please reopen your project manually from disk.");
            }
            return encodeBridge("Error: " + logMsg + " -> " + message +
                " — project restored from the protective-save snapshot.");
        }

        app.beginUndoGroup("Save Comp");
        log("begin undo group");

        // ── PROTECTIVE SAVE (abort-on-failure) ────────────────────────────
        // If the protective save fails we abort BEFORE any destructive op:
        // end the undo group once and return. No reduce, no reopen — the live
        // project is 100% intact.
        var protectOk = true;
        try {
            app.project.save(originalFile);
            log("saved original file copy");
        } catch (e) {
            protectOk = false;
            log("original file save failed: " + e.toString());
        }
        if (!protectOk) {
            app.endUndoGroup();
            return encodeBridge("Error: " + logMsg +
                " -> Protective save failed — aborted, your project is untouched.");
        }

        // ── RENAME PRECOMP (before reduce) ────────────────────────────────
        log("renaming precomp to " + name);
        try {
            precomp.name = name;
            log("precomp renamed");
        } catch (e) {
            log("precomp rename failed: " + e.toString());
        }

        // ── CAPTURE EVERY VALUE DERIVED FROM precomp (pre-destructive) ─────
        // app.open(originalFile) below replaces the whole project DOM: reading
        // ANY property of precomp afterwards throws, which used to turn a
        // fully successful save into a reported failure (and triggered a second
        // app.open through the windowEntered branch of the outer catch). Read it
        // all HERE, right after the rename, so renderComp is the name actually
        // written into project.aep. Same pattern as coreSaveLayerType's
        // pre-reopen layerState capture.
        var capName = name;
        var capWidth = 0;
        var capHeight = 0;
        var capPixelAspect = 1;
        var capFrameRate = 0;
        var capDuration = 0;
        var capFrame = 0;
        try { capName = "" + precomp.name; } catch (eCapN) { capName = name; }
        try { capWidth = precomp.width; } catch (eCapW) { }
        try { capHeight = precomp.height; } catch (eCapH) { }
        try { capPixelAspect = precomp.pixelAspect; } catch (eCapP) { }
        try { capFrameRate = precomp.frameRate; } catch (eCapR) { }
        try { capDuration = precomp.duration; } catch (eCapD) { }
        try {
            capFrame = Math.round(
                (precomp.workAreaStart + precomp.workAreaDuration * 0.3) * precomp.frameRate);
        } catch (eCapF) { capFrame = 0; }
        if (!(capFrame >= 0)) capFrame = 0; // NaN-safe floor
        log("captured render target: " + capName + " @frame " + capFrame);

        var targetFilePath = f.fsName.replace(/\\/g, "/") + "/project.aep";
        var targetFile = new File(targetFilePath);

        // ── DESTRUCTIVE WINDOW: reduce first, then the single template save ─
        log("reducing project");
        try {
            app.project.reduceProject([precomp]);
            windowEntered = true;
            log("project reduced");
        } catch (reduceErr) {
            log("project reduce failed: " + reduceErr.toString());
            return RESTORE_AND_RETURN_HEX(originalFile, "Reduce failed: " + reduceErr.toString());
        }

        log("saving target file to: " + targetFilePath);
        try {
            app.project.save(targetFile);
            log("saved target file");
        } catch (saveErr) {
            log("target file save failed: " + saveErr.toString());
            return RESTORE_AND_RETURN_HEX(originalFile, "Template save failed: " + saveErr.toString());
        }

        // ── COLLECT ASSETS (after reduce, before reopen) ──────────────────
        log("collecting assets");
        var assetsList = [];
        var ii;
        for (ii = app.project.numItems; ii >= 1; ii--) {
            try {
                var item = app.project.item(ii);
                if (item instanceof FootageItem && item.file && item.file.exists) {
                    assetsList.push({
                        fsPath: item.file.fsName,
                        name: fsEntryName(item.file) || item.file.name
                    });
                }
            } catch (e) { }
        }
        log("assets collected");

        app.endUndoGroup();

        // ── REOPEN ONCE (suppress-balanced via try/finally) ───────────────
        // Invariant preserved: exactly ONE reopen, and only because the
        // destructive window was entered.
        log("reopening original project: " + originalFile.fsName);
        var reopenOk = true;
        var reopenErr = "";
        var reopenSuppressed = false;
        try { app.beginSuppressDialogs(); reopenSuppressed = true; } catch (eSupB) { }
        try {
            app.open(originalFile);
            log("original project reopened");
        } catch (eReopen) {
            reopenOk = false;
            reopenErr = eReopen.toString();
            log("original project reopen failed: " + reopenErr);
        } finally {
            if (reopenSuppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
        }

        // A FAILED reopen is NOT a success: app.project.save(targetFile) above
        // reassigned app.project.file to the library template, so the user's
        // next Ctrl+S would overwrite the template with their own project. Say
        // so instead of returning ok:true.
        //
        // Reported as a STRUCTURED failure (ok:false) rather than a bare string:
        // both shapes land in the panel's parseEssential error branch — so the
        // loading state still exits exactly once and no background work is
        // scheduled — but ok:false says "this save did not complete" explicitly
        // instead of being inferred from a reply that is neither JSON-with-ok
        // nor the monolithic sentinel, and it carries the paths the user needs
        // in order to recover.
        if (!reopenOk) {
            return encodeBridge(jsonStringify({
                ok: false,
                reopenFailed: true,
                folderPath: targetFolderPath.replace(/\\/g, "/"),
                templateFile: targetFilePath,
                error: "Error: " + logMsg +
                    " -> Template written to " + targetFilePath +
                    ", but reopening your project failed: " + reopenErr +
                    " — After Effects is still pointed at the template's project.aep." +
                    " Do NOT save; reopen your project manually from disk first."
            }));
        }

        log("success");

        var resultObj = {
            ok: true,
            templateId: templateId,
            name: name,
            category: cat,
            // The panel keys its meta.json / assetsDir branches off these two;
            // omitting them silently dropped assetsDir from every comp save.
            section: "comp",
            type: "comp",
            folderPath: targetFolderPath.replace(/\\/g, "/"),
            assetsList: assetsList,
            oldId: oldId,
            needsThumbnail: true,
            // Composition format, captured pre-reopen, so meta.json can record
            // it and no consumer has to open the .aep to learn it.
            width: capWidth,
            height: capHeight,
            pixelAspect: capPixelAspect,
            frameRate: capFrameRate,
            duration: capDuration,
            // Exact comp name inside project.aep + the representative frame for
            // the isolated aerender path — both captured BEFORE the reopen.
            renderComp: capName,
            renderFrame: capFrame
        };
        return encodeBridge(jsonStringify(resultObj));
    } catch (e) {
        log("exception: " + e.toString());
        if (windowEntered && originalFile) {
            // Destructive window was entered: restore from the protective
            // snapshot (remove precomp, end undo once, one suppress-balanced
            // reopen) — mirrors RESTORE_AND_RETURN_HEX inline.
            try { if (precomp) precomp.remove(); } catch (eR) { }
            try { app.endUndoGroup(); } catch (eR2) { }
            // Task 12.2, Req 2.23: suppression released by try/finally on every
            // path. Sequence unchanged (Req 3.1/3.2/3.3).
            var reopenOkOuter = true;
            var suppressedOuter = false;
            try { app.beginSuppressDialogs(); suppressedOuter = true; } catch (eSupB) { }
            try {
                app.open(originalFile);
            } catch (eR3) {
                reopenOkOuter = false;
            } finally {
                if (suppressedOuter) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
            }
            if (!reopenOkOuter) {
                return encodeBridge("Error: " + logMsg +
                    " -> Exception: " + e.toString() +
                    " — automatic restore failed; please reopen your project manually from disk.");
            }
            return encodeBridge("Error: " + logMsg + " -> Exception: " + e.toString());
        }
        // Pre-window failure: live project intact on disk AND in memory.
        // End the undo group once; NO reopen (invariant: reopen only after
        // the destructive window was entered).
        try { if (precomp) precomp.remove(); } catch (eTmp) { }
        try { app.endUndoGroup(); } catch (e5) { }
        return encodeBridge("Error: " + logMsg + " -> Exception: " + e.toString());
    }
}

// =========================================================
// SAVE LAYER
// =========================================================

function hasLayerCustomContent(layer) {
    // 1. Check if it has effects
    try {
        var fxGroup = layer.property("ADBE Effect Parade");
        if (fxGroup && fxGroup.numProperties > 0) return true;
    } catch (e) { }

    // 2. Check if it has any keyframes or expressions recursively
    var hasCustom = false;
    function checkProp(prop) {
        if (hasCustom) return;
        if (prop.propertyType === PropertyType.PROPERTY) {
            if (prop.numKeys > 0) {
                hasCustom = true;
                return;
            }
            if (prop.expressionEnabled && prop.expression !== "") {
                hasCustom = true;
                return;
            }
        } else if (prop.propertyType === PropertyType.INDEXED_GROUP || prop.propertyType === PropertyType.NAMED_GROUP) {
            var p;
            for (p = 1; p <= prop.numProperties; p++) {
                checkProp(prop.property(p));
            }
        }
    }

    try {
        var g;
        for (g = 1; g <= layer.numProperties; g++) {
            checkProp(layer.property(g));
        }
    } catch (e2) { }

    if (hasCustom) return true;

    // 3. Check shape layer contents (shapes drawn)
    if (layer instanceof ShapeLayer) {
        try {
            var contents = layer.property("ADBE Root Vectors Group");
            if (contents && contents.numProperties > 0) return true;
        } catch (e3) { }
    }

    // 4. Check camera options group modified
    if (layer instanceof CameraLayer) {
        try {
            var camOpts = layer.property("ADBE Camera Options Group");
            if (camOpts && camOpts.isModified) return true;
        } catch (e4) { }
    }

    // 5. Check light options group modified
    if (layer instanceof LightLayer) {
        try {
            var lightOpts = layer.property("ADBE Light Options Group");
            if (lightOpts && lightOpts.isModified) return true;
        } catch (e5) { }
    }

    return false;
}

function saveActiveLayer(nHex, cHex, rHex, oldIdHex) {
    try {
        var name = cleanStr(decodeBridge(nHex));
        var cat = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var oldId = "";
        if (oldIdHex) oldId = cleanStr(decodeBridge(oldIdHex));

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return encodeBridge("Open a composition first!");
        var sl = comp.selectedLayers;
        if (!sl || sl.length === 0) return encodeBridge("Please select at least 1 layer.");

        var v;
        // Utility Pre-Comp asset detection: a SINGLE selected pre-comp layer is
        // saved/restored as a complete Composition asset (reference), not flattened.
        // Captured BEFORE coreSaveLayerType runs (it reopens the project and would
        // invalidate these layer references).
        var isPrecompAsset = false;
        var precompName = "";
        if (sl.length === 1 && sl[0] instanceof AVLayer && sl[0].source instanceof CompItem) {
            isPrecompAsset = true;
            try { precompName = sl[0].source.name; } catch (ePN) { precompName = ""; }
        }
        for (v = 0; v < sl.length; v++) {
            var t = classifyLayer(sl[v]);
            // Accept normal building-block layers AND Utility Pre-Comps (a pre-comp
            // layer inserts as a single reusable layer; classifyLayer reports it as
            // "comp", so allow it explicitly here regardless of internal complexity).
            var isUtilityPrecomp = (sl[v] instanceof AVLayer && sl[v].source instanceof CompItem);
            if (t !== "layer" && !isUtilityPrecomp) {
                return encodeBridge("Layer section accepts only Shape/Solid/Null/Camera/Light layers and Utility Pre-Comps.");
            }
        }

        var hasValidContent = false;
        var vi;
        for (vi = 0; vi < sl.length; vi++) {
            // A Utility Pre-Comp is valid content by itself — its layers/animation
            // live inside the nested comp, so it never needs keyframes/effects on
            // the pre-comp layer.
            if ((sl[vi] instanceof AVLayer && sl[vi].source instanceof CompItem) || hasLayerCustomContent(sl[vi])) {
                hasValidContent = true;
                break;
            }
        }
        if (!hasValidContent) {
            return encodeBridge("Cannot save fresh/empty layers without keyframes, effects, or custom properties. Empty layers can be created directly from the Toolkit.");
        }

        var templateId = generateTemplateId(name);
        var safeCat = getSafeName(cat);
        var targetFolderPath = r + "/layer/" + safeCat + "/" + templateId;
        var f = new Folder(targetFolderPath);

        var result = coreSaveLayerType(name, cat, r, "Layer", "blackbg", "layer", templateId);
        if (typeof result === "string") return encodeBridge(result);
        if (!result || !result.ok) return encodeBridge(result ? result.error : "Unknown core save error");

        var resObj = {
            ok: true,
            templateId: templateId,
            name: name,
            category: cat,
            section: "layer",
            type: "layer",
            folderPath: result.folderPath,
            assetsList: result.assetsList,
            oldId: oldId,
            layerCount: result.layerCount,
            isAdjustment: result.isAdjustment,
            is3D: result.is3D,
            blendMode: result.blendMode,
            label: result.label,
            layerState: result.layerState || null
        };
        // Tag Utility Pre-Comp assets so import restores them as a Composition
        // reference (single pre-comp layer), never flattened. Normal layers omit this.
        if (isPrecompAsset) {
            resObj.assetKind = "precomp";
            resObj.precompName = precompName;
        }
        return encodeBridge(jsonStringify(resObj));
    } catch (e) {
        return encodeBridge("Save Error: " + e.toString());
    }
}

// =========================================================
// SAVE TEXT
// =========================================================

function saveActiveText(nHex, cHex, rHex, oldIdHex) {
    try {
        var name = cleanStr(decodeBridge(nHex));
        var cat = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var oldId = "";
        if (oldIdHex) oldId = cleanStr(decodeBridge(oldIdHex));

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return encodeBridge("Open a composition first!");
        var sl = comp.selectedLayers;
        if (!sl || sl.length === 0) return encodeBridge("Please select at least 1 text layer.");

        var hasTextLayer = false;
        var v;
        for (v = 0; v < sl.length; v++) {
            if (isTextLayer(sl[v])) {
                hasTextLayer = true;
                break;
            }
        }
        if (!hasTextLayer) {
            return encodeBridge("Text section requires at least 1 Text layer to be selected.");
        }

        var templateId = generateTemplateId(name);
        var safeCat = getSafeName(cat);
        var targetFolderPath = r + "/text/" + safeCat + "/" + templateId;
        var f = new Folder(targetFolderPath);

        // Generate thumbnail from active comp (like Comp section)
        ensureDeepFolder(targetFolderPath);
        var thumbFile = new File(targetFolderPath + "/thumbnail.png");
        var oldDepthT = null;
        var tempBgT = null;
        try {
            oldDepthT = app.project.bitsPerChannel;
            app.project.bitsPerChannel = 8;
            try { comp.openInViewer(); } catch (eV) { }
            tempBgT = comp.layers.addSolid(comp.bgColor, "__CS_BG__", comp.width, comp.height, 1);
            tempBgT.moveToEnd();
            var thumbTimeT = comp.workAreaStart + comp.workAreaDuration * 0.3;
            try { comp.saveFrameToPng(thumbTimeT, thumbFile); } catch (eT) { }
        } catch (eTh) { } finally {
            try { if (tempBgT) tempBgT.remove(); } catch (eR) { }
            try { if (oldDepthT !== null) app.project.bitsPerChannel = oldDepthT; } catch (eD) { }
            // Restore original selection since adding/removing the temp solid layer clears it
            try {
                for (var i = 0; i < sl.length; i++) {
                    sl[i].selected = true;
                }
            } catch (eSel) { }
        }

        var result = coreSaveLayerType(name, cat, r, "Text", "none", "text", templateId);
        if (typeof result === "string") return encodeBridge(result);
        if (!result || !result.ok) return encodeBridge(result ? result.error : "Unknown core save error");

        var resObj = {
            ok: true,
            templateId: templateId,
            name: name,
            category: cat,
            section: "text",
            type: "text",
            folderPath: result.folderPath,
            assetsList: result.assetsList,
            oldId: oldId,
            layerCount: result.layerCount
        };
        return encodeBridge(jsonStringify(resObj));
    } catch (e) {
        return encodeBridge("Save Error: " + e.toString());
    }
}

function saveActiveTextProperties(nHex, cHex, rHex, oldIdHex) {
    try {
        var name = cleanStr(decodeBridge(nHex));
        var cat = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var oldId = "";
        if (oldIdHex) oldId = cleanStr(decodeBridge(oldIdHex));

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return encodeBridge("Open a composition first!");
        var sl = comp.selectedLayers;
        if (!sl || sl.length !== 1) return encodeBridge("Please select exactly 1 text layer for Text Properties.");
        if (!isTextLayer(sl[0])) return encodeBridge("Text Properties accepts ONLY a Text layer.");

        var templateId = generateTemplateId(name);
        var safeCat = getSafeName(cat);
        var targetFolderPath = r + "/text/" + safeCat + "/" + templateId;
        var f = new Folder(targetFolderPath);

        // Generate thumbnail from active comp (like Comp section)
        ensureDeepFolder(targetFolderPath);
        var thumbFile = new File(targetFolderPath + "/thumbnail.png");
        var oldDepthT = null;
        var tempBgT = null;
        try {
            oldDepthT = app.project.bitsPerChannel;
            app.project.bitsPerChannel = 8;
            try { comp.openInViewer(); } catch (eV) { }
            tempBgT = comp.layers.addSolid(comp.bgColor, "__CS_BG__", comp.width, comp.height, 1);
            tempBgT.moveToEnd();
            var thumbTimeT = comp.workAreaStart + comp.workAreaDuration * 0.3;
            try { comp.saveFrameToPng(thumbTimeT, thumbFile); } catch (eT) { }
        } catch (eTh) { } finally {
            try { if (tempBgT) tempBgT.remove(); } catch (eR) { }
            try { if (oldDepthT !== null) app.project.bitsPerChannel = oldDepthT; } catch (eD) { }
            // Restore original selection since adding/removing the temp solid layer clears it
            try {
                for (var i = 0; i < sl.length; i++) {
                    sl[i].selected = true;
                }
            } catch (eSel) { }
        }

        var result = coreSaveLayerType(name, cat, r, "Text Properties", "none", "text", templateId);
        if (typeof result === "string") return encodeBridge(result);
        if (!result || !result.ok) return encodeBridge(result ? result.error : "Unknown core save error");

        var resObj = {
            ok: true,
            templateId: templateId,
            name: name,
            category: cat,
            section: "text",
            type: "text_props",
            folderPath: result.folderPath,
            assetsList: result.assetsList,
            oldId: oldId,
            layerCount: 1
        };
        return encodeBridge(jsonStringify(resObj));
    } catch (e) {
        return encodeBridge("Save Error: " + e.toString());
    }
}

// =========================================================
// SAVE FOOTAGE
// =========================================================

function saveActiveFootage(nHex, cHex, rHex, oldIdHex) {
    try {
        var name = cleanStr(decodeBridge(nHex));
        var cat = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var oldId = "";
        if (oldIdHex) oldId = cleanStr(decodeBridge(oldIdHex));

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return encodeBridge("Open a composition first!");
        var sl = comp.selectedLayers;
        if (!sl || sl.length === 0) return encodeBridge("Please select at least 1 footage layer.");

        var v;
        for (v = 0; v < sl.length; v++) {
            var t = classifyLayer(sl[v]);
            if (t !== "footage") {
                return encodeBridge("Footage section accepts ONLY video/audio footage layers.");
            }
        }

        var templateId = generateTemplateId(name);
        var safeCat = getSafeName(cat);
        var targetFolderPath = r + "/footage/" + safeCat + "/" + templateId;
        var f = new Folder(targetFolderPath);

        var result = coreSaveLayerType(name, cat, r, "Footage", "frame", "footage", templateId);
        if (typeof result === "string") return encodeBridge(result);
        if (!result || !result.ok) return encodeBridge(result ? result.error : "Unknown core save error");

        var resObj = {
            ok: true,
            templateId: templateId,
            name: name,
            category: cat,
            section: "footage",
            type: "footage",
            folderPath: result.folderPath,
            assetsList: result.assetsList,
            oldId: oldId,
            layerCount: result.layerCount
        };
        return encodeBridge(jsonStringify(resObj));
    } catch (e) {
        return encodeBridge("Save Error: " + e.toString());
    }
}

// =========================================================
// SAVE PNG
// =========================================================

function savePNGOnly(nHex, cHex, rHex, typeHex, oldIdHex) {
    try {
        var name = cleanStr(decodeBridge(nHex));
        var cat = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var itemType = "icon";
        if (typeHex) itemType = cleanStr(decodeBridge(typeHex));
        if (itemType !== "icon" && itemType !== "overlay" && itemType !== "element") itemType = "icon";

        var oldId = "";
        if (oldIdHex) oldId = cleanStr(decodeBridge(oldIdHex));

        var section = (itemType === "overlay" || itemType === "element") ? "overlay" : "icon";
        var templateId = generateTemplateId(name);
        var targetFolderPath = r + "/" + section + "/" + getSafeName(cat) + "/" + templateId;
        var folder = ensureDeepFolder(targetFolderPath);
        // ensureDeepFolder returns null when the tree could not be created (1.7);
        // every later step here dereferences `folder`.
        if (!folder || !folder.exists) {
            return encodeBridge("ERROR:Failed to create folder: " + targetFolderPath);
        }

        var sourceFile = null;
        var sourceWidth = 0;
        var sourceHeight = 0;

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            // Failure convention: "ERROR:" prefix (no space) — the client's
            // parseEssential (templates.js) recognizes failures ONLY via
            // indexOf("ERROR:") === 0 and strips the 6-char prefix; bare
            // strings fall through to JSON.parse and get mis-reported.
            return encodeBridge("ERROR:Open a composition and select an image layer in the timeline.");
        }

        var selLayers = comp.selectedLayers;
        if (!selLayers || selLayers.length === 0) {
            return encodeBridge("ERROR:Select an image layer in the Timeline to save.");
        }

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

        var fileExt = sourceFile.name.substring(sourceFile.name.lastIndexOf("."));
        var destFile = new File(folder.fsName + "/source" + fileExt.toLowerCase());
        // File.copy returns false on failure (does not throw). Never write
        // meta.json or report success when the source image copy failed (Bug H6b).
        if (!sourceFile.copy(destFile)) {
            return encodeBridge("ERROR:Could not copy source image to " + destFile.fsName);
        }

        var thumbFile = new File(folder.fsName + "/thumbnail.png");
        if (!sourceFile.copy(thumbFile)) {
            return encodeBridge("ERROR:Could not copy thumbnail to " + thumbFile.fsName);
        }

        var dimStr = "";
        if (sourceWidth > 0 && sourceHeight > 0) dimStr = sourceWidth + "x" + sourceHeight;

        // Capture the layer's timeline transform so imports can restore the
        // original visual size (fixes auto-fit-to-comp scaling bug).
        var layerTransform = null;
        try {
            var selLayer = selLayers[si]; // si still points to the matched layer
            if (selLayer) {
                var xfGroup = selLayer.property("ADBE Transform Group");
                if (xfGroup) {
                    var scaleP = xfGroup.property("ADBE Scale");
                    var posP = xfGroup.property("ADBE Position");
                    layerTransform = {};
                    if (scaleP) {
                        var sv = scaleP.value;
                        layerTransform.scale = (sv && sv.length >= 2) ? [sv[0], sv[1]] : [100, 100];
                    }
                    if (posP) {
                        var pv = posP.value;
                        layerTransform.position = (pv && pv.length >= 2) ? [pv[0], pv[1]] : [0, 0];
                    }
                    layerTransform.savedCompWidth = comp.width;
                    layerTransform.savedCompHeight = comp.height;
                }
            }
        } catch (eLt) { layerTransform = null; }

        var meta = new File(folder.fsName + "/meta.json");
        meta.open("w");
        var now = getISOString();
        var metaObj = {
            schemaVersion: 2,
            id: templateId,
            name: name,
            section: section,
            type: section,
            category: cat,
            mainFile: "source" + fileExt.toLowerCase(),
            thumbnail: "thumbnail.png",
            dim: dimStr,
            hasFrames: false,
            frameCount: 0,
            createdAt: now,
            updatedAt: now
        };
        if (layerTransform) metaObj.layerTransform = layerTransform;
        meta.write(jsonStringify(metaObj));
        meta.close();

        if (oldId) {
            finalizeSave(r, cat, section, templateId, oldId);
        }

        return encodeBridge("true");
    } catch (e) {
        return encodeBridge("ERROR:Save failed - " + e.toString());
    }
}

// =========================================================
// EFFECT SERIALIZATION
// =========================================================

function serializePropertyValue(val) {
    try {
        if (val === null || val === undefined) return "null";
        if (typeof val === "number") {
            if (isNaN(val) || !isFinite(val)) return "0";
            return "" + val;
        }
        if (typeof val === "boolean") return val ? "true" : "false";
        if (typeof val === "string") return '"' + escapeJSON(val) + '"';
        if (val instanceof Array) {
            var parts = [];
            var i;
            for (i = 0; i < val.length; i++) {
                parts.push(serializePropertyValue(val[i]));
            }
            return "[" + parts.join(",") + "]";
        }
        return "null";
    } catch (e) {
        return "null";
    }
}

function serializeKeyframes(prop) {
    var kfs = [];
    try {
        if (!prop.numKeys || prop.numKeys === 0) return kfs;
        var k;
        for (k = 1; k <= prop.numKeys; k++) {
            try {
                var kfData = {
                    time: prop.keyTime(k),
                    value: prop.keyValue(k),
                    inInterp: prop.keyInInterpolationType(k),
                    outInterp: prop.keyOutInterpolationType(k)
                };
                try { kfData.inEase = prop.keyInTemporalEase(k); } catch (eEi) { }
                try { kfData.outEase = prop.keyOutTemporalEase(k); } catch (eEo) { }
                kfs.push(kfData);
            } catch (eKf) { }
        }
    } catch (e) { }
    return kfs;
}

function serializeKeyframeJson(kf) {
    var s = '{"time":' + kf.time;
    s += ',"value":' + serializePropertyValue(kf.value);
    s += ',"inInterp":' + kf.inInterp;
    s += ',"outInterp":' + kf.outInterp;
    if (kf.inEase) {
        var ie = [];
        var i;
        for (i = 0; i < kf.inEase.length; i++) {
            ie.push('{"speed":' + kf.inEase[i].speed + ',"influence":' + kf.inEase[i].influence + '}');
        }
        s += ',"inEase":[' + ie.join(",") + ']';
    }
    if (kf.outEase) {
        var oe = [];
        var j;
        for (j = 0; j < kf.outEase.length; j++) {
            oe.push('{"speed":' + kf.outEase[j].speed + ',"influence":' + kf.outEase[j].influence + '}');
        }
        s += ',"outEase":[' + oe.join(",") + ']';
    }
    s += '}';
    return s;
}

function serializeProperty(prop) {
    try {
        if (!prop) return null;

        var data = {
            name: prop.name,
            matchName: prop.matchName,
            type: "",
            value: null,
            keyframes: [],
            expression: "",
            children: []
        };

        if (prop.propertyType === PropertyType.PROPERTY) {
            data.type = "property";
            try { data.value = prop.value; } catch (eV) { }
            try {
                if (prop.canSetExpression && prop.expression && prop.expression.length > 0) {
                    data.expression = prop.expression;
                }
            } catch (eE) { }
            try {
                if (prop.numKeys > 0) {
                    data.keyframes = serializeKeyframes(prop);
                }
            } catch (eK) { }
            return data;
        }

        if (prop.propertyType === PropertyType.INDEXED_GROUP || prop.propertyType === PropertyType.NAMED_GROUP) {
            data.type = "group";
            try {
                var n = prop.numProperties;
                var i;
                for (i = 1; i <= n; i++) {
                    try {
                        var child = serializeProperty(prop.property(i));
                        if (child) data.children.push(child);
                    } catch (eC) { }
                }
            } catch (eG) { }
            return data;
        }

        return null;
    } catch (e) {
        return null;
    }
}

function serializePropertyToJson(propData) {
    if (!propData) return "null";
    var s = '{';
    s += '"name":"' + escapeJSON(propData.name) + '"';
    s += ',"matchName":"' + escapeJSON(propData.matchName) + '"';
    s += ',"type":"' + escapeJSON(propData.type) + '"';

    if (propData.type === "property") {
        s += ',"value":' + serializePropertyValue(propData.value);
        s += ',"expression":"' + escapeJSON(propData.expression || "") + '"';
        if (propData.keyframes && propData.keyframes.length > 0) {
            var kfs = [];
            var k;
            for (k = 0; k < propData.keyframes.length; k++) {
                kfs.push(serializeKeyframeJson(propData.keyframes[k]));
            }
            s += ',"keyframes":[' + kfs.join(",") + ']';
        } else {
            s += ',"keyframes":[]';
        }
    } else if (propData.type === "group") {
        if (propData.children && propData.children.length > 0) {
            var cs = [];
            var c;
            for (c = 0; c < propData.children.length; c++) {
                cs.push(serializePropertyToJson(propData.children[c]));
            }
            s += ',"children":[' + cs.join(",") + ']';
        } else {
            s += ',"children":[]';
        }
    }
    s += '}';
    return s;
}

function serializeEffect(effect) {
    try {
        if (!effect) return null;
        var data = {
            name: effect.name,
            matchName: effect.matchName,
            enabled: true,
            properties: []
        };
        try { data.enabled = effect.enabled; } catch (eEn) { }

        var n = effect.numProperties;
        var i;
        for (i = 1; i <= n; i++) {
            try {
                var prop = effect.property(i);
                var propData = serializeProperty(prop);
                if (propData) data.properties.push(propData);
            } catch (eP) { }
        }
        return data;
    } catch (e) {
        return null;
    }
}

function serializeEffectToJson(effData) {
    if (!effData) return "null";
    var s = '{';
    s += '"name":"' + escapeJSON(effData.name) + '"';
    s += ',"matchName":"' + escapeJSON(effData.matchName) + '"';
    s += ',"enabled":' + (effData.enabled ? "true" : "false");
    var props = [];
    var i;
    for (i = 0; i < effData.properties.length; i++) {
        props.push(serializePropertyToJson(effData.properties[i]));
    }
    s += ',"properties":[' + props.join(",") + ']';
    s += '}';
    return s;
}

// =========================================================
// EFFECT DESERIALIZATION
// =========================================================

// Applies keyframes to a property, routing visibility through the Property_Helper
// and verifying the resulting keyframe count with one retry (Req 1.6, 2.1, 7.1, 7.4).
// Returns an internal apply-result object:
//   { success:Boolean, appliedCount:Number, resultingCount:Number, retried:Boolean, error?:String }
function applyKeyframesToProperty(prop, keyframes) {
    var result = { success: false, appliedCount: 0, resultingCount: 0, retried: false };

    // Guard: no target or no keyframes is a no-op success (nothing to verify).
    if (!prop || !keyframes || keyframes.length === 0) {
        result.success = true;
        return result;
    }

    var appliedCount = keyframes.length;
    result.appliedCount = appliedCount;

    // Req 1.6 / 2.1: ensure the property (and its whole parent chain) is
    // visible/editable BEFORE writing any keys, so writes are not rejected on
    // hidden/collapsed props.
    try { ensurePropertyVisible(prop); } catch (eVis0) { }

    // Inner apply: clears existing keys then writes all keyframes with their
    // per-key interpolation/ease. The rich keyframe/ease/interp handling is kept
    // intact (setPropertyValueSafe is only for scalar value writes, not for these).
    function doApplyKeys() {
        try {
            var comp = resolveActiveComp();
            var baseTime = (comp && comp instanceof CompItem) ? comp.time : 0;

            // Find minimum time in keyframes to use as relative zero
            var minTime = keyframes[0].time;
            var k;
            for (k = 1; k < keyframes.length; k++) {
                if (keyframes[k].time < minTime) {
                    minTime = keyframes[k].time;
                }
            }

            try {
                while (prop.numKeys > 0) {
                    prop.removeKey(1);
                }
            } catch (eClr) { }

            for (k = 0; k < keyframes.length; k++) {
                try {
                    var kf = keyframes[k];
                    var targetTime = kf.time - minTime + baseTime;
                    var idx = prop.addKey(targetTime);
                    try { prop.setValueAtKey(idx, kf.value); } catch (eSv) { }
                    try {
                        if (typeof kf.inInterp !== "undefined" && typeof kf.outInterp !== "undefined") {
                            prop.setInterpolationTypeAtKey(idx, kf.inInterp, kf.outInterp);
                        }
                    } catch (eIn) { }
                    try {
                        if (kf.inEase && kf.outEase) {
                            var inE = [];
                            var ie;
                            for (ie = 0; ie < kf.inEase.length; ie++) {
                                inE.push(new KeyframeEase(kf.inEase[ie].speed, kf.inEase[ie].influence));
                            }
                            var outE = [];
                            var oe;
                            for (oe = 0; oe < kf.outEase.length; oe++) {
                                outE.push(new KeyframeEase(kf.outEase[oe].speed, kf.outEase[oe].influence));
                            }
                            prop.setTemporalEaseAtKey(idx, inE, outE);
                        }
                    } catch (eEs) { }
                } catch (eAdd) { }
            }
        } catch (e) {
            result.error = e.toString();
        }
    }

    // First attempt.
    doApplyKeys();
    var count = 0;
    try { count = prop.numKeys; } catch (eN) { count = 0; }
    result.resultingCount = count;

    // Req 7.1 / 7.4: verify the resulting key count equals the applied count;
    // retry the apply exactly once on mismatch.
    if (count !== appliedCount) {
        result.retried = true;
        try { ensurePropertyVisible(prop); } catch (eVis1) { }
        doApplyKeys();
        try { count = prop.numKeys; } catch (eN2) { count = 0; }
        result.resultingCount = count;
    }

    result.success = (result.resultingCount === appliedCount);
    if (!result.success && !result.error) {
        result.error = "Keyframe count mismatch: expected " + appliedCount + ", got " + result.resultingCount;
    }
    return result;
}

// Applies serialized property data onto a target property. Scalar value writes go
// through the Property_Helper (ensurePropertyVisible + setPropertyValueSafe) and
// expression writes are made visible first (Req 1.6, 2.1). Returns an aggregate
// internal result object: { success:Boolean, error?:String } - success is true when
// it completed without a fatal error and no child write reported failure.
function applyPropertyData(targetProp, propData) {
    var result = { success: false };
    if (!targetProp || !propData) {
        result.error = "Missing target property or data";
        return result;
    }
    try {
        if (propData.type === "property") {
            if (!propData.keyframes || propData.keyframes.length === 0) {
                if (propData.value !== null && propData.value !== undefined) {
                    // Req 1.6 / 2.1: visible-first, then a safe scalar value write
                    // (no-keyframes branch) via the Property_Helper.
                    try { ensurePropertyVisible(targetProp); } catch (eVis) { }
                    var setRes = setPropertyValueSafe(targetProp, resolveActiveComp(), null, propData.value);
                    if (setRes && setRes.success === false && !result.error) {
                        result.error = setRes.error || "Value write failed";
                    }
                }
            } else {
                var kfRes = applyKeyframesToProperty(targetProp, propData.keyframes);
                if (kfRes && kfRes.success === false && !result.error) {
                    result.error = kfRes.error || "Keyframe apply failed";
                }
            }
            try {
                if (propData.expression && propData.expression.length > 0 && targetProp.canSetExpression) {
                    // Req 1.6: ensure the property is visible before writing an expression.
                    try { ensurePropertyVisible(targetProp); } catch (eVis2) { }
                    targetProp.expression = propData.expression;
                }
            } catch (eEx) { }
        } else if (propData.type === "group") {
            if (propData.children && propData.children.length > 0) {
                var c;
                for (c = 0; c < propData.children.length; c++) {
                    var childData = propData.children[c];
                    var childProp = null;
                    try { childProp = targetProp.property(childData.matchName); } catch (e1) { }
                    if (!childProp) {
                        try { childProp = targetProp.property(childData.name); } catch (e2) { }
                    }
                    if (childProp) {
                        var childRes = applyPropertyData(childProp, childData);
                        if (childRes && childRes.success === false && !result.error) {
                            result.error = childRes.error || "Child write failed";
                        }
                    }
                }
            }
        }
        // Completed without a fatal (thrown) error.
        result.success = !result.error;
        return result;
    } catch (e) {
        result.error = e.toString();
        result.success = false;
        return result;
    }
}

// Adds an effect to a layer and populates its properties (writes flow through
// applyPropertyData / the Property_Helper). After adding, verifies the effect is
// present in the layer's effect parade, retrying once on failure (Req 7.2, 7.4).
// Returns an internal result object:
//   { success:Boolean, effect:Object|null, present:Boolean, retried:Boolean, error?:String }
function applyEffectData(layer, effData) {
    var result = { success: false, effect: null, present: false, retried: false };
    if (!layer || !effData) {
        result.error = "Missing layer or effect data";
        return result;
    }
    try {
        var fxGroup = layer.property("ADBE Effect Parade");
        if (!fxGroup) {
            result.error = "No effect parade on layer";
            return result;
        }

        // Inner: create the effect and populate its properties. Effect-creation
        // logic is preserved from the original; property writes delegate to
        // applyPropertyData (which routes through the Property_Helper).
        function doAddEffect() {
            var eff = null;
            try {
                eff = fxGroup.addProperty(effData.matchName);
            } catch (eAdd) {
                try {
                    eff = fxGroup.addProperty(effData.name);
                } catch (eAdd2) {
                    return null;
                }
            }

            if (!eff) return null;

            try {
                if (typeof effData.enabled !== "undefined") eff.enabled = effData.enabled;
            } catch (eEn) { }

            var i;
            for (i = 0; i < effData.properties.length; i++) {
                var propData = effData.properties[i];
                var targetProp = null;
                try { targetProp = eff.property(propData.matchName); } catch (e1) { }
                if (!targetProp) {
                    try { targetProp = eff.property(propData.name); } catch (e2) { }
                }
                if (targetProp) {
                    applyPropertyData(targetProp, propData);
                }
            }

            return eff;
        }

        // Req 7.2: verify the effect is present in the layer's effect parade.
        function effectPresent(eff) {
            if (!eff) return false;
            // Identity match against the parade members, when available.
            try {
                var n = fxGroup.numProperties;
                var j;
                for (j = 1; j <= n; j++) {
                    try {
                        if (fxGroup.property(j) === eff) return true;
                    } catch (ePj) { }
                }
            } catch (eNp) { }
            // Fallback: a live effect object exposes an accessible name; a removed
            // or invalid effect throws on access.
            try {
                var nm = eff.name;
                if (nm !== null && nm !== undefined) return true;
            } catch (eNm) { }
            return false;
        }

        // First attempt.
        var newEffect = doAddEffect();
        var present = effectPresent(newEffect);

        // Req 7.2 / 7.4: if the effect is not present, retry exactly once.
        if (!present) {
            result.retried = true;
            newEffect = doAddEffect();
            present = effectPresent(newEffect);
        }

        result.effect = newEffect;
        result.present = present;
        result.success = present;
        if (!present) {
            result.error = "Effect not present after apply: " + (effData.name || effData.matchName || "unknown");
        }
        return result;
    } catch (e) {
        result.error = e.toString();
        result.success = false;
        return result;
    }
}

// =========================================================
// SAVE EFFECT
// =========================================================

function saveActiveEffect(nHex, cHex, rHex, oldIdHex) {
    try {
        var name = cleanStr(decodeBridge(nHex));
        var cat = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        var oldId = "";
        if (oldIdHex) oldId = cleanStr(decodeBridge(oldIdHex));

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return encodeBridge("Open a composition first!");
        var sl = comp.selectedLayers;
        if (!sl || sl.length === 0) return encodeBridge("Please select 1 layer with effects.");
        if (sl.length > 1) return encodeBridge("Effect save supports only 1 layer at a time.");

        var layer = sl[0];

        var fxInfo = detectEffectsOnSelection();
        if (fxInfo.mode === "none" || fxInfo.effects.length === 0) {
            return encodeBridge("Selected layer has no effects to save.");
        }

        var effDataObjects = [];
        var serialized = [];
        var effectNamesArr = [];
        var i;
        for (i = 0; i < fxInfo.effects.length; i++) {
            try {
                var effData = serializeEffect(fxInfo.effects[i]);
                if (effData) {
                    effDataObjects.push(effData);
                    serialized.push(serializeEffectToJson(effData));
                    effectNamesArr.push(escapeJSON(effData.name));
                }
            } catch (eS) { }
        }

        if (serialized.length === 0) {
            return encodeBridge("Could not serialize any effects.");
        }

        var templateId = generateTemplateId(name);
        var safeCat = getSafeName(cat);
        var targetFolderPath = r + "/effect/" + safeCat + "/" + templateId;
        var f = ensureDeepFolder(targetFolderPath);
        // ensureDeepFolder returns null when the tree could not be created (1.7).
        // Checked BEFORE app.beginUndoGroup so there is no group to leak.
        if (!f || !f.exists) {
            return encodeBridge("Failed to create folder: " + targetFolderPath);
        }

        app.beginUndoGroup("Save Effect Preset");

        var thumbFile = new File(f.fsName.replace(/\\/g, "/") + "/thumbnail.png");
        generateBlackBgThumbnail(comp, [layer], thumbFile, r, "effect", effDataObjects);

        var effectJsonFile = new File(f.fsName.replace(/\\/g, "/") + "/project.aep");
        var fullJson = '{"version":1,"effects":[' + serialized.join(",") + ']}';

        try {
            effectJsonFile.encoding = "UTF-8";
            effectJsonFile.open("w");
            effectJsonFile.write(fullJson);
            effectJsonFile.close();
        } catch (eW) {
            try { effectJsonFile.close(); } catch (eC) { }
            app.endUndoGroup();
            return encodeBridge("Effect file write failed: " + eW.toString());
        }

        if (!effectJsonFile.exists) {
            app.endUndoGroup();
            return encodeBridge("Effect file was not created.");
        }

        // ── SAVE PREVIEW.AEP FOR RENDERER (auxiliary, non-essential) ────────
        // The essential effect save (project.aep JSON above) is already on
        // disk, so nothing below can fail the essential result. The preview
        // input is produced with the canonical destructive sequence —
        // protective save -> temp comp -> reduceProject -> ONE write to
        // preview.aep -> endUndoGroup -> exactly one reopen — replacing the
        // previous save-before-reduce order whose trailing bare save() could
        // overwrite the user's project file with the reduced project.
        var originalFile = app.project.file;
        if (originalFile) {
            app.beginUndoGroup("Save Effect Preview");
            try {
                // Protective full-project write (the only live-project write).
                app.project.save(originalFile);

                var tempCompPv = app.project.items.addComp(name + " [Effect Temp]", 1080, 1080, comp.pixelAspect, comp.duration, comp.frameRate);
                if (!tempCompPv) throw "temp comp create failed";
                try {
                    tempCompPv.workAreaStart = comp.workAreaStart;
                    tempCompPv.workAreaDuration = comp.workAreaDuration;
                } catch (eWA) { }

                if (effDataObjects && effDataObjects.length > 0) {
                    var adjLayer = tempCompPv.layers.addSolid([1, 1, 1], "Adjustment Layer", 1080, 1080, 1);
                    adjLayer.adjustmentLayer = true;
                    for (var ej = 0; ej < effDataObjects.length; ej++) {
                        applyEffectData(adjLayer, effDataObjects[ej]);
                    }
                } else {
                    copySelectedLayersToTempComp(comp, [layer], tempCompPv);
                    try { tempCompPv.layer(1).adjustmentLayer = true; } catch (eAL) { }
                }

                var targetPreviewFile = new File(f.fsName.replace(/\\/g, "/") + "/preview.aep");
                if (targetPreviewFile.exists) {
                    try { targetPreviewFile.remove(); } catch (eRM) { }
                }

                // Destructive window: reduce FIRST, then the single write.
                app.project.reduceProject([tempCompPv]);
                app.project.save(targetPreviewFile);
            } catch (ePrev) {
                // Auxiliary failure: log only — the essential result still
                // returns ok, and restoration below always runs.
                try { $.writeln("[CompSaver] effect preview.aep failed: " + ePrev); } catch (eWL) { }
            } finally {
                // The window may have been entered: end the group once, then
                // the single suppress-balanced reopen restores the live
                // project from the protective snapshot.
                try { app.endUndoGroup(); } catch (eUG) { }
                app.beginSuppressDialogs();
                try { app.open(originalFile); } catch (eRS) { }
                app.endSuppressDialogs(false);
            }
        }
        // ───────────────────────────────────────────────────────────────────────

        var resObj = {
            ok: true,
            templateId: templateId,
            name: name,
            category: cat,
            section: "effect",
            type: "effect",
            folderPath: targetFolderPath.replace(/\\/g, "/"),
            assetsList: [],
            oldId: oldId,
            effectCount: fxInfo.effects.length,
            effectNames: effectNamesArr,
            saveMode: fxInfo.mode,
            // preview.aep's temp comp name (see the preview block above) +
            // frame 0 for the isolated aerender thumbnail path.
            renderComp: name + " [Effect Temp]",
            renderFrame: 0
        };

        app.endUndoGroup();
        return encodeBridge(jsonStringify(resObj));
    } catch (e) {
        try { app.endUndoGroup(); } catch (eU) { }
        return encodeBridge("Save Error: " + e.toString());
    }
}

// =========================================================
// IMPORT EFFECT
// =========================================================

function importEffect(idHex, cHex, rHex) {
    try {
        var id = cleanStr(decodeBridge(idHex));
        var c = cleanStr(decodeBridge(cHex));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

        var resolvedFiles = resolveTemplateFiles(r, c, id);
        if (!resolvedFiles) return encodeBridge("Effect folder not found!");

        var effectFile = resolvedFiles.mainFile;
        if (!effectFile || !effectFile.exists) {
            return encodeBridge("No effect data file found! This template may have been saved with an older version.");
        }

        var jsonContent = readFileText(effectFile);
        if (!jsonContent) return encodeBridge("Effect file is empty!");

        var effectData = null;
        try {
            // Security (Phase 1): strict parser instead of eval — effect
            // files come from the shared library and must never execute as
            // code. They are written by serializeEffectToJson (strict JSON),
            // so a strict parse preserves every success path; anything else
            // is reported corrupted exactly as the eval catch did.
            effectData = jsonParse(jsonContent);
        } catch (eP) {
            return encodeBridge("Effect file is corrupted: " + eP.toString());
        }

        if (!effectData || !effectData.effects || effectData.effects.length === 0) {
            return encodeBridge("No effects in file!");
        }

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return encodeBridge("Open a composition first!");

        var sl = comp.selectedLayers;
        if (!sl || sl.length === 0) return encodeBridge("Please select a layer to apply the effect.");

        // Guarded so a single undo group covers the whole action; while an
        // importBatch is active (Task 8.1) this is a no-op and the batch owns
        // the one group. csBegin/csEndUndoGroup are defined in import.jsx.
        csBeginUndoGroup("Apply Effect Preset");

        var totalApplied = 0;
        var li;
        for (li = 0; li < sl.length; li++) {
            var targetLayer = sl[li];
            var ei;
            for (ei = 0; ei < effectData.effects.length; ei++) {
                try {
                    var applied = applyEffectData(targetLayer, effectData.effects[ei]);
                    if (applied) totalApplied = totalApplied + 1;
                } catch (eA) { }
            }
        }

        csEndUndoGroup();

        if (totalApplied === 0) {
            return encodeBridge("Could not apply any effect. The effect may not be available in this AE version or requires a missing plugin.");
        }

        return encodeBridge("true");
    } catch (e) {
        try { csEndUndoGroup(); } catch (ee) { }
        return encodeBridge("Apply Error: " + e.toString());
    }
}

