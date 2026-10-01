# Feature 05: Instant Velocity Speed Ramp

> **Feature ID:** FEAT-05  
> **Category:** Video & Timing Manipulations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Applies an instant, professional slow-in / slow-out velocity speed ramp to selected footage via Time Remap with custom eased bezier curves. Turns regular footage into a cinematic velocity edit with 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Works on any footage or precomp layer with video content.
- Automatically enables Time Remap (`timeRemapEnabled = true`).
- Calculates current playhead and sets 4 keyframes: Normal -> Fast Zoom-In -> Slow-Motion Impact -> Normal.
- Applies high-influence bezier easing handles (85% influence) to create punchy velocity transitions.
- Option for presets: "Fast In / Slow Out", "Punch Impact", "Classic Smooth Ramp".

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitApplySpeedRamp(presetHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select a video layer.");
    var lyr = comp.selectedLayers[0];
    if (!lyr.canSetTimeRemapEnabled) return encodeBridge("Layer cannot be time remapped.");
    
    app.beginUndoGroup("Instant Speed Ramp");
    lyr.timeRemapEnabled = true;
    var tr = lyr.property("ADBE Time Remapping");
    var now = comp.time;
    
    // Clear keys in local range and insert ramp keyframe cluster
    var k1Time = Math.max(lyr.inPoint, now - 0.5);
    var k2Time = now - 0.1;
    var k3Time = now + 0.3;
    var k4Time = Math.min(lyr.outPoint, now + 0.8);
    
    tr.setValueAtTime(k1Time, k1Time - lyr.inPoint);
    tr.setValueAtTime(k2Time, (k2Time - lyr.inPoint) + 0.2);
    tr.setValueAtTime(k3Time, (k2Time - lyr.inPoint) + 0.25); // Slow motion segment
    tr.setValueAtTime(k4Time, k4Time - lyr.inPoint);
    
    // Apply 85% bezier curve handles for punchy velocity
    var easeIn = new KeyframeEase(0, 85);
    var easeOut = new KeyframeEase(0, 85);
    for (var k = 1; k <= tr.numKeys; k++) {
        tr.setTemporalEaseAtKey(k, [easeIn], [easeOut]);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select footage layer, place playhead on action moment, click button.
- [ ] Footage speed speeds up, drops into slow-motion at playhead, and ramps back.
- [ ] RAM preview plays smoothly without dropped frames.
