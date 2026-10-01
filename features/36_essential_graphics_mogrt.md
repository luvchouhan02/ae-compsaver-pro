# Feature 36: Essential Graphics / MOGRT Push

> **Feature ID:** FEAT-36  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Adds selected layer properties (Source Text, Color, Position, Slider Controls) directly into the Essential Graphics panel with 1 click to streamline MOGRT template creation for Premiere Pro.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Detects selected properties.
- Calls `prop.addToMotionGraphicsTemplate(comp)` in AE CC 2020+.
- Zero manual drag-and-drop needed.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitAddToEssentialGraphics() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    app.beginUndoGroup("Add to Essential Graphics");
    var props = comp.selectedProperties;
    var count = 0;
    for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (p.canAddToMotionGraphicsTemplate && p.canAddToMotionGraphicsTemplate(comp)) {
            p.addToMotionGraphicsTemplate(comp);
            count++;
        }
    }
    app.endUndoGroup();
    return encodeBridge("Added " + count + " properties to Essential Graphics.");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select Text Document property, click Push to MOGRT -> property lands in Essential Graphics panel.
