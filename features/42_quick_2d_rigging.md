# Feature 42: Quick 2D Layer Rigging (Parenting & Joint Hierarchy)

> **Feature ID:** FEAT-42  
> **Category:** Motion Design & Rigging  
> **Target Module:** Toolkit Toolbar (`rig.html`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Sets up joint hierarchies and parent-child rigging chains for character limbs (Head -> Neck -> Torso -> Hip) or multi-part graphics with 1 click, creating zero-rotation controller nulls at layer joint boundaries.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Selected layers chained in hierarchy (1 -> 2 -> 3).
- Places a controller Null at each layer joint / anchor point.
- Parents child layer to controller, and controller to parent limb.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitBuild2DRigChain() {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length < 2) return encodeBridge("Select at least 2 layers in chain order.");
    app.beginUndoGroup("Build 2D Rig Chain");
    var layers = comp.selectedLayers;
    for (var i = layers.length - 1; i > 0; i--) {
        layers[i].parent = layers[i - 1];
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select Arm, Forearm, Hand -> click Rig Chain -> creates hierarchical joint parenting.
