# AI Feature AI-07: AI 2D to 3D Depth Map Extractor

> **Feature ID:** AI-07  
> **Category:** 🧠 Local GPU Offline AI Suite (Zero Cloud)  
> **Target Subsystem:** CompSaver Local AI Engine & CEP UI  
> **Status:** ⏳ Ready for Architecture & Implementation  

---

## 1. Problem & Purpose (Yeh AI feature kya kaam karta hai?)
Generates a grayscale 3D Depth Pass (Z-depth) from regular 2D video footage. Enables 3D displacement, camera parallax, depth of field (lens blur), and fog effects directly inside After Effects.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Uses Depth Anything / MiDaS lightweight ONNX model.
- Generates 16-bit / 8-bit grayscale depth pass (White = Near, Black = Far).
- Integrates with FEAT-20 (Parallax Rig) to immediately rig a 3D camera move.

---

## 3. How It Works Under The Hood (Technical Pipeline & ExtendScript Bridge)
```javascript
// Worker executes Depth Anything model on video frames -> exports grayscale video.
// ExtendScript sets imported depth map as Displacement Map or Camera Lens Blur source.
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Select 2D landscape or portrait video -> outputs accurate depth map.
- [ ] Allows realistic 3D camera pushes inside After Effects.
