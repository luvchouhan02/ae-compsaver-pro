# Feature 22: Copy-Paste Expressions Across Layers

> **Feature ID:** FEAT-22  
> **Category:** Keyframe & Animation Enhancements  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Copies expressions from the active property of the first selected layer and applies them to all other selected layers.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Copies transform expressions (Position, Scale, Rotation, Opacity) across multiple layers.
- Skips properties that already have matching expressions.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitCopyExpressionsAcrossLayers() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length < 2) return encodeBridge("Select source layer and target layers.");
    app.beginUndoGroup("Copy Expressions Across Layers");
    var src = comp.selectedLayers[0];
    for (var i = 1; i < comp.selectedLayers.length; i++) {
        var tgt = comp.selectedLayers[i];
        if (src.transform.position.expression) tgt.transform.position.expression = src.transform.position.expression;
        if (src.transform.scale.expression) tgt.transform.scale.expression = src.transform.scale.expression;
        if (src.transform.rotation && src.transform.rotation.expression && tgt.transform.rotation) {
            tgt.transform.rotation.expression = src.transform.rotation.expression;
        }
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select master with wiggle expression, select 4 others, click Copy Expression -> all wiggle.
