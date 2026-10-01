# Feature 03: Text Splitter into Letters, Words, and Lines

> **Feature ID:** FEAT-03  
> **Category:** Typography & Captions Suite  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/text.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Breaks any text layer into separate individual layers by Letters (characters), Words, or Lines without expressions or complex animators. Essential for kinetic typography, staggered reveals, and TikTok/Reels caption animations.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Dropdown or modal option: Split by Characters (Letters), Split by Words, or Split by Lines.
- Pixel-perfect alignment: Each newly generated layer must sit at the exact visual screen coordinate as the original word/letter.
- Preserves original font family, weight, size, color, stroke, tracking, and leading.
- Auto-parents all split layers to a shared Master Null controller.
- Optional Stagger checkbox: Staggers split layers by 1-3 frames on timeline.
- Original text layer is set to Guide Layer or hidden so it remains safe as backup.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitSplitText(splitModeHex) {
    var comp = getSafeActiveComp();
    if (!comp || comp.selectedLayers.length === 0) return encodeBridge("Select a text layer.");
    var srcLayer = comp.selectedLayers[0];
    if (!(srcLayer instanceof TextLayer)) return encodeBridge("Selected layer must be text.");
    
    var mode = decodeBridge(splitModeHex) || "words"; // "letters", "words", "lines"
    app.beginUndoGroup("Split Text");
    
    var textProp = srcLayer.property("ADBE Text Properties").property("ADBE Text Document");
    var doc = textProp.value;
    var fullText = doc.text;
    
    var tokens = [];
    if (mode === "letters") tokens = fullText.split("");
    else if (mode === "lines") tokens = fullText.split(/\r\n|\r|\n/);
    else tokens = fullText.split(/\s+/);
    
    var masterNull = comp.layers.addNull();
    masterNull.name = srcLayer.name + " [Master Null]";
    masterNull.transform.position.setValue(srcLayer.transform.position.value);
    
    // Duplicate layer per token, mask or set text string while matching character metrics
    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i] === "" || tokens[i] === " ") continue;
        var newLy = srcLayer.duplicate();
        newLy.name = tokens[i];
        var newDoc = newLy.property("ADBE Text Properties").property("ADBE Text Document").value;
        newDoc.text = tokens[i];
        newLy.property("ADBE Text Properties").property("ADBE Text Document").setValue(newDoc);
        newLy.parent = masterNull;
    }
    srcLayer.enabled = false;
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Selecting a text layer and clicking "Split by Words" generates one layer per word.
- [ ] Visual layout and coordinates match the source text identically.
- [ ] Master null moves all split words together.
- [ ] Zero expressions left on the split layers.
