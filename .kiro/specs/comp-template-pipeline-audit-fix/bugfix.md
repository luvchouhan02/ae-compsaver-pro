# Bugfix Requirements Document

## Introduction

This bugfix covers a full audit of the **Comp / Composition Template Pipeline** in the CompSaver Adobe CEP + ExtendScript extension: the save path (`jsx/templates_save.jsx` → `saveActiveComp`, `resolveCompForSave`, `coreSaveLayerType`), the import path (`jsx/import.jsx` → `importCompDirect`, `resolveTemplateFiles`, `placeLayerAtPlayhead`, `importBatch`), the shared host utilities (`jsx/core.jsx`, `jsx/helpers.jsx`), the hex transport (`js/core/bridge.js`), and the panel orchestration (`js/templates/templates.js`, `js/core/saveController.js`, `js/core/importEngine.js`).

Every clause below was derived by reading the current source, not from assumption. The defects fall into four groups:

- **Save correctness** — a comp save that fully succeeds on disk is reported to the user as a failure, because the result object dereferences After Effects item references that `app.open()` has already invalidated. A failed project reopen on the success path is swallowed and still reported as success, leaving the user's session pointed at the library's `project.aep`.
- **Selection resolution** — `resolveCompForSave` and `getStrictSaveType` disagree about which composition a "Comp" save targets, so the panel can advertise a save that the engine refuses, or silently save a different composition than the one the UI named.
- **Transport & contract integrity** — `itemExists` returns a folder name where the panel compares against `"true"`, so overwrite confirmation and old-folder cleanup are dead code; `decodeBridge` corrupts malformed payloads differently on each side of the Bridge; `escapeJSON` can emit invalid JSON; the import call path has no timeout.
- **Import hygiene** — imported items leak on failure outside `importBatch`, every import creates a fresh top-level Project-panel folder instead of one dedicated assets folder, and layer placement re-locates the anchor layer by *name* instead of by reference.

The user impact ranges from "saved template shows an error toast and never gets a thumbnail or `meta.json`" through "the next Ctrl+S overwrites a library template with the user's project" to accumulating Project-panel clutter on every import.

The fix must eliminate each condition below **without changing any behavior listed in section 3**, most importantly the reduce-first destructive-window protocol, the single-reopen invariant, the single-undo-group batch envelope, and the cache-first metadata reads.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a comp save completes successfully and `saveActiveComp` builds its result object AFTER `app.open(originalFile)` has reopened the project THEN the system dereferences the now-invalid `precomp` item reference at `jsx/templates_save.jsx:967-968` (`renderComp: precomp.name`, `renderFrame: ... precomp.workAreaStart ...`), throws, lands in the `windowEntered` branch of the outer catch, performs a second `app.open`, and returns an `"Error: ... Exception: ..."` string — so a template whose `project.aep` was written correctly is reported to the user as a failed save, no `meta.json` is written, no optimistic card survives, and no thumbnail job is enqueued.

1.2 WHEN `coreSaveLayerType` builds its success result after the same reopen THEN the system dereferences the stale `comp` reference at `jsx/templates_save.jsx:767-768` and fails identically, despite the file itself documenting at `jsx/templates_save.jsx:648-649` that the reopen "invalidates refs".

1.3 WHEN a composition is open in the viewer, no layers are selected in it, and nothing is selected in the Project panel THEN `getStrictSaveType` reports `type:"comp"` with the message "Active composition will be saved" (`jsx/core.jsx:886`) and `validateSaveRequest` therefore returns `"true"`, but `resolveCompForSave` falls through every branch and returns `{ok:false, error:"Select a precomposition first."}` (`jsx/core.jsx:1005`) — the panel enables a save the engine refuses.

1.4 WHEN the Project panel selection contains exactly one composition together with at least one non-composition item and a different composition is open in the viewer THEN `getStrictSaveType` skips both selection branches and falls through to `jsx/core.jsx:886` announcing the ACTIVE comp, while `resolveCompForSave` (`jsx/core.jsx:990-1000`) returns the Project-panel composition — the system saves a different composition than the one the UI named, under the user-supplied name.

1.5 WHEN the destructive window has completed, the template `project.aep` has been written, and `app.open(originalFile)` then fails THEN the system swallows the exception at `jsx/templates_save.jsx:946-950` (and identically at `jsx/templates_save.jsx:750`), records it only in the internal `logMsg`, and returns `ok:true` — leaving the live After Effects session pointed at the library template's `project.aep` (because `app.project.save(targetFile)` reassigned `app.project.file`), so the user's next save overwrites the template with their own project.

1.6 WHEN the library root path resolved from `savePath || rootPath` is empty, relative, or otherwise not an absolute path THEN `saveActiveComp` builds `targetFolderPath` as `"/comp/<cat>/<id>"` (`jsx/templates_save.jsx:830`) and `ensureDeepFolder` (`jsx/core.jsx:458-473`) creates that tree at the filesystem/drive root with no validation, writing the template outside the library.

1.7 WHEN `ensureDeepFolder` cannot create an intermediate folder THEN the system ignores the boolean returned by `cf.create()` and returns `new Folder(pathStr)` regardless (`jsx/core.jsx:464-470`); `coreSaveLayerType` does not check `f.exists` at `jsx/templates_save.jsx:660`, so the destructive `reduceProject` window is entered with no valid target folder and the failure only surfaces after the in-memory project has been destroyed.

1.8 WHEN the template name sanitizes to `"."`, `".."`, or a name ending in a dot or space THEN `getSafeName` (`jsx/core.jsx:74-78`) returns it unchanged — it only replaces `\ / : * ? " < > |` — so `<root>/comp/<cat>/.` resolves to the category folder and `<root>/comp/<cat>/..` resolves to the section folder, and `project.aep` plus `meta.json` are written outside any template folder, corrupting the library scan.

1.9 WHEN a comp template is saved THEN the `meta.json` written by the panel (`js/templates/templates.js:3298-3345`) records only `schemaVersion, id, name, section, type, category, mainFile, thumbnail, hasFrames, frameCount, createdAt, updatedAt` — it omits `width`, `height`, `pixelAspect`, `frameRate` and `duration` entirely, so `parseMetaContent`'s `dim` field (`jsx/core.jsx:...`) is always empty and no consumer can know the composition's format.

1.10 WHEN a comp template is saved THEN `saveActiveComp`'s result object (`jsx/templates_save.jsx:956-969`) omits the `section` and `type` fields, so the panel's `if (resObj.section === "comp")` guard at `js/templates/templates.js:3335` never fires and `assetsDir` is never recorded in `meta.json` even when assets were copied.

1.11 WHEN the isolated `aerender` path is unavailable and the thumbnail falls back in-project THEN `renderTemplateThumbnail(aepPathHex, outPngPathHex)` (`jsx/templates_save.jsx:358`) accepts only two arguments and `js/textanim/textanim.js:1335-1338` passes only those two — the `renderComp` and `renderFrame` values the save engine computed are discarded, and the PNG is rendered at `workAreaStart + workAreaDuration * 0.3` of whatever composition `findCompItemInFolder` happens to return first, not at the recorded comp frame.

1.12 WHEN `renderFrameToPng` renders a frame THEN it assigns `comp.time = time` (`jsx/helpers.jsx:132-134`) and never restores the previous value, so any code path that renders from a live composition (e.g. `generateActiveFrameThumbnail`, `jsx/templates_save.jsx:298`) permanently moves the user's playhead.

1.13 WHEN the panel checks for an existing template before saving THEN `itemExists` returns the matched folder's NAME on a hit (`jsx/import.jsx:2113`) while `js/templates/templates.js:3172` evaluates `decodeBridge(existsHex) === "true"` — the comparison is therefore always false, so the `library.confirmOverwrite` prompt never appears, `oldId` is always `""` (`js/templates/templates.js:3185`), and the `.fav` preservation plus old-folder removal in the background finalizer is unreachable dead code.

1.14 WHEN the panel calls `itemExists` THEN it passes only three arguments (`js/templates/templates.js:3170`), so `sHex` is undefined and the host defaults `section` to `"comp"` (`jsx/import.jsx:2093-2096`) — the existence check for a layer/text/footage/effect save inspects the `comp` section instead of the section actually being saved.

1.15 WHEN a hex payload reaches `decodeBridge` with a length that is not a multiple of four, or with a non-hex chunk THEN the panel implementation (`js/core/bridge.js:23-30`) produces `String.fromCharCode(NaN)` — a U+0000 — while the host implementation (`jsx/core.jsx:32-43`) silently skips the chunk; neither validates the length nor reports an error, so a truncated or corrupted transfer is decoded into silently different strings on the two sides and a `"true"` comparison fails on an operation that actually succeeded.

1.16 WHEN a string containing a control character other than newline reaches `escapeJSON` THEN the system emits it raw and deletes `\r` outright (`jsx/core.jsx:80-88`), so `jsonStringify` can produce a document that `JSON.parse` rejects on the panel side — a completed save is then surfaced as `"JSON Parse Error"` (`js/templates/templates.js:3223`).

1.17 WHEN a card is imported THEN `importCurrentCardToTimeline` supplies a transport that calls `csInterface.evalScript` directly (`js/templates/templates.js:2412-2415`), bypassing the timeout-guarded `callHost` used by the save path — so a host call that never returns leaves the card stuck with the `.importing` class, no toast, and no way to retry, and the CEP `"EvalScript error."` sentinel is fed to `decodeBridge` as if it were hex.

1.18 WHEN `importCompDirect` is invoked outside `importBatch` (via `importTemplate` or a direct call) and fails after `app.project.importFile` has already run THEN the early returns at `jsx/import.jsx:1489` ("Import failed!"), `1585` ("No comp found!") and `1589` ("Cannot create recursive nesting!") return without removing `allImportedItems` — only the `1604` path cleans up — so the imported composition, footage and folders are left in the user's project. `importLayerTypeAep` leaks identically at `jsx/import.jsx:1011`.

1.19 WHEN a comp template is imported THEN `toolkitOrganizeTemplateImport` (`jsx/import.jsx:877-935`) creates a new top-level Project-panel folder named after the imported composition rather than one dedicated `_CompSaver_Assets` folder; because `safeRenameAllImportedItems` has already made the composition's name unique against every existing item name (folders included), the "find existing folder" branch at `jsx/import.jsx:884-891` can never match, so every single import adds another root-level folder (`Name`, `Name 2`, `Name 3`, …).

1.20 WHEN an imported template contains only solid-source footage THEN `needsAssets` stays false (`jsx/import.jsx:900-914`) and the `assetsToMove` block is skipped, so the `FolderItem` that `importFile` created for the `.aep` is neither reparented nor removed and remains as an empty folder at the Project-panel root.

1.21 WHEN `placeLayerAtPlayhead` positions the imported layer relative to the anchor THEN it discards the still-valid `anchorLayer` reference and re-locates the anchor by NAME (`jsx/templates_save.jsx:19-31`), so whenever two or more layers in the active composition share the anchor's name the imported layer is moved above the wrong layer.

1.22 WHEN `placeLayerAtPlayhead` finishes THEN it calls `deselectAllLayers(activeComp)` and selects only the new layer (`jsx/templates_save.jsx:34-35`), destroying the user's existing selection; inside `importBatch` this means template *n* anchors to the layer template *n-1* just inserted rather than to the layer the user originally selected.

1.23 WHEN `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)` are used around the destructive window and around `importFile` THEN they are written as bare sequential statements rather than `try/finally` (`jsx/templates_save.jsx:944-950`, `jsx/templates_save.jsx:660-676` restore handler, `jsx/import.jsx:1452-1465`, `jsx/import.jsx:997-1010`), so a throw between the two calls leaves After Effects with dialog suppression stuck on for the remainder of the session.

1.24 WHEN `app.beginUndoGroup("CompSaver Import")` throws inside `importBatch` THEN `__CS_IMPORT_BATCH_ACTIVE` has already been set to true at `jsx/import.jsx:566`, so every reused per-section routine treats its own `csBeginUndoGroup` as a no-op and the entire batch of DOM mutations runs with NO undo group at all — the user cannot undo the import.

1.25 WHEN `resolveTemplateFiles` cannot find the `mainFile` named in `meta.json` and falls back to `folder.getFiles("*.aep")` (`jsx/core.jsx:354-360`) THEN it takes `aepFiles[0]` from an enumeration whose order is unspecified, so a template folder holding more than one `.aep` resolves non-deterministically; the same call also bypasses the once-per-import `csEnumerateFolderOnce` memoization used everywhere else in the import path.

1.26 WHEN the panel derives a template folder path itself — the monolithic and PNG save branches at `js/templates/templates.js:3423-3436` and the optimistic card at `js/templates/templates.js:3477-3489` — THEN it uses `getSafeName` from `js/core/utils.js:20-24`, which does not apply `cleanStr`, while the host derives the same path as `generateTemplateId(cleanStr(name))` (`jsx/templates_save.jsx:818-830`); for any name containing a tab or a run of consecutive spaces the two paths differ, so the optimistic card and the metadata-cache key point at a folder that does not exist.

1.27 WHEN the property tests exercise `js/core/pathBuilders.js` THEN they validate a `getSafeName`/`generateTemplateId` pair that returns `{ok, value}` objects and replaces whitespace with underscores (`js/core/pathBuilders.js:44-78`), but that module is absent from the panel's script list (`index.html:1576-1614`), so the rules under test are not the rules the running panel applies — a divergence that lets path-safety regressions pass CI.

### Expected Behavior (Correct)

2.1 WHEN a comp save completes successfully THEN the system SHALL capture `renderComp` and `renderFrame` from the composition BEFORE `app.open(originalFile)` invalidates the reference, and SHALL return the success payload without dereferencing any post-reopen item reference.

2.2 WHEN `coreSaveLayerType` completes successfully THEN the system SHALL capture every value derived from the source composition before the reopen, matching the pattern already used for `layerState`, and SHALL return the success result unaffected by reference invalidation.

2.3 WHEN a composition is open in the viewer, no layers are selected in it, and nothing is selected in the Project panel THEN `resolveCompForSave` SHALL resolve the active composition, matching the capability `getStrictSaveType` advertises, so that a save the panel enables always executes.

2.4 WHEN the Project panel selection contains one composition alongside non-composition items THEN `getStrictSaveType` and `resolveCompForSave` SHALL resolve the SAME composition and the message shown to the user SHALL name that composition, so the system never saves a composition other than the one the UI announced.

2.5 WHEN `app.open(originalFile)` fails after the destructive window THEN the system SHALL report the save as failed (or as succeeded-with-restore-failure), SHALL state that the live session is no longer pointed at the user's project, and SHALL NOT return `ok:true`.

2.6 WHEN the resolved library root path is empty, relative, or not absolute THEN the system SHALL reject the save with an explicit error before any folder is created and before the destructive window is entered.

2.7 WHEN `ensureDeepFolder` cannot create the target tree THEN it SHALL report the failure to its caller, and every save path SHALL verify the target folder exists before entering the destructive window.

2.8 WHEN a template name sanitizes to `"."`, `".."`, an empty string, or a name ending in a dot or space THEN `getSafeName` SHALL produce a filesystem-safe, non-traversing folder name so that the template's files are always written inside their own template folder.

2.9 WHEN a comp template is saved THEN `meta.json` SHALL record `width`, `height`, `pixelAspect`, `frameRate`, `duration`, `mainFile` and the schema version, so consumers can present the composition's format without opening the `.aep`.

2.10 WHEN a comp template is saved THEN the host result SHALL carry `section` and `type`, and `meta.json` SHALL record `assetsDir` whenever assets were copied.

2.11 WHEN the thumbnail falls back to the in-project renderer THEN the system SHALL render the composition named by `renderComp` at the frame given by `renderFrame`, producing the same frame the isolated `aerender` path would produce.

2.12 WHEN `renderFrameToPng` changes `comp.time` to focus a frame THEN it SHALL restore the composition's previous time before returning, on both the success and failure paths.

2.13 WHEN the panel checks whether a template already exists THEN the host and panel SHALL agree on one return contract, the overwrite prompt SHALL appear when `library.confirmOverwrite` is enabled and a match exists, and `oldId` SHALL be populated so `.fav` preservation and old-folder removal actually run.

2.14 WHEN the panel checks whether a template already exists THEN it SHALL pass the section being saved, and the host SHALL search that section rather than defaulting to `comp`.

2.15 WHEN a hex payload is malformed or truncated THEN both `decodeBridge` implementations SHALL behave identically and SHALL surface a decode failure to the caller rather than silently producing a corrupted string.

2.16 WHEN a string containing control characters is serialized THEN `escapeJSON` SHALL emit valid JSON escapes (including `\r`, `\t` and `\u00XX` for other control characters) so the panel can always parse a host success payload.

2.17 WHEN a card is imported THEN the call SHALL go through the timeout-guarded transport, the `.importing` state SHALL always be cleared, the CEP error sentinels SHALL be recognized as errors rather than decoded as hex, and the user SHALL receive a definite success or failure indication.

2.18 WHEN `importCompDirect` or `importLayerTypeAep` fails after `app.project.importFile` has run — whether inside `importBatch` or standalone — THEN the system SHALL remove every item that import added, leaving the project exactly as it was before the attempt.

2.19 WHEN a comp template is imported THEN its items SHALL be grouped under a single dedicated Project-panel folder (`_CompSaver_Assets`) that is reused across imports, so repeated imports do not accumulate root-level folders.

2.20 WHEN an imported template contains only solid-source footage THEN the leftover `FolderItem` created by `importFile` SHALL be removed or reparented, leaving no empty folder at the Project-panel root.

2.21 WHEN `placeLayerAtPlayhead` positions the imported layer THEN it SHALL use the live `anchorLayer` reference so the layer lands directly above the layer the user actually selected, even when layer names are duplicated.

2.22 WHEN `placeLayerAtPlayhead` finishes THEN the anchor used for each template in a batch SHALL be the layer the user selected before the action began, and the user's original selection SHALL be restorable rather than silently discarded.

2.23 WHEN dialog suppression is enabled around a destructive or import operation THEN `app.endSuppressDialogs(false)` SHALL be guaranteed by `try/finally` on every path, so suppression can never remain stuck on.

2.24 WHEN `app.beginUndoGroup` fails at the start of `importBatch` THEN the system SHALL either abort the batch or let the per-section routines open their own undo groups, so the user always retains a working undo for the import.

2.25 WHEN `resolveTemplateFiles` falls back to searching for an `.aep` THEN the selection SHALL be deterministic (a documented precedence rather than enumeration order) and SHALL reuse the once-per-import folder enumeration.

2.26 WHEN the panel derives a template folder path itself THEN it SHALL apply the identical sanitization the host applies, so panel-derived and host-derived paths are always the same string.

2.27 WHEN path-safety rules are covered by tests THEN the tested implementation SHALL be the implementation the panel loads at runtime, so a single canonical sanitizer governs both.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the protective save (`app.project.save(originalFile)`) fails THEN the system SHALL CONTINUE TO abort before any destructive operation, end the undo group exactly once, and leave the live project untouched in memory and on disk.

3.2 WHEN a save fails BEFORE `reduceProject` succeeds THEN the system SHALL CONTINUE TO skip the project reopen entirely, preserving the user's in-memory project and undo context.

3.3 WHEN a save fails AFTER `reduceProject` succeeds THEN the system SHALL CONTINUE TO perform exactly ONE reopen of the original project from the protective-save snapshot and SHALL CONTINUE TO tell the user to reopen manually when that restore fails.

3.4 WHEN a comp template is saved THEN the system SHALL CONTINUE TO execute the reduce-first ordering — protective save, rename, `reduceProject([precomp])`, one `app.project.save(targetFile)` — with no additional destructive project writes.

3.5 WHEN the project has never been saved (`app.project.file` is null) THEN the system SHALL CONTINUE TO refuse the save with "Please save your project first!" before touching the project.

3.6 WHEN text containing non-English, accented, CJK, or non-BMP (surrogate-pair) characters is passed through `encodeBridge`/`decodeBridge` THEN the system SHALL CONTINUE TO round-trip it byte-for-byte identically in both the panel and host implementations.

3.7 WHEN a long JSON payload (a full library scan or a 500-template import batch) crosses the Bridge THEN the system SHALL CONTINUE TO transport it without truncation.

3.8 WHEN `importBatch` runs THEN the system SHALL CONTINUE TO perform the entire action in ONE host execution inside ONE undo group, with `endUndoGroup` guaranteed by `try/finally` on the success, per-template-failure, and thrown-error paths, and SHALL CONTINUE TO leave `csBeginUndoGroup`/`csEndUndoGroup` as no-ops in the reused per-section routines while the batch is active.

3.9 WHEN `importCompDirect` is called on its own THEN the system SHALL CONTINUE TO open and close its own undo group in `try/finally` so no undo group leaks.

3.10 WHEN one template in a batch fails THEN `csRollbackToSnapshot` SHALL CONTINUE TO remove only the layers and project items that template's import added, and SHALL CONTINUE TO leave every pre-existing layer, item and successfully imported template untouched.

3.11 WHEN `importBatch` returns THEN the result SHALL CONTINUE TO be total over the requested templates — exactly one `perTemplate` entry per input template, in input order — including on a whole-call decode failure or a catastrophic mid-batch error.

3.12 WHEN a template's metadata is already seeded from the `Metadata_Cache` THEN the import SHALL CONTINUE TO serve it with zero disk reads, and on a cache miss SHALL CONTINUE TO read and parse `meta.json` at most once per import and reuse that parse for the remainder of the import.

3.13 WHEN a required file read or asset-folder enumeration fails during an import THEN the system SHALL CONTINUE TO stop that import and return an error naming the offending file or folder.

3.14 WHEN `meta.json` is missing or unparseable THEN `resolveTemplateFiles` SHALL CONTINUE TO fall back to `project.aep`, then `*.aep`, then `*.cseffect`, then the image fallbacks, and `getAllTemplates` SHALL CONTINUE TO emit a degraded record and return every other template it scanned rather than emptying the library.

3.15 WHEN `app.project.importFile` runs during an import THEN the system SHALL CONTINUE TO wrap it in `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)` so no modal dialog interrupts the import.

3.16 WHEN a Utility Pre-Comp template is imported THEN the system SHALL CONTINUE TO place the original pre-composition as a single reference layer (never flattened), remove the leftover wrapper comps, and re-apply the saved `layerState` switches and markers.

3.17 WHEN an imported layer has a trimmed in-point THEN `placeLayerAtPlayhead` SHALL CONTINUE TO align it so the trimmed in-point lands on the playhead time captured before the import.

3.18 WHEN a multi-layer template is imported THEN the system SHALL CONTINUE TO shift every new layer by one uniform delta derived from the top layer, preserving the layers' relative timing.

3.19 WHEN imported footage can be relinked from the template's `assets` folder THEN the system SHALL CONTINUE TO try the exact decoded name, then the raw name, then a case-insensitive match, then an extension-agnostic match before giving up.

3.20 WHEN imported comps or folders collide with existing project item names THEN `csResolveName` SHALL CONTINUE TO be the single deterministic resolver, producing identical output for identical input, and the existing-name set SHALL CONTINUE TO be computed once per import.

3.21 WHEN a save's essential host call settles THEN `runSaveController` SHALL CONTINUE TO exit the loading state exactly once before scheduling any background work, and SHALL CONTINUE TO schedule no background work on essential failure.

3.22 WHEN a unit of background work (thumbnail render, preview render, asset finalization) fails after a successful essential save THEN the system SHALL CONTINUE TO retain the essential result, surface an error identifying the failed unit, and never re-enter the blocking loading state.

3.23 WHEN a template is saved or re-saved THEN `renderOptimisticCard` SHALL CONTINUE TO insert the card at the head of the Library_Index and `allTemplates`, replacing any prior entry for the same `folderPath` in place so re-saving never duplicates a card, and SHALL CONTINUE TO re-render from memory without triggering a library scan.

3.24 WHEN a thumbnail render fails after its retries THEN the system SHALL CONTINUE TO retain the placeholder artwork and the Library_Index entry, mark the entry for regeneration, and add the failure badge to only the affected card.

3.25 WHEN the isolated `aerender` path is available and a comp name is known THEN the system SHALL CONTINUE TO prefer it over the in-project renderer and SHALL CONTINUE TO fall back in-project on any aerender failure.

3.26 WHEN a thumbnail render produces a missing, empty, or sub-64-byte PNG THEN the system SHALL CONTINUE TO classify it as a failure rather than a false success.

3.27 WHEN `renderTemplateThumbnail` runs against the live session THEN it SHALL CONTINUE TO be non-destructive: never touching `app.project.file`, never calling `app.open`, never reducing the live project, and always removing its scratch import and wrapper comp and restoring `bitsPerChannel`.

3.28 WHEN `meta.json`, an effect file, or a batch payload is parsed on the host THEN the system SHALL CONTINUE TO use the strict `jsonParse` recursive-descent parser with no code execution, and every caller SHALL CONTINUE TO keep its existing fallback on a parse failure.

3.29 WHEN `getAllTemplates` scans a library THEN it SHALL CONTINUE TO run the one-time migration guard per engine session, honour the section filter, and preserve the measured string-append encoding in `encodeBridge`/`decodeBridge` rather than reverting to array + `join`.

3.30 WHEN the library is scanned at startup THEN the system SHALL CONTINUE TO issue one section-chunked scan per root, and SHALL CONTINUE TO treat a missing or unparseable host response as an incomplete set rather than an empty library.
---

# Comp / Composition Template Pipeline Bugfix Design

## Overview

The 27 defects in section 1 are not 27 independent bugs. They collapse into **eleven root causes**, each of which is fixed once, in one place:

| # | Root cause | Conditions | Fix |
|---|---|---|---|
| R1 | Item references dereferenced after `app.open()` invalidated them; a failed reopen reported as success | 1.1, 1.2, 1.5 | F1, F2 |
| R2 | Two independent selection resolvers (`getStrictSaveType`, `resolveCompForSave`) walking the same inputs with different rules | 1.3, 1.4 | F3 |
| R3 | An unvalidated library root used as a path prefix, and `ensureDeepFolder` swallowing creation failure | 1.6, 1.7 | F4 |
| R4 | Three different "make this name filesystem-safe" implementations, one of which is not loaded at runtime | 1.8, 1.26, 1.27 | F5 |
| R5 | The save result and `meta.json` drop the composition's format; the thumbnail fallback ignores the recorded target; `renderFrameToPng` moves the playhead | 1.9, 1.10, 1.11, 1.12 | F6 |
| R6 | `itemExists` returns a folder name where the panel tests for `"true"`, and the panel omits the section argument | 1.13, 1.14 | F7 |
| R7 | Transport primitives that corrupt rather than report: divergent `decodeBridge`, invalid-JSON `escapeJSON`, untimed import transport | 1.15, 1.16, 1.17 | F8 |
| R8 | Import cleanup written at exit points instead of owned by scope exit; per-comp Project-panel folders that can never be found again | 1.18, 1.19, 1.20 | F9 |
| R9 | Anchor re-located by name instead of by reference; the anchor for template *n* is the layer template *n-1* inserted | 1.21, 1.22 | F10 |
| R10 | `beginSuppressDialogs`/`beginUndoGroup` paired as sequential statements rather than `try/finally`, and the batch guard set before its group exists | 1.23, 1.24 | F11 |
| R11 | `folder.getFiles("*.aep")[0]` — selection from an unspecified enumeration order | 1.25 | F12 |

The strategy is *narrow the contract, widen the guard*: every fix either (a) captures a value while the reference that produces it is still valid, (b) collapses two divergent implementations into one canonical implementation used by both sides, or (c) converts a silent failure into a reported one. No fix changes the reduce-first destructive ordering, the single-reopen invariant, the single-undo-group batch envelope, or the cache-first metadata reads — the regression clauses those describe are re-verified fix by fix in the section 5 analysis and in the preservation tests in section 8.

## Glossary

- **Bug_Condition (C)** — the condition that triggers the bug: an input to the comp/template pipeline that reaches one of the eleven defective mechanisms above. Formalized as `isBugCondition` below.
- **Property (P)** — the desired behavior for a buggy input: the save/import completes and is *reported* as it actually happened, with no reference dereferenced after invalidation, no path escaping the library, no item leaked, and no suppression or undo group left open.
- **Preservation** — everything section 3 enumerates: the protective-save abort, the reduce-first ordering, the single-reopen invariant, hex round-trip fidelity, the single-undo-group batch envelope, snapshot rollback scoping, batch result totality, and cache-first metadata reads.
- **Destructive window** — the interval between `app.project.reduceProject([...])` succeeding and the single `app.open(originalFile)` completing. Inside it the in-memory project is not the user's project. Tracked by the `windowEntered` latch (`jsx/templates_save.jsx:558`, `:805`).
- **Reference invalidation** — `app.open()` replaces the entire project DOM; every `Item`, `CompItem`, `FootageItem` and `Layer` reference held across it becomes invalid, and *reading any property of one throws*. The file already documents this at `jsx/templates_save.jsx:647`.
- **`saveActiveComp`** (`jsx/templates_save.jsx:800`) — the Comp-section save engine. Returns `encodeBridge(jsonStringify(resultObj))` on success, `encodeBridge("Error: …")` on failure.
- **`coreSaveLayerType`** (`jsx/templates_save.jsx:553`) — the shared save engine for the layer/text/footage/text_props sections. Returns a result **object** on success and a plain **string** on failure.
- **`resolveCompForSave`** (`jsx/core.jsx:976`) — resolves which composition a Comp save targets. **`getStrictSaveType`** (`jsx/core.jsx:798`) — decides what the panel offers to save and what message it shows.
- **`importBatch`** (`jsx/import.jsx:505`) — the single-Bridge_Call, single-undo-group batch envelope. **`__CS_IMPORT_BATCH_ACTIVE`** (`jsx/import.jsx:25`) — the latch that makes the reused per-section routines' `csBeginUndoGroup`/`csEndUndoGroup` no-ops while the batch owns the one group.
- **`allImportedItems`** — the flat list of every project item one `app.project.importFile` call added, built by the folder-tree walk at `jsx/import.jsx:1466-1485` (and `:989-1006`).
- **Bridge** — the hex-pair transport. `encodeBridge`/`decodeBridge` exist twice, once per side (`js/core/bridge.js:11,23` and `jsx/core.jsx:17,32`), and must stay behaviorally identical.

## Bug Details

### Bug Condition

The bug manifests when a comp/template pipeline operation crosses one of eleven boundaries where the code's assumption and the runtime's behavior differ: an item reference is read after `app.open()` invalidated it; two resolvers are asked the same question; a path prefix is trusted without being validated; a name is sanitized by whichever of three implementations happens to be in scope; a value the engine computed is never carried to the consumer that needs it; a return contract is read as `"true"` but written as a folder name; a malformed payload is decoded instead of rejected; a failure path exits without undoing what the success path set up; an anchor is looked up by an ambiguous key; a `begin*` has no guaranteed `end*`; or a file is chosen from an unspecified enumeration order.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type PipelineOperation
         { kind        : "save" | "import" | "exists" | "thumbnail" | "transport" | "path",
           selection   : SelectionState,      // viewer comp, timeline layers, project-panel items
           libraryRoot : String,
           name        : String,
           section     : String,
           payloadHex  : String,
           folder      : TemplateFolder,
           project     : ProjectState }
  OUTPUT: boolean

  RETURN
    // R1 — a value derived from a project item is read after the reopen
    (input.kind = "save"
      AND reduceProjectSucceeded(input)
      AND resultBuiltAfter(appOpen(input))
      AND resultReads(staleItemReference))

    OR (input.kind = "save" AND reduceProjectSucceeded(input)
         AND appOpenThrew(input) AND reportedOk(input))

    // R2 — the two resolvers disagree
    OR (input.kind = "save" AND input.section = "comp"
         AND getStrictSaveType(input.selection).type = "comp"
         AND resolveCompForSave(input.selection) <> announcedComp(input.selection))

    // R3 — the target path is not provably inside the library
    OR (input.kind = "save"
         AND (NOT isAbsolutePath(input.libraryRoot)
              OR NOT targetFolderExists(input) BEFORE destructiveWindow(input)))

    // R4 — the name sanitizes to a traversing / reserved / empty folder name,
    //      or two sides of the product sanitize it differently
    OR (input.kind IN {"save","path"}
         AND (sanitize(input.name) IN {".", "..", ""}
              OR endsWithDotOrSpace(sanitize(input.name))
              OR hostSanitize(input.name) <> panelSanitize(input.name)))

    // R5 — a value the engine computed never reaches its consumer,
    //      or a render mutates state it does not own
    OR (input.kind IN {"save","thumbnail"}
         AND (metaOmits(input, {width,height,pixelAspect,frameRate,duration,section,type,assetsDir})
              OR renderedFrame(input) <> recordedRenderFrame(input)
              OR compTimeMutatedWithoutRestore(input)))

    // R6/R7 — the two sides of a contract disagree, or a malformed
    //          payload is decoded instead of rejected
    OR (input.kind IN {"exists","transport"}
         AND (hostReturnShape(input) <> panelExpectedShape(input)
              OR argumentOmitted(input)
              OR (NOT isWellFormedBridgeHex(input.payloadHex)
                  AND panelDecode(input.payloadHex) <> hostDecode(input.payloadHex))
              OR NOT isValidJSON(jsonStringify(input))
              OR NOT timeoutGuarded(input)))

    // R8/R9/R10/R11 — import hygiene, placement, balance, determinism
    OR (input.kind = "import"
         AND (importFileRan(input) AND failedAfter(input) AND itemsRemain(input)
              OR createsNewRootFolderPerImport(input)
              OR leavesEmptyFolderAtRoot(input)
              OR anchorResolvedByName(input) AND duplicateLayerNames(input.project)
              OR anchorIs(previousTemplatesLayer, input)
              OR suppressionOrUndoUnbalancedOnThrow(input)
              OR NOT deterministic(resolveTemplateFiles(input.folder))))
END FUNCTION
```

### Examples

- **1.1** Select a pre-comp layer, save it to the Comp section. `project.aep`, the folder and the assets are written correctly; then `resultObj.renderComp = precomp.name` (`jsx/templates_save.jsx:967`) throws on the invalidated reference, the outer catch takes the `windowEntered` branch, performs a **second** `app.open`, and returns `"Error: [start] … -> Exception: …"`. Expected: a success payload. Actual: an error toast, no `meta.json`, no card, no thumbnail job — for a template that is complete on disk.
- **1.2** Same for a Layer/Text/Footage save: `renderFrame` at `jsx/templates_save.jsx:768` reads `comp.workAreaStart`, `comp.workAreaDuration` and `comp.frameRate` from the source comp that the reduce removed and the reopen invalidated.
- **1.5** The template saves, then `app.open(originalFile)` fails (file locked, moved, permission). `jsx/templates_save.jsx:946-950` catches it, appends one line to `logMsg`, and returns `ok:true`. Because `app.project.save(targetFile)` re-pointed `app.project.file` at the library, the user's next Ctrl+S overwrites the template with their project. Expected: a reported failure that names the state of the session.
- **1.3** A comp is open in the viewer, nothing selected in it, nothing selected in the Project panel. Panel: Save enabled, "Active composition will be saved" (`jsx/core.jsx:886`). Engine: `"Select a precomposition first."` (`jsx/core.jsx:1005`). Expected: the save the panel enabled runs.
- **1.4** Project panel selection = {`Comp A`, `logo.png`}; `Comp B` open in the viewer. `getStrictSaveType` requires `nonCompSelected === 0`, so it falls through and announces **Comp B**; `resolveCompForSave` counts only comps and returns **Comp A**. The user names the template after B and gets A's content.
- **1.6** `savePath || rootPath` resolves to `""`. `targetFolderPath` becomes `"/comp/Titles/My Title"` (`jsx/templates_save.jsx:830`) and `ensureDeepFolder` creates that tree at the drive root — outside the library, invisible to every scan. Expected: rejected before any folder is created.
- **1.7** `ensureDeepFolder` cannot create an intermediate folder (read-only volume). It ignores `cf.create()`'s boolean and returns `new Folder(pathStr)` anyway (`jsx/core.jsx:464-470`); `coreSaveLayerType` never checks `f.exists` (`jsx/templates_save.jsx:653`), so the destructive `reduceProject` runs and the failure surfaces only after the in-memory project is gone.
- **1.8** Template named `".."`. `getSafeName` (`jsx/core.jsx:74-78`) only replaces `\ / : * ? " < > |`, so the folder path resolves to the **section** folder and `project.aep` + `meta.json` land there, corrupting the library scan for every category.
- **1.9** A 1920×1080 / 25 fps comp is saved. `meta.json` records no `width`, `height`, `pixelAspect`, `frameRate` or `duration`, and `parseMetaContent`'s `dim` field (`jsx/core.jsx:1064`) — which nothing has ever written — stays `""`.
- **1.11** The `aerender` path is unavailable. `renderTemplateThumbnail(aepPathHex, outPngPathHex)` (`jsx/templates_save.jsx:358`) takes two arguments; `js/textanim/textanim.js:1334-1337` passes two. `renderComp`/`renderFrame` are discarded and the PNG is rendered from whatever comp `findCompItemInFolder` returns first.
- **1.13** Re-saving an existing template: the host returns `encodeBridge("My Title")` (`jsx/import.jsx:2113`), the panel tests `decodeBridge(existsHex) === "true"` (`js/templates/templates.js:3172`) → `false`. No overwrite prompt, `oldId === ""`, and the `.fav` preservation plus old-folder removal at `js/templates/templates.js:3344-3356` are unreachable.
- **1.15** A truncated payload `"00480065006C6C6"` (15 chars). Panel: `parseInt("6C6", 16)` on the trailing chunk → a *wrong* character; a 14-char payload yields `String.fromCharCode(NaN)` → U+0000. Host: the malformed chunk is skipped. Two different strings from one payload, and no error either side.
- **1.17** `importCurrentCardToTimeline` injects `csInterface.evalScript` directly (`js/templates/templates.js:2415`). A host call that never returns leaves `.importing` on the card forever; a CEP `"EvalScript error."` sentinel is fed to `decodeBridge` as if it were hex.
- **1.19** Import the same comp template three times. Because `safeRenameAllImportedItems` has already uniquified the comp's name against every existing item name, `toolkitOrganizeTemplateImport`'s find-existing-folder scan (`jsx/import.jsx:884-891`) can never match: the Project panel accumulates `Name`, `Name 2`, `Name 3` at the root.
- **1.21** The active comp has two layers both named `BG`. The user selects the lower one; `placeLayerAtPlayhead` discards the live `anchorLayer` and scans by name (`jsx/templates_save.jsx:19-31`), matching the upper one first. The imported layer lands in the wrong place.
- **1.25** A template folder contains both `project.aep` and `project_backup.aep`, and `meta.json` is missing. `aepFiles[0]` (`jsx/core.jsx:360`) may be either one, depending on the filesystem.

## Expected Behavior

### Preservation Requirements

**Unchanged behaviors** (the full list is section 3; these are the ones each fix is checked against):

- The protective save aborts before any destructive operation, ends the undo group exactly once, and leaves the live project untouched (3.1).
- A failure **before** `reduceProject` succeeds performs **no** reopen (3.2); a failure **after** it performs exactly **one** reopen from the protective snapshot and tells the user to reopen manually when that fails (3.3).
- Reduce-first ordering: protective save → rename → `reduceProject([target])` → one `app.project.save(targetFile)`, with no additional destructive project writes (3.4).
- An unsaved project is refused with "Please save your project first!" before anything is touched (3.5).
- `encodeBridge`/`decodeBridge` round-trip non-English, CJK and surrogate-pair text byte-for-byte on both sides (3.6) and carry a full library scan or a 500-template batch without truncation (3.7); the measured string-append form is not reverted to array + `join` (3.29).
- `importBatch` performs the whole action in ONE host execution inside ONE undo group with `endUndoGroup` guaranteed by `try/finally`, and the reused per-section routines' undo calls stay no-ops while the batch is active (3.8); a standalone `importCompDirect` still opens and closes its own group (3.9).
- `csRollbackToSnapshot` removes only what the failed template added (3.10), and `importBatch`'s result stays total over the requested templates, in input order, on every path (3.11).
- Metadata seeded from the `Metadata_Cache` is served with zero disk reads, and a miss reads + parses `meta.json` at most once per import (3.12).
- `resolveTemplateFiles`' fallback ladder (`project.aep` → `*.aep` → `*.cseffect` → image) and `getAllTemplates`' degraded-record behavior are unchanged (3.14).
- `importFile` stays wrapped in dialog suppression (3.15); the Utility Pre-Comp path still places one reference layer, removes the wrapper comps and re-applies `layerState` (3.16); trimmed in-points still align to the captured playhead (3.17); multi-layer imports still shift by one uniform delta (3.18); footage relink still tries decoded → raw → case-insensitive → extension-agnostic (3.19); `csResolveName` stays the single deterministic resolver over a once-per-import name set (3.20).
- `runSaveController` exits the loading state exactly once and schedules no background work on essential failure (3.21, 3.22); `renderOptimisticCard` still replaces in place at the head (3.23); a failed thumbnail still keeps the placeholder and badges only its own card (3.24); `aerender` is still preferred when available (3.25); a sub-64-byte PNG is still a failure (3.26); `renderTemplateThumbnail` stays non-destructive (3.27).
- Host-side JSON parsing stays on the strict `jsonParse` recursive-descent parser with no code execution (3.28).

**Scope.** Every input for which `isBugCondition` is false must behave **identically** after the fix, including: saves whose reopen succeeds, selections where the two resolvers already agreed, absolute library roots, names that need no sanitization beyond the current character class, well-formed hex payloads, imports that succeed, single-name anchors, and template folders holding exactly one `.aep`.

The correct behavior for buggy inputs is specified in **Correctness Properties** below.

## Hypothesized Root Cause

### R1 — A value read after the reference that produces it was destroyed

**Conditions:** 1.1, 1.2, 1.5 · **Satisfies:** 2.1, 2.2, 2.5 · **Fix:** F1 (`saveActiveComp`), F2 (`coreSaveLayerType`)

**Mechanism.** Both engines were correctly restructured for the reduce-first protocol — `layerState` is captured pre-reopen at `jsx/templates_save.jsx:645-651` precisely because the file knows the reopen "invalidates refs" (`:647`) — but the *result object* was left at the bottom of the function, after the reopen, still reading from the source item. `app.open()` does not null those references; it makes every property read on them **throw**. So the failure is not a wrong value, it is an exception on the success path, which the outer catch then classifies as a save failure (with `windowEntered === true`, producing a second `app.open`). 1.5 is the same misplacement of trust in the other direction: the reopen's `catch` block records the failure in a debug string and lets execution fall through to `return ok:true`, even though `app.project.save(targetFile)` has already reassigned `app.project.file` to the library template.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.1 | `resultObj.renderComp`/`renderFrame` (`jsx/templates_save.jsx:967-968`) read `precomp` after `app.open` at `:947` invalidated it; the throw is caught at `:973` with `windowEntered` true → second `app.open` + `"Error: …"` | `jsx/templates_save.jsx` — capture `capName`/`capFrame` (plus the format fields for 2.9) immediately after the rename at `:894-901`, before the destructive window; build `resultObj` at `:956-969` from the captured locals only | 2.1 |
| 1.2 | `renderFrame` (`jsx/templates_save.jsx:768`) reads `comp.workAreaStart`/`workAreaDuration`/`frameRate` after the reopen at `:750`; the source comp was additionally removed by `reduceProject([tempComp])` | `jsx/templates_save.jsx` — capture into `capComp*` locals alongside the existing `layerState` capture at `:645-651`; return them from `:761-769` | 2.2 |
| 1.5 | The reopen `catch` at `jsx/templates_save.jsx:946-950` (and the bare `try { app.open(origFile); } catch` in `RESTORE_AND_RETURN` at `:751`) records the failure only in `logMsg`; control falls through to the `ok:true` result. `app.project.file` now points at the template | `jsx/templates_save.jsx:944-952` / `:747-753` — a `reopenOk` latch; on `false` return a failure string that names the template path and warns the session is pointed at it | 2.5 |

**Regression clauses held.** The capture is inserted *before* `reduceProject`, so the destructive ordering at `:905-925` is byte-identical (**3.4**). `windowEntered` still gates every reopen, so a pre-window throw still performs none (**3.2**) and a post-window failure still performs exactly one (**3.3**) — and eliminating the post-reopen throw *removes* the accidental second `app.open` that 1.1 caused, strengthening 3.3. The protective-save abort at `:878-891` is untouched (**3.1**), as is the `app.project.file` null check at `:833` (**3.5**). Returning a failure string on a failed reopen routes through the panel's existing `parseEssential` error branch, so `runSaveController` exits loading once and schedules no background work — exactly what 3.21/3.22 require of an essential failure.

### R2 — Two resolvers, one question

**Conditions:** 1.3, 1.4 · **Satisfies:** 2.3, 2.4 · **Fix:** F3

**Mechanism.** `getStrictSaveType` (`jsx/core.jsx:798-891`) and `resolveCompForSave` (`jsx/core.jsx:976-1010`) each walk the same three inputs — timeline selection, Project-panel selection, active comp — in the same order but with **different acceptance rules**, and neither delegates to the other. Two divergences follow mechanically:

- *Missing branch.* `getStrictSaveType` has a final "active comp" fallback (`:885-887`); `resolveCompForSave` has none — its Project-panel branch returns early for *any* non-empty selection and its function tail is an error (`:1005`). So with an empty selection the panel advertises what the engine refuses.
- *Different predicate on the same branch.* `getStrictSaveType` accepts the Project-panel comp only when `compsSelected === 1 && nonCompSelected === 0` (`:876`); `resolveCompForSave` counts comps and ignores non-comps entirely (`:990-996`). One comp plus one footage item therefore satisfies the second and not the first, and they resolve different compositions.

There is a third latent divergence on the same seam: a Project-panel selection of non-comp items only falls through to the active comp in `getStrictSaveType` but returns `"Selection is not a composition."` in `resolveCompForSave` (`:997`). One canonical resolver removes all three at once.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.3 | `resolveCompForSave` has no active-comp fallback; its tail (`jsx/core.jsx:1005`) is an error where `getStrictSaveType:885-887` returns `type:"comp"` | New canonical `csResolveCompTarget()` in `jsx/core.jsx` (above `:976`) owning all three branches including the active-comp fallback; `resolveCompForSave` becomes a thin adapter over it | 2.3 |
| 1.4 | The Project-panel predicates differ: `nonCompSelected === 0` required at `jsx/core.jsx:876` but not at `:990-996` | The canonical resolver applies ONE rule — a Project-panel selection containing exactly one comp wins regardless of accompanying non-comp items (`>1` comp is still the existing error); `getStrictSaveType:859-887` delegates to it for both the decision and the announced name | 2.4 |

**Regression clauses held.** The resolver is pure selection inspection: no project mutation, so 3.1–3.5 cannot be reached by it. The existing error strings (`"Select only ONE pre-comp layer."`, `"Please select only ONE composition in the Project panel."`, `"Selected layer is not a precomposition."`) are preserved verbatim, so `validateSaveRequest`'s message pass-through (`jsx/core.jsx:1025-1027`) and the panel's toast text are unchanged. `getSaveCapabilities` still reads `getStrictSaveType`'s JSON via its existing regexes (`jsx/core.jsx:897-907`), so the capability flags and the Utility Pre-Comp `caps.layer` addition at `:940-953` behave as before.

### R3 — An unvalidated prefix and a swallowed creation failure

**Conditions:** 1.6, 1.7 · **Satisfies:** 2.6, 2.7 · **Fix:** F4

**Mechanism.** `ensureDeepFolder` (`jsx/core.jsx:458-473`) is a pure string walk: it splits the path on `/`, starts from `parts[0]`, and creates each prefix. With `r === ""` the target is `"/comp/<cat>/<id>"`, `parts[0]` is the empty string, and the first created folder is `/comp` at the volume root — the function has no notion of "inside the library", so it cannot object. It then discards `cf.create()`'s boolean and returns `new Folder(pathStr)` unconditionally, so its return value carries **no** success information; the only signal left is `.exists`, which `saveActiveComp` does check (`:832-836`) and `coreSaveLayerType` does not (`:653`). The consequence in `coreSaveLayerType` is ordering: `f` is used to build `targetFile` at `:704` *after* `reduceProject` has already destroyed the in-memory project at `:708`.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.6 | `r` is interpolated into `targetFolderPath` (`jsx/templates_save.jsx:830`, `:652`) with no shape check; `ensureDeepFolder` creates whatever it is handed | New `validateLibraryRoot(pathStr)` in `jsx/core.jsx` (absolute-path test + resolvable-parent test); called in `saveActiveComp` at `:828` and `coreSaveLayerType` at `:651`, before `ensureDeepFolder` and before the undo group | 2.6 |
| 1.7 | `ensureDeepFolder` ignores `cf.create()` (`jsx/core.jsx:464-470`) and returns a Folder regardless; `coreSaveLayerType:653` never inspects it | `ensureDeepFolder` returns `null` on failure (verified per level, with an `exists` re-test for volumes that under-report); `coreSaveLayerType` gains the same `!f || !f.exists` abort `saveActiveComp` already has, placed before `app.beginUndoGroup` at `:673` | 2.7 |

**Regression clauses held.** Both new checks run **before** `app.beginUndoGroup` and before the protective save, so they are pre-window failures: no undo group to leak, no reopen (**3.2**), the live project untouched in memory and on disk (**3.1**). Ordering inside the window is untouched (**3.4**), and the unsaved-project refusal still precedes everything (**3.5**). `ensureDeepFolder`'s new `null` return requires a guard at the seven call sites that dereference it — enumerated in F4 — so a creation failure surfaces as a named error instead of a `null` property access.

### R4 — Three sanitizers, one of them unreachable

**Conditions:** 1.8, 1.26, 1.27 · **Satisfies:** 2.8, 2.26, 2.27 · **Fix:** F5

**Mechanism.** "Make this name filesystem-safe" is implemented three times with three different rule sets:

1. `jsx/core.jsx:74-78` — trim, then replace `\ / : * ? " < > |`. Nothing else. `"."`, `".."`, `"name."` and `""` pass through unchanged, and on Windows `<root>/comp/<cat>/.` resolves to the category folder while `..` resolves to the section folder. Callers pass through `cleanStr` first (`jsx/templates_save.jsx:812-818`).
2. `js/core/utils.js:20-24` — the same character class, but **no** `cleanStr`. So a name containing a tab or a run of spaces yields a different string than the host produced for the same input, and the panel's optimistic card and metadata-cache key point at a folder that does not exist.
3. `js/core/pathBuilders.js:44-78` — a *third* rule set (all whitespace → `_`) returning `{ok, value}` — and the module is **absent from `index.html:1575-1613`**. It is therefore the only implementation with property tests and the only one that never runs. Its absence also silently degrades `js/templates/templates.js:2432`, where `typeof generateTemplateId === "function" ? generateTemplateId(fsName) : fsName` falls to the raw, unsanitized name for the cache-first folder-path reconstruction.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.8 | `getSafeName` (`jsx/core.jsx:74-78`) has no notion of reserved or traversing names: its regex class contains no `.`, and it has no empty-result or trailing-dot/space rule | Canonical `sanitizeNameStrict` in `js/core/pathBuilders.js`, ported verbatim (ES3) into `jsx/core.jsx:74`: replace the illegal class **and** C0 controls, strip trailing dots/spaces, reject `"." / ".." /` reserved device names / empty-after-sanitize to `_untitled`, truncate to 255 | 2.8 |
| 1.26 | The panel omits `cleanStr` before sanitizing (`js/core/utils.js:20-24`), so `js/templates/templates.js:3246`, `:3421`, `:3487` and `:2432` derive a different folder name than `generateTemplateId(cleanStr(name))` does host-side | `cleanName()` (the panel twin of `cleanStr`) folded into `generateTemplateId`, on **both** sides; `getSafeName` removed from `js/core/utils.js`; the four panel call sites use `generateTemplateId(name)` for the id segment and `getSafeName(cat)` for the category | 2.26 |
| 1.27 | `js/core/pathBuilders.js` is not in `index.html:1575-1613`, so the tested rules are not the runtime rules | Add `<script src="js/core/pathBuilders.js?v=1">` **before** `js/core/utils.js` in `index.html`; `pathBuilders` becomes the single panel definition of `getSafeName`/`generateTemplateId`, and `jsx/core.jsx` carries the identical algorithm | 2.27 |

**No library re-keying.** The canonical rules are a strict superset of today's host rules *for names that are already safe*: for any name made of letters, digits, spaces, dashes and dots-not-at-the-end, `sanitizeNameStrict` returns byte-identically what `jsx/core.jsx:74-78` returns today. Only names that currently produce a broken or traversing path change, and those have no valid folder on disk to re-key. An **empty** input still returns `""` (not the fallback), so the shape of existing empty-category paths is preserved; an empty *name* is instead rejected up front by the save engines, which is what 2.8 asks for.

**Regression clauses held.** `findTemplateFolder`/`resolveTemplateFiles` (`jsx/core.jsx:325-360`) sanitize the *lookup* id with the same function, so lookup and creation stay symmetric and 3.14's fallback ladder is unaffected. `renderOptimisticCard`'s in-place replacement is keyed on `folderPath` (**3.23**) — after this fix the panel-derived `folderPath` finally equals the host's, which is what makes that replacement work rather than duplicate. The `Metadata_Cache` is keyed on the same normalized `folderPath`, so cache-first reads (**3.12**) hit instead of missing.

### R5 — Computed once, delivered nowhere

**Conditions:** 1.9, 1.10, 1.11, 1.12 · **Satisfies:** 2.9, 2.10, 2.11, 2.12 · **Fix:** F6

**Mechanism.** The save engine sits on the only side that can cheaply read the composition's format and the exact render target, and the consumers (`meta.json`, the thumbnail renderer) sit on the other side of the Bridge. Each of these four defects is a link in that chain that was never connected: the host result object never carried the format (1.9) or the `section`/`type` keys the panel's own branch tests (1.10); `renderTemplateThumbnail` never grew parameters for the `renderComp`/`renderFrame` the engine had already computed (1.11); and `renderFrameToPng` writes `comp.time` as render prep without treating it as borrowed state (1.12) — harmless for the scratch/temp comps most callers pass, but `generateActiveFrameThumbnail` (`jsx/templates_save.jsx:298-306`) passes the **live** comp.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.9 | `js/templates/templates.js:3298-3312` writes a fixed key set with no format fields, and the host result (`jsx/templates_save.jsx:956-969`) carries none for it to write | Host: add `width`/`height`/`pixelAspect`/`frameRate`/`duration` to `resultObj` from the pre-reopen capture (R1). Panel: write them into `metaObj` plus `dim: w + "x" + h` — the field `parseMetaContent` (`jsx/core.jsx:1064`) already reads and nothing ever wrote | 2.9 |
| 1.10 | `resultObj` omits `section`/`type`, so `if (resObj.section === "comp")` (`js/templates/templates.js:3335`) never fires | Host: `section:"comp", type:"comp"` in `resultObj`. Panel: key the `assetsDir` branch off `metaObj.section` (the already-normalized `resObj.section \|\| "comp"` it wrote at `:3302`) so a host that omits it still records `assetsDir` | 2.10 |
| 1.11 | `renderTemplateThumbnail(aepPathHex, outPngPathHex)` (`jsx/templates_save.jsx:358`) has no parameters for a comp name or frame, and `js/textanim/textanim.js:1334-1337` passes only two arguments | Extend to `(aepPathHex, outPngPathHex, compNameHex, frameHex)`; new ES3 `findCompItemInFolderByName` breadth-first walk; `thumbTime = frame / frameRate` clamped to the comp duration, falling back to the existing 30%-of-work-area rule when either argument is absent. `js/textanim/textanim.js:1334` passes `job.compName` and `job.renderFrame`, which `enqueueThumbnailRender` already carries | 2.11 |
| 1.12 | `renderFrameToPng` assigns `comp.time = time` (`jsx/helpers.jsx:132-134`) as prep and never restores it; the `finally` only releases dialog suppression | Capture `prevTime` before the assignment and restore it in the same `finally`, each step independently guarded so neither restore can mask the other or the render result | 2.12 |

**Regression clauses held.** `renderTemplateThumbnail` keeps its scratch-import shape: no `app.project.file` write, no `app.open`, no reduce, and the wrapper + imported folder + `bitsPerChannel` teardown in its `finally` (**3.27**). Both new arguments are optional and default to the current behavior, so an aerender-first flow (**3.25**) and a back-compat two-argument call are unchanged. The bounded-resolution wrapper at `:401-427` still caps the raster, and `renderFrameToPng`'s `isValidPng` tail still classifies a missing/empty/sub-64-byte PNG as failure (**3.26**); the `comp.time` restore is in the `finally` *after* the render, so it cannot change the returned success value. A failed thumbnail still keeps the placeholder and badges one card (**3.24**). The new `meta.json` keys are additive — `parseMetaContent` and `getAllTemplates` ignore unknown keys, so a library holding both old and new documents scans identically (**3.14**).

### R6 — A contract written one way and read another

**Conditions:** 1.13, 1.14 · **Satisfies:** 2.13, 2.14 · **Fix:** F7

**Mechanism.** `itemExists` overloads its return value: it uses the *matched folder's name* as the success signal (`jsx/import.jsx:2113`) because that name is genuinely useful to the caller — but the caller was written against a boolean protocol and tests `=== "true"` (`js/templates/templates.js:3172`). Since a folder name is never the literal `"true"`, `exists` is constant `false`, which statically kills three downstream behaviors: the `library.confirmOverwrite` prompt, the `oldId` assignment (`:3185`), and — because `oldId && oldId !== templateId` gates it — the entire `.fav` preservation + old-folder removal block at `:3344-3356`. 1.14 is the same call site under-supplying: with `sHex` undefined the host's `if (sHex)` guard (`jsx/import.jsx:2093-2096`) leaves `section` at its `"comp"` default, so a Layer/Text/Footage/Effect save has its existence check run against the Comp section. The contract is also mis-documented in `js/core/bridgeRegistry.js:56`, which declares `successShapes: ["true","false"]`.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.13 | Host returns a folder name as the hit signal (`jsx/import.jsx:2113`); panel compares against `"true"` (`js/templates/templates.js:3172`), so `oldId` is always `""` and `:3344-3356` is dead | One explicit envelope: host returns `{"exists":Boolean,"id":String,"section":String}` via `jsonStringify`; panel parses it, uses `info.exists` for the prompt and `info.id` — the folder that actually exists — as `oldId`. `js/core/bridgeRegistry.js:56` updated to the new shape | 2.13 |
| 1.14 | The panel passes three arguments (`js/templates/templates.js:3170`); the host's `section` default is `"comp"` (`jsx/import.jsx:2093-2096`) | Panel passes `sHex = encodeBridge(saveType === "png" ? targetImgSec : saveType)`; the host normalizes it through `normalizeSectionName` and searches that section | 2.14 |

**Regression clauses held.** The check runs before the save is dispatched and mutates nothing, so 3.1–3.5 are out of reach. Routing it through `callHost` (F8) adds the timeout guard without changing the sequence: the existing `validateSaveRequest` → `itemExists` → `runSave()` order and the 80 ms modal-close defer at `js/templates/templates.js:3517` are preserved, so `runSaveController`'s single loading exit (**3.21**) and background-only scheduling (**3.22**) are unaffected. Making `oldId` real finally *activates* `.fav` preservation and old-folder removal; `renderOptimisticCard` still replaces the entry for the same `folderPath` in place, so a re-save produces one card, not two (**3.23**). Host-side parsing stays on `jsonParse` (**3.28**) — the dead `typeof jsonParse === "function" ? … : JSON.parse(…)` branch at `:2110` is dropped, since the host has no native `JSON`.

### R7 — Transport primitives that corrupt instead of reporting

**Conditions:** 1.15, 1.16, 1.17 · **Satisfies:** 2.15, 2.16, 2.17 · **Fix:** F8

**Mechanism.** All three are the same class of defect: a primitive that cannot express failure, so it invents a value.

- **1.15** Neither `decodeBridge` validates its input. Both loop `i += 4` over the string; the panel (`js/core/bridge.js:23-30`) hands whatever `parseInt` produced to `String.fromCharCode`, and `String.fromCharCode(NaN)` is U+0000; the host (`jsx/core.jsx:32-43`) guards with `if (!isNaN(code))` and **skips** the chunk. A trailing partial chunk is worse than either: `parseInt("6C6", 16)` succeeds and yields a plausible but wrong character on both sides. So one corrupted payload decodes to two different strings, and a `"true"` comparison then fails for an operation that succeeded.
- **1.16** `escapeJSON` (`jsx/core.jsx:80-88`) escapes `\`, `"` and `\n`, **deletes** `\r`, and passes every other control character through raw. Raw C0 characters are illegal inside a JSON string, so `jsonStringify` — which routes every string and every key through it (`jsx/core.jsx:135`, `:147`) — can emit a document `JSON.parse` rejects, surfacing a completed save as `"JSON Parse Error"` (`js/templates/templates.js:3223`).
- **1.17** The import call site injects a raw transport (`js/templates/templates.js:2412-2415`) instead of the timeout-guarded `callHost` the save path uses. It therefore inherits none of `callHost`'s three guarantees: the settled latch, the timeout, and the `BRIDGE_ERROR_SENTINELS` classification (`js/core/bridge.js:62-65`). A never-returning host call leaves `.importing` on the card permanently, because the class is only removed in the result callback (`js/templates/templates.js:2462`).

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.15 | No length or hex validation on either side, and two different malformed-chunk behaviors (`js/core/bridge.js:23-30` vs `jsx/core.jsx:32-43`) | `decodeBridgeStrict(hex) -> {ok,value,error}` added **identically** to both files: one whole-string check (`length % 4 === 0` and a single `/^[0-9a-fA-F]*$/` test) then the unchanged append loop. `decodeBridge` becomes a wrapper returning `""` for malformed input on both sides. `callHost` reports the decode failure; `importBatch` uses it for the payload decode and returns its existing total failed result | 2.15 |
| 1.16 | `escapeJSON` emits raw C0 controls and deletes `\r` (`jsx/core.jsx:80-88`) | Full escape set — `\\ \" \n \r \t \b \f` — plus `\u00XX` for the remaining C0/DEL characters, behind a single `/[\u0000-\u001F\u007F]/` fast-path test so the common (control-free) case still costs one native pass | 2.16 |
| 1.17 | Raw `csInterface.evalScript` transport (`js/templates/templates.js:2415`) bypasses `callHost`'s latch, timeout and sentinel classification | The injected transport calls `callHost('importBatch("…")', {timeoutMs})` and hands `importEngine` the decoded body (`decode` becomes the identity); on timeout/error it synthesizes `{"perTemplate":[],"error":reason}`. `js/core/importEngine.js:113` propagates `parsed.error` so the reason reaches every entry | 2.17 |

**Regression clauses held.** `decodeBridgeStrict` keeps the measured string-append loop verbatim and adds exactly one O(n) native regex test — no array + `join` (**3.29**) — and because it validates rather than transforms, well-formed payloads decode byte-for-byte as before, including surrogate pairs and CJK (**3.6**) and multi-megabyte scan/batch payloads (**3.7**). `escapeJSON`'s change is additive for every string that contains no control characters, which is every string the host produces after `cleanStr` (`jsx/core.jsx:64-70`); `jsonParse` is untouched (**3.28**). The import transport swap preserves the Import_Engine contract exactly — one Bridge_Call for a batch, zero when everything is cached — so 9.1/9.4's properties still hold, and because the guarded transport *always* settles, `importBatch`'s result stays total over the requested templates on the timeout path too (**3.11**). The host-side undo envelope is not touched (**3.8**, **3.9**).

### R8 — Cleanup at exit points instead of at scope exit

**Conditions:** 1.18, 1.19, 1.20 · **Satisfies:** 2.18, 2.19, 2.20 · **Fix:** F9

**Mechanism.** `importCompDirect` and `importLayerTypeAep` build `allImportedItems` as the authoritative record of everything one `importFile` added (`jsx/import.jsx:1466-1485`, `:989-1006`), and then clean it up at **one** of their exit points (`:1596-1601`) instead of on scope exit. The `try/finally` that wraps the body already exists — it just owns the undo group and not the items. So the returns at `:1489`, `:1585`, `:1589` (and `:1011` in `importLayerTypeAep`) leave the imported composition, footage and folders in the user's project. Inside `importBatch` this is masked by `csRollbackToSnapshot`; called standalone via `importTemplate` (`jsx/import.jsx:1615`) nothing catches it.

1.19 and 1.20 are both consequences of `toolkitOrganizeTemplateImport`'s container being named after the payload. `folderName = mainComp.name` (`:880`) is looked up among root folders (`:884-891`) — but `safeRenameAllImportedItems` has already made `mainComp.name` unique against **every** existing item name, folders included, so that lookup provably cannot match and `addFolder` runs on every import. 1.20 then follows from `needsAssets` gating the *whole* reparent block (`:913-931`): with only solid footage the flag stays false, nothing moves, and the `FolderItem` `importFile` created — now empty, because `mainComp.parentFolder = rootFolder` moved its only meaningful child out — is left at the Project-panel root.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.18 | Cleanup is inline at one exit (`jsx/import.jsx:1596-1601`) rather than owned by the existing `try/finally` at `:1443`/`:1600`; the same shape in `importLayerTypeAep` at `:966`/`:1339` | An `importCommitted` latch set only on the success returns; the existing `finally` calls `cleanupImportedItems(allImportedItems)` (already defined at `:869`) when it is false, **before** `csEndUndoGroup()` so the removals sit inside the group. The redundant inline loop at `:1596-1601` is deleted | 2.18 |
| 1.19 | The container is named after a payload whose name was just uniquified against all item names, so the find-existing branch (`jsx/import.jsx:884-891`) can never match | One fixed container name `_CompSaver_Assets` via `csFindOrCreateRootFolder` — findable by definition, so created once and reused; assets go into its `Assets` subfolder via `csFindOrCreateSubFolder` | 2.19 |
| 1.20 | `needsAssets` gates the entire reparent block (`jsx/import.jsx:913-931`), so a solid-only import moves nothing and the emptied `FolderItem` stays at the root | The `FolderItem`s are partitioned out of the asset set and swept unconditionally after reparenting: `numItems === 0` → `remove()`, otherwise reparent under the container. Non-asset items are still reparented under the container so nothing is left loose at the root | 2.20 |

**Regression clauses held.** `cleanupImportedItems` only ever touches `allImportedItems` — items this `importFile` created — so it cannot reach a pre-existing layer, item, or a previously imported template: exactly the scoping `csRollbackToSnapshot` guarantees (**3.10**). Inside a batch both may remove the same item; each removal is individually `try`-guarded, so the second is a no-op and the batch result stays total (**3.11**). The latch is set only after the success `return`'s own work completes, so the Utility Pre-Comp path still returns `"true"` with its reference layer, wrapper removal and `layerState` re-apply intact (**3.16**), and the multi-layer uniform-delta shift (**3.18**) and trimmed-in-point alignment (**3.17**) are untouched. `csEndUndoGroup()` still runs on every path and remains a no-op under a batch (**3.8**, **3.9**). Because the container is found by a fixed name, `csResolveName` is never asked to resolve it, so the once-per-import existing-name set is unchanged (**3.20**); the footage relink ladder (**3.19**) and the cache-first meta read (**3.12**) run before organization and are not reordered.

### R9 — An ambiguous key, and an anchor that moves

**Conditions:** 1.21, 1.22 · **Satisfies:** 2.21, 2.22 · **Fix:** F10

**Mechanism.** `placeLayerAtPlayhead` receives a live `anchorLayer` — resolved microseconds earlier by `getTopSelectedLayer(activeComp)` in the same host execution (`jsx/import.jsx:963`, `:1441`, `:1698`, `:1796`) — and immediately discards it in favor of `anchorLayer.name` (`jsx/templates_save.jsx:21-31`). Layer names are not unique in a composition, so the scan is ambiguous *by construction*: the first same-named layer wins. The reference, by contrast, is exact; layer references stay valid across insertions (only indices shift), so `moveBefore(anchorLayer)` is both correct and cheaper.

1.22 is a coupling created by the function's tail: `deselectAllLayers(activeComp)` + `newLayer.selected = true` (`:34-35`) means that after template *n-1*, `getTopSelectedLayer` returns *its* layer. Each per-template routine resolves its anchor independently, so template *n* anchors to template *n-1*'s output and the user's original selection is gone.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.21 | The live reference is thrown away for a by-name scan (`jsx/templates_save.jsx:21-31`), which is ambiguous whenever names repeat | `moveBefore(anchorLayer)` directly; liveness probed by reading `anchorLayer.index` inside a `try` (an invalidated reference throws), and the by-name scan retained **only** as the fallback for a genuinely stale reference | 2.21 |
| 1.22 | Every per-section routine calls `getTopSelectedLayer` itself (`jsx/import.jsx:963`, `:1441`, `:1698`, `:1796`) after `placeLayerAtPlayhead` already re-selected the previous template's layer | A batch-scoped latch — `__CS_IMPORT_BATCH_ANCHOR`, mirroring the existing `__CS_IMPORT_BATCH_ACTIVE` pattern — captured once by `importBatch` before the loop and restored in its `finally`; the four call sites use `csResolveImportAnchor(activeComp)`, which returns the latched anchor inside a batch and `getTopSelectedLayer` standalone | 2.22 |

**Regression clauses held.** Only the *choice* of anchor changes, never the timing math: `startTime = playheadTime - inPoint` and its fallback (`jsx/templates_save.jsx:11-17`) are untouched, so trimmed in-points still land on the captured playhead (**3.17**) and the multi-layer uniform-delta path (`jsx/import.jsx:1259-1289`) is not entered by this fix (**3.18**). Standalone imports behave exactly as before, including leaving the new layer selected. The batch restore is a selection change only — not an undoable DOM mutation — and runs inside the single group before `endUndoGroup` (**3.8**); it touches only layers captured from the pre-action selection, so it cannot resurrect anything rollback removed (**3.10**). The Utility Pre-Comp reference layer still goes through the same `placeLayerAtPlayhead` call (**3.16**).

### R10 — `begin*` without a guaranteed `end*`

**Conditions:** 1.23, 1.24 · **Satisfies:** 2.23, 2.24 · **Fix:** F11

**Mechanism.** ExtendScript has no automatic unwinding: a `begin`/`end` pair written as two sequential statements is only balanced on the path that does not throw. Four sites do exactly that — `jsx/templates_save.jsx:944-952` (the success reopen), `:663-670` and `:772-779` (the destructive-window restore handlers), `:856-862` (the hex restore handler), `jsx/import.jsx:1454-1465` and `:997-1010` (around `importFile`) — while the *correct* pattern already exists two files over, in `renderFrameToPng` (`jsx/helpers.jsx:126-147`) and `renderTemplateThumbnail` (`jsx/templates_save.jsx:441-450`). A throw between the calls leaves After Effects with dialog suppression on for the rest of the session: every subsequent modal is silently auto-answered.

1.24 is an ordering inversion. `__CS_IMPORT_BATCH_ACTIVE = true` is set at `jsx/import.jsx:566`, *before* `app.beginUndoGroup("CompSaver Import")` is attempted at `:568`. The `undoOpened` latch correctly records whether the group opened and correctly gates `endUndoGroup` in the `finally` (`:627`) — but the guard that makes the per-section routines' groups no-ops was already set. So when `beginUndoGroup` throws, the batch owns no group and suppresses everyone else's: the entire batch of DOM mutations runs with **no** undo group at all.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.23 | `beginSuppressDialogs`/`endSuppressDialogs(false)` written as sequential statements at `jsx/templates_save.jsx:944-952`, `:663-670`, `:772-779`, `:856-862` and `jsx/import.jsx:1454-1465`, `:997-1010` | A `suppressed` latch plus `try/finally` at each site, matching `renderFrameToPng`'s in-repo pattern; the `finally` releases suppression on the throw path and on every early `return` inside the block | 2.23 |
| 1.24 | The batch guard is set before the group it represents exists (`jsx/import.jsx:566` vs `:568`) | `__CS_IMPORT_BATCH_ACTIVE = undoOpened;` — set from the latch **after** the attempt, so a failed `beginUndoGroup` leaves it `false` and each per-section routine opens its own group. The user gets N undo groups instead of none | 2.24 |

**Regression clauses held.** On the normal path `beginUndoGroup` succeeds, so `__CS_IMPORT_BATCH_ACTIVE` is `true` exactly as before: one host execution, one undo group, `endUndoGroup` guaranteed by the existing `finally`, and the per-section `csBeginUndoGroup`/`csEndUndoGroup` still no-ops (**3.8**). A standalone `importCompDirect` still opens and closes its own group in `try/finally` (**3.9**). `importFile` remains wrapped in suppression — the fix only guarantees the release (**3.15**). In the save engines the restore handlers keep their exact sequence (remove temp/precomp → one `endUndoGroup` → one suppress-balanced `app.open` → return the message), so the abort-before-destruction (**3.1**), no-reopen-before-the-window (**3.2**) and exactly-one-reopen-after-it with a manual-reopen instruction on failure (**3.3**) are all preserved verbatim.

### R11 — A choice from an unordered set

**Conditions:** 1.25 · **Satisfies:** 2.25 · **Fix:** F12

**Mechanism.** `Folder.getFiles(mask)` returns entries in whatever order the filesystem enumerates them; the ExtendScript documentation specifies none. `resolveTemplateFiles` takes `aepFiles[0]` (`jsx/core.jsx:358-360`), so a template folder holding more than one `.aep` — a `project.aep` plus a backup, say — resolves to a different file on different machines, or after a copy. The same call also bypasses `csEnumerateFolderOnce` (`jsx/import.jsx:167`), the once-per-import memoized enumerator every other path in the import uses, so the fallback re-hits the disk on each template. The identical `[0]` pattern appears in the `*.cseffect` and image fallbacks at `:362-386`.

| Condition | Root cause | Targeted fix | Satisfies |
|---|---|---|---|
| 1.25 | `aepFiles[0]` (`jsx/core.jsx:360`) selects from an unspecified enumeration order, and the call bypasses `csEnumerateFolderOnce` | `csPickDeterministicFile(files, preferredName)` — documented precedence: the preferred exact name case-insensitively, else the lexicographically smallest name under a total (case-insensitive, then case-sensitive tie-break) order; enumeration through `csListTemplateFiles`, which routes to `csEnumerateFolderOnce` and degrades to a direct `getFiles` if that throws. Applied to the `*.aep`, `*.cseffect` and image branches at `jsx/core.jsx:358-386` | 2.25 |

**Regression clauses held.** The **ladder** is unchanged: `meta.mainFile` → `project.aep` → `*.aep` → `*.cseffect` → images in the existing extension order, with `source.*` still preferred inside an image group — only the tie-break within a step becomes total, so `getAllTemplates`' degraded-record behavior is identical (**3.14**). Routing through `csEnumerateFolderOnce` *adds* memoization, tightening the once-per-import read/enumerate guarantee rather than loosening it (**3.12**). This is the meta-missing degraded path, so a `csIo` enumeration failure here degrades to a direct read instead of aborting — the required-file failures that must stop an import and name the file (**3.13**) all live in `csReadFileTextOnce`/the assets-folder enumeration and are untouched.

## Correctness Properties

Property 1: Bug Condition — Comp/Template Pipeline Operations Behave As Specified And Are Reported As They Happened

_For any_ pipeline operation where the bug condition holds (`isBugCondition` returns true), the fixed pipeline SHALL complete the operation according to its specification and report the outcome that actually occurred: no value is read from an item reference after `app.open` invalidated it, a failed reopen is never reported as success, the composition the panel announced is the composition saved, no file is written outside the resolved library folder, no template's files land outside their own template folder, `meta.json` carries the composition's format, the recorded render target is the frame rendered, a malformed transport payload is reported rather than decoded, an existence check answers for the section being saved, a failed import leaves the project exactly as it was, the imported layer lands above the layer the user selected, and no dialog suppression or undo group is left open.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15, 2.16, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 2.26, 2.27**

Property 2: Preservation — Non-Buggy Inputs Are Byte-For-Byte Unchanged

_For any_ pipeline operation where the bug condition does NOT hold (`isBugCondition` returns false) — a save whose reopen succeeds, a selection on which both resolvers already agreed, an absolute library root, a name that needs no sanitization beyond the current character class, a well-formed hex payload, an import that succeeds, an unambiguous anchor, a template folder holding exactly one `.aep` — the fixed code SHALL produce the same observable result as the original code, preserving the protective-save abort, the reduce-first ordering, the reopen invariants, hex round-trip fidelity, the single-undo-group batch envelope, snapshot rollback scoping, batch result totality, and cache-first metadata reads.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.18, 3.19, 3.20, 3.21, 3.22, 3.23, 3.24, 3.25, 3.26, 3.27, 3.28, 3.29, 3.30**

Property 3: Reference Capture Precedes Invalidation

_For any_ save that enters the destructive window and reaches its result-construction step, every field of the returned result SHALL be derived from a value captured before `app.open(originalFile)` was called, so the result construction performs zero property reads on a project item and cannot throw for reference-invalidation reasons.

**Validates: Requirements 2.1, 2.2**

Property 4: Reopen Failure Is Never Success

_For any_ save in which `reduceProject` succeeded, `app.project.save(targetFile)` succeeded, and the subsequent `app.open(originalFile)` threw, the engine SHALL return a failure whose message states that the live session is pointed at the template rather than the user's project, and SHALL NOT return a result with `ok:true`; exactly one reopen SHALL have been attempted.

**Validates: Requirements 2.5, 3.3**

Property 5: Selection Resolution Agreement

_For any_ selection state, `getStrictSaveType` reporting `type:"comp"` SHALL imply that `resolveCompForSave` returns `ok:true`, and the composition it returns SHALL be the composition whose name `getStrictSaveType` put in `suggestedName`.

**Validates: Requirements 2.3, 2.4**

Property 6: Every Written Path Is Inside The Library

_For any_ library root and any template name and category, the save engine SHALL either reject the request before creating a folder or produce a target folder path that, once normalized, is a strict descendant of `<root>/<section>/<safeCategory>` with a non-empty final segment that is neither `"."` nor `".."`.

**Validates: Requirements 2.6, 2.7, 2.8**

Property 7: One Canonical Sanitizer

_For any_ name, the panel's `getSafeName`/`generateTemplateId` and the host's `getSafeName`/`generateTemplateId` SHALL return the identical string, that string SHALL contain no path separator, no C0 control character, no trailing dot or space, SHALL be at most 255 characters, and SHALL never be `"."` or `".."`; and the implementation exercised by the tests SHALL be the implementation `index.html` loads.

**Validates: Requirements 2.8, 2.26, 2.27**

Property 8: Transport Decode Agreement And Round-Trip Fidelity

_For any_ string, `decodeBridge(encodeBridge(s)) === s` on both sides; and _for any_ hex payload, `decodeBridgeStrict` SHALL return the same `ok` flag and the same `value` in the panel and the host implementations, reporting `ok:false` exactly when the payload's length is not a multiple of four or it contains a non-hex character.

**Validates: Requirements 2.15, 3.6, 3.7**

Property 9: Serialization Always Parses

_For any_ object containing arbitrary strings — including every control character, quotes, backslashes, newlines and surrogate pairs — `JSON.parse(jsonStringify(obj))` SHALL succeed and SHALL reproduce those strings, except that a lone `\r` SHALL survive as `\r` rather than being deleted.

**Validates: Requirement 2.16**

Property 10: Import Atomicity

_For any_ import that fails at any point after `app.project.importFile` has run, whether standalone or inside a batch, the multiset of project item ids after the attempt SHALL equal the multiset before it; and for any sequence of successful comp imports, the number of root-level Project-panel folders added SHALL be at most one in total, not one per import.

**Validates: Requirements 2.18, 2.19, 2.20, 3.10**

Property 11: Anchor Correctness Under Duplicate Names And Batching

_For any_ active composition containing two or more layers sharing the anchor's name, the imported layer's index SHALL be exactly one less than the index of the layer that was actually selected; and _for any_ batch of N templates, every template's anchor SHALL be the layer that was selected before the batch began.

**Validates: Requirements 2.21, 2.22**

Property 12: Balance On Every Path

_For any_ save or import path, including every early return and every thrown error, the number of `beginSuppressDialogs` calls SHALL equal the number of `endSuppressDialogs` calls and the number of `beginUndoGroup` calls SHALL equal the number of `endUndoGroup` calls; and whenever the batch guard is active, the batch SHALL own exactly one open undo group.

**Validates: Requirements 2.23, 2.24, 3.8, 3.9**

Property 13: Deterministic Template File Resolution

_For any_ set of file names in a template folder, `resolveTemplateFiles` SHALL select the same file on every invocation and under every input permutation, and that file SHALL be the highest-precedence candidate under the documented ladder.

**Validates: Requirements 2.25, 3.14**

## Fix Implementation

All host (`.jsx`) blocks are strict ExtendScript ES3: `var` only, no arrow functions, no template literals, no `let`/`const`, no `Array.prototype.map/forEach/filter`, no `JSON.parse`/`JSON.stringify` — serialization goes through the project's `jsonStringify`/`jsonParse`/`escapeJSON`. Error strings keep each file's conventions (`"ERROR:…"`, `"Error: " + logMsg + " -> …"`, the `"true"` import protocol, and `coreSaveLayerType`'s string-on-failure / object-on-success shape).

### F1 — `saveActiveComp`: pre-window capture, reported reopen failure, richer result

**File:** `jsx/templates_save.jsx` · **Function:** `saveActiveComp` (`:800`) · **Conditions:** 1.1, 1.5, 1.9, 1.10

**(a)** Insert immediately after the rename block (after `:901`, before `var targetFilePath`). Capturing *after* the rename is deliberate: `capName` must be the name actually stored inside `project.aep`, so it still matches when the rename failed.

```javascript
        // ── CAPTURE EVERY VALUE DERIVED FROM `precomp` (pre-destructive) ──
        // app.open(originalFile) below replaces the whole project DOM: reading
        // ANY property of `precomp` afterwards throws, which used to turn a
        // fully successful save into a reported failure (and triggered a second
        // app.open through the windowEntered branch of the outer catch). Read it
        // all HERE, right after the rename, so renderComp is the name actually
        // written into project.aep. Same pattern as coreSaveLayerType's
        // pre-reopen layerState capture.
        var capName = name;
        var capWidth = 0;
        var capHeight = 0;
        var capPixelAspect = 1;
        var capFrameRate = 0;
        var capDuration = 0;
        var capFrame = 0;
        try { capName = "" + precomp.name; } catch (eCapN) { capName = name; }
        try { capWidth = precomp.width; } catch (eCapW) { }
        try { capHeight = precomp.height; } catch (eCapH) { }
        try { capPixelAspect = precomp.pixelAspect; } catch (eCapP) { }
        try { capFrameRate = precomp.frameRate; } catch (eCapR) { }
        try { capDuration = precomp.duration; } catch (eCapD) { }
        try {
            capFrame = Math.round(
                (precomp.workAreaStart + precomp.workAreaDuration * 0.3) * precomp.frameRate);
        } catch (eCapF) { capFrame = 0; }
        if (!(capFrame >= 0)) capFrame = 0; // NaN-safe floor
        log("captured render target: " + capName + " @frame " + capFrame);
```

**(b)** Replace the reopen + result tail (`:944-970`):

```javascript
        // ── REOPEN ONCE (suppress-balanced via try/finally) ────────────────
        // Invariant preserved: exactly ONE reopen, and only because the
        // destructive window was entered.
        log("reopening original project: " + originalFile.fsName);
        var reopenOk = true;
        var reopenErr = "";
        var reopenSuppressed = false;
        try { app.beginSuppressDialogs(); reopenSuppressed = true; } catch (eSupB) { }
        try {
            app.open(originalFile);
            log("original project reopened");
        } catch (eReopen) {
            reopenOk = false;
            reopenErr = eReopen.toString();
            log("original project reopen failed: " + reopenErr);
        } finally {
            if (reopenSuppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
        }

        // A FAILED reopen is NOT a success: app.project.save(targetFile) above
        // reassigned app.project.file to the library template, so the user's
        // next Ctrl+S would overwrite the template with their own project. Say
        // so instead of returning ok:true.
        if (!reopenOk) {
            return encodeBridge("Error: " + logMsg +
                " -> Template written to " + targetFolderPath.replace(/\\/g, "/") +
                ", but reopening your project failed: " + reopenErr +
                " — After Effects is still pointed at the template's project.aep." +
                " Do NOT save; reopen your project manually from disk first.");
        }

        log("success");

        var resultObj = {
            ok: true,
            templateId: templateId,
            name: name,
            category: cat,
            // The panel keys its meta.json / assetsDir branches off these two;
            // omitting them silently dropped assetsDir from every comp save.
            section: "comp",
            type: "comp",
            folderPath: targetFolderPath.replace(/\\/g, "/"),
            assetsList: assetsList,
            oldId: oldId,
            needsThumbnail: true,
            // Composition format, captured pre-reopen, so meta.json can record
            // it and no consumer has to open the .aep to learn it.
            width: capWidth,
            height: capHeight,
            pixelAspect: capPixelAspect,
            frameRate: capFrameRate,
            duration: capDuration,
            // Exact comp name inside project.aep + the representative frame for
            // the isolated aerender path — both captured BEFORE the reopen.
            renderComp: capName,
            renderFrame: capFrame
        };
        return encodeBridge(jsonStringify(resultObj));
```

**(c)** Also add the name guard next to the existing project-file guard (after `:822`), so an empty name can never produce `<root>/comp/<cat>/`:

```javascript
        if (!name) {
            log("empty name");
            return encodeBridge("Error: " + logMsg + " -> Please enter a template name.");
        }
```

### F2 — `coreSaveLayerType`: pre-window capture and reported reopen failure

**File:** `jsx/templates_save.jsx` · **Function:** `coreSaveLayerType` (`:553`) · **Conditions:** 1.2, 1.5, 1.7

**(a)** Extend the existing pre-reopen capture block (after `:651`, immediately following the `layerState` capture):

```javascript
        // Everything derived from the SOURCE comp, captured before the
        // destructive window. reduceProject([tempComp]) removes `comp` from the
        // project and app.open then invalidates the reference, so reading
        // comp.workAreaStart / workAreaDuration / frameRate at result-build time
        // threw and reported a successful save as a failure.
        var capCompWidth = 0;
        var capCompHeight = 0;
        var capCompPixelAspect = 1;
        var capCompFrameRate = 0;
        var capCompDuration = 0;
        var capCompFrame = 0;
        try { capCompWidth = comp.width; } catch (eCW) { }
        try { capCompHeight = comp.height; } catch (eCH) { }
        try { capCompPixelAspect = comp.pixelAspect; } catch (eCP) { }
        try { capCompFrameRate = comp.frameRate; } catch (eCR) { }
        try { capCompDuration = comp.duration; } catch (eCD) { }
        try {
            capCompFrame = Math.round(
                (comp.workAreaStart + comp.workAreaDuration * 0.3) * comp.frameRate);
        } catch (eCF) { capCompFrame = 0; }
        if (!(capCompFrame >= 0)) capCompFrame = 0;
```

**(b)** Replace the folder resolution at `:651-653` (adds the 1.6/1.7 guards this engine lacked — see F4):

```javascript
        var rootCheck = validateLibraryRoot(r);
        if (!rootCheck.ok) return "Save Error: " + rootCheck.error;
        if (!name) return "Please enter a template name.";

        var safeCat = getSafeName(cat);
        var targetFolderPath = rootCheck.path + "/" + section + "/" + safeCat + "/" + templateId;
        var f = ensureDeepFolder(targetFolderPath);
        // Verified BEFORE app.beginUndoGroup and before the protective save, so
        // this is a pre-window failure: no undo group to leak, no reopen, the
        // live project untouched in memory and on disk.
        if (!f || !f.exists) {
            return "Save Error: Failed to create folder: " + targetFolderPath;
        }
```

**(c)** Replace the reopen + result tail (`:747-769`):

```javascript
        // ── REOPEN ONCE (suppress-balanced via try/finally) ────────────────
        var reopenOk = true;
        var reopenErr = "";
        var reopenSuppressed = false;
        try { app.beginSuppressDialogs(); reopenSuppressed = true; } catch (eSupB) { }
        try {
            app.open(originalFile);
        } catch (eReopen) {
            reopenOk = false;
            reopenErr = eReopen.toString();
        } finally {
            if (reopenSuppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
        }

        // A string return is this function's failure protocol (the callers at
        // :1122, :1213, :1278, :1330 already branch on typeof).
        if (!reopenOk) {
            return "Template written to " + targetFolderPath.replace(/\\/g, "/") +
                ", but reopening your project failed: " + reopenErr +
                " — After Effects is still pointed at the template's project.aep." +
                " Do NOT save; reopen your project manually from disk first.";
        }

        return {
            ok: true,
            layerCount: layerCount,
            isAdjustment: isAdjustment,
            is3D: is3D,
            blendMode: blendMode,
            label: label,
            layerState: layerState,
            assetsList: assetsList,
            folderPath: targetFolderPath.replace(/\\/g, "/"),
            needsThumbnail: true,
            width: capCompWidth,
            height: capCompHeight,
            pixelAspect: capCompPixelAspect,
            frameRate: capCompFrameRate,
            duration: capCompDuration,
            // tempComp was renamed to `name` before the reduce, so that IS the
            // comp name inside project.aep. The frame comes from the pre-window
            // capture — reading it from `comp` here throws.
            renderComp: name,
            renderFrame: capCompFrame
        };
```

### F3 — One canonical comp resolver

**File:** `jsx/core.jsx` · **Conditions:** 1.3, 1.4

**(a)** Insert above `resolveCompForSave` (`:976`):

```javascript
// =========================================================
// CANONICAL COMP TARGET RESOLUTION
// ---------------------------------------------------------
// ONE resolver for "which composition does a Comp save target?", used by BOTH
// getStrictSaveType (what the panel offers + the message it shows) and
// resolveCompForSave (what the engine saves). They used to walk the same three
// inputs with different acceptance rules, so the panel could advertise a save
// the engine refused (empty selection + open comp) or name a different
// composition than the one that got saved (one project-panel comp alongside a
// non-comp item).
//
// Precedence, evaluated once:
//   1. Timeline selection in the active comp — exactly one pre-comp layer.
//   2. Project-panel selection — exactly one CompItem (non-comp items in the
//      selection are ignored; the explicit click is the stronger signal).
//   3. The active composition itself.
// Returns { ok:Boolean, comp:CompItem, source:String } | { ok:false, error:String }.
// =========================================================
function csResolveCompTarget() {
    try {
        var activeComp = app.project.activeItem;

        if (activeComp instanceof CompItem) {
            var selLayers = null;
            try { selLayers = activeComp.selectedLayers; } catch (eSL) { selLayers = null; }
            if (selLayers && selLayers.length > 0) {
                if (selLayers.length > 1) {
                    return { ok: false, error: "Select only ONE pre-comp layer." };
                }
                var layer = selLayers[0];
                if (layer instanceof AVLayer && layer.source instanceof CompItem) {
                    return { ok: true, comp: layer.source, source: "timeline" };
                }
                return { ok: false, error: "Selected layer is not a precomposition." };
            }
        }

        try {
            var sel = app.project.selection;
            if (sel && sel.length > 0) {
                var selectedComps = [];
                var i;
                for (i = 0; i < sel.length; i++) {
                    if (sel[i] instanceof CompItem) selectedComps.push(sel[i]);
                }
                if (selectedComps.length > 1) {
                    return { ok: false, error: "Please select only ONE composition in the Project panel." };
                }
                if (selectedComps.length === 1) {
                    return { ok: true, comp: selectedComps[0], source: "project" };
                }
                // Zero comps in the selection: fall through to the active comp
                // rather than failing, which is what the panel already offered.
            }
        } catch (eSel) { }

        if (activeComp instanceof CompItem) {
            return { ok: true, comp: activeComp, source: "active" };
        }

        // getStrictSaveType's existing "nothing available" message, kept verbatim
        // and now shared: the engine's old "Select a precomposition first." was
        // both less helpful and inconsistent with what the panel displayed.
        return { ok: false, error: "Please open a composition or select a comp/asset in the Project panel." };
    } catch (e) {
        return { ok: false, error: "Resolution error: " + e.toString() };
    }
}
```

`resolveCompForSave` has exactly one caller (`jsx/templates_save.jsx:821`, which passes the message straight through to the panel's error toast), so this is the only message change and it aligns the toast with the panel's own wording.

**(b)** Replace `resolveCompForSave` (`:976-1010`) with the adapter:

```javascript
function resolveCompForSave() {
    var t = csResolveCompTarget();
    if (!t.ok) return { ok: false, error: t.error };
    return { ok: true, comp: t.comp };
}
```

**(c)** Replace the Project-panel + active-comp tail of `getStrictSaveType` (`:859-889`) so the decision AND the announced name come from the same resolver:

```javascript
        // Both the capability and the message come from the canonical resolver,
        // so the composition the panel NAMES is always the composition
        // resolveCompForSave will save.
        var target = csResolveCompTarget();
        if (!target.ok) {
            return buildDetectionResult("error", target.error, "");
        }
        if (target.source === "project") {
            return buildDetectionResult("comp", "Pre-Comp from Project panel selected", target.comp.name);
        }
        if (target.source === "timeline") {
            return buildDetectionResult("comp", "Pre-comp layer selected", target.comp.name);
        }
        return buildDetectionResult("comp", "Active composition will be saved", target.comp.name);
    } catch (e) {
        return buildDetectionResult("error", "Detection error: " + e.toString(), "");
    }
}
```

The timeline branch above `:859` is unchanged: effect detection, layer-type classification and mixed-type rejection still run first, and a single selected pre-comp layer still returns from `:840` with `"Pre-comp layer selected"`. `csResolveCompTarget` is therefore reached only once that branch has declined, so the `"timeline"` case in the block above is defensive — it reproduces `:840`'s exact message and name should the branch order ever change, and keeps the two functions' timeline rule textually identical.

### F4 — Library-root validation and an honest `ensureDeepFolder`

**File:** `jsx/core.jsx` · **Conditions:** 1.6, 1.7

**(a)** Insert above `ensureDeepFolder` (`:458`):

```javascript
// A library root must be an ABSOLUTE path before it is used as a path prefix.
// Without this, an empty or relative root turns "<root>/comp/<cat>/<id>" into
// "/comp/<cat>/<id>" and ensureDeepFolder creates that tree at the volume root,
// writing the template outside the library where no scan will ever find it.
// Accepts drive-letter ("C:/x"), UNC ("//server/share/x") and POSIX ("/Users/x").
function isAbsoluteLibraryRoot(pathStr) {
    if (pathStr === null || pathStr === undefined) return false;
    var p = trimStr("" + pathStr).replace(/\\/g, "/");
    if (p.length === 0) return false;
    if (/^[A-Za-z]:\//.test(p)) return true;
    if (p.substr(0, 2) === "//") return true;
    if (p.charAt(0) === "/") return true;
    return false;
}

// Validate a resolved library root BEFORE any folder is created and before the
// destructive window is entered. The root must be absolute AND resolvable: the
// folder itself exists, or its immediate parent does (so a first-run library can
// still be created). Returns { ok:true, path:String } | { ok:false, error:String }.
function validateLibraryRoot(pathStr) {
    var p = (pathStr === null || pathStr === undefined)
        ? "" : trimStr("" + pathStr).replace(/\\/g, "/");
    if (p.length === 0) {
        return { ok: false, error: "No library root path was provided." };
    }
    if (!isAbsoluteLibraryRoot(p)) {
        return { ok: false, error: "Library root is not an absolute path: " + p };
    }
    p = p.replace(/\/+$/, "");
    var f = new Folder(p);
    if (f.exists) return { ok: true, path: p };
    var parent = null;
    try { parent = f.parent; } catch (eP) { parent = null; }
    if (parent && parent.exists) return { ok: true, path: p };
    return { ok: false, error: "Library root does not exist and cannot be created: " + p };
}
```

**(b)** Replace `ensureDeepFolder` (`:458-473`). **Contract change:** returns a Folder that *exists*, or `null`.

```javascript
// Create a folder tree and REPORT failure. The old version discarded the
// boolean Folder.create() returns and handed back `new Folder(pathStr)`
// regardless, so its return value carried no success information at all and a
// caller that did not check `.exists` entered its destructive window with no
// target folder. Contract: a Folder that exists, or null.
function ensureDeepFolder(pathStr) {
    try {
        var norm = ("" + pathStr).replace(/\\/g, "/");
        var f = new Folder(norm);
        if (f.exists) return f;

        var parts = norm.split("/");
        var current = parts[0];
        var i;
        for (i = 1; i < parts.length; i++) {
            if (parts[i] === "") continue; // collapse "//" runs
            current = current + "/" + parts[i];
            var cf = new Folder(current);
            if (!cf.exists) {
                var created = false;
                try { created = cf.create(); } catch (eC) { created = false; }
                // Re-test: some volumes/drivers report false yet do create it.
                if (!created && !cf.exists) return null;
            }
        }
        var out = new Folder(norm);
        return out.exists ? out : null;
    } catch (e) {
        return null;
    }
}
```

**(c)** In `saveActiveComp`, validate the root before deriving the path (replaces `:828-830`):

```javascript
        var rootCheck = validateLibraryRoot(r);
        if (!rootCheck.ok) {
            log("invalid library root");
            return encodeBridge("Error: " + logMsg + " -> " + rootCheck.error);
        }

        var templateId = generateTemplateId(name);
        var targetFolderPath = rootCheck.path + "/comp/" + getSafeName(cat) + "/" + templateId;
```

**(d)** `ensureDeepFolder`'s `null` return needs a guard at the call sites that dereference it. `jsx/templates_save.jsx:844` already has one; add the same shape at `jsx/templates_save.jsx:653` (covered in F2b), `:1371`, `:2004`, and `jsx/text.jsx:25`, `:460`, `:748`, following each file's error convention, e.g.:

```javascript
        var folder = ensureDeepFolder(targetFolderPath);
        if (!folder || !folder.exists) {
            return encodeBridge("ERROR:Failed to create folder: " + targetFolderPath);
        }
```

The fire-and-forget call sites (`jsx/core.jsx:1364`, `jsx/import.jsx:1876`, `:1994`, `jsx/templates_save.jsx:1190`, `:1255`) ignore the return value and are unaffected; their subsequent `File`/`Folder` operations already fail with their own named errors.

### F5 — One canonical sanitizer, loaded at runtime

**Conditions:** 1.8, 1.26, 1.27

**(a) `js/core/pathBuilders.js`** — replace `sanitizeName`/`getSafeName`/`generateTemplateId` (`:33-78`) with the canonical rules. `getSafeName`/`generateTemplateId` now return **strings** (so they are drop-in replacements for the panel's and host's current signatures); the `{ok,…}` envelope lives on under `sanitizeNameStrict`.

```javascript
// Windows reserved device names — a folder with one of these names is not
// addressable, so it must be escaped rather than passed through.
var PATH_BUILDER_RESERVED = {
    "con": true, "prn": true, "aux": true, "nul": true,
    "com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
    "com6": true, "com7": true, "com8": true, "com9": true,
    "lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
    "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true
};
var PATH_BUILDER_FALLBACK_NAME = "_untitled";

// cleanName — the panel twin of the host's cleanStr (jsx/core.jsx:64): strip
// CR/LF/TAB, collapse whitespace runs to one space, trim. The host applies this
// BEFORE sanitizing (generateTemplateId(cleanStr(name)) in saveActiveComp); the
// panel did not, so any name containing a tab or a run of spaces produced a
// different folder name on the two sides. Idempotent, so folding it into
// generateTemplateId on both sides is safe.
function cleanName(s) {
    if (s === null || s === undefined) return "";
    var out = String(s);
    out = out.replace(/[\n\r\t]/g, "");
    out = out.replace(/\s+/g, " ");
    out = out.replace(/^\s+/, "").replace(/\s+$/, "");
    return out;
}

// sanitizeNameStrict — the ONE filesystem-safe-name rule for the whole product
// (panel + host + tests). Applied in order:
//   1. trim
//   2. replace \ / : * ? " < > | and every C0 control / DEL with "_"
//   3. strip trailing dots and spaces (Windows silently drops them, so
//      "name." and "name" would collide on disk but not in the index)
//   4. escape the traversal names "." and ".." and the reserved device names
//   5. truncate to PATH_BUILDER_MAX_NAME_LENGTH, then re-strip trailing dots/spaces
// For any already-safe name (letters, digits, spaces, dashes, interior dots) the
// output is byte-identical to the previous host getSafeName, so NO existing
// library folder is re-keyed by this change. An EMPTY input still returns "" —
// preserving the shape of existing empty-category paths — while a non-empty
// input that reduces to nothing becomes the fallback.
// Returns { ok:Boolean, value:String, error?:String }.
function sanitizeNameStrict(name) {
    if (name === null || name === undefined) {
        return { ok: false, value: "", error: "Invalid name: name is empty." };
    }
    var s = String(name);
    s = s.replace(/^\s+/, "").replace(/\s+$/, "");
    if (s.length === 0) {
        return { ok: false, value: "", error: "Invalid name: name is empty." };
    }
    s = s.replace(/[\\\/:\*\?"<>\|]/g, "_");
    s = s.replace(/[\u0000-\u001F\u007F]/g, "_");
    s = s.replace(/[. ]+$/, "");
    if (s.length > PATH_BUILDER_MAX_NAME_LENGTH) {
        s = s.substring(0, PATH_BUILDER_MAX_NAME_LENGTH);
        s = s.replace(/[. ]+$/, "");
    }
    if (s.length === 0) {
        return { ok: false, value: PATH_BUILDER_FALLBACK_NAME, error: "Invalid name: sanitized to zero characters." };
    }
    if (s === "." || s === "..") {
        return { ok: false, value: PATH_BUILDER_FALLBACK_NAME, error: "Invalid name: path-traversal name." };
    }
    var bare = s.toLowerCase();
    var dot = bare.indexOf(".");
    if (dot > 0) bare = bare.substring(0, dot);
    if (PATH_BUILDER_RESERVED[bare] === true) {
        return { ok: false, value: "_" + s, error: "Invalid name: reserved device name." };
    }
    return { ok: true, value: s };
}

// Filesystem-safe category/name segment. Always a String.
function getSafeName(name) {
    return sanitizeNameStrict(name).value;
}

// Filesystem-safe template id. Folds in cleanName so it matches the host's
// generateTemplateId(cleanStr(name)) exactly.
function generateTemplateId(name) {
    return sanitizeNameStrict(cleanName(name)).value;
}
```

Add `cleanName` and `sanitizeNameStrict` to the `module.exports` block at `:107-118`.

**(b) `jsx/core.jsx`** — replace `getSafeName` (`:74-78`) and `generateTemplateId`/`getDeterministicTemplateId` (`:317-323`) with the ES3 port of the identical algorithm:

```javascript
var CS_MAX_NAME_LENGTH = 255;
var CS_FALLBACK_NAME = "_untitled";
var CS_RESERVED_NAMES = {
    "con": true, "prn": true, "aux": true, "nul": true,
    "com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
    "com6": true, "com7": true, "com8": true, "com9": true,
    "lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
    "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true
};

// The ONE canonical filesystem-safe-name rule, kept byte-identical to
// sanitizeNameStrict in js/core/pathBuilders.js (that module is the tested
// implementation AND, after this fix, the one the panel loads). The old version
// replaced only \ / : * ? " < > | — so ".", "..", "name." and "" passed through
// unchanged and wrote a template's files outside its own folder.
function csSanitizeName(s) {
    if (s === null || s === undefined) return { ok: false, value: "" };
    var v = trimStr("" + s);
    if (v.length === 0) return { ok: false, value: "" };
    v = v.replace(/[\\\/:\*\?"<>\|]/g, "_");
    v = v.replace(/[\u0000-\u001F\u007F]/g, "_");
    v = v.replace(/[. ]+$/, "");
    if (v.length > CS_MAX_NAME_LENGTH) {
        v = v.substring(0, CS_MAX_NAME_LENGTH);
        v = v.replace(/[. ]+$/, "");
    }
    if (v.length === 0) return { ok: false, value: CS_FALLBACK_NAME };
    if (v === "." || v === "..") return { ok: false, value: CS_FALLBACK_NAME };
    var bare = v.toLowerCase();
    var dot = bare.indexOf(".");
    if (dot > 0) bare = bare.substring(0, dot);
    if (CS_RESERVED_NAMES[bare] === true) return { ok: false, value: "_" + v };
    return { ok: true, value: v };
}

function getSafeName(s) {
    return csSanitizeName(s).value;
}
```

and, replacing `:317-323`:

```javascript
function generateTemplateId(name) {
    return csSanitizeName(cleanStr(name)).value;
}

function getDeterministicTemplateId(name) {
    return generateTemplateId(name);
}
```

`cleanStr` is idempotent, so `generateTemplateId(cleanStr(name))` at `jsx/templates_save.jsx:818` keeps producing the same id it does today.

**(c) `js/core/utils.js`** — delete `getSafeName` (`:20-24`) entirely. `pathBuilders.js` becomes the single panel definition; leaving both would make the folder-name rules depend on script order.

**(d) `index.html`** — load the canonical module before its consumers (insert after the `bridge.js` line at `:1583`):

```html
            <script src="js/core/pathBuilders.js?v=1"></script>
```

This also repairs `js/templates/templates.js:2432`, where `typeof generateTemplateId === "function" ? generateTemplateId(fsName) : fsName` had been silently falling through to the raw, unsanitized name because the module was never loaded.

**(e) `js/templates/templates.js`** — apply the host's exact derivation at the three panel-derived path sites. `:3246`:

```javascript
                                    var pngFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + pngSec + "/" + getSafeName(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
```

`:3421`:

```javascript
                                    var folderPathT = ((savePath || rootPath).replace(/\\/g, "/") + "/" + folderNameT + "/" + getSafeName(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
```

`:3487`:

```javascript
                                            optFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + optSec + "/" + getSafeName(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
```

and the monolithic metadata-cache seed at `:3426` uses `id: generateTemplateId(name)` in place of `getSafeName(name)`.

### F6 — Metadata fidelity, targeted thumbnail, borrowed playhead

**Conditions:** 1.9, 1.10, 1.11, 1.12

**(a) `js/templates/templates.js`** — extend the `meta.json` document (replaces `:3298-3337`). The format fields come from the F1 capture; `dim` is the string field `parseMetaContent` (`jsx/core.jsx:1064`) has always read and nothing ever wrote.

```javascript
                                            var metaObj = {
                                                schemaVersion: 2,
                                                id: templateId,
                                                name: resObj.name,
                                                section: resObj.section || "comp",
                                                type: resObj.type || "comp",
                                                category: resObj.category,
                                                mainFile: "project.aep",
                                                thumbnail: "thumbnail.png",
                                                hasFrames: false,
                                                frameCount: 0,
                                                createdAt: now,
                                                updatedAt: now
                                            };
                                            // Composition format (host-captured pre-reopen) so a
                                            // consumer can present it without opening the .aep.
                                            if (typeof resObj.width === "number" && resObj.width > 0 &&
                                                typeof resObj.height === "number" && resObj.height > 0) {
                                                metaObj.width = resObj.width;
                                                metaObj.height = resObj.height;
                                                metaObj.dim = resObj.width + "x" + resObj.height;
                                            }
                                            if (typeof resObj.pixelAspect === "number" && resObj.pixelAspect > 0) {
                                                metaObj.pixelAspect = resObj.pixelAspect;
                                            }
                                            if (typeof resObj.frameRate === "number" && resObj.frameRate > 0) {
                                                metaObj.frameRate = resObj.frameRate;
                                            }
                                            if (typeof resObj.duration === "number" && resObj.duration >= 0) {
                                                metaObj.duration = resObj.duration;
                                            }
                                            // Key off the SAME normalized value written above, so a
                                            // host result that omits `section` still records assetsDir.
                                            if (metaObj.section === "comp") {
                                                metaObj.assetsDir = assetsList.length > 0 ? "assets/" : "";
                                            }
```

The `resObj.type === "layer" | "text" | "footage" | "text_props" | "effect"` blocks at `:3338-3358` are unchanged.

**(b) `jsx/text.jsx`** — add the name-targeted lookup next to `findCompItemInFolder` (`:635`):

```javascript
/**
 * Locate a CompItem by EXACT name anywhere inside an imported folder tree, so a
 * background thumbnail renders the composition the save engine recorded rather
 * than whichever comp happens to enumerate first. Falls back to a
 * case-insensitive match. ES3: iterative breadth-first walk, no Array extras
 * beyond push/shift. Returns the CompItem or null.
 */
function findCompItemInFolderByName(folderItem, wantName) {
    if (!folderItem || !wantName) return null;
    var target = "" + wantName;
    var targetLower = target.toLowerCase();
    var exact = null;
    var loose = null;
    var queue = [folderItem];
    while (queue.length > 0) {
        var f = queue.shift();
        var n = 0;
        try { n = f.numItems; } catch (eN) { n = 0; }
        var i;
        for (i = 1; i <= n; i++) {
            var child = null;
            try { child = f.item(i); } catch (eI) { child = null; }
            if (!child) continue;
            if (child instanceof FolderItem) { queue.push(child); continue; }
            if (child instanceof CompItem) {
                if (child.name === target) { exact = child; break; }
                if (!loose && ("" + child.name).toLowerCase() === targetLower) loose = child;
            }
        }
        if (exact) break;
    }
    return exact ? exact : loose;
}
```

**(c) `jsx/templates_save.jsx`** — `renderTemplateThumbnail` (`:358`) takes the recorded target. Signature and decode (replaces `:358-368`):

```javascript
function renderTemplateThumbnail(aepPathHex, outPngPathHex, compNameHex, frameHex) {
    var importedFolder = null;
    var wrapperComp = null;
    var oldDepth = null;
    var dlgSuppressed = false;
    try {
        var aepPath = decodeBridge(aepPathHex || "");
        var outPng = decodeBridge(outPngPathHex || "");
        // Both optional: absent means "first comp, 30% into the work area",
        // which is exactly the previous behavior (back-compat for a 2-arg call).
        var wantComp = compNameHex ? decodeBridge(compNameHex) : "";
        var wantFrame = -1;
        if (frameHex) {
            var frameRaw = decodeBridge(frameHex);
            if (frameRaw !== "") {
                var frameNum = parseInt(frameRaw, 10);
                if (!isNaN(frameNum) && frameNum >= 0) wantFrame = frameNum;
            }
        }
```

Comp selection (replaces `:387-390`):

```javascript
            importedFolder = app.project.importFile(new ImportOptions(aepFile));
            // Target the comp the save engine recorded; only fall back to the
            // first comp when no name was supplied or it is not in this .aep.
            if (wantComp) srcComp = findCompItemInFolderByName(importedFolder, wantComp);
            if (!srcComp) srcComp = findCompItemInFolder(importedFolder);
```

Frame selection (replaces `:432`):

```javascript
        // Render the recorded frame so the in-project fallback produces the SAME
        // frame the isolated aerender path produces. Clamped into the comp so a
        // stale frame index can never push the time past the end.
        var thumbTime;
        if (wantFrame >= 0 && renderComp.frameRate > 0) {
            thumbTime = wantFrame / renderComp.frameRate;
            var maxTime = renderComp.duration - (1 / renderComp.frameRate);
            if (!(maxTime > 0)) maxTime = 0;
            if (thumbTime > maxTime) thumbTime = maxTime;
            if (!(thumbTime >= 0)) thumbTime = 0;
        } else {
            thumbTime = renderComp.workAreaStart + renderComp.workAreaDuration * 0.3;
        }
        var res = renderFrameToPng(renderComp, thumbTime, outFile);
```

(`renderComp` here is the existing local for the bounded-resolution wrapper, created with `srcComp.frameRate`/`duration` at `:405-410`, so the conversion is correct for both the wrapper and the direct path.)

**(d) `js/textanim/textanim.js`** — pass the recorded target (replaces `:1333-1336`):

```javascript
        function runInProject() {
            // Forward the comp name + frame the save engine recorded so the
            // in-project fallback renders the same frame aerender would. Both are
            // optional host-side; an empty string means "use the default".
            var frameArg = (typeof job.renderFrame === "number" && job.renderFrame >= 0)
                ? String(job.renderFrame) : "";
            var jsx = 'renderTemplateThumbnail("' +
                encodeBridge(job.aepPath) + '","' +
                encodeBridge(job.outPngPath) + '","' +
                encodeBridge(job.compName || "") + '","' +
                encodeBridge(frameArg) + '")';
```

`job.compName` / `job.renderFrame` are already carried on the job by `enqueueThumbnailRender` — the aerender branch at `:1315-1320` reads both.

**(e) `jsx/helpers.jsx`** — restore the borrowed playhead (replaces `renderFrameToPng`, `:126-147`):

```javascript
function renderFrameToPng(comp, time, outFile) {
    // Req 2.12: remember the composition's current time BEFORE any mutation and
    // restore it in the finally on both the success and the failure path. Most
    // callers pass a scratch/temp comp, but generateActiveFrameThumbnail passes
    // the LIVE composition, so focusing the frame used to move the user's
    // playhead permanently.
    var prevTime = null;
    var timeChanged = false;
    try { prevTime = comp.time; } catch (ePrev) { prevTime = null; }

    // Req 3.1: enable dialog suppression before rendering so a modal dialog can
    // never stall the render.
    app.beginSuppressDialogs();
    try {
        // Minimal prep as MNTOOLS does: focus the target frame when a time is
        // supplied. Guarded so a rejected time assignment does not abort render.
        if (time !== undefined && time !== null) {
            try { comp.time = time; timeChanged = true; } catch (eTime) { }
        }
        comp.saveFrameToPng(time, outFile);
    } catch (e) {
        // Req 3.2: a thrown render reports failure - never success.
        return { success: false, error: e.toString() };
    } finally {
        // Req 2.12: restore the playhead first, then release suppression. Each
        // step is independently guarded so one failure cannot skip the other or
        // change the reported result.
        if (timeChanged && prevTime !== null) {
            try { comp.time = prevTime; } catch (eRestore) { }
        }
        // Req 3.1/3.2: ALWAYS restore suppression, even when the render throws,
        // so dialog suppression can never get stuck on.
        try { app.endSuppressDialogs(false); } catch (eEnd) { }
    }
    // Req 3.3/3.4: success only when the output is a Valid PNG.
    return { success: isValidPng(outFile) };
}
```

### F7 — One `itemExists` contract, with the section

**Conditions:** 1.13, 1.14

**(a) `jsx/import.jsx`** — replace `itemExists` (`:2088-2123`):

```javascript
// ONE contract for both sides. Returns an encoded JSON envelope:
//   {"exists":true,"id":"<existing folder name>","section":"<section>"}
//   {"exists":false,"section":"<section>"}
// The old version used the matched folder's NAME as the hit signal while the
// panel compared the decoded reply against the literal "true" — always false, so
// the overwrite prompt never appeared, oldId was always "", and the .fav
// preservation plus old-folder removal in the background finalizer were
// unreachable. `id` is the folder that ACTUALLY exists, which is what those two
// steps need. `section` is echoed back so a mismatch is diagnosable.
function itemExists(nHex, cHex, rHex, sHex) {
    var section = "comp";
    try {
        var name = cleanStr(decodeBridge(nHex));
        var c = getSafeName(cleanStr(decodeBridge(cHex)));
        var r = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");

        // Search the section actually being saved. The panel now always supplies
        // it; the "comp" default remains only for a legacy 3-argument caller.
        if (sHex) {
            var sDecoded = normalizeSectionName(cleanStr(decodeBridge(sHex)));
            if (sDecoded) section = sDecoded;
        }

        if (!name) return encodeBridge(jsonStringify({ exists: false, section: section }));

        var catFolder = new Folder(r + "/" + section + "/" + c);
        if (!catFolder.exists) return encodeBridge(jsonStringify({ exists: false, section: section }));

        var subfolders = catFolder.getFiles();
        if (!subfolders) return encodeBridge(jsonStringify({ exists: false, section: section }));

        var nameLower = name.toLowerCase();
        var i;
        for (i = 0; i < subfolders.length; i++) {
            if (!(subfolders[i] instanceof Folder)) continue;
            var metaFile = new File(subfolders[i].fsName + "/meta.json");
            if (!metaFile.exists) continue;
            var mObj = {};
            // Security (Phase 1): strict parser, never eval (see csReadTemplateMeta).
            try { mObj = jsonParse(readFileText(metaFile)); } catch (eParse) { mObj = {}; }
            if (mObj && mObj.name && ("" + mObj.name).toLowerCase() === nameLower) {
                return encodeBridge(jsonStringify({
                    exists: true,
                    id: subfolders[i].name,
                    section: section
                }));
            }
        }
        return encodeBridge(jsonStringify({ exists: false, section: section }));
    } catch (e) {
        // A failed CHECK must not silently claim "no existing template" — report
        // it so the caller can decide.
        return encodeBridge(jsonStringify({
            exists: false,
            section: section,
            error: e.toString()
        }));
    }
}
```

**(b) `js/templates/templates.js`** — replace the existence check (`:3164-3189`). Routed through the timeout-guarded `callHost`, and `oldId` is now the folder that exists:

```javascript
            var nHex = encodeBridge(name);
            var cHex = encodeBridge(cat);
            var rHex = encodeBridge(savePath || rootPath);
            // Pass the section being saved — the host used to default to "comp"
            // and check the wrong section for layer/text/footage/effect saves.
            var existsSection = (saveType === "png") ? targetImgSec : saveType;
            var sHex = encodeBridge(existsSection);

            callHost('itemExists("' + nHex + '","' + cHex + '","' + rHex + '","' + sHex + '")')
                .then(function (outcome) {
                    var info = { exists: false, id: "" };
                    if (outcome && outcome.ok && outcome.result &&
                        ("" + outcome.result).charAt(0) === "{") {
                        try { info = JSON.parse(outcome.result); } catch (eJson) { info = { exists: false, id: "" }; }
                    }
                    var exists = info.exists === true;

                    if (exists && Settings.get("library.confirmOverwrite")) {
                        var ok = confirm('"' + name + '" already exists. Overwrite?');
                        if (!ok) {
                            saveBtn.disabled = false;
                            saveBtn.textContent = "Save";
                            return;
                        }
                    }

                    // The id of the folder that ACTUALLY exists, so the background
                    // finalizer's .fav preservation and old-folder removal operate
                    // on a real path instead of a name that may not match it.
                    var oldId = exists ? (info.id || generateTemplateId(name)) : "";
                    var oldIdHex = encodeBridge(oldId);

                    closeSaveModal();
                    saveBtn.textContent = "Saving...";
                    // …unchanged from here (runSave definition + runSave() call)
                });
```

**(c) `js/core/bridgeRegistry.js`** — correct the declared contract (`:56`):

```javascript
    addEncoded("templates.item-exists", "itemExists", ["name", "category", "rootPath", "section"],
        "decodeBridge+json-object", ["{exists:Boolean,id?:String,section:String}"],
        "js/templates/templates.js:confirmSave", ERROR_SENTINELS, {
        transportPolicy: "guarded-callHost", timeoutPolicy: GUARDED_TIMEOUT,
        callbackBehavior: "promise-never-rejects-first-settlement-wins"
    });
```

### F8 — Transport integrity

**Conditions:** 1.15, 1.16, 1.17

**(a) `js/core/bridge.js`** — replace `decodeBridge` (`:23-30`):

```javascript
// A well-formed Bridge payload is a multiple of 4 hex digits: encodeBridge emits
// exactly one 4-digit UTF-16 code unit per character. Validating the WHOLE string
// once with a single native regex keeps the hot decode loop untouched — no
// per-chunk work, and no array+join rewrite (that was measured 5x slower host-side).
var BRIDGE_HEX_RE = /^[0-9a-fA-F]*$/;

function isWellFormedBridgeHex(hex) {
    if (hex === null || hex === undefined) return false;
    var s = "" + hex;
    if (s.length % 4 !== 0) return false;
    return BRIDGE_HEX_RE.test(s);
}

// Strict decode with an explicit failure result. Both sides of the Bridge run
// this identical algorithm, so a truncated or corrupted transfer can no longer
// decode into two DIFFERENT strings — the panel used to emit U+0000 for a bad
// chunk (String.fromCharCode(NaN)) while the host silently skipped it, and a
// trailing partial chunk produced a plausible but wrong character on both sides.
function decodeBridgeStrict(hex) {
    if (hex === null || hex === undefined || hex === "") return { ok: true, value: "" };
    var s = "" + hex;
    if (!isWellFormedBridgeHex(s)) {
        return {
            ok: false,
            value: "",
            error: "Malformed Bridge payload (" + s.length +
                " chars; expected a multiple of 4 hex digits)"
        };
    }
    var str = "";
    for (var i = 0; i < s.length; i += 4) {
        str += String.fromCharCode(parseInt(s.substr(i, 4), 16));
    }
    return { ok: true, value: str };
}

// Back-compatible wrapper: same signature and return type as before, but a
// malformed payload now yields "" on BOTH sides instead of a silently corrupted
// string. Callers that must distinguish "empty" from "malformed" use
// decodeBridgeStrict — callHost does.
function decodeBridge(hex) {
    return decodeBridgeStrict(hex).value;
}
```

In `callHost`'s completion callback (replaces `:110-116`):

```javascript
                if (!raw || BRIDGE_ERROR_SENTINELS[raw] === true) {
                    finish({ ok: false, error: raw ? String(raw) : "Empty host response" });
                    return;
                }
                // A malformed/truncated payload is reported, never decoded into a
                // corrupted string that then fails a "true" comparison for an
                // operation that actually succeeded.
                var decoded = decodeBridgeStrict(raw);
                if (!decoded.ok) {
                    finish({ ok: false, error: decoded.error });
                    return;
                }
                finish({ ok: true, result: decoded.value });
```

and add `decodeBridgeStrict` + `isWellFormedBridgeHex` to `module.exports` (`:125-131`).

**(b) `jsx/core.jsx`** — the identical host implementation (replaces `decodeBridge`, `:32-43`):

```javascript
// Same measured conclusion as encodeBridge: string append beats array+join in
// ExtendScript, so the loop below is unchanged. The added validation is ONE
// native regex pass over the payload, not per-chunk work.
var CS_BRIDGE_HEX_RE = /^[0-9a-fA-F]*$/;

function isWellFormedBridgeHex(hex) {
    if (hex === null || hex === undefined) return false;
    var s = "" + hex;
    if (s.length % 4 !== 0) return false;
    return CS_BRIDGE_HEX_RE.test(s);
}

// Byte-for-byte the same algorithm as decodeBridgeStrict in js/core/bridge.js:
// a malformed payload is REPORTED on both sides instead of being decoded into
// two different corrupted strings.
function decodeBridgeStrict(hex) {
    if (hex === null || hex === undefined || hex === "") return { ok: true, value: "" };
    var s = "" + hex;
    if (!isWellFormedBridgeHex(s)) {
        return {
            ok: false,
            value: "",
            error: "Malformed Bridge payload (" + s.length +
                " chars; expected a multiple of 4 hex digits)"
        };
    }
    var str = "";
    var i;
    for (i = 0; i < s.length; i = i + 4) {
        str = str + String.fromCharCode(parseInt(s.substr(i, 4), 16));
    }
    return { ok: true, value: str };
}

function decodeBridge(hex) {
    return decodeBridgeStrict(hex).value;
}
```

**(c) `jsx/core.jsx`** — valid-JSON `escapeJSON` (replaces `:80-88`):

```javascript
// Emit VALID JSON. The old version passed control characters through raw and
// DELETED \r outright, so jsonStringify — which routes every string and every
// key through here — could produce a document the panel's JSON.parse rejects,
// surfacing a COMPLETED save as "JSON Parse Error".
// The control-character scan is a single native regex test, so the common case
// (no controls, which is every cleanStr'd string) costs one pass and skips the
// escape loop entirely — this runs for every string in a 326-template scan.
var CS_CTRL_RE = /[\u0000-\u001F\u007F]/;
var CS_HEX_DIGITS = "0123456789abcdef";

function escapeJSON(s) {
    if (s === null || s === undefined) return "";
    s = "" + s;
    s = s.replace(/\\/g, "\\\\");
    s = s.replace(/"/g, '\\"');
    s = s.replace(/\n/g, "\\n");
    s = s.replace(/\r/g, "\\r");
    s = s.replace(/\t/g, "\\t");
    s = s.replace(/\u0008/g, "\\b");
    s = s.replace(/\u000C/g, "\\f");
    if (!CS_CTRL_RE.test(s)) return s;
    // Any remaining C0 control (and DEL) must be \u-escaped to stay valid JSON.
    var out = "";
    var i;
    for (i = 0; i < s.length; i++) {
        var code = s.charCodeAt(i);
        if (code < 32 || code === 127) {
            out = out + "\\u00" +
                CS_HEX_DIGITS.charAt((code >> 4) & 15) +
                CS_HEX_DIGITS.charAt(code & 15);
        } else {
            out = out + s.charAt(i);
        }
    }
    return out;
}
```

**(d) `jsx/import.jsx`** — use the strict decode for the batch payload (replaces `:521-531`):

```javascript
    var payload = null;
    try {
        // The typeof guard follows the same convention as the jsonParse guard
        // below: a slice-harness that injects only decodeBridge still works, so
        // tests/import-timings.test.js needs no harness change.
        var decodedPayload = (typeof decodeBridgeStrict === "function")
            ? decodeBridgeStrict(payloadHex)
            : { ok: true, value: decodeBridge(payloadHex) };
        if (!decodedPayload.ok) {
            return encodeBridge(jsonStringify({
                perTemplate: [],
                error: "Batch payload decode failed: " + decodedPayload.error
            }));
        }
        // Security (Phase 1): strict parser instead of eval — the payload is
        // pure JSON from the panel and must never execute as code. The typeof
        // guard covers slice-harnesses without core.jsx (strict built-in
        // JSON.parse); the AE host uses jsonParse.
        payload = (typeof jsonParse === "function")
            ? jsonParse(decodedPayload.value)
            : JSON.parse(decodedPayload.value);
    } catch (eDecode) {
        return encodeBridge(jsonStringify({ perTemplate: [], error: "Batch payload decode failed: " + eDecode.toString() }));
    }
```

**(e) `js/core/importEngine.js`** — propagate the host's whole-call error so it reaches every entry (replaces `:113`):

```javascript
    return { map: map, error: (parsed.error != null ? "" + parsed.error : null) };
```

**(f) `js/templates/templates.js`** — the guarded import transport (replaces `:2412-2415` and the `decode` entry at `:2450`):

```javascript
            // Transport: EXACTLY ONE Bridge_Call carrying the batch payload,
            // routed through the timeout-guarded wrapper. Without it a host call
            // that never returns left the card stuck with .importing, no toast
            // and no way to retry, and a CEP "EvalScript error." sentinel was
            // fed to decodeBridge as if it were hex. callHost owns the settled
            // latch, the timeout and the sentinel classification, and always
            // settles — so the result callback (which clears .importing) always
            // runs. It already decoded the reply, hence the identity `decode`.
            callHost: function (payloadHex, cb) {
                callHost('importBatch("' + payloadHex + '")', { timeoutMs: 120000 })
                    .then(function (outcome) {
                        if (outcome && outcome.ok) { cb(outcome.result); return; }
                        var reason = (outcome && outcome.timedOut)
                            ? "Import timed out — After Effects did not respond"
                            : ((outcome && outcome.error) || "Import failed");
                        cb(JSON.stringify({ perTemplate: [], error: reason }));
                    });
            },
```

```javascript
            encode: encodeBridge,
            // callHost already decoded the host reply.
            decode: function (s) { return s == null ? "" : "" + s; }
```

### F9 — Import atomicity and Project-panel hygiene

**Conditions:** 1.18, 1.19, 1.20

**(a) `jsx/import.jsx`** — the commit latch in `importCompDirect`. Replace `:1442-1443`:

```javascript
            // Cleanup is owned by scope exit, not by individual exit points.
            // The early returns below ("Import failed!", "No comp found!",
            // "Cannot create recursive nesting!", "Cannot add comp to timeline.")
            // used to leave the imported comp, footage and folders in the user's
            // project on every standalone call.
            var importCommitted = false;
            csBeginUndoGroup("Import Comp");
            try {
```

Replace the success tail (`:1596-1603`):

```javascript
                if (!newLayer) {
                    return encodeBridge("Cannot add comp to timeline.");
                }

                placeLayerAtPlayhead(activeComp, newLayer, playheadTime, anchorLayer);
                // Req 6.3: force a single viewer refresh after the import edited the comp.
                try { forceCompViewerRefresh(activeComp); } catch (eVR) { }
                importCommitted = true;
                return encodeBridge("true");
            } finally {
                // Any exit that is not a committed import removes every item
                // this call's importFile added, leaving the project exactly as
                // it was. Runs BEFORE csEndUndoGroup so the removals sit inside
                // the group; inside a batch csRollbackToSnapshot may remove the
                // same items, and each removal here is individually guarded so
                // the second pass is a no-op.
                if (!importCommitted) {
                    try { cleanupImportedItems(allImportedItems); } catch (eCleanup) { }
                }
                csEndUndoGroup();
            }
```

The same latch goes into `importLayerTypeAep` (`:965-966` / `:1337-1339`), set on **both** success returns: the Utility Pre-Comp branch at `:1187` and the normal tail at `:1294`.

**(b) `jsx/import.jsx`** — replace `toolkitOrganizeTemplateImport` (`:877-935`):

```javascript
// One dedicated, reused container for every CompSaver import.
// The old version named the container after the imported comp — but
// safeRenameAllImportedItems has already made that name unique against EVERY
// existing item name, folders included, so the "find existing folder" scan could
// provably never match and each import added another root-level folder
// (Name, Name 2, Name 3, …). A fixed name is findable, so it is created once.
var CS_ASSETS_FOLDER_NAME = "_CompSaver_Assets";

function csFindOrCreateRootFolder(folderName) {
    var i;
    for (i = 1; i <= app.project.numItems; i++) {
        var item = null;
        try { item = app.project.item(i); } catch (eItem) { item = null; }
        if (!item) continue;
        if (item instanceof FolderItem &&
            item.name === folderName &&
            item.parentFolder === app.project.rootFolder) {
            return item;
        }
    }
    var made = null;
    try { made = app.project.items.addFolder(folderName); } catch (eAdd) { made = null; }
    return made;
}

function csFindOrCreateSubFolder(parentFolder, folderName) {
    var i;
    for (i = 1; i <= parentFolder.numItems; i++) {
        var sub = null;
        try { sub = parentFolder.item(i); } catch (eSub) { sub = null; }
        if (sub && sub instanceof FolderItem && sub.name === folderName) return sub;
    }
    var made = null;
    try { made = parentFolder.items.addFolder(folderName); } catch (eAdd2) { made = null; }
    return made;
}

function toolkitOrganizeTemplateImport(allImportedItems, mainComp) {
    if (!mainComp) return;
    try {
        var rootFolder = csFindOrCreateRootFolder(CS_ASSETS_FOLDER_NAME);
        if (!rootFolder) return;

        // Partition: real assets (non-solid footage + secondary comps) want an
        // Assets subfolder; the FolderItems importFile created are containers,
        // never assets, and are swept separately below.
        var assetsToMove = [];
        var foldersSeen = [];
        var needsAssets = false;
        var i;
        for (i = 0; i < allImportedItems.length; i++) {
            var imp = allImportedItems[i];
            if (!imp) continue;
            var impId = null;
            try { impId = imp.id; } catch (eId) { impId = null; }
            if (!impId || impId === mainComp.id || impId === rootFolder.id) continue;

            if (imp instanceof FolderItem) {
                foldersSeen.push(imp);
                continue;
            }
            if (imp instanceof FootageItem) {
                var isSolid = false;
                try { isSolid = (imp.mainSource instanceof SolidSource); } catch (eSrc) { }
                if (!isSolid) needsAssets = true;
            } else if (imp instanceof CompItem) {
                needsAssets = true;
            }
            assetsToMove.push(imp);
        }

        try { mainComp.parentFolder = rootFolder; } catch (eMain) { }

        if (needsAssets && assetsToMove.length > 0) {
            var assetsFolder = csFindOrCreateSubFolder(rootFolder, "Assets");
            if (assetsFolder) {
                var m;
                for (m = 0; m < assetsToMove.length; m++) {
                    try { assetsToMove[m].parentFolder = assetsFolder; } catch (eMove) { }
                }
            }
        } else {
            // Solid-only import: the items still belong under the container so
            // nothing is left loose at the Project-panel root.
            var s;
            for (s = 0; s < assetsToMove.length; s++) {
                try { assetsToMove[s].parentFolder = rootFolder; } catch (eMove2) { }
            }
        }

        // The FolderItem importFile created for the .aep is empty once its
        // children were reparented above — remove it instead of leaving an empty
        // folder at the root (the old code skipped this entirely whenever
        // needsAssets was false, i.e. for every solid-only template). A folder
        // that still holds something is reparented under the container instead.
        var fi;
        for (fi = foldersSeen.length - 1; fi >= 0; fi--) {
            var fold = foldersSeen[fi];
            var count = -1;
            try { count = fold.numItems; } catch (eCount) { count = -1; }
            if (count === 0) {
                try { fold.remove(); } catch (eRemove) { }
            } else if (count > 0) {
                try { fold.parentFolder = rootFolder; } catch (eReparent) { }
            }
        }
    } catch (err) { }
}
```

### F10 — Anchor by reference, latched per batch

**Conditions:** 1.21, 1.22

**(a) `jsx/templates_save.jsx`** — replace `placeLayerAtPlayhead` (`:10-36`):

```javascript
function placeLayerAtPlayhead(activeComp, newLayer, playheadTime, anchorLayer) {
    try {
        newLayer.startTime = 0;
        var inPoint = newLayer.inPoint;
        newLayer.startTime = playheadTime - inPoint;
    } catch (e) {
        try { newLayer.startTime = playheadTime; } catch (e2) { }
    }

    // Move relative to the anchor REFERENCE. The old code threw the still-valid
    // reference away and re-found the anchor by NAME, which is ambiguous by
    // construction: with two layers sharing the anchor's name the first match
    // won and the imported layer landed above the wrong layer. Layer references
    // stay valid across insertions (only indices shift), so moveBefore on the
    // reference is both exact and cheaper. The name scan survives ONLY as the
    // fallback for a genuinely stale reference — reading .index on an
    // invalidated reference throws, which is the liveness probe.
    if (anchorLayer) {
        var anchorUsable = false;
        try { anchorUsable = (anchorLayer !== newLayer && anchorLayer.index > 0); } catch (eIdx) { anchorUsable = false; }
        if (anchorUsable) {
            var moved = false;
            try { newLayer.moveBefore(anchorLayer); moved = true; } catch (eMove) { }
            if (!moved) {
                try {
                    var anchorName = anchorLayer.name;
                    var m;
                    for (m = 1; m <= activeComp.numLayers; m++) {
                        try {
                            var ml = activeComp.layer(m);
                            if (ml !== newLayer && ml.name === anchorName) {
                                if (newLayer.index !== m - 1) newLayer.moveBefore(ml);
                                break;
                            }
                        } catch (eLayer) { }
                    }
                } catch (eFallback) { }
            }
        }
    }

    try { deselectAllLayers(activeComp); } catch (e) { }
    try { newLayer.selected = true; } catch (e) { }
}
```

**(b) `jsx/import.jsx`** — the batch-scoped anchor latch, next to `__CS_IMPORT_BATCH_ACTIVE` (`:25`):

```javascript
// The anchor and the user's selection for an ENTIRE batch are the ones that
// existed before the action began. placeLayerAtPlayhead selects the layer it
// just inserted, so a per-template getTopSelectedLayer anchored template n to
// the layer template n-1 inserted instead of to the layer the user selected.
// Mirrors the __CS_IMPORT_BATCH_ACTIVE pattern: latched by importBatch, ignored
// entirely by a standalone import.
var __CS_IMPORT_BATCH_ANCHOR = null;

function csBatchAnchorBegin(comp) {
    __CS_IMPORT_BATCH_ANCHOR = null;
    if (!comp) return;
    var sel = [];
    try {
        var s = comp.selectedLayers;
        var i;
        for (i = 0; i < s.length; i++) sel.push(s[i]);
    } catch (eSel) { sel = []; }
    var anchor = null;
    try { anchor = getTopSelectedLayer(comp); } catch (eAnchor) { anchor = null; }
    var cid = null;
    try { cid = comp.id; } catch (eCid) { cid = null; }
    __CS_IMPORT_BATCH_ANCHOR = { compId: cid, anchor: anchor, selection: sel };
}

// Restore the user's pre-action selection and clear the latch. Selection is not
// an undoable mutation, so this is safe inside the single undo group.
function csBatchAnchorEnd(comp) {
    var latch = __CS_IMPORT_BATCH_ANCHOR;
    __CS_IMPORT_BATCH_ANCHOR = null;
    if (!latch || !comp) return;
    try { deselectAllLayers(comp); } catch (eDes) { }
    var i;
    for (i = 0; i < latch.selection.length; i++) {
        try { latch.selection[i].selected = true; } catch (eSelSet) { }
    }
}

// Anchor resolver for every per-section import routine. Inside a batch it
// returns the latched anchor (or null when the user had nothing selected, which
// stays null for the whole batch); standalone it behaves exactly as before.
function csResolveImportAnchor(comp) {
    var latch = __CS_IMPORT_BATCH_ANCHOR;
    if (latch && comp) {
        var cid = null;
        try { cid = comp.id; } catch (eCid) { cid = null; }
        if (cid !== null && cid === latch.compId) {
            if (latch.anchor) {
                var live = false;
                try { live = latch.anchor.index > 0; } catch (eIdx) { live = false; }
                if (live) return latch.anchor;
            }
            return null;
        }
    }
    try { return getTopSelectedLayer(comp); } catch (eTop) { return null; }
}
```

**(c) `jsx/import.jsx`** — latch it in `importBatch`. After `csImportIoBegin(seededMeta);` (`:569`):

```javascript
    // Latch the pre-action anchor + selection ONCE for the whole batch.
    var batchAnchorComp = null;
    try {
        batchAnchorComp = app.project.activeItem;
        if (!(batchAnchorComp instanceof CompItem)) batchAnchorComp = null;
    } catch (eBatchComp) { batchAnchorComp = null; }
    csBatchAnchorBegin(batchAnchorComp);
```

and in the `finally` (`:622-627`), before `endUndoGroup`:

```javascript
    } finally {
        // Task 8.4 teardown (discard the recomputed-metadata context), restore
        // the user's pre-action selection, and close the single undo group on
        // EVERY path (Req 9.1/9.2).
        try { csImportIoEnd(); } catch (eIoEnd) { }
        try { csBatchAnchorEnd(batchAnchorComp); } catch (eAnchorEnd) { }
        __CS_IMPORT_BATCH_ACTIVE = false;
        if (undoOpened) { try { app.endUndoGroup(); } catch (eEnd) { } }
```

**(d)** Replace `getTopSelectedLayer(activeComp)` with `csResolveImportAnchor(activeComp)` at the four import call sites: `jsx/import.jsx:963`, `:1441`, `:1698`, `:1796`. `getTopSelectedLayer` itself (`jsx/core.jsx:573`) is unchanged and still used everywhere else.

### F11 — Guaranteed balance

**Conditions:** 1.23, 1.24

**(a) `jsx/import.jsx`** — set the batch guard from the latch (replaces `:566-568`):

```javascript
    var undoOpened = false;
    try { app.beginUndoGroup("CompSaver Import"); undoOpened = true; } catch (eUndo) { }
    // Set the guard ONLY when this batch actually owns a group. It used to be
    // set BEFORE the attempt, so a failed beginUndoGroup left every per-section
    // routine's csBeginUndoGroup a no-op and the whole batch of DOM mutations
    // ran with NO undo group at all. Now a failed begin means N per-section
    // groups instead of none — strictly better than an unundoable import.
    __CS_IMPORT_BATCH_ACTIVE = undoOpened;
```

**(b) `jsx/templates_save.jsx`** — the destructive-window restore handlers. `RESTORE_AND_RETURN` (`:660-676`) becomes:

```javascript
        function RESTORE_AND_RETURN(origFile, message) {
            try { if (tempComp) tempComp.remove(); } catch (eR) { }
            try { app.endUndoGroup(); } catch (eR2) { }
            // Suppression is released by try/finally on EVERY path, so a throw
            // inside app.open can never leave it stuck on for the session.
            var reopenOk = true;
            var suppressed = false;
            try { app.beginSuppressDialogs(); suppressed = true; } catch (eSupB) { }
            try {
                app.open(origFile);
            } catch (eR3) {
                reopenOk = false;
            } finally {
                if (suppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
            }
            if (!reopenOk) {
                return message + " — automatic restore failed; please reopen your project manually from disk.";
            }
            return message;
        }
```

The same shape applies to `RESTORE_AND_RETURN_HEX` (`:854-869`) and to the two outer-catch restore blocks (`:770-786`, `:973-990`), each keeping its own return-string convention.

**(c) `jsx/import.jsx`** — the `importFile` sites. `importCompDirect` (`:1454-1465`):

```javascript
                var importedItem = null;
                var tPreImport = $.hiresTimer;
                var dlgSuppressed = false;
                try { app.beginSuppressDialogs(); dlgSuppressed = true; } catch (eSupB) { }
                try {
                    importedItem = app.project.importFile(new ImportOptions(mainFile));
                    _csProfilePoint("  Native importFile");
                } catch (importErr) {
                    return encodeBridge("File import failed: " + importErr.toString());
                } finally {
                    // Req 3.15: importFile stays wrapped in suppression; the
                    // release is now guaranteed on the throw path too.
                    if (dlgSuppressed) { try { app.endSuppressDialogs(false); } catch (eSupE) { } }
                }
```

Identically at `importLayerTypeAep` (`:997-1010`). The early `return` inside the `try` runs this inner `finally` (suppression off) and then the outer one from F9 (cleanup, then `csEndUndoGroup`), in that order.

### F12 — Deterministic template-file resolution

**Condition:** 1.25 · **File:** `jsx/core.jsx`

**(a)** Insert above `resolveTemplateFiles` (`:343`):

```javascript
// Deterministic pick from a file list. Folder.getFiles(mask) returns entries in
// an unspecified, filesystem-dependent order, so `[0]` resolved a multi-.aep
// template folder differently on different machines. Documented precedence:
//   1. the preferred exact name, case-insensitively ("project.aep")
//   2. otherwise the lexicographically smallest name under a TOTAL order
//      (case-insensitive first, case-sensitive as the tie-break)
// ES3: manual scan, no dependence on Array.prototype.sort stability.
function csPickDeterministicFile(files, preferredName) {
    if (!files || files.length === 0) return null;
    var want = preferredName ? ("" + preferredName).toLowerCase() : "";
    var best = null;
    var bestKey = null;
    var i;
    for (i = 0; i < files.length; i++) {
        var f = files[i];
        if (!(f instanceof File)) continue;
        var nm = "" + f.name;
        var nmLower = nm.toLowerCase();
        if (want && nmLower === want) return f;
        var key = nmLower + "\u0000" + nm;
        if (bestKey === null || key < bestKey) {
            bestKey = key;
            best = f;
        }
    }
    return best;
}

// Enumerate through the once-per-import memoized enumerator (Req 8.2) so this
// fallback stops re-hitting the disk per template. csEnumerateFolderOnce is
// defined in jsx/import.jsx; ExtendScript hoists every //@include'd top-level
// function into one global scope, which is the same arrangement that lets
// resolveTemplateFiles already call csReadTemplateMeta. A csIo enumeration
// failure degrades to a direct read here rather than aborting, because this IS
// the meta.json-missing degraded path that Req 3.14 requires to keep working.
function csListTemplateFiles(folder, mask) {
    var files = null;
    try {
        if (typeof csEnumerateFolderOnce === "function") {
            files = csEnumerateFolderOnce(folder, mask);
        }
    } catch (eEnum) { files = null; }
    if (!files) {
        try { files = mask ? folder.getFiles(mask) : folder.getFiles(); } catch (eGet) { files = null; }
    }
    return files ? files : [];
}
```

**(b)** Replace the fallback ladder in `resolveTemplateFiles` (`:355-386`). The **order** of the ladder is unchanged — only the tie-break inside each step becomes total:

```javascript
    var mainFileName = metaObj.mainFile || "project.aep";
    var mainFile = new File(folder.fsName + "/" + mainFileName);
    if (!mainFile.exists) {
        var picked = csPickDeterministicFile(csListTemplateFiles(folder, "*.aep"), "project.aep");
        if (!picked) {
            picked = csPickDeterministicFile(csListTemplateFiles(folder, "*.cseffect"), null);
        }
        if (!picked) {
            // Image fallback: the extension precedence is preserved exactly;
            // within an extension group a "source.*" file (written by
            // savePNGOnly) wins, otherwise the lexicographically smallest name.
            var imgExts = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.bmp", "*.tif", "*.tiff"];
            var ie;
            for (ie = 0; ie < imgExts.length; ie++) {
                var imgFiles = csListTemplateFiles(folder, imgExts[ie]);
                if (!imgFiles || imgFiles.length === 0) continue;
                var srcPick = null;
                var im;
                for (im = 0; im < imgFiles.length; im++) {
                    var cand = imgFiles[im];
                    if (!(cand instanceof File)) continue;
                    if (("" + cand.name).toLowerCase().indexOf("source") !== 0) continue;
                    if (!srcPick || ("" + cand.name).toLowerCase() < ("" + srcPick.name).toLowerCase()) {
                        srcPick = cand;
                    }
                }
                picked = srcPick ? srcPick : csPickDeterministicFile(imgFiles, null);
                if (picked) break;
            }
        }
        if (picked) mainFile = picked;
    }
```

## Testing Strategy

### Validation Approach

Two phases, in order. **First** surface counterexamples on the *unfixed* code — each exploratory test below must FAIL before any fix lands, which is what proves the defect is real and the root-cause analysis is right (a test that passes on unfixed code has refuted its hypothesis and the analysis must be redone). **Then** verify the fix and, separately, verify that everything section 3 enumerates is unchanged.

**How host `.jsx` logic becomes testable.** The engine has no module system: `jsx/*.jsx` is a set of bare top-level `function` declarations concatenated by the ExtendScript `//@include` preprocessor. The repo already solves this two ways, and every host-side fix here is verified through one of them:

1. **Function slicing into a `vm` realm with instrumented AE fakes** — the pattern in `tests/save-window-invariants.test.js:27-38` (`sliceFn(src, name)` walks braces to extract one function's source) plus a fake `app` that counts `saveCalls`, `openCalls`, `reduceCalls`, `undoBegin/undoEnd`, `suppressBegin/suppressEnd`. `tests/import-timings.test.js` does the same for `importBatch`. This is how the save engines, the import routines and the balance invariants are tested: the fake `app.open()` can be made to throw, and item fakes can be made to throw on *every* property read, which is exactly how reference invalidation is simulated.
2. **Whole-file sandbox loading** — `tests/helpers/loadHelpers.js` reads a `.jsx` file fresh, strips `//@include`/`#target` directives, evaluates it in a `vm` whose globals are the AE-DOM fakes from `tests/helpers/aeFakes.js`, and exposes `get(name)`. `tests/helpers/isValidPng.test.js` and `tests/helpers/layerPrep.test.js` use it. This is how `renderFrameToPng`, `escapeJSON`/`jsonStringify`, `decodeBridgeStrict`, the sanitizer and `csPickDeterministicFile` are tested — all of them are pure or near-pure, so no slicing is needed.

For the sanitizer specifically, the canonical implementation lives in `js/core/pathBuilders.js`, which jest `require`s directly. The host port in `jsx/core.jsx` is then verified **against** it: a cross-implementation property test loads `jsx/core.jsx`'s `csSanitizeName` through `loadHelpers` and asserts it agrees with `sanitizeNameStrict` on every generated input. That is what makes 2.27 checkable rather than aspirational.

### Existing coverage map

| Area | Existing tests | Verdict |
|---|---|---|
| Destructive-window invariants (3.1–3.4) | `tests/save-window-invariants.test.js` — real `coreSaveLayerType` in a `vm`, asserting no reopen pre-window, exactly one post-window, 2 writes/1 reopen/balanced undo+suppression on success | **Reusable as the preservation harness for F2/F11.** Currently asserts nothing about the *result object*, so it passes today despite 1.2 — extend it, do not replace it. |
| Live-project survival (3.1–3.3) | `tests/save-live-project-survival.test.js` — Property 1, on-disk project byte-identical, reopen invoked exactly when the window was entered | Covers the reopen *count*; **silent on reopen failure being reported**. Extend for Property 4. |
| Save result shapes (3.21–3.23) | `tests/save-return-shape.test.js` — object/`"true"`/`{ok:false}`/bare-string/empty dispatch, one thumbnail + one preview job, optimistic card targeting | **Directly reusable** for F1's new result fields and the reopen-failure string; the "bare error string → error, no jobs" case at `:416` is the assertion that pins 2.5's panel-side behavior. |
| Loading exit + background failure (3.21, 3.22) | `tests/save-loading-exit-on-essential.property.test.js`, `tests/save-background-failure-surfacing.property.test.js` | **Reusable unchanged** — they constrain `runSaveController`, which no fix touches. |
| Optimistic card (3.23) | `tests/library-index-insert-at-head.property.test.js`, `tests/optimistic-card-placeholder.property.test.js`, `tests/library-single-mutation-locality.property.test.js` | **Reusable**; F5 makes the panel-derived `folderPath` finally equal the host's, which is the key these tests already assume. |
| Thumbnail queue/failure (3.24–3.26) | `tests/save-thumbnail-queue.test.js`, `tests/background-queue-fail-advance.test.js`, `tests/thumbnail-bounded-resolution.test.js`, `tests/helpers/isValidPng.test.js`, `tests/save-render-background-only.test.js` | **Reusable**; `thumbnail-bounded-resolution` is the guard that F6's frame math must not disturb the wrapper. |
| Bridge timeout (Property 6) | `tests/bridge-timeout.test.js` — decoded result before timeout, timeout on late/never return | **Reusable**; extend with the malformed-payload branch (F8a). |
| Import batching (9.1, 9.4) | `tests/import-one-bridge-call.property.test.js`, `tests/import-cached-no-bridge.property.test.js` | **Reusable unchanged** — F8f swaps the transport but keeps the one-call/zero-call contract. |
| Batch undo + rollback + totality (3.8, 3.10, 3.11) | `tests/import-timings.test.js` (balanced group, rollback on failure, totality, ES3 static check) | **Reusable as the F9/F10c/F11a harness**; its ES3 assertion (`:139-145`) is the gate every host edit must pass. |
| Metadata cache (3.12) | `tests/metadata-cache-roundtrip.test.js`, `-currency`, `-malformed` | **Reusable**; F6a adds keys, and "malformed" already covers unknown-key tolerance. |
| Path builders (12.x) | `tests/save-path-builders.test.js` | **Must be updated by F5**: it asserts `getSafeName` returns `{ok,value}`. The `{ok,…}` contract moves to `sanitizeNameStrict` and the assertions follow it; `getSafeName`/`generateTemplateId` gain string-returning assertions. This change is the point of 2.27 — the tested implementation becomes the loaded one. |
| Contract registry | `tests/contract-registries.test.js`, `tests/bridge-registry-adapter.test.js` | **Update with F7c** (new `itemExists` shape, 4th argument, guarded transport). |
| Panel/host static wiring | `tests/cep-compat.test.js`, `tests/templates-contract.test.js`, `tests/class-contract.test.js` | **Reusable**; the `index.html` script-list change in F5d belongs in a static assertion here (see New PBT 7). |

**Not covered anywhere today:** reference invalidation (1.1, 1.2), reopen-failure reporting (1.5), resolver agreement (1.3, 1.4), library-root validation (1.6, 1.7), reserved/traversing names (1.8), the format fields in `meta.json` (1.9, 1.10), thumbnail target fidelity (1.11), playhead restore (1.12), the `itemExists` contract (1.13, 1.14), malformed-hex agreement (1.15), `escapeJSON` validity (1.16), the import transport guard (1.17), import leak on early return (1.18), Project-panel folder accumulation (1.19, 1.20), anchor-by-reference and batch anchoring (1.21, 1.22), suppression balance on throw (1.23), the batch-guard inversion (1.24), and `.aep` fallback determinism (1.25).

### Exploratory Bug Condition Checking

**Goal:** produce a concrete counterexample for each condition on the **unfixed** code, confirming or refuting the root causes in section 5. New file: `tests/comp-pipeline-bug-exploration.test.js`, following the shape of `tests/bug-condition-exploration.test.js`.

**Test plan:** slice `saveActiveComp`, `coreSaveLayerType`, `getStrictSaveType`, `resolveCompForSave`, `itemExists`, `toolkitOrganizeTemplateImport`, `importCompDirect`, `placeLayerAtPlayhead` and `importBatch` into a `vm` with fakes that (a) make every property read on an item throw once `app.open()` has been called, (b) let `app.open` be configured to throw, (c) count `beginSuppressDialogs`/`endSuppressDialogs` and `beginUndoGroup`/`endUndoGroup`, and (d) record `addFolder`/`remove`/`parentFolder` mutations. Load `jsx/core.jsx` and `jsx/helpers.jsx` through `loadHelpers` for the pure functions.

**Test cases** (all expected to FAIL pre-fix):

1. **Stale result reference (1.1)** — save succeeds; the returned string starts with `"Error:"` and `openCalls.length === 2`. Assert a JSON success payload and `openCalls.length === 1`.
2. **Stale `renderFrame` (1.2)** — `coreSaveLayerType` returns a `"Save Error: …"` string instead of an object. Assert `typeof result === "object" && result.ok === true`.
3. **Reopen failure reported as success (1.5)** — `app.open` throws post-window; the reply is `ok:true`. Assert a failure whose message contains the template path.
4. **Resolver disagreement, empty selection (1.3)** — `getStrictSaveType` → `type:"comp"` while `resolveCompForSave` → `ok:false`. Assert both agree.
5. **Resolver disagreement, mixed project selection (1.4)** — the announced `suggestedName` is Comp B while `resolveCompForSave` returns Comp A. Assert identity.
6. **Empty/relative root (1.6)** — `r = ""` reaches `ensureDeepFolder` and creates `/comp/...`. Assert rejection with no `create` call.
7. **Folder creation failure (1.7)** — `Folder.create()` returns false; assert `reduceCalls === 0`.
8. **Traversal name (1.8)** — `getSafeName("..") === ".."`. Assert a safe, non-traversing segment.
9. **Format fields absent (1.9, 1.10)** — the host result has no `width`/`section`; the panel writes no `dim`/`assetsDir`. Assert both present.
10. **Thumbnail target discarded (1.11)** — `renderTemplateThumbnail.length === 2` and the rendered time equals `workAreaStart + 0.3 * workAreaDuration` regardless of the recorded frame. Assert `frame / frameRate`.
11. **Playhead moved (1.12)** — `comp.time` after `renderFrameToPng` differs from before. Assert equality on both the success and the throwing path.
12. **`itemExists` contract (1.13, 1.14)** — the decoded reply is a folder name, `=== "true"` is false, and a 3-argument call searches `comp` for a `layer` save. Assert `{exists:true,id:"…"}` and the requested section.
13. **Malformed hex divergence (1.15)** — for `"0048006"` and a 14-char payload, the panel and host decoders return different strings and neither reports. Assert identical `{ok:false}`.
14. **Invalid JSON (1.16)** — `JSON.parse(jsonStringify({e:"a\u0001b"}))` throws, and `"a\r\nb"` loses its `\r`. Assert parse success and round-trip.
15. **Untimed import (1.17)** — with a transport that never invokes its callback, the result callback never runs and `.importing` is never cleared. Assert a settled failure result within the timeout.
16. **Import leak (1.18)** — force "No comp found!"; imported item ids remain. Assert the id multiset is restored.
17. **Root folder accumulation (1.19, 1.20)** — three successive imports add three root folders; a solid-only import leaves an empty one. Assert one reused container and zero empty folders.
18. **Wrong anchor (1.21)** — two layers named `BG`; the imported layer lands above the wrong one. Assert it lands above the selected reference.
19. **Batch anchor drift (1.22)** — a 3-template batch; templates 2 and 3 anchor to the previous insert. Assert all three anchor to the original selection.
20. **Suppression stuck (1.23)** — make `app.open` throw inside a restore handler; `suppressBegin - suppressEnd === 1`. Assert equality.
21. **Batch guard inversion (1.24)** — make `beginUndoGroup` throw; assert the per-section routines still open their own groups (`undoBegin >= 1`) instead of zero.
22. **Non-deterministic `.aep` (1.25)** — feed `["b.aep","project.aep"]` and its reverse; the resolved file differs. Assert `project.aep` both ways.

**Expected counterexamples:** an `"Error: … Exception: …"` reply from a save whose `project.aep` exists on disk; two `app.open` calls for one save; `ok:true` after a thrown reopen; two different composition names from the two resolvers; a folder created at the volume root; `".."` surviving sanitization; `meta.json` without `width`/`dim`/`assetsDir`; a thumbnail rendered at the wrong frame; a moved playhead; `exists === false` for a template that exists; two different decodings of one malformed payload; a `JSON.parse` throw on host-produced JSON; a never-settling import; leaked project items; N root folders after N imports; a layer above the wrong anchor; unbalanced suppression counters; zero undo groups for a whole batch; order-dependent file resolution.

### Fix Checking

**Goal:** for every input satisfying the bug condition, the fixed code produces the specified behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedPipeline(input)
  ASSERT expectedBehavior(result)
END FOR
```

Concretely, for each fix group: F1/F2 → the result is built from captured locals only and a thrown reopen returns a failure naming the template path; F3 → the two resolvers agree on `ok` and on the comp; F4 → a non-absolute root is rejected before any `create` and a creation failure aborts before `reduceProject`; F5 → both sanitizers return the same safe segment; F6 → `meta.json` carries the format, the recorded frame is rendered, and `comp.time` is restored; F7 → `{exists,id,section}` on both sides with the section that was asked for; F8 → identical strict decode results, always-parseable JSON, an always-settling import transport; F9 → the item-id multiset is restored on failure and at most one container folder exists; F10 → the anchor is the selected reference for every template in a batch; F11 → the suppression and undo counters balance on every path and the batch guard implies an owned group; F12 → one file for every input permutation.

### Preservation Checking

**Goal:** for every input where the bug condition does **not** hold, the fixed code produces the same result as the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalPipeline(input) = fixedPipeline(input)
END FOR
```

**Testing approach.** Property-based testing is the right instrument here: the preserved surface is broad (every save path, every import path, every string that crosses the Bridge, every already-safe name) and the regressions that matter are edge cases a fixed table of examples will not reach — a name that is exactly 255 characters, a payload that is a multiple of four *and* corrupt, a batch where template 3 of 5 fails, a comp with `frameRate === 0`. Generators produce those combinations for free, and a failure gives a minimal counterexample rather than a puzzle.

**Test plan.** Capture the baseline on the **unfixed** code first for every non-buggy input class, then assert the fixed code reproduces it. Two of the existing suites already *are* the baseline and must keep passing byte-for-byte: `tests/save-window-invariants.test.js` (call sequences and counters) and `tests/import-timings.test.js` (single balanced group, rollback scoping, result totality).

**Test cases:**

1. **Reduce-first ordering (3.4)** — on a successful save the recorded `app` call sequence is exactly `beginUndoGroup → save(PROTECTIVE) → reduceProject → save(TARGET) → endUndoGroup → beginSuppressDialogs → open → endSuppressDialogs`, with `saveCalls.length === 2` and `reduceCalls === 1`. Baseline from `save-window-invariants`; must be unchanged after F1/F2/F11.
2. **Protective-save abort (3.1)** — protective save throws → `reduceCalls === 0`, `openCalls.length === 0`, `undoEnd === undoBegin`, the message is `"Protective save failed — aborted, your project is untouched."`.
3. **Reopen invariants (3.2, 3.3)** — over generated failure-injection points: a pre-window throw → zero reopens; a post-window throw → exactly one, and on a failed restore the message still ends with the manual-reopen instruction.
4. **Unsaved project (3.5)** — `app.project.file = null` → `"Please save your project first!"` with no mutation, for every section.
5. **Hex round-trip (3.6, 3.7)** — `decodeBridge(encodeBridge(s)) === s` for generated strings including CJK, accents, lone surrogates and full surrogate pairs, and for a ≥1 MB payload; asserted against **both** implementations, and the encode/decode source is statically checked to contain no `join(` (3.29).
6. **Batch envelope (3.8, 3.9)** — for generated batches of 1–20 templates with arbitrary failure positions: `undoBegin === 1 && undoEnd === 1` and no per-section group opened while the guard is on; a standalone `importCompDirect` opens and closes exactly one.
7. **Rollback scoping (3.10)** — pre-existing layers/items and previously imported templates survive a mid-batch failure; only the failed template's additions disappear. F9's cleanup must not widen this.
8. **Result totality (3.11)** — `perTemplate.length === templates.length` with ids in input order, over: all-success, all-failure, mid-batch throw, whole-call decode failure, and (new) transport timeout.
9. **Cache-first metadata (3.12)** — a seeded entry causes zero `readFileText` calls; a miss causes exactly one read and one parse per folder per import, including through F12's new enumeration path.
10. **Fallback ladder (3.14)** — for generated folder contents, the resolved file matches the documented ladder, and a missing/unparseable `meta.json` still yields a degraded record rather than an empty library.
11. **Suppression around `importFile` (3.15)** — `beginSuppressDialogs` still brackets the call on the success path, with the counters balanced.
12. **Utility Pre-Comp (3.16)** — one reference layer, wrapper comps removed, `layerState` re-applied; unchanged under F9's container rename and F10's anchor change.
13. **Timing math (3.17, 3.18)** — a trimmed in-point still lands on the captured playhead; a multi-layer import still shifts by one uniform delta. Anchor selection must not perturb either.
14. **Relink ladder + name resolution (3.19, 3.20)** — decoded → raw → case-insensitive → extension-agnostic order preserved; `csResolveName` deterministic over a once-computed name set.
15. **Save controller (3.21, 3.22)** — `exitLoading` called exactly once before any background scheduling; no background work on essential failure — including the new reopen-failure string, which must be classified as an essential failure.
16. **Optimistic card (3.23)** — re-saving the same template replaces one entry at the head instead of duplicating, using the F5-corrected `folderPath`.
17. **Thumbnail behavior (3.24–3.27)** — a failed render keeps the placeholder and badges one card; aerender is still preferred when a comp name exists; a sub-64-byte PNG is still a failure; `renderTemplateThumbnail` still touches neither `app.project.file` nor `app.open` and always removes its scratch import (asserted on the new 4-argument form *and* a legacy 2-argument call).
18. **Strict host parsing (3.28)** — `jsonParse` remains the only host parser; `jsx/*.jsx` contains no `eval(` and no `JSON.parse` outside the documented harness guards.
19. **Startup scan (3.29, 3.30)** — one section-chunked scan per root, the migration guard runs once per engine session, and a missing/unparseable response is treated as incomplete rather than empty.

### Unit Tests

- `validateLibraryRoot` / `isAbsoluteLibraryRoot`: `""`, `"MyLib"`, `"./x"`, `"C:/x"`, `"C:\\x"`, `"//server/share"`, `"/Users/x"`, a trailing-slash root, a non-existent root with an existing parent, a non-existent root with a non-existent parent.
- `ensureDeepFolder`: already-exists, multi-level creation, `create()` returning false, `create()` throwing, a path with `"//"` runs, and the `null` contract at each guarded call site.
- `sanitizeNameStrict` / `csSanitizeName`: `"."`, `".."`, `"..."`, `"name."`, `"name "`, `""`, `"   "`, `"CON"`, `"con.aep"`, `"a/b\\c"`, a 300-character name, a name containing `\u0000`, and an already-safe name (which must be returned unchanged).
- `escapeJSON`: every C0 character, `\r` alone, `\r\n`, `"`, `\`, `\t`, `\b`, `\f`, DEL, and a control-free string (which must take the fast path and be byte-identical to the input).
- `decodeBridgeStrict`: `""`, a valid payload, length 1/2/3 mod 4, a non-hex character, a 4-char non-hex chunk, and a very long valid payload.
- `csPickDeterministicFile`: empty list, one file, preferred present, preferred absent, names differing only by case, and both input orders.
- `findCompItemInFolderByName`: exact match at depth 1 and depth 3, case-differing match, no match, a folder whose `numItems` throws.
- `renderFrameToPng`: time restored on success, on a thrown render, and when the `comp.time` write itself is rejected; suppression balanced in all three.
- `placeLayerAtPlayhead`: live anchor, anchor whose `.index` read throws (fallback engaged), `anchorLayer === newLayer`, `anchorLayer === null`, and duplicate names.
- `csResolveImportAnchor`: no latch (standalone), latch for the same comp, latch for a different comp, latch whose anchor went stale, latch with an empty selection.
- `itemExists`: hit, miss, missing category folder, unparseable `meta.json`, `getFiles()` returning null, no section argument (legacy default), each section value, and an empty name.
- `parseHostBatchResult`: `{perTemplate:[],error:"…"}` propagates the reason to every entry.

### Property-Based Tests

New `fast-check` suites, one per property in the Correctness Properties section:

1. `tests/comp-save-reference-capture.property.test.js` — **Property 3, 4.** Generate save scenarios (section, reopen-throws, target-save-throws, reduce-throws, protective-throws) against an item fake that throws on every property read after `app.open`. Assert: a successful save never returns a string starting with `"Error"`; `openCalls.length <= 1`; a thrown reopen yields a failure mentioning the template path; and the counters from `save-window-invariants` are unchanged.
2. `tests/comp-selection-resolution.property.test.js` — **Property 5.** Generate selection states over {0,1,2+ timeline layers} × {precomp, non-precomp} × {0,1,2+ project comps} × {0,n non-comp items} × {active comp present/absent}. Assert `type === "comp"` ⇒ `resolveCompForSave().ok`, and `suggestedName === resolveCompForSave().comp.name`.
3. `tests/library-path-containment.property.test.js` — **Property 6.** Generate root × category × name (including `"."`, `".."`, reserved names, 300-char names, whitespace-only). Assert the derived path is either rejected or a strict descendant of the category folder with a safe final segment.
4. `tests/sanitizer-cross-implementation.property.test.js` — **Property 7.** For every generated name assert `pathBuilders.getSafeName(n) === csSanitizeName(n).value` (host loaded via `loadHelpers`) and `pathBuilders.generateTemplateId(n) === hostGenerateTemplateId(n)`, plus the invariants (no separator, no control, no trailing dot/space, ≤255, never `.`/`..`).
5. `tests/bridge-decode-agreement.property.test.js` — **Property 8.** For generated strings assert round-trip on both sides; for generated arbitrary hex-ish payloads assert the panel and host `decodeBridgeStrict` return equal `ok` and equal `value`.
6. `tests/host-json-validity.property.test.js` — **Property 9.** For generated objects with arbitrary string values assert `JSON.parse(jsonStringify(obj))` succeeds and reproduces every string, with `\r` preserved.
7. `tests/panel-script-manifest.test.js` — **Property 7 (static half).** Assert `index.html` loads `js/core/pathBuilders.js`, that it precedes `js/core/utils.js`, and that `getSafeName`/`generateTemplateId` are each defined exactly once across `js/`. Uses `tests/helpers/static-analysis.js`.
8. `tests/import-atomicity.property.test.js` — **Property 10.** Generate failure-injection points across `importCompDirect`/`importLayerTypeAep` (importFile throws, zero items, no comp, recursive nesting, `layers.add` fails) both standalone and in a batch. Assert the project item-id multiset is restored, and that N successful imports add at most one root folder and leave zero empty folders.
9. `tests/import-anchor-placement.property.test.js` — **Property 11.** Generate comps with duplicate layer names and batches of 1–10 templates. Assert the new layer's index is one less than the *selected* layer's, for every template, and that the pre-action selection is restored at batch end.
10. `tests/host-balance-invariants.property.test.js` — **Property 12.** Generate throw-injection at every instrumented `app` method across both save engines and both import routines. Assert `suppressBegin === suppressEnd`, `undoBegin === undoEnd`, and `__CS_IMPORT_BATCH_ACTIVE ⇒ undoOpened`.
11. `tests/template-file-resolution.property.test.js` — **Property 13.** Generate folder contents (0–8 files across `.aep`/`.cseffect`/image extensions, arbitrary names, shuffled) and assert the resolved file is invariant under permutation and matches the documented ladder.
12. `tests/thumbnail-target-fidelity.property.test.js` — **Property 1 (thumbnail slice).** Generate `(compName, frame, frameRate, duration)` and assert the rendered time is `frame / frameRate` clamped into the comp, that the named comp is the one rendered, and that omitting either argument reproduces the legacy 30%-of-work-area time.
13. `tests/comp-meta-fidelity.property.test.js` — **Property 1 (metadata slice).** Generate host result objects and assert the written `meta.json` carries `width`, `height`, `dim`, `pixelAspect`, `frameRate`, `duration`, `mainFile`, `schemaVersion`, `section`, `type`, and `assetsDir` whenever assets were copied.
14. `tests/comp-pipeline-preservation.property.test.js` — **Property 2.** The consolidated preservation suite for the 19 cases in Preservation Checking above; runs the same generators against the fixed code and the recorded pre-fix baseline.

### Integration Tests

- **Full comp save → card → thumbnail:** `saveActiveComp` (real, in a `vm`) → panel `parseEssential` → `runSaveController` → optimistic card → `meta.json` written → thumbnail job enqueued with `renderComp`/`renderFrame` → `renderTemplateThumbnail` invoked with four arguments. Asserts the whole chain that 1.1 + 1.10 + 1.11 broke at three separate links.
- **Save with a failing reopen:** end to end, the user sees an error naming the template path, no card is rendered, and no background work is scheduled (3.21, 3.22).
- **Re-save over an existing template:** `itemExists` → overwrite prompt → `oldId` → `.fav` preserved → old folder removed → exactly one card at the head of the index (2.13 + 3.23).
- **Layer/text/footage save through `coreSaveLayerType`:** object result reaches the panel, `meta.json` carries `layerState` *and* the new format fields, and the destructive-window counters are unchanged.
- **Batch import of 5 templates, template 3 failing:** one Bridge_Call, one undo group, `perTemplate` total in input order, template 3's items gone and 1/2/4/5 intact, all five anchored to the original selection, one `_CompSaver_Assets` folder, zero empty folders, and the user's selection restored at the end.
- **Import with a never-returning host:** the card's `.importing` class is cleared, a failure toast names the timeout, and the project is unmodified.
- **Solid-only template import:** no empty folder at the Project-panel root, and the solid footage lives under the container.
- **Startup library scan after the fixes:** one section-chunked scan per root, mixed old/new `meta.json` documents both scanned, and templates whose folder names were produced by the pre-fix panel derivation still resolve (3.14, 3.30).
