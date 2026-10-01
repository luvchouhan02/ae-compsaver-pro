# Feature 26: Audio Amplitude to Keyframes Rig

> **Feature ID:** FEAT-26  
> **Category:** Audio & Music Beats Workflow  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Converts the volume/amplitude of an audio track into keyframes on a Null object with built-in smoothing and multiplier sliders to drive scale, glow, and camera pulsing to the beat.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Invokes AE command "Convert Audio to Keyframes".
- Creates a master controller Null named `[AUDIO CONTROLLER]` with customizable sliders: Sensitivity, Min Value, Max Value.
- Zero script errors.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitAudioToKeyframes() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select an audio layer.");
    var audioLy = comp.selectedLayers[0];
    if (!audioLy.hasAudio) return encodeBridge("Selected layer must have audio.");
    
    app.beginUndoGroup("Audio to Keyframes");
    app.executeCommand(app.findMenuCommandId("Convert Audio to Keyframes"));
    var ampLayer = comp.layer("Audio Amplitude");
    if (ampLayer) {
        var fx = ampLayer.property("ADBE Effect Parade");
        var mult = fx.addProperty("ADBE Slider Control");
        mult.name = "Multiplier";
        mult.property(1).setValue(1.5);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select music layer, click Audio to Keyframes -> Amplitude null created with multiplier slider.
