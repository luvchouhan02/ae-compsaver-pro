# Feature 27: Audio Beat Detector & BPM Markers

> **Feature ID:** FEAT-27  
> **Category:** Audio & Music Beats Workflow  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Drops timeline markers automatically on musical beats using BPM grid or audio peaks so editors can cut on the beat effortlessly.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Option 1: Input BPM (e.g. 120 BPM) -> automatically places markers every `60/BPM` seconds.
- Option 2: Peak detector threshold.
- Clears or updates markers cleanly.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitAddBpmMarkers(bpmHex) {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    var bpm = parseFloat(decodeBridge(bpmHex)) || 120;
    var interval = 60 / bpm;
    app.beginUndoGroup("Add BPM Markers");
    for (var t = comp.workAreaStart; t < comp.workAreaStart + comp.workAreaDuration; t += interval) {
        var m = new MarkerValue(Math.round(t * bpm / 60).toString());
        comp.markerProperty.setValueAtTime(t, m);
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Enter 128 BPM, click Add Markers -> markers appear at every beat across work area.
