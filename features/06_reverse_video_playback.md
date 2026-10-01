# Feature 06: 1-Click Reverse Video Playback

> **Feature ID:** FEAT-06  
> **Category:** Video & Timing Manipulations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Instantly reverses video playback of selected layers on the timeline without re-rendering or exporting via native Time Remapping.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Enables Time Remap on selected footage or precomp layers.
- Swaps start and end time values so footage plays from end to beginning.
- Keeps original layer in/out duration intact.
- Works in < 10ms with zero CPU load.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitReversePlayback() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers to reverse.");
    
    app.beginUndoGroup("Reverse Video Playback");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var lyr = comp.selectedLayers[i];
        if (!lyr.canSetTimeRemapEnabled) continue;
        lyr.timeRemapEnabled = true;
        var tr = lyr.property("ADBE Time Remapping");
        var inVal = tr.valueAtTime(lyr.inPoint, false);
        var outVal = tr.valueAtTime(lyr.outPoint, false);
        
        while (tr.numKeys > 0) tr.removeKey(1);
        tr.setValueAtTime(lyr.inPoint, outVal);
        tr.setValueAtTime(lyr.outPoint, inVal);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select any video layer and click Reverse.
- [ ] Layer plays backwards from outPoint to inPoint.
- [ ] One-click execution in < 10ms.
