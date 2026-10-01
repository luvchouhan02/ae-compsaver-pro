# Feature 02: Responsive Auto-Resizing Text Box

> **Feature ID:** FEAT-02  
> **Category:** Typography & Captions Suite  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Creates a rounded background plate/shape layer behind the selected text layer that automatically resizes, expands, or shrinks whenever the text or font size changes. Perfect for modern captions, subtitles, lower thirds, and callout badges.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Must work dynamically on any selected text layer in active composition.
- Generates a native Shape Layer placed directly below the text layer and parented to it.
- Uses clean After Effects expressions on the Shape Path (Rectangle Size) using `sourceRectAtTime()` with customizable padding (Horizontal/Vertical) and corner roundness.
- Adds sliders or pseudo-effect controls for: Padding X, Padding Y, Corner Radius, and Fill Color.
- Zero external asset dependency, instant 1-click generation in < 50ms.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitCreateResponsiveTextBox() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    if (comp.selectedLayers.length === 0) return encodeBridge("Select a text layer.");
    var textLayer = comp.selectedLayers[0];
    if (!(textLayer instanceof TextLayer)) return encodeBridge("Selected layer must be a text layer.");
    
    app.beginUndoGroup("Create Responsive Text Box");
    var shapeLayer = comp.layers.addShape();
    shapeLayer.name = textLayer.name + " Box";
    shapeLayer.moveAfter(textLayer);
    shapeLayer.parent = textLayer;
    
    // Add controls: Padding X, Padding Y, Roundness
    var fxGroup = shapeLayer.property("ADBE Effect Parade");
    var padX = fxGroup.addProperty("ADBE Slider Control"); padX.name = "Padding X"; padX.property(1).setValue(30);
    var padY = fxGroup.addProperty("ADBE Slider Control"); padY.name = "Padding Y"; padY.property(1).setValue(20);
    var roundness = fxGroup.addProperty("ADBE Slider Control"); roundness.name = "Roundness"; roundness.property(1).setValue(20);
    
    // Build Shape Group (Rectangle Path + Fill)
    var contents = shapeLayer.property("ADBE Root Vectors Group");
    var rectGroup = contents.addProperty("ADBE Vector Group");
    rectGroup.name = "Box Group";
    var rectVectors = rectGroup.property("ADBE Vectors Group");
    var rect = rectVectors.addProperty("ADBE Vector Shape - Rect");
    var fill = rectVectors.addProperty("ADBE Vector Graphic - Fill");
    fill.property("ADBE Vector Fill Color").setValue([0.08, 0.08, 0.1, 1]); // Dark premium slate
    
    // Expressions linking rect size & position to text layer bounds
    rect.property("ADBE Vector Rect Size").expression = 
        'var t = thisComp.layer("' + textLayer.name + '");\n' +
        'var r = t.sourceRectAtTime(time, false);\n' +
        'var px = effect("Padding X")(1);\n' +
        'var py = effect("Padding Y")(1);\n' +
        '[r.width + px * 2, r.height + py * 2];';
        
    rect.property("ADBE Vector Rect Position").expression = 
        'var t = thisComp.layer("' + textLayer.name + '");\n' +
        'var r = t.sourceRectAtTime(time, false);\n' +
        '[r.left + r.width / 2, r.top + r.height / 2];';
        
    rect.property("ADBE Vector Rect Roundness").expression = 'effect("Roundness")(1);';
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select text layer and click button -> shape layer appears behind text.
- [ ] Typing new text dynamically resizes the box in real-time.
- [ ] Changing Padding X/Y or Roundness sliders adjusts box dimensions smoothly.
- [ ] Moving or scaling the text layer moves the box with it.
