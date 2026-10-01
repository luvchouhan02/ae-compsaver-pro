# Feature 40: 2.5D Depth Extruder & Bevel Rig

> **Feature ID:** FEAT-40  
> **Category:** Visual Effects & Styling Suite  
> **Target Module:** Toolkit Toolbar (`extrude.html`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Generates faux 3D depth extrusion for flat 2D shape layers, text layers, or vector logos by creating stacked Z-axis depth slices with shaded bevel lighting and a master controller null.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Slider for Extrude Depth (e.g. 10 to 100 slices along Z-axis).
- Shading gradient slider: Front face bright, sides shaded darker for realistic 3D appearance.
- Master 3D Null controller that rotates and repositions all slices in tandem.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitExtrudeLayer25D(depthSlices) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select a 2D layer.");
    var src = comp.selectedLayers[0];
    app.beginUndoGroup("2.5D Depth Extrude");
    src.threeDLayer = true;
    var masterNull = comp.layers.addNull();
    masterNull.threeDLayer = true;
    masterNull.name = src.name + " [3D Controller]";
    masterNull.position.setValue(src.position.value);
    src.parent = masterNull;
    
    var slices = parseInt(depthSlices) || 20;
    for (var i = 1; i <= slices; i++) {
        var dup = src.duplicate();
        dup.name = src.name + " [Depth " + i + "]";
        dup.parent = masterNull;
        dup.position.setValue([src.position.value[0], src.position.value[1], src.position.value[2] + i]);
        // Add brightness drop to sides
        var fx = dup.property("ADBE Effect Parade").addProperty("ADBE Brightness & Contrast 2");
        fx.property(1).setValue(- (i * 2));
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select logo, set depth 25, click Extrude -> creates 3D extruded block with shaded sides.
- [ ] Rotating master null rotates the 3D block seamlessly.
