# Feature 28: Built-in SFX Sound Effects Library

> **Feature ID:** FEAT-28  
> **Category:** Audio & Music Beats Workflow  
> **Target Module:** SFX Tab (`index.html`, `js/toolkit/sfx.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Provides a built-in Sound Effects library of 50+ essential royalty-free sounds (Whoosh, Pop, Click, Impact, Paper Tear, Bell, Camera Shutter) with inline audio player and 1-click timeline drop.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Bundled audio assets in `CompSaver/assets/sfx/` (~5-10MB total CC0 48kHz WAV/MP3 files).
- Panel UI: Waveform preview, play/pause button, search bar, categories (Whooshes, Hits, UI, Transitions).
- Clicking "Add" imports the audio file into the project and drops it onto the active comp at current playhead.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitImportSFX(sfxRelativePathHex) {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    var relPath = decodeBridge(sfxRelativePathHex);
    var audioFile = new File(getPluginFolder() + "/assets/sfx/" + relPath);
    if (!audioFile.exists) return encodeBridge("Sound file not found.");
    
    app.beginUndoGroup("Add SFX to Timeline");
    var item = app.project.importFile(new ImportOptions(audioFile));
    var layer = comp.layers.add(item);
    layer.startTime = comp.time;
    layer.moveToBeginning();
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Browse Whoosh sound in CompSaver UI, listen to preview, click Add.
- [ ] Sound instantly lands on timeline at current playhead.
