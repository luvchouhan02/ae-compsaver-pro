# Feature 29: Aspect Ratio Preset Switcher

> **Feature ID:** FEAT-29  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
1-click converts any active composition to 9:16 (Reels/Shorts/TikTok - 1080x1920), 16:9 (YouTube - 1920x1080), 1:1 (Square - 1080x1080), or 4:5 (Feed - 1080x1350) with smart reframing.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Buttons or dropdown: 9:16, 16:9, 1:1, 4:5.
- Adjusts `comp.width` and `comp.height` instantly in 1 click.
- Optional checkbox: Auto-scale layers to fit new aspect ratio.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitSetAspectRatio(ratioHex) {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    var r = decodeBridge(ratioHex);
    app.beginUndoGroup("Switch Aspect Ratio");
    if (r === "9:16") { comp.width = 1080; comp.height = 1920; }
    else if (r === "16:9") { comp.width = 1920; comp.height = 1080; }
    else if (r === "1:1") { comp.width = 1080; comp.height = 1080; }
    else if (r === "4:5") { comp.width = 1080; comp.height = 1350; }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click "9:16 Reel" -> active comp instantly resizes to 1080x1920 in < 10ms.
