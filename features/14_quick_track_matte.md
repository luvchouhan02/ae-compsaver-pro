# Feature 14: Quick Track Matte Setup

> **Feature ID:** FEAT-14  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Sets the selected layer as an Alpha or Luma Track Matte for the layer directly underneath it in 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Supports modern After Effects CC 2023+ Track Matte system (`setTrackMatte`).
- Supports fallback for legacy AE versions (`trackMatteType`).
- Options: Alpha Matte, Alpha Inverted, Luma Matte, Luma Inverted.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitSetQuickTrackMatte(matteTypeHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select a layer.");
    var type = decodeBridge(matteTypeHex) || "alpha";
    app.beginUndoGroup("Quick Track Matte");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var lyr = comp.selectedLayers[i];
        if (lyr.index < comp.numLayers) {
            var target = comp.layer(lyr.index + 1);
            if (target.setTrackMatte) {
                target.setTrackMatte(lyr, type === "luma" ? TrackMatteType.LUMA : TrackMatteType.ALPHA);
            }
        }
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Place graphic above video, click Quick Matte -> graphic acts as matte for video.
