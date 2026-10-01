# Implementation Plan: Icon Import Timeline Bulk Fix

## Overview

Implement the fix inside the existing media pipeline rather than introducing a parallel import path. The work first adds item-local repository/card mutation primitives, then moves media readiness to the copy/readability/final-persistence durability boundary, adds independent bulk outcomes and cleanup, hardens card interaction and legacy-record reconciliation, and finally carries the exact persisted `mainFile` through the existing host dispatch.

Production changes remain limited to:

- `js/core/persistence.js`
- `js/core/keyedMediaCardHelper.js`
- `js/core/fastMediaEngine.js`
- `js/templates/templates.js`
- `jsx/import.jsx`

Panel code must remain CEP-compatible ES5, and host code must remain ExtendScript-compatible ES5. All property tests use `fast-check` with at least 100 runs and include the exact tag `Feature: icon-import-timeline-bulk-fix, Property <number>: <property title>`. The core fix and all listed validations are required; no task is optional.

## Tasks

- [ ] 1. Add item-local repository and keyed-card mutation primitives
  - [ ] 1.1 Implement transactional `MediaEntryRepository.removeById` in `js/core/persistence.js`
    - Normalize and locate the stable record ID, remove only that entry from a candidate snapshot, and preserve survivor order.
    - Persist through `_commitEntries` and the existing verified storage ladder; publish to `LibraryIndex` and `allTemplates` only after persistence succeeds.
    - Return idempotent success when the record is absent, and retain the last durable snapshot and mirrors when persistence fails.
    - Return the structured `{ ok, removed, snapshot }` result expected by item cleanup without adding a direct storage write path.
    - _Requirements: 4.8, 5.3, 5.4, 5.7, 5.8, 5.9, 7.6, 7.14_

  - [ ] 1.2 Add keyed, idempotent card removal to `js/core/keyedMediaCardHelper.js`
    - Add `removeById(id)` using the existing stable registration and `#tpl-<id>` node identity.
    - Remove only the matching node and registry entry; treat an absent registration or detached node as successful cleanup.
    - Preserve sibling DOM order and all existing insert/patch behavior.
    - _Requirements: 4.7, 4.8, 5.2, 5.7, 5.8, 5.9, 7.5, 7.6_

  - [ ] 1.3 Serialize coordinator-issued repository mutations in `js/core/fastMediaEngine.js`
    - Add one promise chain for final-ready patches, failed-item removals, and later derivative patches issued by `MediaWorkCoordinator`.
    - Keep the chain usable after a rejected mutation and preserve the current timing of synchronous production persistence while making injected asynchronous persistence deterministic.
    - Route all three mutation kinds through the queue so stale asynchronous snapshots cannot overwrite newer item state.
    - _Requirements: 2.7, 4.2, 4.5, 5.1, 5.3, 5.4, 5.7, 7.7, 7.8, 7.9_

  - [ ] 1.4 Add focused repository, card-removal, and mutation-order tests
    - Extend `tests/media-index-migration.test.js` for absent-ID idempotence, single-record removal, survivor ordering, durable mirror publication, and persistence-failure rollback.
    - Extend `tests/keyed-media-card-helper.test.js` for attached, detached, absent, and repeated `removeById` calls without sibling movement.
    - Add an injected asynchronous persistence race covering overlapping ready patch, failed removal, and derivative patch; assert final repository, shared-index, and `allTemplates` parity.
    - _Requirements: 4.8, 5.2, 5.3, 5.4, 5.7, 5.8, 5.9, 7.6, 7.7_

- [ ] 2. Implement the item durability lifecycle, cleanup, and bulk settlement
  - [ ] 2.1 Prepare stable pending records, work items, ownership ledgers, and outcome slots in `js/core/fastMediaEngine.js`
    - Keep one stable ID and insertion position per accepted candidate, with explicit pending terminal/derivative fields and source-derived name/category.
    - Seed `thumbnail` and `thumbnailPath` as empty so source media is never used as a temporary preview; predicted folder/main-file values remain non-authoritative while pending.
    - Record artifact ownership before filesystem mutation, including `existedBefore`, owner IDs, kind, and the candidate’s unique destination as the maximum cleanup boundary.
    - Create exactly one outcome-table slot per candidate, including candidates rejected by keyed insertion, while preserving discovery order.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.7, 4.8, 7.1, 7.3, 7.5_

  - [ ] 2.2 Move the ready transition to the copy/readability/final-persistence durability gate
    - Run destination creation, copy, and post-copy verification in the existing filesystem lane.
    - Verify that the normalized destination is a directory and that the exact copied main file is a readable regular file.
    - Submit final `folderPath`, `mainFile`, `mediaFile`, ready terminal state, pending derivative state, and placeholder thumbnail state through the serialized repository queue; wait for `{ ok: true }`.
    - Latch readiness exactly once, then patch the existing keyed card in place immediately after repository acknowledgement.
    - Start or continue thumbnail/ffmpeg and best-effort `meta.json` work only after the required gate; derivative success/failure may patch derivative fields but must never change ready state, identity, paths, or order.
    - _Requirements: 2.7, 2.8, 2.9, 2.10, 2.12, 4.2, 7.3, 7.5, 7.8, 7.9_

  - [ ] 2.3 Route every required-stage failure through item-local, idempotent cleanup
    - Add per-item failure and cleanup latches and one `failItem` path covering card insertion, provisional persistence, copy, folder verification, main-file verification, and final persistence.
    - Remove the keyed pending card, transactionally remove the provisional repository record through the mutation queue, then delete only owned partial artifacts deepest-first within the safe boundary.
    - Never delete preexisting paths, source files, shared paths still owned by successful items, or artifacts outside the candidate’s unique destination.
    - Treat already-missing cards, records, files, and directories as successful cleanup; retain actionable item/stage/path reasons for residual cleanup failures.
    - Publish the failed outcome only after required cleanup settles, without cancelling siblings or rolling back successful files or records.
    - _Requirements: 2.12, 4.3, 4.4, 4.9, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 7.13, 7.14_

  - [ ] 2.4 Aggregate independent item outcomes and exact bulk results
    - Let each candidate write one terminal success/failed outcome exactly once and let ready siblings publish without waiting for the batch.
    - Split coordinator completion into `required settled` and `background idle`; build user-visible results only after all item outcomes and failed-item cleanup settle while keeping derivative metrics alive until background idle.
    - Derive candidate, success, and failure counts from the outcome table, not rendered cards or repository length, and classify all-success, partial-success, and all-failed exactly.
    - Preserve one actionable reason per failed item plus every residual cleanup artifact; reserve operation-level failure for errors before any candidate exists.
    - Continue coalesced category/count refreshes and item-local updates without a full filesystem rescan or whole-folder rollback.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 7.6, 7.7, 7.13, 7.14_

  - [ ] 2.5 Project pending, ready, removal, and derivative state through keyed cards in `js/templates/templates.js`
    - Render pending cards with source-derived labels, `.media-pending`, explicit state/accessibility attributes, and the stable empty thumbnail target.
    - Apply ready and thumbnail patches to the existing node without reinsertion; preserve ID, name, category, stored folder path, and catalog position.
    - Show the placeholder while derivatives are pending and the existing failure visual when derivatives fail, without disabling a durable ready card.
    - Ensure failed new items disappear through keyed removal rather than a grid rebuild.
    - _Requirements: 2.1, 2.2, 2.3, 2.7, 2.8, 2.9, 2.10, 4.7, 4.8, 5.2, 7.5, 7.6, 7.8, 7.9_

  - [ ] 2.6 Write the property test for durability producing one derivative-independent ready transition
    - **Property 4: Durability produces one ready transition independent of derivatives**
    - Generate required-stage success/failure and derivative schedules in `tests/optimistic-card-placeholder.property.test.js`; assert one ready transition only after final persistence acknowledgement and no derivative-driven terminal-state change.
    - **Validates: Requirements 2.7, 2.10, 2.12**

  - [ ] 2.7 Write the property test for independent and total bulk settlement
    - **Property 8: Bulk required work settles independently and totally**
    - Generate candidate vectors, stage outcomes, and settlement orders in `tests/media-import-coordinator.test.js`; assert one operation/outcome per candidate, progressive ready publication, and continued sibling work after failures.
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.5**

  - [ ] 2.8 Write the property test for identity and survivor-order preservation
    - **Property 9: Item-local transitions preserve identity and survivor order**
    - Extend `tests/keyed-media-card-helper.test.js` and `tests/single-card-patch-job-completion.property.test.js` with generated ready/removal sequences; compare DOM, repository, shared index, and mirror survivor order.
    - **Validates: Requirements 4.7, 4.8, 7.5, 7.6**

  - [ ] 2.9 Write the property test for isolated, idempotent cleanup
    - **Property 10: Failed-item cleanup is isolated and idempotent**
    - Generate mixed outcomes and ownership ledgers in `tests/media-index-migration.test.js` and coordinator tests; run cleanup once and repeatedly and assert identical final state, safe-boundary enforcement, and successful-item preservation.
    - **Validates: Requirements 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 7.13, 7.14**

  - [ ] 2.10 Write the property test for cleanup-gated summaries and residual reasons
    - **Property 11: Summary waits for cleanup and covers residual artifacts**
    - Generate delayed and failing cleanup promises in `tests/media-import-coordinator.test.js`; assert no summary before settlement and one item-associated actionable reason for each residual artifact.
    - **Validates: Requirements 4.9, 5.10, 6.8**

  - [ ] 2.11 Write the property test for exact bulk counts and classification
    - **Property 12: Bulk summaries are exact, total, and correctly classified**
    - Generate nonempty terminal outcome vectors in `tests/media-import-coordinator.test.js`; assert exact partitions, count totality, one reason per failure, and exact success/partial/failure classification.
    - **Validates: Requirements 4.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7**

  - [ ] 2.12 Write the property test for item-local terminal and derivative updates
    - **Property 14: Terminal and derivative updates remain item-local**
    - Extend `tests/single-card-patch-job-completion.property.test.js` and `tests/media-card-lifecycle-preservation.property.test.js`; assert keyed patch/removal only, zero full rescans, stable ready identity/path, and actionable thumbnail-failure visuals.
    - **Validates: Requirements 7.7, 7.8, 7.9**

  - [ ] 2.13 Add required-stage, derivative, cleanup, and ordering example tests
    - Cover each required-stage failure, final persistence rejection, duplicate callbacks, thumbnail held pending past readiness, thumbnail failure after readiness, unlink/rmdir failure with exact residual paths, and successful siblings surviving each failure.
    - Assert stable card/order fields across pending-to-ready, no source preview before a real thumbnail, no whole-folder rollback, and no full scan on any terminal update.
    - Keep these focused examples in the existing coordinator, thumbnail-resource, and stage-worker suites.
    - _Requirements: 2.7, 2.9, 2.10, 2.12, 4.2, 4.3, 4.4, 4.7, 4.8, 4.9, 5.5, 5.6, 5.10, 7.7, 7.8, 7.9, 7.13, 7.14_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Preserve picker discovery and expose structured import feedback
  - [ ] 4.1 Adapt picker entry points and feedback to structured results in `js/core/fastMediaEngine.js`
    - Keep `openMediaPicker`, `importMediaFile`, and `importMediaFolder` catalog-only; do not query active composition state or call card/timeline import functions.
    - Preserve recursive discovery, supported-extension registry, limits, source-identity deduplication, candidate order, and cancellation behavior unchanged.
    - Format exact success, partial-success, all-failed, empty, cancelled, and operation-level outcomes; retain `No supported media found in folder` exactly.
    - Show initial folder progress, include complete item/cleanup reasons in the existing details/log surface, and keep metrics alive through `backgroundIdle` without delaying the required result.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 7.10, 7.11, 7.12_

  - [ ] 4.2 Write the property test for discovery-baseline equivalence
    - **Property 1: Bounded discovery equals the baseline accepted set**
    - Generate supported/unsupported trees, duplicates, and limit boundaries in `tests/media-import-coordinator.test.js`; compare accepted candidates and first-occurrence order to the existing registry, traversal limits, and source-identity rules.
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 7.10, 7.11, 7.12**

  - [ ] 4.3 Write the property test for catalog-neutral empty discovery
    - **Property 2: Empty discovery is catalog-neutral**
    - Generate initial ordered catalogs and selections with zero accepted candidates; assert byte-equivalent records/cards/order and no provisional state.
    - **Validates: Requirements 1.9**

  - [ ] 4.4 Write the property test for sanitizer and copied-path parity
    - **Property 13: Destination paths preserve sanitizer and copy parity**
    - Extend `tests/save-path-builders.test.js` and focused fast-media cases with generated roots, categories, item names, IDs, and long filenames; assert one sanitization pass, byte-identical baseline output, and final stored values equal the actual copy destination.
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [ ] 4.5 Add picker cancellation, empty, dedupe, and timeline-neutral examples
    - Cover file and folder cancellation, unsupported-only folders, duplicate source identities, nested accepted files at discovery boundaries, and ingestion with no active composition.
    - Distinguish the picker dialog bridge call from `importBatch`; assert zero timeline requests/layer changes for every picker-only path and exact empty-folder feedback.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

- [ ] 5. Gate card interaction on final records and reconcile preexisting records
  - [ ] 5.1 Add targeted compatibility validation for marker-less records in `js/core/fastMediaEngine.js`
    - Have `ensureProductionMediaRuntime` queue bounded per-record validation after first paint through the existing filesystem scheduler lane; do not trigger a full library scan.
    - Keep each marker-less media card non-actionable while checking that its persisted index entry exists, its normalized folder is a directory, and its recorded main file is readable.
    - Patch valid records to explicit ready state through the serialized repository queue without changing identity/order.
    - Retain invalid legacy records for existing repair/reconciliation behavior; never delete them as operation-owned failures.
    - _Requirements: 2.3, 2.4, 2.8, 2.11, 7.7, 7.15_

  - [ ] 5.2 Resolve card actions from the selected final persisted record in `js/templates/templates.js`
    - Resolve by stable card ID through `TemplateCatalog`/`allTemplates` first, using the existing name/category lookup only for records without a usable stable ID.
    - Run the pending/compatibility-check guard before folder checks, metadata cache lookup, or `importTemplates`; report `Catalog import for "<name>" is still in progress` and issue zero timeline requests.
    - For ready media, build one request from the resolved record’s normalized `folderPath`, exact `mainFile`, and `getTemplateSection(record)`; do not trust `currentSection`, DOM `data-folder`, or reconstructed paths.
    - Validate `mainFile` as one safe basename without re-sanitizing it, reject corrupt persisted names actionably, and ensure the joined file remains inside `folderPath`.
    - Prevent the metadata cache from returning a terminal result for media timeline actions, so each activation reaches exactly one host request.
    - Preserve the ready record/card and clear only transient importing UI after missing-comp/path or host failures.
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.8, 3.1, 3.2, 3.3, 3.4, 3.9, 3.10, 3.11, 3.12, 7.4, 7.15_

  - [ ] 5.3 Write the property test for the pending durability guard
    - **Property 3: Incomplete durability always excludes timeline action**
    - Generate every incomplete durability prefix in `tests/optimistic-card-placeholder.property.test.js`; assert pending projection, disabled normal action, in-progress classification, and zero timeline requests regardless of predicted folder/file existence.
    - **Validates: Requirements 2.1, 2.3, 2.4, 2.6**

  - [ ] 5.4 Write the property test for valid legacy-record reconciliation
    - **Property 5: Valid legacy records reconcile to ready**
    - Generate persisted marker-less records with readable media in `tests/optimistic-card-placeholder.property.test.js`; assert targeted ready persistence without identity/order changes or full scans.
    - **Validates: Requirements 2.11**

  - [ ] 5.5 Write the property test for single, record-exact ready requests
    - **Property 6: Ready-card requests are single and record-exact**
    - Extend `tests/import-section-derivation.property.test.js` with generated ready records, stale DOM paths, mismatched visible sections, and seeded metadata cache; assert exactly one request carrying the final record’s folder, main file, and section.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 7.4**

  - [ ] 5.6 Write the property test for retryability after timeline failure
    - **Property 7: Timeline failure preserves retryability**
    - Generate host/path failure outcomes in `tests/import-section-derivation.property.test.js`; assert unchanged ready record/card identity, paths, action availability, and order after each failure.
    - **Validates: Requirements 3.12**

  - [ ] 5.7 Add pending, corrupt-record, path, cache, and routing examples
    - Cover pending activation, compatibility-checking activation, invalid `mainFile`, missing active composition, removed folder, missing exact file, stale `data-folder`, mismatched visible section, and a warm metadata cache.
    - Assert pending feedback wins over missing-path errors, ready requests remain single, no wildcard/path reconstruction occurs, success feedback uses the resolved section, and failure leaves the card retryable.
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.8, 3.1, 3.2, 3.3, 3.4, 3.8, 3.9, 3.10, 3.11, 3.12, 7.4_

  - [ ] 5.8 Add startup and reopen compatibility examples
    - Extend the startup progressive/lifecycle/reconcile suites for explicit ready records with placeholder, completed, and failed thumbnails; assert immediate action restoration after reopen.
    - Cover marker-less valid records becoming ready through targeted validation after first paint and invalid records remaining retained/non-actionable for repair.
    - Assert no first-paint block, no full filesystem rescan, and no cleanup/deletion of preexisting records.
    - _Requirements: 2.8, 2.9, 2.10, 2.11, 7.7, 7.8, 7.9, 7.15_

- [ ] 6. Carry exact `mainFile` through host image dispatch with legacy fallback intact
  - [ ] 6.1 Add exact-mode `mainFile` dispatch in `jsx/import.jsx`
    - Decode the additive `mainFile` field in `importBatch`, pass it through `csDispatchImport`, and forward it to image/footage direct-import routines using ES5-compatible code.
    - When both `folderPath` and `mainFile` are present, validate the basename, construct only that exact file byte-for-byte, confirm it stays inside the folder, and never consult metadata or wildcard fallbacks.
    - Return item-specific actionable errors for missing composition, folder, exact file, corrupt basename, or import/layer failure.
    - Preserve existing `meta.json` and name/pattern fallback behavior when `mainFile` is absent, and preserve non-media dispatch plus `icon`, `overlay`, `element`, `png`, and `image` routing.
    - Keep the existing undo group, project snapshot rollback, selected-layer anchoring, playhead placement, and viewer refresh behavior.
    - _Requirements: 3.2, 3.3, 3.5, 3.6, 3.7, 3.9, 3.10, 3.11, 3.12, 7.4_

  - [ ] 6.2 Add focused host dispatch and layer-placement tests
    - Add a harness around the real `importBatch`, `csDispatchImport`, and `importImageDirect` slices from `jsx/import.jsx`.
    - Assert icon-family sections select image import, exact folder/main-file values reach `ImportOptions`, one created layer references that footage item, and success is returned.
    - Cover missing comp/folder/file, invalid basename, exact-mode no-fallback behavior, and host failure rollback without catalog-fixture mutation.
    - Verify legacy callers without `mainFile` still use existing metadata/pattern fallback and non-media routes remain byte-compatible.
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12_

- [ ] 7. Wire and validate the complete picker-to-ready-card-to-host flow
  - [ ] 7.1 Extend `tests/media-pipeline-integration.test.js` for the wired production pipeline
    - Verify picker dialog calls create catalog records/cards but issue no `importBatch` call or timeline mutation.
    - Drive mixed folder outcomes through real coordinator/repository/card wiring; retain successful records/files/cards, remove failed provisional state, preserve survivor order, and emit exact summaries after cleanup.
    - Hold thumbnail work pending while a durable card becomes ready and imports successfully, then cover thumbnail failure without loss of actionability.
    - Reopen from the persisted index and verify actions for placeholder, completed-thumbnail, failed-thumbnail, and validated preexisting records.
    - _Requirements: 1.6, 1.7, 2.7, 2.8, 2.9, 2.10, 3.1, 3.5, 3.6, 3.7, 3.8, 4.2, 4.3, 4.4, 4.6, 4.7, 4.8, 4.9, 5.8, 5.9, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 7.15_

  - [ ] 7.2 Add focused discovery, path, ordering, lifecycle, and no-rescan regressions
    - Add only missing assertions to the existing media-import batch, terminal, lifecycle, thumbnail-resource, async-I/O, stage-worker, template-catalog, import-section, save-path, and startup suites.
    - Pin baseline supported extensions, traversal limits, dedupe/order, one-pass sanitization, normalized persisted paths, keyed order preservation, no whole-folder rollback, no full scan, and derivative-state independence.
    - Ensure the focused cases exercise both synchronous production persistence and injected asynchronous persistence.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.13, 7.14, 7.15_

  - [ ] 7.3 Extend compatibility checks and run the focused automated regression matrix
    - Extend `tests/media-cep-compatibility.test.js` only as needed to scan all touched panel files for CEP-safe ES5 and `jsx/import.jsx` for ExtendScript-safe ES5 and additive bridge encoding.
    - Run the targeted property, example, integration, host, lifecycle, path, async-I/O, stage-worker, and startup suites with Jest in non-watch mode (`--runInBand`); repair only regressions caused by this feature.
    - Confirm every property runs at least 100 generated cases and retains its exact feature/property tag.
    - _Requirements: 1.1, 1.6, 2.1, 2.7, 2.11, 3.1, 3.12, 4.5, 4.9, 5.7, 6.3, 6.8, 7.1, 7.4, 7.7, 7.10, 7.15_

- [ ] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All implementation and validation subtasks are required because they protect the shared durability boundary; none is marked optional.
- Preserve the existing discovery registry, traversal limits, source deduplication, destination naming, catalog ordering, verified persistence ladder, scheduler lanes, import engine, and host placement behavior unless a task explicitly changes it.
- Do not introduce a full filesystem rescan, a whole-folder transaction/rollback, a parallel catalog schema, or a second import subsystem.
- Use Jest single-run commands such as `npx jest <focused suites> --runInBand`; do not use watch mode or start a development server.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3"] },
    { "id": 2, "tasks": ["1.4", "2.1"] },
    { "id": 3, "tasks": ["2.2"] },
    { "id": 4, "tasks": ["2.3"] },
    { "id": 5, "tasks": ["2.4", "2.5"] },
    { "id": 6, "tasks": ["2.6", "2.7", "2.8"] },
    { "id": 7, "tasks": ["2.9", "2.12"] },
    { "id": 8, "tasks": ["2.10"] },
    { "id": 9, "tasks": ["2.11"] },
    { "id": 10, "tasks": ["2.13"] },
    { "id": 11, "tasks": ["4.1"] },
    { "id": 12, "tasks": ["4.2", "4.4"] },
    { "id": 13, "tasks": ["4.3"] },
    { "id": 14, "tasks": ["4.5"] },
    { "id": 15, "tasks": ["5.1", "5.2"] },
    { "id": 16, "tasks": ["5.3", "5.5"] },
    { "id": 17, "tasks": ["5.4", "5.6"] },
    { "id": 18, "tasks": ["5.7", "5.8"] },
    { "id": 19, "tasks": ["6.1"] },
    { "id": 20, "tasks": ["6.2"] },
    { "id": 21, "tasks": ["7.1"] },
    { "id": 22, "tasks": ["7.2"] },
    { "id": 23, "tasks": ["7.3"] }
  ]
}
```
