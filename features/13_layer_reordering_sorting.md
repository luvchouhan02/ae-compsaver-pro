# Feature 13: Layer Reordering, Sorting & Shuffle

> **Feature ID:** FEAT-13  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Reorders selected layers in the timeline stack by Name (A-Z or Z-A), Label Color, In-Point (Earliest on Top vs Latest on Top), or Random Shuffle.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Modes: "Sort by In-Point", "Sort by Name", "Sort by Label Color", "Random Shuffle".
- Maintains exact layer timing and contents, only rearranges visual layer stacking order index.
- Instant execution in < 30ms.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitSortLayers(sortModeHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length < 2) return encodeBridge("Select at least 2 layers.");
    var mode = decodeBridge(sortModeHex); // "inPoint", "name", "shuffle"
    app.beginUndoGroup("Sort Layers");
    var layers = comp.selectedLayers.slice(0);
    
    if (mode === "inPoint") {
        layers.sort(function(a, b) { return a.inPoint - b.inPoint; });
    } else if (mode === "name") {
        layers.sort(function(a, b) { return a.name.localeCompare(b.name); });
    } else if (mode === "shuffle") {
        layers.sort(function() { return 0.5 - Math.random(); });
    }
    for (var i = 0; i < layers.length; i++) {
        layers[i].moveToBeginning();
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 10 staggered layers, click Sort by In-Point -> layers stack chronologically.
