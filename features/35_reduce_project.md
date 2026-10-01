# Feature 35: Reduce Project (Keep Selected Comps Only)

> **Feature ID:** FEAT-35  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Cleans up the active project by deleting all unused footage, assets, and comps, keeping ONLY the active composition and its direct dependencies.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Executes native After Effects "Reduce Project" safely.
- Prompts user confirmation before executing.
- Dramatically reduces `.aep` file size for client handoff.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitReduceProject() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("Select a composition.");
    app.beginUndoGroup("Reduce Project");
    app.project.reduceProject([comp]);
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Reduce Project -> cleans all unreferenced items from project panel.
