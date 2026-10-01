# Implementation Plan: save-performance-optimization

## Overview

This plan implements the "reduce-first, single template save" redesign in the existing
JavaScript/ExtendScript codebase. The strategy is to extract the destructive save sequence and the
path construction logic into **pure, `app`-injected / dependency-free modules** so that jest +
fast-check can assert the correctness properties without After Effects, then apply the same sequence
inside the ExtendScript host functions (`coreSaveLayerType`, `saveActiveComp`) and move thumbnail
rendering into the client background queue.

Implementation language: **JavaScript / ExtendScript** (the host language of this codebase).
Testing: **jest 29** with **fast-check 3.22** (already in `devDependencies`); tests live in
`tests/*.test.js`.

## Tasks

- [x] 1. Extract pure, testable core modules (path builders + save orchestrator)
  - [x] 1.1 Create the pure path-builder module
    - Create `js/core/pathBuilders.js` exporting `buildTemplateFolderPath(root, section, safeCat, templateId)`, `buildAepPath(folderPath)`, `buildThumbPath(folderPath)`, `getSafeName(name)`, and `generateTemplateId(name)`
    - Normalize separators: convert every backslash to forward slash, collapse runs of separators to one, strip leading/trailing separator
    - `getSafeName`/`generateTemplateId`: replace every `/`, `\`, and whitespace char with a single underscore, ensure no path separator remains, truncate to 255 chars
    - Return a descriptive error (no path constructed) when the name is empty or sanitizes to zero characters
    - Guard the export so the same file is loadable by jest (CommonJS) and includable by ExtendScript
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x]* 1.2 Write property tests for the path builders
    - **Property (Req 12): Deterministic path construction and sanitization**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5**
    - Use fast-check to assert: identical inputs produce byte-for-byte identical output; output never contains `\`, `//`, or leading/trailing separator; sanitized names contain no `/` or `\` and are ≤255 chars; empty/zeroed names yield the invalid-name error
    - Create `tests/save-path-builders.test.js`

  - [x] 1.3 Create the pure save orchestrator module
    - Create `js/core/saveOrchestrator.js` exporting `runReduceFirstSave(app, ctx)` with the exact ordering from the design: `beginUndoGroup` → protective `save(originalFile)` (abort-on-throw) → `buildTempComp` → `reduceProject([temp])` → single `save(targetFile)` → `collectFootageAssets` → `endUndoGroup` → `open(originalFile)` once
    - Return `{ ok:true, assetsList, folderPath, needsThumbnail:true }` on success; on protective-save throw return `{ ok:false, aborted:true, reason:"protective-save-failed" }` with `endUndoGroup` called once and NO reduce/reopen
    - On a throw inside the destructive window (reduce or template save) end the undo group once, reopen `originalFile` (with suppress-dialogs balanced), and return a failure result
    - Never call `saveFrameToPng`/`renderFrameToPng` from this module
    - Guard the export for both jest (CommonJS) and ExtendScript inclusion
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.4, 4.1, 4.2, 4.4, 5.1, 6.1, 6.2, 7.1, 7.2, 7.3, 8.1_

  - [x]* 1.4 Write property/ordering tests for the orchestrator using a fake `app`
    - **Property 1: Reduce-before-save ordering** — reduce is recorded before the single template save _(Validates: Requirements 1.1, 1.2, 1.3)_
    - **Property 4: Exactly two full saves** — `app.project.save` call count equals exactly 2 on success _(Validates: Requirements 2.1, 2.2)_
    - **Property 5: Reopen exactly once** — `app.open(originalFile)` recorded exactly once on success and once on destructive-window failure, never zero after reduce _(Validates: Requirements 4.1, 4.2, 4.4)_
    - **Property 6: No frame render in blocking path** — no `saveFrameToPng`/`renderFrameToPng` in the call log _(Validates: Requirements 5.1, 5.2)_
    - **Property 7: Abort-before-destroy** — fake throws on first `save` → `reduceProject` and `open` never called, result `{aborted:true}`, `endUndoGroup` called once _(Validates: Requirements 3.1, 3.4)_
    - **Property 8: Undo/suppress balance** — across success, abort, and restore paths the begin/end undo-group counts match and begin/end suppress-dialogs counts match _(Validates: Requirements 7.1, 7.2, 7.3)_
    - **Property 2: assetsList collected after reduce** — assets collection is recorded after `reduceProject` and before `open` _(Validates: Requirements 8.1)_
    - Use a fake `app` recording a call log; each property above is its own fast-check/jest case
    - Create `tests/save-orchestrator.test.js`

- [x] 2. Rework `coreSaveLayerType` to the reduce-first sequence
  - [x] 2.1 Apply the reduce-first sequence in `coreSaveLayerType`
    - In `jsx/templates_save.jsx`, capture `layerState`/layer metadata BEFORE any destructive op, then run the orchestrator sequence: protective save (abort-on-failure with `endUndoGroup` + error return, no reduce/reopen), build temp comp, reduce-first, single `save(targetFile)`, collect `assetsList` after reduce, `endUndoGroup`, reopen once with balanced suppress-dialogs
    - Add the `RESTORE_AND_RETURN(originalFile, message)` helper for destructive-window failures (best-effort temp remove, `endUndoGroup`, suppressed reopen, return error string)
    - Remove the synchronous thumbnail render call and remove the redundant third `app.project.save()`
    - Return object includes `needsThumbnail: true` plus preserved fields (`folderPath`, `assetsList`, `layerCount`, `isAdjustment`, `is3D`, `blendMode`, `label`, `layerState`, etc.)
    - Keep input guardrails (no comp / no selection / project never saved / temp-comp or copy failure) returning errors without leaving state unbalanced
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 8.4, 9.1, 9.3, 13.1, 13.2, 13.3, 13.4_

- [x] 3. Rework `saveActiveComp` to the reduce-first sequence
  - [x] 3.1 Apply the reduce-first sequence in `saveActiveComp`
    - In `jsx/templates_save.jsx`, remove the inline thumbnail block (`openInViewer` + `__CS_BG__` solid + `saveFrameToPng` + depth restore) and the redundant third save
    - Apply protective save (abort-on-failure), rename precomp before reduce, reduce-first, single `save(targetFile)`, collect `assetsList` after reduce, `endUndoGroup`, reopen once with balanced suppress-dialogs
    - Add `RESTORE_AND_RETURN_HEX(originalFile, message)` (encodeBridge-wrapping restore) for destructive-window failures
    - Update the returned JSON: add `needsThumbnail: true`, drop `thumbnailPath`, preserve `ok`, `templateId`, `name`, `category`, `folderPath`, `assetsList`, `oldId`; keep success signalled by `ok === true` / `"true"` and failure by a distinguishable non-empty error string
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 8.1, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 13.3_

- [x] 4. Add the non-destructive background thumbnail renderer (host)
  - [x] 4.1 Implement `renderTemplateThumbnail` in ExtendScript
    - In `jsx/templates_save.jsx`, add `renderTemplateThumbnail(aepPathHex, outPngPathHex)` that decodes the bridge args, imports the saved `project.aep` non-destructively (the `taRenderPresetPreview` scratch-import pattern), picks the first comp, renders a frame at `workAreaStart + workAreaDuration * 0.3` via the reused `renderFrameToPng`, discards the scratch import, and returns `encodeBridge(JSON{ ok, error? })`
    - Do NOT modify, reopen, or reload the user's live project
    - _Requirements: 10.3, 11.2_

- [x] 5. Add the client-side background thumbnail queue
  - [x] 5.1 Implement `enqueueThumbnailRender` on the existing serialized queue
    - In `js/textanim/textanim.js`, add `enqueueThumbnailRender(aepPath, outPngPath, onDone)` that pushes a thumbnail job onto the existing `previewQueue`/`drainPreviewQueue` infrastructure so thumbnail and preview jobs run one-at-a-time in FIFO order and never overlap
    - Call the host `renderTemplateThumbnail` via the hex bridge; on completion invoke `onDone(err)`
    - Abandon a job that fails or does not complete within 60 seconds, mark it failed, and proceed to the next queued job; retry a failed thumbnail at most once during the session
    - _Requirements: 10.5, 10.6, 10.7, 11.1_

  - [x]* 5.2 Write unit tests for queue serialization and timeout/retry
    - Assert FIFO ordering, no overlap between thumbnail and preview jobs, the 60s abandon-and-advance behavior, and the at-most-once retry
    - _Requirements: 10.5, 10.6, 10.7_

- [x] 6. Wire the client save flow to defer thumbnail rendering
  - [x] 6.1 Branch `confirmSave` on `needsThumbnail` and schedule background renders
    - In `js/templates/templates.js`, after a successful save writes `meta.json` + assets, when `needsThumbnail === true` schedule `enqueueThumbnailRender(folderPath + "/project.aep", folderPath + "/thumbnail.png", cb)` inside a `setTimeout(…, 0)` so the panel paints/accepts input first, then enqueue exactly one `enqueuePreviewRender` for the saved `.aep`
    - On thumbnail success refresh only the saved card with a cache-busting `?v=<mtime>` query; on failure retain the CSS placeholder and mark the template for regeneration on next load
    - Treat a missing `needsThumbnail` field as "no deferred thumbnail" (back-compat); stop reading `thumbnailPath`
    - Preview failure must leave any existing preview and the live project unchanged
    - _Requirements: 9.6, 10.1, 10.2, 10.4, 10.6, 11.1, 11.3_

  - [x]* 6.2 Write unit tests for client return-shape handling and back-compat
    - Assert `needsThumbnail:true` schedules exactly one thumbnail job and one preview job without blocking; missing `needsThumbnail` schedules no thumbnail job; success/error dispatch (`ok`/`"true"`/error string) unchanged
    - _Requirements: 9.1, 9.4, 9.5, 9.6, 10.1, 10.2, 11.1_

- [x] 7. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific granular requirement clauses for traceability.
- Property-based tests (fast-check) validate the universal correctness properties from the design;
  each property is its own sub-task annotated with its property number and the requirement clauses it
  checks.
- AE-runtime behavior (actual freeze/timing, real `reduceProject`/`app.open`) is validated via the
  design's manual checklist, not automated tests; those manual items are intentionally out of scope
  for the coding tasks above.
- Pure modules (`pathBuilders.js`, `saveOrchestrator.js`) are dependency-free/`app`-injected so the
  same logic is exercised by jest and reused by the ExtendScript host functions.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "5.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.1", "6.1"] },
    { "id": 2, "tasks": ["3.1", "5.2", "6.2"] },
    { "id": 3, "tasks": ["4.1"] }
  ]
}
```
