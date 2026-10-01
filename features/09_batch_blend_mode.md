# Feature 09: Batch Blend Mode Changer

> **Feature ID:** FEAT-09  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Changes the blending mode (Add, Screen, Multiply, Overlay, Normal, Difference) of all selected layers simultaneously in 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Dropdown or palette in UI: Screen, Add, Multiply, Overlay, Soft Light, Darken, Normal.
- Iterates through all selected layers and sets `layer.blendingMode` in a single undo group.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitSetBatchBlendMode(modeNameHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers.");
    var modeStr = decodeBridge(modeNameHex).toLowerCase();
    var modeMap = {
        "screen": BlendingMode.SCREEN,
        "add": BlendingMode.ADD,
        "multiply": BlendingMode.MULTIPLY,
        "overlay": BlendingMode.OVERLAY,
        "normal": BlendingMode.NORMAL,
        "soft_light": BlendingMode.SOFT_LIGHT
    };
    var targetMode = modeMap[modeStr] || BlendingMode.NORMAL;
    app.beginUndoGroup("Batch Blend Mode");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        comp.selectedLayers[i].blendingMode = targetMode;
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 5 texture layers, click "Screen" -> all 5 instantly switch to Screen blend mode.
