# AI Feature AI-01: Local GPU Offline AI Engine & Bridge Architecture

> **Feature ID:** AI-01  
> **Category:** 🧠 Local GPU Offline AI Suite (Zero Cloud)  
> **Target Subsystem:** CompSaver Local AI Engine & CEP UI  
> **Status:** ⏳ Ready for Architecture & Implementation  

---

## 1. Problem & Purpose (Yeh AI feature kya kaam karta hai?)
The foundational offline AI server and background worker for CompSaver. Runs locally on the user machine (via Vulkan / DirectML / ncnn portable binaries) with ZERO cloud dependency, allowing AE to run heavy neural network models locally without freezing the UI.

---

## 2. Exact Requirements (Kya-kya chahiye?)
- Zero Cloud / 100% Offline: Videos, frames, and audio NEVER leave the user computer.
- No heavy 5GB Python/PyTorch requirement: Uses standalone lightweight C++/Vulkan executables (~50MB to 100MB each).
- Local HTTP/WebSocket Daemon running on localhost (e.g. `http://127.0.0.1:28854`).
- Asynchronous task queue: AE does not hang while AI is processing; progress bar (0-100%, ETA, frames processed) displays in CompSaver panel.
- Auto-start / Auto-stop with Adobe After Effects lifecycle.

---

## 3. How It Works Under The Hood (Technical Pipeline & ExtendScript Bridge)
```javascript
// Workflow in CompSaver CEP:
// 1. User triggers AI tool in CEP panel
// 2. ExtendScript renders active layer frames to %TEMP%/compsaver_ai_input/
// 3. CEP panel sends POST request to local server:
async function dispatchAITask(taskType, inputPath, options) {
    const res = await fetch("http://127.0.0.1:28854/api/v1/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: taskType, input: inputPath, options: options })
    });
    const { taskId } = await res.json();
    return monitorAITask(taskId);
}

// 4. Poll / WebSocket event for progress (10% ... 50% ... 100%)
// 5. On completion, ExtendScript imports output file back into AE composition:
function toolkitImportAIResult(outputPathHex) {
    var comp = getSafeActiveComp();
    var f = new File(decodeBridge(outputPathHex));
    if (!f.exists) return encodeBridge("Output file missing.");
    app.beginUndoGroup("Import AI Result");
    var item = app.project.importFile(new ImportOptions(f));
    var layer = comp.layers.add(item);
    layer.moveToBeginning();
    app.endUndoGroup();
    return encodeBridge("ok");
}
```

---

## 4. Definition of Done & Acceptance Checklist
- [ ] Local daemon starts quietly in background without annoying command prompt windows.
- [ ] Correctly detects user GPU (NVIDIA, AMD, or Intel).
- [ ] Smooth communication between CEP Panel, Local Worker, and After Effects ExtendScript.
