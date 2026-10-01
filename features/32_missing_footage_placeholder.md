# Feature 32: Missing Footage Placeholder Solid

> **Feature ID:** FEAT-32  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Replaces all missing/offline footage items with a colored placeholder solid so render queue exports do not fail with error alerts.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Identifies `item.footageMissing == true`.
- Replaces missing footage with a generated 1920x1080 Solid ("MISSING_FOOTAGE_PLACEHOLDER").
- Allows smooth background rendering without crashes.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitReplaceMissingWithPlaceholder() {
    app.beginUndoGroup("Replace Missing with Placeholder");
    var count = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof FootageItem && it.footageMissing) {
            it.replaceWithSolid([0.8, 0.2, 0.2], it.name + " [Offline]", it.width || 1920, it.height || 1080, 1.0);
            count++;
        }
    }
    app.endUndoGroup();
    return encodeBridge("Replaced " + count + " missing items.");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Replace Missing -> turns all red missing boxes into placeholder solids.
