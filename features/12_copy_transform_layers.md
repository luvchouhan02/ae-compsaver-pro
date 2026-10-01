# Feature 12: Copy Transform Across Layers

> **Feature ID:** FEAT-12  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Copies Position, Scale, Rotation, and Opacity values from the topmost selected layer to all other selected layers in 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Reads transform values of first layer in selection.
- Applies values to all subsequent selected layers in the active comp.
- Handles both 2D and 3D layers safely.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitCopyTransformAcrossLayers() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length < 2) return encodeBridge("Select master layer and target layers.");
    app.beginUndoGroup("Copy Transform Across Layers");
    var master = comp.selectedLayers[0];
    var mPos = master.transform.position.value;
    var mScale = master.transform.scale.value;
    var mRot = master.transform.rotation ? master.transform.rotation.value : 0;
    var mOp = master.transform.opacity.value;
    
    for (var i = 1; i < comp.selectedLayers.length; i++) {
        var target = comp.selectedLayers[i];
        target.transform.position.setValue(mPos);
        target.transform.scale.setValue(mScale);
        if (target.transform.rotation) target.transform.rotation.setValue(mRot);
        target.transform.opacity.setValue(mOp);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 4 layers, click Copy Transform -> all 3 subordinate layers align with master.
