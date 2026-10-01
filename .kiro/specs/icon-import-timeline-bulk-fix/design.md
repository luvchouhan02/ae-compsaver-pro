# Technical Design: Icon Import Timeline and Bulk Reliability

## Overview

This feature repairs the icon workflow at the existing catalog durability boundary. Picker actions remain catalog ingestion only. A card becomes timeline-actionable only after its final library directory exists, its copied main file is a readable regular file, and `MediaEntryRepository` acknowledges a verified persistence commit containing those final values. Thumbnail work then continues independently.

The design deliberately reuses the current production pipeline:

```text
picker
  -> MediaImportCoordinator (discover, dedupe, prepare, insert pending cards)
  -> MediaEntryRepository (persist provisional records)
  -> MediaWorkCoordinator (copy, verify, persist final record)
       -> ready card immediately
       -> thumbnail / ffmpeg as non-gating derivative work

ready card action
  -> templates.js resolves the selected persisted record
  -> importTemplates sends one record-exact request
  -> importBatch / csDispatchImport
  -> importImageDirect imports <folderPath>/<mainFile> into the active comp
```

No new production subsystem is introduced. The implementation remains within the five existing boundaries that already own the behavior:

- `js/core/fastMediaEngine.js`
- `js/core/persistence.js`
- `js/core/keyedMediaCardHelper.js`
- `js/templates/templates.js`
- `jsx/import.jsx`

The supported-media table, recursive discovery limits, source identity algorithm, storage naming rules, catalog insertion order, verified local-storage ladder, import engine, and host layer-placement routines remain the sources of truth.

## Repository Findings and Design Constraints

The current code already provides most required primitives:

| Existing boundary | Current behavior relevant to this feature | Required adjustment |
| --- | --- | --- |
| `openMediaPicker` / `importMediaFile` / `importMediaFolder` in `fastMediaEngine.js` | Picker results enter `MediaImportCoordinator`; no timeline import is intentionally requested | Preserve the boundary and add result-specific feedback only |
| `MediaImportCoordinator` | Recursively discovers with `SUPPORTED_MEDIA_EXTENSIONS`, `MEDIA_DISCOVERY_*`, and `mediaPathIdentity`; inserts pending cards and commits one optimistic batch | Preserve discovery exactly; retain all candidates in an item outcome table; do not collapse item failures into one folder failure |
| `MediaWorkCoordinator` | Runs copy -> thumbnail -> optional ffmpeg -> completion; readiness currently waits for derivatives | Insert the durability transition after copy verification and before derivatives; make derivative completion non-gating |
| `MediaEntryRepository` | Provides `commitOptimisticBatch`, `patchById`, verified persistence, ordered publication, and mirror synchronization | Add one transactional, idempotent `removeById` operation for failed provisional records |
| `KeyedMediaCardHelper` | Provides keyed insertion and in-place patching; has `unregister` but no item-local DOM removal | Add keyed, idempotent card removal and preserve all existing patch behavior |
| `renderTemplateCardMarkup` | Emits `.media-pending` from `_isPending`, preserves one thumbnail patch target, and stores `data-folder` | Reuse pending visuals; expose state/accessibility attributes, but do not make DOM attributes authoritative for import paths |
| `importCurrentCardToTimeline` | Uses global `currentSection`, card `data-folder`, and no explicit `mainFile` | Resolve the selected catalog record by stable ID, guard pending first, and build the request from that record |
| `importBatch` / `csDispatchImport` / `importImageDirect` | Sends `folderPath`; image import rereads `meta.json` or scans as fallback | Add `mainFile`; when both exact fields are present, import only that file and do not substitute a fallback |

The core defect is therefore not recursive discovery or host image placement. It is the point at which a provisional card is allowed to act like a durable catalog record.

## Goals and Non-Goals

### Goals

1. Keep file and folder pickers catalog-only.
2. Establish one explicit durability gate for new media records.
3. Let each bulk item settle independently and progressively.
4. Remove only failed provisional state and artifacts owned by the failing operation.
5. Build ready-card timeline requests from the final persisted record.
6. Keep thumbnail generation outside required durability.
7. Preserve discovery, order, paths, section routing, startup behavior, and CEP compatibility.

### Non-Goals

- Replacing `MediaImportCoordinator`, `MediaWorkCoordinator`, or `importTemplates`.
- Changing supported extensions, traversal limits, deduplication, or discovery order.
- Reformatting existing library folders or migrating successful records to new paths.
- Making thumbnail or `meta.json` generation a condition of timeline usability.
- Adding a whole-folder transaction or rollback.
- Changing non-media card import behavior except to share the record-resolution helper where safe.
- Performing a full filesystem rescan after an item settles.

## Design Decisions

### D1. Picker actions remain catalog-only

`openMediaPicker` continues to invoke only `importMediaFile` or `importMediaFolder`. Those functions continue to delegate to `MediaImportCoordinator`. They must not call `importCurrentCardToTimeline`, `importTemplates`, `importBatch`, or any host layer routine.

The picker dialog itself remains one CEP `evalScript` call. Tests distinguish that dialog call from a timeline `importBatch` call. Catalog ingestion does not require an active `CompItem` and never reads active-composition state.

Cancellation exits before discovery and preserves both catalog and timeline state. Empty discovery returns the existing exact warning: `No supported media found in folder`.

### D2. The durability gate ends at final record persistence, not thumbnail completion

For a new item, `Ready_State` requires all of the following evidence:

1. The normalized `destinationFolder` exists and is a directory.
2. Copy completion has been observed.
3. `destinationMedia` exists, is a regular file, and can be opened for reading.
4. The final `folderPath`, `mainFile`, and destination `mediaFile` are passed to `MediaEntryRepository.patchById`.
5. That repository operation returns `ok: true`, which means the existing verified storage ladder has committed and `_publishDurable` has updated the shared index and `allTemplates` mirror.

The ready transition occurs immediately after item 5 and is latched once. Thumbnail and ffmpeg states do not participate in this predicate.

The final durability patch has this semantic shape:

```javascript
{
    folderPath: item.destinationFolder,
    mainFile: item.fileName,
    mediaFile: item.destinationMedia,
    terminalState: "ready",
    derivativeStatus: "pending",
    thumbStatus: "placeholder",
    _isPending: false,
    updatedAt: nowIso
}
```

The pending record may already contain predicted `folderPath` and `mainFile` so the card can be inserted progressively, but those values are not trusted as durable until the final patch is acknowledged. A pending card cannot use them for a timeline request.

### D3. Thumbnail work is an independent derivative lifecycle

After the ready transition, the existing thumbnail worker and optional ffmpeg fallback continue through the current scheduler lanes. Their results only patch derivative fields:

- success: `thumbStatus: "ready"`, thumbnail path, optional proxy path;
- failure/unavailable: `thumbStatus: "failed"`, `derivativeStatus: "derivative-unavailable"`.

Neither result changes `terminalState: "ready"`, `_isPending: false`, `folderPath`, `mainFile`, `id`, or catalog order. A ready card with no completed thumbnail uses the existing stable empty `<img class="thumb-img">` target and placeholder visual. A failed thumbnail uses the existing `thumb-failed` visual and remains actionable.

The self-describing `meta.json` write remains best-effort background work. It is attempted with final record fields even when thumbnail decoding fails, but its success is not added to the durability gate. This preserves filesystem-scan recovery without reintroducing the original coupling.

### D4. Failed items clean up individually

Every candidate owns a failure/cleanup latch. A required-stage failure routes through one `failItem` path rather than patching a failed card in place.

The cleanup sequence is:

1. Remove the keyed provisional card if it is still attached.
2. Transactionally remove the provisional record from `MediaEntryRepository` and therefore from the shared index and in-memory mirror.
3. Remove owned partial files and unique owned directories from the operation ownership ledger.
4. Record any residual artifact or repository/card cleanup error as an actionable reason.
5. Publish exactly one `Failed_Item` outcome after required cleanup promises settle.

Missing cards, missing records, and already-removed files are successful idempotent cleanup outcomes. Re-running cleanup produces the same final state.

A failure never invokes batch rollback. Other item workers remain admitted, ready records remain committed, and successful files remain on disk.

### D5. Timeline requests use the selected final record

`importCurrentCardToTimeline` resolves the selected record by stable card ID first, using `TemplateCatalog.get` or `allTemplates`; the existing name/category route remains only as a compatibility fallback for records without a usable stable ID.

For media records, no path reconstruction is allowed. The request is built from the resolved record:

```javascript
{
    id: record.name,             // preserves existing host display-name semantics
    recordId: record.id,         // correlation only; additive
    name: record.name,
    category: record.category,
    section: getTemplateSection(record),
    sourcePath: mediaRootFromFolderPath(record.folderPath),
    folderPath: normalizeFolderPath(record.folderPath),
    mainFile: record.mainFile
}
```

`currentSection` is not used for media routing. `card.dataset.folder` is not used as the authority. This prevents a stale DOM path, a name-derived fallback, or the visible navigation tab from overriding the final record.

The pending guard runs before path validation, metadata cache lookup, and `importTemplates`. Therefore a pending activation produces an in-progress result and exactly zero timeline requests even if its predicted folder does not exist yet.

### D6. Exact host fields take precedence over legacy lookup

`importBatch` adds `mainFile` to the per-template dispatch arguments. `csDispatchImport` forwards it to image and footage direct-import routines.

When `folderPath` and `mainFile` are both present, `importImageDirect` uses exact mode:

```javascript
var folder = new Folder(folderPath);
var sourceFile = new File(folder.fsName + "/" + mainFile);
```

Exact mode has no metadata or wildcard fallback. If the folder or exact file is missing at action time, the host returns an actionable item-specific reason. This is essential: silently choosing another image would violate source fidelity.

Legacy callers that do not send `mainFile` retain the existing `meta.json` and name/pattern fallback behavior. Non-media import dispatch is unchanged. `icon`, `overlay`, `element`, `png`, and `image` continue to route to `importImageDirect`.

### D7. Preexisting records use a compatibility validation path

A newly persisted ready record carries explicit `terminalState: "ready"` and `_isPending: false`, so warm paint can expose its action immediately on reopen.

A preexisting media record with no pending marker is not treated as a newly active import. The existing startup flow queues a targeted, bounded filesystem validation for that record rather than a full library scan. The compatibility classifier marks it ready only when:

- its normalized `folderPath` exists as a directory;
- `folderPath/mainFile` exists and is readable; and
- the record is present in the persisted index.

The first bounded paint is not blocked. Until validation settles, the card is non-actionable in the compatibility-checking state; successful validation patches the explicit ready marker in place. Invalid legacy records are retained for existing repair/reconciliation behavior and are never deleted as if this operation owned them. `ensureProductionMediaRuntime` owns this targeted compatibility queue and runs it through the existing filesystem scheduler lane after first paint.

### D8. Cross-cutting race and fidelity constraints

Four details are required to keep the preceding decisions true under real panel timing:

1. **One repository mutation queue.** All final-ready patches, failed-item removals, and later derivative patches issued by the media coordinators pass through one promise chain. The chain continues after a rejected operation. This prevents two asynchronously persisted item snapshots from publishing over each other; the existing synchronous production storage path keeps its current timing, while injected asynchronous persistence remains correct.
2. **Placeholder seed, not source preview.** A newly prepared pending record keeps `thumbnail` and `thumbnailPath` empty. `sourcePath` remains dedupe/source metadata and is not temporarily promoted to a card thumbnail. Therefore a gate that completes before derivative work always projects the standard placeholder until an actual thumbnail patch arrives.
3. **No media cache short-circuit.** The metadata cache may seed host metadata, but `resolveCached` must return no terminal cached result for a media timeline action. Timeline insertion is a side effect, so every ready-card activation reaches exactly one host request even when metadata is cached.
4. **Validate, never re-sanitize, exact main filenames.** Exact host mode requires `mainFile` to be one basename with no slash, backslash, `.` or `..` segment. Invalid persisted data produces an actionable corrupt-record error. A valid name is concatenated byte-for-byte without another sanitization pass, and the resulting file must remain inside `folderPath`.

## Architecture and Component Boundaries

### 1. Panel entry and feedback adapter — `fastMediaEngine.js`

Responsibilities:

- Keep picker calls catalog-only.
- Translate coordinator results into exact file/folder feedback.
- Show an initial `Importing media...` status for folders.
- Format success, partial-success, all-failed, empty, cancellation, and operation-level failures separately.
- Keep production scenario metrics alive until derivative work is idle even if the required import result settles earlier.

It does not decide item durability and does not inspect the active composition.

### 2. Discovery and batch coordinator — `MediaImportCoordinator`

Responsibilities:

- Preserve `_expandCandidate`, `discover`, `SUPPORTED_MEDIA_EXTENSIONS`, `MEDIA_DISCOVERY_*`, and `mediaPathIdentity` behavior.
- Prepare one stable item/record pair per accepted source.
- Preserve discovered candidate order.
- Insert pending cards progressively with `KeyedMediaCardHelper.insertBatch`.
- Persist provisional records with the existing `commitOptimisticBatch`.
- Retain item outcomes for candidates skipped by keyed insertion rather than silently dropping them from batch accounting.
- Delegate required stages to `MediaWorkCoordinator`.
- Aggregate item outcomes without converting item failures into an operation-level failure.
- Refresh category counts after item-local removals using the existing coalescer.

An error before candidate creation produces `Operation_Level_Failure`. Any error after candidates exist is assigned to affected item outcomes.

### 3. Required and derivative work coordinator — `MediaWorkCoordinator`

Responsibilities:

- Own per-item stage state and at-most-once latches.
- Run copy and post-copy verification in the filesystem lane.
- Request the final repository patch and wait for its acknowledgment.
- Publish ready immediately after the durability gate.
- Continue thumbnail/ffmpeg jobs independently.
- Invoke item cleanup for required-stage failures.
- Expose two completion concepts:
  - **required settled**: every candidate is ready or failed cleanup has settled; used for the import result/summary;
  - **background idle**: all optional derivative work and refresh timers have settled; used for metrics and disposal accounting.

This split avoids making a thumbnail timeout part of catalog durability while preserving bounded scheduler ownership and teardown.

### 4. Catalog repository — `MediaEntryRepository` in `persistence.js`

Existing methods remain authoritative:

```javascript
repository.commitOptimisticBatch(entries);
repository.patchById(id, finalFields);
repository.getById(id);
repository.snapshot();
```

One method is added:

```javascript
repository.removeById(id);
// -> { ok: true, removed: true|false, snapshot: [...] }
// -> { ok: false, operation: "removeById", error: ... }
```

`removeById` requirements:

- normalize and search by stable ID;
- if absent, return idempotent success without flagging a full scan;
- if present, splice only that entry from a candidate snapshot;
- preserve every survivor's relative order;
- persist through `_commitEntries` and the verified storage ladder;
- publish to the shared `LibraryIndex` and `allTemplates` only after persistence succeeds;
- preserve the last successful durable snapshot on failure.

No direct `localStorage.setItem` path is added.

### 5. Keyed card adapter — `KeyedMediaCardHelper`

The existing insert/patch contract is preserved. One item-local operation is added:

```javascript
cards.removeById(id);
// idempotent success when the registration/node is already absent
// removes only #tpl-<id> and its registry entry
```

Ready patches continue to happen in place; they never remove/reinsert a node. Removal of a failed node naturally preserves sibling order. State attributes and classes are projections of the catalog record, not alternate data storage.

### 6. Card renderer and interaction coordinator — `templates.js`

Responsibilities:

- Render pending/ready/thumbnail state from record fields.
- Reuse `.media-pending`, the stable thumbnail target, and existing failure visuals.
- Mark pending actions disabled for accessibility (`aria-disabled`) while still allowing activation to reach the in-progress feedback guard.
- Resolve the selected catalog record by stable ID.
- Classify pending before checking paths.
- Build one single-template request from final record fields.
- Preserve the ready card after any host/timeline failure.
- Use the resolved record section for success feedback as well as routing.

Non-media cards continue through their current request construction unless they can safely use the same record resolver without payload changes.

### 7. After Effects host boundary — `jsx/import.jsx`

Responsibilities:

- Decode the additive `mainFile` field.
- Forward exact media fields through `csDispatchImport`.
- In exact mode, validate folder then exact file and import that `File` only.
- Preserve the existing active-comp check, undo-group discipline, project snapshot rollback, selected-layer anchoring, playhead placement, and viewer refresh.
- Return item-specific reasons for missing composition, folder, main file, or host import failure.
- On success, create a `FootageItem` from the exact file and a layer whose source is that item.

All ExtendScript remains ES5-compatible.

## Data Models

### Catalog record

The existing record is retained; no parallel catalog schema is introduced.

```javascript
{
    id: "media-...",                 // stable Card_ID
    name: "logo",                    // source-derived Item_Name
    category: "Brand",               // Category_Name
    section: "icon",                 // card-derived routing source
    type: "media",
    mediaType: "image",

    folderPath: "C:/lib/icon/Brand/media-...", // normalized Backing_Destination
    mainFile: "logo.png",            // final stored basename
    mediaFile: "C:/lib/icon/Brand/media-.../logo.png",
    sourcePath: "C:/source/logo.png", // dedupe identity input only

    terminalState: "pending" | "ready",
    _isPending: true | false,
    derivativeStatus: "pending" | "available" | "derivative-unavailable",
    thumbStatus: "placeholder" | "ready" | "failed",
    thumbnailPath: "..."             // optional
}
```

Failed new items do not remain as persisted records. `terminalState: "failed"` may exist transiently in an item outcome but is not the final catalog representation.

### Work item

```javascript
{
    id: record.id,
    batchId: "media-batch-...",
    sourcePath: "...",
    destinationFolder: "...",
    destinationMedia: "...",
    fileName: "...",
    entry: record,

    requiredState: "pending" | "ready" | "failed",
    derivativeState: "not-started" | "queued" | "running" | "available" | "unavailable",
    readyLatched: false,
    failureLatched: false,
    cleanupPromise: null,
    ownership: ownershipLedgerReference
}
```

### Artifact ownership ledger

Ownership is recorded before mutation and confirmed after creation:

```javascript
{
    path: "C:/lib/icon/Brand/media-.../logo.png",
    kind: "file" | "directory",
    existedBefore: false,
    createdByOperation: true,
    ownerIds: ["media-..."],
    safeBoundary: "C:/lib/icon/Brand/media-..."
}
```

Rules:

- Source files are never entered in the ledger.
- A path that existed before the operation is never deleted.
- A path is deleted only when every owning item failed.
- Shared category/section directories are retained when any successful owner needs them.
- Cleanup proceeds deepest path first and tolerates already-missing paths.
- Every candidate's unique destination folder is the maximum recursive-delete boundary; no cleanup may escape it.

### Item outcome and bulk result

```javascript
{
    id: "media-...",
    itemName: "logo",
    status: "success" | "failed",
    stage: "durability" | "card-insert" | "provisional-persist" | "copy" |
           "verify-folder" | "verify-main-file" | "final-persist" | "cleanup",
    reason: null | "actionable text",
    cleanupReasons: []
}
```

```javascript
{
    ok: true, // coordinator completed; item status is expressed below
    status: "success" | "partial-success" | "failure",
    candidateCount: 5,
    successCount: 3,
    failureCount: 2,
    items: [/* exactly one outcome per candidate */],
    backgroundIdle: promiseLike
}
```

`ok: false` is reserved for an operation-level failure before candidates exist. This prevents a completed all-failed item batch from being confused with an unavailable engine or failed discovery operation.

## Detailed Flows

### File picker flow

1. User selects a file.
2. `openMediaPicker(false)` normalizes only path separators and calls `importMediaFile`.
3. `discover` validates the file with the existing registry and source dedupe.
4. One candidate is prepared when supported and unique.
5. The pending card/record enters the standard durability flow.
6. No active-composition query or timeline request occurs.

### Folder picker flow

1. User selects a folder.
2. `_expandCandidate` performs the existing bounded breadth-first traversal.
3. Unsupported entries are ignored; unreadable children retain existing discovery behavior.
4. `discover` applies the current extension registry and source identity dedupe.
5. Candidate order is the accepted discovery order.
6. One pending card/record is created per candidate.
7. Each candidate settles independently.
8. The summary is built only after all required item outcomes and failed-item cleanup settle.

### Required item lifecycle

```text
PREPARED
  -> pending card inserted
  -> provisional record persisted
  -> copy destination main file
  -> verify destination directory
  -> verify exact main file is regular + readable
  -> persist final record
  -> READY (record first, keyed card projection immediately after)
  -> schedule/continue optional derivative work
```

Any failure from card insertion through final persistence routes to item cleanup. Duplicate stage callbacks observe the latches and perform no second transition.

### Card activation flow

1. Resolve the record represented by the card.
2. If it is an active-import pending record, return `Pending_State`, show `Catalog import for "<name>" is still in progress`, and stop.
3. If it is not a usable media record, return an item-specific repair reason and stop.
4. Build the single-template payload from the record's `folderPath`, `mainFile`, and section.
5. Call the existing `importTemplates` engine once.
6. The engine issues one `importBatch` bridge call.
7. Host exact mode imports `folderPath/mainFile` as image footage and adds it to the active composition.
8. Success shows icon-placement feedback; failure removes only transient `.importing` UI and preserves the ready record/card.

### Bulk settlement and summary flow

The batch keeps a table keyed by candidate ID. A candidate can write its terminal outcome only once.

- A ready item is counted immediately after final repository acknowledgment.
- A failed item is counted only after required cleanup settles.
- A failed item does not cancel scheduler work owned by siblings.
- A partial result is not represented as an exception.
- Counts are derived from the terminal table, never from number of rendered cards or repository length.
- Reasons are derived from structured stage failures, then formatted for the user.

Example feedback shapes:

- success: `Imported 5 of 5 media items.`
- partial: `Imported 3 of 5 media items; 2 failed. logo: main file copy failed — check source access and retry. mark: cleanup could not remove <path> — close programs using the file and remove it manually.`
- all failed: `Imported 0 of 5 media items; 5 failed.` followed by one reason per item.
- operation failure: `Folder import could not start: library root is not set — choose a library folder and retry.`

UI truncation may visually abbreviate a long toast only if the complete structured result remains available to the existing logging/details surface; counts and item reasons themselves are not replaced by a generic message.

## State and Ordering Invariants

1. `terminalState === "ready"` implies an acknowledged final record with normalized `folderPath` and exact `mainFile`.
2. `_isPending === true` implies the normal card action issues no timeline request.
3. `thumbStatus` never determines ready/pending state.
4. `id`, `name`, `category`, `section`, `folderPath`, and catalog position are immutable across the pending-to-ready transition.
5. Keyed patches do not move cards.
6. Keyed removals preserve survivor order in DOM, repository snapshot, shared index, and `allTemplates`.
7. Every candidate produces exactly one success or failed outcome.
8. Failed-item cleanup never mutates a successful item's record, card, or artifacts.
9. Timeline failure never rolls back catalog durability.
10. Picker import never mutates the After Effects project.

## Path and Routing Preservation

`MediaImportCoordinator._prepare` remains the only destination builder. It continues to use the current helpers in their current roles:

- `canonicalizeMediaSourcePath`
- `mediaPathIdentity`
- `mediaPathJoin`
- `mediaSafeName`
- `mediaIdFolderSegment`
- `mediaStorageFileName`
- `mediaWindowsLongPath` only at filesystem boundaries

Category and item/identifier segments are not sanitized again during copy, final persistence, card action, or host dispatch. The final stored `folderPath` is the normalized value used for `mkdir` and copy. The final `mainFile` is the capped stored filename used for the copy, not the original basename when those differ.

Card routing uses `getTemplateSection(record)`. Global navigation state may select a grid, but it cannot select the host import routine for an already selected card.

## Error Handling

| Failure | Item/operation classification | Cleanup | User action |
| --- | --- | --- | --- |
| Picker cancelled | cancelled operation | none | none |
| No supported/unique paths | successful empty operation | none | choose a folder containing supported media |
| Engine unavailable/root unset before discovery | operation-level failure | none | restore runtime/select library root and retry |
| Card insertion skip for one candidate | failed item | remove any provisional state owned by that ID | retry after resolving duplicate/markup issue |
| Provisional batch persistence fails | every created candidate fails at provisional persistence | remove cards; no successful durable index mutation to roll back | fix storage availability and retry |
| Destination creation/copy fails | failed item | remove owned partial destination artifacts and provisional state | check source/destination access and retry |
| Folder verification fails | failed item | same | restore writable library and retry |
| Main file absent/not regular/not readable | failed item | same | check source/permissions and retry |
| Final record persistence fails | failed item | remove copied owned artifacts and pending record | restore catalog storage and retry |
| Thumbnail/ffmpeg fails | successful ready item with failed derivative | no durability cleanup | card remains usable; retry thumbnail separately if desired |
| Pending card activated | pending outcome | none | wait for catalog import to finish |
| No active composition | timeline action failure | none; ready card retained | open a composition and retry |
| Ready folder missing later | timeline action failure | none; ready card retained | re-import/restore the item and retry |
| Ready main file missing later | timeline action failure | none; ready card retained | restore exact file/re-import and retry |
| Host import/layer placement fails | timeline action failure with host rollback | no catalog cleanup | correct host/project condition and retry |
| Artifact cleanup fails | failed item with incomplete cleanup | retain exact residual reason | close file handles/remove named residual manually |

Errors are stage-tagged internally. `mediaDescribeImportFailure` is extended to consume structured item results rather than flattening a whole batch into `Folder import failed`.

## Progressive Rendering and Lifecycle Preservation

- Pending cards are inserted before filesystem work, as today.
- Ready and failed transitions target one stable ID; they do not rebuild the grid.
- Category/count refreshes remain coalesced.
- No item settlement invokes `getAllTemplates` or a full filesystem scan.
- Discovery remains bounded and asynchronous.
- Ready cards can be clicked while sibling items and their thumbnails are still running.
- Optional derivative jobs remain scheduler-owned and are cancelled/disposed by the existing FastMedia lifecycle.
- Explicit ready records warm-paint as actionable on reopen.
- Legacy validation is targeted and scheduled after the bounded first paint.

## CEP and ExtendScript Compatibility

All panel code remains ES5 syntax: `var`, function expressions/declarations, prototype methods, and existing Promise usage. No `async`/`await`, classes, generators, `Map`, `Set`, optional chaining, or Node APIs without callback-compatible fallbacks are introduced.

Filesystem readability uses an ES5-compatible wrapper: prefer `fs.access`/`fs.promises.access` when available, otherwise open the exact file read-only and close it. Long-path conversion stays at the filesystem call boundary.

`jsx/import.jsx` remains ExtendScript-compatible ES5. The additive host argument is encoded through the existing bridge functions; no raw path is interpolated into executable script text.

## Testing Strategy

The test plan extends existing repository harnesses rather than creating a parallel architecture model.

### Property tests

Use `fast-check` with at least 100 iterations per property. Every property test includes a comment/tag in this exact form:

```text
Feature: icon-import-timeline-bulk-fix, Property <number>: <property title>
```

Primary suites:

- `tests/media-import-coordinator.test.js`: generated discovery trees, independent item schedules, required-stage failure injection, progressive readiness, outcome totality, order.
- `tests/optimistic-card-placeholder.property.test.js`: pending gate, final persistence acknowledgment, placeholder-ready behavior, legacy compatibility validation.
- `tests/media-index-migration.test.js`: `removeById` transactionality, idempotence, ordered mirror publication, persistence failure rollback.
- `tests/keyed-media-card-helper.test.js` and `tests/single-card-patch-job-completion.property.test.js`: keyed ready patch/removal isolation and DOM order.
- `tests/import-section-derivation.property.test.js`: record-derived section plus exact `folderPath` and `mainFile` payload fidelity under mismatched visible sections.
- `tests/save-path-builders.test.js` plus focused fast-media path cases: baseline sanitizer/path byte parity and long stored filenames.

### Example and edge tests

- Pending card activation shows in-progress and performs no import call.
- Exact empty-folder warning and picker cancellation.
- Ready card with no active composition.
- Ready card with a removed folder.
- Ready card with an existing folder but missing exact main file; verify no wildcard fallback.
- Thumbnail held pending while the card becomes ready and imports.
- Thumbnail failure leaves ready action and failure visual.
- Cleanup unlink/rmdir failure names each residual artifact.
- Legacy marker-less record with existing readable media becomes ready through targeted validation.

### Integration tests

Extend `tests/media-pipeline-integration.test.js` to drive the real wired panel pipeline:

1. Picker dialog call occurs, catalog cards appear, and no `importBatch`/timeline mutation occurs.
2. Mixed folder plans retain successful records/files/cards and remove failed provisional state.
3. Ready cards become actionable before deferred thumbnail completion.
4. Exact counts/reasons are emitted after cleanup.
5. Reopen from the persisted index preserves actions for placeholder, ready-thumbnail, and failed-thumbnail cards.

Add a focused host harness around the real `importBatch`, `csDispatchImport`, and `importImageDirect` slices from `jsx/import.jsx`:

- icon dispatch selects image import;
- exact folder/main file reaches `ImportOptions`;
- one layer is created and references that footage item;
- missing comp/folder/file returns actionable text;
- host failure rolls the modeled project back without changing catalog fixtures.

### Regression suites

Run the focused suites above, then preserve these established contracts:

- `tests/performance/media-import-batch.property.test.js`
- `tests/performance/fast-media-terminal-regression.test.js`
- `tests/media-card-lifecycle-preservation.property.test.js`
- `tests/media-thumbnail-resources.property.test.js`
- `tests/media-async-io.property.test.js`
- `tests/media-stage-workers.test.js`
- `tests/template-catalog.test.js`
- `tests/import-section-derivation.property.test.js`
- `tests/save-path-builders.test.js`
- `tests/media-cep-compatibility.test.js`
- startup progressive/lifecycle/reconcile suites under `tests/performance/`

Targeted tests run with Jest's non-watch mode. No development server or watcher is required.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties bridge human-readable requirements and machine-verifiable correctness guarantees.*

### Property 1: Bounded discovery equals the baseline accepted set

For any selected supported file or generated folder hierarchy, recursive discovery produces exactly the first-occurrence set of unique supported source identities admitted by the existing registry and discovery limits, while unsupported files produce no candidates and do not prevent later supported files from being discovered.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 7.10, 7.11, 7.12**

### Property 2: Empty discovery is catalog-neutral

For any initial ordered catalog and any picker selection whose baseline discovery result contains zero candidates, completing discovery leaves every catalog record, card, and order position unchanged.

**Validates: Requirements 1.9**

### Property 3: Incomplete durability always excludes timeline action

For any accepted item and any execution prefix in which at least one durability predicate is not satisfied or the final record persistence has not been acknowledged, the item remains pending, its normal card action is disabled, activating it issues zero timeline requests, and its outcome is classified as in-progress regardless of current folder or file existence.

**Validates: Requirements 2.1, 2.3, 2.4, 2.6**

### Property 4: Durability produces one ready transition independent of derivatives

For any accepted item, satisfying directory existence, completed copy, readable regular main-file verification, and final record persistence acknowledgment produces exactly one ready transition; failure of any required stage produces no ready transition, and every thumbnail/ffmpeg state leaves that durability decision unchanged.

**Validates: Requirements 2.7, 2.10, 2.12**

### Property 5: Valid legacy records reconcile to ready

For any preexisting marker-less media record whose persisted folder exists as a directory and whose recorded main file exists as a readable regular file, targeted compatibility validation classifies and persists that record as ready without changing its stable identity or catalog position.

**Validates: Requirements 2.11**

### Property 6: Ready-card requests are single and record-exact

For any ready media catalog record and any currently visible catalog section, one normal card action constructs exactly one single-template timeline request whose folder path, main file, and section equal the selected record's final stored values, independently of reconstructable fallback paths and global navigation state.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 7.4**

### Property 7: Timeline failure preserves retryability

For any ready card and any timeline request failure after its durability evidence remains valid, the catalog record, card identity, ready state, stored path, main file, and order remain unchanged and the normal card action remains available for retry.

**Validates: Requirements 3.12**

### Property 8: Bulk required work settles independently and totally

For any nonempty candidate set, any required-stage success/failure plan, and any settlement order, each candidate has one independent operation and receives exactly one terminal success or failed classification; each durable item becomes ready without waiting for siblings, and one failed item does not prevent any unsettled sibling from continuing.

**Validates: Requirements 4.1, 4.2, 4.4, 4.5**

### Property 9: Item-local transitions preserve identity and survivor order

For any ordered catalog and any sequence of pending-to-ready transitions and failed-item removals, every transitioned card preserves its ID, name, category, and stored folder path, and the surviving cards/records occur in the same relative order as in the original catalog.

**Validates: Requirements 4.7, 4.8, 7.5, 7.6**

### Property 10: Failed-item cleanup is isolated and idempotent

For any mixed-outcome batch and any valid artifact ownership ledger, cleaning every failed item one or more times removes its provisional card, in-memory record, persisted record, and owned partial artifacts, while preserving all unowned paths and all successful item records, cards, and files exactly.

**Validates: Requirements 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 7.13, 7.14**

### Property 11: Summary waits for cleanup and covers residual artifacts

For any bulk execution with failed items, no terminal summary is emitted before all required cleanup operations settle, and every owned artifact that remains because cleanup failed has an actionable, item-associated cleanup reason in the summary.

**Validates: Requirements 4.9, 5.10, 6.8**

### Property 12: Bulk summaries are exact, total, and correctly classified

For any nonempty vector of terminal item outcomes, the summary success and failure counts equal the corresponding outcome partitions, sum to the candidate count, include one actionable reason per failed item, and select success, partial-success, or failure exactly when the vector is all-success, mixed, or all-failed respectively.

**Validates: Requirements 4.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7**

### Property 13: Destination paths preserve sanitizer and copy parity

For any valid library root, category, item name, identifier, and source filename, destination preparation applies each existing path-segment sanitizer exactly once, produces the same bytes as the pre-feature baseline, and persists the same normalized folder and stored filename used by the successful copy.

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 14: Terminal and derivative updates remain item-local

For any catalog item that reaches ready or failed classification and any later thumbnail success or failure for a ready item, the system uses only keyed patch/removal and coalesced count refreshes with zero full filesystem rescans; thumbnail completion preserves card ID and stored folder, while thumbnail failure preserves ready action and applies the failure visual.

**Validates: Requirements 7.7, 7.8, 7.9**
