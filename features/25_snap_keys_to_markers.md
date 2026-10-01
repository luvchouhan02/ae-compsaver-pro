# Feature 25: Snap Keyframes to Markers

> **Feature ID:** FEAT-25  
> **Category:** Keyframe & Animation Enhancements  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Snaps nearby keyframes to the closest layer or composition marker on the timeline (magnetic snapping for music beat sync).

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Reads all marker times from active composition or audio layer.
- Shifts selected keyframes to the closest marker within a 5-frame threshold.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitSnapKeysToMarkers() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    app.beginUndoGroup("Snap Keys to Markers");
    var markers = [];
    for (var m = 1; m <= comp.markerProperty.numKeys; m++) {
        markers.push(comp.markerProperty.keyTime(m));
    }
    if (markers.length === 0) return encodeBridge("No comp markers found.");
    
    var props = comp.selectedProperties;
    for (var p = 0; p < props.length; p++) {
        var prop = props[p];
        for (var k = 1; k <= prop.numKeys; k++) {
            var kt = prop.keyTime(k);
            // find closest
            var closest = markers[0];
            var minDiff = Math.abs(kt - closest);
            for (var j = 1; j < markers.length; j++) {
                var diff = Math.abs(kt - markers[j]);
                if (diff < minDiff) { minDiff = diff; closest = markers[j]; }
            }
            if (minDiff < 0.2) { // within 5 frames
                var val = prop.keyValue(k);
                prop.setValueAtTime(closest, val);
                prop.removeKey(k);
            }
        }
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Place beat markers, click Snap Keys -> keyframes align to beat markers.
