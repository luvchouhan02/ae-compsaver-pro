# Feature 16: Batch Layer & Comp Renamer

> **Feature ID:** FEAT-16  
> **Category:** Layer Stacking, Transforms & Batch Operations  
> **Target Module:** Toolkit Dialog (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Batch-renames selected layers or project compositions with Find/Replace, Prefix, Suffix, and auto-numbering (`_01`, `_02`).

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Input fields: Prefix, Base Name, Suffix, Find, Replace With, Start Numbering padding.
- Works on either selected timeline layers or selected items in the Project panel.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitBatchRename(configHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select layers to rename.");
    var cfg = JSON.parse(decodeBridge(configHex));
    app.beginUndoGroup("Batch Rename");
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var lyr = comp.selectedLayers[i];
        var name = lyr.name;
        if (cfg.find) name = name.replace(new RegExp(cfg.find, "g"), cfg.replace || "");
        if (cfg.base) name = cfg.base;
        if (cfg.number) name += "_" + (i + 1 < 10 ? "0" + (i + 1) : (i + 1));
        if (cfg.prefix) name = cfg.prefix + name;
        if (cfg.suffix) name = name + cfg.suffix;
        lyr.name = name;
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 5 layers, add prefix "VFX_" and numbering -> `VFX_Layer_01`, `VFX_Layer_02`.
