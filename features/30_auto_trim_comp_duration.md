# Feature 30: Auto-Trim Comp to Content / Last Layer

> **Feature ID:** FEAT-30  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Trims composition duration to exactly match the out-point of the latest layer (removes dead space at the end of the comp) or trims to current Work Area.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Finds max `layer.outPoint` across all enabled layers.
- Sets `comp.duration = maxOutPoint`.
- Optionally trims to Work Area in 1 click.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitAutoTrimCompDuration(toWorkArea) {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    app.beginUndoGroup("Auto-Trim Comp Duration");
    if (toWorkArea) {
        comp.duration = comp.workAreaDuration;
        comp.displayStartTime = comp.workAreaStart;
    } else {
        var maxOut = 0;
        for (var i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i).outPoint > maxOut) maxOut = comp.layer(i).outPoint;
        }
        if (maxOut > 0) comp.duration = maxOut;
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Auto-Trim -> comp duration instantly snaps to the end of footage.
