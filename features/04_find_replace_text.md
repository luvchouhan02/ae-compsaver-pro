# Feature 04: Find & Replace Text Across Comps/Project

> **Feature ID:** FEAT-04  
> **Category:** Typography & Captions Suite  
> **Target Module:** Toolkit Dialog / Shell (`index.html`, `js/toolkit/toolkit.js`, `jsx/text.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Finds and replaces text strings across all text layers in the active composition or across the entire project. Ideal for changing client names, typos, subtitles, and template placeholders in 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Clean modal dialog with: "Find" input, "Replace With" input, Scope selection ("Active Comp" vs "Whole Project"), and Case-sensitive checkbox.
- Scans all text layers recursively through nested compositions.
- Preserves character styling (font, weight, color, tracking) while updating the text string.
- Returns a clear toast report: "Replaced 14 instances across 6 layers".

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitFindAndReplaceText(findStrHex, replaceStrHex, scopeHex, matchCase) {
    var comp = getSafeActiveComp();
    var findStr = decodeBridge(findStrHex);
    var replaceStr = decodeBridge(replaceStrHex);
    var scope = decodeBridge(scopeHex) || "comp";
    
    app.beginUndoGroup("Find and Replace Text");
    var count = 0;
    function processComp(c) {
        for (var i = 1; i <= c.numLayers; i++) {
            var lyr = c.layer(i);
            if (lyr instanceof TextLayer) {
                var textProp = lyr.property("ADBE Text Properties").property("ADBE Text Document");
                var doc = textProp.value;
                var original = doc.text;
                var updated = matchCase ? original.split(findStr).join(replaceStr) : original.replace(new RegExp(findStr, "gi"), replaceStr);
                if (original !== updated) {
                    doc.text = updated;
                    textProp.setValue(doc);
                    count++;
                }
            }
        }
    }
    if (scope === "comp" && comp) processComp(comp);
    else if (scope === "project") {
        for (var j = 1; j <= app.project.numItems; j++) {
            if (app.project.item(j) instanceof CompItem) processComp(app.project.item(j));
        }
    }
    app.endUndoGroup();
    return encodeBridge("Replaced " + count + " instances.");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Enter "SALE 20%" and replace with "SALE 50%" across comp.
- [ ] Updates all matching text layers instantly without modifying fonts or positions.
- [ ] Undo group rolls back all changes with one Ctrl+Z.
