# CompSaver — 100% Deep Architectural Analysis, Full-Stack Bug Eradication & 100× Smart Performance Master Prompt

> **Purpose**: Conduct a **100% DEEP BEHAVIORAL & CODE-LEVEL ANALYSIS** across every single tool, every feature, every UI section, and the entire backend engine in CompSaver.  
> **Core Directives**:  
> 1. **DO NOT DO A SUPERFICIAL SCAN** — Deeply trace and test every tool's end-to-end execution.  
> 2. **Audit Real Working State** — Verify if each tool actually works properly, handles Undo cleanly, executes Delete/Bulk Delete without leaks, and applies changes safely.  
> 3. **Eliminate All Bugs at the Root** — Fix crashes, freezes, race conditions, memory leaks, and ExtendScript errors.  
> 4. **Replace Naive Legacy Code with 100× Smart Modern Versions** — Modernize outdated, clumsy workflows into instant, automated, state-of-the-art smart implementations.  
> 5. **Achieve 100× Performance & Snappy 60 FPS Feel** — Match and exceed gold-standard studio tools like MNTools v1.0.7 with zero project corruption.

---

## 🧠 Master Prompt Directive for Frontier AI

You are the Principal Systems Architect, Quality Engineer, and Adobe CEP / ExtendScript Performance Specialist for **CompSaver** — a high-performance Adobe After Effects CEP extension combining Vanilla JavaScript (ES6+ in Chromium CEP runtime), Node.js integration, and an Adobe ExtendScript host backend (strict ECMAScript 3 engine).

Your mandate is comprehensive, autonomous, and uncompromising:

1. **Autonomous Deep Analysis (Zero Assumptions & Zero Preconceptions)**:  
   You have complete, unrestricted access to the entire codebase. **Do NOT perform a shallow or superficial scan.** Do not rely on outside guesses or human assumptions — human intuition can be mistaken, whereas code execution never lies. Independently trace, profile, and deeply audit every single tool, every UI section, and every backend host script based on concrete code evidence and execution flow.

2. **Diagnose & Rank the Worst Choke Points**:  
   Identify and rank the **Top Architectural Bottlenecks** dragging down CompSaver's responsiveness, speed, and stability (the 20% of code causing 80% of all UI lag, memory bloat, and AE freezes).

3. **Verify Every Single Tool's Real-World Behavior**:  
   Trace the full lifecycle of every tool: `User Click ➔ DOM Event ➔ JS Controller ➔ Hex/Bridge IPC ➔ ExtendScript ES3 Execution ➔ AE Project/Layer Mutation ➔ Undo Group Creation ➔ AE Timeline/Viewer Redraw ➔ IPC Return Callback ➔ Toast / UI Feedback`. Check whether each tool works correctly or silently fails, whether `Undo (Ctrl+Z)` restores the exact previous state cleanly, and whether `Delete` and `Bulk Delete` operate without leaving orphaned files or ghost references.

4. **Replace Legacy Clumsy Implementations with 100× Smart Modern Versions**:  
   Wherever existing code relies on naive, clumsy, or obsolete legacy patterns (e.g., brute-force disk directory loops, synchronous `writeFileSync`, quadratic array lookups, giant unwindowed `innerHTML` DOM injections, unbatched AE roundtrips, un-throttled event listeners, re-importing `.aep` files into live projects for thumbnails), **completely replace them with modern, smart, state-of-the-art engineering patterns** (e.g., streaming I/O, O(1) hash maps, virtualized windowed rendering, atomic batched IPC, hardware-accelerated GPU transforms, background worker queues, smart preflight auto-detection).

5. **100× Performance Acceleration & Fluid 60 FPS UX**:  
   Re-engineer hot paths, disk I/O, bridge calls, and render pipelines to make CompSaver blazingly fast, snappy, and smooth at 60 FPS — matching and exceeding gold-standard studio tools like MNTools v1.0.7 (sub-100ms interaction feedback, bounded queues, DOM virtualization for 5,000+ items, instant snapshot hydration, zero-lag clicks).

6. **Ironclad Safety & Project Preservation**:  
   Never corrupt user templates, project files (`.aep`), or active After Effects comp states. Preserve existing capabilities, user settings, visual theme aesthetics, and backward compatibility. Every claim of speedup must be verifiable and measured.

---

## 🔬 1. Deep Behavioral & Architectural Audit Scope (Every Tool & Section)

You must systematically trace, analyze, and test 100% of the codebase across these 7 primary subsystems:

---

### Section A: Toolkit Suite & Layer Operations (Every Single Tool)
- **Target Files**: `js/toolkit/toolkit.js`, `js/toolkit/flow.js`, `js/toolkit/colorflow.js`, `js/toolkit/effects.js`, `jsx/toolkit.jsx`, `jsx/workflow.jsx`.
- **Deeply Analyze & Test Every Individual Tool**:
  1. **Anchor 9-Point Grid**: Does clicking each of the 9 anchor points instantly reposition the layer's anchor point without shifting its visual position in the comp? Is the active button state updated immediately (<16ms)?
  2. **Align & Distribute Suite**: Do all 6 alignment buttons (Left, Center H, Right, Top, Center V, Bottom) calculate bounds accurately? Does switching between `[ Comp ]` and `[ Selection ]` scope work flawlessly across multiple selected layers?
  3. **Precompose Suite**:
     - **Smart Precompose**: Does it package selected layers into a new comp with correct duration and bounds?
     - **Un-precompose**: Does it extract internal layers into the parent timeline with accurate transforms, keyframes, blend modes, and expressions preserved?
     - **Multi-Precomp**: Does it batch-precompose each selected layer into its own separate comp individually?
     - **True Comp Duplicator**: Does it duplicate the comp AND recursively clone all nested child precomps so changes in the duplicate NEVER affect the original comp?
     - **Decompose**: Does it flatten/unwrap comp hierarchies cleanly?
     - **Crop Precomp**: Does it trim comp dimensions to the exact bounding box of its contents without shifting child layers?
  4. **Layer Creation & Management Helpers**:
     - **1-Click Parent Null**: Normal click = creates 1 parent null for all selected layers and parents them; Shift+click = creates individual parent nulls per layer. Does parenting calculation maintain world transforms?
     - **Solid, Adjustment Layer, Shape Layer**: Are they created at comp dimensions, centered at playhead time, with standard naming?
     - **1-Click Mirror / Flip (H & V)**: Does it flip scale (`[-scale[0], scale[1]]`) around the anchor point cleanly?
     - **Batch Blend Modes**: Does it apply Screen, Multiply, Add, Overlay, Normal across 50+ selected layers in a single instantaneous call?
  5. **Sequence & Stagger Layers**:
     - Does the frame stepper (`[ - ] [ N frames ] [ + ]`) calculate offsets accurately?
     - Do Ascending, Descending, and Random ordering modes sort layers cleanly on the timeline?
  6. **Flow Graph System (Easing & Velocity Curve Studio)**:
     - Does the interactive Bezier graph update smoothly on drag?
     - Are ease-in and ease-out velocity values calculated and applied to selected keyframes accurately?
     - Do preset curve cards apply instantly with zero timeline stall?
  7. **ColorFlow (Palette Workshop)**:
     - Does color extraction from selected layers or images work accurately?
     - Does clicking a swatch apply fill/stroke colors immediately to selected shape/text layers?
  8. **Undo Integrity (Non-Negotiable)**:
     - Does **EVERY SINGLE TOOL** enclose its entire operation in `app.beginUndoGroup("CompSaver: <Tool>")` and `app.endUndoGroup()` in a strict `try...catch...finally` block?
     - Can the user press `Ctrl+Z` (Undo) **exactly ONCE** to completely revert any tool action with zero leftover artifacts?
  9. **Delete & Bulk Delete Behavior**:
     - Are selected layers/items cleanly deleted without leaving detached listeners, broken references, or memory leaks?
- **Smart Upgrade Target**:
  - Replace individual button listeners with unified **Event Delegation**.
  - Replace repeated AE property reads with single-pass cached reads.
  - Implement optimistic UI updates (<16ms feedback) so the UI never waits for ExtendScript to finish before updating button states.

---

### Section B: Template Library, Grid Engine & Scale (5,000+ Items)
- **Target Files**: `js/templates/templates.js`, `js/templates/virtualGrid.js`, `js/templates/templateCatalog.js`, `js/ui/collection-controller.js`, `js/templates/templateCardView.js`.
- **Deeply Analyze & Test**:
  1. **Hover Preview Pipeline**:
     - Does hovering over a template card play video/animation preview smoothly without dropped frames?
     - When the mouse leaves the card, is the video element/canvas **properly paused, detached, and garbage collected**? Or does it leak memory and GPU video decoders?
     - Does rapid hovering over 20 cards in 5 seconds create memory spikes or audio glitching?
  2. **Thumbnail Generation & Rendering Pipeline**:
     - Are thumbnails generated reliably for Comps, Images, Footage, Overlays, Transitions, and Text?
     - Are any cards stuck indefinitely in a loading shimmer or broken image icon?
     - Are full-resolution multi-megabyte images being loaded directly into DOM cards, choking Chromium memory?
     - Are thumbnails strictly bounded to ≤ 320×180 web-optimized formats?
  3. **Virtual Grid & 5,000+ Items Scalability**:
     - Does scrolling through 1,000 to 5,000 templates maintain a rock-solid 60 FPS?
     - Does `renderCards()` use giant `innerHTML` injections that destroy and recreate the entire DOM on every search/filter keystroke?
     - Is there a true virtualized windowed grid that mounts **only the 8–15 cards visible in the viewport** and recycles DOM nodes on scroll?
  4. **Category Switching & Search Filtering**:
     - Does category switching take < 100ms at 5,000 items?
     - Is search debounced, using an in-memory normalized index (O(1) lookups) rather than an O(N × C) brute-force scan?
  5. **Apply & Import Execution**:
     - Does double-clicking or clicking Apply insert the template into the active comp at the playhead position accurately?
     - Does it prevent duplicate import spam if clicked rapidly multiple times?
- **Smart Upgrade Target**:
  - Implement a CEP-safe Virtual Windowed Grid with fixed DOM footprint.
  - Implement an Inverted Search Index for instant, zero-lag character-by-character search.
  - Implement a Single Shared Hover Preview Controller (only 1 active media element in memory at any time).

---

### Section C: Save Engine, Render Pipeline & Aerender Architecture
- **Target Files**: `js/core/saveController.js`, `js/core/saveOrchestrator.js`, `js/core/aerenderRunner.js`, `jsx/templates_save.jsx`.
- **Deeply Analyze & Test**:
  1. **Save Engine Stability & Memory Footprint**:
     - Does saving a selected comp into a template cause After Effects to freeze or crash?
     - Does the save process perform destructive project reductions that risk corrupting the user's active `.aep` project file?
     - Are temporary files and project snapshots properly cleaned up from disk, even if the save fails or is cancelled?
  2. **The Thumbnail Render Pipeline (The #1 Crash Culprit)**:
     - **Examine the biggest historical flaw**: Does CompSaver re-import saved `.aep` files back into the user's active project just to render a thumbnail frame?
     - Why is this dangerous? Re-importing bloats the active project, triggers timeline redraws, and causes out-of-memory crashes on complex projects!
     - **The Smart Move**: Isolate thumbnail rendering completely from the active AE session! Use headless background rendering, `aerender`, or capture the thumbnail frame **directly from the active comp buffer BEFORE saving**, eliminating the need to re-open or re-import the `.aep`!
  3. **Background Render Queue & Circuit Breakers**:
     - If a background render hangs or exceeds a timeout (e.g., 15 seconds), does the system have a circuit breaker that aborts cleanly without freezing the panel?
     - Are render tasks strictly serialized to prevent concurrent render collisions?
- **Smart Upgrade Target**:
  - Complete decoupling of Template Save (instant, <500ms) from Thumbnail Render (background, asynchronous).
  - Direct frame-grab thumbnail capture from active comp preview (zero project re-import).
  - Non-blocking, fault-tolerant background render queue with automatic circuit breaker.

---

### Section D: Media Engine & Footage Section
- **Target Files**: `js/core/fastMediaEngine.js`, `js/core/importEngine.js`, `js/core/keyedMediaCardHelper.js`, `bin/` FFmpeg/FFprobe binaries.
- **Deeply Analyze & Test**:
  1. **FastMediaEngine Throughput**:
     - When importing a batch of 20 media files (PNG, MP4, MOV, Audio), does the UI freeze?
     - Does it rebuild categories and re-render the entire grid for every single imported file?
     - Does it spawn unbounded FFmpeg/FFprobe child processes that saturate 100% CPU and choke the operating system?
  2. **Footage Card Management & Playback**:
     - Do footage cards render proper metadata (dimensions, duration, fps, codec)?
     - Does drag-and-drop into AE comp work smoothly?
     - Are special characters, unicode names, and spaces in filenames handled without path resolution failures?
- **Smart Upgrade Target**:
  - Bounded concurrency queue (maximum 2 parallel FFmpeg jobs, 2 file copy workers).
  - Optimistic batch UI insertion: insert all cards into the UI in 1 frame, then hydrate metadata and thumbnails asynchronously.
  - Low-overhead thumbnail extraction using optimized FFmpeg parameters (`-ss 00:00:00.5 -vframes 1 -s 320x180 -q:v 3`).

---

### Section E: Typography & Text Animations Suite
- **Target Files**: `js/textanim/*`, `jsx/text.jsx`, `js/toolkit/toolkit.js`.
- **Deeply Analyze & Test**:
  1. **Text Splitter (Letters, Words, Lines)**:
     - Does it accurately split text layers into individual layers per letter, word, or line?
     - Are character kerning, font families, tracking, and world transforms preserved identically?
     - Is a master Null controller created with parent links for easy motion design?
  2. **Responsive Auto-Resizing Text Box**:
     - Does the rounded background shape layer dynamically hug the text box using expressions (`sourceRectAtTime()`)?
     - Does it update smoothly in real time when text content, font size, or multiline text changes?
  3. **Find & Replace Text Across Comps**:
     - Does it search all text layers in the active comp or whole project without missing nested precomps?
     - Does replacing strings update timeline layers accurately without throwing null pointer exceptions on locked layers?
  4. **Text Presets & Kinetic Styles**:
     - Do presets apply cleanly with correct in/out keyframed easing?
- **Smart Upgrade Target**:
  - 1-Click expressions that automatically adjust padding and roundness via slider controls.
  - Robust text-metric preflight checks that avoid expression breaks when text layers are empty (`""`).

---

### Section F: FX Presets, 106 One-Framers & Color Engine
- **Target Files**: `js/toolkit/effects.js`, `presets/oneframers_106_recipes.json`, `jsx/helpers.jsx`.
- **Deeply Analyze & Test**:
  1. **.ffx Preset Management**:
     - Does scanning user preset directories handle deeply nested subfolders without blocking the UI thread?
     - Does applying a `.ffx` preset handle missing plug-in dependencies gracefully with clear user toasts instead of silent AE script halts?
  2. **106 One-Framers Programmatic Presets**:
     - Are the 106 ported One-Framers recipes verified against ExtendScript?
     - Do recipes create proper effect properties, keyframes, expressions, and blend modes in a single undo group?
  3. **Favorites, Categories & Search**:
     - Does starring a preset persist immediately to local storage/settings without disk lag?
     - Is preset search instant (<16ms keystroke latency)?
- **Smart Upgrade Target**:
  - In-memory cached recipe catalog loaded asynchronously.
  - Safe application wrapper that checks for required host effects before applying.

---

### Section G: Backend Host & Core Infrastructure (`jsx/` + Node + Bridge)
- **Target Files**: `jsx/core.jsx`, `jsx/toolkit.jsx`, `jsx/import.jsx`, `jsx/compSaver.jsx`, `js/core/bridge.js`, `js/core/persistence.js`, `js/core/state.js`, `js/core/appLifecycle.js`.
- **Deeply Analyze & Test**:
  1. **ExtendScript ES3 Compliance & AE Runtime Safety**:
     - Scan every `.jsx` file for accidental ES5/ES6 syntax (`let`, `const`, arrow functions `() => {}`, `JSON.parse` without polyfill, `Array.map`, `Object.keys`, default arguments).
     - Does any function fail silently when executed in older After Effects versions?
  2. **The Hex-Bridge Payload Expansion Penalty**:
     - `encodeBridge()` expands every single character into 4 hexadecimal digits (`"a"` ➔ `"0061"`). A 100KB JSON object becomes a 400KB string!
     - In single-threaded ExtendScript, decoding 400,000 characters in an ES3 loop takes 150ms–300ms of pure CPU freeze!
     - **The Smart Move**: Optimize the transport! Only hex-encode arbitrary user strings (filenames, custom paths) while passing structured numbers, command tokens, and booleans in compact raw format.
  3. **Timeline Viewer Freeze During Batch Operations**:
     - In ExtendScript, modifying 20 layers without grouping causes AE to re-render the composition viewer 20 times!
     - Verify that every batch operation suspends viewer redraws or uses atomic undo blocks so AE updates only ONCE at the end.
  4. **Persistence & Atomic Disk Operations**:
     - Are settings, templates, and favorites written atomically (write to temp file then rename) to prevent JSON file corruption on sudden AE crashes?
     - Are file system operations in Node.js asynchronous (`fs.promises`) rather than synchronous (`fs.writeFileSync`, `fs.readdirSync`) on the CEP UI thread?
  5. **Panel Lifecycle & Memory Leak Elimination**:
     - When the panel is closed, re-opened, or reloaded (F5), are all intervals, timers, file watchers, and video elements cleanly destroyed?
     - Does repeated opening/closing cause memory or process count growth?
- **Smart Upgrade Target**:
  - Fast-path IPC transport with zero redundant encoding.
  - Atomic snapshot persistence with instant warm boot (<80ms).
  - Complete memory lifecycle management (`AppLifecycle.disposeAll()`).

---

## 🚀 2. Operating Mode — 5-Phase Systematic Execution

To ensure absolute thoroughness, do not perform uncoordinated edits. Follow this exact 5-phase execution framework:

### Phase 1: Full Autonomous Audit & Top Bottlenecks Diagnostic
1. Independently inspect, profile, and trace every subsystem listed above with zero preconceptions.
2. Rank and document the **Top 5 Absolute Worst Bottlenecks** in CompSaver (the primary culprits causing UI freezes, memory bloat, high latency, or crash risks).
3. Produce an evidence-backed **Defect, Smart Upgrade & 100× Optimization Matrix**:
   - `Item ID & Priority Rank`
   - `Subsystem, File Path & Function`
   - `Working vs. Broken vs. Weak Assessment`
   - `Root Cause Analysis`
   - `Legacy Naive Implementation ➔ 100× Smart Modern Replacement`
   - `Latency / Memory Impact (Current Baseline vs. Target)`
   - `Safe Solution Plan & Invariants`

### Phase 2: Systematic Wave Grouping
Group all identified defects, smart replacements, and optimizations into at most **6 Sequential Execution Waves**:
- **Wave 1**: Startup, Instant Snapshot Hydration & State Engine (<80ms Panel Boot)
- **Wave 2**: Virtual Windowed Grid & 5,000+ Scalability (Zero-lag scroll, O(1) Search)
- **Wave 3**: Thumbnail Engine & Hover Preview Pipeline (Bounded 320×180, Zero Leaks)
- **Wave 4**: Media Engine & Batch Import Pipeline (Bounded Concurrency, Optimistic Cards)
- **Wave 5**: Toolkit Suite, Flow, Text, FX & IPC Bridge (Single-Trip Calls, Undo Grouping)
- **Wave 6**: Save Engine, Render Pipeline & Aerender Isolation (Zero-Crash AEP Save)

### Phase 3: Sequential Wave Execution (One Wave at a Time)
1. In the active session, implement **only the selected wave**.
2. For every item in that wave:
   - Fix all identified bugs completely at the root cause.
   - Replace outdated legacy code with the modern smart implementation.
   - Accelerate the hot path to achieve 10× to 100× performance improvement.
   - Guard against edge cases (empty states, missing comp selections, locked layers, corrupted files).
3. Run automated tests, syntax linting, and manual verification steps immediately.
4. Report before/after evidence (bugs fixed, legacy code replaced, latency benchmarks, memory delta) and **STOP**.
5. Do NOT proceed to the next wave without explicit confirmation: `Continue with the next wave`.

---

## 🛡️ 3. Strict Performance & Quality Gates

Every modification must satisfy these objective quality standards:

| Requirement / Gate | Target Standard | Verification Method |
|---|---|---|
| **Zero Regressions & Safety** | 100% preservation of active AE projects and user templates; zero project corruption | Verified against test `.aep` fixtures |
| **ExtendScript ES3 Compliance** | Strict ES3 syntax in all `jsx/*.jsx` files; no `let`, `const`, or arrow functions | Syntax checks, ES3 parser validation |
| **Instant Interaction Feedback** | ≤ 16ms to 100ms click-to-visual response across all tools and buttons | CEP performance timeline / console timestamps |
| **Startup / Hydration Time** | Warm panel open to first usable interactive viewport ≤ 80ms at 5,000 records | Startup instrumentation timer |
| **Grid Scroll Performance** | Rock-solid 60 FPS scrolling through 5,000+ items with bounded DOM footprint | Chrome DevTools Frame Viewer |
| **Atomic Undo Groups** | Every tool action reverts cleanly in exactly 1 `Ctrl+Z` undo step | Manual and automated AE undo tests |
| **Memory Leak Protection** | Zero unbounded RAM or video element growth after 50 operations | Process memory delta measurement |
| **Measured 100× Evidence** | Every speedup claim must be supported by before/after empirical latency data | Comparative benchmark table with sample counts |

---

## 📊 4. Required Report Format for Each Wave

Upon completing each wave, output a clean, structured report containing:
1. **Wave Summary**: Wave number, target subsystem, and engineering rationale.
2. **Bugs Eradicated**: Table of all fixed defects with IDs, file paths, root causes, and verification tests.
3. **Smart Transformations**: Detailed comparison of the legacy naive code replaced vs. the modern smart architecture implemented.
4. **100× Performance Benchmark**: Table comparing baseline latency vs. optimized latency (p50 & p95 in ms), speedup factor, and memory delta.
5. **Modified Files & Symbols**: Exact list of files and key functions updated.
6. **Safety & Invariant Confirmation**: Confirmation of ES3 compliance, single-step undo integrity, and zero project corruption.
7. **Next Wave Recommendation**: Recommended next wave and prerequisites.