// ============================================================
// workflow.jsx - new workflow toolkit actions + colorflow backend + label color
// (ExtendScript module - included by compSaver.jsx; functions are global)
// ============================================================

// =========================================================
// NEW WORKFLOW TOOLKIT ACTIONS
// =========================================================

function toolkitSequenceLayers(modeParamsHex) {
    // ─────────────────────────────────────────────────────────────────────────
    // LAYER SEQUENCE ENGINE  v3.0  —  Pure Professional Timeline Cascade
    // ─────────────────────────────────────────────────────────────────────────
    // PARAMETERS (pipe-delimited, hex-encoded via bridge):
    //   [0] mode        : "down" | "up" | "center" | "random"
    //   [1] stepFrames  : integer — frame delay between each successive layer
    //   [2] holdCount   : integer — how many layers (from the mode's anchor) stay
    //                     HELD at the anchor time; all others cascade. Min 1.
    //
    // CONTROL SEMANTICS:
    //   N    = how many layers (from the mode's anchor) stay HELD; the rest cascade
    //   Step = frame delay between each individual layer — pure cascade, no batching
    //
    // MODES:
    //   down    → CTI Normalize: snap ALL selected layers to current playhead (no stagger)
    //   up      → Forward Stagger:  top layer = 0f, each layer below += step
    //   center  → Reverse Stagger:  bottom layer = 0f, each layer above += step
    //   random  → Random Stagger: held layers anchor, the rest scatter to random
    //             times within the window (re-click re-rolls). ("reverse"/Center-Out
    //             offset table is still supported below for backward compatibility.)
    //
    // INCREMENTAL REPEAT:
    //   Every click reads CURRENT live startTimes from AE — fully stateless.
    //   If layers already match this click's stagger pattern (isAlreadyStaggered)
    //   AND the pattern spans >1 distinct timing slot (maxOffset > 0),
    //   advance baseTime by +step to guarantee visible movement on repeated clicks.
    //
    // EXTENSIBILITY SLOTS (future features — wired but unused by default):
    //   [3] overlapPct    : 0–100 — shortens effective step by overlap percentage
    //   [4] randomStrength: 0–N   — adds ±random jitter per layer (in frames)
    // ─────────────────────────────────────────────────────────────────────────
    try {
        var params = cleanStr(decodeBridge(modeParamsHex)).split("|");
        var mode = params[0] || "down";
        var stepFrames = parseInt(params[1] || "5", 10);
        var numLimit = parseInt(params[2] || "0", 10);
        var overlapPct = parseFloat(params[3] || "0");
        var randomStrength = parseFloat(params[4] || "0");

        if (isNaN(stepFrames)) stepFrames = 5;
        if (isNaN(numLimit) || numLimit < 0) numLimit = 0;
        if (isNaN(overlapPct)) overlapPct = 0;
        if (isNaN(randomStrength)) randomStrength = 0;

        // ── COMP + SELECTION GUARD ────────────────────────────────────────────
        var comp = getSafeActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) return encodeBridge("Select layers to sequence first.");

        app.beginUndoGroup("Sequence Layers");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            // ── 1. FILTER ELIGIBLE LAYERS ─────────────────────────────────────────
            // Skip locked, camera, light, and guide layers — they must not be touched
            var eligible = [];
            var i;
            for (i = 0; i < sel.length; i++) {
                var lyr = sel[i];
                if (lyr.locked) continue;
                if (lyr instanceof CameraLayer) continue;
                if (lyr instanceof LightLayer) continue;
                if (lyr.guideLayer === true) continue;
                eligible.push(lyr);
            }

            if (eligible.length === 0) {
                return encodeBridge("All selected layers are locked, cameras, lights, or guides!");
            }

            var totalN = eligible.length;

            // ── 2. SORT BY TIMELINE INDEX  (top → bottom, index ascending) ────────
            var timelineSorted = [];
            for (i = 0; i < totalN; i++) timelineSorted.push(eligible[i]);
            timelineSorted.sort(function (a, b) { return a.index - b.index; });

            // ── 3. FRAME → SECONDS CONVERSION ────────────────────────────────────
            var fps = comp.frameRate;
            var step = stepFrames / fps;

            // Extensibility: overlap shortens effective step (not active at default 0)
            if (overlapPct !== 0) step = step * (1.0 - (overlapPct / 100.0));

            // ── 4. CTI NORMALIZE  (button 1 — no stagger, pure sync) ─────────────
            if (mode === "down") {
                var cti = comp.time;
                for (i = 0; i < totalN; i++) timelineSorted[i].startTime = cti;
                for (i = 0; i < totalN; i++) {
                    try { timelineSorted[i].selected = true; } catch (eS) { }
                }
                return encodeBridge("true");
            }

            // ── 5. HOLD COUNT (N)  —  anchored layers that DON'T move ────────────
            // N = how many layers, counting from each mode's ANCHOR, stay HELD at the
            // anchor time. Every OTHER layer cascades by `step`.
            //   N = 1 (default): only the anchor layer holds → ALL other layers move.
            //   N = k          : the k layers nearest the anchor hold together; rest cascade.
            // Clamped to 1..totalN. (A sent value of 0 is treated as 1.)
            var hold = numLimit;
            if (isNaN(hold) || hold < 1) hold = 1;
            if (hold > totalN) hold = totalN;

            // Every eligible layer participates (top → bottom). N no longer limits
            // participation — it only decides how many anchor layers stay frozen.
            var participants = timelineSorted;
            var count = totalN;

            // ── 6. BUILD OFFSET TABLE ─────────────────────────────────────────────
            // rank[i] = step-distance from the mode's anchor (0 = the anchor layer):
            //   up      (Forward):    rank = i                 (top    = anchor)
            //   center  (Reverse):    rank = count-1-i         (bottom = anchor)
            //   reverse (Center-Out): rank = floor(|i - mid|)  (middle = anchor)
            //
            // HOLD is then applied per layer:
            //   rank <  hold  → offset 0           (held at anchor, no movement)
            //   rank >= hold  → offset rank-hold+1 (cascade, starting one step out)
            // With hold = 1 this reduces to offset == rank, i.e. the classic stagger
            // where only the single anchor layer stays put and everyone else moves.
            var offsets = [];
            var rank;
            if (mode === "up") {
                for (i = 0; i < count; i++) {
                    rank = i;
                    offsets.push(rank < hold ? 0 : (rank - hold + 1));
                }

            } else if (mode === "center") {
                for (i = 0; i < count; i++) {
                    rank = count - 1 - i;
                    offsets.push(rank < hold ? 0 : (rank - hold + 1));
                }

            } else if (mode === "reverse") {
                var mid = (count - 1) / 2.0;
                for (i = 0; i < count; i++) {
                    rank = Math.floor(Math.abs(i - mid));
                    offsets.push(rank < hold ? 0 : (rank - hold + 1));
                }

            } else if (mode === "random") {
                // RANDOM scatter — organic, non-ordered stagger.
                // The top N (hold) layers anchor at offset 0; every other layer gets a
                // random offset within the full stagger window, so layers land at random
                // times instead of a clean cascade. Re-clicking re-rolls a fresh layout.
                for (i = 0; i < count; i++) {
                    if (i < hold) {
                        offsets.push(0);
                    } else {
                        offsets.push(1 + Math.floor(Math.random() * count));
                    }
                }

            } else {
                return encodeBridge("Unknown stagger mode: " + mode);
            }

            // ── 7. LIVE-READ INCREMENTAL STAGGER ENGINE ───────────────────────────
            //
            // Every execution reads CURRENT live startTimes from AE with zero
            // stale state or cached references.
            //
            // Step A — anchorTime: current live startTime of the anchor layer (where offset == 0).
            // Step B — isAlreadyStaggered / detectedM: check if current startTimes
            //          match the pattern: participants[i].startTime == anchorTime + offsets[i]*M*step
            //          for some positive integer M >= 1.
            // Step C — finalM decision:
            //          • Pattern matched AND maxOffset > 0
            //            → finalM = detectedM + 1 (advance multiplier to increase the gap)
            //          • Pattern NOT matched OR single-slot
            //            → finalM = 1 (fresh apply of the step gap)

            var anchorTime = 0;
            for (i = 0; i < count; i++) {
                if (offsets[i] === 0) {
                    anchorTime = participants[i].startTime;
                    break;
                }
            }

            var maxOffset = 0;
            for (i = 0; i < count; i++) {
                if (offsets[i] > maxOffset) maxOffset = offsets[i];
            }

            var tolerance = 0.25 / fps; // ¼-frame FP rounding guard
            var isAlreadyStaggered = false;
            var detectedM = 1;

            if (maxOffset > 0) {
                var candidateM = 1;
                var foundCandidate = false;
                for (i = 0; i < count; i++) {
                    if (offsets[i] > 0) {
                        var calculatedM = (participants[i].startTime - anchorTime) / (offsets[i] * step);
                        candidateM = Math.round(calculatedM);
                        if (candidateM >= 1) {
                            foundCandidate = true;
                            break;
                        }
                    }
                }

                if (foundCandidate) {
                    var fits = true;
                    for (i = 0; i < count; i++) {
                        var expected = anchorTime + offsets[i] * candidateM * step;
                        if (Math.abs(participants[i].startTime - expected) > tolerance) {
                            fits = false;
                            break;
                        }
                    }
                    if (fits) {
                        detectedM = candidateM;
                        isAlreadyStaggered = true;
                    }
                }
            }

            var finalM = isAlreadyStaggered ? (detectedM + 1) : 1;

            // ── 8. APPLY STAGGER ──────────────────────────────────────────────────
            // Shifting startTime does NOT destroy keyframes, break parenting, or
            // clear expressions — all internal coordinates shift with the new inPoint.
            for (i = 0; i < count; i++) {
                // Extensibility: per-layer random jitter (inactive at randomStrength=0)
                var jitter = 0;
                if (randomStrength > 0) {
                    jitter = (Math.random() * 2.0 - 1.0) * (randomStrength / fps);
                }
                var newTime = anchorTime + offsets[i] * finalM * step + jitter;
                if (newTime < 0) newTime = 0;
                participants[i].startTime = newTime;
            }

            // ── 9. RESTORE SELECTION STATE ────────────────────────────────────────
            // startTime shifts can dirty AE's internal selection cache in some builds.
            // Re-selecting explicitly prevents "dead" selections on the next click.
            for (i = 0; i < totalN; i++) {
                try { timelineSorted[i].selected = true; } catch (eS) { }
            }

            return encodeBridge("true");

        } finally {
            // Req 9.1/9.2: always close the undo group, normal or error path.
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (err) {
        return encodeBridge("Sequence Error: " + err.toString());
    }
}

function toolkitAddGuides() {
    try {
        var comp = getSafeActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            comp = null;
            sel = null;
            return encodeBridge("Select at least one layer.");
        }

        app.beginUndoGroup("Add Layer Guides");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            var i;
            var addedCount = 0;
            var currentTime = comp.time;
            for (i = 0; i < sel.length; i++) {
                var lyr = sel[i];

                if (lyr instanceof CameraLayer) continue;
                if (lyr instanceof LightLayer) continue;
                if (lyr.locked) continue;

                var r = null;
                try {
                    r = lyr.sourceRectAtTime(currentTime, true);
                } catch (errRect) {
                    continue;
                }

                if (!r) continue;

                var effectsParade = null;
                var tempEffect = null;
                try {
                    effectsParade = lyr.property("ADBE Effect Parade");
                    tempEffect = effectsParade.addProperty("ADBE Point Control");
                } catch (eAdd) {
                    // In case the layer type doesn't support effects
                    continue;
                }
                if (!tempEffect) continue;

                var pointProp = tempEffect.property(1);
                var pt1Comp = null;
                var pt2Comp = null;
                var pt3Comp = null;
                var pt4Comp = null;

                try {
                    // Corner 1: Top-Left
                    pointProp.expression = "toComp([" + r.left + ", " + r.top + ", 0])";
                    pt1Comp = pointProp.value;

                    // Corner 2: Top-Right
                    pointProp.expression = "toComp([" + (r.left + r.width) + ", " + r.top + ", 0])";
                    pt2Comp = pointProp.value;

                    // Corner 3: Bottom-Left
                    pointProp.expression = "toComp([" + r.left + ", " + (r.top + r.height) + ", 0])";
                    pt3Comp = pointProp.value;

                    // Corner 4: Bottom-Right
                    pointProp.expression = "toComp([" + (r.left + r.width) + ", " + (r.top + r.height) + ", 0])";
                    pt4Comp = pointProp.value;
                } catch (errEval) {
                    try { tempEffect.remove(); } catch (eRem) { }
                    continue;
                }

                try { tempEffect.remove(); } catch (eRem) { }

                var xMin = Math.min(pt1Comp[0], pt2Comp[0], pt3Comp[0], pt4Comp[0]);
                var xMax = Math.max(pt1Comp[0], pt2Comp[0], pt3Comp[0], pt4Comp[0]);
                var yMin = Math.min(pt1Comp[1], pt2Comp[1], pt3Comp[1], pt4Comp[1]);
                var yMax = Math.max(pt1Comp[1], pt2Comp[1], pt3Comp[1], pt4Comp[1]);

                var xCenter = (xMin + xMax) / 2;
                var yCenter = (yMin + yMax) / 2;

                comp.addGuide(1, xMin);
                comp.addGuide(1, xCenter);
                comp.addGuide(1, xMax);

                comp.addGuide(0, yMin);
                comp.addGuide(0, yCenter);
                comp.addGuide(0, yMax);

                addedCount++;
                lyr = null;
                effectsParade = null;
                tempEffect = null;
                pointProp = null;
            }

            comp = null;
            sel = null;

            if (addedCount === 0) {
                return encodeBridge("No layers could be guided (cameras/lights/locked skipped).");
            }

            return encodeBridge("true");
        } finally {
            // Req 9.1/9.2: always close the undo group, normal or error path.
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (e) {
        comp = null;
        sel = null;
        return encodeBridge("Add Guides Error: " + e.toString());
    }
}

function toolkitClearGuides() {
    try {
        var comp = getSafeActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");

        app.beginUndoGroup("Clear Guides");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {
            var numGuides = comp.guides.length;
            var i;
            for (i = 0; i < numGuides; i++) {
                comp.removeGuide(0);
            }

            comp = null;
            return encodeBridge("true");
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (e) {
        comp = null;
        return encodeBridge("Clear Guides Error: " + e.toString());
    }
}

function toolkitRemoveExpressions() {
    try {
        var comp = getSafeActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            comp = null;
            sel = null;
            return encodeBridge("Select at least one layer.");
        }

        app.beginUndoGroup("Delete Layer Expressions");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            var i;
            var removedCount = 0;

            // Recursive helper to traverse property groups
            function removeExpressionsFromGroup(group) {
                var numProps = group.numProperties;
                var k;
                for (k = 1; k <= numProps; k++) {
                    var prop = group.property(k);
                    if (prop.propertyType === PropertyType.PROPERTY) {
                        try {
                            if (prop.expression && prop.expression !== "") {
                                prop.expression = "";
                                removedCount++;
                            }
                        } catch (e) { }
                    } else {
                        removeExpressionsFromGroup(prop);
                    }
                    prop = null;
                }
            }

            for (i = 0; i < sel.length; i++) {
                var lyr = sel[i];
                if (lyr.locked) continue;
                removeExpressionsFromGroup(lyr);
                lyr = null;
            }

            comp = null;
            sel = null;

            return encodeBridge("true");
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (e) {
        comp = null;
        sel = null;
        return encodeBridge("Delete Expressions Error: " + e.toString());
    }
}

function toolkitMultiPrecomp(prefixCountHex) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge("Open a composition first.");
        }

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return encodeBridge("Select layers to pre-compose first.");
        }

        app.beginUndoGroup("Multi Pre-compose Individually");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            // 1. Gather unlocked selected layers
            var layers = [];
            var i;
            for (i = 0; i < sel.length; i++) {
                if (!sel[i].locked) {
                    layers.push(sel[i]);
                }
            }

            if (layers.length === 0) {
                return encodeBridge("All selected layers are locked!");
            }

            // 2. Sort by timeline index ascending so stacking order is preserved
            layers.sort(function (a, b) { return a.index - b.index; });

            // 2b. Tag each target with a unique marker comment so we can re-resolve
            //     its CURRENT index right before precomposing. Holding the captured
            //     layer references across precompose() mutations is unreliable
            //     (stale index -> wrong layer precomposed); re-finding by marker is
            //     bulletproof. Real comments are stashed for restoration afterwards.
            var MP_MARK = "__CS_MP_MARK__";
            var originalComments = [];
            for (i = 0; i < layers.length; i++) {
                var ocmt = "";
                try { ocmt = layers[i].comment; } catch (eOC) { ocmt = ""; }
                originalComments.push(ocmt);
                try { layers[i].comment = MP_MARK + i; } catch (eSC) { }
            }

            var precompedCount = 0;
            var resultingPrecompLayers = [];

            // Comp-name lookup set built ONCE for the whole run instead of a full
            // project rescan per candidate name (Req 6 — O(items x candidates) ->
            // O(items)). Names handed out during this run are folded back into the
            // set, so precomps created by earlier iterations still collide
            // correctly. "n" prefix avoids Object.prototype name clashes.
            var localCompNames = {};
            try {
                var nameScan;
                for (nameScan = 1; nameScan <= app.project.numItems; nameScan++) {
                    var scanItem = app.project.item(nameScan);
                    if (scanItem instanceof CompItem) localCompNames["n" + scanItem.name] = true;
                }
            } catch (eNameScan) { }

            function getUniqueMultiPrecompName(baseName) {
                var checkName = baseName;
                var counter = 1;
                while (localCompNames["n" + checkName]) {
                    checkName = baseName + " " + counter;
                    counter++;
                }
                localCompNames["n" + checkName] = true;
                return checkName;
            }

            // 3. Precompose each layer individually
            for (i = 0; i < layers.length; i++) {
                // Re-resolve THIS target by its marker against the live layer
                // collection so we always act on the correct CURRENT index, even
                // after earlier precompose() calls mutated the collection.
                var layer = null;
                var mpKey = MP_MARK + i;
                var mpFind;
                for (mpFind = 1; mpFind <= comp.numLayers; mpFind++) {
                    var mpCand = comp.layer(mpFind);
                    var mpCmt = "";
                    try { mpCmt = mpCand.comment; } catch (eMC) { mpCmt = ""; }
                    if (mpCmt === mpKey) { layer = mpCand; break; }
                }
                if (!layer) { continue; } // target already consumed / not found — skip safely

                // Capture all original layer properties before precomposing
                var originalIndex = layer.index;
                var originalName = layer.name;
                var originalParent = layer.parent;
                var originalLabel = layer.label;
                var originalShy = layer.shy;
                var originalSolo = layer.solo;
                var originalEnabled = layer.enabled;
                var originalComment = originalComments[i];

                // Capture timing properties
                var originalInPoint = layer.inPoint;
                var originalOutPoint = layer.outPoint;
                var originalStartTime = layer.startTime;
                var originalStretch = layer.stretch;

                // Capture blending and other properties
                var originalBlendingMode = null;
                try { originalBlendingMode = layer.blendingMode; } catch (e) { }
                var originalAdjustment = null;
                try { originalAdjustment = layer.adjustmentLayer; } catch (e) { }
                var originalThreeD = null;
                try { originalThreeD = layer.threeDLayer; } catch (e) { }
                var originalMotionBlur = null;
                try { originalMotionBlur = layer.motionBlur; } catch (e) { }
                var originalEffectsActive = null;
                try { originalEffectsActive = layer.effectsActive; } catch (e) { }
                var originalGuide = null;
                try { originalGuide = layer.guideLayer; } catch (e) { }
                var originalCollapse = null;
                // Only capture and restore collapseTransformation if the original layer was already a Composition/Precomp layer!
                if (layer.source && layer.source instanceof CompItem) {
                    try { originalCollapse = layer.collapseTransformation; } catch (e) { }
                }
                var originalSampling = null;
                try { originalSampling = layer.samplingQuality; } catch (e) { }
                var originalMatteMode = null;
                try { originalMatteMode = layer.trackMatteType; } catch (e) { }
                var originalQuality = null;
                try { originalQuality = layer.quality; } catch (e) { }
                var originalFrameBlendingType = null;
                try { originalFrameBlendingType = layer.frameBlendingType; } catch (e) { }
                var originalPreserveTransparency = null;
                try { originalPreserveTransparency = layer.preserveTransparency; } catch (e) { }

                // Generate unique precomp name: layerName + " Comp" (Project panel unique safety)
                var desiredCompName = originalName + " Comp";
                var compName = getUniqueMultiPrecompName(desiredCompName);

                try {
                    // Call native precompose on the single layer index
                    comp.layers.precompose([originalIndex], compName, true);
                    precompedCount++;

                    // Locate the new precomp layer by searching for it to be index-independent
                    var precompLayer = null;
                    var k;
                    for (k = 1; k <= comp.numLayers; k++) {
                        var lyr = comp.layer(k);
                        if (lyr.source && lyr.source instanceof CompItem && lyr.source.name === compName) {
                            precompLayer = lyr;
                            break;
                        }
                    }

                    if (precompLayer) {
                        resultingPrecompLayers.push(precompLayer);

                        // Restore properties (using standard precomp brown label index 15)
                        try { precompLayer.label = 15; } catch (e) { }
                        try { precompLayer.shy = originalShy; } catch (e) { }
                        try { precompLayer.solo = originalSolo; } catch (e) { }
                        try { precompLayer.enabled = originalEnabled; } catch (e) { }
                        try { precompLayer.comment = originalComment; } catch (e) { }
                        try { precompLayer.name = originalName; } catch (e) { } // Keep the EXACT original layer name in timeline!
                        if (originalBlendingMode !== null) { try { precompLayer.blendingMode = originalBlendingMode; } catch (e) { } }
                        if (originalAdjustment !== null) { try { precompLayer.adjustmentLayer = originalAdjustment; } catch (e) { } }
                        if (originalThreeD !== null) { try { precompLayer.threeDLayer = originalThreeD; } catch (e) { } }
                        if (originalMotionBlur !== null) { try { precompLayer.motionBlur = originalMotionBlur; } catch (e) { } }
                        if (originalEffectsActive !== null) { try { precompLayer.effectsActive = originalEffectsActive; } catch (e) { } }
                        if (originalGuide !== null) { try { precompLayer.guideLayer = originalGuide; } catch (e) { } }
                        if (originalCollapse !== null) { try { precompLayer.collapseTransformation = originalCollapse; } catch (e) { } }
                        if (originalSampling !== null) { try { precompLayer.samplingQuality = originalSampling; } catch (e) { } }
                        if (originalMatteMode !== null) { try { precompLayer.trackMatteType = originalMatteMode; } catch (e) { } }
                        if (originalQuality !== null) { try { precompLayer.quality = originalQuality; } catch (e) { } }
                        if (originalFrameBlendingType !== null) { try { precompLayer.frameBlendingType = originalFrameBlendingType; } catch (e) { } }
                        if (originalPreserveTransparency !== null) { try { precompLayer.preserveTransparency = originalPreserveTransparency; } catch (e) { } }

                        // Process internal timing shift
                        var precompSource = precompLayer.source;
                        if (precompSource && precompSource instanceof CompItem) {
                            // Clear our temporary marker off the moved inner layer(s),
                            // restoring whatever comment the layer originally had.
                            var mpci;
                            for (mpci = 1; mpci <= precompSource.numLayers; mpci++) {
                                try {
                                    if (precompSource.layer(mpci).comment === mpKey) {
                                        precompSource.layer(mpci).comment = originalComments[i];
                                    }
                                } catch (eMPC) { }
                            }

                            // Gather internal layers
                            var innerLayers = [];
                            var j;
                            for (j = 1; j <= precompSource.numLayers; j++) {
                                innerLayers.push(precompSource.layer(j));
                            }

                            // Shift start times of internal layers by subtracting originalInPoint
                            // Keeping their native stretch factor completely untouched to preserve internal keyframe speeds
                            for (j = 0; j < innerLayers.length; j++) {
                                try {
                                    innerLayers[j].startTime = innerLayers[j].startTime - originalInPoint;
                                } catch (eInner) { }
                            }

                            // Set the precomp composition's duration to the exact active duration footprint
                            var activeDuration = originalOutPoint - originalInPoint;
                            if (activeDuration <= 0) activeDuration = 0.1;
                            try {
                                precompSource.duration = activeDuration;
                            } catch (eDur) { }
                        }

                        // Restore exact tight timing footprint on the precomp layer in the parent comp
                        try { precompLayer.startTime = originalInPoint; } catch (e) { }
                        try { precompLayer.stretch = 100; } catch (e) { } // Let the speed stretch remain inside the precomp
                        try { precompLayer.inPoint = originalInPoint; } catch (e) { }
                        try { precompLayer.outPoint = originalOutPoint; } catch (e) { }

                        // Restore parent connection safely
                        if (originalParent) {
                            try {
                                precompLayer.parent = originalParent;
                            } catch (eParent) { }
                        }
                    }
                } catch (ePre) {
                    // If precompose throws, continue to next layer
                }
            }

            // Safety: restore any markers still left on parent-comp layers (e.g. a
            // target whose precompose threw before the inner cleanup ran).
            var mpClean;
            for (mpClean = 1; mpClean <= comp.numLayers; mpClean++) {
                try {
                    var clLyr = comp.layer(mpClean);
                    var clCmt = clLyr.comment;
                    if (clCmt && clCmt.indexOf(MP_MARK) === 0) {
                        var clIdx = parseInt(clCmt.substring(MP_MARK.length), 10);
                        clLyr.comment = (!isNaN(clIdx) && originalComments[clIdx] !== undefined) ? originalComments[clIdx] : "";
                    }
                } catch (eCL) { }
            }

            // Restore Multi-Selection State programmatically
            var layerIndex;
            for (layerIndex = 1; layerIndex <= comp.numLayers; layerIndex++) {
                try { comp.layer(layerIndex).selected = false; } catch (e) { }
            }
            for (layerIndex = 0; layerIndex < resultingPrecompLayers.length; layerIndex++) {
                try { resultingPrecompLayers[layerIndex].selected = true; } catch (e) { }
            }

            return encodeBridge("OK:" + precompedCount + " layers individually precomped");
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (err) {
        return encodeBridge("Multi Precomp Error: " + err.toString());
    }
}

function toolkitTrueDuplicate() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge("Open a composition first.");
        }

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return encodeBridge("Select precomp layers first.");
        }

        app.beginUndoGroup("True Duplicate");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            var duplicateCount = 0;

            // Comp-name lookup set built ONCE for the whole run instead of a full
            // project rescan per candidate name (Req 6). Every name handed out is
            // folded back in, so clones created during this run still collide
            // correctly. "n" prefix avoids Object.prototype name clashes.
            var localCompNames = {};
            try {
                var nameScan;
                for (nameScan = 1; nameScan <= app.project.numItems; nameScan++) {
                    var scanItem = app.project.item(nameScan);
                    if (scanItem instanceof CompItem) localCompNames["n" + scanItem.name] = true;
                }
            } catch (eNameScan) { }

            // Recursive deep duplication of composition and nested precomps
            function deepDuplicateComp(c, map) {
                var originalId = c.id;
                if (map[originalId]) {
                    return map[originalId];
                }

                var baseName = c.name + "_COPY";
                var uniqueName = baseName;
                var counter = 1;
                while (localCompNames["n" + uniqueName]) {
                    uniqueName = baseName + " " + counter;
                    counter++;
                }
                localCompNames["n" + uniqueName] = true;

                var clonedComp = c.duplicate();
                clonedComp.name = uniqueName;
                map[originalId] = clonedComp;

                // Recurse down inside the cloned composition to clone any nested precomps
                var j;
                for (j = 1; j <= clonedComp.numLayers; j++) {
                    var layer = clonedComp.layer(j);
                    if (layer.source && layer.source instanceof CompItem) {
                        var nestedComp = layer.source;
                        var newNested = deepDuplicateComp(nestedComp, map);
                        layer.replaceSource(newNested, true);
                    }
                }

                return clonedComp;
            }

            // Gather unlocked composition layers
            var targetLayers = [];
            var i;
            for (i = 0; i < sel.length; i++) {
                var layer = sel[i];
                if (!layer.locked && layer.source && layer.source instanceof CompItem) {
                    targetLayers.push(layer);
                }
            }

            if (targetLayers.length === 0) {
                return encodeBridge("Select at least one unlocked precomp layer.");
            }

            // Iterate and duplicate each layer and its source.
            // Share ONE map across the whole selection so layers that reference the
            // same (nested) source comp resolve to a single shared duplicate rather
            // than producing redundant "_COPY"/"_COPY 1" clones.
            var dupMap = {};
            for (i = 0; i < targetLayers.length; i++) {
                var layer = targetLayers[i];
                var sourceComp = layer.source;

                // 1. Deep duplicate the source comp to make it fully independent
                var uniqueSource = deepDuplicateComp(sourceComp, dupMap);

                // 2. Duplicate the layer in the timeline. 
                // In AE, layer.duplicate() returns the duplicate layer and places it directly above original.
                var duplicateLayer = layer.duplicate();

                // 3. Replace the source of the duplicated layer
                duplicateLayer.replaceSource(uniqueSource, true);

                // 4. Set the name of the duplicated layer to [originalLayer.name]_COPY
                duplicateLayer.name = layer.name + "_COPY";

                duplicateCount++;
            }

            return encodeBridge("OK:Independent duplicate created");
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (err) {
        return encodeBridge("True Duplicate Error: " + err.toString());
    }
}

function toolkitImportPastedImage(pathHex) {
    try {
        var filePath = cleanStr(decodeBridge(pathHex));
        var imgFile = new File(filePath);
        if (!imgFile.exists) {
            return encodeBridge("Pasted image file not found on disk!");
        }

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge("Open a composition first.");
        }

        app.beginUndoGroup("Paste Clipboard Image");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            // Import footage
            var footageItem = app.project.importFile(new ImportOptions(imgFile));

            // Add layer, align with CTI/comp.time, and center
            var layer = comp.layers.add(footageItem);
            try { layer.startTime = comp.time; } catch (eTime) { }
            try {
                var centerPos = [comp.width / 2, comp.height / 2];
                if (layer.threeDLayer) centerPos.push(0);
                layer.property("ADBE Transform Group").property("ADBE Position").setValue(centerPos);
            } catch (ePos) { }

            // Select only new pasted layer
            var i;
            for (i = 1; i <= comp.numLayers; i++) {
                try { comp.layer(i).selected = false; } catch (e) { }
            }
            layer.selected = true;

            // Req 6.3: a newly added/centered layer changes the visible frame - refresh once.
            if (typeof forceCompViewerRefresh === "function") {
                try { forceCompViewerRefresh(comp); } catch (eR) { }
            }

            return encodeBridge("OK:Pasted clipboard image centered!");
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (err) {
        return encodeBridge("Import Paste Error: " + err.toString());
    }
}

function toolkitImportClipboardImage() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge("Open a composition first.");
        }

        var tempFolder = Folder.temp;
        var tempBase = tempFolder.fsName;
        var exePath = tempBase + "\\compsaver_clip.exe";
        var resultPath = tempBase + "\\compsaver_clip_result.txt";
        var exeFile = new File(exePath);

        // 1. Check if the compiled clipboard tool already exists. If not, compile it once.
        if (!exeFile.exists) {
            var cscPaths = [
                "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
                "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"
            ];
            var cscPath = null;
            var i;
            for (i = 0; i < cscPaths.length; i++) {
                var f = new File(cscPaths[i]);
                if (f.exists) {
                    cscPath = cscPaths[i];
                    break;
                }
            }

            if (!cscPath) {
                return encodeBridge("Paste Error: .NET Compiler (csc.exe) not found on machine.");
            }

            var csPath = tempBase + "\\compsaver_clip.cs";
            var csFile = new File(csPath);
            var csCode =
                'using System;\n' +
                'using System.Drawing;\n' +
                'using System.Drawing.Imaging;\n' +
                'using System.Windows.Forms;\n' +
                'using System.IO;\n' +
                'class CompSaverClip {\n' +
                '    [STAThread]\n' +
                '    static void Main() {\n' +
                '        string result = "EMPTY";\n' +
                '        try {\n' +
                '            if (Clipboard.ContainsImage()) {\n' +
                '                Image img = Clipboard.GetImage();\n' +
                '                string path = Path.Combine(Path.GetTempPath(), "compsaver_paste_" + DateTime.Now.Ticks + ".png");\n' +
                '                img.Save(path, ImageFormat.Png);\n' +
                '                result = "IMAGE:" + path;\n' +
                '            } else if (Clipboard.ContainsFileDropList()) {\n' +
                '                var files = Clipboard.GetFileDropList();\n' +
                '                if (files.Count > 0) {\n' +
                '                    result = "FILE:" + files[0];\n' +
                '                }\n' +
                '            }\n' +
                '        } catch (Exception ex) {\n' +
                '            result = "ERROR:" + ex.Message;\n' +
                '        }\n' +
                '        try {\n' +
                '            File.WriteAllText(@"' + resultPath.replace(/\\/g, "\\\\") + '", result);\n' +
                '        } catch {} \n' +
                '    }\n' +
                '}\n';

            csFile.open("w");
            csFile.write(csCode);
            csFile.close();

            var batPath = tempBase + "\\compsaver_compile.bat";
            var batFile = new File(batPath);
            batFile.open("w");
            batFile.write('@echo off\r\n');
            batFile.write('"' + cscPath + '" /nologo /out:"' + exePath + '" /r:System.Windows.Forms.dll /r:System.Drawing.dll "' + csPath + '"\r\n');
            batFile.close();

            system.callSystem('cmd.exe /c "' + batPath + '"');

            try { csFile.remove(); } catch (e) { }
            try { batFile.remove(); } catch (e) { }

            if (!exeFile.exists) {
                return encodeBridge("Paste Error: Dynamic compilation of clipboard helper failed.");
            }
        }

        // 2. Execute compiled C# clipboard extraction tool directly (bypassing cmd.exe for 10x performance speedup)
        system.callSystem('"' + exePath + '"');

        // 3. Read output from result text file
        var resFile = new File(resultPath);
        if (!resFile.exists) {
            return encodeBridge("Paste Error: Clipboard tool output not generated.");
        }

        resFile.open("r");
        var stdout = resFile.read();
        resFile.close();
        try { resFile.remove(); } catch (e) { }

        if (!stdout) {
            return encodeBridge("Paste Error: Clipboard tool returned empty result.");
        }

        var result = stdout.toString().replace(/^\s+|\s+$/g, ""); // trim

        if (result.indexOf("IMAGE:") === 0) {
            var imgPath = result.substring(6).replace(/\\/g, "/");
            return importImageFromFilePath(imgPath);
        } else if (result.indexOf("FILE:") === 0) {
            var filePath = result.substring(5).replace(/\\/g, "/");
            var ext = filePath.substring(filePath.lastIndexOf(".") + 1).toLowerCase();
            var isImg = (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "bmp");
            if (isImg) {
                return importImageFromFilePath(filePath);
            } else {
                return encodeBridge("Copied file is not an image!");
            }
        } else if (result.indexOf("ERROR:") === 0) {
            return encodeBridge("Clipboard Tool Error: " + result.substring(6));
        } else {
            return encodeBridge("No image in clipboard!");
        }

    } catch (err) {
        return encodeBridge("Paste Error: " + err.toString());
    }

    function importImageFromFilePath(filePath) {
        try {
            var imgFile = new File(filePath);
            if (!imgFile.exists) {
                return encodeBridge("Pasted image file not found on disk!");
            }

            app.beginUndoGroup("Paste Clipboard Image");
            // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
            try {

                // Import footage
                var footageItem = app.project.importFile(new ImportOptions(imgFile));

                // Add layer, align with CTI/comp.time, and center
                var layer = comp.layers.add(footageItem);
                try { layer.startTime = comp.time; } catch (eTime) { }
                try {
                    var centerPos = [comp.width / 2, comp.height / 2];
                    if (layer.threeDLayer) centerPos.push(0);
                    layer.property("ADBE Transform Group").property("ADBE Position").setValue(centerPos);
                } catch (ePos) { }

                // Select only new pasted layer
                var i;
                for (i = 1; i <= comp.numLayers; i++) {
                    try { comp.layer(i).selected = false; } catch (e) { }
                }
                layer.selected = true;

                // Req 6.3: a newly added/centered layer changes the visible frame - refresh once.
                if (typeof forceCompViewerRefresh === "function") {
                    try { forceCompViewerRefresh(comp); } catch (eR) { }
                }

                return encodeBridge("OK:Pasted clipboard image centered!");
            } finally {
                try { app.endUndoGroup(); } catch (eUG) { }
            }
        } catch (eImport) {
            return encodeBridge("Import Error: " + eImport.toString());
        }
    }
}

function toolkitDeCompose() {
    try {
        var comp = getSafeActiveComp ? getSafeActiveComp() : app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge("Open a composition first.");
        }

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return encodeBridge("Select precomp layers first.");
        }

        var targets = [];
        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            if (!layer.locked && layer.source && layer.source instanceof CompItem) {
                targets.push(layer);
            }
        }

        if (targets.length === 0) {
            return encodeBridge("Select at least one unlocked precomp layer.");
        }

        app.beginUndoGroup("De-compose Precomp(s)");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit — normal
        // return, early return or thrown error — via the finally at the end of
        // this block. The body below is intentionally left at its original
        // indentation to keep this fix reviewable.
        try {
        var decompedCount = 0;
        var skippedCount = 0;
        var skippedReason = "";

        // Sort bottom-to-top
        targets.sort(function (a, b) { return b.index - a.index; });

        for (var t = 0; t < targets.length; t++) {
            var preLayer = targets[t];
            var sourceComp = preLayer.source;

            if (preLayer.timeRemapEnabled) {
                skippedCount++;
                skippedReason = "Time Remap not supported.";
                continue;
            }

            // Check if we need a Controller Null (due to Scale/Rotation/3D/Parent)
            var requiresController = false;
            try {
                var sProp = preLayer.property("ADBE Transform Group").property("ADBE Scale");
                var rZProp = preLayer.property("ADBE Transform Group").property("ADBE Rotate Z");
                var rXProp = preLayer.property("ADBE Transform Group").property("ADBE Rotate X");
                var rYProp = preLayer.property("ADBE Transform Group").property("ADBE Rotate Y");
                var oProp = preLayer.property("ADBE Transform Group").property("ADBE Opacity");
                
                if (sProp && (Math.abs(sProp.value[0] - 100) > 0.01 || Math.abs(sProp.value[1] - 100) > 0.01)) requiresController = true;
                if (rZProp && Math.abs(rZProp.value) > 0.01) requiresController = true;
                if (rXProp && Math.abs(rXProp.value) > 0.01) requiresController = true;
                if (rYProp && Math.abs(rYProp.value) > 0.01) requiresController = true;
                if (oProp && Math.abs(oProp.value - 100) > 0.01) requiresController = true;
                if (preLayer.threeDLayer || preLayer.parent) requiresController = true;
            } catch (eCheck) { }

            var pStart = preLayer.startTime;
            var pIn = preLayer.inPoint;
            var pOut = preLayer.outPoint;
            var pStretch = preLayer.stretch / 100;
            
            // Anchor/Position may be missing on exotic layer types (or throw when
            // the property tree is unavailable). Previously `.value` was read off a
            // possibly-null property, so ONE bad layer threw out of the loop and
            // aborted the whole De-compose run — including layers already
            // processed. Skip just that layer with a reason instead. (Req 4)
            var anchorProp = toolkitGetAnchorProp(preLayer);
            var positionProp = toolkitGetPositionProp(preLayer);
            if (!anchorProp || !positionProp) {
                skippedCount++;
                skippedReason = "Anchor Point/Position unavailable on '" + preLayer.name + "'.";
                continue;
            }
            var anchor, position;
            try {
                anchor = anchorProp.value || [0, 0, 0];
                position = positionProp.value || [0, 0, 0];
            } catch (eAP) {
                skippedCount++;
                skippedReason = "Could not read Anchor Point/Position on '" + preLayer.name + "'.";
                continue;
            }
            var shift = [
                position[0] - anchor[0],
                position[1] - anchor[1],
                position.length > 2 && anchor.length > 2 ? position[2] - anchor[2] : 0
            ];
            var hasShift = Math.abs(shift[0]) > 0.001 || Math.abs(shift[1]) > 0.001 || Math.abs(shift[2] || 0) > 0.001;

            var restored = 0;
            var map = {};
            var sourceNumLayers = sourceComp.numLayers;
            var rootLayers = [];

            // 1. Copy layers FORWARD (1 to N)
            for (var i = 1; i <= sourceNumLayers; i++) {
                try {
                    var sl = sourceComp.layer(i);
                    var parentIndex = sl.parent ? sl.parent.index : 0;
                    
                    var slStretch = 100, slStartTime = 0, slInPoint = 0, slOutPoint = 1;
                    try { slStretch = sl.stretch; } catch(e){}
                    try { slStartTime = sl.startTime; } catch(e){}
                    try { slInPoint = sl.inPoint; } catch(e){}
                    try { slOutPoint = sl.outPoint; } catch(e){}
                    
                    sl.copyToComp(comp);
                    var nl = comp.layer(1);
                    if (nl.locked) nl.locked = false;
                    
                    map[i] = {
                        nl: nl,
                        parentIndex: parentIndex,
                        slStretch: slStretch,
                        slStartTime: slStartTime,
                        slInPoint: slInPoint,
                        slOutPoint: slOutPoint
                    };
                    restored++;
                } catch (eC) {}
            }

            if (restored === 0) {
                skippedCount++;
                skippedReason = "No inner layers.";
                continue;
            }

            // 2. Move layers into correct order directly above preLayer
            var targetLayer = preLayer;
            for (var i = sourceNumLayers; i >= 1; i--) {
                if (map[i]) {
                    try {
                        map[i].nl.moveBefore(targetLayer);
                        targetLayer = map[i].nl;
                    } catch (eMove) {}
                }
            }

            // 3. Timing and Parenting Restoration
            for (var i = 1; i <= sourceNumLayers; i++) {
                if (map[i]) {
                    try {
                        var nl = map[i].nl;
                        var pIdx = map[i].parentIndex;

                        // Timing
                        try { nl.stretch = map[i].slStretch * pStretch; } catch(e) {}
                        try { nl.startTime = pStart + (map[i].slStartTime * pStretch); } catch(e) {}
                        
                        var targetIn = pStart + (map[i].slInPoint * pStretch);
                        var targetOut = pStart + (map[i].slOutPoint * pStretch);
                        if (pStretch < 0) {
                            var temp = targetIn;
                            targetIn = targetOut;
                            targetOut = temp;
                        }
                        
                        var finalIn = Math.max(targetIn, pIn);
                        var finalOut = Math.min(targetOut, pOut);
                        
                        if (finalIn < finalOut) {
                            if (finalIn > nl.outPoint) {
                                try { nl.outPoint = finalOut; } catch(e) {}
                                try { nl.inPoint = finalIn; } catch(e) {}
                            } else {
                                try { nl.inPoint = finalIn; } catch(e) {}
                                try { nl.outPoint = finalOut; } catch(e) {}
                            }
                        } else {
                            try { nl.inPoint = finalIn; } catch(e) {}
                            try { nl.outPoint = finalIn + comp.frameDuration; } catch(e) {}
                            try { nl.enabled = false; } catch(e) {}
                        }

                        // Parenting
                        if (pIdx > 0 && map[pIdx]) {
                            nl.parent = map[pIdx].nl;
                        } else {
                            rootLayers.push(nl);
                            // If NO controller is needed, apply manual shift
                            if (!requiresController && hasShift) {
                                var posProp = toolkitGetPositionProp(nl);
                                if (posProp) {
                                    if (posProp.numKeys > 0) {
                                        if (posProp.dimensionsSeparated) {
                                            var tr = toolkitGetTransform(nl);
                                            if (tr) {
                                                toolkitOffsetPropKeyframes(tr.property("ADBE Position_0"), [shift[0]]);
                                                toolkitOffsetPropKeyframes(tr.property("ADBE Position_1"), [shift[1]]);
                                                toolkitOffsetPropKeyframes(tr.property("ADBE Position_2"), [shift[2]]);
                                            }
                                        } else {
                                            toolkitOffsetPropKeyframes(posProp, shift);
                                        }
                                    } else {
                                        var curPos = toolkitPropValueAt(posProp, comp.time);
                                        if (curPos) {
                                            var nextPos = [curPos[0] + shift[0], curPos[1] + shift[1], (curPos[2] || 0) + shift[2]];
                                            toolkitSetPositionToPoint(nl, nextPos, comp.time);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (eProc) {}
                }
            }

            // 4. Handle preLayer (Remove or Convert to Controller)
            if (requiresController) {
                try {
                    // Parent all root layers to the precomp layer
                    for (var r = 0; r < rootLayers.length; r++) {
                        rootLayers[r].parent = preLayer;
                    }
                    
                    // Replace source with a Null Solid
                    var dummyNull = comp.layers.addNull();
                    var nullSource = dummyNull.source;
                    dummyNull.remove();
                    
                    preLayer.replaceSource(nullSource, false);
                    preLayer.name = preLayer.name + " Controller";
                } catch (eCtrl) { }
            } else {
                if (preLayer.locked) preLayer.locked = false;
                preLayer.remove();
            }
            
            decompedCount++;
        }

        if (decompedCount > 0) {
            var msg = "OK:" + decompedCount + " precomp(s) decomposed";
            if (skippedCount > 0) msg += " (" + skippedCount + " skipped)";
            return encodeBridge(msg);
        } else {
            return encodeBridge("Decompose skipped: " + skippedReason);
        }
        } finally {
            // Req 9.1/9.2: always close the undo group, normal or error path.
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (err) {
        var msg = "Err: " + err.toString();
        if (msg.length > 70) msg = msg.substring(0, 70) + "...";
        return encodeBridge(msg);
    }
}

// =========================================================
// COMPACT COLORFLOW BACKEND
// =========================================================

function hexToFloatRgb(hex) {
    if (hex.charAt(0) === "#") hex = hex.substring(1);
    if (hex.length === 3) {
        hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }
    var r = parseInt(hex.substring(0, 2), 16) / 255;
    var g = parseInt(hex.substring(2, 4), 16) / 255;
    var b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b];
}

function recolorShapeProperties(propGroup, rgb, isStroke) {
    if (!propGroup) return;
    var i;
    for (i = 1; i <= propGroup.numProperties; i++) {
        var prop = propGroup.property(i);
        if (prop instanceof Property) {
            if (isStroke) {
                if (prop.matchName === "ADBE Vector Stroke Color" || (prop.name === "Color" && prop.parent && prop.parent.matchName === "ADBE Vector Graphic - Stroke")) {
                    try { prop.setValue(rgb); } catch (e) { }
                }
            } else {
                if (prop.matchName === "ADBE Vector Fill Color" || (prop.name === "Color" && prop.parent && prop.parent.matchName === "ADBE Vector Graphic - Fill")) {
                    try { prop.setValue(rgb); } catch (e) { }
                }
            }
        } else if (prop instanceof PropertyGroup) {
            recolorShapeProperties(prop, rgb, isStroke);
        }
    }
}

function applyColorToLayer(layer, rgb, isStroke) {
    try {
        if (layer instanceof ShapeLayer) {
            var vectors = layer.property("ADBE Root Vectors Group");
            if (vectors) {
                recolorShapeProperties(vectors, rgb, isStroke);
                return true;
            }
        } else if (isTextLayer(layer)) {
            var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
            if (textProp) {
                var textDocument = textProp.value;
                if (isStroke) {
                    textDocument.strokeColor = rgb;
                    textDocument.applyStroke = true;
                } else {
                    textDocument.fillColor = rgb;
                    textDocument.applyFill = true;
                }
                textProp.setValue(textDocument);
                return true;
            }
        } else if (layer instanceof AVLayer) {
            var applied = false;
            if (layer.source && layer.source.mainSource && layer.source.mainSource instanceof SolidSource) {
                layer.source.mainSource.color = rgb;
                applied = true;
            }
            // Essential Graphics color properties support
            try {
                var essentialProps = layer.property("ADBE Essential Properties");
                if (essentialProps) {
                    for (var j = 1; j <= essentialProps.numProperties; j++) {
                        var p = essentialProps.property(j);
                        if (p.propertyValueType === PropertyValueType.COLOR) {
                            p.setValue(rgb);
                            applied = true;
                        }
                    }
                }
            } catch (errProps) { }
            if (applied) return true;
        }
    } catch (e) { }
    return false;
}

// =========================================================
// LABEL COLOR — additive path, isolated from fill/stroke engine
// =========================================================

// Default After Effects label colors (indexes 1..16). Index 0 = "None".
// These match AE's stock label palette as approximate float-RGB values.
// Users who customize their label palette in AE preferences will get the index
// nearest to AE defaults — acceptable trade-off vs. brittle preference reads.
var CS_DEFAULT_LABEL_COLORS = [
    [0.886, 0.231, 0.216], // 1  Red
    [0.984, 0.808, 0.122], // 2  Yellow
    [0.482, 0.792, 0.722], // 3  Aqua
    [1.000, 0.690, 0.690], // 4  Pink
    [0.643, 0.408, 0.851], // 5  Lavender
    [1.000, 0.886, 0.749], // 6  Peach
    [0.741, 0.871, 0.713], // 7  Sea Foam
    [0.396, 0.451, 0.902], // 8  Blue
    [0.541, 0.831, 0.467], // 9  Green
    [0.792, 0.353, 0.604], // 10 Purple
    [0.969, 0.643, 0.290], // 11 Orange
    [0.706, 0.298, 0.298], // 12 Brown
    [1.000, 0.408, 0.451], // 13 Fuchsia
    [0.149, 0.671, 0.875], // 14 Cyan
    [0.961, 0.847, 0.624], // 15 Sandstone
    [0.196, 0.396, 0.196]  // 16 Dark Green
];

function findClosestLabelIndex(rgb) {
    var bestIdx = 1;
    var bestDist = -1;
    var i;
    for (i = 0; i < CS_DEFAULT_LABEL_COLORS.length; i++) {
        var lc = CS_DEFAULT_LABEL_COLORS[i];
        var dr = rgb[0] - lc[0];
        var dg = rgb[1] - lc[1];
        var db = rgb[2] - lc[2];
        // Squared Euclidean distance — no need for sqrt for comparison
        var dist = dr * dr + dg * dg + db * db;
        if (bestDist < 0 || dist < bestDist) {
            bestDist = dist;
            bestIdx = i + 1; // labels are 1..16
        }
    }
    return bestIdx;
}

function applyLabelColorToLayer(layer, rgb) {
    try {
        if (!layer) return false;
        var idx = findClosestLabelIndex(rgb);
        layer.label = idx;
        return true;
    } catch (e) {
        return false;
    }
}

function toolkitPickColor(defaultColorHex) {
    try {
        var defaultRgb = [1, 0, 0];
        if (defaultColorHex) {
            defaultRgb = hexToFloatRgb(decodeBridge(defaultColorHex));
        }

        var comp = app.project.activeItem;
        var tempLayer = null;
        var createdComp = false;

        app.beginUndoGroup("ColorFlow: Eyedropper");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            if (!comp || !(comp instanceof CompItem)) {
                comp = app.project.items.addComp("CF_TempPick", 100, 100, 1, 1, 30);
                createdComp = true;
            }

            tempLayer = comp.layers.addNull();
            tempLayer.name = "ColorFlow_Eyedropper_Temp";

            var effect = tempLayer.property("ADBE Effect Parade").addProperty("ADBE Color Control");
            var prop = effect.property(1);
            prop.setValue(defaultRgb);
            prop.selected = true;

            app.executeCommand(2240); // Opens native AE system color picker (including eyedropper)

            var val = prop.value;

            // Clean up
            tempLayer.remove();
            if (createdComp) {
                comp.remove();
            }

            var r = Math.round(val[0] * 255);
            var g = Math.round(val[1] * 255);
            var b = Math.round(val[2] * 255);
            var rHex = r.toString(16).toUpperCase();
            var gHex = g.toString(16).toUpperCase();
            var bHex = b.toString(16).toUpperCase();
            if (rHex.length < 2) rHex = "0" + rHex;
            if (gHex.length < 2) gHex = "0" + gHex;
            if (bHex.length < 2) bHex = "0" + bHex;

            return encodeBridge("#" + rHex + gHex + bHex);
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (e) {
        if (tempLayer) {
            try { tempLayer.remove(); } catch (err) { }
        }
        return encodeBridge("ERROR: " + e.toString());
    }
}


function toolkitApplyColor(colorHexHex, targetTypeHex) {
    try {
        var colorHex = decodeBridge(colorHexHex);
        var targetType = decodeBridge(targetTypeHex);

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge("Open a composition first.");
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return encodeBridge("Select layers first.");
        }

        app.beginUndoGroup("ColorFlow: Apply Color");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            var rgb = hexToFloatRgb(colorHex);
            var isLabel = (targetType === "label");
            var isStroke = (targetType === "stroke");
            var appliedCount = 0;

            for (var i = 0; i < sel.length; i++) {
                var layer = sel[i];

                // Req 4.6: LIGHT-unlock the layer so a locked/shy layer can still be
                // recolored, capturing its Original Layer State first; restore that
                // lock/shy state right after the edit so the user's setup is preserved.
                var csOrig = null;
                if (typeof unlockLayerForEdit === "function") {
                    try { csOrig = unlockLayerForEdit(layer, comp); } catch (ePrep) { csOrig = null; }
                }

                var success;
                if (isLabel) {
                    success = applyLabelColorToLayer(layer, rgb);
                } else {
                    success = applyColorToLayer(layer, rgb, isStroke);
                }
                if (success) appliedCount++;

                if (csOrig && typeof restoreLayerState === "function") {
                    try { restoreLayerState(layer, csOrig); } catch (eRest) { }
                }
            }

            // Req 6.3: fill/stroke/label color changes what should be visible -
            // force a single viewer refresh once the whole batch is done.
            if (typeof forceCompViewerRefresh === "function") {
                try { forceCompViewerRefresh(comp); } catch (eRef) { }
            }

            var msg = isLabel
                ? ("OK:Set label on " + appliedCount + " layer(s)")
                : ("OK:Applied color to " + appliedCount + " layer(s)");
            return encodeBridge(msg);
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (e) {
        return encodeBridge("ColorFlow Error: " + e.toString());
    }
}

function toolkitExportPalette(paletteNameHex, jsonStrHex) {
    try {
        var name = decodeBridge(paletteNameHex);
        var jsonStr = decodeBridge(jsonStrHex);

        var file = File.saveDialog("Export ColorFlow Palette", "JSON Palette:*.json");
        if (file) {
            file.open("w");
            file.write(jsonStr);
            file.close();
            return encodeBridge("true");
        }
        return encodeBridge("false");
    } catch (e) {
        return encodeBridge("Export Error: " + e.toString());
    }
}

function toolkitImportPalette() {
    try {
        var file = File.openDialog("Import ColorFlow Palette", "JSON Palette:*.json");
        if (file && file.exists) {
            file.open("r");
            var content = file.read();
            file.close();
            return encodeBridge(content);
        }
        return encodeBridge("false");
    } catch (e) {
        return encodeBridge("Import Error: " + e.toString());
    }
}

function getTargetEffectForSave() {
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return null;
        var sel = comp.selectedLayers;
        if (!sel || sel.length !== 1) return null; // Enforce exactly one layer

        var layer = sel[0];
        var fxGroup = null;
        try { fxGroup = layer.property("ADBE Effect Parade"); } catch (e) {
            try { fxGroup = layer.Effects; } catch (e2) { return null; }
        }
        if (!fxGroup || fxGroup.numProperties === 0) return null;

        // Priority 1: Check each effect directly for .selected === true (Effect Controls & Timeline selection)
        try {
            for (var fi = 1; fi <= fxGroup.numProperties; fi++) {
                var eff = fxGroup.property(fi);
                if (eff && eff.selected) {
                    return eff;
                }
            }
        } catch (eEffSel) { }

        // Priority 2: Check layer.selectedProperties and walk up to ADBE Effect Parade
        try {
            var selProps = layer.selectedProperties;
            if (selProps && selProps.length > 0) {
                var i;
                for (i = 0; i < selProps.length; i++) {
                    try {
                        var prop = selProps[i];
                        var p = prop;
                        while (p && p.parentProperty && p.parentProperty.matchName !== "ADBE Effect Parade") {
                            p = p.parentProperty;
                        }
                        if (p && p.parentProperty && p.parentProperty.matchName === "ADBE Effect Parade") {
                            return p;
                        }
                    } catch (eP) { }
                }
            }
        } catch (eSel) { }

        // Priority 3: Check comp.selectedProperties
        try {
            if (comp.selectedProperties && comp.selectedProperties.length > 0) {
                for (var ci = 0; ci < comp.selectedProperties.length; ci++) {
                    try {
                        var cp = comp.selectedProperties[ci];
                        while (cp && cp.parentProperty && cp.parentProperty.matchName !== "ADBE Effect Parade") {
                            cp = cp.parentProperty;
                        }
                        if (cp && cp.parentProperty && cp.parentProperty.matchName === "ADBE Effect Parade") {
                            return cp;
                        }
                    } catch (eCP) { }
                }
            }
        } catch (eCompSel) { }

        // Priority 4 (Fallback): If exactly one layer is selected with effects, return its first effect
        if (fxGroup.numProperties > 0) {
            return fxGroup.property(1);
        }

        return null;
    } catch (e) {
        return null;
    }
}

/**
 * Builds a filesystem-safe file name from an effect name.
 * Strips illegal characters, trims whitespace, appends .ffx.
 */
function buildEffectFileName(effectName) {
    var name = "" + (effectName || "Effect");
    var illegal = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    var i;
    for (i = 0; i < illegal.length; i++) {
        name = name.split(illegal[i]).join("_");
    }
    name = name.replace(/\s+/g, " ").replace(/_+/g, "_");
    name = name.replace(/^\s+|\s+$/g, "");
    if (!name) name = "Effect";
    return name + ".cseffect";
}

/**
 * Silent auto-save pipeline.
 * No dialogs. No prompts. Auto-detects effect name. Writes silently to target.
 * Argument: hex-encoded absolute target path.
 * Returns encoded JSON: { ok: bool, name: string, path: string, error: string }
 */
function toolkitSaveEffectPreset(pathHex) {
    try {
        var presetsPath = decodeBridge(pathHex || "");
        if (!presetsPath) {
            return encodeBridge('{"ok":false,"error":"No target presets directory specified"}');
        }

        // ── 1. Validate composition ──────────────────────────────────────────
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }

        var sel = comp.selectedLayers;
        if (!sel || sel.length !== 1) {
            return encodeBridge('{"ok":false,"error":"Exactly ONE single layer must be selected in the timeline"}');
        }

        var layer = sel[0];

        // ── 2. Find the target effect ────────────────────────────────────────
        var targetEffect = getTargetEffectForSave();
        if (!targetEffect) {
            return encodeBridge('{"ok":false,"error":"Select an effect in Effect Controls"}');
        }

        var effectName = "";
        try { effectName = targetEffect.name || ""; } catch (eN) { effectName = ""; }
        if (!effectName) effectName = "Effect";

        // ── 3. Serialize effect to custom JSON ───────────────────────────────
        var effData = serializeEffect(targetEffect);
        if (!effData) {
            return encodeBridge('{"ok":false,"error":"Could not serialize the selected effect"}');
        }

        var serializedJson = serializeEffectToJson(effData);
        var fullJson = '{"version":1,"effects":[' + serializedJson + ']}';

        // ── 4. Resolve save destination ──────────────────────────────────────
        var folderObj = new Folder(presetsPath);
        if (!folderObj.exists) {
            try { folderObj.create(); } catch (eC) { }
        }
        if (!folderObj.exists) {
            return encodeBridge('{"ok":false,"error":"Failed to create presets target directory"}');
        }

        var fileName = buildEffectFileName(effectName);

        // Handle name collisions: append (2), (3), … until unique
        var destPath = presetsPath + "/" + fileName;
        try {
            var attempt = 1;
            while (new File(destPath).exists) {
                attempt++;
                var base = fileName.replace(/\.cseffect$/i, "");
                destPath = presetsPath + "/" + base + " (" + attempt + ").cseffect";
            }
        } catch (eCol) { /* keep original destPath */ }

        var destFile = new File(destPath);

        // ── 5. Silent write directly to disk ──────────────────────────────────
        try {
            destFile.encoding = "UTF-8";
            destFile.open("w");
            destFile.write(fullJson);
            destFile.close();
        } catch (eSave) {
            try { destFile.close(); } catch (eC) { }
            return encodeBridge('{"ok":false,"error":"Silent background save failed: ' + escapeJSON("" + eSave) + '"}');
        }

        if (!destFile.exists) {
            return encodeBridge('{"ok":false,"error":"Effect file was not created on disk"}');
        }

        // ── 6. Return success with path info for the frontend ─────────────────
        var finalPath = destFile.fsName.replace(/\\/g, "/");
        return encodeBridge('{"ok":true,"dialog":false,"name":"' + escapeJSON(effectName) +
            '","file":"' + escapeJSON(destFile.name) +
            '","path":"' + escapeJSON(finalPath) +
            '","presetsDir":"' + escapeJSON(presetsPath) + '"}');

    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Scans the whitelisted directory and returns a JSON payload with:
 *   { presetsDir: string, files: string[] }
 * Argument: hex-encoded whitelisted path string.
 */
function toolkitGetEffectsScan(pathHex) {
    try {
        var presetsPath = decodeBridge(pathHex || "");
        if (!presetsPath) {
            return encodeBridge('{"presetsDir":"","files":[]}');
        }

        var folder = new Folder(presetsPath);
        if (!folder.exists) {
            return encodeBridge('{"presetsDir":"' + escapeJSON(presetsPath) + '","files":[]}');
        }

        var allFiles = folder.getFiles("*.*") || [];
        var names = [];
        var i;
        for (i = 0; i < allFiles.length; i++) {
            if (allFiles[i] instanceof File) {
                var fname = allFiles[i].name;
                if (/\.(ffx|cseffect)$/i.test(fname)) {
                    names.push('"' + escapeJSON(fname) + '"');
                }
            }
        }
        names.sort();

        return encodeBridge('{"presetsDir":"' + escapeJSON(presetsPath) + '","files":[' + names.join(",") + ']}');
    } catch (e) {
        return encodeBridge('{"presetsDir":"","files":[]}');
    }
}

/**
 * Applies a saved .ffx preset to the currently selected layer.
 * Argument: hex-encoded full path to the .ffx file.
 * Returns encoded JSON: { ok: bool, error: string }
 */
function toolkitApplyEffectPreset(pathHex) {
    try {
        var filePath = decodeBridge(pathHex || "");
        if (!filePath) {
            return encodeBridge('{"ok":false,"error":"No file path provided"}');
        }

        filePath = filePath.replace(/\\/g, "/");
        var presetFile = new File(filePath);
        if (!presetFile.exists) {
            return encodeBridge('{"ok":false,"error":"Preset file not found: ' + escapeJSON(filePath) + '"}');
        }

        // ── Validate composition and layer ────────────────────────────────────
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }

        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            // Intelligent fallback: if no layer is explicitly selected, pick first unlocked layer or create adjustment layer
            if (comp.numLayers > 0) {
                for (var li = 1; li <= comp.numLayers; li++) {
                    var cand = comp.layer(li);
                    if (!cand.locked) {
                        cand.selected = true;
                        sel = [cand];
                        break;
                    }
                }
            }
            if (!sel || sel.length === 0) {
                try {
                    var adj = comp.layers.addSolid([1, 1, 1], "Adjustment Layer", comp.width, comp.height, comp.pixelAspect, comp.duration);
                    adj.adjustmentLayer = true;
                    adj.selected = true;
                    sel = [adj];
                } catch (eAdj) { }
            }
        }

        if (!sel || sel.length === 0) {
            return encodeBridge('{"ok":false,"error":"Select a layer to apply the preset to"}');
        }


        // ── Apply preset programmatically ─────────────────────────────────────
        app.beginUndoGroup("Apply Effect Preset");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {
            var appliedCount = 0;
            var i;
            for (i = 0; i < sel.length; i++) {
                var layer = sel[i];

                // Req 4.6: LIGHT-unlock so a locked/shy layer can still receive the
                // preset, capturing its Original Layer State; restore that lock/shy
                // state right after applying so the user's setup is preserved.
                var csOrig = null;
                if (typeof unlockLayerForEdit === "function") {
                    try { csOrig = unlockLayerForEdit(layer, comp); } catch (ePrep) { csOrig = null; }
                }

                if (typeof layer.applyPreset === "function") {
                    layer.applyPreset(presetFile);
                    appliedCount++;
                }

                if (csOrig && typeof restoreLayerState === "function") {
                    try { restoreLayerState(layer, csOrig); } catch (eRest) { }
                }
            }

            // Req 6.3: applying an effect preset changes what should be visible -
            // force a single viewer refresh once the whole batch is done.
            if (typeof forceCompViewerRefresh === "function") {
                try { forceCompViewerRefresh(comp); } catch (eRef) { }
            }

            if (appliedCount > 0) {
                return encodeBridge('{"ok":true}');
            } else {
                return encodeBridge('{"ok":false,"error":"Could not apply preset to any selected layers"}');
            }
        } catch (eApply) {
            return encodeBridge('{"ok":false,"error":"applyPreset failed: ' + escapeJSON("" + eApply) + '"}');
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}

/**
 * Applies a saved custom JSON preset (.cseffect) to the currently selected layer.
 * Argument: hex-encoded full path to the .cseffect file.
 * Returns encoded JSON: { ok: bool, error: string }
 */
function toolkitApplyCustomEffect(pathHex) {
    try {
        var filePath = decodeBridge(pathHex || "");
        if (!filePath) {
            return encodeBridge('{"ok":false,"error":"No file path provided"}');
        }

        filePath = filePath.replace(/\\/g, "/");
        var effectFile = new File(filePath);
        if (!effectFile.exists) {
            return encodeBridge('{"ok":false,"error":"Preset file not found: ' + escapeJSON(filePath) + '"}');
        }

        effectFile.open("r");
        var jsonContent = effectFile.read();
        effectFile.close();

        if (!jsonContent) {
            return encodeBridge('{"ok":false,"error":"Preset file is empty"}');
        }

        var effectData = null;
        try {
            // Security (Phase 1, Task 33 follow-up to Task 31): strict parser
            // instead of eval — preset files come from the shared library and
            // must never execute as code. They are written by
            // serializeEffectToJson (strict JSON), so a strict parse preserves
            // every success path; anything else is reported corrupted exactly
            // as the eval catch did. The typeof guard covers harnesses that
            // could run this file without core.jsx (strict built-in
            // JSON.parse); in the AE host core.jsx is @included first.
            effectData = (typeof jsonParse === "function") ? jsonParse(jsonContent) : JSON.parse(jsonContent);
        } catch (eP) {
            return encodeBridge('{"ok":false,"error":"Preset file is corrupted: ' + eP.toString() + '"}');
        }

        if (!effectData || !effectData.effects || effectData.effects.length === 0) {
            return encodeBridge('{"ok":false,"error":"No effects found in preset data"}');
        }

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return encodeBridge('{"ok":false,"error":"Open a composition first"}');
        }

        var sl = comp.selectedLayers;
        if (!sl || sl.length === 0) {
            // Intelligent fallback: if no layer is explicitly selected, pick first unlocked layer or create adjustment layer
            if (comp.numLayers > 0) {
                for (var sli = 1; sli <= comp.numLayers; sli++) {
                    var slCand = comp.layer(sli);
                    if (!slCand.locked) {
                        slCand.selected = true;
                        sl = [slCand];
                        break;
                    }
                }
            }
            if (!sl || sl.length === 0) {
                try {
                    var adjCust = comp.layers.addSolid([1, 1, 1], "Adjustment Layer", comp.width, comp.height, comp.pixelAspect, comp.duration);
                    adjCust.adjustmentLayer = true;
                    adjCust.selected = true;
                    sl = [adjCust];
                } catch (eAdj2) { }
            }
        }

        if (!sl || sl.length === 0) {
            return encodeBridge('{"ok":false,"error":"Select a layer to apply the preset to"}');
        }

        app.beginUndoGroup("Apply Custom Effect");
        // Undo discipline (Req 9.1/9.2): endUndoGroup runs on every exit via finally.
        try {

            var totalApplied = 0;
            var li;
            for (li = 0; li < sl.length; li++) {
                var targetLayer = sl[li];

                // Req 4.6: LIGHT-unlock so a locked/shy layer can still receive the
                // effect(s), capturing its Original Layer State; restore that lock/shy
                // state after all effects for this layer are applied.
                var csOrig = null;
                if (typeof unlockLayerForEdit === "function") {
                    try { csOrig = unlockLayerForEdit(targetLayer, comp); } catch (ePrep) { csOrig = null; }
                }

                var ei;
                for (ei = 0; ei < effectData.effects.length; ei++) {
                    try {
                        // applyEffectData now returns an internal result object; count
                        // an application as successful only when the effect verified present.
                        var applied = applyEffectData(targetLayer, effectData.effects[ei]);
                        if (applied && applied.success) totalApplied = totalApplied + 1;
                    } catch (eA) { }
                }

                if (csOrig && typeof restoreLayerState === "function") {
                    try { restoreLayerState(targetLayer, csOrig); } catch (eRest) { }
                }
            }

            // Req 6.3: applying custom effects changes what should be visible -
            // force a single viewer refresh once the whole batch is done.
            if (typeof forceCompViewerRefresh === "function") {
                try { forceCompViewerRefresh(comp); } catch (eRef) { }
            }

            if (totalApplied === 0) {
                return encodeBridge('{"ok":false,"error":"Could not apply the custom effect"}');
            }

            return encodeBridge('{"ok":true}');
        } finally {
            try { app.endUndoGroup(); } catch (eUG) { }
        }
    } catch (e) {
        return encodeBridge('{"ok":false,"error":"' + escapeJSON(e.toString()) + '"}');
    }
}



