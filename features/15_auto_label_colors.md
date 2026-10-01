# Feature 15: Auto Label Color Assignment

> **Feature ID:** FEAT-15  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Scans the active composition and automatically color-codes all timeline layers based on their type (Text, Audio, Solid, Comp, Adjustment, Footage, Camera, Light) so timelines stay organized.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Assigns distinct AE label colors:
- - Text Layers: Orange (9)
- - Audio Layers: Green (10)
- - Solids / Backgrounds: Red (1)
- - Precomps: Yellow (2)
- - Adjustment Layers: Blue (8)
- - Null Objects: Purple (11)
- - Footage: Cyan (4).

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitAutoLabelColors() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    app.beginUndoGroup("Auto Label Colors");
    for (var i = 1; i <= comp.numLayers; i++) {
        var lyr = comp.layer(i);
        if (lyr instanceof TextLayer) lyr.label = 9; // Orange
        else if (lyr.hasAudio && !lyr.hasVideo) lyr.label = 10; // Green
        else if (lyr.nullLayer) lyr.label = 11; // Purple
        else if (lyr.adjustmentLayer) lyr.label = 8; // Blue
        else if (lyr.source instanceof CompItem) lyr.label = 2; // Yellow
        else if (lyr.source && lyr.source.mainSource instanceof SolidSource) lyr.label = 1; // Red
        else lyr.label = 4; // Cyan
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Auto Label Colors -> entire timeline organizes into color-coded blocks.
