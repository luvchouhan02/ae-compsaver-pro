# Feature 17: Toggle Layer Switches Batch

> **Feature ID:** FEAT-17  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Mass toggles layer switches (Motion Blur, 3D Layer, Shy, Guide Layer, Solo, Lock) across all selected layers simultaneously.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Quick buttons in toolbar: Motion Blur ON/OFF, 3D ON/OFF, Shy ON/OFF, Guide ON/OFF.
- Executes instantly on all selected layers in active comp.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitToggleBatchSwitches(switchNameHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers.");
    var sw = decodeBridge(switchNameHex);
    app.beginUndoGroup("Toggle Batch Switches");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var lyr = comp.selectedLayers[i];
        if (sw === "motionBlur") lyr.motionBlur = !lyr.motionBlur;
        else if (sw === "threeD") lyr.threeDLayer = !lyr.threeDLayer;
        else if (sw === "shy") lyr.shy = !lyr.shy;
        else if (sw === "guide") lyr.guideLayer = !lyr.guideLayer;
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 10 layers, click 3D switch -> all 10 switch to 3D in 1 click.
