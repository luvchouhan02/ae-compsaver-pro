# Save Engine Implementation — Developer Handoff

Feature: **save-performance-optimization** ("reduce-first, single template save").

This document is for developers maintaining CompSaver. It explains what changed in the
template save path, why the old path froze After Effects, and how the new design works.

Spec: `.kiro/specs/save-performance-optimization/` (requirements, design, tasks).

---

## 1. What changed (summary)

The template save path was reworked so the blocking ExtendScript routine does the minimum
possible work, and all rendering (thumbnail + preview) happens afterward in a client-side
background queue.

- Reduce-first ordering: the project is reduced **before** the single template save.
- Exactly **two** full project saves (one protective, one template) — down from up to three.
- Protective save now **aborts on failure** instead of silently swallowing the error.
- The synchronous thumbnail frame render was **removed from the blocking path**.
- Any failure inside the destructive window **restores the user's project from disk**.
- Thumbnails render in the background via a new non-destructive host entry point, serialized
  with preview rendering on the existing queue.

The overriding invariant: **the user's live project must never be lost.**

---

## 2. Why the old implementation was slow

The old blocking save (in `jsx/templates_save.jsx`) performed, synchronously, before returning
control to the panel:

1. Up to **three** full `app.project.save()` calls.
2. A **synchronous thumbnail render** — opening a comp in the viewer, adding a temporary
   background solid, calling `saveFrameToPng`, and restoring project bit depth.
3. A destructive `reduceProject` and a reopen from disk.

Every one of these blocks the AE main thread. The frame render in particular is expensive, so
AE went "Not Responding" and the panel stayed in a loading state until everything finished.
A failed protective save was also swallowed, leaving a real data-loss risk.

---

## 3. How the new reduce-first workflow operates

The canonical ordering is encoded as a pure, `app`-injected function
`runReduceFirstSave(app, ctx)` in `js/core/saveOrchestrator.js` (so it is unit-testable without
AE), and mirrored inside the ExtendScript host functions `coreSaveLayerType` and `saveActiveComp`.

Success path (no step fails):

```
beginUndoGroup
  → save(originalFile)        // PROTECTIVE save; abort on throw
  → buildTempComp             // pre-reduce, non-destructive
  → reduceProject([tempComp]) // enters the "destructive window"
  → save(targetFile)          // the single TEMPLATE save (project.aep)
  → collectFootageAssets      // AFTER reduce, so assetsList is accurate
endUndoGroup
  → open(originalFile)        // REOPEN exactly once, dialog-suppression balanced
```

Key guarantees (each covered by a property test):

- `reduceProject` runs before the template save, exactly once.
- Exactly two full `app.project.save` calls; the reopen (`app.open`) is not a save.
- `open(originalFile)` is invoked exactly once on success.
- No `saveFrameToPng` / `renderFrameToPng` on any path in the blocking routine.
- `beginUndoGroup`/`endUndoGroup` and `beginSuppressDialogs`/`endSuppressDialogs` counts are
  balanced on every exit path.

Return shape (over the hex bridge): adds `needsThumbnail: true`, drops the eager `thumbnailPath`,
and preserves all existing fields (`folderPath`, `assetsList`, `templateId`, `name`, `category`,
`oldId`, plus layer metadata for layer saves). Success is still signalled by `ok === true` on the
object path or the literal string `"true"` on the monolithic path; failures are a distinguishable
non-empty error string.

---

## 4. How the background thumbnail queue works

After a successful save, the client (`js/templates/templates.js`, `confirmSave`) defers rendering:

1. When `needsThumbnail === true`, it schedules a thumbnail job inside `setTimeout(…, 0)` so the
   panel paints and accepts input first.
2. It enqueues exactly one preview job for the same saved `project.aep`.

Both ride the **existing serialized `previewQueue`** in `js/textanim/textanim.js`
(`enqueueThumbnailRender` / `drainPreviewQueue` / `drainThumbnailJob`), so thumbnail and preview
renders run one-at-a-time in FIFO order and never overlap.

- Timeout: a thumbnail that fails or does not finish within `THUMBNAIL_TIMEOUT_MS` (60s) is
  abandoned and the queue advances.
- Retry: a failed thumbnail is retried **at most once** per session
  (`THUMBNAIL_MAX_ATTEMPTS = 2`), requeued at the back so the next job runs first.
- On success, only the saved card is refreshed, using a cache-busting `?v=<mtime>` query so CEF
  does not show a stale image.
- On terminal failure, the CSS placeholder is retained and the template is marked for thumbnail
  regeneration on next load.

The host renderer `renderTemplateThumbnail(aepPathHex, outPngPathHex)` (in
`jsx/templates_save.jsx`) imports the saved `project.aep` as a **scratch import** (the
`taRenderPresetPreview` pattern), renders one frame at
`workAreaStart + workAreaDuration * 0.3` via the reused `renderFrameToPng`, then discards the
import. It never touches `app.project.file`, never calls `app.open`, and never reduces/reloads the
live project.

---

## 5. Restore / failure recovery flow

The **destructive window** is the interval between `reduceProject` and the successful reopen. The
protective save writes an on-disk snapshot of the user's project *before* this window opens, so
recovery is always possible from disk.

- **Protective save fails** → end undo group, return an error. No reduce, no template save, no
  reopen. The live project is 100% intact (abort-before-destroy).
- **Reduce fails** or **template save fails** (inside the destructive window) →
  `RESTORE_AND_RETURN` / `RESTORE_AND_RETURN_HEX`: best-effort remove temp comp, end the undo
  group once, reopen `originalFile` from disk with balanced dialog suppression, and return a
  descriptive error string.
- **Reopen itself fails** → return an error instructing the user to reopen manually; the on-disk
  protective snapshot is left intact.
- **Metadata collection fails** after reduce → reopen from disk and return an error.

Undo groups and dialog suppression are balanced on every one of these paths.

---

## 6. Files added / modified

Added:

- `js/core/saveOrchestrator.js` — pure, `app`-injected `runReduceFirstSave(app, ctx)` (+ helpers
  `reopenOriginal`, `restoreAndReturn`, `removeTempCompSafe`). Dual-export guard for Jest
  (CommonJS) and ExtendScript include.
- `js/core/pathBuilders.js` — pure path/name helpers: `buildTemplateFolderPath`, `buildAepPath`,
  `buildThumbPath`, `getSafeName`, `generateTemplateId`, `normalizeSeparators`. ES3-compatible.

Modified:

- `jsx/templates_save.jsx` — reworked `coreSaveLayerType` and `saveActiveComp` to reduce-first;
  added `RESTORE_AND_RETURN` / `RESTORE_AND_RETURN_HEX`; removed the sync thumbnail block and the
  redundant third save; added the `renderTemplateThumbnail` host entry point; return shape now
  includes `needsThumbnail`.
- `js/textanim/textanim.js` — added `enqueueThumbnailRender`, `drainThumbnailJob`,
  `runOneThumbnail`; extended `drainPreviewQueue` to dispatch by job kind; exposed
  `enqueueThumbnailRender` on the public API.
- `js/templates/templates.js` — `confirmSave` branches on `needsThumbnail`, defers thumbnail +
  preview scheduling, refreshes the saved card, and stays back-compatible with a missing field.

Tests added (40 tests, all passing):

- `tests/save-orchestrator.test.js` — ordering/save-count/reopen/abort/restore/balance properties.
- `tests/save-path-builders.test.js` — deterministic path construction + sanitization properties.
- `tests/save-thumbnail-queue.test.js` — FIFO/no-overlap/timeout/retry.
- `tests/save-return-shape.test.js` — client dispatch + back-compat.

---

## 7. Architectural decisions future contributors should know

- **Pure, app-injected core.** The reduce-first ordering and path building live in dependency-free
  modules so their correctness is provable under Jest + fast-check without After Effects. The
  ExtendScript host mirrors the same ordering. If you change the ordering in one place, change it
  in both and update the property tests.
- **`getSafeName` / `generateTemplateId` exist in three runtime contexts** (Node/Jest,
  ExtendScript host, CEP browser panel). These are **not** duplicates to consolidate — the three
  contexts cannot share a module. Keep them in sync by behavior, not by merging.
- **Thumbnails and previews share one serialized queue** on purpose. Two concurrent AE renders
  thrash the app; the single-flight `previewQueue` prevents overlap. Do not add a second queue.
- **Return-shape contract is a bridge boundary.** `needsThumbnail` drives client scheduling; a
  missing field means "no deferred thumbnail" (back-compat). Preserve existing field names/values.
- **Never reference secrets or reopen the live project in the background renderer.** The scratch
  import must always be discarded in a `finally`.

---

## 8. Known limitations

- **In-AE behavior is not automatically tested.** The property tests use a fake `app` and mocked
  bridge. Real `reduceProject` / `app.open` timing and the perceived freeze elimination must be
  confirmed with a manual smoke test in After Effects.
- **Thumbnail retry is once per session, in-memory.** The retry counter is not persisted; a
  restart resets it.
- **60s thumbnail timeout is a fixed constant** (`THUMBNAIL_TIMEOUT_MS`). Very heavy comps could
  legitimately exceed it and be abandoned (regenerated on next load).
- **Project-wide test suite is not fully green.** ~103 pre-existing failures come from an unrelated
  CSS/HTML visual redesign (design-token and markup contract drift). They do not touch the save
  engine. The save engine's own 40 tests all pass.

---

## 9. Manual smoke-test checklist (After Effects)

Run these in a real AE session before shipping:

1. **Comp save, happy path.** Save a comp as a template. AE stays responsive (no "Not
   Responding"); the card appears immediately with a placeholder; the thumbnail swaps in a few
   seconds later; the preview also renders.
2. **Layer save.** Save a single layer. Layer metadata (adjustment/3D/blend/label/layerState) is
   preserved; thumbnail + preview appear.
3. **Project reopens once.** After a save, confirm your original project is reopened and you are
   back where you were — not duplicated, not left on the reduced project.
4. **Protective-save abort.** Make the project file read-only (or otherwise unsaveable) and save a
   template. Expect a clear error and your live project completely untouched (no reduction).
5. **Destructive-window restore.** Simulate a failure after reduce (e.g., target folder not
   writable). Expect your project restored from disk and a descriptive error.
6. **Unsaved project.** Save a template from a project that was never saved to disk. Expect the
   "save your project first" guardrail with no destructive work.
7. **Thumbnail regeneration.** Delete a template's `thumbnail.png`, reload the panel, confirm it
   regenerates in the background.
8. **Queue serialization.** Save several templates quickly. Confirm renders run one at a time and
   the panel stays responsive.
9. **Exactly two saves.** (Optional, via logging) Confirm only one protective + one template save
   occur — no redundant third save.

---

## 10. Future improvement ideas

- **Automated in-AE integration harness** (e.g., BridgeTalk / aerender-driven) to cover the real
  `reduceProject`/reopen behavior that the unit tests mock.
- **Adaptive thumbnail timeout** based on comp complexity instead of a fixed 60s.
- **Persisted regeneration marker** so abandoned thumbnails reliably regenerate across restarts.
- **Batch save** support that reduces once and writes multiple templates, if a use case emerges.
- **Progress/telemetry** around save duration (`console.time`) to catch regressions early.
- **Consolidate the reduce-first host code** so `coreSaveLayerType` and `saveActiveComp` share a
  single ExtendScript implementation of the sequence, reducing drift risk with the pure module.
