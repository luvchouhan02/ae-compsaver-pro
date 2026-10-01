# Feature 21: Hold Keyframe Switcher

> **Feature ID:** FEAT-21  
> **Category:** Keyframe & Animation Enhancements  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Converts selected keyframes to Hold Interpolation (stepped / stop-motion style), preventing in-between interpolation.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Sets `keyOutInterpolationType = KeyframeInterpolationType.HOLD` on all selected keyframes.
- Executes instantly.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitConvertToHoldKeyframes() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    app.beginUndoGroup("Convert to Hold Keyframes");
    var props = comp.selectedProperties;
    for (var i = 0; i < props.length; i++) {
        var prop = props[i];
        if (prop.selectedKeys) {
            for (var k = 0; k < prop.selectedKeys.length; k++) {
                prop.setInterpolationTypeAtKey(prop.selectedKeys[k], prop.keyInInterpolationType(prop.selectedKeys[k]), KeyframeInterpolationType.HOLD);
            }
        }
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select keyframes, click Hold Keys -> animation becomes stepped instantly.
