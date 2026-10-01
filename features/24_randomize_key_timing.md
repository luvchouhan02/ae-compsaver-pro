# Feature 24: Randomize Keyframe Timing

> **Feature ID:** FEAT-24  
> **Category:** Keyframe & Animation Enhancements  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Randomly offsets/jitters the keyframes of selected layers in time by a small range (e.g. ±2-5 frames) for a more organic, human, and staggered feel.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Input: max jitter frames (e.g. 3 frames).
- Shifts all keys of each layer forward or backward by random frame offset.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitRandomizeKeyTiming(maxFramesHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers.");
    var maxOffsetSec = (parseInt(decodeBridge(maxFramesHex)) || 3) / comp.frameRate;
    app.beginUndoGroup("Randomize Key Timing");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var lyr = comp.selectedLayers[i];
        var offset = (Math.random() * (maxOffsetSec * 2)) - maxOffsetSec;
        // Shift layer in/out and keyframes
        lyr.startTime += offset;
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 10 identical animated layers, click Randomize -> animation looks natural & staggered.
