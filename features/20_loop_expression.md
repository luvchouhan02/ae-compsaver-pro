# Feature 20: 1-Click Seamless Loop Expression

> **Feature ID:** FEAT-20  
> **Category:** Keyframe & Animation Enhancements  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Adds `loopOut("cycle")` or `loopOut("pingpong")` to any selected keyframed property with 1 click so animations repeat infinitely without duplicating keyframes.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Detects selected properties or animated transform properties on selected layers.
- Applies `loopOut("cycle");` safely without syntax errors.
- Zero performance load.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitApplyLoopExpression(modeHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layer.");
    var mode = decodeBridge(modeHex) || "cycle"; // "cycle" or "pingpong"
    app.beginUndoGroup("Apply Loop Expression");
    var props = comp.selectedProperties;
    if (props && props.length > 0) {
        for (var p = 0; p < props.length; p++) {
            if (props[p].canSetExpression) props[p].expression = 'loopOut("' + mode + '");';
        }
    } else {
        // Fallback to position/rotation if keyframed
        var lyr = comp.selectedLayers[0];
        if (lyr.transform.position.numKeys > 1) lyr.transform.position.expression = 'loopOut("' + mode + '");';
        if (lyr.transform.rotation && lyr.transform.rotation.numKeys > 1) lyr.transform.rotation.expression = 'loopOut("' + mode + '");';
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select animated position keyframes, click Loop -> animation plays continuously.
