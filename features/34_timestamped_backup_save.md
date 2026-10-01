# Feature 34: Timestamped Backup & Incremental Save

> **Feature ID:** FEAT-34  
> **Category:** Composition & Project Intelligence  
> **Target Module:** Toolkit Toolbar (`index.html`, `js/toolkit/toolkit.js`, `jsx/workflow.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Creates an instant timestamped backup copy (`ProjectName_2026-09-20_0215.aep`) or an incremental versioned copy (`ProjectName_v002.aep`) in 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Works without interrupting user flow.
- Copies `.aep` file with timestamped or incremented suffix.
- Never overwrites original file.

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitTimestampedBackup() {
    if (!app.project.file) return encodeBridge("Save project first.");
    var curFile = app.project.file;
    var d = new Date();
    var stamp = d.getFullYear() + "-" + (d.getMonth()+1) + "-" + d.getDate() + "_" + d.getHours() + d.getMinutes();
    var backupFile = new File(curFile.parent.fsName + "/" + curFile.name.replace(".aep", "") + "_backup_" + stamp + ".aep");
    curFile.copy(backupFile.fsName);
    return encodeBridge("Backup created: " + backupFile.name);
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Click Backup -> backup `.aep` created instantly in project folder.
