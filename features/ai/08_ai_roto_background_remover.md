# AI Feature AI-08: AI Subject Rotoscoping & Background Removal

> **Feature ID:** AI-08  
> **Category:** 🧠 Local GPU Offline AI Suite (Zero Cloud)  
> **Target Subsystem:** CompSaver Local AI Engine & CEP UI  
> **Status:** ⏳ Ready for Architecture & Implementation  

---

## 1. Problem & Purpose (Yeh AI feature kya kaam karta hai?)
Automatically isolates humans, characters, or subjects from video backgrounds without green screen, outputting a transparent RGBA video or black-and-white alpha matte.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Robust Video Matting model (RobustVideoMatting / Bria AI).
- Outputs ProRes 4444 with transparent alpha channel or standalone matte video.
- Hair and edge preservation with clean boundaries.

---

## 3. How It Works Under The Hood (Technical Pipeline & ExtendScript Bridge)
```javascript
// Worker runs video matting neural net -> extracts foreground subject + alpha channel.
// Imports directly as transparent video layer above background.
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select video with person walking -> outputs clean cutout with transparent background.
- [ ] Allows placing text or graphics BEHIND the person instantly.
