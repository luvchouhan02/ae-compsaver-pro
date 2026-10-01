# Feature 37: 106 Instant "One-Framers" Visual FX & Style Presets Engine

> **Feature ID:** FEAT-37  
> **Category:** Visual Effects & Styling Suite  
> **Target Module:** Effects (FX) Tab (`index.html`, `js/toolkit/effects.js`, `jsx/workflow.jsx`)  
> **Source Data:** Extracted from `MNToolData.ONEFRAMERS` (106 programmatic JSON recipes)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem Statement & Purpose (Yeh feature kya kaam karta hai?)
Video editors frequently need fast, stylistic treatments (Chromatic Aberration, Cyber Glitch, Datamosh, Vintage Film Grain, Lens Bloom, Paparazzi Flash, CRT Scanlines, Acid Trip, Halftone, etc.). 

Traditionally, editors have to manually browse folders for heavy `.ffx` preset files, which often fail due to missing plugin errors or AE version incompatibilities.

**The One-Framers Engine** solves this by providing a **1-click visual presets library of 106 distinctive looks** that use **smart programmatic recipes**. Instead of static files, it directly instructs After Effects via ExtendScript to add native effects and configure their exact slider/color values in under 5 milliseconds.

---

## 2. Exact Requirements (Kya-kya chahiye?)

### A. UI in CompSaver (Effects / FX Tab):
1. **Interactive Preset Card Grid:**
   - Grid of sleek cards displaying preset title (e.g., `Cyber Glitch`, `Bloom`, `Film Grain`, `Teal & Orange`).
   - Color accent pill/dot matching each preset's visual vibe.
   - Live category filter chips:
     * `All (106)`
     * `Glitch & Sci-Fi (24)`
     * `Lens & Optical (22)`
     * `Color Grading (20)`
     * `Film & Vintage (18)`
     * `Artistic & Retro (22)`
   - Search bar: Instant fuzzy filtering by name.
   - Favorite star icon on each card.

2. **Smart Application Modes:**
   - **Default Click:** Applies the preset directly to the selected layer.
   - **Shift + Click (or UI Toggle Switch):** Automatically creates an Adjustment Layer above the selection and applies the effects to it (ideal for global grading and scene looks).

3. **100% Native Fallback System:**
   - Recipes include matchName fallbacks (e.g., if a third-party plugin is not installed, it falls back to native After Effects built-in effects like `ADBE Channel Blur`, `ADBE Glo2`, `ADBE Sharpen`, `ADBE Brightness & Contrast 2`).
   - Zero missing plugin crash warnings.

---

## 3. The 106 Presets Catalog (Sample Categories)

- **Glitches & Cyber:** `Aberration`, `Cyber Glitch`, `Datamosh`, `Data Corrupt`, `Broken TV`, `CRT Pixels`, `ASCII Art`, `Dot Matrix`, `Signal Loss`, `Bit Crush`, `Pixel Dither`, `Mosh Pit`.
- **Lenses & Light FX:** `Bloom`, `Lens Bloom`, `Paparazzi Flash`, `Dream Glow`, `Prism Displacement`, `Camera Shake`, `Color Melt`, `Starburst`, `God Rays`, `Kaleidoscope`.
- **Color Grading & Looks:** `Teal & Orange`, `Blackout`, `Bleach Skip`, `Duotone`, `Cinema Look`, `False Color`, `Night Vision`, `Blood Wash`, `Frost Wash`, `Acid Trip`.
- **Film, Print & Textures:** `Film Grain`, `Halftone`, `Comic Dots`, `Dot Print`, `Charcoal`, `Engrave`, `Mosaic Punch`, `Whiteout`, `Relief`, `Vector Haze`.

---

## 4. How It Works Under The Hood (ExtendScript / JSX Logic)

```javascript
// ExtendScript execution function:
function toolkitApplyOneFramerPreset(recipeJsonHex, applyOnAdjustmentLayer) {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    if (comp.selectedLayers.length === 0 && !applyOnAdjustmentLayer) {
        return encodeBridge("Select a layer or toggle Adjustment Layer mode.");
    }
    
    var recipe = JSON.parse(decodeBridge(recipeJsonHex));
    app.beginUndoGroup("Apply One-Framer: " + recipe.name);
    
    var targetLayer;
    if (applyOnAdjustmentLayer) {
        targetLayer = comp.layers.addSolid([1, 1, 1], "[" + recipe.name + " Look]", comp.width, comp.height, comp.pixelAspect, comp.duration);
        targetLayer.adjustmentLayer = true;
        targetLayer.moveToBeginning();
    } else {
        targetLayer = comp.selectedLayers[0];
    }
    
    // Apply Blend Mode if defined in recipe
    if (recipe.blend === "screen") targetLayer.blendingMode = BlendingMode.SCREEN;
    else if (recipe.blend === "add") targetLayer.blendingMode = BlendingMode.ADD;
    else if (recipe.blend === "multiply") targetLayer.blendingMode = BlendingMode.MULTIPLY;
    
    var fxGroup = targetLayer.property("ADBE Effect Parade");
    
    // Iterate through recipe effects
    for (var i = 0; i < recipe.effects.length; i++) {
        var fxItem = recipe.effects[i];
        var addedEffect = null;
        
        // Try matchNames (string or array of fallbacks)
        if (typeof fxItem.mn === "string") {
            try { addedEffect = fxGroup.addProperty(fxItem.mn); } catch(e) {}
        } else if (fxItem.mn instanceof Array) {
            for (var m = 0; m < fxItem.mn.length; m++) {
                try {
                    addedEffect = fxGroup.addProperty(fxItem.mn[m]);
                    if (addedEffect) break;
                } catch(e) {}
            }
        }
        
        // Apply parameters [[propIndex, value], ...]
        if (addedEffect && fxItem.p && fxItem.p.length > 0) {
            for (var p = 0; p < fxItem.p.length; p++) {
                var propIdx = fxItem.p[p][0];
                var propVal = fxItem.p[p][1];
                try {
                    addedEffect.property(propIdx).setValue(propVal);
                } catch(eP) {}
            }
        }
    }
    
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 5. Definition of Done & Acceptance Checklist
- [ ] Effects (FX) tab contains searchable grid of all 106 One-Framer cards.
- [ ] Category filter chips instantly filter cards (Glitch, Optical, Color, Film, Textures).
- [ ] 1-Click on any card applies effects to selected layer in < 10ms.
- [ ] Shift+Click creates an Adjustment layer and applies the preset to it.
- [ ] Zero missing-file crashes or alert popups.
- [ ] Single Ctrl+Z cleanly undoes the entire preset.
