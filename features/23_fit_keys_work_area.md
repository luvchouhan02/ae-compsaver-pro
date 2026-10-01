# Feature 23: Fit Keyframes to Work Area

> **Feature ID:** FEAT-23  
> **Category:** Keyframe & Animation Enhancements  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Stretches or compresses the span of selected keyframes so they exactly span from the start to the end of the composition Work Area.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Measures `workAreaStart` and `workAreaDuration`.
- Scales keyframe times proportionally so first key touches workAreaStart and last key touches workAreaEnd.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitFitKeysToWorkArea() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    app.beginUndoGroup("Fit Keys to Work Area");
    var wStart = comp.workAreaStart;
    var wDur = comp.workAreaDuration;
    var props = comp.selectedProperties;
    for (var p = 0; p < props.length; p++) {
        var prop = props[p];
        if (prop.numKeys >= 2) {
            var kStart = prop.keyTime(1);
            var kDur = prop.keyTime(prop.numKeys) - kStart;
            if (kDur <= 0) continue;
            // Store and remap
            var stored = [];
            for (var k = 1; k <= prop.numKeys; k++) {
                var progress = (prop.keyTime(k) - kStart) / kDur;
                stored.push({ time: wStart + (progress * wDur), val: prop.keyValue(k) });
            }
            while (prop.numKeys > 0) prop.removeKey(1);
            for (var s = 0; s < stored.length; s++) {
                prop.setValueAtTime(stored[s].time, stored[s].val);
            }
        }
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Set work area to 2 seconds, click Fit Keys -> keyframes smoothly stretch to 2s.
