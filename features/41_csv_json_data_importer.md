# Feature 41: CSV & JSON Data to Text Importer

> **Feature ID:** FEAT-41  
> **Category:** Productivity & Workspaces  
> **Target Module:** Toolkit Dialog (`data.html`, `jsx/text.jsx`)  
> **Status:** ⏳ Ready for Implementation  

---

## 1. Problem & Purpose (Yeh feature kya kaam karta hai?)
Imports CSV spreadsheets or JSON data files to automatically generate and populate text layers or infographic charts in After Effects with 1 click.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- File picker for `.csv` and `.json`.
- Parses rows and columns; lets user map column names to specific text layers.
- Option to generate a new duplicated composition for each row in the spreadsheet (Bulk video generation).

---

## 3. How It Works Under The Hood (ExtendScript / JSX Logic)
```javascript
function toolkitImportCSVData(csvStringHex, compId) {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active composition.");
    var csvText = decodeBridge(csvStringHex);
    var lines = csvText.split(/\r\n|\r|\n/);
    if (lines.length < 2) return encodeBridge("Invalid CSV.");
    var headers = lines[0].split(",");
    
    app.beginUndoGroup("Import CSV Data");
    for (var r = 1; r < lines.length; r++) {
        if (!lines[r]) continue;
        var row = lines[r].split(",");
        for (var c = 0; c < row.length; c++) {
            var lyr = comp.layers.addText(row[c]);
            lyr.name = headers[c] + "_Row" + r;
            lyr.startTime = (r - 1) * 2; // Staggered by row
        }
    }
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Upload CSV with 10 client names -> generates 10 cleanly titled text layers automatically.
