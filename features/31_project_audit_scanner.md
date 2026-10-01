# Feature 31: Project Audit & Health Scanner

> **Feature ID:** FEAT-31  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Dialog (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Scans the entire After Effects project for issues: broken/missing footage files, expression syntax errors, heavy 4K compositions, and unused assets, providing 1-click select and cleanup.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Generates a clean health report:
- - Missing footage count (with button to select them in Project panel).
- - Expression error count.
- - Unused comps count.
- Zero crashes or project lockups during scan.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitProjectAudit() {
    var missing = 0;
    var unused = 0;
    var comps = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof FootageItem && it.footageMissing) missing++;
        if (it instanceof CompItem) {
            comps++;
            if (it.usedIn.length === 0) unused++;
        }
    }
    return encodeBridge(JSON.stringify({ missing: missing, unusedComps: unused, totalComps: comps }));
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Project Audit -> pops up summary of missing footage and unused comps.
