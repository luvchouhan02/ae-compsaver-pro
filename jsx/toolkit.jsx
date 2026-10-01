// ============================================================
// toolkit.jsx - toolkit core + anchor/align/create/organize/toggle/precompose/clear-cache
// (ExtendScript module - included by compSaver.jsx; functions are global)
// ============================================================

// =========================================================
// TOOLKIT — CORE HELPERS
// =========================================================

var __CS_TOOLKIT_EFFECT_STATES = null;

function __alignLog(msg) { }

// ---------------------------------------------------------
// Layer <-> comp coordinate probe
// ---------------------------------------------------------
// ExtendScript exposes toComp()/fromComp() ONLY to expressions, never to the
// scripting DOM, so the only way to convert a point is to attach an expression
// to a real property and read the evaluated value back. A Point Control on the
// layer's own effect parade is used because it is 3D-aware, has no visual
// effect, and can be removed cleanly.
//
// PERFORMANCE (Req 6 — no behavior change): adding AND removing that control for
// every single queried point is the dominant cost of Align/Anchor (5-7
// add/remove cycles per layer). The probe below is opened ONCE per layer, reused
// for every query on that layer (only the expression string changes — the same
// mechanism the one-shot helpers already relied on), then closed once. The set of
// evaluated (point, expression) pairs is identical, so results are unchanged.
function toolkitOpenProbe(layer) {
    try {
        var effects = layer.property("ADBE Effect Parade");
        if (!effects) return null;
        var control = effects.addProperty("ADBE Point Control");
        if (!control) return null;
        var prop = control.property(1);
        if (!prop) { try { control.remove(); } catch (eR) { } return null; }
        return { control: control, prop: prop };
    } catch (e) {
        return null;
    }
}

// fnName is "toComp" or "fromComp".
function toolkitProbeQuery(probe, fnName, point) {
    if (!probe || !probe.prop) return null;
    try {
        probe.prop.expression = fnName + "([" + (point[0] || 0) + "," + (point[1] || 0) + "," + (point[2] || 0) + "])";
        return probe.prop.value;
    } catch (e) {
        __alignLog("    probe " + fnName + " failed: " + e.toString());
        return null;
    }
}

function toolkitCloseProbe(probe) {
    if (!probe || !probe.control) return;
    try { probe.control.remove(); } catch (e) { }
    probe.control = null;
    probe.prop = null;
}

// One-shot wrappers: kept for callers that convert a single point.
function toolkitToComp(layer, point) {
    var probe = toolkitOpenProbe(layer);
    if (!probe) return null;
    var val = toolkitProbeQuery(probe, "toComp", point);
    toolkitCloseProbe(probe);
    return val;
}

function toolkitFromComp(layer, compPoint) {
    var probe = toolkitOpenProbe(layer);
    if (!probe) return null;
    var val = toolkitProbeQuery(probe, "fromComp", compPoint);
    toolkitCloseProbe(probe);
    return val;
}

function toolkitGetActiveComp() {
    // Delegates to the shared defensive resolver in helpers.jsx
    // (activeItem -> selection -> single-comp -> null precedence). (Req 8.5)
    return resolveActiveComp();
}

function toolkitGetTransform(layer) {
    try {
        var tr = layer.property("ADBE Transform Group");
        if (tr) return tr;
    } catch (e) { }
    try {
        var tr2 = layer.property("Transform");
        if (tr2) return tr2;
    } catch (e2) { }
    return null;
}

// Get the appropriate transform property safely across layer types
function toolkitGetTransformProp(layer, matchName, fallbackName) {
    try {
        // Try direct access first
        if (matchName === "ADBE Anchor Point" && layer.anchorPoint) return layer.anchorPoint;
        if (matchName === "ADBE Position" && layer.position) return layer.position;
    } catch (e) { }

    try {
        var tr = layer.property("ADBE Transform Group");
        if (tr) {
            var p = tr.property(matchName);
            if (p) return p;
            if (fallbackName) {
                p = tr.property(fallbackName);
                if (p) return p;
            }
        }
    } catch (eTr) { }

    try {
        var p2 = layer.property(matchName);
        if (p2) return p2;
    } catch (e2) { }

    return null;
}

function toolkitGetAnchorProp(layer) {
    return toolkitGetTransformProp(layer, "ADBE Anchor Point", "Anchor Point");
}

function toolkitGetPositionProp(layer) {
    return toolkitGetTransformProp(layer, "ADBE Position", "Position");
}

function toolkitPropValueAt(prop, time) {
    try {
        if (prop.numKeys && prop.numKeys > 0) return prop.valueAtTime(time, false);
    } catch (e) { }
    try { return prop.value; } catch (e2) { }
    return null;
}

function toolkitSetPropValue(prop, value, time) {
    // Thin adapter over the shared setPropertyValueSafe helper in helpers.jsx.
    // Preserves the (prop, value, time) signature and boolean return contract
    // so all existing callers keep working. (Req 2.6, 10.1)
    var r = setPropertyValueSafe(prop, toolkitGetActiveComp(), time, value);
    return r && r.success ? true : false;
}

function toolkitPointWithLength(point, length, fallback) {
    var out = [];
    var i;
    for (i = 0; i < length; i++) {
        if (point && i < point.length && point[i] !== undefined && point[i] !== null) out[i] = point[i];
        else if (fallback && i < fallback.length && fallback[i] !== undefined && fallback[i] !== null) out[i] = fallback[i];
        else out[i] = 0;
    }
    return out;
}

function toolkitSetPositionToPoint(layer, point, time) {
    var pos = toolkitGetPositionProp(layer);
    if (!pos || !point) return false;

    try {
        if (pos.dimensionsSeparated) {
            var tr = toolkitGetTransform(layer);
            if (!tr) return false;

            var props = [
                tr.property("ADBE Position_0"),
                tr.property("ADBE Position_1"),
                tr.property("ADBE Position_2")
            ];
            var changed = false;
            var i;
            for (i = 0; i < props.length; i++) {
                if (props[i] && i < point.length) {
                    if (toolkitSetPropValue(props[i], point[i], time)) changed = true;
                }
            }
            return changed;
        }
    } catch (eSep) { }

    var cur = toolkitPropValueAt(pos, time);
    if (!cur) return false;

    return toolkitSetPropValue(pos, toolkitPointWithLength(point, cur.length, cur), time);
}

function toolkitLayerSupportsAnchorPoint(layer) {
    if (!layer || layer.locked) return false;
    // Exclude cameras and lights
    try {
        var type = layer.typename;
        if (type === "CameraLayer" || type === "LightLayer") return false;
    } catch (e) { }

    return !!(toolkitGetAnchorProp(layer) && toolkitGetPositionProp(layer));
}

// Add a delta directly to position (handles separated dims + parent space).
// Uses DIRECT prop.setValue() for non-keyed properties — NEVER creates keyframes.
// For keyed properties, offsets existing keyframes only (no new keys).
function toolkitAddPositionDelta(layer, delta, time) {
    var pos = toolkitGetPositionProp(layer);
    if (!pos) return false;

    try {
        // Separated dimensions
        if (pos.dimensionsSeparated) {
            var tr = toolkitGetTransform(layer);
            if (!tr) return false;
            var anySet = false;
            var px = tr.property("ADBE Position_0");
            var py = tr.property("ADBE Position_1");
            var pz = tr.property("ADBE Position_2");
            if (px && delta[0]) {
                if (px.numKeys > 0) {
                    toolkitOffsetPropKeyframes(px, [delta[0]]);
                    anySet = true;
                } else {
                    // Direct setValue — ZERO keyframes created.
                    var cx = px.value || 0;
                    px.setValue(cx + delta[0]);
                    anySet = true;
                }
            }
            if (py && delta[1]) {
                if (py.numKeys > 0) {
                    toolkitOffsetPropKeyframes(py, [delta[1]]);
                    anySet = true;
                } else {
                    // Direct setValue — ZERO keyframes created.
                    var cy = py.value || 0;
                    py.setValue(cy + delta[1]);
                    anySet = true;
                }
            }
            if (pz && delta[2]) {
                if (pz.numKeys > 0) {
                    toolkitOffsetPropKeyframes(pz, [delta[2]]);
                    anySet = true;
                } else {
                    // Direct setValue — ZERO keyframes created.
                    var cz = pz.value || 0;
                    pz.setValue(cz + delta[2]);
                    anySet = true;
                }
            }
            return anySet;
        }
    } catch (eS) { }

    if (pos.numKeys > 0) {
        toolkitOffsetPropKeyframes(pos, delta);
        return true;
    } else {
        var cur = toolkitPropValueAt(pos, time);
        if (!cur) return false;

        var next = [];
        var i;
        for (i = 0; i < cur.length; i++) {
            next[i] = cur[i] + (delta[i] || 0);
        }
        // Direct setValue — ZERO keyframes created.
        pos.setValue(next);
        return true;
    }
}

// Apply a comp-space delta to layer's position (parent-aware)
function toolkitAddCompDelta(layer, compDelta, time) {
    var dx = compDelta[0] || 0;
    var dy = compDelta[1] || 0;
    var dz = compDelta[2] || 0;
    if (dx === 0 && dy === 0 && dz === 0) return true; // nothing to do

    try {
        // Primary path: use toComp/fromComp to convert comp-space delta to position space.
        // This works for ALL layer types and handles parented layers correctly.
        var anchorProp = toolkitGetAnchorProp(layer);
        var anchor = null;
        if (anchorProp) {
            anchor = toolkitPropValueAt(anchorProp, time);
        }
        // Never fall back to [0,0,0] — it gives wrong comp-space reference.
        // Use layer.toComp with a known layer-space point instead.
        var refComp;
        if (anchor) {
            refComp = toolkitToComp(layer, anchor);
            if (!refComp) throw new Error("toolkitToComp failed on anchor");
            __alignLog("    AddCompDelta: anchor=[" + anchor[0].toFixed(1) + "," + anchor[1].toFixed(1) + "] refComp=[" + refComp[0].toFixed(1) + "," + refComp[1].toFixed(1) + "]");
        } else {
            // Fallback: use [0,0,0] in layer space (top-left of content)
            refComp = toolkitToComp(layer, [0, 0, 0]);
            if (!refComp) throw new Error("toolkitToComp failed on [0,0,0]");
            __alignLog("    AddCompDelta: anchor=NULL, using [0,0,0] refComp=[" + refComp[0].toFixed(1) + "," + refComp[1].toFixed(1) + "]");
        }

        var targetComp = [refComp[0] + dx, refComp[1] + dy, (refComp[2] || 0) + dz];

        // Convert comp-space delta to position space (parent-aware)
        var localDelta;
        if (layer.parent) {
            // ONE probe on the parent for both conversions (was two add/remove cycles).
            var parentProbe = toolkitOpenProbe(layer.parent);
            var a = null;
            var b = null;
            try {
                if (parentProbe) {
                    a = toolkitProbeQuery(parentProbe, "fromComp", refComp);
                    b = toolkitProbeQuery(parentProbe, "fromComp", targetComp);
                }
            } finally {
                toolkitCloseProbe(parentProbe);
            }
            if (!a || !b) throw new Error("toolkitFromComp failed on parent");
            localDelta = [
                b[0] - a[0],
                b[1] - a[1],
                (b.length > 2 && a.length > 2) ? b[2] - a[2] : 0
            ];
            __alignLog("    AddCompDelta: parented, localDelta=[" + localDelta[0].toFixed(1) + "," + localDelta[1].toFixed(1) + "]");
        } else {
            // Unparented: comp space = position space
            localDelta = [dx, dy, dz];
        }

        return toolkitAddPositionDelta(layer, localDelta, time);
    } catch (e) {
        __alignLog("    AddCompDelta: OUTER EXCEPTION: " + e.toString());
        return false;
    }
}

// Returns layer's source rect at time. Falls back to layer width/height.
function toolkitLayerRect(layer, time) {
    var rect = null;
    try { rect = layer.sourceRectAtTime(time, true); } catch (e) { }
    if (rect && rect.width !== undefined && rect.height !== undefined && (rect.width !== 0 && rect.height !== 0)) {
        return rect;
    }
    var w = 0;
    var h = 0;
    try { w = layer.width || 0; } catch (eW) { }
    try { h = layer.height || 0; } catch (eH) { }
    if (w === 0) w = 100;
    if (h === 0) h = 100;
    return { left: 0, top: 0, width: w, height: h };
}

// Compute new anchor target inside layer-space rect
function toolkitTargetFromRect(rect, mode, oldAnchor) {
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    if (mode.indexOf("left") !== -1) x = rect.left;
    else if (mode.indexOf("right") !== -1) x = rect.left + rect.width;
    if (mode.indexOf("top") !== -1) y = rect.top;
    else if (mode.indexOf("bottom") !== -1) y = rect.top + rect.height;
    return [x, y, oldAnchor && oldAnchor.length > 2 ? oldAnchor[2] : 0];
}

function toolkitAnchorTargetForMode(layer, mode, time, oldAnchor) {
    var rect = toolkitLayerRect(layer, time);

    var isNullOrAdj = false;
    try { isNullOrAdj = layer.nullLayer || layer.adjustmentLayer; } catch (eN) { }

    if (isNullOrAdj || !rect || rect.width < 2 || rect.height < 2) {
        var lw = 100, lh = 100;
        try { lw = layer.width || 100; } catch (eW) { }
        try { lh = layer.height || 100; } catch (eH) { }
        rect = { left: 0, top: 0, width: lw, height: lh };
    }

    return toolkitPointWithLength(toolkitTargetFromRect(rect, mode, oldAnchor), oldAnchor.length, oldAnchor);
}

// Safely offset all keyframes of a property
function toolkitOffsetPropKeyframes(prop, delta) {
    if (!prop || !delta) return;
    try {
        if (prop.numKeys > 0) {
            for (var k = 1; k <= prop.numKeys; k++) {
                var val = prop.keyValue(k);
                if (typeof val === "number") {
                    prop.setValueAtKey(k, val + (delta[0] || 0));
                } else {
                    var newVal = [];
                    for (var i = 0; i < val.length; i++) {
                        newVal[i] = val[i] + (delta[i] || 0);
                    }
                    prop.setValueAtKey(k, newVal);
                }
            }
        } else {
            var val2 = prop.value;
            if (typeof val2 === "number") {
                prop.setValue(val2 + (delta[0] || 0));
            } else {
                var newVal2 = [];
                for (var j = 0; j < val2.length; j++) {
                    newVal2[j] = val2[j] + (delta[j] || 0);
                }
                prop.setValue(newVal2);
            }
        }
    } catch (e) { }
}

function toolkitTransformIsSimple(layer) {
    try {
        if (layer.parent) return false;
        if (layer.threeDLayer) return false;
        var tr = toolkitGetTransform(layer);
        if (!tr) return false;
        var scale = tr.property("ADBE Scale").value;
        var rot = tr.property("ADBE Rotate Z").value;
        var op = tr.property("ADBE Opacity").value;
        if (Math.abs(scale[0] - 100) > 0.01 || Math.abs(scale[1] - 100) > 0.01) return false;
        if (Math.abs(rot) > 0.01) return false;
        if (Math.abs(op - 100) > 0.01) return false;
    } catch (e) { }
    return true;
}

// Compute position delta needed to compensate for an anchor point change.
// Uses ONLY the layer's own rotation and scale (not parent transform).
// This is correct for both parented and unparented layers because
// position is measured in parent space, and the layer's own R*S
// transforms from anchor-offset space to parent space.
function toolkitComputePosDelta(layer, anchorDelta, time) {
    var dx = anchorDelta[0] || 0;
    var dy = anchorDelta[1] || 0;
    var dz = anchorDelta[2] || 0;

    // Read layer's own scale
    var sx = 1, sy = 1, sz = 1;
    try {
        var sv = layer.scale.valueAtTime(time, false);
        sx = (sv[0] || 100) / 100;
        sy = (sv[1] || 100) / 100;
        sz = (sv.length > 2 ? (sv[2] || 100) / 100 : 1);
    } catch (eS) { }

    // 3D layer: build full rotation matrix from X/Y/Z rotation + orientation
    if (layer.threeDLayer) {
        try {
            var tr = toolkitGetTransform(layer);
            if (!tr) throw new Error("no transform");

            var rx = 0, ry = 0, rz = 0;
            var ox = 0, oy = 0, oz = 0;
            try { rx = tr.property("ADBE Rotate X").valueAtTime(time, false) || 0; } catch (e) { }
            try { ry = tr.property("ADBE Rotate Y").valueAtTime(time, false) || 0; } catch (e) { }
            try { rz = tr.property("ADBE Rotate Z").valueAtTime(time, false) || 0; } catch (e) { }
            try {
                var ori = tr.property("ADBE Orientation").valueAtTime(time, false);
                if (ori) { ox = ori[0] || 0; oy = ori[1] || 0; oz = ori[2] || 0; }
            } catch (e) { }

            // Convert degrees to radians
            var DEG = Math.PI / 180;
            var orx = (ox + rx) * DEG;
            var ory = (oy + ry) * DEG;
            var orz = (oz + rz) * DEG;

            // Build rotation matrix: Rz * Ry * Rx (AE's transform order for orientation+rotation)
            var cx = Math.cos(orx), sx_r = Math.sin(orx);
            var cy = Math.cos(ory), sy_r = Math.sin(ory);
            var cz = Math.cos(orz), sz_r = Math.sin(orz);

            // Rz matrix
            var r00 = cz, r01 = -sz_r, r02 = 0;
            var r10 = sz_r, r11 = cz, r12 = 0;
            var r20 = 0, r21 = 0, r22 = 1;

            // Multiply by Ry
            var a00 = r00 * cy + r02 * sy_r, a01 = r01, a02 = -r00 * sy_r + r02 * cy;
            var a10 = r10 * cy + r12 * sy_r, a11 = r11, a12 = -r10 * sy_r + r12 * cy;
            var a20 = r20 * cy + r22 * sy_r, a21 = r21, a22 = -r20 * sy_r + r22 * cy;

            // Multiply by Rx
            var m00 = a00, m01 = a01 * cx - a02 * sx_r, m02 = a01 * sx_r + a02 * cx;
            var m10 = a10, m11 = a11 * cx - a12 * sx_r, m12 = a11 * sx_r + a12 * cx;
            var m20 = a20, m21 = a21 * cx - a22 * sx_r, m22 = a21 * sx_r + a22 * cx;

            // Apply rotation * scale to anchor delta
            // AE transform order: Scale first, then Rotate (R * S * delta)
            var sdx3 = dx * sx, sdy3 = dy * sy, sdz3 = dz * sz;
            return [
                m00 * sdx3 + m01 * sdy3 + m02 * sdz3,
                m10 * sdx3 + m11 * sdy3 + m12 * sdz3,
                m20 * sdx3 + m21 * sdy3 + m22 * sdz3
            ];
        } catch (e3d) { }
    }

    // 2D layer (or 3D fallback): Z rotation + scale
    var rz2d = 0;
    try {
        var tr2d = toolkitGetTransform(layer);
        if (tr2d) {
            try { rz2d = tr2d.property("ADBE Rotate Z").valueAtTime(time, false) || 0; } catch (e) { }
        }
    } catch (eR) { }

    var rad = rz2d * Math.PI / 180;
    var cosR = Math.cos(rad);
    var sinR = Math.sin(rad);

    // Scale first, then rotate (R * S * delta)
    var sdx = dx * sx, sdy = dy * sy;
    return [
        cosR * sdx - sinR * sdy,
        sinR * sdx + cosR * sdy,
        dz * sz
    ];
}

function toolkitCompensatedAnchorPoint(layer, mode, time) {
    if (!toolkitLayerSupportsAnchorPoint(layer)) return "ERR_SUPPORT";

    var anchorProp = toolkitGetAnchorProp(layer);
    var posProp = toolkitGetPositionProp(layer);
    if (!anchorProp || !posProp) return "ERR_PROPS";

    var oldAnchor = toolkitPropValueAt(anchorProp, time);
    if (!oldAnchor) return "ERR_VALUE";

    var newAnchor = toolkitAnchorTargetForMode(layer, mode, time, oldAnchor);
    var anchorDelta = [newAnchor[0] - oldAnchor[0], newAnchor[1] - oldAnchor[1], (newAnchor[2] || 0) - (oldAnchor[2] || 0)];

    // If delta is effectively zero, skip
    if (Math.abs(anchorDelta[0]) < 0.001 && Math.abs(anchorDelta[1]) < 0.001 && Math.abs(anchorDelta[2] || 0) < 0.001) return "OK";

    // Compute position delta using layer's own rotation/scale only.
    // This is correct for parented layers because position is in parent space,
    // and the layer's R*S transforms anchor-offset space to parent space.
    var posDelta = toolkitComputePosDelta(layer, anchorDelta, time);

    // Apply changes — DIRECT prop.setValue() ONLY, never setValueAtTime.
    // This guarantees ZERO keyframes are created by the anchor point mover.
    try {
        // ── Anchor Point ──
        if (anchorProp.numKeys > 0) {
            // Offset every existing keyframe — no new keys added.
            toolkitOffsetPropKeyframes(anchorProp, anchorDelta);
        } else {
            // Direct static setValue — NEVER creates a keyframe.
            anchorProp.setValue(newAnchor);
        }

        // ── Position ──
        if (posProp.numKeys > 0) {
            // Offset every existing keyframe — no new keys added.
            toolkitOffsetPropKeyframes(posProp, posDelta);
        } else {
            // Handle separated dimensions inline for maximum speed.
            var posSepOk = false;
            try {
                if (posProp.dimensionsSeparated) {
                    var tr = toolkitGetTransform(layer);
                    if (tr) {
                        var px = tr.property("ADBE Position_0");
                        var py = tr.property("ADBE Position_1");
                        var pz = tr.property("ADBE Position_2");
                        // Each separated dim: offset keyframes if keyed, else direct setValue.
                        if (px) {
                            if (px.numKeys > 0) { toolkitOffsetPropKeyframes(px, [posDelta[0]]); }
                            else { var vx = px.value; px.setValue(vx + (posDelta[0] || 0)); }
                        }
                        if (py) {
                            if (py.numKeys > 0) { toolkitOffsetPropKeyframes(py, [posDelta[1]]); }
                            else { var vy = py.value; py.setValue(vy + (posDelta[1] || 0)); }
                        }
                        if (pz && (posDelta[2] || 0) !== 0) {
                            if (pz.numKeys > 0) { toolkitOffsetPropKeyframes(pz, [posDelta[2]]); }
                            else { var vz = pz.value; pz.setValue(vz + (posDelta[2] || 0)); }
                        }
                        posSepOk = true;
                    }
                }
            } catch (eSep) { }

            if (!posSepOk) {
                // Unified position: direct setValue with delta applied.
                var curPos = toolkitPropValueAt(posProp, time);
                if (!curPos) {
                    // Rollback anchor
                    if (anchorProp.numKeys > 0) {
                        toolkitOffsetPropKeyframes(anchorProp, [-anchorDelta[0], -anchorDelta[1], -(anchorDelta[2] || 0)]);
                    } else {
                        anchorProp.setValue(oldAnchor);
                    }
                    return "ERR_SET_POS";
                }
                var nextPos = [];
                var pi;
                for (pi = 0; pi < curPos.length; pi++) {
                    nextPos[pi] = curPos[pi] + (posDelta[pi] || 0);
                }
                posProp.setValue(nextPos);
            }
        }
    } catch (eExec) {
        return "ERR_EXEC:" + eExec.toString();
    }

    return "OK";
}

// =========================================================
// TOOLKIT — ANCHOR POINT
// =========================================================
function toolkitAnchorPoint(modeHex) {
    try {
        var mode = cleanStr(decodeBridge(modeHex));
        var comp = toolkitGetActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");

        var layers = comp.selectedLayers;
        if (!layers || layers.length === 0) return encodeBridge("Select at least one layer.");

        app.beginUndoGroup("Toolkit Anchor Point");

        var time = comp.time;
        var changed = 0;
        var skipped = 0;
        var debugLog = "";

        var i;
        for (i = 0; i < layers.length; i++) {
            try {
                var layer = layers[i];
                var res = toolkitCompensatedAnchorPoint(layer, mode, time);
                if (res === "OK") {
                    changed++;
                } else {
                    skipped++;
                    debugLog += " L" + (i + 1) + ":" + res;
                }
            } catch (eL) {
                skipped++;
                debugLog += " L" + (i + 1) + "Err:" + eL.toString();
            }
        }

        app.endUndoGroup();

        if (changed === 0) {
            return encodeBridge("No layers updated. " + (debugLog ? "LOG:" + debugLog : "Try shape/text/solid/footage layers."));
        }
        // All selected layers succeeded — return "true" for silent success
        if (skipped === 0) return encodeBridge("true");
        // Partial success — return info message
        return encodeBridge("OK:Anchor set on " + changed + " of " + (changed + skipped) + " layer(s)");
    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge("Anchor Error: " + e.toString());
    }
}

// =========================================================
// TOOLKIT — ALIGN
// =========================================================

// Returns comp-space bounds of a layer
function toolkitLayerCompBounds(layer, time) {
    try {
        var rect = toolkitLayerRect(layer, time);

        // Nulls/Adjustments often have undefined real bounds — use intrinsic
        var isNullOrAdj = false;
        try { isNullOrAdj = layer.nullLayer || layer.adjustmentLayer; } catch (eN) { }

        if (isNullOrAdj && (!rect || rect.width < 2 || rect.height < 2)) {
            var lw = 100, lh = 100;
            try { lw = layer.width || 100; } catch (eW) { }
            try { lh = layer.height || 100; } catch (eH) { }
            rect = { left: 0, top: 0, width: lw, height: lh };
        }

        var pts = [
            [rect.left, rect.top, 0],
            [rect.left + rect.width, rect.top, 0],
            [rect.left, rect.top + rect.height, 0],
            [rect.left + rect.width, rect.top + rect.height, 0]
        ];

        var minX = 99999999, minY = 99999999;
        var maxX = -99999999, maxY = -99999999;
        var transformed = false;

        // ONE probe for all four corners (and the center fallback) instead of one
        // add/remove cycle per point.
        var probe = toolkitOpenProbe(layer);
        try {
            var i;
            for (i = 0; i < pts.length; i++) {
                try {
                    var pt = probe ? toolkitProbeQuery(probe, "toComp", pts[i]) : null;
                    if (pt) {
                        if (pt[0] < minX) minX = pt[0];
                        if (pt[0] > maxX) maxX = pt[0];
                        if (pt[1] < minY) minY = pt[1];
                        if (pt[1] > maxY) maxY = pt[1];
                        transformed = true;
                    }
                } catch (eP) { }
            }

            // If toComp failed for all corners, use a single-point fallback
            if (!transformed) {
                try {
                    // Try toComp on the center of the source rect
                    var cx = rect.left + rect.width / 2;
                    var cy = rect.top + rect.height / 2;
                    var centerComp = probe ? toolkitProbeQuery(probe, "toComp", [cx, cy, 0]) : null;
                    if (centerComp) {
                        var hw = (rect.width || 100) / 2;
                        var hh = (rect.height || 100) / 2;
                        return {
                            left: centerComp[0] - hw,
                            right: centerComp[0] + hw,
                            top: centerComp[1] - hh,
                            bottom: centerComp[1] + hh,
                            cx: centerComp[0],
                            cy: centerComp[1]
                        };
                    }
                } catch (eFb) { }
                // Last resort: use position
                try {
                    var posProp = toolkitGetPositionProp(layer);
                    var pp = posProp ? toolkitPropValueAt(posProp, time) : [0, 0, 0];
                    if (pp) {
                        var ppx = pp[0] || 0;
                        var ppy = pp[1] || 0;
                        var hw2 = (rect.width || 100) / 2;
                        var hh2 = (rect.height || 100) / 2;
                        return {
                            left: ppx - hw2,
                            right: ppx + hw2,
                            top: ppy - hh2,
                            bottom: ppy + hh2,
                            cx: ppx,
                            cy: ppy
                        };
                    }
                } catch (eFb2) { }
                return { left: 0, right: 0, top: 0, bottom: 0, cx: 0, cy: 0 };
            }

            return {
                left: minX,
                right: maxX,
                top: minY,
                bottom: maxY,
                cx: (minX + maxX) / 2,
                cy: (minY + maxY) / 2
            };
        } finally {
            // Runs on every return path above, including the fallbacks.
            toolkitCloseProbe(probe);
        }
    } catch (e) {
        return { left: 0, right: 0, top: 0, bottom: 0, cx: 0, cy: 0 };
    }
}

function toolkitAlignLayers(modeHex) {
    try {
        var mode = cleanStr(decodeBridge(modeHex));
        var alignOptions = mode.split("|");
        mode = alignOptions[0];
        var scope = alignOptions[1] === "selection" ? "selection" : "comp";
        if (!/^(left|right|hcenter|top|bottom|vcenter|center_both)$/.test(mode)) return encodeBridge("Invalid alignment edge.");
        var comp = toolkitGetActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");

        var layers = comp.selectedLayers;
        if (!layers || layers.length === 0) return encodeBridge("Select at least one layer.");

        app.beginUndoGroup("Toolkit Align");
        var time = comp.time;
        var changed = 0;
        var skipped = 0;
        var target = { left: 0, top: 0, right: comp.width, bottom: comp.height };
        var boundsSnapshot = [];
        var boundsIndex;
        var hasBounds = false;
        for (boundsIndex = 0; boundsIndex < layers.length; boundsIndex++) {
            var boundsLayer = layers[boundsIndex];
            if (boundsLayer instanceof CameraLayer || boundsLayer instanceof LightLayer) continue;
            var snapshot = toolkitLayerCompBounds(boundsLayer, time);
            boundsSnapshot[boundsIndex] = snapshot;
            if (scope === "selection") {
                if (!hasBounds) {
                    target = { left: snapshot.left, top: snapshot.top, right: snapshot.right, bottom: snapshot.bottom };
                    hasBounds = true;
                } else {
                    target.left = Math.min(target.left, snapshot.left);
                    target.top = Math.min(target.top, snapshot.top);
                    target.right = Math.max(target.right, snapshot.right);
                    target.bottom = Math.max(target.bottom, snapshot.bottom);
                }
            }
        }

        __alignLog("=== ALIGN mode=" + mode + " comp=" + comp.width + "x" + comp.height + " time=" + time + " layers=" + layers.length + " ===");

        var i;
        for (i = 0; i < layers.length; i++) {
            try {
                var layer = layers[i];
                var layerName = "";
                try { layerName = layer.name; } catch (eN) { }
                var layerType = "";
                try { layerType = layer.typename; } catch (eT) { }
                var isLocked = false;
                try { isLocked = layer.locked; } catch (eLk) { }
                var is3D = false;
                try { is3D = layer.threeDLayer; } catch (e3d) { }
                var hasParent = !!layer.parent;

                // Skip locked layers
                if (isLocked) {
                    __alignLog("  L" + (i + 1) + " [" + layerName + "] type=" + layerType + " SKIPPED (locked)");
                    skipped++;
                    continue;
                }

                // Cameras/Lights don't align meaningfully
                if (layer instanceof CameraLayer || layer instanceof LightLayer) {
                    __alignLog("  L" + (i + 1) + " [" + layerName + "] type=" + layerType + " SKIPPED (camera/light)");
                    skipped++;
                    continue;
                }

                var posProp = toolkitGetPositionProp(layer);
                if (!posProp) {
                    __alignLog("  L" + (i + 1) + " [" + layerName + "] type=" + layerType + " SKIPPED (no position prop)");
                    skipped++;
                    continue;
                }

                var b = boundsSnapshot[i] || toolkitLayerCompBounds(layer, time);

                // Read current position for logging
                var curPos = toolkitPropValueAt(posProp, time);
                var curPosStr = curPos ? ("[" + curPos[0].toFixed(1) + "," + curPos[1].toFixed(1) + "]") : "null";

                var dx = 0, dy = 0;
                if (mode === "left") dx = target.left - b.left;
                else if (mode === "right") dx = target.right - b.right;
                else if (mode === "hcenter") dx = (target.left + target.right) / 2 - b.cx;
                else if (mode === "top") dy = target.top - b.top;
                else if (mode === "bottom") dy = target.bottom - b.bottom;
                else if (mode === "vcenter") dy = (target.top + target.bottom) / 2 - b.cy;
                else if (mode === "center_both") {
                    dx = (target.left + target.right) / 2 - b.cx;
                    dy = (target.top + target.bottom) / 2 - b.cy;
                }

                __alignLog("  L" + (i + 1) + " [" + layerName + "] type=" + layerType + " 3d=" + is3D + " parent=" + hasParent +
                    " pos=" + curPosStr +
                    " bounds=[L:" + b.left.toFixed(1) + " R:" + b.right.toFixed(1) + " T:" + b.top.toFixed(1) + " B:" + b.bottom.toFixed(1) +
                    " CX:" + b.cx.toFixed(1) + " CY:" + b.cy.toFixed(1) + "]" +
                    " delta=[" + dx.toFixed(1) + "," + dy.toFixed(1) + "]");

                var addResult = toolkitAddCompDelta(layer, [dx, dy, 0], time);
                if (addResult) {
                    // Log new position
                    var newPos = toolkitPropValueAt(posProp, time);
                    var newPosStr = newPos ? ("[" + newPos[0].toFixed(1) + "," + newPos[1].toFixed(1) + "]") : "null";
                    __alignLog("    -> OK newpos=" + newPosStr);
                    changed++;
                } else {
                    __alignLog("    -> FAILED (toolkitAddCompDelta returned false)");
                    skipped++;
                }
            } catch (eL) {
                __alignLog("  L" + (i + 1) + " EXCEPTION: " + eL.toString());
                skipped++;
            }
        }

        __alignLog("=== ALIGN RESULT: changed=" + changed + " skipped=" + skipped + " ===");

        app.endUndoGroup();

        if (changed === 0) {
            return encodeBridge("Could not align any layer. Skipped: " + skipped);
        }
        // All selected layers succeeded — return "true" for silent success
        if (skipped === 0) return encodeBridge("true");
        // Partial success — return info message
        return encodeBridge("OK:Aligned " + changed + " of " + (changed + skipped) + " layer(s)");
    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge("Align Error: " + e.toString());
    }
}

// =========================================================
// TOOLKIT — CREATE LAYER
// =========================================================

function toolkitTopSelectedLayer(comp) {
    return getTopSelectedLayer(comp);
}

function toolkitApplyTiming(newLayer, refLayer, comp) {
    try {
        if (refLayer) {
            newLayer.startTime = refLayer.startTime;
            newLayer.inPoint = refLayer.inPoint;
            newLayer.outPoint = refLayer.outPoint;
            newLayer.moveBefore(refLayer);
        } else {
            newLayer.startTime = 0;
            newLayer.inPoint = 0;
            newLayer.outPoint = comp.duration;
            try { newLayer.moveToBeginning(); } catch (e) { }
        }
    } catch (e2) { }
}

function toolkitDeselect(comp) {
    deselectAllLayers(comp);
}

function toolkitApplyTextDefaults(layer, comp) {
    try {
        var textProp = getSourceTextProp(layer);
        if (textProp) {
            var doc = textProp.value;
            if (doc) {
                doc.justification = ParagraphJustification.CENTER_JUSTIFY;
                textProp.setValue(doc);
            }
        }
    } catch (eJustify) { }

    // Text layers should start with a centered anchor without a visual jump.
    try { toolkitCompensatedAnchorPoint(layer, "center", comp.time); } catch (eAnchor) { }
}

function toolkitCreateLayer(modeHex) {
    try {
        var mode = cleanStr(decodeBridge(modeHex));
        var comp = toolkitGetActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");

        // Validate the mode BEFORE touching the project. Previously an unknown
        // mode with a selection fell through every branch, created nothing, and
        // still reported "OK:Layer created" (Req 13 — never fake success).
        if (mode !== "null" && mode !== "adjustment" && mode !== "camera" &&
            mode !== "solid" && mode !== "text") {
            return encodeBridge("Unknown layer type.");
        }

        // comp.selectedLayers is a LIVE getter: AE rebuilds the whole array on
        // every access, so reading .length in the loop condition and indexing it
        // again in the body cost O(n^2) host calls. Snapshot it once. (Req 6)
        var liveSelection = comp.selectedLayers;
        var selectedLayers = [];
        for (var i = 0; i < liveSelection.length; i++) {
            selectedLayers.push(liveSelection[i]);
        }

        // Sort by index ascending to process from top to bottom
        selectedLayers.sort(function (a, b) {
            return a.index - b.index;
        });

        app.beginUndoGroup("Toolkit Create Layer");

        var createdLayers = [];
        var warnings = [];

        if (selectedLayers.length > 0) {
            // MULTI-LAYER MODE
            for (var i = 0; i < selectedLayers.length; i++) {
                var ref = selectedLayers[i];
                var wasLocked = ref.locked;

                try {
                    if (wasLocked) ref.locked = false;

                    var layer = null;
                    if (mode === "null") {
                        layer = comp.layers.addNull();
                        try { layer.threeDLayer = !!ref.threeDLayer; } catch (e3d) { }
                        toolkitApplyTiming(layer, ref, comp);
                        try { ref.parent = layer; } catch (ePar) { }
                        createdLayers.push(layer);
                    } else if (mode === "adjustment") {
                        layer = comp.layers.addSolid([1, 1, 1], "Adjustment Layer", comp.width, comp.height, comp.pixelAspect, comp.duration);
                        layer.adjustmentLayer = true;
                        toolkitApplyTiming(layer, ref, comp);
                        createdLayers.push(layer);
                    } else if (mode === "camera") {
                        var camNum = i + 1;
                        var cam = comp.layers.addCamera("Camera " + camNum, [comp.width / 2, comp.height / 2]);
                        try { cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT; } catch (eAO) { }

                        var nativeZoom = 529.17;
                        try { nativeZoom = cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").value; } catch (eZ) { }

                        try {
                            var xform = cam.property("ADBE Transform Group");
                            xform.property("ADBE Position").setValue([comp.width / 2, comp.height / 2, -nativeZoom]);
                            xform.property("ADBE Orientation").setValue([0, 0, 0]);
                            xform.property("ADBE Rotate X").setValue(0);
                            xform.property("ADBE Rotate Y").setValue(0);
                            xform.property("ADBE Rotate Z").setValue(0);
                        } catch (eReset) { }

                        var cameraNull = comp.layers.addNull();
                        cameraNull.name = cam.name + " Control";
                        try { cameraNull.threeDLayer = true; } catch (eCam3D) { }
                        try {
                            cameraNull.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
                            cameraNull.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2, 0]);
                        } catch (eNullXform) { }

                        toolkitApplyTiming(cameraNull, ref, comp);
                        toolkitApplyTiming(cam, ref, comp);
                        try { cameraNull.moveBefore(cam); } catch (eOrder) { }

                        try { cam.parent = cameraNull; } catch (eCamParent) { }

                        try {
                            var xf = cam.property("ADBE Transform Group");
                            xf.property("ADBE Position").setValue([0, 0, -nativeZoom]);
                            xf.property("ADBE Orientation").setValue([0, 0, 0]);
                            xf.property("ADBE Rotate X").setValue(0);
                            xf.property("ADBE Rotate Y").setValue(0);
                            xf.property("ADBE Rotate Z").setValue(0);
                            cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(nativeZoom);
                        } catch (eRestore) { }

                        createdLayers.push(cameraNull);
                        createdLayers.push(cam);
                    } else if (mode === "solid") {
                        layer = comp.layers.addSolid([1, 1, 1], "White Solid", comp.width, comp.height, comp.pixelAspect, comp.duration);
                        toolkitApplyTiming(layer, ref, comp);
                        createdLayers.push(layer);
                    } else if (mode === "text") {
                        layer = createDefaultTextLayer(comp, ref);
                        toolkitApplyTiming(layer, ref, comp);
                        createdLayers.push(layer);
                    }
                } catch (eInner) {
                    warnings.push("Failed to create layer for '" + ref.name + "': " + eInner.toString());
                } finally {
                    if (wasLocked) {
                        try { ref.locked = true; } catch (eLock) { }
                    }
                }
            }

            // Select new layers
            toolkitDeselect(comp);
            for (var i = 0; i < createdLayers.length; i++) {
                createdLayers[i].selected = true;
            }

            app.endUndoGroup();

            // Nothing was created: report the real failure instead of "OK". (Req 13)
            if (createdLayers.length === 0) {
                return encodeBridge("Could not create any layer:\n" + (warnings.length > 0 ? warnings.join("\n") : "No layer was created for the current selection."));
            }
            if (warnings.length > 0) {
                return encodeBridge("OK:Layer(s) created with warnings:\n" + warnings.join("\n"));
            }
            return encodeBridge(mode === "camera" ? "OK:Camera created" : "OK:Layer created");
        } else {
            // NO SELECTION MODE (Keep existing default fallback)
            var layer = null;
            if (mode === "null") {
                layer = comp.layers.addNull();
                toolkitApplyTiming(layer, null, comp);
            } else if (mode === "adjustment") {
                layer = comp.layers.addSolid([1, 1, 1], "Adjustment Layer", comp.width, comp.height, comp.pixelAspect, comp.duration);
                layer.adjustmentLayer = true;
                toolkitApplyTiming(layer, null, comp);
            } else if (mode === "camera") {
                var cam = comp.layers.addCamera("Camera 1", [comp.width / 2, comp.height / 2]);
                try { cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT; } catch (eAO) { }

                var nativeZoom = 529.17;
                try { nativeZoom = cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").value; } catch (eZ) { }

                try {
                    var xform = cam.property("ADBE Transform Group");
                    xform.property("ADBE Position").setValue([comp.width / 2, comp.height / 2, -nativeZoom]);
                    xform.property("ADBE Orientation").setValue([0, 0, 0]);
                    xform.property("ADBE Rotate X").setValue(0);
                    xform.property("ADBE Rotate Y").setValue(0);
                    xform.property("ADBE Rotate Z").setValue(0);
                } catch (eReset) { }

                var cameraNull = comp.layers.addNull();
                cameraNull.name = cam.name + " Control";
                try { cameraNull.threeDLayer = true; } catch (eCam3D) { }
                try {
                    cameraNull.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
                    cameraNull.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2, 0]);
                } catch (eNullXform) { }

                toolkitApplyTiming(cameraNull, null, comp);
                toolkitApplyTiming(cam, null, comp);
                try { cameraNull.moveBefore(cam); } catch (eOrder) { }

                try { cam.parent = cameraNull; } catch (eCamParent) { }

                try {
                    var xf = cam.property("ADBE Transform Group");
                    xf.property("ADBE Position").setValue([0, 0, -nativeZoom]);
                    xf.property("ADBE Orientation").setValue([0, 0, 0]);
                    xf.property("ADBE Rotate X").setValue(0);
                    xf.property("ADBE Rotate Y").setValue(0);
                    xf.property("ADBE Rotate Z").setValue(0);
                    cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(nativeZoom);
                } catch (eRestore) { }

                toolkitDeselect(comp);
                cameraNull.selected = true;
                cam.selected = true;
                app.endUndoGroup();
                return encodeBridge("OK:Camera created");
            } else if (mode === "solid") {
                layer = comp.layers.addSolid([1, 1, 1], "White Solid", comp.width, comp.height, comp.pixelAspect, comp.duration);
                toolkitApplyTiming(layer, null, comp);
            } else if (mode === "text") {
                layer = createDefaultTextLayer(comp, null);
                toolkitApplyTiming(layer, null, comp);
            } else {
                app.endUndoGroup();
                return encodeBridge("Unknown layer type.");
            }

            toolkitDeselect(comp);
            if (layer) layer.selected = true;
            app.endUndoGroup();
            return encodeBridge("OK:Layer created");
        }
    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge("Create Error: " + e.toString());
    }
}

function toolkitApplyFlowDebug() {
    // Diagnostic: return exactly what AE sees for selection state
    var out = [];
    try {
        var comp = app.project.activeItem;
        if (!comp) return encodeBridge("NO_COMP");
        if (!(comp instanceof CompItem)) return encodeBridge("NOT_COMP");

        out.push("comp:" + comp.name);
        var selLayers = comp.selectedLayers;
        out.push("layers:" + (selLayers ? selLayers.length : "null"));

        if (!selLayers || selLayers.length === 0) return encodeBridge(out.join("|"));

        for (var i = 0; i < selLayers.length; i++) {
            var layer = selLayers[i];
            out.push("L" + i + ":" + layer.name);

            // Check Transform
            var xform = layer.property("ADBE Transform Group");
            if (xform) {
                for (var p = 1; p <= xform.numProperties; p++) {
                    var prop = xform.property(p);
                    var mn = "";
                    var vt = "";
                    var nk = 0;
                    var sk = "";
                    var cvt = false;
                    var isP = false;
                    try { mn = prop.matchName; } catch (e) { }
                    try { vt = prop.propertyValueType; } catch (e) { }
                    try { nk = prop.numKeys; } catch (e) { }
                    try { sk = (prop.selectedKeys ? prop.selectedKeys.length : "null"); } catch (e) { sk = "ERR"; }
                    try { cvt = prop.canVaryOverTime; } catch (e) { }
                    isP = (prop instanceof Property);
                    out.push("  " + mn + " vt=" + vt + " keys=" + nk + " sel=" + sk + " isP=" + isP + " cvt=" + cvt);

                    // If PropertyGroup, recurse one level
                    if (!isP) {
                        try {
                            for (var c = 1; c <= prop.numProperties; c++) {
                                var child = prop.property(c);
                                var cmn = ""; var cvt2 = ""; var cnk = 0; var csk = ""; var cisP = false;
                                try { cmn = child.matchName; } catch (e) { }
                                try { cvt2 = child.propertyValueType; } catch (e) { }
                                try { cnk = child.numKeys; } catch (e) { }
                                try { csk = (child.selectedKeys ? child.selectedKeys.length : "null"); } catch (e) { csk = "ERR"; }
                                cisP = (child instanceof Property);
                                out.push("    " + cmn + " vt=" + cvt2 + " keys=" + cnk + " sel=" + csk + " isP=" + cisP);
                            }
                        } catch (e) { }
                    }
                }
            }
        }
    } catch (e) {
        out.push("ERR:" + e.toString());
    }
    return encodeBridge(out.join("|"));
}

// =========================================================
// TOOLKIT — BOUNCE OVERSHOOT (one-click velocity bounce expression)
// =========================================================
// Applies a velocity-based overshoot/bounce expression to every selected
// property that has selected keyframes. Works on Position, Scale, Rotation,
// Opacity, or any animated property on any layer type.
// Parameters (pipe-delimited hex string): freq|amp|decay
//   freq  = oscillation frequency (default 3)
//   amp   = amplitude multiplier (default 40, means 40/1000)
//   decay = exponential decay speed (default 5)
function toolkitApplyBounce(paramsHex) {
    try {
        var parts = cleanStr(decodeBridge(paramsHex)).split("|");
        var freq = parseFloat(parts[0]) || 3;
        var amp = parseFloat(parts[1]) || 40;
        var decay = parseFloat(parts[2]) || 5;

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return encodeBridge("Open a composition first.");

        var selLayers = comp.selectedLayers;
        if (!selLayers || selLayers.length === 0) return encodeBridge("Select a layer with keyframes first.");

        // Bounce overshoot expression. It reads its four parameters from
        // Expression Controls that this function guarantees on the layer.
        //
        // BUG FIX (Req 5): the previous string resolved them as
        // effect("BOUNCr overSHOOT+")("Amplitude") — i.e. ONE effect owning four
        // named sub-properties. Only a pseudo-effect (.ffx) has that shape and
        // scripting cannot create pseudo-effects, so every evaluation threw and
        // the expression's own trailing `catch (err) { value }` quietly returned
        // the un-bounced value: Bounce reported success while changing nothing.
        // Standard Expression Controls expose exactly one child each — a Slider
        // Control's child is "Slider", a Checkbox Control's is "Checkbox" — so the
        // lookups now address one control per parameter (indices 12/13 below).
        // The bounce math itself is untouched.
        var AMP_NAME = "Amplitude";
        var FREQ_NAME = "Frequency";
        var DECAY_NAME = "Decay";
        var FLOOR_NAME = "Floor";
        var expr = '/*overshoot+ expression*/var _0x9233=[\'BOUNCr overSHOOT+\',\'Amplitude\',\'Frequency\',\'Decay\',\'Floor\',\'index\',\'time\',\'frameDuration\',\'PI\',\'sin\',\'exp\',\'abs\',\'Slider\',\'Checkbox\'];try{var amp=effect(_0x9233[1])(_0x9233[12])/ 1000;var freq=effect(_0x9233[2])(_0x9233[12]);var decay=effect(_0x9233[3])(_0x9233[12]);var floor=effect(_0x9233[4])(_0x9233[13]);var n,numkeys,v,t;if(floor!= true){n= 0;if(numKeys> 0){n= nearestKey(time)[_0x9233[5]];if(key(n)[_0x9233[6]]> time){n--}};if(n== 0){t= 0}else {t= time- key(n)[_0x9233[6]]};if(n> 0){v= velocityAtTime(key(n)[_0x9233[6]]- thisComp[_0x9233[7]]/ 10);value+ v* amp* (Math[_0x9233[9]](freq* t* 2* Math[_0x9233[8]])/ Math[_0x9233[10]](decay* t))}else {value}}else {n= 0;if(numKeys> 0){n= nearestKey(time)[_0x9233[5]];if(key(n)[_0x9233[6]]> time){n--}};if(n== 0){t= 0}else {t= time- key(n)[_0x9233[6]]};if(n> 0){v= velocityAtTime(key(n)[_0x9233[6]]- thisComp[_0x9233[7]]/ 10);value+ v* amp*  -(Math[_0x9233[11]](Math[_0x9233[9]](freq* t* 2* Math[_0x9233[8]]))/ Math[_0x9233[10]](decay* t))}else {value}}}catch(err){value}';

        app.beginUndoGroup("Bounce Overshoot");
        var applied = 0;
        var anyKeysSelected = false;

        // Guarantee the three sliders + checkbox the expression reads, and keep
        // them in sync with the panel on every run.
        //
        // BUG FIX (Req 5): the previous version only pushed `amp` into the marker
        // slider, so re-running Bounce with different Frequency/Decay values left
        // the controls — and therefore the animation — on the old numbers.
        function setBounceControlValue(effectProp, childName, value) {
            try {
                var child = effectProp.property(childName);
                if (child) { child.setValue(value); return true; }
            } catch (e) { }
            try {
                // Fallback for localized AE builds where the child's display name
                // differs: an Expression Control has exactly one child property.
                var only = effectProp.property(1);
                if (only) { only.setValue(value); return true; }
            } catch (e2) { }
            return false;
        }

        function ensureBounceControls(layer) {
            var fx = layer.property("ADBE Effect Parade");
            if (!fx) return;

            var existing = {};
            for (var ei = 1; ei <= fx.numProperties; ei++) {
                try {
                    var nm = fx.property(ei).name;
                    if (nm === AMP_NAME || nm === FREQ_NAME || nm === DECAY_NAME || nm === FLOOR_NAME) {
                        existing[nm] = fx.property(ei);
                    }
                } catch (e) { }
            }

            try {
                var ampCtrl = existing[AMP_NAME];
                if (!ampCtrl) { ampCtrl = fx.addProperty("ADBE Slider Control"); ampCtrl.name = AMP_NAME; }
                setBounceControlValue(ampCtrl, "Slider", amp);

                var freqCtrl = existing[FREQ_NAME];
                if (!freqCtrl) { freqCtrl = fx.addProperty("ADBE Slider Control"); freqCtrl.name = FREQ_NAME; }
                setBounceControlValue(freqCtrl, "Slider", freq);

                var decayCtrl = existing[DECAY_NAME];
                if (!decayCtrl) { decayCtrl = fx.addProperty("ADBE Slider Control"); decayCtrl.name = DECAY_NAME; }
                setBounceControlValue(decayCtrl, "Slider", decay);

                // Floor is a user toggle: create it defaulted OFF, but never
                // stomp a value the user has already set.
                if (!existing[FLOOR_NAME]) {
                    var floorCtrl = fx.addProperty("ADBE Checkbox Control");
                    floorCtrl.name = FLOOR_NAME;
                    setBounceControlValue(floorCtrl, "Checkbox", 0);
                }
            } catch (eCtrl) { }
        }

        // Detect if user explicitly selected keyframes
        function checkKeys(prop) {
            if (anyKeysSelected) return;
            try {
                if (!(prop instanceof Property)) {
                    if (prop.numProperties) {
                        for (var c = 1; c <= prop.numProperties; c++) checkKeys(prop.property(c));
                    }
                    return;
                }
            } catch (e) { return; }
            try {
                if (prop.canVaryOverTime && prop.numKeys > 0 && prop.selectedKeys && prop.selectedKeys.length > 0) {
                    anyKeysSelected = true;
                }
            } catch (e) { }
        }
        for (var di = 0; di < selLayers.length; di++) {
            try {
                for (var dp = 1; dp <= selLayers[di].numProperties; dp++) {
                    try { checkKeys(selLayers[di].property(dp)); } catch (e) { }
                }
            } catch (e) { }
        }

        function applyExpr(prop) {
            try {
                if (!(prop instanceof Property)) {
                    if (prop.numProperties) {
                        for (var c = 1; c <= prop.numProperties; c++) applyExpr(prop.property(c));
                    }
                    return;
                }
            } catch (e) { return; }
            if (!prop.canVaryOverTime || !prop.canSetExpression) return;
            var nk = 0;
            try { nk = prop.numKeys; } catch (e) { return; }
            if (nk === 0) return;

            // If user selected specific keyframes, only apply to those properties
            if (anyKeysSelected) {
                var sk;
                try { sk = prop.selectedKeys; } catch (e) { return; }
                if (!sk || sk.length === 0) return;
            }

            try {
                prop.expression = expr;
                applied++;
            } catch (e) { }
        }

        for (var i = 0; i < selLayers.length; i++) {
            ensureBounceControls(selLayers[i]);
            try {
                for (var p = 1; p <= selLayers[i].numProperties; p++) {
                    try { applyExpr(selLayers[i].property(p)); } catch (e) { }
                }
            } catch (e) { }
        }

        app.endUndoGroup();
        if (applied === 0) return encodeBridge("No animated properties found. Add keyframes first.");
        return encodeBridge("OK: Bounce applied to " + applied + " propert" + (applied === 1 ? "y" : "ies"));
    } catch (err) {
        try { app.endUndoGroup(); } catch (e) { }
        return encodeBridge("Bounce error: " + err.toString());
    }
}

function toolkitApplyFlow(inf1, inf2) {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) return encodeBridge("Open a composition");

    app.beginUndoGroup("Flow Easing");
    var appliedCount = 0;
    var errors = [];

    try {
        var eOutVal = Math.max(0.1, Math.min(100, Number(inf1)));
        var eInVal = Math.max(0.1, Math.min(100, Number(inf2)));
        var eOut = new KeyframeEase(0, eOutVal);
        var eIn = new KeyframeEase(0, eInVal);
        var anySelected = false;

        function applyToProp(prop) {
            // Recurse into property groups
            try {
                if (!(prop instanceof Property)) {
                    if (prop.numProperties) {
                        for (var c = 1; c <= prop.numProperties; c++) {
                            applyToProp(prop.property(c));
                        }
                    }
                    return;
                }
            } catch (e) { return; }

            if (!prop.canVaryOverTime) return;

            var numKeys = 0;
            try { numKeys = prop.numKeys; } catch (e) { return; }
            if (numKeys === 0) return;

            var selectedKeys;
            // Use explicitly-selected keyframes when the user picked some;
            // otherwise (layer selected but no keys chosen) ease ALL keyframes
            // on the property so a single click always does something useful.
            if (anySelected) {
                try { selectedKeys = prop.selectedKeys; } catch (e) { return; }
                if (!selectedKeys || selectedKeys.length === 0) return;
            } else {
                selectedKeys = [];
                for (var ak = 1; ak <= numKeys; ak++) selectedKeys.push(ak);
            }

            // Determine property dimensionality
            var vt;
            try { vt = prop.propertyValueType; } catch (e) { return; }

            // SPATIAL properties (Position, Anchor Point) always use 1 KeyframeEase
            // for temporal easing — spatial dimensions are handled via spatial tangents.
            // NON-SPATIAL multi-dim properties (Scale) use 1 KeyframeEase per dimension.
            var isSpatial = (vt === PropertyValueType.TwoD_SPATIAL || vt === PropertyValueType.ThreeD_SPATIAL);
            var dim = 1;
            if (!isSpatial) {
                if (vt === PropertyValueType.TwoD) dim = 2;
                else if (vt === PropertyValueType.ThreeD) dim = 3;
            }

            // Build per-dimension easing arrays
            var easeInArray = [];
            var easeOutArray = [];
            for (var d = 0; d < dim; d++) {
                easeInArray.push(eIn);
                easeOutArray.push(eOut);
            }

            for (var j = 0; j < selectedKeys.length; j++) {
                var ki = selectedKeys[j];
                // Temporal easing — must succeed
                try {
                    prop.setTemporalEaseAtKey(ki, easeInArray, easeOutArray);
                } catch (e) {
                    errors.push("ease:" + (prop.matchName || "?") + ":" + ki + ":" + e.toString());
                    continue;
                }
                // Interpolation type — may fail on spatial, that's OK
                try {
                    prop.setInterpolationTypeAtKey(ki, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                } catch (e) {
                    try {
                        prop.setInterpolationTypeAtKey(ki, KeyframeInterpolationType.BEZIER);
                    } catch (e2) { }
                }
                appliedCount++;
            }
        }

        // Walk all selected layers
        var selLayers = comp.selectedLayers;
        if (!selLayers || selLayers.length === 0) {
            app.endUndoGroup();
            return encodeBridge("Select a layer (and optionally keyframes) first");
        }

        // Detect whether the user explicitly selected any keyframes. If none are
        // selected, we fall back to easing ALL keyframes on the selected layers —
        // so "Apply" / preset clicks work even when only the layer is selected.
        function detectSelected(prop) {
            if (anySelected) return;
            try {
                if (!(prop instanceof Property)) {
                    if (prop.numProperties) {
                        for (var c = 1; c <= prop.numProperties; c++) detectSelected(prop.property(c));
                    }
                    return;
                }
            } catch (e) { return; }
            try {
                if (prop.canVaryOverTime && prop.numKeys > 0) {
                    var sk = prop.selectedKeys;
                    if (sk && sk.length > 0) anySelected = true;
                }
            } catch (e) { }
        }
        for (var di = 0; di < selLayers.length; di++) {
            try {
                for (var dp = 1; dp <= selLayers[di].numProperties; dp++) {
                    try { detectSelected(selLayers[di].property(dp)); } catch (e) { }
                }
            } catch (e) { }
        }

        for (var i = 0; i < selLayers.length; i++) {
            var layer = selLayers[i];
            try {
                // Iterate ALL properties on the layer (top-level groups)
                for (var p = 1; p <= layer.numProperties; p++) {
                    try {
                        applyToProp(layer.property(p));
                    } catch (e) { }
                }
            } catch (e) { }
        }

        app.endUndoGroup();
        if (appliedCount === 0) {
            var msg = "Select keyframes first";
            if (errors.length > 0) msg = errors[0];
            return encodeBridge(msg);
        }
        return encodeBridge("true");
    } catch (err) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge("Error: " + err.toString());
    }
}

// =========================================================
// TOOLKIT — ORGANIZE PROJECT
// =========================================================

function toolkitGetOrCreateRootFolder(name) {
    var i;
    for (i = 1; i <= app.project.numItems; i++) {
        try {
            var item = app.project.item(i);
            // Only match a folder that lives at the project root (MN behavior),
            // so a same-named nested folder is never hijacked.
            if (item instanceof FolderItem && item.name === name && item.parentFolder === app.project.rootFolder) return item;
        } catch (e) { }
    }
    return app.project.items.addFolder(name);
}

function toolkitLowerExt(fileObj) {
    try {
        var n = fileObj.name.toLowerCase();
        var p = n.lastIndexOf(".");
        return p >= 0 ? n.substr(p + 1) : "";
    } catch (e) { }
    return "";
}

function toolkitOrganizeProject() {
    try {
        if (!app.project) return encodeBridge("No project open.");
        var proj = app.project;
        app.beginUndoGroup("Toolkit Organize Project");

        // Folder taxonomy — EXACT MN Tools set + names. Sorts all root-level
        // items into folders by type; non-destructive (only moves items;
        // empty auto-created folders are removed at the end).
        var NAMES = {
            comps: "Comps",
            precomps: "Precomps",
            video: "Footage \u2022 Video",
            images: "Footage \u2022 Images",
            sequences: "Footage \u2022 Sequences",
            audio: "Footage \u2022 Audio",
            solids: "Solids",
            other: "Footage \u2022 Other"
        };

        // Lazily create a destination folder only when first needed.
        var folders = {};
        function dest(name) {
            if (!folders[name]) folders[name] = toolkitGetOrCreateRootFolder(name);
            return folders[name];
        }

        // --- Pass 1: which comps are used as a layer source inside another
        //     comp → treat those as Precomps (MN uses layer.source directly). ---
        var usedAsPrecomp = {};
        var c, L;
        for (c = 1; c <= proj.numItems; c++) {
            var ci = proj.item(c);
            if (ci instanceof CompItem) {
                for (L = 1; L <= ci.numLayers; L++) {
                    var src = null;
                    try { src = ci.layer(L).source; } catch (eSrc) { src = null; }
                    if (src && (src instanceof CompItem)) usedAsPrecomp[src.id] = true;
                }
            }
        }

        // Extension read from the item NAME (MN behavior), and the exact MN
        // still-image extension set used to detect image sequences.
        function extOf(name) {
            var m = /\.([a-z0-9]+)\s*$/i.exec(name || "");
            return m ? m[1].toLowerCase() : "";
        }
        var IMG = { jpg: 1, jpeg: 1, png: 1, tif: 1, tiff: 1, tga: 1, bmp: 1, exr: 1, psd: 1, ai: 1, eps: 1, hdr: 1, dpx: 1, gif: 1, webp: 1, heic: 1, jp2: 1 };

        // Snapshot first — moving items mutates the live project collection.
        var items = [];
        var k;
        for (k = 1; k <= proj.numItems; k++) items.push(proj.item(k));

        // --- Pass 2: classify + move each item (MN's exact rules). ---
        var moved = 0;
        var i2;
        for (i2 = 0; i2 < items.length; i2++) {
            var it = items[i2];
            if (!it || (it instanceof FolderItem)) continue; // never move folders
            var target = null;

            if (it instanceof CompItem) {
                target = usedAsPrecomp[it.id] ? NAMES.precomps : NAMES.comps;
            } else if (it instanceof FootageItem) {
                var ms = null;
                try { ms = it.mainSource; } catch (eM) { ms = null; }
                var isSolid = false;
                try { isSolid = (ms && (ms instanceof SolidSource)); } catch (eSo) { isSolid = false; }
                var hasV = false, hasA = false, still = false;
                try { hasV = it.hasVideo; } catch (e1) { }
                try { hasA = it.hasAudio; } catch (e2) { }
                try { still = (ms && ms.isStill); } catch (e3) { }
                var e = extOf(it.name);

                if (isSolid) {
                    target = NAMES.solids;
                } else if (hasV && still) {
                    target = NAMES.images;
                } else if (hasV && !still) {
                    target = IMG[e] ? NAMES.sequences : NAMES.video; // moving image footage = sequence
                } else if (hasA && !hasV) {
                    target = NAMES.audio;
                } else {
                    target = NAMES.other;
                }
            } else {
                continue;
            }

            if (target) {
                var folder = dest(target);
                try { if (it.parentFolder !== folder) { it.parentFolder = folder; moved++; } } catch (eMove) { }
            }
        }

        // --- Pass 3: drop any of OUR folders left empty (root-level only). ---
        var ourNames = [];
        var key;
        for (key in NAMES) { if (NAMES.hasOwnProperty(key)) ourNames.push(NAMES[key]); }
        var fI, ni;
        for (fI = proj.numItems; fI >= 1; fI--) {
            try {
                var fit = proj.item(fI);
                if (fit instanceof FolderItem && fit.parentFolder === proj.rootFolder && fit.numItems === 0) {
                    for (ni = 0; ni < ourNames.length; ni++) {
                        if (ourNames[ni] === fit.name) { try { fit.remove(); } catch (eR) { } break; }
                    }
                }
            } catch (eF) { }
        }

        app.endUndoGroup();
        return encodeBridge("OK:Organized " + moved + " item(s)");
    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge("Organize Error: " + e.toString());
    }
}

// =========================================================
// TOOLKIT — TOGGLE EFFECTS
// =========================================================

function toolkitToggleEffects() {
    try {
        if (__CS_TOOLKIT_EFFECT_STATES && __CS_TOOLKIT_EFFECT_STATES.length >= 0) {
            app.beginUndoGroup("Restore Effects");
            var r;
            for (r = 0; r < __CS_TOOLKIT_EFFECT_STATES.length; r++) {
                try { __CS_TOOLKIT_EFFECT_STATES[r].fx.enabled = __CS_TOOLKIT_EFFECT_STATES[r].enabled; } catch (eR) { }
            }
            __CS_TOOLKIT_EFFECT_STATES = null;
            app.endUndoGroup();
            return encodeBridge("OK:Effects restored");
        }

        app.beginUndoGroup("Disable Effects");
        __CS_TOOLKIT_EFFECT_STATES = [];
        var i, j, k;
        for (i = 1; i <= app.project.numItems; i++) {
            try {
                var comp = app.project.item(i);
                if (!(comp instanceof CompItem)) continue;
                for (j = 1; j <= comp.numLayers; j++) {
                    var fxGroup = comp.layer(j).property("ADBE Effect Parade");
                    if (!fxGroup) continue;
                    for (k = 1; k <= fxGroup.numProperties; k++) {
                        var fx = fxGroup.property(k);
                        __CS_TOOLKIT_EFFECT_STATES.push({ fx: fx, enabled: fx.enabled });
                        fx.enabled = false;
                    }
                }
            } catch (eL) { }
        }
        app.endUndoGroup();
        return encodeBridge("OK:Effects disabled");
    } catch (e) {
        try { app.endUndoGroup(); } catch (eU) { }
        return encodeBridge("Effects Toggle Error: " + e.toString());
    }
}

// =========================================================
// TOOLKIT — PRECOMPOSE / UNPRECOMPOSE
// =========================================================

function toolkitCleanPrecompBaseName(name) {
    name = getSafeName(cleanStr(name));
    if (!name) name = "Pre-comp";
    return name;
}

function toolkitCompNameExists(name) {
    try {
        var i;
        for (i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === name) return true;
        }
    } catch (e) { }
    return false;
}

// Snapshot of every comp name in the project as a lookup set.
// PERFORMANCE (Req 6): resolving a unique name by calling toolkitCompNameExists()
// per candidate rescans all project items every time — O(items x candidates) AE
// DOM reads on projects with hundreds of items. One scan builds the same answer.
// The "n" prefix keeps names like "constructor" or "toString" from colliding with
// Object.prototype members.
function toolkitBuildCompNameSet() {
    var set = {};
    try {
        var i;
        for (i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) set["n" + item.name] = true;
        }
    } catch (e) { }
    return set;
}

function toolkitUniquePrecompName(layers) {
    var base = "Pre-comp";
    try {
        if (layers && layers.length === 1) {
            base = toolkitCleanPrecompBaseName(layers[0].name) + " Comp";
        } else if (layers && layers.length > 1) {
            var top = layers[0];
            var i;
            for (i = 1; i < layers.length; i++) if (layers[i].index < top.index) top = layers[i];
            base = toolkitCleanPrecompBaseName(top.name) + " Comp";
        }
    } catch (e) { }

    var taken = toolkitBuildCompNameSet();
    var n = 1;
    var candidate = base + " " + n;
    while (taken["n" + candidate]) {
        n++;
        candidate = base + " " + n;
    }
    return candidate;
}

function toolkitTrimPrecompToLayerSpan(newComp, precompLayer, minIn, maxOut) {
    var span = maxOut - minIn;
    if (!(newComp instanceof CompItem) || span <= 0) return;

    try {
        var i;
        for (i = 1; i <= newComp.numLayers; i++) {
            try { newComp.layer(i).startTime = newComp.layer(i).startTime - minIn; } catch (eL) { }
        }
        newComp.duration = span;
        newComp.workAreaStart = 0;
        newComp.workAreaDuration = span;
    } catch (eC) { }

    try {
        if (precompLayer) {
            precompLayer.startTime = minIn;
            precompLayer.inPoint = minIn;
            precompLayer.outPoint = maxOut;
        }
    } catch (eP) { }
}

function toolkitPrecompose() {
    try {
        var comp = toolkitGetActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");
        var layers = comp.selectedLayers;
        if (!layers || layers.length === 0) return encodeBridge("Select layer(s) to pre-compose.");
        var indices = [];
        var minIn = 999999, maxOut = -999999;
        var i;
        for (i = 0; i < layers.length; i++) {
            indices.push(layers[i].index);
            if (layers[i].inPoint < minIn) minIn = layers[i].inPoint;
            if (layers[i].outPoint > maxOut) maxOut = layers[i].outPoint;
        }
        indices.sort(function (a, b) { return a - b; });
        app.beginUndoGroup("Toolkit Pre-compose");
        var newName = toolkitUniquePrecompName(layers);
        var newComp = comp.layers.precompose(indices, newName, true);
        var precompLayer = null;
        try {
            if (comp.selectedLayers && comp.selectedLayers.length > 0) precompLayer = comp.selectedLayers[0];
        } catch (eSel) { }
        if (!precompLayer) {
            try {
                for (i = 1; i <= comp.numLayers; i++) {
                    if (comp.layer(i) instanceof AVLayer && comp.layer(i).source === newComp) {
                        precompLayer = comp.layer(i);
                        break;
                    }
                }
            } catch (eFind) { }
        }
        toolkitTrimPrecompToLayerSpan(newComp, precompLayer, minIn, maxOut);
        app.endUndoGroup();
        return encodeBridge("OK:Pre-composed");
    } catch (e) {
        try { app.endUndoGroup(); } catch (ee) { }
        return encodeBridge("Pre-compose Error: " + e.toString());
    }
}

function toolkitUnprecompose() {
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

        app.beginUndoGroup("Unprecompose");
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
            
            var anchor = toolkitGetAnchorProp(preLayer).value || [0, 0, 0];
            var position = toolkitGetPositionProp(preLayer).value || [0, 0, 0];
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

        app.endUndoGroup();
        
        if (decompedCount > 0) {
            var msg = "OK:Unpre-composed " + decompedCount + " precomp(s)";
            if (skippedCount > 0) msg += " (" + skippedCount + " skipped)";
            return encodeBridge(msg);
        } else {
            return encodeBridge("Unprecompose skipped: " + skippedReason);
        }
    } catch (err) {
        try { app.endUndoGroup(); } catch (ee) { }
        var msg = "Err: " + err.toString();
        if (msg.length > 70) msg = msg.substring(0, 70) + "...";
        return encodeBridge(msg);
    }
}

// =========================================================
// TOOLKIT — CLEAR CACHE
// =========================================================

function getAEMemoryKB() {
    try {
        var output = system.callSystem('tasklist /FI "IMAGENAME eq AfterFX.exe" /FO CSV /NH');
        if (output) {
            var parts = output.split(",");
            if (parts.length >= 5) {
                var memStr = parts[4].replace(/"/g, "").replace(/K/g, "").replace(/\s/g, "").replace(/[^0-9]/g, "");
                var kb = parseInt(memStr, 10);
                if (!isNaN(kb)) return kb;
            }
        }
    } catch (e) { }
    return 0;
}

function getFolderSizeRobocopy(folderPath) {
    // Returns total bytes in a folder using robocopy /L (list-only) output.
    // Robocopy summary line format: "    Bytes :   366559969408         0    366559969408"
    // We need the FIRST number after "Bytes :" which is the total size.
    // BUG FIX: Previous version grabbed all digits from the line, merging
    // multiple columns (total + copied + skipped) into one giant fake number.
    try {
        var cleanPath = folderPath.replace(/\//g, "\\");
        if (cleanPath.slice(-1) === "\\") {
            cleanPath = cleanPath.slice(0, -1);
        }
        var testFolder = new Folder(cleanPath.replace(/\\/g, "/"));
        if (!testFolder.exists) return 0;

        var cmd = 'robocopy "' + cleanPath + '" "' + cleanPath + '" /L /S /XJ /R:0 /W:0 /BYTES /NFL /NDL /NJH';
        var output = system.callSystem(cmd);
        if (!output) return 0;

        var lines = output.split("\n");
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            // Find the summary line that starts with "Bytes" (after whitespace)
            var trimmed = line.replace(/^\s+/, "");
            if (trimmed.indexOf("Bytes") === 0) {
                // Format: "Bytes :   123456789   0   123456789"
                // Split by ":" then extract first number token
                var afterColon = line.substring(line.indexOf(":") + 1);
                // Split by whitespace to get individual number columns
                var tokens = afterColon.replace(/^\s+/, "").split(/\s+/);
                for (var t = 0; t < tokens.length; t++) {
                    var num = parseFloat(tokens[t]);
                    if (!isNaN(num) && num >= 0) {
                        return num; // First valid number = total bytes
                    }
                }
            }
        }
    } catch (e) { }
    return 0;
}

function getAECacheFolderPath() {
    var section = "Disk Cache Controls";
    var keys = ["Folder", "Folder 1", "Folder 2", "Folder 3", "Folder 4", "Folder 5", "Folder 6", "Folder 7", "Folder 8"];
    var i;
    for (i = 0; i < keys.length; i++) {
        try {
            if (app.preferences.havePref(section, keys[i])) {
                var path = app.preferences.getPrefAsString(section, keys[i]);
                if (path && path.length > 0) {
                    var f = new Folder(path);
                    if (f.exists) return f.fsName;
                }
            }
        } catch (e) { }
    }

    // Fallback: Scan the default temp directory recursively for the "Disk Cache" folder
    try {
        var tempAdobe = new Folder(Folder.temp.fsName + "/Adobe/After Effects");
        if (tempAdobe.exists) {
            var files = tempAdobe.getFiles();
            var j;
            for (j = 0; j < files.length; j++) {
                if (files[j] instanceof Folder && files[j].name.indexOf("Disk Cache") !== -1) {
                    return files[j].fsName;
                }
            }

            // In newer AE versions, there is a version subfolder (e.g. "25.3")
            // Scan one level down for the Disk Cache folder
            for (j = 0; j < files.length; j++) {
                if (files[j] instanceof Folder) {
                    var subFiles = files[j].getFiles();
                    var k;
                    for (k = 0; k < subFiles.length; k++) {
                        if (subFiles[k] instanceof Folder && subFiles[k].name.indexOf("Disk Cache") !== -1) {
                            return subFiles[k].fsName;
                        }
                    }
                }
            }
        }
    } catch (eFallback) { }

    return "";
}

function getAccessibleCacheSize() {
    var totalSize = 0;
    try {
        var diskPath = getAECacheFolderPath();
        if (diskPath) {
            var actualPath = diskPath;
            var diskFolder = new Folder(diskPath);
            if (diskFolder.exists) {
                // If the path is a generic parent directory (like Temp), resolve the actual After Effects "Disk Cache" subfolder
                var files = diskFolder.getFiles();
                var i;
                for (i = 0; i < files.length; i++) {
                    if (files[i] instanceof Folder && files[i].name.indexOf("Disk Cache") !== -1) {
                        actualPath = files[i].fsName;
                        break;
                    }
                }
            }
            var diskSize = getFolderSizeRobocopy(actualPath);
            if (diskSize > 0) totalSize += diskSize;
        }
        var tempFolder = new Folder(Folder.temp.fsName + "/Adobe/After Effects");
        if (tempFolder.exists) {
            var tempSize = getFolderSizeRobocopy(tempFolder.fsName);
            if (tempSize > 0) totalSize += tempSize;
        }

        // Scan for 3D Cache in ProgramData (contains heavy 3D GLB model caches)
        var programDataAdobe = new Folder("C:/ProgramData/Adobe/Common");
        if (programDataAdobe.exists) {
            var subDirs = programDataAdobe.getFiles();
            var i;
            for (i = 0; i < subDirs.length; i++) {
                if (subDirs[i] instanceof Folder) {
                    var aeFolder = new Folder(subDirs[i].fsName + "/After Effects");
                    if (aeFolder.exists) {
                        var aeVerFolders = aeFolder.getFiles();
                        var j;
                        for (j = 0; j < aeVerFolders.length; j++) {
                            if (aeVerFolders[j] instanceof Folder) {
                                var subFiles = aeVerFolders[j].getFiles();
                                var k;
                                for (k = 0; k < subFiles.length; k++) {
                                    if (subFiles[k] instanceof Folder && subFiles[k].name.indexOf("3D Cache") !== -1) {
                                        var c3dSize = getFolderSizeRobocopy(subFiles[k].fsName);
                                        if (c3dSize > 0) totalSize += c3dSize;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch (e) { }
    return totalSize;
}

function toolkitClearCache() {
    var dlgSuppressed = false;
    try {
        // --- Step 1: Measure disk cache BEFORE ---
        var diskBefore = 0;
        try {
            diskBefore = getAccessibleCacheSize();
        } catch (eSizeB) { }

        // --- Step 2: Purge AE RAM caches (image + snapshot) ---
        try {
            app.beginSuppressDialogs();
            dlgSuppressed = true;
        } catch (eSup) { }

        try {
            app.purge(PurgeTarget.ALL_CACHES);
        } catch (ePurge) {
            try { app.purge(PurgeTarget.IMAGE_CACHES); } catch (eImg) { }
            try { app.purge(PurgeTarget.SNAPSHOT_CACHES); } catch (eSnp) { }
        }

        if (dlgSuppressed) {
            try { app.endSuppressDialogs(false); } catch (eEnd) { }
            dlgSuppressed = false;
        }

        // --- Step 3: Clear disk cache files (AE purge only clears RAM) ---
        var diskCleared = 0;
        try {
            var cachePath = getAECacheFolderPath();
            if (cachePath) {
                var cacheFolder = new Folder(cachePath);
                if (cacheFolder.exists) {
                    diskCleared = deleteFolderContents(cacheFolder);
                }
            }
        } catch (eDisk) { }

        // --- Step 4: Measure AFTER and calculate actual freed space ---
        var diskAfter = 0;
        try {
            diskAfter = getAccessibleCacheSize();
        } catch (eSizeA) { }

        // Use the larger of: measured difference vs files-we-deleted
        var freedBytes = diskBefore - diskAfter;
        if (freedBytes < 0) freedBytes = 0;
        if (diskCleared > freedBytes) freedBytes = diskCleared;

        // Format human-readable size
        var msg = "";
        if (freedBytes > 0) {
            msg = "Cache Cleared — " + formatBytes(freedBytes) + " Freed";
        } else {
            msg = "Cache Cleared — All clean";
        }

        return encodeBridge("OK:" + msg);
    } catch (e) {
        if (dlgSuppressed) {
            try { app.endSuppressDialogs(false); } catch (eEnd) { }
        }
        return encodeBridge("Cache Error: " + e.toString());
    }
}

// Format bytes into human readable string (KB/MB/GB)
function formatBytes(bytes) {
    if (bytes <= 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}

// Delete all files and subfolders inside a folder. Returns total bytes deleted.
// Skips locked/in-use files gracefully.
function deleteFolderContents(folder) {
    var totalDeleted = 0;
    if (!folder || !folder.exists) return 0;
    try {
        var items = folder.getFiles();
        for (var i = 0; i < items.length; i++) {
            try {
                if (items[i] instanceof Folder) {
                    // Recursively delete subfolder contents first
                    totalDeleted += deleteFolderContents(items[i]);
                    items[i].remove(); // Remove the now-empty folder
                } else if (items[i] instanceof File) {
                    var fSize = 0;
                    try { fSize = items[i].length; } catch (eLen) { }
                    if (items[i].remove()) {
                        totalDeleted += fSize;
                    }
                    // If remove() returns false, file is locked — skip silently
                }
            } catch (eItem) {
                // Skip files that can't be deleted (locked by AE, permissions, etc.)
            }
        }
    } catch (eList) { }
    return totalDeleted;
}


// =========================================================
// TOOLKIT — RESIZE COMP TREE (resolution + FPS, content-scaled)
// =========================================================
// One-click: set the active comp to a target resolution + FPS, and
// uniformly scale every nested pre-comp (and its content) by the same
// factor so the look is preserved at the higher/lower resolution.
// Timing is untouched (frameRate change does not move keyframes in time).
// Parented layers are skipped (they inherit from their scaled parent).
// Expression-driven transforms are left as-is (can't be safely scaled)
// and counted as a warning. Whole op is ONE undo group — Ctrl+Z reverts all.

function __resizeMulVal(v, F) {
    if (v instanceof Array) {
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(v[i] * F);
        return out;
    }
    return v * F;
}

// Scale a property's value + all keyframes by F.
// Returns 1 scaled, 0 skipped(expression), -1 missing/error.
function __resizeScaleProp(prop, F) {
    if (!prop) return -1;
    try {
        if (prop.expressionEnabled && prop.expression && trimStr(prop.expression) !== "") return 0;
    } catch (eE) { }
    try {
        if (prop.numKeys && prop.numKeys > 0) {
            for (var k = 1; k <= prop.numKeys; k++) {
                prop.setValueAtKey(k, __resizeMulVal(prop.keyValue(k), F));
            }
        } else {
            prop.setValue(__resizeMulVal(prop.value, F));
        }
        return 1;
    } catch (eS) { return -1; }
}

// Scale one layer's spatial transform by F. Position + Anchor always;
// Scale only when the source is NOT a nested comp (that comp is resized
// separately, so its instance must stay at 100%).
function __resizeScaleLayer(layer, F, warn) {
    try {
        if (layer.parent) return; // inherits from scaled parent
        var tr = layer.property("ADBE Transform Group");
        if (!tr) return;

        var isCompSrc = false;
        try { isCompSrc = (layer.source && (layer.source instanceof CompItem)); } catch (eC) { }

        var pos = null;
        try { pos = tr.property("ADBE Position"); } catch (eP) { }
        if (pos) {
            if (pos.dimensionsSeparated) {
                if (__resizeScaleProp(tr.property("ADBE Position_0"), F) === 0) warn.expr++;
                if (__resizeScaleProp(tr.property("ADBE Position_1"), F) === 0) warn.expr++;
                try { var pz = tr.property("ADBE Position_2"); if (pz) __resizeScaleProp(pz, F); } catch (ePZ) { }
            } else {
                if (__resizeScaleProp(pos, F) === 0) warn.expr++;
            }
        }
        try { if (__resizeScaleProp(tr.property("ADBE Anchor Point"), F) === 0) warn.expr++; } catch (eA) { }
        if (!isCompSrc) {
            try { if (__resizeScaleProp(tr.property("ADBE Scale"), F) === 0) warn.expr++; } catch (eSc) { }
        }
    } catch (eL) { }
}

function toolkitResizeCompTree(modeHex) {
    try {
        var parts = cleanStr(decodeBridge(modeHex)).split("|");
        var tierShort = parseInt(parts[0], 10);   // target SHORT-side px (720/1080/1440/2160)
        var targetFPS = parseFloat(parts[1]);

        if (!tierShort || tierShort < 1 || tierShort > 30000) {
            return encodeBridge("Invalid resolution.");
        }
        if (!targetFPS || targetFPS <= 0 || targetFPS > 999) {
            return encodeBridge("Invalid frame rate.");
        }

        // ── Decide the ROOTS to resize ──────────────────────────────
        // Priority:
        //   1) Comps selected in the PROJECT PANEL.
        //   2) Precomp layers selected in the active comp's TIMELINE.
        //   If anything is selected -> resize ONLY those (+ their nested tree).
        //   If nothing is selected -> resize the active comp's WHOLE tree.
        var roots = [];
        var rootSeen = {};
        function addRoot(item) {
            if (item && (item instanceof CompItem) && !rootSeen[item.id]) {
                rootSeen[item.id] = true;
                roots.push(item);
            }
        }

        var usedSelection = false;

        // 1) Project-panel selection (comps only)
        try {
            var psel = app.project.selection;
            if (psel && psel.length) {
                for (var pi = 0; pi < psel.length; pi++) {
                    if (psel[pi] instanceof CompItem) { addRoot(psel[pi]); usedSelection = true; }
                }
            }
        } catch (ePS) { }

        // 2) Timeline-selected layers whose source is a precomp
        var active = app.project.activeItem;
        try {
            if (active && (active instanceof CompItem)) {
                var sl = active.selectedLayers;
                if (sl && sl.length) {
                    for (var si = 0; si < sl.length; si++) {
                        try {
                            var lsrc = sl[si].source;
                            if (lsrc && (lsrc instanceof CompItem)) { addRoot(lsrc); usedSelection = true; }
                        } catch (eLS) { }
                    }
                }
            }
        } catch (eTL) { }

        // 3) Fallback - nothing selected -> use the active comp's whole tree
        if (roots.length === 0) {
            if (active && (active instanceof CompItem)) {
                addRoot(active);
            } else {
                return encodeBridge("Open a comp, or select comp(s)/precomp(s) first.");
            }
        }

        // ── Walk each root's tree, scaling each comp once (global dedupe) ──
        var seen = {};
        var warn = { expr: 0 };
        var changed = 0;
        var firstMW = 0, firstMH = 0;

        app.beginUndoGroup("Resize Comp Tree \u2192 " + tierShort + "p @" + targetFPS);

        for (var r = 0; r < roots.length; r++) {
            var root = roots[r];
            // Per-root uniform factor from its SHORT side -> target tier.
            // Uniform = aspect ratio preserved exactly (only resolution changes).
            var F = tierShort / Math.min(root.width, root.height);
            if (!(F > 0) || !isFinite(F)) continue;

            if (r === 0) {
                firstMW = Math.max(1, Math.round(root.width * F));
                firstMH = Math.max(1, Math.round(root.height * F));
            }

            // Collect this root's tree (skipping comps already handled by an earlier root)
            var comps = [];
            (function collect(comp) {
                if (!comp || !(comp instanceof CompItem)) return;
                if (seen[comp.id]) return;
                seen[comp.id] = true;
                comps.push(comp);
                for (var i = 1; i <= comp.numLayers; i++) {
                    try {
                        var src = comp.layer(i).source;
                        if (src && (src instanceof CompItem)) collect(src);
                    } catch (eC) { }
                }
            })(root);

            for (var c = 0; c < comps.length; c++) {
                var comp = comps[c];
                for (var li = 1; li <= comp.numLayers; li++) {
                    __resizeScaleLayer(comp.layer(li), F, warn);
                }
                try {
                    comp.width = Math.max(1, Math.round(comp.width * F));
                    comp.height = Math.max(1, Math.round(comp.height * F));
                    comp.frameRate = targetFPS;
                    changed++;
                } catch (eDim) { }
            }
        }

        app.endUndoGroup();

        var scope = usedSelection ? "selected" : "active tree";
        var msg = "OK: Resized " + changed + " comp" + (changed === 1 ? "" : "s") + " (" + scope + ") ";
        if (roots.length === 1) {
            msg += "to " + firstMW + "x" + firstMH + " @ " + targetFPS + "fps";
        } else {
            msg += "to " + tierShort + "p short-side @ " + targetFPS + "fps";
        }
        if (warn.expr > 0) msg += " (" + warn.expr + " expr prop(s) skipped)";
        return encodeBridge(msg);
    } catch (e) {
        try { app.endUndoGroup(); } catch (eU) { }
        return encodeBridge("Resize error: " + e.toString());
    }
}
