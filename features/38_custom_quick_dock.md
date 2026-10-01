# Feature 38: Custom Floating Quick-Access Dock (CompSaver Dock)

> **Feature ID:** FEAT-38  
> **Category:** Productivity & Workspaces  
> **Target Module:** Dock Module (`dock.html`, `js/toolkit/dock.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
A compact, customizable floating toolbar where editors can pin their most frequently used tools, One-Framer presets, and custom external .jsx scripts with custom colors, icon sizes, and column layouts.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Configurable column count: 1 column (vertical strip for narrow docks) up to 6 columns.
- Drag-and-drop reordering of pinned buttons.
- Allows adding custom user .jsx scripts from a designated folder with custom SVG icons and colors.
- Persistent storage in localStorage / Settings so user layout is always preserved.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
// Dock button execution routing in dock.js:
function executeDockItem(item) {
    if (item.type === "toolkit") runToolkitAction(item.actionId);
    else if (item.type === "preset") applyOneFramerPreset(item.recipe);
    else if (item.type === "script") {
        var scriptFile = new File(item.filePath);
        if (scriptFile.exists) $.evalFile(scriptFile);
    }
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Open Dock panel, pin 5 favorite tools.
- [ ] Clicking pinned button executes action identically to main panel.
- [ ] Rearranging buttons saves order automatically.
