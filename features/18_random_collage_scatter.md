# Feature 18: Random Collage / Scatter Generator

> **Feature ID:** FEAT-18  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Randomizes Scale, Rotation, and Position offsets of selected layers to build instant photo collages, sticker scrawls, or scatter backgrounds.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Random rotation range: e.g. -15° to +15°.
- Random scale range: e.g. 80% to 110%.
- Random position jitter across comp width/height.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitRandomCollageScatter() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers.");
    app.beginUndoGroup("Random Collage Scatter");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var lyr = comp.selectedLayers[i];
        var rot = (Math.random() * 30) - 15;
        var scaleMul = 0.85 + (Math.random() * 0.3);
        if (lyr.transform.rotation) lyr.transform.rotation.setValue(rot);
        var curScale = lyr.transform.scale.value;
        lyr.transform.scale.setValue([curScale[0] * scaleMul, curScale[1] * scaleMul]);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 8 photo layers, click Scatter -> instantly creates an artistic sticker collage.
