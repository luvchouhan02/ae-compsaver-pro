# AI Feature AI-05: AI Object & Watermark Remover (LaMa Inpainting)

> **Feature ID:** AI-05  
> **Category:** 🧠 Local GPU Offline AI Suite (Zero Cloud)  
> **Target Subsystem:** CompSaver Local AI Engine & CEP UI  
> **Status:** ⏳ Ready for Architecture & Implementation  

---

## 1. Problem & Purpose (Yeh AI feature kya kaam karta hai?)
Erases logos, watermarks, wires, microphones, or unwanted people from video footage. The editor simply draws a quick mask over the object in After Effects, and the AI inpainting model fills the area with realistic matching background textures.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Powered by LaMa (Large Mask Inpainting) model.
- Editor workflow: Add mask to AE layer -> Select mask name in CompSaver panel -> Click "Remove Object".
- Processes masked frames and outputs clean seamless background footage.

---

## 3. How It Works Under The Hood (Technical Pipeline & ExtendScript Bridge)
```javascript
// Workflow:
// 1. ExtendScript exports RGB footage + Mask Alpha Channel
// 2. LaMa inpainting model takes (image, mask) and synthesizes the background
// 3. Cleaned footage imported back to AE right under the mask.
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Draw mask around watermark -> click Erase -> watermark vanishes cleanly.
- [ ] Background texture and lighting match surrounding environment.
