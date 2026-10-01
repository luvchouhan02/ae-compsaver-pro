# AI Feature AI-02: AI Whisper Auto-Subtitles & Kinetic Captions

> **Feature ID:** AI-02  
> **Category:** 🧠 Local GPU Offline AI Suite (Zero Cloud)  
> **Target Subsystem:** CompSaver Local AI Engine & CEP UI  
> **Status:** ⏳ Ready for Architecture & Implementation  

---

## 1. Problem & Purpose (Yeh AI feature kya kaam karta hai?)
Extracts audio from composition, transcribes speech using Whisper AI locally with exact word-by-word timestamps, and generates stylized, animated caption layers (Hormozi / MrBeast viral style) directly on After Effects text layers.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- High accuracy multilingual speech recognition powered by whisper.cpp / faster-whisper.
- Generates word-level timestamps (`[ { word: "HELLO", start: 0.12, end: 0.35 }, ... ]`).
- CompSaver Caption Styler UI: Font picker, text case (UPPERCASE/lowercase), highlight active word with accent color, auto-box background toggle.
- Supports importing & exporting `.srt` and `.vtt` files.
- Zero cloud upload — 1-minute clip transcribes in 2-3 seconds on modern GPUs.

---

## 3. How It Works Under The Hood (Technical Pipeline & ExtendScript Bridge)
```javascript
function toolkitBuildSubtitlesFromJSON(subtitlesJsonHex, styleConfigHex) {
    var comp = getSafeActiveComp();
    if (!comp) return encodeBridge("No active comp.");
    var words = JSON.parse(decodeBridge(subtitlesJsonHex));
    var style = JSON.parse(decodeBridge(styleConfigHex));
    
    app.beginUndoGroup("Generate AI Subtitles");
    var groupComp = comp.layers.addNull();
    groupComp.name = "[CAPTIONS MASTER]";
    
    for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var textLayer = comp.layers.addText(w.word);
        textLayer.inPoint = w.start;
        textLayer.outPoint = w.end;
        textLayer.parent = groupComp;
        
        var textProp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = textProp.value;
        doc.fontSize = style.fontSize || 75;
        doc.font = style.fontFamily || "Arial-BoldMT";
        doc.fillColor = (style.highlightCurrent && w.isHighlight) ? style.highlightColor : [1, 1, 1];
        doc.applyFill = true;
        textProp.setValue(doc);
    }
    app.endUndoGroup();
    return encodeBridge("Subtitles created: " + words.length + " words.");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Extract audio from layer -> Whisper generates accurate words & timestamps.
- [ ] Text layers are accurately timed with spoken audio.
- [ ] Supports Hormozi-style one-word-at-a-time or 3-words-per-chunk animations.
