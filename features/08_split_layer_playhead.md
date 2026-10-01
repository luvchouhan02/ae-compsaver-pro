# Feature 08: Split Layer at Playhead (Razor Tool)

> **Feature ID:** FEAT-08  
> **Category:** Video & Timing Manipulations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Performs a razor blade cut on all selected layers at the current playhead time, creating two clean segments (In to Playhead, and Playhead to Out) with 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Splits multiple selected layers at `comp.time`.
- Left segment outPoint ends at playhead; right segment inPoint starts at playhead.
- Preserves effects, parenting, blend modes, and expressions on both halves.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitSplitLayerAtPlayhead() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers to split.");
    var now = comp.time;
    app.beginUndoGroup("Split Layer at Playhead");
    var sel = comp.selectedLayers.slice(0);
    for (var i = 0; i < sel.length; i++) {
        var lyr = sel[i];
        if (now <= lyr.inPoint || now >= lyr.outPoint) continue;
        var dup = lyr.duplicate();
        lyr.outPoint = now;
        dup.inPoint = now;
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select layers, place playhead at middle, click Split Layer.
- [ ] Layers are cleanly split into two halves at the playhead.
