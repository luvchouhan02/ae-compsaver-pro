# Feature 01: Instagram Reel Real UI Safe Zone Overlay (1-Click Instant Guide)

> **Feature ID:** FEAT-01  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** Ready for Implementation  
> **Category:** Workflow / Safe Zone Guides  
> **Asset Dependency:** `assets/guides/ig_reel_guide_1080x1920.png` (~40KB-50KB PNG)

---

## 1. Problem Statement
When editing 9:16 vertical short-form videos (Reels, TikTok, Shorts), editors frequently place essential graphics, text overlays, captions, or talent faces inside Instagram's native UI "Dead Zones". In the real Instagram app, this results in:
- Text blocked by the right-hand interaction buttons (Like, Comment, Share).
- Talent faces obscured by top header margins or bottom metadata.
- Captions clashing with the bottom username and audio ticker.

---

## 2. Solution Overview
CompSaver will provide a **1-click lightweight Instagram Reel UI Guide Overlay** inside After Effects:
- **Instant Toggle:** Adds or toggles visibility in `< 50ms`.
- **Zero Lag Guarantee:** Uses an ultra-lightweight, high-resolution transparent PNG (~50KB). No heavy expression rigs, no runtime shape generation lag, 100% full 60 FPS RAM preview even on entry-level laptops.
- **Render-Safe (`guideLayer = true`):** Visible in After Effects viewer, but automatically excluded during Render Queue / Adobe Media Encoder exports.
- **Auto-Locked (`locked = true`):** Locked at layer Index 1 so editors do not accidentally select or move it.

---

## 3. Pixel-Perfect Mockup Details

### Right Action Column:
- ❤️ **Like (Heart) Icon** + real counter (e.g. `128K`)
- 💬 **Comment Bubble Icon** + real counter (e.g. `1,420`)
- ✈️ **Share (Paper Airplane) Icon** + real counter (e.g. `32.5K`)
- ⋯ **Three Dots (...)** more options
- 🎵 **Rotating Audio Disc / Album Art** at bottom-right

### Bottom Metadata Area (Dead Zone):
- 👤 **Circular Profile Avatar placeholder**
- **Username (`@username`)** + **"Follow"** pill button
- **Multi-line realistic caption preview** (indicates where Instagram collapses/expands captions)
- **Audio Track title ticker** with musical note icon
- **Video bottom progress / scrubber bar**
- **Subtle bottom-up dark gradient vignette** (matches Instagram's native overlay for text readability)

### Top Header & Phone Margins:
- "Reels" title + Camera icon
- Upper status bar & notch/Dynamic Island boundary margin

---

## 4. Technical Architecture

### 1. File Structure
```text
CompSaver/
├── assets/
│   └── guides/
│       └── ig_reel_guide_1080x1920.png   <-- 1080x1920 crisp transparent UI mockup
├── js/
│   ├── core/
│   │   └── bridgeRegistry.js             <-- Register action "toggle-ig-guide"
│   └── toolkit/
│       └── toolkit.js                    <-- Map toolkit button click to action
├── jsx/
│   └── workflow.jsx                      <-- ExtendScript implementation
└── index.html                            <-- Toolkit toolbar button with Instagram SVG icon
```

### 2. Frontend UI Button (`index.html`)
Placed inside the Toolkit toolbar alongside existing guide buttons:
```html
<button class="tk-icon-btn tk-icon-btn--muted" data-toolkit-action="toggle-ig-guide" title="Instagram Reel Safe Zone (Guide)">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
        <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
    </svg>
</button>
```

### 3. ExtendScript Backend (`jsx/workflow.jsx`)
```javascript
function toolkitToggleIGReelGuide() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    
    var layerName = "[GUIDE] Instagram Reel Safezone";
    
    // 1. Smart Toggle: If layer already exists, toggle eye visibility
    for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === layerName) {
            app.beginUndoGroup("Toggle Instagram Guide");
            comp.layer(i).enabled = !comp.layer(i).enabled;
            app.endUndoGroup();
            return encodeBridge("ok");
        }
    }
    
    // 2. First-time insert: Import asset and configure
    app.beginUndoGroup("Add Instagram Guide");
    var assetFile = new File(getPluginFolder() + "/assets/guides/ig_reel_guide_1080x1920.png");
    if (!assetFile.exists) return encodeBridge("Guide asset not found: " + assetFile.fsName);
    
    var importedItem = app.project.importFile(new ImportOptions(assetFile));
    var guideLayer = comp.layers.add(importedItem);
    guideLayer.name = layerName;
    guideLayer.guideLayer = true;
    guideLayer.moveToBeginning();
    
    // Auto-fit to composition dimensions (1080x1920, 4K, etc.)
    var scaleX = (comp.width / guideLayer.width) * 100;
    var scaleY = (comp.height / guideLayer.height) * 100;
    guideLayer.property("ADBE Transform Group").property("ADBE Scale").setValue([scaleX, scaleY]);
    
    guideLayer.locked = true;
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 5. Acceptance Checklist
- [ ] 1-Click adds the guide layer at top (index 1) of the active comp.
- [ ] Set as `guideLayer = true` (never renders during export).
- [ ] Set as `locked = true` (cannot be accidentally moved by user).
- [ ] Subsequent clicks toggle eye visibility (Show/Hide) in < 10ms.
- [ ] No multiple duplicate layers created.
- [ ] Zero timeline scrubbing lag or RAM preview slowdown on low-end systems.
