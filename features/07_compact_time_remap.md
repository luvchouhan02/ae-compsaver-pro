# Feature 07: Compact Time Remap Cleaner

> **Feature ID:** FEAT-07  
> **Category:** Video & Timing Manipulations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Cleans up cluttered, redundant, or fractional Time Remap keyframes on imported footage or retimed sequences, condensing them to 1 clean key per frame and trimming the layer out-point.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Removes micro-fractional duplicate keys created by plugins or external imports.
- Snaps all Time Remap keys to exact frame boundaries.
- Trims layer outPoint to match the final valid frame.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitCompactTimeRemap() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layer with time remap.");
    app.beginUndoGroup("Compact Time Remap");
    var lyr = comp.selectedLayers[0];
    var tr = lyr.property("ADBE Time Remapping");
    if (!tr || tr.numKeys < 2) return encodeBridge("No time remap keys found.");
    
    var fps = comp.frameRate;
    for (var k = 1; k <= tr.numKeys; k++) {
        var t = tr.keyTime(k);
        var snappedT = Math.round(t * fps) / fps;
        var val = tr.keyValue(k);
        var snappedVal = Math.round(val * fps) / fps;
        tr.setValueAtTime(snappedT, snappedVal);
    }
    lyr.outPoint = tr.keyTime(tr.numKeys);
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Cleans up broken time remap curves in 1 click.
- [ ] Aligns keyframes to exact frame increments.
