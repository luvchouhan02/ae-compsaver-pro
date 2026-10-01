# Feature 10: 1-Click Mirror / Flip Horizontal & Vertical

> **Feature ID:** FEAT-10  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Flips selected layers horizontally (mirrors scale X) or vertically (mirrors scale Y) around their anchor point in 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Two actions: Flip Horizontal (Flip H) and Flip Vertical (Flip V).
- Inverts current Scale X or Scale Y (e.g. `100` becomes `-100`, or `-100` becomes `100`).
- Preserves keyframes if scale is animated.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitFlipLayer(axisHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers to flip.");
    var axis = decodeBridge(axisHex); // "h" or "v"
    app.beginUndoGroup("Flip Layer");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var scaleProp = comp.selectedLayers[i].property("ADBE Transform Group").property("ADBE Scale");
        var cur = scaleProp.value;
        if (axis === "h") scaleProp.setValue([-cur[0], cur[1], cur[2] || 100]);
        else scaleProp.setValue([cur[0], -cur[1], cur[2] || 100]);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Flip H -> layer horizontally inverts instantly.
- [ ] Click Flip V -> layer vertically inverts instantly.
