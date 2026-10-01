# CompSaver Performance Repair — Individual Master Prompt Pack

This pack splits the six reported performance failures into independent, copy-paste-ready repair sessions. Do **not** paste all prompts together. Start a fresh Kiro Vibe/Autopilot session for one file, let it finish and validate, then test CompSaver inside After Effects before starting the next.

## Recommended order
1. `02-panel-reopen-startup.md` — establish reliable persistent cache and fast hydration.
2. `04-template-library-5000-scale.md` — index and virtualize the template UI.
3. `05-image-card-thumbnails.md` — make visible thumbnails bounded and deterministic.
4. `01-media-engine-lag.md` — batch imports and bound media decoding/transcoding.
5. `03-tools-instant-paste-crop.md` — remove UI-thread blocking and harden host calls.
6. `06-render-save-crash.md` — isolate and serialize the highest-risk AE work.

This order minimizes overlap: Problems 4–5 reuse startup state from Problem 2, and Problem 1 reuses the scalable grid from Problem 4. If you must follow the original numbering, each prompt is still self-contained, but rework is more likely.

## Code-backed diagnosis and proposed solution
| Problem | Confirmed bottleneck | Solution direction |
|---|---|---|
| Media Engine lag | `importMediaFile()` rebuilds categories and the complete grid per item; images are copied full-size as thumbnails; native-size video frames and FFmpeg jobs are not tightly bounded; FFmpeg patches selectors that cards do not contain. | Batch optimistic inserts, one render per frame/batch, bounded queues, 320×180 thumbnails, normalized cache records, correct keyed card patches, reusable/controlled hover preview. |
| Slow panel reopen | `loadTemplates()` blocks on full bridge scans whenever validity differs and even warm startup walks and renders all records. | Paint from a compact persisted index first, validate/reconcile in background, incrementally invalidate changed folders, instrument cache-hit/miss causes. |
| Slow/unreliable tools | Paste uses `writeFileSync` or byte-by-byte string building; direct bridge calls have weak timeout/operation cleanup; Crop performs synchronous AE traversal. | Async temp writes, idempotent listeners, immediate feedback, shared operation guards/timeouts, structured host errors, optimized Crop preflight/property traversal. |
| Lag at 150; need 5,000+ | Filtering repeatedly scans all records, category counts are O(N×C), and `renderCards()` creates every card with one giant `innerHTML`. | Section/category indexes, one-pass counts, debounced search, incremental mutations, event delegation, a CEP-safe virtual/windowed grid with bounded DOM. |
| Late/missing image thumbnails | All normal card images decode together, `content-visibility` is relied on in old CEP Chromium, full-resolution sources are used, patch selectors/schema differ, and errors have no terminal UI. | Normalize entry schema, explicit thumbnail state machine, bounded assets, virtualized/observer-driven loading with fallback, async decode, fixed dimensions, retry/error state. |
| Slow/crashing render | Save performs two full project writes plus destructive reduce/reopen; duplicate save logic exists; thumbnail rendering imports saved AEPs into the live project, causing memory spikes. | One canonical safe sequence, essential-save/background-render separation, serialized queue with timeout/circuit breaker, memory gates, bounded thumbnails, optional isolated `aerender` behind capability checks. |

## Session rules
- Commit or back up the current working tree before each prompt; Kiro must not commit unless you explicitly ask.
- Use a real test library copy, never the only copy of production templates.
- Record before/after numbers requested by the prompt. “Feels faster” is not sufficient.
- Do not run multiple prompts in parallel: they touch shared template/cache/render paths.
- A prompt is complete only when targeted Jest checks pass and the listed manual AE checks pass.
- If a regression appears, revert only that prompt’s changes before moving on.

## Expected outcome
Warm reopen should show the first usable viewport immediately, category/section switching and scrolling should remain responsive at 5,000 records, thumbnail work should stay proportional to visible cards, tools should acknowledge clicks instantly without freezing CEP, and render failures should degrade safely instead of crashing or wedging After Effects.