# Feature 33: Quick Export Current Frame to PNG

> **Feature ID:** FEAT-33  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Saves the current frame of the active composition as a full-resolution PNG image directly to disk in 1 click without opening the Render Queue or Media Encoder.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Uses `comp.saveFrameToPng(comp.time, file)` or AE render frame method.
- Saves to project directory or Desktop with timestamped name (`CompName_00-05-12.png`).
- Displays a toast notification with a button to open the file location.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitQuickExportFrame() {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    var projFolder = app.project.file ? app.project.file.parent.fsName : Folder.desktop.fsName;
    var safeName = comp.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    var outputFile = new File(projFolder + "/" + safeName + "_frame_" + Math.round(comp.time * comp.frameRate) + ".png");
    
    comp.saveFrameToPng(comp.time, outputFile);
    return encodeBridge("Saved to: " + outputFile.fsName);
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Export Frame -> PNG image saved instantly on disk in < 100ms.
