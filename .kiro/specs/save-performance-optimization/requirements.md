# Requirements Document

## Introduction

Saving a template in CompSaver currently freezes After Effects ("Not Responding") and keeps the
panel in a loading state after the visible frame render finishes. The blocking work lives in
ExtendScript (`jsx/templates_save.jsx`), where the save path performs up to three full project
saves, a synchronous thumbnail render, a destructive `reduceProject`, and a reopen from disk.

This feature applies the "reduce-first, single template save" redesign. The blocking save keeps a
single protective project save (with abort-on-failure instead of the current swallowed failure),
runs `reduceProject` before a single template save, drops the redundant third save, and reopens the
user's project exactly once. Thumbnail and preview rendering move out of the blocking path into a
client-side background queue that imports the saved `project.aep` non-destructively. The overriding
invariant is that the user's live project must never be lost.

These requirements are derived from the approved design document and describe the observable
behavior the redesigned save path must guarantee.

## Glossary

- **Save_Sequence**: The reduce-first ExtendScript save routine implemented by `coreSaveLayerType`
  and `saveActiveComp` in `jsx/templates_save.jsx` that writes a template `project.aep` and returns
  metadata over the hex bridge.
- **Protective_Save**: The single full `app.project.save(originalFile)` performed at the start of
  the Save_Sequence to guarantee an on-disk snapshot of the user's project.
- **Template_Save**: The single full `app.project.save(targetFile)` that writes the reduced template
  `project.aep`.
- **Reduce_Operation**: The `app.project.reduceProject([tempComp])` call that strips the live
  project down to the template comp and its dependencies.
- **Destructive_Window**: The interval between the start of the Reduce_Operation and the successful
  reopen of the user's project, during which the in-memory project is compromised.
- **Reopen**: The single `app.open(originalFile)` call that restores the user's project from disk
  after the Destructive_Window.
- **Save_Orchestrator**: The pure, `app`-injected function `runReduceFirstSave(app, ctx)` that
  encodes the reduce-first call ordering for testability.
- **Return_Object**: The metadata object (or its hex-encoded JSON form) returned by the
  Save_Sequence to the client over the `evalScript` hex bridge.
- **Thumbnail_Job**: The client-side background task `enqueueThumbnailRender` that renders a
  template thumbnail after the blocking save returns.
- **Preview_Job**: The existing client-side background task `enqueuePreviewRender` that renders the
  template preview video.
- **Thumbnail_Renderer**: The new ExtendScript entry point `renderTemplateThumbnail` that
  non-destructively imports a saved `project.aep` and renders a frame to PNG via `renderFrameToPng`.
- **Background_Queue**: The existing serialized client queue (`previewQueue` / `drainPreviewQueue`)
  that runs Thumbnail_Job and Preview_Job without overlap.
- **Path_Builder**: The pure path-construction helpers (`buildTemplateFolderPath`, `buildAepPath`,
  `buildThumbPath`, `getSafeName`, `generateTemplateId`).
- **originalFile**: The user's project file on disk (the Protective_Save target).
- **targetFile**: The template `project.aep` written under the template folder.

## Requirements

### Requirement 1: Reduce-first single template save ordering

**User Story:** As a CompSaver user, I want the save routine to run the project reduction before the
template save, so that the written template is minimal and the project is written the fewest times.

#### Acceptance Criteria

1. WHEN the Save_Sequence executes a save in which no step fails, THE Save_Orchestrator SHALL invoke exactly these operations, each exactly once, in this relative order with no other Protective_Save, Reduce_Operation, Template_Save, or Reopen invoked before, between, or after the listed steps: begin undo group, Protective_Save of originalFile, Reduce_Operation, Template_Save of targetFile, end undo group, Reopen of originalFile.
2. WHEN the Save_Sequence executes a save in which no step fails, THE Save_Orchestrator SHALL complete the Reduce_Operation before initiating the Template_Save.
3. WHEN the Save_Sequence executes a save in which no step fails, THE Save_Orchestrator SHALL invoke the Reduce_Operation exactly once, regardless of the number of layers or comps included in the save.

### Requirement 2: Exactly two full project saves

**User Story:** As a CompSaver user, I want redundant full-project saves eliminated, so that saving a
template does less blocking disk work.

#### Acceptance Criteria

1. WHEN the Save_Sequence executes a successful save, THE Save_Orchestrator SHALL perform exactly two full-project `app.project.save` invocations: one Protective_Save and one Template_Save.
2. THE Save_Sequence SHALL NOT perform any full-project `app.project.save` invocation on any execution path, including successful, aborted, and restore paths, beyond the single Protective_Save and the single Template_Save.
3. WHEN the Save_Sequence performs the Reopen of originalFile, THE Save_Sequence SHALL treat the `app.open` invocation as a project reopen and SHALL NOT count it as a full-project save.

### Requirement 3: Protective save with abort-on-failure

**User Story:** As a CompSaver user, I want the save to stop safely if the protective save fails, so
that my unsaved work is never destroyed.

#### Acceptance Criteria

1. IF the Protective_Save fails, THEN THE Save_Sequence SHALL end the undo group exactly once and return an error string to the client without invoking the Reduce_Operation, the Template_Save, or the Reopen.
2. IF the Protective_Save fails, THEN THE Save_Sequence SHALL leave the in-memory live project with the same comps, layers, and footage references it had before the Save_Sequence began, having applied no Reduce_Operation.
3. IF the Protective_Save fails, THEN THE Save_Sequence SHALL leave the originalFile on disk in its prior state, without overwriting it with a reduced or partial project.
4. WHEN the Reduce_Operation begins, THE Save_Sequence SHALL have already completed a successful Protective_Save of originalFile.

### Requirement 4: Reopen the user project exactly once

**User Story:** As a CompSaver user, I want my project reloaded exactly once after a reducing save,
so that I return to my working project without duplicate reloads.

#### Acceptance Criteria

1. WHEN the Save_Sequence completes a successful save, THE Save_Sequence SHALL invoke the Reopen of originalFile exactly once.
2. WHILE the Save_Sequence is inside the Destructive_Window, THE Save_Sequence SHALL guarantee that the Reopen of originalFile is invoked before returning on every return path, including successful returns and error returns.
3. WHEN the Save_Sequence invokes the Reopen of originalFile, THE Save_Sequence SHALL enable dialog suppression before the Reopen and disable dialog suppression after the Reopen so that no modal dialog blocks the Reopen.
4. THE Save_Sequence SHALL NOT invoke the Reopen of originalFile more than once across all return paths, including successful, error, and restore paths.
5. IF the Reopen of originalFile fails, THEN THE Save_Sequence SHALL return an error indicating that the reopen failed while leaving the on-disk snapshot of originalFile written by the Protective_Save intact.

### Requirement 5: No frame render in the blocking save path

**User Story:** As a CompSaver user, I want the blocking save to skip frame rendering, so that After
Effects does not freeze while saving a template.

#### Acceptance Criteria

1. THE Save_Sequence SHALL complete every execution path, including the successful path, all early-return guardrail paths, and all Destructive_Window restore paths, without invoking `saveFrameToPng` or `renderFrameToPng`.
2. WHEN the Template_Save writes targetFile to disk, THE Save_Sequence SHALL return the Return_Object without invoking any synchronous thumbnail or preview frame render in the blocking path.
3. IF any step of the Save_Sequence fails after the Reduce_Operation, THEN THE Save_Sequence SHALL return an error without invoking `saveFrameToPng` or `renderFrameToPng`.

### Requirement 6: Restore the user project on destructive-window failure

**User Story:** As a CompSaver user, I want my project restored from disk if a save step fails after
reduction, so that I never lose my project to a partial save.

#### Acceptance Criteria

1. IF the Reduce_Operation fails, THEN THE Save_Sequence SHALL end the undo group exactly once, enable suppressed dialogs before the Reopen of originalFile from disk and disable them after the Reopen, and return an error string indicating that the reduction failed and the project was restored from the Protective_Save snapshot.
2. IF the Template_Save fails after the Reduce_Operation, THEN THE Save_Sequence SHALL end the undo group exactly once, enable suppressed dialogs before the Reopen of originalFile from disk and disable them after the Reopen, and return an error string indicating that the template save failed and the project was restored from the Protective_Save snapshot.
3. WHILE the Save_Sequence is inside the Destructive_Window, THE Save_Sequence SHALL rely on the on-disk snapshot written by the Protective_Save as the source for restoring the user project.
4. IF the Reopen of originalFile fails while restoring the project during the Destructive_Window, THEN THE Save_Sequence SHALL return an error string indicating that automatic restore failed and instructing the user to manually reopen originalFile from disk.

### Requirement 7: Balanced undo group and dialog suppression

**User Story:** As a CompSaver maintainer, I want undo groups and dialog suppression balanced on
every path, so that After Effects state is not corrupted by unmatched calls.

#### Acceptance Criteria

1. WHEN the Save_Sequence opens an undo group, THE Save_Sequence SHALL end that undo group exactly once on every return path, including the successful path, early-return guardrail paths, and error or restore paths.
2. WHEN the Save_Sequence enables suppressed dialogs on a path, THE Save_Sequence SHALL disable suppressed dialogs exactly once on that same path before returning.
3. WHEN the Save_Sequence completes any execution path, THE Save_Sequence SHALL leave the count of opened undo groups equal to the count of ended undo groups and the count of enabled dialog-suppression calls equal to the count of disabled dialog-suppression calls.

### Requirement 8: Metadata collection timing

**User Story:** As a CompSaver user, I want the saved template metadata to reflect only the reduced
project, so that the asset list and layer state are accurate.

#### Acceptance Criteria

1. WHEN the Save_Sequence collects the assetsList, THE Save_Sequence SHALL collect it after the Reduce_Operation completes and before the Reopen of originalFile, so that the list contains only footage still referenced by the saved comp.
2. WHEN the Save_Sequence captures layerState for a single-layer save, THE Save_Sequence SHALL capture it before the Reduce_Operation and before the Reopen.
3. WHEN the reduced project references no external footage, THE Save_Sequence SHALL set the assetsList to an empty list rather than returning an error.
4. IF the assetsList collection fails after the Reduce_Operation, THEN THE Save_Sequence SHALL reopen originalFile from disk and return an error indicating that metadata collection failed, with the live project restored from the Protective_Save snapshot.

### Requirement 9: Hex-bridge return-shape contract

**User Story:** As a CompSaver client developer, I want the save return shape to stay compatible, so
that existing consumers keep working while the deferred thumbnail is signalled.

#### Acceptance Criteria

1. WHEN the Save_Sequence returns successfully, THE Return_Object SHALL include the boolean field `needsThumbnail` equal to true.
2. WHEN `saveActiveComp` returns successfully, THE Return_Object SHALL NOT include a `thumbnailPath` key.
3. WHEN the Save_Sequence returns successfully, THE Return_Object SHALL include the fields `folderPath`, `assetsList`, `templateId`, `name`, `category`, and `oldId` with the same names and values that the pre-deferral save produced, and SHALL include `layerCount`, `isAdjustment`, `is3D`, `blendMode`, `label`, and `layerState` with the same names and values for layer saves only.
4. WHEN the Save_Sequence returns successfully, THE Save_Sequence SHALL signal success via `ok === true` on the object path or the literal string `"true"` on the monolithic path.
5. IF the Save_Sequence fails, THEN THE Save_Sequence SHALL signal the failure by returning a non-empty error string that is distinguishable from the success signals defined in criterion 4.
6. IF the Return_Object omits `needsThumbnail`, THEN THE client SHALL treat the save as having no deferred thumbnail.

### Requirement 10: Deferred background thumbnail rendering

**User Story:** As a CompSaver user, I want the template thumbnail generated in the background after
saving, so that the panel becomes responsive immediately and the thumbnail appears when ready.

#### Acceptance Criteria

1. WHEN a successful Return_Object has `needsThumbnail` set to true, THE client SHALL schedule a Thumbnail_Job on the Background_Queue for the saved `project.aep` without blocking the panel UI thread.
2. WHEN the client schedules a Thumbnail_Job, THE panel SHALL accept further user input within 1000 milliseconds of receiving the Return_Object.
3. WHEN the Thumbnail_Renderer runs, THE Thumbnail_Renderer SHALL import the saved `project.aep` non-destructively without modifying, reopening, or reloading the user's live project.
4. WHEN the Thumbnail_Job completes successfully, THE client SHALL refresh only the template card for the saved `project.aep` so that the rendered `thumbnail.png` replaces the placeholder, using a cache-busting query so no stale cached image is displayed.
5. IF the Thumbnail_Job fails or does not complete within 60 seconds, THEN THE Background_Queue SHALL abandon that Thumbnail_Job, treat it as failed, and proceed to the next queued job.
6. IF the Thumbnail_Job fails, THEN THE client SHALL retain the placeholder, retry the Thumbnail_Job at most once during the current session, and mark the template so its thumbnail is regenerated on the next template load.
7. WHILE the Background_Queue holds queued or running jobs, THE Background_Queue SHALL run at most one of Thumbnail_Job and Preview_Job at a time and SHALL start queued jobs in first-in-first-out order so that their renders never overlap.

### Requirement 11: Preview rendering continuity

**User Story:** As a CompSaver user, I want the preview video to keep rendering after a save, so that
the redesign does not regress preview generation.

#### Acceptance Criteria

1. WHEN a template save returns a successful Return_Object, THE client SHALL enqueue exactly one Preview_Job on the Background_Queue for the saved `project.aep` through the existing background preview path.
2. WHEN the Preview_Job runs, THE Preview_Job SHALL import the saved `project.aep` without modifying the user's live project.
3. IF the Preview_Job fails, THEN THE client SHALL leave any existing preview unchanged, leave the user's live project unmodified, and allow the preview to be regenerated on a subsequent template load.

### Requirement 12: Deterministic path construction

**User Story:** As a CompSaver maintainer, I want template paths built by pure helpers, so that path
construction is deterministic and testable independent of After Effects.

#### Acceptance Criteria

1. WHEN a template folder path is requested, THE Path_Builder SHALL construct it as `root/section/safeCategory/templateId`, converting every backslash to a forward slash, collapsing each run of consecutive separators into a single forward slash, and removing any leading or trailing separator, producing byte-for-byte identical output for identical inputs.
2. WHEN an asset path is requested for a template folder, THE Path_Builder SHALL construct `folderPath/project.aep`, applying the same separator normalization defined in criterion 1.
3. WHEN a thumbnail path is requested for a template folder, THE Path_Builder SHALL construct `folderPath/thumbnail.png`, applying the same separator normalization defined in criterion 1.
4. WHEN a name containing spaces, unicode characters, or path separators is provided, THE Path_Builder SHALL produce a safe name and a template identifier in which every forward slash, backslash, and whitespace character is replaced with a single underscore, no path separator character (`/` or `\`) remains, and the result is truncated to a maximum of 255 characters.
5. IF the provided name is empty or reduces to zero characters after sanitization, THEN THE Path_Builder SHALL return a descriptive error indicating the name is invalid and SHALL NOT construct a path.

### Requirement 13: Save-input guardrails

**User Story:** As a CompSaver user, I want clear early errors when preconditions are not met, so
that the destructive save path only runs when it is safe.

#### Acceptance Criteria

1. IF no composition is active when a composition is required, THEN THE Save_Sequence SHALL return an error identifying that no composition is active, without opening an undo group and leaving the live project unmodified.
2. IF no layer is selected when a layer save is required, THEN THE Save_Sequence SHALL return an error identifying that no layer is selected, without opening an undo group and leaving the live project unmodified.
3. IF the project has never been saved and originalFile is absent, THEN THE Save_Sequence SHALL return an error instructing the user to save the project first, without invoking the Reduce_Operation and leaving the live project unmodified.
4. IF the temp comp creation or layer copy fails before the Reduce_Operation, THEN THE Save_Sequence SHALL remove the temp comp, end the undo group exactly once, and return an error identifying the failure with the live project intact.
