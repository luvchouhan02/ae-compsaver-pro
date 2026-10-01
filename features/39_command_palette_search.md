# Feature 39: Universal Command Palette (Ctrl + K Spotlight Search)

> **Feature ID:** FEAT-39  
> **Category:** Productivity & Workspaces  
> **Target Module:** Command Palette Overlay (`ui/command-palette.js`, `index.html`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
A spotlight-style search overlay triggered via keyboard shortcut (Ctrl+K or Cmd+K) that searches across all tools, presets, One-Framers, templates, and settings instantly, allowing power users to work without touching the mouse.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Keyboard shortcut listener: Ctrl+K / Cmd+K opens modal instantly.
- Fuzzy search matching across tool names, categories, and keywords.
- Arrow Up/Down navigation and Enter to execute.
- Esc closes the palette cleanly.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
// Global keydown handler in app shell:
document.addEventListener("keydown", function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        CommandPalette.toggle();
    }
});
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Press Ctrl+K -> spotlight search opens.
- [ ] Type "Reel" -> highlights "Instagram Reel Safe Zone Overlay", hit Enter -> executes.
