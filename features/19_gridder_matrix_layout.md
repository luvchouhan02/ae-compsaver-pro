# Feature 19: Gridder / Matrix Layout Tool

> **Feature ID:** FEAT-19  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Floating Window (`gridder.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Arranges selected layers into an aligned grid / matrix layout (e.g. 2x2, 3x3, 4x4) with customizable cell padding, spacing, and order.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Inputs: Rows, Columns, Margin X, Margin Y.
- Positions and scales layers evenly across the composition frame.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitArrangeGrid(rows, cols, padX, padY) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers.");
    app.beginUndoGroup("Arrange Grid");
    var layers = comp.selectedLayers;
    var cellW = (comp.width - (padX * (cols + 1))) / cols;
    var cellH = (comp.height - (padY * (rows + 1))) / rows;
    
    for (var i = 0; i < layers.length; i++) {
        var r = Math.floor(i / cols);
        var c = i % cols;
        var x = padX + (c * (cellW + padX)) + (cellW / 2);
        var y = padY + (r * (cellH + padY)) + (cellH / 2);
        layers[i].transform.position.setValue([x, y]);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 4 video layers, set 2x2 grid -> arranges into quad split-screen instantly.
