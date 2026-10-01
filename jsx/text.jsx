// ============================================================
// text.jsx - text animation module + preview render pipeline (incl layer-bg compositing)
// (ExtendScript module - included by compSaver.jsx; functions are global)
// ============================================================

// Dev-only switch: when true, a debugScan_<timestamp>.txt trace is written
// next to the rendered preset. Must stay false in production.
var CS_DEBUG_SCAN = false;

// =========================================================
// TEXT ANIMATION MODULE (Toolkit > Text 'T' tab)
// Native .ffx text-animation save / apply / management.
// Fully isolated from the Effects pipeline.
// =========================================================

/**
 * Ensures the isolated text-animation directory exists.
 * Argument: hex-encoded absolute directory path.
 * Returns encoded JSON: { ok: bool, path: string, error: string }
 */
function taEnsureTextDir(pathHex) {
    try {
        var dir = decodeBridge(pathHex || "");
        if (!dir) return encodeBridge('{"ok":false,"error":"No directory specified"}');
        var f = ensureDeepFolder(dir);
        if (!f || !f.exists) return encodeBridge('{"ok":false,"error":"Could not create text directory"}');
        return encodeBridge('{"ok":true,"path":"' + escapeJSON(f.fsName.replace(/\\/g, "/")) + '"}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Permanently deletes a text animation preset and all associated files
 * (.ffx, .preview.apng, .preview.webp, .thumb.png, .json metadata, debug traces).
 * If the parent category folder is left empty (and is not the root text directory),
 * it also safely removes the empty directory.
 *
 * Argument: pathHex - hex-encoded absolute path to the .ffx file.
 * Returns encoded JSON: { ok: bool, deletedCount: number, error: string }
 */
function taDeleteTextPreset(pathHex) {
    try {
        var presetPath = decodeBridge(pathHex || "");
        if (!presetPath) return encodeBridge('{"ok":false,"error":"No preset path specified"}');

        var ffxFile = new File(presetPath.replace(/\\/g, "/"));
        var parentFolder = ffxFile.parent;
        var deletedCount = 0;

        // Base name without .ffx
        var baseName = ffxFile.name.replace(/\.ffx$/i, "");
        var parentPath = parentFolder.fsName.replace(/\\/g, "/");

        // List of sibling extensions to delete
        var siblingExts = [
            ".ffx",
            ".preview.apng",
            ".preview.webp",
            ".thumb.png",
            ".json"
        ];

        for (var s = 0; s < siblingExts.length; s++) {
            try {
                var sibFile = new File(parentPath + "/" + baseName + siblingExts[s]);
                if (sibFile.exists) {
                    if (sibFile.remove()) {
                        deletedCount++;
                    }
                }
            } catch (eSib) { }
        }

        // Also check if the ffx file itself still exists (in case it wasn't matched above)
        if (ffxFile.exists) {
            try {
                if (ffxFile.remove()) deletedCount++;
            } catch (eFfx) { }
        }

        // Clean up any debugScan or orphan temp files in the parent folder
        try {
            if (parentFolder.exists) {
                var files = parentFolder.getFiles("debugScan_*.txt");
                if (files) {
                    for (var d = 0; d < files.length; d++) {
                        try { files[d].remove(); } catch (eD) { }
                    }
                }
            }
        } catch (eTraces) { }

        // Clean up empty category directory if empty (except root text directories)
        try {
            if (parentFolder.exists) {
                var remaining = parentFolder.getFiles();
                if (!remaining || remaining.length === 0) {
                    var pName = parentFolder.name.toLowerCase();
                    if (pName !== "text_animations" && pName !== "user_text") {
                        parentFolder.remove();
                    }
                }
            }
        } catch (eDir) { }

        return encodeBridge('{"ok":true,"deletedCount":' + deletedCount + '}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Infallible check for TextLayer in ExtendScript without relying on `instanceof TextLayer`.
 * In AE ExtendScript, selectedLayers returns generic AVLayer objects whose prototype
 * chain may not match `instanceof TextLayer`. matchName and property inspection provide
 * a 100% reliable determination across all AE versions.
 */
function isTextLayer(layer) {
    if (!layer) return false;
    try {
        if (layer.matchName === "ADBE Text Layer") return true;
        if (typeof TextLayer !== "undefined" && layer instanceof TextLayer) return true;
        if (layer.property && layer.property("ADBE Text Properties") !== null) return true;
    } catch (e) { }
    return false;
}

/**
 * Pre-validates that the selection is a single Text Layer ready to be saved
 * as an animation preset. Run BEFORE invoking the native Save dialog so we
 * fail fast with a clear toast instead of letting AE pop an error.
 *
 * Returns encoded JSON: { ok, layerName, hasKeys, error }
 */
function taValidateTextSelection() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length !== 1) {
            return encodeBridge('{"ok":false,"error":"Select exactly ONE text layer"}');
        }
        var layer = sel[0];
        if (!isTextLayer(layer)) {
            return encodeBridge('{"ok":false,"error":"Selected layer is not a Text Layer"}');
        }
        // Sanity-check that something is actually animated or custom-configured.
        // Checks: Text Animators, Effects (Slider Controls), or animated Transform properties.
        var hasKeys = false;
        try {
            var animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
            if (animators && animators.numProperties > 0) hasKeys = true;
        } catch (eAnim) { }
        try {
            var fx = layer.property("ADBE Effect Parade");
            if (fx && fx.numProperties > 0) hasKeys = true;
        } catch (eFx) { }
        try {
            var xform = layer.property("ADBE Transform Group");
            if (xform) {
                for (var x = 1; x <= xform.numProperties; x++) {
                    var xp = xform.property(x);
                    if (xp && (xp.numKeys > 0 || (xp.canSetExpression && xp.expressionEnabled && xp.expression && xp.expression.length > 0))) {
                        hasKeys = true;
                        break;
                    }
                }
            }
        } catch (eXf) { }

        return encodeBridge('{"ok":true,"layerName":"' + escapeJSON(layer.name) +
            '","hasKeys":' + (hasKeys ? "true" : "false") + '}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Inspects the currently-selected text layer and produces a smart, human-
 * friendly default name for the Save dialog. Walks every animator inside
 * "ADBE Text Animators", maps known animator-property matchNames to friendly
 * labels (Opacity→Fade In, Blur→Blur In, Position→Slide In, Scale→Pop In,
 * Tracking→Tracking In, Skew→Skew In, Rotation→Rotate In, Character Value/
 * Offset→Decoder, Fill/Stroke Color→Color Shift). Detects typewriter signature
 * (character-based Range Selector + animated Start/Offset percentage). Also
 * scans layer effects for Blur/Glow/Drop Shadow.
 *
 * Combines: 1 label → bare; 2 → "A and B"; 3+ → "A, B and C".
 * Fallback: layer name (if not generic "Text"/"Empty Text Layer") else
 * "Text Animation".
 *
 * Returns encoded JSON: { ok, name, debug, error }
 */
function taDetectAnimationName() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"name":"Text Animation","error":"No active comp"}');
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length !== 1) {
            return encodeBridge('{"ok":false,"name":"Text Animation"}');
        }
        var layer = sel[0];
        if (!isTextLayer(layer)) {
            return encodeBridge('{"ok":false,"name":"Text Animation"}');
        }

        var labels = [];
        var seen = {};
        function add(label) {
            if (!label || seen[label]) return;
            seen[label] = true;
            labels.push(label);
        }
        function unadd(label) {
            if (!seen[label]) return;
            delete seen[label];
            for (var li = labels.length - 1; li >= 0; li--) {
                if (labels[li] === label) labels.splice(li, 1);
            }
        }

        // Animator-property matchName → friendly label.
        var propMap = {
            "ADBE Text Opacity": "Fade In",
            "ADBE Text Tracking Amount": "Tracking In",
            "ADBE Text Blur": "Blur In",
            "ADBE Text Position 3D": "Slide In",
            "ADBE Text Position": "Slide In",
            "ADBE Text Scale 3D": "Pop In",
            "ADBE Text Scale": "Pop In",
            "ADBE Text Skew": "Skew In",
            "ADBE Text Rotation": "Rotate In",
            "ADBE Text Rotation X": "Rotate In",
            "ADBE Text Rotation Y": "Rotate In",
            "ADBE Text Rotation Z": "Rotate In",
            "ADBE Text Fill Color": "Color Shift",
            "ADBE Text Stroke Color": "Color Shift",
            "ADBE Text Character Value": "Decoder",
            "ADBE Text Character Offset": "Decoder",
            "ADBE Text Anchor Point 3D": "Anchor Shift",
            "ADBE Text Anchor Point": "Anchor Shift",
            "ADBE Text Line Anchor": "Anchor Shift"
        };

        var hasCharacterReveal = false;
        try {
            var animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
            if (animators && animators.numProperties > 0) {
                for (var a = 1; a <= animators.numProperties; a++) {
                    var animator = animators.property(a);
                    if (!animator) continue;

                    // Animated properties on this animator.
                    var animProps = null;
                    try { animProps = animator.property("ADBE Text Animator Properties"); } catch (eAP) { }
                    if (animProps && animProps.numProperties > 0) {
                        for (var ap = 1; ap <= animProps.numProperties; ap++) {
                            var p = animProps.property(ap);
                            if (p && propMap[p.matchName]) add(propMap[p.matchName]);
                        }
                    }

                    // Range selector(s) → detect typewriter reveal.
                    var selectors = null;
                    try { selectors = animator.property("ADBE Text Selectors"); } catch (eSel) { }
                    if (selectors && selectors.numProperties > 0) {
                        for (var s = 1; s <= selectors.numProperties; s++) {
                            var selr = selectors.property(s);
                            if (!selr) continue;
                            // "Based On" = 1 → Characters (typewriter-style unit).
                            try {
                                var rangeAdv = selr.property("ADBE Text Range Advanced");
                                if (rangeAdv) {
                                    var basedOn = rangeAdv.property("ADBE Text Range Type 2");
                                    if (basedOn && basedOn.value === 1) hasCharacterReveal = true;
                                }
                            } catch (eR) { }
                            // Start% animated 0→100 is the classic reveal driver.
                            try {
                                var startP = selr.property("ADBE Text Percent Start");
                                if (startP && startP.numKeys >= 2) hasCharacterReveal = true;
                            } catch (eSS) { }
                            try {
                                var offP = selr.property("ADBE Text Percent Offset");
                                if (offP && offP.numKeys >= 2) hasCharacterReveal = true;
                            } catch (eOO) { }
                        }
                    }
                }
            }
        } catch (eAnim) { }

        // Layer effects — common in text presets for glow/blur look.
        try {
            var effects = layer.property("ADBE Effect Parade");
            if (effects && effects.numProperties > 0) {
                for (var e = 1; e <= effects.numProperties; e++) {
                    var fx = effects.property(e);
                    if (!fx) continue;
                    var mn = fx.matchName || "";
                    if (mn === "ADBE Gaussian Blur 2" || mn === "ADBE Blur Camera Lens" ||
                        mn === "ADBE Box Blur2" || mn === "ADBE Motion Blur" ||
                        mn === "ADBE Gaussian Blur") add("Blur In");
                    else if (mn === "ADBE Glo2" || mn === "ADBE Glow") add("Glow");
                    else if (mn === "ADBE Drop Shadow") add("Shadow");
                }
            }
        } catch (eFx) { }

        // Typewriter promotion: character-based reveal + Fade In → "Typewriter".
        if (hasCharacterReveal) {
            if (seen["Fade In"]) {
                unadd("Fade In");
                add("Typewriter");
            } else if (!seen["Decoder"] && labels.length === 0) {
                add("Typewriter");
            }
        }

        // Join. Keep it SHORT and clean — at most the two most significant
        // motions (a giant "A, B, C, D and E" string is unusable as a filename
        // and looked identical across presets). The user can always overtype.
        var finalName;
        if (labels.length === 0) {
            var ln = (layer.name || "") + "";
            var lnLower = ln.toLowerCase();
            if (ln && lnLower !== "text" && lnLower !== "empty text layer") {
                finalName = ln;
            } else {
                finalName = "Text Animation";
            }
        } else if (labels.length === 1) {
            finalName = labels[0];
        } else {
            // Two primary labels joined; extra motions are summarized with "+N".
            finalName = labels[0] + " " + labels[1];
            if (labels.length > 2) finalName += " +" + (labels.length - 2);
        }

        return encodeBridge('{"ok":true,"name":"' + escapeJSON(finalName) +
            '","debug":"' + escapeJSON(labels.join("|") + (hasCharacterReveal ? "|charReveal" : "")) + '"}');
    } catch (e) {
        return encodeBridge('{"ok":false,"name":"Text Animation","error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Prepares the layer selection for saving a pure Text Animation Preset (.ffx):
 * 1. Clears any current property selection on the layer.
 * 2. Selects all animators in "ADBE Text Animators" (Animator 1, Animator 2, etc.)
 *    with their full stack (Range Selectors, Wiggly Selectors, Expression Selectors,
 *    properties, keyframes, expressions).
 * 3. Selects "ADBE Text More Options" (Anchor Point Grouping, Alignment, Fill/Stroke order).
 * 4. Selects "ADBE Text Path Options" if active or keyframed.
 * 5. Selects ALL effects in "ADBE Effect Parade" (Slider Controls, Checkboxes, Points,
 *    Angles, Colors, Glow, Blur, etc.) so expressions referencing them NEVER break.
 * 6. Selects any "ADBE Transform Group" properties that have keyframes or expressions
 *    (e.g., bounce expressions on Scale, wiggle on Position, Opacity fades).
 * 7. Strictly OMITS "ADBE Text Document" (Source Text) and the parent "ADBE Text Properties"
 *    so user text content, font, and styling are NEVER written to the .ffx preset!
 *
 * Returns: Array of property objects that were marked selected.
 */
function selectTextAnimationProperties(targetLayer) {
    var selectedProps = [];
    if (!targetLayer) return selectedProps;

    try {
        // Snapshot and deselect all currently selected properties
        var liveSel = [];
        try {
            var snap = targetLayer.selectedProperties;
            for (var s = 0; s < snap.length; s++) liveSel.push(snap[s]);
        } catch (eSnap) { liveSel = []; }
        for (var ic = 0; ic < liveSel.length; ic++) {
            try { if (liveSel[ic] && liveSel[ic].selected) liveSel[ic].selected = false; }
            catch (eClr) { }
        }

        var textProps = null;
        try { textProps = targetLayer.property("ADBE Text Properties"); } catch (eTP) { }
        if (textProps) {
            // 1. Select all individual animators inside ADBE Text Animators
            try {
                var animGroup = textProps.property("ADBE Text Animators");
                if (animGroup && animGroup.numProperties > 0) {
                    for (var a = 1; a <= animGroup.numProperties; a++) {
                        var anim = animGroup.property(a);
                        if (anim) {
                            anim.selected = true;
                            selectedProps.push(anim);
                        }
                    }
                }
            } catch (eAnim) { }

            // 2. Select ADBE Text More Options (Anchor Point Grouping, Alignment, Fill/Stroke order)
            try {
                var moreOptions = textProps.property("ADBE Text More Options");
                if (moreOptions) {
                    moreOptions.selected = true;
                    selectedProps.push(moreOptions);
                }
            } catch (eMore) { }

            // 3. Select ADBE Text Path Options if active or animated
            try {
                var pathOptions = textProps.property("ADBE Text Path Options");
                if (pathOptions && pathOptions.numProperties > 0) {
                    var hasPathAnim = false;
                    for (var p = 1; p <= pathOptions.numProperties; p++) {
                        var pp = pathOptions.property(p);
                        if (pp && (pp.numKeys > 0 || (pp.canSetExpression && pp.expressionEnabled))) {
                            hasPathAnim = true;
                            break;
                        }
                    }
                    if (hasPathAnim) {
                        pathOptions.selected = true;
                        selectedProps.push(pathOptions);
                    }
                }
            } catch (ePath) { }
        }

        // 4. Select all effects (Slider Controls, Checkboxes, Angles, Points, Colors, etc.)
        // This preserves expression dependencies like effect("Slider Control")("Slider")
        try {
            var fxGroup = targetLayer.property("ADBE Effect Parade");
            if (fxGroup && fxGroup.numProperties > 0) {
                for (var fxIdx = 1; fxIdx <= fxGroup.numProperties; fxIdx++) {
                    var fx = fxGroup.property(fxIdx);
                    if (fx) {
                        fx.selected = true;
                        selectedProps.push(fx);
                    }
                }
            }
        } catch (eFx) { }

        // 5. Select animated layer transform properties (Position, Scale, Rotation, Opacity, Anchor Point)
        // Only select if keyframed or expression-driven so static position is not forced onto target
        try {
            var xformGroup = targetLayer.property("ADBE Transform Group");
            if (xformGroup && xformGroup.numProperties > 0) {
                for (var x = 1; x <= xformGroup.numProperties; x++) {
                    var xp = xformGroup.property(x);
                    if (xp && (xp.numKeys > 0 || (xp.canSetExpression && xp.expressionEnabled && xp.expression && xp.expression.length > 0))) {
                        xp.selected = true;
                        selectedProps.push(xp);
                    }
                }
            }
        } catch (eXform) { }

        // 6. Guarantee Source Text (ADBE Text Document) and parent group are NOT selected
        if (textProps) {
            try {
                var srcDoc = textProps.property("ADBE Text Document");
                if (srcDoc && srcDoc.selected) srcDoc.selected = false;
            } catch (eDoc) { }
            try {
                if (textProps.selected) textProps.selected = false;
            } catch (eTPClr) { }
        }

    } catch (e) { }

    return selectedProps;
}

function taSavePresetDirectly(destPathHex) {
    try {
        var destPath = decodeBridge(destPathHex || "");
        if (!destPath) return encodeBridge('{"ok":false,"error":"No destination path"}');

        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return encodeBridge('{"ok":false,"error":"Open a composition first"}');

        var sel = comp.selectedLayers;
        if (!sel || sel.length !== 1) return encodeBridge('{"ok":false,"error":"Select exactly ONE text layer"}');

        var targetLayer = sel[0];
        if (!isTextLayer(targetLayer)) {
            return encodeBridge('{"ok":false,"error":"Text section saves text layers only — select a text layer."}');
        }
        var textCheck = null;
        try { textCheck = targetLayer.property("ADBE Text Properties"); } catch (eTC) { textCheck = null; }
        if (!textCheck) {
            return encodeBridge('{"ok":false,"error":"Text section saves text layers only — this layer has no text properties."}');
        }

        var destFile = new File(destPath);
        var parent = destFile.parent;
        if (!parent.exists) parent.create();

        var selectedProps = selectTextAnimationProperties(targetLayer);
        if (!selectedProps || selectedProps.length === 0) {
            return encodeBridge('{"ok":false,"error":"No text animators, expressions, or effects found on selected layer to save."}');
        }

        var saveSuccess = false;
        try {
            if (typeof targetLayer.savePreset === "function") {
                targetLayer.savePreset(destFile);
                saveSuccess = true;
            } else if (typeof targetLayer.saveUserPreset === "function") {
                targetLayer.saveUserPreset(destFile);
                saveSuccess = true;
            }
        } finally {
            for (var p = 0; p < selectedProps.length; p++) {
                try { if (selectedProps[p]) selectedProps[p].selected = false; } catch (eU) { }
            }
        }

        if (saveSuccess) {
            return encodeBridge('{"ok":true, "path":"' + escapeJSON(destPath) + '"}');
        } else {
            return encodeBridge('{"ok":false, "error":"AE version does not support direct save. Please update."}');
        }
    } catch (e) {
        return encodeBridge('{"ok":false, "error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Triggers AE's native "Save Animation Preset…" dialog via executeCommand.
 *
 * Uses selectTextAnimationProperties so the preset captures all animators,
 * selectors, expressions, and effects, while strictly excluding Source Text.
 *
 * Arguments:
 *   pathHex - hex-encoded watch-directory (we scan this for the new .ffx)
 * Returns encoded JSON: { ok, dialogShown, error }
 */
function taInvokeSavePresetDialog(pathHex) {
    try {
        var watchDir = decodeBridge(pathHex || "");
        if (!watchDir) {
            return encodeBridge('{"ok":false,"error":"No watch directory specified"}');
        }

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length !== 1) {
            return encodeBridge('{"ok":false,"error":"Select exactly ONE text layer"}');
        }
        var targetLayer = sel[0];
        if (!isTextLayer(targetLayer)) {
            return encodeBridge('{"ok":false,"error":"Text section saves text layers only — select a text layer."}');
        }
        var textCheck2 = null;
        try { textCheck2 = targetLayer.property("ADBE Text Properties"); } catch (eTC2) { textCheck2 = null; }
        if (!textCheck2) {
            return encodeBridge('{"ok":false,"error":"Text section saves text layers only — this layer has no text properties."}');
        }

        var selectedProps = selectTextAnimationProperties(targetLayer);
        if (!selectedProps || selectedProps.length === 0) {
            return encodeBridge('{"ok":false,"error":"No text animators, expressions, or effects found on selected layer to save."}');
        }

        // Locate the menu command. The exact label includes the trailing ellipsis.
        var cmdId = 0;
        try { cmdId = app.findMenuCommandId("Save Animation Preset..."); } catch (eFind) { cmdId = 0; }
        if (!cmdId) {
            try { cmdId = app.findMenuCommandId("Save Animation Preset…"); } catch (eFind2) { cmdId = 0; }
        }
        if (!cmdId) {
            for (var p = 0; p < selectedProps.length; p++) {
                try { if (selectedProps[p]) selectedProps[p].selected = false; } catch (eU) { }
            }
            return encodeBridge('{"ok":false,"error":"Save Animation Preset command not found in this AE version"}');
        }

        try {
            app.executeCommand(cmdId);
        } catch (eExec) {
            for (var p2 = 0; p2 < selectedProps.length; p2++) {
                try { if (selectedProps[p2]) selectedProps[p2].selected = false; } catch (eU2) { }
            }
            return encodeBridge('{"ok":false,"error":"Dialog invocation failed: ' +
                escapeJSON("" + eExec) + '"}');
        }

        // Clean up selection state regardless of save/cancel.
        for (var p3 = 0; p3 < selectedProps.length; p3++) {
            try { if (selectedProps[p3]) selectedProps[p3].selected = false; } catch (eU3) { }
        }

        return encodeBridge('{"ok":true,"dialogShown":true}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Moves a .ffx file from its native save location into the CompSaver-managed
 * directory, applying collision-safe naming. Called from JS after the native
 * dialog has been confirmed and we've detected the new file on disk.
 *
 * Arguments:
 *   srcHex - hex-encoded absolute path of the .ffx AE just wrote
 *   destDirHex - hex-encoded destination directory (category folder)
 *   suggestedNameHex - hex-encoded preferred display name (without .ffx)
 *
 * Returns encoded JSON: { ok, file, path, error }
 */
function taRelocatePreset(srcHex, destDirHex, suggestedNameHex) {
    try {
        var src = decodeBridge(srcHex || "");
        var destDir = decodeBridge(destDirHex || "");
        var suggested = cleanStr(decodeBridge(suggestedNameHex || ""));
        if (!src) return encodeBridge('{"ok":false,"error":"No source file"}');
        if (!destDir) return encodeBridge('{"ok":false,"error":"No destination folder"}');

        var srcFile = new File(src.replace(/\\/g, "/"));
        if (!srcFile.exists) {
            return encodeBridge('{"ok":false,"error":"Source preset no longer exists"}');
        }
        var folder = ensureDeepFolder(destDir.replace(/\\/g, "/"));
        if (!folder || !folder.exists) {
            return encodeBridge('{"ok":false,"error":"Could not create destination folder"}');
        }

        var baseName = suggested || srcFile.name.replace(/\.ffx$/i, "");
        var safe = getSafeName(baseName);
        if (!safe) safe = "Text Animation";

        var baseDir = folder.fsName.replace(/\\/g, "/");
        var destFile = new File(baseDir + "/" + safe + ".ffx");
        var attempt = 1;
        while (destFile.exists) {
            attempt = attempt + 1;
            destFile = new File(baseDir + "/" + safe + " (" + attempt + ").ffx");
        }

        // Copy then remove source — safer than rename across volumes.
        if (!srcFile.copy(destFile.fsName)) {
            return encodeBridge('{"ok":false,"error":"Could not copy preset to library"}');
        }
        try { srcFile.remove(); } catch (eRm) { /* leave original if remove fails */ }

        var finalPath = destFile.fsName.replace(/\\/g, "/");
        return encodeBridge('{"ok":true,"file":"' + escapeJSON(destFile.name) +
            '","path":"' + escapeJSON(finalPath) + '"}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Returns a pipe-separated list of AE-related directories worth watching
 * for a newly written .ffx after the native Save Animation Preset dialog.
 *
 * AE writes .ffx into different paths depending on version, OS locale, and
 * whether OneDrive has redirected Documents. Rather than pinpoint the exact
 * User Presets dir (fragile — the folder may not even exist until first save),
 * we return EVERY plausible AE root. JS snapshots all of them recursively and
 * diffs to find the new file regardless of where AE landed it.
 *
 * Returns encoded JSON: { ok, paths, error }
 *   paths = "C:/.../A|C:/.../B|..." — pipe-separated, deduplicated
 */
function taResolveUserPresetsDir() {
    var debug = [];
    try {
        var seen = {};
        var out = [];
        function push(p, why) {
            if (!p) return;
            var norm = ("" + p).replace(/\\/g, "/").replace(/\/+$/, "");
            if (!norm || seen[norm]) return;
            var f = new Folder(norm);
            if (!f.exists) return;
            seen[norm] = true;
            out.push(norm);
            debug.push("HIT[" + why + "]: " + norm);
        }

        // Collect every plausible Documents-style root we can find. We probe
        // many sources because Windows + OneDrive + custom-redirected Documents
        // can put the AE folder in surprising places.
        var rootSeen = {};
        var roots = [];
        function addRoot(r, why) {
            if (!r) return;
            var n = ("" + r).replace(/\\/g, "/").replace(/\/+$/, "");
            if (!n || rootSeen[n]) return;
            rootSeen[n] = true;
            roots.push(n);
            debug.push("ROOT[" + why + "]: " + n);
        }

        try { if (Folder.myDocuments && Folder.myDocuments.exists) addRoot(Folder.myDocuments.fsName, "myDocuments"); } catch (e1) { }
        try { if (Folder.userData && Folder.userData.exists) addRoot(Folder.userData.fsName, "userData"); } catch (e1b) { }

        var envNames = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
        var envVals = {};
        for (var ei = 0; ei < envNames.length; ei++) {
            try { envVals[envNames[ei]] = $.getenv(envNames[ei]) || ""; } catch (eEnv) { envVals[envNames[ei]] = ""; }
            debug.push("ENV[" + envNames[ei] + "]=" + envVals[envNames[ei]]);
        }

        if (envVals.OneDrive) {
            addRoot(envVals.OneDrive, "OneDrive");
            addRoot(envVals.OneDrive + "/Documents", "OneDrive/Documents");
            addRoot(envVals.OneDrive + "/Documentos", "OneDrive/Documentos"); // es locale
        }
        if (envVals.OneDriveConsumer) {
            addRoot(envVals.OneDriveConsumer, "OneDriveConsumer");
            addRoot(envVals.OneDriveConsumer + "/Documents", "OneDriveConsumer/Documents");
        }
        if (envVals.OneDriveCommercial) {
            addRoot(envVals.OneDriveCommercial, "OneDriveCommercial");
            addRoot(envVals.OneDriveCommercial + "/Documents", "OneDriveCommercial/Documents");
        }
        if (envVals.USERPROFILE) {
            addRoot(envVals.USERPROFILE, "USERPROFILE");
            addRoot(envVals.USERPROFILE + "/Documents", "USERPROFILE/Documents");
            addRoot(envVals.USERPROFILE + "/OneDrive", "USERPROFILE/OneDrive");
            addRoot(envVals.USERPROFILE + "/OneDrive/Documents", "USERPROFILE/OneDrive/Documents");
        }
        if (envVals.HOMEDRIVE && envVals.HOMEPATH) {
            addRoot(envVals.HOMEDRIVE + envVals.HOMEPATH, "HOME");
            addRoot(envVals.HOMEDRIVE + envVals.HOMEPATH + "/Documents", "HOME/Documents");
        }

        // Recursively look for anything matching /After Effects/i, up to depth 4.
        // Depth 4 is enough to find e.g.
        //   <Root>/Adobe/Adobe After Effects 2024
        //   <Root>/Documents/Adobe/Adobe After Effects 2024
        //   <Root>/OneDrive/Documents/Adobe/Adobe After Effects 2024
        // without scanning unrelated trees forever.
        var MAX_DEPTH = 4;
        function scan(folder, depth) {
            if (!folder || depth > MAX_DEPTH) return;
            var subs;
            try { subs = folder.getFiles(function (f) { return f instanceof Folder; }); }
            catch (eGF) { return; }
            if (!subs) return;
            for (var i = 0; i < subs.length; i++) {
                var sub = subs[i];
                if (!sub || !sub.name) continue;
                if (/After Effects/i.test(sub.name)) {
                    push(sub.fsName, "scan d=" + depth);
                    continue; // already recorded; no need to recurse deeper for new hits
                }
                // Only recurse into directories that plausibly contain AE folders,
                // to avoid scanning the entire user profile.
                if (/^(Adobe|Documents|Documentos|OneDrive|Personal|Mis Documentos)$/i.test(sub.name)) {
                    scan(sub, depth + 1);
                }
            }
        }
        for (var r = 0; r < roots.length; r++) {
            var rf = new Folder(roots[r]);
            if (rf.exists) scan(rf, 0);
        }

        if (!out.length) {
            // Surface debug trail so we can see exactly which roots existed
            // and what was scanned. This is invaluable when the resolver fails
            // on a user's machine — we can't ask them to run scripts.
            return encodeBridge('{"ok":false,"error":"No After Effects folder found","debug":"' +
                escapeJSON(debug.join(" || ")) + '"}');
        }
        return encodeBridge('{"ok":true,"paths":"' + escapeJSON(out.join("|")) +
            '","debug":"' + escapeJSON(debug.join(" || ")) + '"}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) +
            '","debug":"' + escapeJSON(debug.join(" || ")) + '"}');
    }
}

/**
 * Native folder picker — manual fallback when auto-detection fails.
 * The user navigates to their AE User Presets folder once; JS caches
 * the path in localStorage and uses it thereafter.
 * Returns the picked absolute path (forward slashes) or empty string.
 */
function taPickPresetsFolder() {
    try {
        var f = Folder.selectDialog("Select your After Effects User Presets folder");
        if (!f) return "";
        return f.fsName.replace(/\\/g, "/");
    } catch (e) {
        return "";
    }
}

/**
 * Recursively searches a FolderItem (imported project) for the first CompItem.
 * Returns the CompItem or null.
 */
function findCompItemInFolder(folderItem) {
    if (!folderItem) return null;
    try {
        // If folderItem is itself a CompItem (rare for direct import), return it.
        if (folderItem instanceof CompItem) return folderItem;
        // Must be a FolderItem to iterate children.
        if (!(folderItem instanceof FolderItem)) return null;
        for (var i = 1; i <= folderItem.numItems; i++) {
            var child = folderItem.item(i);
            if (child instanceof CompItem) return child;
            if (child instanceof FolderItem) {
                var found = findCompItemInFolder(child);
                if (found) return found;
            }
        }
    } catch (e) { }
    return null;
}

/**
 * Locate a CompItem by EXACT name anywhere inside an imported folder tree, so a
 * background thumbnail renders the composition the save engine recorded rather
 * than whichever comp happens to enumerate first. Falls back to a
 * case-insensitive match. ES3: iterative breadth-first walk, no Array extras
 * beyond push/shift. Returns the CompItem or null.
 */
function findCompItemInFolderByName(folderItem, wantName) {
    if (!folderItem || !wantName) return null;
    var target = "" + wantName;
    var targetLower = target.toLowerCase();
    var exact = null;
    var loose = null;
    var queue = [folderItem];
    while (queue.length > 0) {
        var f = queue.shift();
        var n = 0;
        try { n = f.numItems; } catch (eN) { n = 0; }
        var i;
        for (i = 1; i <= n; i++) {
            var child = null;
            try { child = f.item(i); } catch (eI) { child = null; }
            if (!child) continue;
            if (child instanceof FolderItem) { queue.push(child); continue; }
            if (child instanceof CompItem) {
                if (child.name === target) { exact = child; break; }
                if (!loose && ("" + child.name).toLowerCase() === targetLower) loose = child;
            }
        }
        if (exact) break;
    }
    return exact ? exact : loose;
}

function collectCompKeyframeTimes(comp, scannedComps) {
    if (!scannedComps) scannedComps = {};
    if (!comp) return [];
    var compId = comp.id;
    if (scannedComps[compId]) return [];
    scannedComps[compId] = true;

    var keyTimes = [];
    function scanKeys(prop) {
        if (!prop) return;
        try {
            if (prop.propertyType === PropertyType.PROPERTY) {
                if (prop.numKeys > 0) {
                    var k;
                    for (k = 1; k <= prop.numKeys; k++) {
                        try { keyTimes.push(prop.keyTime(k)); } catch (eKt) { }
                    }
                }
            } else if (prop.propertyType === PropertyType.INDEXED_GROUP || prop.propertyType === PropertyType.NAMED_GROUP) {
                var p;
                for (p = 1; p <= prop.numProperties; p++) {
                    try {
                        var subProp = prop.property(p);
                        var matchName = subProp.matchName;
                        if (matchName === "ADBE Root Vectors Group" || matchName === "ADBE Mask Parade" || matchName === "ADBE Marker") {
                            continue;
                        }
                        scanKeys(subProp);
                    } catch (ep) { }
                }
            }
        } catch (e) { }
    }

    var lIdx;
    for (lIdx = 1; lIdx <= comp.numLayers; lIdx++) {
        try {
            var layer = comp.layer(lIdx);
            var layerName = layer.name;
            if (layerName.indexOf("__bg__") !== -1 ||
                layerName.indexOf("__CS_BG__") !== -1 ||
                layerName.indexOf("CS_Ref_Square_") !== -1) {
                continue;
            }
            var g;
            for (g = 1; g <= layer.numProperties; g++) {
                try {
                    var propGroup = layer.property(g);
                    var matchName = propGroup.matchName;
                    if (matchName === "ADBE Root Vectors Group" || matchName === "ADBE Mask Parade" || matchName === "ADBE Marker") {
                        continue;
                    }
                    scanKeys(propGroup);
                } catch (eLp) { }
            }
            try {
                if (layer.source instanceof CompItem) {
                    var subKeys = collectCompKeyframeTimes(layer.source, scannedComps);
                    if (subKeys && subKeys.length > 0) {
                        var sk;
                        for (sk = 0; sk < subKeys.length; sk++) {
                            var stretch = 1.0;
                            try { stretch = layer.timeStretch / 100.0; } catch (eSt) { }
                            var tParentVal = layer.startTime + subKeys[sk] * stretch;
                            keyTimes.push(tParentVal);
                        }
                    }
                }
            } catch (eSrc) { }
        } catch (eL) { }
    }
    return keyTimes;
}

function taRenderPresetPreview(presetPathHex, tempDirHex, labelHex) {
    var tempComp = null;
    var oldDepth = null;
    var importedFolder = null;
    var previewBG = null;
    var bgLayer = null;
    // Hoisted so every teardown path can remove the project-scope footage item
    // imported below (Bug F: it used to leak into the user's live project).
    var mediaItem = null;
    try {
        var presetPath = decodeBridge(presetPathHex || "");
        var tempDir = decodeBridge(tempDirHex || "");
        var label = decodeBridge(labelHex || "") || "TEXT";

        if (!presetPath) return encodeBridge('{"ok":false,"error":"No preset path"}');
        if (!tempDir) return encodeBridge('{"ok":false,"error":"No temp dir"}');

        var presetFile = new File(presetPath.replace(/\\/g, "/"));
        if (!presetFile.exists) return encodeBridge('{"ok":false,"error":"Preset file missing"}');

        var outFolder = ensureDeepFolder(tempDir.replace(/\\/g, "/"));
        if (!outFolder || !outFolder.exists) {
            return encodeBridge('{"ok":false,"error":"Could not create temp dir"}');
        }
        var baseDir = outFolder.fsName.replace(/\\/g, "/");

        // ── State save ────────────────────────────────────────────────────
        try { oldDepth = app.project.bitsPerChannel; app.project.bitsPerChannel = 8; } catch (eD) { }

        // ── Suppress ALL AE modal dialogs for the whole render ─────────────
        var dlgSuppressed = false;
        try { app.beginSuppressDialogs(); dlgSuppressed = true; } catch (eSup) { }
        function endDlg() {
            if (dlgSuppressed) {
                try { app.endSuppressDialogs(false); } catch (eES) { }
                dlgSuppressed = false;
            }
        }

        // ── Comp setup ────────────────────────────────────────────────────
        var COMP_W = 200, COMP_H = 164, FPS = 30;
        var SEED_DUR = 1.5;
        var TAIL_BUFFER = 0.3;
        var MIN_ANIM_LEN = 0.5;
        var DEFAULT_ANIM_DUR = 2.0;
        var GAP_THRESHOLD = 2.0;
        var RENDER_MIN = 1.0;
        var RENDER_MAX = 4.0;
        var FRAME_DT = 1.0 / FPS;

        var compName = "_CSPreview_" + generateUniqueTimestamp();
        tempComp = app.project.items.addComp(compName, COMP_W, COMP_H, 1.0, SEED_DUR, FPS);
        if (!tempComp) {
            endDlg();
            return encodeBridge('{"ok":false,"error":"Could not create temp comp"}');
        }
        tempComp.workAreaStart = 0;
        tempComp.workAreaDuration = SEED_DUR;

        var isAep = (presetPath.slice(-4).toLowerCase() === ".aep");
        var srcComp = null;
        var nestedLayer = null;
        var textLayer = null;
        var debugScan = [];
        var DUR = SEED_DUR;
        var FRAME_COUNT = Math.round(DUR * FPS);
        var startTimeToRender = 0;
        var keyframesFound = 0;
        var actualLength = 1.5;

        if (isAep) {
            try {
                var importOptions = new ImportOptions(presetFile);
                importedFolder = app.project.importFile(importOptions);
                srcComp = findCompItemInFolder(importedFolder);
            } catch (eImport) {
                try { debugLog("Importing project.aep failed: " + eImport.toString()); } catch (eLog) { }
                if (tempComp) { try { tempComp.remove(); } catch (eR) { } }
                try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eDR) { }
                endDlg();
                return encodeBridge('{"ok":false,"error":"Importing project.aep failed: ' + escapeJSON("" + eImport) + '"}');
            }
            // Apply visual background/depth reference to srcComp if it's the LAYER/Transitions section
            var isLayerSection = (presetPath.toLowerCase().indexOf("/layer/") !== -1 || presetPath.toLowerCase().indexOf("/effect/") !== -1);
            debugLog("isLayerSection: " + isLayerSection + " | presetPath: " + presetPath);
            if (isLayerSection) {
                var hasCamera = false;
                var lIdx;
                for (lIdx = 1; lIdx <= srcComp.numLayers; lIdx++) {
                    try {
                        if (srcComp.layer(lIdx) instanceof CameraLayer) {
                            hasCamera = true;
                            break;
                        }
                    } catch (eCam) { }
                }
                debugLog("hasCamera: " + hasCamera);

                var rPath = presetPath.replace(/\\/g, "/");
                if (rPath.indexOf("/layer/") !== -1) {
                    rPath = rPath.split("/layer/")[0];
                } else if (rPath.indexOf("/effect/") !== -1) {
                    rPath = rPath.split("/effect/")[0];
                } else if (rPath.indexOf("/text/") !== -1) {
                    rPath = rPath.split("/text/")[0];
                }

                debugLog("rPath resolved: " + rPath);
                var customMediaFile = null;
                var foldersToSearch = [
                    rPath + "/preview_assets",
                    rPath + "/preview"
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
                                debugLog("Found customMediaFile in " + foldersToSearch[fIdx] + ": " + customMediaFile.fsName);
                                break;
                            }
                        }
                    } catch (eFold) {
                        debugLog("Error searching folder: " + eFold.toString());
                    }
                }

                if (!customMediaFile) {
                    var extensions = [".png", ".jpg", ".jpeg", ".mp4"];
                    var extIdx;
                    for (extIdx = 0; extIdx < extensions.length; extIdx++) {
                        try {
                            var f = new File(rPath + "/preview_media" + extensions[extIdx]);
                            if (f.exists) {
                                customMediaFile = f;
                                debugLog("Fallback: Found preview_media at root: " + f.fsName);
                                break;
                            }
                        } catch (eF) { }
                    }
                }

                if (!customMediaFile) {
                    debugLog("No customMediaFile found on disk!");
                }

                if (customMediaFile && customMediaFile.exists) {
                    try {
                        debugLog("Attempting to import: " + customMediaFile.fsName);
                        mediaItem = app.project.importFile(new ImportOptions(customMediaFile));
                        debugLog("Import success! mediaItem: " + mediaItem.name);
                        // Enable looping if it's a video/footage item
                        if (mediaItem && mediaItem.mainSource && !mediaItem.mainSource.isStill) {
                            try {
                                mediaItem.mainSource.loop = 10;
                                debugLog("Set video mediaItem loop count to 10");
                            } catch (eLoop) {
                                debugLog("Failed to set loop count: " + eLoop.toString());
                            }
                        }
                    } catch (eMedia) {
                        debugLog("Import failed! Error: " + eMedia.toString());
                    }
                }

                bgLayer = null;
                if (mediaItem) {
                    try {
                        bgLayer = srcComp.layers.add(mediaItem);
                        debugLog("Added mediaItem to srcComp. Layers count: " + srcComp.numLayers);
                        bgLayer.moveToEnd();
                        var scaleX = (srcComp.width / bgLayer.width) * 100;
                        var scaleY = (srcComp.height / bgLayer.height) * 100;
                        var scale = Math.max(scaleX, scaleY);
                        bgLayer.property("ADBE Transform Group").property("ADBE Scale").setValue([scale, scale, 100]);
                        bgLayer.property("ADBE Transform Group").property("ADBE Position").setValue([srcComp.width / 2, srcComp.height / 2]);
                        if (hasCamera) {
                            bgLayer.threeDLayer = true;
                        }
                    } catch (eBgL) {
                        bgLayer = null;
                    }
                }

                if (!bgLayer) {
                    try {
                        var bgSolid = srcComp.layers.addSolid([0.15, 0.15, 0.16], "CS_Preview_BG", srcComp.width, srcComp.height, 1);
                        bgSolid.moveToEnd();
                        if (hasCamera) {
                            bgSolid.threeDLayer = true;
                        }
                        try {
                            var gridFx = bgSolid.property("ADBE Effect Parade").addProperty("ADBE Grid");
                            gridFx.property("Size From").setValue(2);
                            gridFx.property("Width").setValue(srcComp.width / 8);
                            gridFx.property("Height").setValue(srcComp.width / 8);
                            gridFx.property("Border").setValue(2);
                            gridFx.property("Color").setValue([0.3, 0.3, 0.32]);
                        } catch (eGrid) { }
                        bgLayer = bgSolid;
                    } catch (eBgS) { }
                }

                if (hasCamera) {
                    var colors = [
                        [0.85, 0.35, 0.35],
                        [0.35, 0.75, 0.45],
                        [0.35, 0.55, 0.85],
                        [0.85, 0.75, 0.35]
                    ];
                    var positions = [
                        [srcComp.width * 0.25, srcComp.height * 0.25, -200],
                        [srcComp.width * 0.75, srcComp.height * 0.25, 200],
                        [srcComp.width * 0.25, srcComp.height * 0.75, 100],
                        [srcComp.width * 0.75, srcComp.height * 0.75, -100]
                    ];
                    var cIdx;
                    for (cIdx = 0; cIdx < colors.length; cIdx++) {
                        try {
                            var square = srcComp.layers.addSolid(colors[cIdx], "CS_Ref_Square_" + cIdx, 80, 80, 1);
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
            }

            if (!srcComp) {
                try { debugLog("No composition found in imported project.aep"); } catch (eLog) { }
                if (importedFolder) { try { importedFolder.remove(); } catch (eR) { } }
                if (tempComp) { try { tempComp.remove(); } catch (eR) { } }
                try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eDR) { }
                endDlg();
                return encodeBridge('{"ok":false,"error":"No composition found in imported project.aep"}');
            }

            nestedLayer = tempComp.layers.add(srcComp);
            previewBG = null;
            try {
                previewBG = tempComp.layers.addSolid(srcComp.bgColor, "__CS_BG__", COMP_W, COMP_H, 1);
                previewBG.moveToEnd();
            } catch (eBG) {
                debugScan.push("previewBG creation failed: " + eBG.toString());
            }
            var scaleFactorX = COMP_W / srcComp.width;
            var scaleFactorY = COMP_H / srcComp.height;
            var scaleFactor = Math.max(scaleFactorX, scaleFactorY);
            var scalePercent = scaleFactor * 100;
            try {
                nestedLayer.property("ADBE Transform Group").property("ADBE Scale").setValue([scalePercent, scalePercent, 100]);
                nestedLayer.property("ADBE Transform Group").property("ADBE Position").setValue([COMP_W / 2, COMP_H / 2]);
                nestedLayer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([srcComp.width / 2, srcComp.height / 2]);
            } catch (eTransform) { }

            var compKeyTimes = collectCompKeyframeTimes(srcComp);
            var uniqueTimes = [];
            var timeMap = {};
            var aepKeyIdx, aepT, roundedTime;
            for (aepKeyIdx = 0; aepKeyIdx < compKeyTimes.length; aepKeyIdx++) {
                aepT = compKeyTimes[aepKeyIdx];
                roundedTime = Math.round(aepT * 1000) / 1000;
                if (!timeMap[roundedTime]) {
                    timeMap[roundedTime] = true;
                    uniqueTimes.push(aepT);
                }
            }
            uniqueTimes.sort(function (a, b) { return a - b; });

            var aepMinTime = uniqueTimes.length > 0 ? uniqueTimes[0] : null;
            var aepMaxTime = uniqueTimes.length > 0 ? uniqueTimes[uniqueTimes.length - 1] : null;

            if (typeof aepMinTime === "number" && !isNaN(aepMinTime) && typeof aepMaxTime === "number" && !isNaN(aepMaxTime)) {
                startTimeToRender = aepMinTime;
                if (startTimeToRender < 0) startTimeToRender = 0;
                var keyframeSpan = aepMaxTime - aepMinTime;
                actualLength = keyframeSpan > 0.05 ? keyframeSpan : 1.5;
            } else {
                startTimeToRender = srcComp.workAreaStart;
                if (typeof startTimeToRender !== "number" || isNaN(startTimeToRender)) {
                    startTimeToRender = 0;
                }
                if (startTimeToRender < 0) startTimeToRender = 0;

                actualLength = srcComp.workAreaDuration;
                if (typeof actualLength !== "number" || isNaN(actualLength)) {
                    actualLength = 1.5;
                }
            }
            debugScan.push("AEP calculated startTime: " + startTimeToRender + ", actualLength: " + actualLength);
        } else {
            var displayLabel = label ? label.toUpperCase() : "TEXT";
            textLayer = tempComp.layers.addText(displayLabel);

            try {
                deselectAllLayers(tempComp);
                textLayer.selected = true;
                if (typeof textLayer.applyPreset === "function") {
                    textLayer.applyPreset(presetFile);
                } else {
                    presetFile.execute();
                }

                // If an older preset altered the text content, restore displayLabel so preview is clean
                try {
                    var docProp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
                    if (docProp && docProp.value && docProp.value.text !== displayLabel) {
                        var docVal = docProp.value;
                        docVal.text = displayLabel;
                        docProp.setValue(docVal);
                    }
                } catch (eFixDoc) { }
            } catch (eApply) {
                try { tempComp.remove(); } catch (eRm0) { }
                try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eDR) { }
                endDlg();
                return encodeBridge('{"ok":false,"error":"Apply preset to preview comp failed: ' +
                    escapeJSON("" + eApply) + '"}');
            }

            try {
                var keyTimes = [];
                var exprFound = 0;
                var sourceTextKeys = 0;
                function scanKeys(prop) {
                    if (!prop) return;
                    try {
                        if (prop.numProperties) {
                            for (var i = 1; i <= prop.numProperties; i++) {
                                try { scanKeys(prop.property(i)); } catch (ep) { }
                            }
                        } else if (prop.canVaryOverTime) {
                            try {
                                if (prop.expressionEnabled && prop.expression && prop.expression.length > 0) {
                                    exprFound++;
                                }
                            } catch (eExpr) { }
                            if (prop.numKeys > 0) {
                                var isSourceText = false;
                                try { isSourceText = (prop.matchName === "ADBE Text Document"); } catch (eMN) { }
                                if (isSourceText) {
                                    sourceTextKeys += prop.numKeys;
                                } else {
                                    keyframesFound += prop.numKeys;
                                    for (var k = 1; k <= prop.numKeys; k++) {
                                        try { keyTimes.push(prop.keyTime(k)); } catch (eKt) { }
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                }
                scanKeys(textLayer);

                keyTimes.sort(function (a, b) { return a - b; });

                var minKeyTime = null;
                var maxKeyTime = null;
                if (keyTimes.length > 0) {
                    minKeyTime = keyTimes[0];
                    maxKeyTime = keyTimes[0];
                    for (var ki = 1; ki < keyTimes.length; ki++) {
                        if (keyTimes[ki] - maxKeyTime > GAP_THRESHOLD) {
                            debugScan.push("gap outlier ignored: " + keyTimes[ki] +
                                " (>" + GAP_THRESHOLD + "s after " + maxKeyTime + ")");
                            break;
                        }
                        maxKeyTime = keyTimes[ki];
                    }
                }

                var animatorsFound = 0, effectsFound = 0;
                try {
                    var animGroup = textLayer.property("ADBE Text Properties").property("ADBE Text Animators");
                    if (animGroup && animGroup.numProperties > 0) animatorsFound = animGroup.numProperties;
                } catch (eAnim) { }
                try {
                    var fxGroup = textLayer.property("ADBE Effect Parade");
                    if (fxGroup && fxGroup.numProperties > 0) effectsFound = fxGroup.numProperties;
                } catch (eFx) { }

                debugScan.push("keyframesFound: " + keyframesFound);
                debugScan.push("exprFound: " + exprFound);
                debugScan.push("animatorsFound: " + animatorsFound);
                debugScan.push("effectsFound: " + effectsFound);
                debugScan.push("sourceTextKeys: " + sourceTextKeys);
                debugScan.push("minKeyTime: " + minKeyTime);
                debugScan.push("maxKeyTime: " + maxKeyTime);

                var hasAnyAnimation = (keyframesFound > 0) || (exprFound > 0) ||
                    (animatorsFound > 0) || (effectsFound > 0) || (sourceTextKeys > 0);

                startTimeToRender = minKeyTime !== null ? minKeyTime : textLayer.inPoint;
                if (startTimeToRender < 0) startTimeToRender = 0;

                if (keyframesFound > 0 && minKeyTime !== null && maxKeyTime !== null) {
                    var keyframeSpan = maxKeyTime - minKeyTime;
                    if (keyframeSpan > 0) {
                        actualLength = keyframeSpan;
                    }
                } else if (hasAnyAnimation) {
                    actualLength = 1.5;
                } else {
                    actualLength = 1.5;
                    try {
                        var warnFile = new File(presetFile.parent.fsName + "/CS_WARN_no_keyframes_" + generateUniqueTimestamp() + ".txt");
                        warnFile.open("w");
                        warnFile.write("CompSaver: applied preset contained no animation of any kind.\nPreset: " + presetFile.fsName + "\nThe saved .ffx is static — re-check the keyframe-save step.");
                        warnFile.close();
                    } catch (eWarn) { }
                }
            } catch (eScan) {
                debugScan.push("eScan: " + eScan.toString());
            }
        }

        var renderDur = 1.5;
        if (isAep) {
            renderDur = actualLength;
            if (renderDur < RENDER_MIN) renderDur = RENDER_MIN;
            if (renderDur > RENDER_MAX) renderDur = RENDER_MAX;
        } else {
            // Capture the FULL animation PLUS a tail buffer for the trailing
            // per-character cascade / secondary bounce that keeps moving past
            // the last keyframe. Coarse tier-rounding (old code) clipped that
            // settle, so bounce/decoder presets looked rushed and choppy.
            renderDur = actualLength + TAIL_BUFFER;
            if (renderDur < RENDER_MIN) renderDur = RENDER_MIN;
            if (renderDur > RENDER_MAX) renderDur = RENDER_MAX;
        }

        var stretchPct = 100;
        var stretchFactor = 1.0;
        if (actualLength > RENDER_MAX) {
            stretchFactor = RENDER_MAX / actualLength;
            stretchPct = stretchFactor * 100;

            try {
                if (isAep) {
                    nestedLayer.timeStretch = stretchPct;
                    debugScan.push("time-stretched nestedLayer to " + stretchPct + "% to fit 2.5s duration");
                } else {
                    textLayer.timeStretch = stretchPct;
                    debugScan.push("time-stretched textLayer to " + stretchPct + "% to fit 2.5s duration");
                }
            } catch (eStretch) {
                debugScan.push("ERROR timeStretch: " + eStretch.toString());
            }
        }

        DUR = renderDur;
        FRAME_COUNT = Math.round(DUR * FPS);
        debugScan.push("actualLength: " + actualLength);
        debugScan.push("renderDur(DUR): " + DUR);
        debugScan.push("startTimeToRender(pre-norm): " + startTimeToRender);

        if (isAep && bgLayer) {
            try {
                if (bgLayer.source && bgLayer.source.mainSource && !bgLayer.source.mainSource.isStill) {
                    bgLayer.startTime = startTimeToRender;
                    if (stretchPct > 0) {
                        bgLayer.timeStretch = 10000 / stretchPct;
                    }
                    bgLayer.outPoint = srcComp.duration;
                    debugScan.push("Configured video bgLayer: startTime=" + bgLayer.startTime + ", timeStretch=" + bgLayer.timeStretch + ", outPoint=" + bgLayer.outPoint);
                } else {
                    bgLayer.startTime = 0;
                    bgLayer.outPoint = srcComp.duration;
                    debugScan.push("Configured still bgLayer: startTime=0, outPoint=" + bgLayer.outPoint);
                }
            } catch (eBgTime) {
                debugScan.push("Error configuring bgLayer time: " + eBgTime.toString());
            }
        }

        if (startTimeToRender > 0) {
            try {
                var targetLayer = isAep ? nestedLayer : textLayer;
                targetLayer.startTime = targetLayer.startTime - (startTimeToRender * stretchFactor);
                debugScan.push("normalized layer startTime by -" + (startTimeToRender * stretchFactor));
                startTimeToRender = 0;
            } catch (eNorm) {
                debugScan.push("eNorm: " + eNorm.toString());
            }
        }

        var fullEnd = startTimeToRender + DUR;
        try {
            tempComp.duration = fullEnd + FRAME_DT;
        } catch (eCompDur) { debugScan.push("eCompDur: " + eCompDur.toString()); }

        // ── Extend outPoint so the layer covers the full render duration ────
        try {
            if (isAep) {
                if (nestedLayer.outPoint < tempComp.duration) {
                    nestedLayer.outPoint = tempComp.duration;
                }
                if (previewBG && previewBG.outPoint < tempComp.duration) {
                    previewBG.outPoint = tempComp.duration;
                }
            } else {
                if (textLayer.outPoint < tempComp.duration) {
                    textLayer.outPoint = tempComp.duration;
                }
            }
        } catch (eOut) {
            try { debugScan.push("eOut: " + eOut.toString()); } catch (eD) { }
        }

        // ── Text styling (text presets ONLY — skip for AEP comp previews) ──
        if (!isAep) {
            try {
                var srcTextProp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
                var td = srcTextProp.value;
                td.text = "TEXT";
                td.font = "Arial-BoldMT";
                td.fontSize = 34;               // CSS .ta-card-text font-size 17px * 2x
                td.fillColor = [1.0, 1.0, 1.0]; // white, matches CSS color
                try { td.applyFill = true; } catch (eAF) { }
                try { td.applyStroke = false; } catch (eAS) { }
                try { td.tracking = 0; } catch (eTk) { }
                td.justification = ParagraphJustification.CENTER_JUSTIFY;
                srcTextProp.setValue(td);
            } catch (eTxt) {
                try { debugScan.push("eTxt: " + eTxt.toString()); } catch (eD) { }
            }

            // ── Normalize Layer Transform (Anchor + Position) ─────────────────
            // Force the layer dead-center in the 200x164 comp so every preview
            // crops identically. Scale/Rotation are deliberately left alone — most
            // text animators don't use layer transforms; the few that do (rare)
            // would otherwise lose their motion. Animator-space transforms (inside
            // ADBE Text Animators) animate independently of these layer props.
            try {
                var transform = textLayer.property("ADBE Transform Group");
                var ap = transform.property("ADBE Anchor Point");
                var pos = transform.property("ADBE Position");

                try { ap.expression = ""; } catch (eAE) { }
                try { pos.expression = ""; } catch (ePE) { }
                try { while (ap.numKeys > 0) ap.removeKey(1); } catch (eAk) { }
                try { while (pos.numKeys > 0) pos.removeKey(1); } catch (ePk) { }

                // Center the anchor on the text's actual bounding box, then place
                // that anchor at comp center → the glyphs are centered both
                // horizontally AND vertically, matching the CSS flex-centered
                // .ta-card-text static thumbnail (not baseline-aligned).
                var apX = COMP_W / 2, apY = COMP_H / 2;
                var bestRect = null, bestArea = -1;
                var sampleTimes = [
                    Math.max(0, tempComp.duration - FRAME_DT),
                    tempComp.duration * 0.66,
                    tempComp.duration * 0.5,
                    0
                ];
                for (var sIdx = 0; sIdx < sampleTimes.length; sIdx++) {
                    try {
                        var rr = textLayer.sourceRectAtTime(sampleTimes[sIdx], false);
                        var area = (rr.width || 0) * (rr.height || 0);
                        if (area > bestArea) { bestArea = area; bestRect = rr; }
                    } catch (eRS) { }
                }
                if (bestRect) {
                    apX = bestRect.left + bestRect.width / 2;
                    apY = bestRect.top + bestRect.height / 2;
                }
                ap.setValue([apX, apY]);
                pos.setValue([COMP_W / 2, COMP_H / 2]);
            } catch (ePos) {
                try { debugScan.push("ePos: " + ePos.toString()); } catch (eD2) { }
            }
        }

        // ── Visible Render Queue render (PNG sequence) ────────────────────
        // The Render Queue is AE's native, reliable renderer. We briefly SHOW
        // it (so the user gets the native "AE is rendering" feedback) and HIDE
        // it the instant it finishes. This replaces CompItem.saveFrameToPng(),
        // which on some builds intermittently raised a blocking
        // "preview_000NN.png could not be found" modal mid-render.
        //
        // The animation was normalized to t=0 above, so the work area is
        // [0, DUR] and AE writes preview_00000.png .. preview_000(N-1).png. The
        // JS side scans the temp dir for the real frames (start index + count),
        // so whatever numbering AE picks is handled there.
        var renderedFrames = 0;
        var rqItem = null;
        var savedRenderFlags = [];
        var qi;

        // Disk-truth output count: PNG frames if we rendered a sequence, else
        // the single fallback video file ("preview_render.*"). Returning >0 for
        // the video keeps the render flagged successful — ffmpeg expands it.
        function countPreviewPngs() {
            try {
                var pics = outFolder.getFiles("preview_*.png");
                if (pics && pics.length) return pics.length;
                var vids = outFolder.getFiles("preview_render*");
                return (vids && vids.length) ? vids.length : 0;
            }
            catch (eCnt) { return 0; }
        }

        try {
            var rq = app.project.renderQueue;

            // Don't disturb the user's own queue: remember every existing item's
            // render flag, switch them OFF so render() touches ONLY our item,
            // then restore them in finally.
            for (qi = 1; qi <= rq.numItems; qi++) {
                var wasOn = true;
                try { wasOn = rq.item(qi).render; } catch (eRf) { }
                savedRenderFlags.push(wasOn);
                try { rq.item(qi).render = false; } catch (eRf2) { }
            }

            rqItem = rq.items.add(tempComp);
            rqItem.render = true;
            try { rqItem.timeSpanStart = tempComp.workAreaStart; } catch (eTS) { }
            try { rqItem.timeSpanDuration = tempComp.workAreaDuration; } catch (eTD) { }

            // Pick an output format. PREFERRED: a PNG image sequence — it is
            // transparent and ffmpeg consumes it directly. But many modern /
            // localized AE installs ship NO "PNG" output-module template, which
            // made every fresh render fail with "no PNG sequence output module".
            // FALLBACK: render a single VIDEO file ("preview_render.*") using a
            // universally-present Lossless template; the JS side already detects
            // that name and pipes the video through ffmpeg to the same APNG.
            var om = rqItem.outputModule(1);
            var tnames = om.templates;
            function pickTemplate(needles) {
                for (var n = 0; n < needles.length; n++) {
                    for (var t = 0; t < tnames.length; t++) {
                        if (("" + tnames[t]).toLowerCase().indexOf(needles[n]) !== -1) return "" + tnames[t];
                    }
                }
                return "";
            }
            var pngTemplate = pickTemplate(["png"]);
            var appliedTemplateName = "";
            if (pngTemplate) {
                appliedTemplateName = pngTemplate;
                om.applyTemplate(pngTemplate);
                om.file = new File(baseDir + "/preview_[#####].png");
            } else {
                // Alpha-capable lossless first (keeps transparency), then any
                // lossless / RQ-renderable video. If nothing matches (e.g. fully
                // localized template names) keep the output module's own default
                // template, which is virtually always a renderable video format.
                var vidTemplate = pickTemplate(["lossless with alpha", "with alpha", "lossless", "quicktime", "avi", "mov"]);
                if (vidTemplate) {
                    appliedTemplateName = vidTemplate;
                    try { om.applyTemplate(vidTemplate); } catch (eVT) { }
                }
                om.file = new File(baseDir + "/preview_render");
            }

            try {
                debugScan.push("Output templates available: " + tnames.join(", "));
                debugScan.push("Applied template: " + (appliedTemplateName || "Default") + " | Assigned file path: " + (om.file ? om.file.fsName : "null"));
            } catch (eDb) { }

            // SAFETY: never trigger the user's OWN queued renders. Confirm that
            // exactly one item (ours) is armed to render; if not, abort BEFORE
            // render() so we can never overwrite the user's outputs or kick off
            // their jobs because a render-flag toggle silently failed above.
            var armedCount = 0;
            for (qi = 1; qi <= rq.numItems; qi++) {
                try {
                    var item = rq.item(qi);
                    var isQueued = false;
                    try {
                        // In some AE versions, RenderQueueItemStatus is not a regular object, so typeof fails.
                        // We access it directly inside try/catch.
                        isQueued = (item.status === RenderQueueItemStatus.QUEUED);
                    } catch (eStat) {
                        // Fallback to numeric codes (1003 is old AE, 3015 is newer AE)
                        isQueued = (item.status === 1003 || item.status === 3015);
                    }
                    try {
                        debugScan.push("RQ Item " + qi + " | render: " + item.render + " | status: " + item.status + " | isQueued: " + isQueued);
                    } catch (eD) { }
                    if (item.render && isQueued) {
                        armedCount++;
                    }
                } catch (eAc) { }
            }
            if (armedCount !== 1) { throw new Error("RQ safety abort: " + armedCount + " items armed (expected exactly 1)"); }

            // Save original active item and open tempComp in viewer to force GPU context initialization (needed for plugins like Sapphire/Universe)
            var originalActiveItem = app.project.activeItem;
            try { tempComp.openInViewer(); } catch (eO) { }

            // Native feel: show the RQ during the render, hide it right after.
            try { rq.showWindow(true); } catch (eSW) { }
            rq.render();
        } catch (eRQ) {
            debugScan.push("RQ render failed: " + eRQ.toString());
        } finally {
            try { app.project.renderQueue.showWindow(false); } catch (eSW2) { }
            try { if (rqItem) { rqItem.remove(); rqItem = null; } } catch (eRm) { }
            // Restore the user's active viewer
            try {
                if (originalActiveItem && (originalActiveItem instanceof CompItem)) {
                    originalActiveItem.openInViewer();
                }
            } catch (eRestV) { }
            // Restore the user's queue items' render flags no matter what happened.
            try {
                var rq2 = app.project.renderQueue;
                for (qi = 1; qi <= rq2.numItems && qi <= savedRenderFlags.length; qi++) {
                    try { rq2.item(qi).render = savedRenderFlags[qi - 1]; } catch (eRfR) { }
                }
            } catch (eRest) { }
        }

        renderedFrames = countPreviewPngs();

        // ── SAFETY: NO saveFrameToPng fallback (deliberately removed) ──────
        // CompItem.saveFrameToPng() is what raised the blocking
        // "preview_000NN.png could not be found" modal that beginSuppressDialogs
        // does NOT catch on some AE builds — it froze the panel so hard the user
        // had to force-restart the machine. The Render Queue path above is the
        // ONLY render route for previews. If it produced nothing (e.g. an install
        // with no PNG-sequence output template), we FAIL CLEANLY: the save itself
        // already succeeded, and JS just shows a quiet "Preview unavailable"
        // toast. A missing preview is a cosmetic gap; a frozen AE is not.
        if (renderedFrames === 0) {
            debugScan.push("RQ produced 0 frames — failing cleanly (saveFrameToPng fallback removed for safety)");
            try { debugLog("debugScan on failure: " + debugScan.join(" | ")); } catch (eDbgL) { }
            try { tempComp.remove(); } catch (eCR4) { }
            // Bug F: remove the imported preview footage item (if any) so it
            // does not leak into the user's live project on this early exit.
            try { if (mediaItem) mediaItem.remove(); } catch (eMI4) { }
            try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eDR4) { }
            endDlg();
            return encodeBridge('{"ok":false,"error":"Preview renderer unavailable (no PNG sequence output module). Save succeeded; preview skipped."}');
        }
        FRAME_COUNT = renderedFrames;

        // ── Teardown ──────────────────────────────────────────────────────
        try { tempComp.remove(); } catch (eCR2) { }
        try { if (importedFolder) importedFolder.remove(); } catch (eIF) { }
        // Bug F: remove the preview footage item imported at PROJECT scope
        // (app.project.importFile above). Removing importedFolder does NOT
        // cover it: the media item lands at project root, not in that folder.
        try { if (mediaItem) mediaItem.remove(); } catch (eMI) { }
        try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eDF) { }
        endDlg();

        if (CS_DEBUG_SCAN) {
            try {
                var dbgFile = new File(presetFile.parent.fsName + "/debugScan_" + generateUniqueTimestamp() + ".txt");
                dbgFile.open("w");
                dbgFile.write(debugScan.join("\n"));
                dbgFile.close();
            } catch (eDbg) { }
        }

        return encodeBridge('{"ok":true,"frameCount":' + FRAME_COUNT +
            ',"frameRate":' + FPS +
            ',"framePattern":"preview_%05d.png"' +
            ',"keyframesFound":' + keyframesFound +
            ',"tempDir":"' + escapeJSON(baseDir) + '"' +
            ',"debugScan":"' + escapeJSON(debugScan.join(" | ")) + '"}');
    } catch (e) {
        try { debugLog("taRenderPresetPreview exception: " + e.toString() + " (line: " + (e.line || "?") + ")"); } catch (eLog) { }
        try { if (tempComp) tempComp.remove(); } catch (eC2) { }
        try { if (importedFolder) importedFolder.remove(); } catch (eIF2) { }
        // Bug F: outer-catch teardown must also drop the imported footage item.
        try { if (mediaItem) mediaItem.remove(); } catch (eMI2) { }
        try { if (oldDepth !== null) app.project.bitsPerChannel = oldDepth; } catch (eC3) { }
        try { if (typeof endDlg === "function") endDlg(); } catch (eED) { }
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Applies a saved text .ffx preset to the selected text layer.
 * Smart pipeline: if no layer is active, auto-creates a fresh text layer
 * ("LAB.PRO TEXT"), selects it, and applies the preset immediately.
 *
 * Uses Layer.applyPreset() — undocumented but functional in CC 2018+. If
 * that path throws on a given AE build, falls back to File.execute() with
 * the target layer pre-selected (AE auto-applies .ffx to current selection).
 *
 * Argument: pathHex - hex-encoded full path to the .ffx file.
 * Returns encoded JSON: { ok, created, method, error }
 */
function createDefaultTextLayer(comp, refLayer) {
    var layer = comp.layers.addText("TEXT");

    // Move immediately to prevent timeline sliding visual lag
    if (refLayer) {
        try { layer.moveBefore(refLayer); } catch (e) { }
    } else {
        try { layer.moveToBeginning(); } catch (e) { }
    }

    // Set font/formatting defaults: center justification and center anchor point via static calculation (100% instant)
    try {
        var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
        if (textProp) {
            var doc = textProp.value;
            if (doc) {
                doc.justification = ParagraphJustification.CENTER_JUSTIFY;
                textProp.setValue(doc);

                // Static anchor point calculation (no sourceRectAtTime) to prevent any render/viewport redraw lag.
                // For center justification, X is already centered at 0. Y is offset by ~31% of the font size.
                var fontSize = doc.fontSize || 36;
                var yOffset = -fontSize * 0.31;

                try {
                    layer.property("ADBE Transform Group").property("ADBE Scale").setValue([100, 100, 100]);
                    layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, yOffset, 0]);
                    layer.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, (comp.height / 2) + yOffset, 0]);
                } catch (eXform) { }
            }
        }
    } catch (eDoc) { }

    return layer;
}

function taApplyTextPreset(pathHex) {
    var originalTime = null;
    var comp = null;
    try {
        var filePath = decodeBridge(pathHex || "");
        if (!filePath) return encodeBridge('{"ok":false,"error":"No file path provided"}');

        var presetFile = new File(filePath.replace(/\\/g, "/"));
        if (!presetFile.exists) {
            return encodeBridge('{"ok":false,"error":"Preset file not found"}');
        }

        comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }

        originalTime = comp.time;

        app.beginUndoGroup("Apply Text Animation Preset");

        var created = false;
        var targetItems = []; // Array of { layer: Layer, isNew: bool }
        var method = "applyPreset";

        try {
            var sel = comp.selectedLayers;
            if (sel && sel.length > 0) {
                for (var sIdx = 0; sIdx < sel.length; sIdx++) {
                    var currentSel = sel[sIdx];
                    if (isTextLayer(currentSel)) {
                        targetItems.push({ layer: currentSel, isNew: false });
                    } else {
                        // Non-text layer selected (e.g. solid, footage, null).
                        // Create a new text layer and match its timing.
                        var newTxt = createDefaultTextLayer(comp, currentSel, false);
                        created = true;
                        try {
                            newTxt.startTime = currentSel.startTime;
                            newTxt.inPoint = currentSel.inPoint;
                            newTxt.outPoint = currentSel.outPoint;
                        } catch (eDur) { }
                        try {
                            newTxt.moveBefore(currentSel);
                        } catch (eMove) { }
                        targetItems.push({ layer: newTxt, isNew: true });
                    }
                }
            } else {
                // No layer selected. Create a new text layer.
                var newTxt2 = createDefaultTextLayer(comp, null, false);
                created = true;
                targetItems.push({ layer: newTxt2, isNew: true });
            }

            var anyApplied = false;
            var errors = [];
            for (var idx = 0; idx < targetItems.length; idx++) {
                var item = targetItems[idx];
                var targetLayer = item.layer;
                var isNew = item.isNew;

                deselectAllLayers(comp);
                targetLayer.selected = true;

                // ── SNAPSHOT ORIGINAL TEXT & TYPOGRAPHY (CRITICAL) ─────────
                // If this is an existing user text layer (e.g. "MY VIDEO TITLE"),
                // we MUST preserve their text content, font, font size, colors,
                // and tracking! Even if an older preset or third-party .ffx file
                // contains a baked-in dummy "TEXT" or "Title" in ADBE Text Document,
                // applying the animation preset MUST NEVER overwrite the user's text.
                var srcTextProp = null;
                var origDoc = null;
                var origKeys = [];
                var hasDoc = false;
                if (!isNew) {
                    try {
                        var tp = targetLayer.property("ADBE Text Properties");
                        if (tp) srcTextProp = tp.property("ADBE Text Document");
                        if (srcTextProp) {
                            origDoc = srcTextProp.value;
                            hasDoc = (origDoc !== null && origDoc !== undefined);
                            if (srcTextProp.numKeys > 0) {
                                for (var k = 1; k <= srcTextProp.numKeys; k++) {
                                    origKeys.push({
                                        time: srcTextProp.keyTime(k),
                                        value: srcTextProp.keyValue(k)
                                    });
                                }
                            }
                        }
                    } catch (eSnapDoc) { }
                }

                var appliedThis = false;
                try {
                    if (typeof targetLayer.applyPreset === "function") {
                        // Set CTI to the layer's in-point so keyframes align with layer start
                        comp.time = targetLayer.inPoint;
                        targetLayer.applyPreset(presetFile);
                        appliedThis = true;
                        anyApplied = true;
                    }
                } catch (ePrimary) {
                    errors.push(ePrimary.toString());
                }

                if (!appliedThis) {
                    // Fallback: File.execute on a .ffx triggers AE's preset-apply pipeline
                    try {
                        comp.time = targetLayer.inPoint;
                        if (presetFile.execute()) {
                            appliedThis = true;
                            anyApplied = true;
                        } else {
                            errors.push("File.execute returned false");
                        }
                    } catch (eExec) {
                        errors.push(eExec.toString());
                    }
                }

                // ── RESTORE USER'S TEXT & TYPOGRAPHY IF OVERWRITTEN BY PRESET ──
                // If a preset contained an ADBE Text Document payload that altered
                // the user's text or styling, restore the user's original document!
                if (!isNew && hasDoc && origDoc && srcTextProp) {
                    try {
                        var currentDoc = srcTextProp.value;
                        var needsRestoration = false;
                        if (!currentDoc) {
                            needsRestoration = true;
                        } else if (currentDoc.text !== origDoc.text ||
                                   currentDoc.font !== origDoc.font ||
                                   currentDoc.fontSize !== origDoc.fontSize) {
                            needsRestoration = true;
                        }

                        if (needsRestoration) {
                            if (origKeys.length > 0) {
                                while (srcTextProp.numKeys > 0) srcTextProp.removeKey(1);
                                for (var rk = 0; rk < origKeys.length; rk++) {
                                    srcTextProp.setValueAtTime(origKeys[rk].time, origKeys[rk].value);
                                }
                            } else {
                                srcTextProp.setValue(origDoc);
                            }
                        }
                    } catch (eRestDoc) { }
                }
            }

            if (!anyApplied && errors.length > 0) {
                throw new Error("Apply failed: " + errors.join("; "));
            }

            // Restore selection of all target layers
            deselectAllLayers(comp);
            for (var rIdx = 0; rIdx < targetItems.length; rIdx++) {
                try { targetItems[rIdx].layer.selected = true; } catch (eRsel) { }
            }

            app.endUndoGroup();

            // Restore the original playhead position
            if (originalTime !== null && comp !== null) {
                try { comp.time = originalTime; } catch (eTime) { }
            }

            return encodeBridge('{"ok":true,"created":' + (created ? "true" : "false") +
                ',"method":"' + method + '"}');
        } catch (eApply) {
            app.endUndoGroup();
            if (originalTime !== null && comp !== null) {
                try { comp.time = originalTime; } catch (eTime) { }
            }
            return encodeBridge('{"ok":false,"error":"Apply failed: ' + escapeJSON("" + eApply) + '"}');
        }
    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        if (originalTime !== null && comp !== null) {
            try { comp.time = originalTime; } catch (eTime) { }
        }
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Opens a native multi-select dialog for .ffx text-animation files.
 * Returns a raw "|"-delimited string of selected absolute paths (NOT hex).
 * The caller wraps this in encodeBridge(...) at the evalScript call site.
 */
function taPickFfxFiles() {
    try {
        var files = File.openDialog("Select .ffx text animation files", "*.ffx", true);
        if (!files) return "";
        var out = [];
        if (files instanceof Array) {
            for (var i = 0; i < files.length; i++) {
                if (files[i] && files[i].fsName) out.push(files[i].fsName.replace(/\\/g, "/"));
            }
        } else if (files.fsName) {
            out.push(files.fsName.replace(/\\/g, "/"));
        }
        return out.join("|");
    } catch (e) {
        return "";
    }
}

function taResetSelectedTextLayers() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return encodeBridge('{"ok":false,"error":"No layers selected"}');
        }

        app.beginUndoGroup("Reset Text Animation");

        var resetCount = 0;
        var skippedCount = 0;
        var errors = [];

        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            if (isTextLayer(layer)) {
                var wasLocked = layer.locked;
                if (wasLocked) {
                    try { layer.locked = false; } catch (eUnlock) { }
                }

                try {
                    // Get final text document before clearing keyframes
                    var sourceText = layer.property("ADBE Text Properties").property("ADBE Text Document");
                    var finalDoc = null;
                    if (sourceText) {
                        var checkTime = comp.time;
                        if (sourceText.numKeys > 0) {
                            checkTime = sourceText.keyTime(sourceText.numKeys);
                        } else if (sourceText.expression && sourceText.expressionEnabled) {
                            checkTime = layer.outPoint - 0.05;
                        }
                        try {
                            finalDoc = sourceText.valueAtTime(checkTime, false);
                        } catch (eVal) { }
                    }

                    // Clear keyframes, expressions, animators, effects
                    clearAnimRecursively(layer);

                    // Restore final text document
                    if (sourceText && finalDoc) {
                        try {
                            sourceText.setValue(finalDoc);
                        } catch (eSetDoc) { }
                    }

                    // Reset basic transform properties back to default
                    resetLayerTransforms(layer, comp);

                    resetCount++;
                } catch (eLayerReset) {
                    errors.push("Layer '" + layer.name + "' failed: " + eLayerReset.toString());
                } finally {
                    if (wasLocked) {
                        try { layer.locked = true; } catch (eLock) { }
                    }
                }
            } else {
                skippedCount++;
            }
        }

        app.endUndoGroup();

        var errsJSON = [];
        for (var eIdx = 0; eIdx < errors.length; eIdx++) {
            errsJSON.push('"' + escapeJSON(errors[eIdx]) + '"');
        }

        return encodeBridge('{"ok":true,"resetCount":' + resetCount + ',"skippedCount":' + skippedCount + ',"errors":[' + errsJSON.join(",") + ']}');

    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

function clearAnimRecursively(prop) {
    if (!prop) return;

    if (prop.numProperties !== undefined) {
        if (prop.matchName === "ADBE Text Animators" || prop.matchName === "ADBE Effect Parade") {
            for (var i = prop.numProperties; i >= 1; i--) {
                try {
                    prop.property(i).remove();
                } catch (e) { }
            }
        } else {
            for (var i = prop.numProperties; i >= 1; i--) {
                clearAnimRecursively(prop.property(i));
            }
        }
    } else {
        if (prop.numKeys && prop.numKeys > 0) {
            for (var j = prop.numKeys; j >= 1; j--) {
                try {
                    prop.removeKey(j);
                } catch (e) { }
            }
        }
        if (prop.canSetExpression) {
            try {
                prop.expression = "";
                prop.expressionEnabled = false;
            } catch (e) { }
        }
    }
}

function resetLayerTransforms(layer, comp) {
    var transform = layer.property("ADBE Transform Group");
    if (!transform) return;

    try {
        layer.parent = null;
    } catch (e) { }

    try {
        var scaleProp = transform.property("ADBE Scale");
        if (scaleProp) {
            scaleProp.setValue([100, 100, 100]);
        }
    } catch (e) { }

    try {
        if (layer.threeDLayer) {
            try { transform.property("ADBE Orientation").setValue([0, 0, 0]); } catch (e) { }
            try { transform.property("ADBE X Rotation").setValue(0); } catch (e) { }
            try { transform.property("ADBE Y Rotation").setValue(0); } catch (e) { }
            try { transform.property("ADBE Rotate Z").setValue(0); } catch (e) { }
        } else {
            try { transform.property("ADBE Rotation").setValue(0); } catch (e) { }
        }
    } catch (e) { }

    try {
        var opacityProp = transform.property("ADBE Opacity");
        if (opacityProp) opacityProp.setValue(100);
    } catch (e) { }

    try {
        toolkitCompensatedAnchorPoint(layer, "center", comp.time);
    } catch (e) { }

    try {
        var posProp = transform.property("ADBE Position");
        if (posProp) {
            posProp.setValue([comp.width / 2, comp.height / 2, 0]);
        }
    } catch (e) { }
}

function toolkitCheckSharedPrecomps() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return encodeBridge('{"ok":false,"error":"No layers selected"}');
        }

        var shared = false;
        var usageMap = buildSourceUsageCountMap();
        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            if (layer instanceof AVLayer && layer.source instanceof CompItem) {
                if (usageMap[layer.source.id] > 1) {
                    shared = true;
                    break;
                }
            }
        }

        return encodeBridge('{"ok":true,"shared":' + (shared ? "true" : "false") + '}');
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

function getSourceCompUsageCount(compItem) {
    var count = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem) {
            for (var j = 1; j <= item.numLayers; j++) {
                var ly = item.layer(j);
                if (ly.source === compItem) {
                    count++;
                }
            }
        }
    }
    return count;
}

// Single O(items x layers) pass counting project-wide usage of every comp
// source, keyed by item id. A crop run previously called
// getSourceCompUsageCount() once per selected layer (preflight) and once
// more per precomp (execution) — each call walking the whole project.
function buildSourceUsageCountMap() {
    var map = {};
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem) {
            for (var j = 1; j <= item.numLayers; j++) {
                var src = item.layer(j).source;
                if (src !== null && src !== undefined) {
                    var srcId = src.id;
                    if (srcId !== undefined && srcId !== null) {
                        map[srcId] = (map[srcId] || 0) + 1;
                    }
                }
            }
        }
    }
    return map;
}

function toolkitCropPrecomp(duplicateShared) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return encodeBridge('{"ok":false,"error":"No layers selected"}');
        }

        var precomps = [];
        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            if (layer instanceof AVLayer && layer.source instanceof CompItem) {
                precomps.push(layer);
            }
        }

        if (precomps.length === 0) {
            return encodeBridge('{"ok":false,"error":"Please select at least one precomp layer"}');
        }

        app.beginUndoGroup("Crop Precomposition");

        var croppedCount = 0;
        var warnings = [];

        // One usage pass for the whole run + one duplicate per shared source
        // comp: several selected layers sharing one comp now all move to the
        // SAME duplicate instead of each spawning (and cropping) its own.
        var usageMap = buildSourceUsageCountMap();
        var duplicateCache = {};

        for (var i = 0; i < precomps.length; i++) {
            var layer = precomps[i];
            var sourceComp = layer.source;

            // Handle duplicate shared
            var isShared = usageMap[sourceComp.id] > 1;
            if (isShared && duplicateShared) {
                var cachedDup = duplicateCache[sourceComp.id];
                if (cachedDup) {
                    try {
                        layer.replaceSource(cachedDup, true);
                        sourceComp = cachedDup;
                    } catch (eRep) {
                        warnings.push("Failed to move '" + layer.name + "' to the shared duplicate of '" + sourceComp.name + "': " + eRep.toString() + " — layer skipped.");
                        continue;
                    }
                } else {
                    try {
                        var newComp = sourceComp.duplicate();
                        layer.replaceSource(newComp, true);
                        duplicateCache[sourceComp.id] = newComp;
                        sourceComp = newComp;
                    } catch (eDup) {
                        // The user explicitly chose Duplicate: never fall back
                        // to cropping the shared original in place.
                        warnings.push("Failed to duplicate '" + sourceComp.name + "': " + eDup.toString() + " — layer skipped.");
                        continue;
                    }
                }
            }

            // Collect visible content layers inside the precomp
            var visibleLayers = [];
            for (var j = 1; j <= sourceComp.numLayers; j++) {
                var innerLy = sourceComp.layer(j);
                if (innerLy.enabled &&
                    !innerLy.guideLayer &&
                    !innerLy.nullLayer &&
                    !innerLy.adjustmentLayer &&
                    !(innerLy instanceof CameraLayer) &&
                    !(innerLy instanceof LightLayer)) {
                    visibleLayers.push(innerLy);
                }
            }

            if (visibleLayers.length === 0) {
                warnings.push("No visible content layers inside precomp '" + layer.name + "'. Skipping.");
                continue;
            }

            // Detect expression-driven Position on top-level layers
            for (var j = 0; j < visibleLayers.length; j++) {
                var innerLy = visibleLayers[j];
                if (innerLy.parent === null) {
                    var posProp = innerLy.property("ADBE Transform Group").property("ADBE Position");
                    if (posProp && posProp.expression && posProp.expressionEnabled) {
                        warnings.push("Layer '" + innerLy.name + "' inside '" + sourceComp.name + "' has an expression-driven Position. It may require manual adjustment after cropping.");
                    }
                }
            }

            // Gather times to sample (Whole Duration)
            var times = [];
            var timesMap = {};
            timesMap[sourceComp.workAreaStart] = true;
            timesMap[sourceComp.workAreaStart + sourceComp.workAreaDuration] = true;

            for (var j = 0; j < visibleLayers.length; j++) {
                var innerLy = visibleLayers[j];
                timesMap[innerLy.inPoint] = true;
                timesMap[innerLy.outPoint] = true;

                var transGroup = innerLy.property("ADBE Transform Group");
                if (transGroup) {
                    for (var pIdx = 1; pIdx <= transGroup.numProperties; pIdx++) {
                        var prop = transGroup.property(pIdx);
                        if (prop && prop.numKeys > 0) {
                            for (var k = 1; k <= prop.numKeys; k++) {
                                timesMap[prop.keyTime(k)] = true;
                            }
                        }
                    }
                }
            }

            // Interval sampling every 0.5 seconds
            var interval = 0.5;
            for (var tVal = sourceComp.workAreaStart; tVal <= sourceComp.workAreaStart + sourceComp.workAreaDuration; tVal += interval) {
                timesMap[tVal] = true;
            }

            for (var key in timesMap) {
                if (!timesMap.hasOwnProperty(key)) continue;
                times.push(Number(key));
            }
            times.sort(function (a, b) { return a - b; });

            // Calculate union bounding box in sourceComp space
            var bounds = getCompBoundsOfLayers(visibleLayers, times);

            // Guard: If empty bounds (width or height = 0), skip with a notice
            if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
                warnings.push("Visible layers in precomp '" + layer.name + "' have empty bounds (width/height = 0). Skipping.");
                continue;
            }

            // Math with percentage padding: content = 70%, empty margin = 30%
            var contentW = bounds.width;
            var contentH = bounds.height;
            var croppedW = Math.round(contentW / 0.70);
            var croppedH = Math.round(contentH / 0.70);

            // Clamp to AE's valid comp size range (4 to 30000)
            croppedW = Math.max(4, Math.min(30000, croppedW));
            croppedH = Math.max(4, Math.min(30000, croppedH));

            // Recompute margins from the rounded/clamped sizes so centering stays accurate
            var marginW = (croppedW - contentW) / 2;
            var marginH = (croppedH - contentH) / 2;

            var shiftX = marginW - bounds.left;
            var shiftY = marginH - bounds.top;

            // Shift inner layers using temp Null
            var tempNull = sourceComp.layers.addNull();
            var tempNullSource = null;
            try { tempNullSource = tempNull.source; } catch (eTns) { tempNullSource = null; }
            try {
                tempNull.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);

                var topLayers = [];
                for (var k = 1; k <= sourceComp.numLayers; k++) {
                    var innerLy = sourceComp.layer(k);
                    if (innerLy !== tempNull && innerLy.parent === null) {
                        topLayers.push(innerLy);
                        try { innerLy.parent = tempNull; } catch (e) { }
                    }
                }

                tempNull.property("ADBE Transform Group").property("ADBE Position").setValue([shiftX, shiftY]);

                for (var k = 0; k < topLayers.length; k++) {
                    try { topLayers[k].parent = null; } catch (e) { }
                }
            } catch (eShift) {
                warnings.push("Failed to offset inner layers in '" + sourceComp.name + "': " + eShift.toString());
            } finally {
                // addNull() also creates a solid FOOTAGE item; removing only the
                // layer would leave that solid orphaned in the project panel.
                try { tempNull.remove(); } catch (eNullRem) { }
                try {
                    if (tempNullSource && tempNullSource.usedIn && tempNullSource.usedIn.length === 0) {
                        tempNullSource.remove();
                    }
                } catch (eNullSrcRem) { }
            }

            // Resize source comp
            sourceComp.width = croppedW;
            sourceComp.height = croppedH;

            // Center the precomposition layer itself in the parent composition:
            // Remove the old anchor/position compensation logic.
            // Clear existing keyframes first, then set static values.
            var transformGroup = layer.property("ADBE Transform Group");
            if (transformGroup) {
                var anchorProp = transformGroup.property("ADBE Anchor Point");
                var posProp = transformGroup.property("ADBE Position");

                if (anchorProp) {
                    try {
                        while (anchorProp.numKeys > 0) {
                            anchorProp.removeKey(1);
                        }
                        anchorProp.setValue([croppedW / 2, croppedH / 2, 0]);
                    } catch (eA) {
                        warnings.push("Failed to set anchor point on '" + layer.name + "': " + eA.toString());
                    }
                }

                if (posProp) {
                    try {
                        if (posProp.dimensionsSeparated) {
                            var px = transformGroup.property("ADBE Position_0");
                            var py = transformGroup.property("ADBE Position_1");
                            var pz = transformGroup.property("ADBE Position_2");
                            if (px) {
                                while (px.numKeys > 0) px.removeKey(1);
                                px.setValue(comp.width / 2);
                            }
                            if (py) {
                                while (py.numKeys > 0) py.removeKey(1);
                                py.setValue(comp.height / 2);
                            }
                            if (pz) {
                                while (pz.numKeys > 0) pz.removeKey(1);
                                pz.setValue(0);
                            }
                        } else {
                            while (posProp.numKeys > 0) {
                                posProp.removeKey(1);
                            }
                            posProp.setValue([comp.width / 2, comp.height / 2, 0]);
                        }
                    } catch (eP) {
                        warnings.push("Failed to set position on '" + layer.name + "': " + eP.toString());
                    }
                }
            }

            croppedCount++;
        }

        app.endUndoGroup();

        var warnJSON = [];
        for (var wIdx = 0; wIdx < warnings.length; wIdx++) {
            warnJSON.push('"' + escapeJSON(warnings[wIdx]) + '"');
        }

        return encodeBridge('{"ok":true,"croppedCount":' + croppedCount + ',"warnings":[' + warnJSON.join(",") + ']}');

    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

// Compute the union of the selected layers' comp-space bounding boxes across
// every sampled time.
//
// PERFORMANCE (Req 6 — no behavior change): the probe expression is the
// expensive part. Assigning `posProp.expression` forces AE to recompile the
// expression; evaluating it with `valueAtTime` is comparatively cheap. The
// previous shape recompiled once per (layer, time, corner) -> 4 * L * T
// compiles. A layer's sourceRect is usually time-invariant, so the SAME four
// corner points repeat at every sampled time.
//
// This version groups the sampled times by the exact corner point they produced,
// then compiles ONE expression per DISTINCT corner and evaluates it at each time
// recorded for that corner. The evaluated (point, time) pairs are exactly the
// same set as before — only the number of expression compiles changes
// (4 * T -> number of distinct corners, typically 4 per layer) — so the
// resulting bounds are bit-identical.
function getCompBoundsOfLayers(layers, times) {
    var comp = layers[0].containingComp;
    var tempNull = comp.layers.addNull();
    var tempNullSource = null;
    try { tempNullSource = tempNull.source; } catch (eSrc) { tempNullSource = null; }
    try {
        var posProp = tempNull.property("ADBE Transform Group").property("ADBE Position");

        var minX = Infinity, maxX = -Infinity;
        var minY = Infinity, maxY = -Infinity;

        for (var l = 0; l < layers.length; l++) {
            var ly = layers[l];
            var lyIndex = ly.index;

            // key ("x,y") -> { x: Number, y: Number, times: [Number] }
            var ptMap = {};
            var ptKeys = [];

            for (var tIdx = 0; tIdx < times.length; tIdx++) {
                var t = times[tIdx];
                var rect = ly.sourceRectAtTime(t, false);

                var localPoints = [
                    [rect.left, rect.top],
                    [rect.left + rect.width, rect.top],
                    [rect.left, rect.top + rect.height],
                    [rect.left + rect.width, rect.top + rect.height]
                ];

                for (var p = 0; p < 4; p++) {
                    var pt = localPoints[p];
                    // Prefix guards against collisions with Object.prototype names.
                    var key = "p" + pt[0] + "," + pt[1];
                    if (!ptMap[key]) {
                        ptMap[key] = { x: pt[0], y: pt[1], times: [] };
                        ptKeys.push(key);
                    }
                    ptMap[key].times.push(t);
                }
            }

            for (var kIdx = 0; kIdx < ptKeys.length; kIdx++) {
                var entry = ptMap[ptKeys[kIdx]];
                posProp.expression = "thisComp.layer(" + lyIndex + ").toComp([" + entry.x + ", " + entry.y + "])";

                for (var eIdx = 0; eIdx < entry.times.length; eIdx++) {
                    var val = posProp.valueAtTime(entry.times[eIdx], false);

                    var x = val[0];
                    var y = val[1];
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        return {
            left: minX,
            top: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    } finally {
        // The temp null carries a live expression: if sourceRectAtTime or
        // expression evaluation throws mid-way, it must not be left in the
        // comp polluting the undo stack. addNull() also creates a solid FOOTAGE
        // item in the project panel; removing only the layer leaves that solid
        // orphaned, so drop it too once nothing else references it.
        try { tempNull.remove(); } catch (eRemove) { }
        try {
            if (tempNullSource && tempNullSource.usedIn && tempNullSource.usedIn.length === 0) {
                tempNullSource.remove();
            }
        } catch (eSrcRemove) { }
    }
}

