# Feature 11: Match Composition Frame Size

> **Feature ID:** FEAT-11  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Scales selected layers so their width and height perfectly fill the active composition frame (Fit to Comp).

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Computes `comp.width / layer.width * 100` and `comp.height / layer.height * 100`.
- Option 1: Fit to Width & Height (Stretch to fill).
- Option 2: Fit Proportional (Crop to fill without distortion).

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitMatchCompSize(proportional) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers.");
    app.beginUndoGroup("Match Comp Size");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var lyr = comp.selectedLayers[i];
        var sx = (comp.width / lyr.width) * 100;
        var sy = (comp.height / lyr.height) * 100;
        if (proportional) {
            var maxScale = Math.max(sx, sy);
            lyr.property("ADBE Transform Group").property("ADBE Scale").setValue([maxScale, maxScale]);
        } else {
            lyr.property("ADBE Transform Group").property("ADBE Scale").setValue([sx, sy]);
        }
        lyr.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select mismatched photo or footage, click Match Comp -> fits composition 100%.
