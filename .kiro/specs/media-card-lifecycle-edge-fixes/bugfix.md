# Bugfix Requirements Document

## Introduction

This bugfix covers **six follow-up edge cases** in the media (Image / Icon / Overlay / Video / Footage) card lifecycle of the CompSaver Adobe CEP + ExtendScript extension. They were found while closing out a prior set of nine root causes in the comp/template pipeline. **Those nine are already fixed and verified and are NOT re-opened here.**

The surfaces in scope are the panel-side card lifecycle (`js/templates/templates.js`), the persisted library index (`js/core/persistence.js`), the shared path sanitizers (`js/core/pathBuilders.js`), and — for verification only, not for modification — the ExtendScript host that owns folder creation and disk scanning.

### Verification outcome per reported bug

Every reported diagnosis was checked against the source before this document was written. Three were confirmed as stated, one was confirmed with a **corrected root-cause mechanism**, and two **do not reproduce as described** and are recorded here as non-defects with regression clauses instead of fixes.

| Bug | Reported | Verification result |
| --- | --- | --- |
| BUG 1 | Warm-paint cross-session blank card | **Confirmed, mechanism corrected.** `LIBRARY_ENTRY_FIELDS` is not the cause — it is exported for tests only and `LibraryIndex.prototype.serialize` persists `this._entries` whole, so any field present on an entry does round-trip. The actual cause is the explicit 8-field object literal passed to `li.insertAtHead` in `renderOptimisticCard` plus the 2-field `li.patchEntry` in `refreshCardThumbnail`, neither of which ever writes `thumbnail`. |
| BUG 2 | Media folder path reconstruction wrong in UI mutation helpers | **Confirmed as stated.** |
| BUG 3 | Category sanitization parity for PNG saves | **Confirmed as stated.** The panel helper is `cleanName` (`js/core/pathBuilders.js:53`), the documented twin of the host's `cleanStr` (`jsx/core.jsx:112`). Two panel call sites diverge, not one. |
| BUG 4 | `renderIconCardsMarkup` lacks the `file:///` guard | **Does not reproduce.** No function named `renderIconCardsMarkup` exists anywhere in the repo. The nearest analogue, `renderIcons` (`js/templates/templates.js:722`), genuinely lacks the guard, but it has **zero production callers** — the icon and overlay sections render through `renderCards` / `renderTemplateCardMarkup` / `VirtualGrid`. Recorded as a latent asymmetry, not a user-visible defect. |
| BUG 5 | `markTemplatesDirty` is defined but never called | **Confirmed as stated.** Exactly one occurrence repo-wide: the definition at `js/templates/templates.js:661`. |
| BUG 6 | `element` missing from startup scan sections | **Does not reproduce.** `STARTUP_SCAN_SECTIONS` does omit `element`, but the host's `getAllTemplates` expands an `overlay`-filtered chunk to `["overlay", "element"]` specifically so a panel that knows only the seven canonical folders still sees `element/` assets. Adding `element` to the panel list would make the panel issue two chunks that each return both folders, **duplicating every overlay and element record**. Recorded as a non-defect with a regression clause. |

### Impact

BUG 1 is the only defect a user sees on every session: a card that had a working thumbnail renders as a blank placeholder after the panel is reopened, permanently, until a full rescan happens to re-derive it. BUG 2 makes delete and rename silently no-op on media cards. BUG 3 produces an unfindable folder — and therefore a blank card — for any image save whose category name contains a tab or a run of spaces. BUG 5 is a correctness hazard rather than a live symptom: the intended O(1) staleness signal is unreachable, so catalog freshness rests entirely on identity probes that are blind to in-place field mutations.

### Verification command

```
npx jest tests/media-pipeline-integration.test.js tests/media-import-coordinator.test.js tests/media-thumbnail-resources.property.test.js tests/performance/media-import-batch.property.test.js tests/comp-pipeline-units.test.js --runInBand
```

### Traceability

Clause numbering is grouped so each bug's defect, expected behavior, and regression clauses line up:

| Bug | Current Behavior | Expected Behavior | Unchanged Behavior |
| --- | --- | --- | --- |
| BUG 1 | 1.1, 1.2 | 2.1, 2.2 | 3.1, 3.2, 3.3 |
| BUG 2 | 1.3, 1.4 | 2.3, 2.4 | 3.4, 3.5 |
| BUG 3 | 1.5, 1.6 | 2.5, 2.6 | 3.6, 3.7 |
| BUG 4 | 1.7, 1.8 | 2.7, 2.8 | 3.8, 3.9 |
| BUG 5 | 1.9, 1.10 | 2.9, 2.10 | 3.10, 3.11 |
| BUG 6 | 1.11, 1.12 | 2.11, 2.12 | 3.12, 3.13 |
| Cross-cutting constraints | — | — | 3.14 – 3.19 |

## Bug Analysis

### Current Behavior (Defect)

#### BUG 1 — Warm-paint cross-session blank card

Observable symptom: after closing and reopening the panel, media cards that previously showed a working thumbnail render as blank placeholder artwork. Trigger: any card whose persisted library-index entry carries `thumbnailPath` / `thumbStatus` but no `thumbnail`. Counterexample: save an image, wait for the thumbnail to appear, close the panel, reopen it — the card is blank.

1.1 WHEN a card is created by `renderOptimisticCard` (`js/templates/templates.js:2992-3007`) THEN the system inserts a library-index entry built from an explicit object literal containing only `id`, `name`, `category`, `section`, `folderPath`, `thumbnailPath`, `thumbStatus` and `favorite`, so the entry has no `thumbnail` field at all — and when that card's thumbnail later completes, `refreshCardThumbnail` (`js/templates/templates.js:2895-2900`) patches the entry with only `{ thumbStatus: "ready", thumbnailPath: <raw path> }`, deliberately withholding the cache-busted `thumbnail` URL it just computed and wrote into `allTemplates`, so the persisted entry never acquires one.

1.2 WHEN the panel reopens and `loadTemplates` takes the warm-paint branch (`js/templates/templates.js:47-58`) THEN the system assigns `allTemplates = li._entries` and back-fills only the missing `section` field, mapping nothing from `thumbnailPath` onto `thumbnail`, so `renderTemplateCardMarkup` reads an absent `thumbnail`, computes `thumbSrc = ""`, and emits the blank placeholder for a card whose `thumbnail.png` exists on disk.

#### BUG 2 — Media folder path reconstruction is wrong in UI mutation helpers

Observable symptom: removing or patching a media card silently does nothing to the persisted index — the card can reappear on the next reopen, or a rename is not durable. Trigger: any entry created by the media writer, whose folder segment is `media-<hex>`. Counterexample: import a video, delete the card, reopen the panel.

1.3 WHEN `_getTemplateFolderPath(name, cat)` (`js/templates/templates.js:2162-2169`) is asked for a media entry's folder THEN the system reconstructs `<normRoot>/<normSection>/<getSafeName(cat)>/<generateTemplateId(name)>`, while the media writer actually created the folder as `<root>/<section>/<mediaSafeName(category)>/<mediaIdFolderSegment(id)>` (`js/core/fastMediaEngine.js:1732`), whose final segment is `media-<hex>` derived from the entry id and never from the display name — so the two paths can never agree for a media entry.

1.4 WHEN `removeUITemplate` or `patchUITemplate` (`js/templates/templates.js:2172, 2186`) uses that reconstructed path against the library index THEN the system calls `li.removeEntry(folderPath)` / `li.patchEntry(folderPath, patchObj)` for a folder that is not in the index, so the persisted mutation is a no-op even though the in-memory `allTemplates` match — which is by `name` + `category` + `section`, not by path — succeeds, leaving the model and the persisted index divergent.

#### BUG 3 — Category sanitization parity for PNG saves

Observable symptom: an image/PNG card saves successfully on disk but renders blank, and the thumbnail refresh targets a folder that does not exist. Trigger: a category name containing a tab, a CR/LF, or two or more consecutive spaces. Counterexample: save an image into the category `"My\tCat"` or `"My  Cat"`.

1.5 WHEN the panel derives the image save folder in `scheduleBackground` (`js/templates/templates.js:3400`) or for the optimistic card (`js/templates/templates.js:3666`) THEN the system composes the category segment as `getSafeName(cat)` on the **raw** category string, while `getSafeName` performs no whitespace folding — it only replaces reserved characters and strips trailing dots and spaces (`js/core/pathBuilders.js:78-107`).

1.6 WHEN the host's `savePNGOnly` (`jsx/templates_save.jsx:1620-1634`) creates the same folder THEN the system composes it as `getSafeName(cleanStr(cat))` — `cat` is passed through `cleanStr` at decode time, which strips CR/LF/TAB, collapses whitespace runs to a single space and trims — so for any category containing a tab or a run of spaces the host writes one folder and the panel addresses a different one, and `refreshCardThumbnail(pngFolder, pngFolder + "/thumbnail.png")` refreshes a card at a path that has nothing on disk. The `name` segment does **not** have this defect: `generateTemplateId` already folds `cleanName` in (`js/core/pathBuilders.js:123-125`), so the divergence is confined to the category segment.

#### BUG 4 — Icon markup renderer lacks the `file:///` guard (does not reproduce as reported)

1.7 WHEN the reported function `renderIconCardsMarkup` is searched for THEN the system contains no such identifier in any file, so the defect cannot be confirmed at the location given; the nearest analogue is `renderIcons` (`js/templates/templates.js:722`), which builds `.icon-card` markup with `var thumbSrc = t.thumbnail ? t.thumbnail.replace(/\\/g, "/") : ""` and emits it directly into `<img src>` with no `file:///` scheme prefixing and no `encodeURI`, making it asymmetric with `renderTemplateCardMarkup` (`js/templates/templates.js:806-811`), which prefixes and encodes any non-`file:///` value.

1.8 WHEN the production icon and overlay sections render THEN the system does **not** reach `renderIcons` — it has zero callers in `js/**` and in `index.html`, and is referenced only as a stub in three test files that assert the keyed media path never calls it — so the missing guard is unreachable dead code and produces no user-visible symptom. No blank or failed icon thumbnail is attributable to it.

#### BUG 5 — `markTemplatesDirty` is defined but never called

Observable symptom: a card that was mutated in place keeps rendering its pre-mutation state for the rest of the session. Trigger: any field-only mutation of a middle-of-array `allTemplates` element that is not separately mirrored into `TemplateCatalog`.

1.9 WHEN `markTemplatesDirty` (`js/templates/templates.js:661-664`) is searched for as a call THEN the system contains exactly one occurrence of the identifier repo-wide — its own definition — so the revision counter `_templatesRevision` it exists to increment is never advanced by any mutation, and `catalogSourceChanged`'s first and cheapest test (`TemplateCatalog.sourceStamp() !== _templatesRevision`) can never fire.

1.10 WHEN a card is mutated in place — a field write on a middle-of-array `allTemplates` element, a thumbnail-ready event, or a `patchUITemplate` field patch — THEN the system leaves the array identity, its length, and its first and last elements unchanged, so the remaining identity probes in `catalogSourceChanged` (`js/templates/templates.js:678-690`) cannot observe the change, and catalog freshness depends entirely on each such site remembering to call `TemplateCatalog.patch` by hand; `refreshCardThumbnail` does so and documents why (`js/templates/templates.js:2918-2923`), which is direct evidence that the generic signal is the missing mechanism.

#### BUG 6 — `element` missing from startup scan sections (does not reproduce as reported)

1.11 WHEN `STARTUP_SCAN_SECTIONS` (`js/templates/templates.js:226`) is read THEN the system lists seven folders — `comp`, `layer`, `text`, `footage`, `effect`, `icon`, `overlay` — and omits `element`, and `SECTION_SCAN_FOLDERS` (`js/templates/templates.js:18-28`) maps the `element` section onto the `overlay` scan folder, so the panel never asks the host for an `element` chunk by name.

1.12 WHEN the host receives an `overlay`-filtered `getAllTemplates` call THEN the system expands the filter to `["overlay", "element"]` (`jsx/core.jsx:1804-1808`) precisely so a panel that knows only the seven canonical folders still sees `element/` assets, and normalizes each record scanned out of the `element` alias folder back to the canonical `overlay` section — so `element/` assets are **not** missed by startup or background sweeps, and the reported defect does not occur. Adding `element` to the panel's list would instead cause the panel to issue both an `overlay` chunk and an `element` chunk, each of which the host expands to both folders, duplicating every overlay and element record in the flattened result and in the persisted index.

### Expected Behavior (Correct)

#### BUG 1

2.1 WHEN a card's thumbnail becomes available and the library-index entry is written or patched THEN the system SHALL persist enough information to reconstruct a renderable thumbnail in a later session, either by recording a `thumbnail` value on the entry or by deriving one on read.

2.2 WHEN `loadTemplates` takes the warm-paint branch and an entry has a `thumbnailPath` and either `thumbStatus === "ready"` or a falsy `thumbnail` THEN the system SHALL set that entry's `thumbnail` from `thumbnailPath` before `filterAndRender` runs, in a form `renderTemplateCardMarkup` renders as an image rather than as placeholder artwork, so a reopened panel shows the same thumbnail the closed panel showed.

> **Design-phase decision, deliberately unresolved here.** The codebase invariant is documented at `js/templates/templates.js:2905-2913`: `thumbnailPath` is the **raw disk path** (what `renderOptimisticCard`'s `existsSync` probe needs) and `thumbnail` is the **cache-busted `file:///…?v=` URL** (which `renderTemplateCardMarkup` passes through verbatim). Verification of `renderTemplateCardMarkup:806-811` shows a raw path is also accepted — it is prefixed with `file:///` and `encodeURI`-ed — so both a raw path and a full URL render. The design phase must decide which shape the derived value takes, weighing warm-paint correctness against CEF answering an unbusted URL from cache. Note that host scan records already set `thumbnail` to a raw disk path and omit `thumbnailPath` entirely (`jsx/core.jsx:1951`), so raw-path `thumbnail` values already exist in production data. `thumbnailPath` MUST remain a raw path either way.

#### BUG 2

2.3 WHEN a UI mutation helper needs the folder path of an existing entry THEN the system SHALL resolve it from the entry's own stored `folderPath` — or from its hex-ID folder segment — rather than reconstructing it from the display name, for media entries.

2.4 WHEN `removeUITemplate` or `patchUITemplate` runs against a media card THEN the system SHALL apply the removal or patch to the library-index entry that actually backs that card, so the persisted index and `allTemplates` agree after the mutation and the change survives a panel reopen.

#### BUG 3

2.5 WHEN the panel derives an image save folder's category segment THEN the system SHALL apply the panel's `cleanName` before `getSafeName`, matching the host's `getSafeName(cleanStr(cat))` for every input, including categories containing tabs, CR/LF and runs of two or more spaces.

2.6 WHEN a PNG/image save completes for a category containing a tab or a run of spaces THEN the system SHALL derive the same folder path the host created, so the optimistic card points at the real folder and `refreshCardThumbnail` flips the placeholder to the on-disk `thumbnail.png` instead of addressing a nonexistent folder. Both diverging call sites — `js/templates/templates.js:3400` and `:3666` — SHALL be corrected.

#### BUG 4

2.7 WHEN this spec's requirements are traced THEN the system SHALL record BUG 4 as **not reproducing at the reported location**: `renderIconCardsMarkup` does not exist, and the analogous `renderIcons` is unreachable from production code. No behavioral fix is required to remove a user-visible symptom.

2.8 WHEN any icon-path card markup builder is retained in the source THEN the system SHALL either apply the same scheme-prefixing and URI-encoding handling `renderTemplateCardMarkup` applies, or SHALL be removed as dead code — the design phase decides which. A shared helper factored out for that purpose SHALL be ES5-safe, because `renderTemplateCardMarkup` is one of the two `js/templates/templates.js` regions scanned by `tests/media-cep-compatibility.test.js`.

#### BUG 5

2.9 WHEN `allTemplates` is mutated in a way `TemplateCatalog` has not absorbed THEN the system SHALL call `markTemplatesDirty()` so the next `ensureCatalogFresh` rebuilds, without relying on the array-identity, length, or first/last-element probes.

2.10 WHEN the wiring is complete THEN the system SHALL have `markTemplatesDirty()` invoked from every in-place card mutation, every thumbnail-ready event, and every patch call site; the exact set of call sites SHALL be enumerated in the design phase. Verified candidates to start from: `patchUITemplate`'s field-patch loop (`js/templates/templates.js:2201-2205`), `removeUITemplate`'s splice (`:2177`), `refreshCardThumbnail`'s field writes (`:2915-2917`), `markThumbnailForRegen`, and the media-completion `patchById` path.

#### BUG 6

2.11 WHEN this spec's requirements are traced THEN the system SHALL record BUG 6 as **not reproducing**: the host's bidirectional `overlay`/`element` expansion already covers the panel's seven-folder list, so `element/` assets are found by startup and background sweeps as they stand.

2.12 WHEN `element` is considered for addition to `STARTUP_SCAN_SECTIONS` or a comparable panel-side scan list THEN the system SHALL NOT add it, because the host expands an `overlay` filter to both folders and a second `element` chunk would duplicate every overlay and element record. If a future change removes the host-side expansion, the panel list becomes the correct place to fix it, and that dependency SHALL be recorded in the design.

### Unchanged Behavior (Regression Prevention)

#### BUG 1

3.1 WHEN a card's thumbnail is refreshed within a session THEN the system SHALL CONTINUE TO set `allTemplates[i].thumbnail` to the cache-busted `file:///…?v=<token>` URL and `allTemplates[i].thumbnailPath` to the raw forward-slashed disk path, and SHALL CONTINUE TO patch `TemplateCatalog` directly for that middle-of-array mutation.

3.2 WHEN `renderOptimisticCard` probes for an existing thumbnail THEN the system SHALL CONTINUE TO find a **raw disk path** in `thumbnailPath` that `existsSync` / `statSync` can resolve, never a `file:///` URL.

3.3 WHEN an entry already carries a valid `thumbnail` and its `thumbStatus` is not `"ready"` THEN the system SHALL CONTINUE TO render that existing value unchanged; the warm-paint derivation SHALL NOT overwrite a good in-session URL with a weaker one, and SHALL CONTINUE TO leave the placeholder in place for an entry that has no `thumbnailPath` at all.

#### BUG 2

3.4 WHEN `removeUITemplate` or `patchUITemplate` runs against a non-media template entry THEN the system SHALL CONTINUE TO resolve the same folder path it resolves today, so no existing comp, layer, text, footage, effect, icon or overlay template is re-keyed.

3.5 WHEN `patchUITemplate` applies a patch THEN the system SHALL CONTINUE TO match `allTemplates` by `name` + `category` + `section`, CONTINUE TO call `TemplateCatalog.patch(mutated, before)`, and CONTINUE TO choose between `filterAndRender` and the in-place `patchTemplateCard` path by the existing `recordChangedView` test.

#### BUG 3

3.6 WHEN a category name contains no tab, no CR/LF and no run of two or more spaces THEN the system SHALL CONTINUE TO produce a byte-identical folder path on both sides, so no existing library folder on disk is re-keyed or orphaned by this change. `cleanName` is idempotent and a no-op on such inputs.

3.7 WHEN the name segment of an image save folder is derived THEN the system SHALL CONTINUE TO use `generateTemplateId(name)` exactly as the host does, and the PNG save SHALL CONTINUE TO be a single monolithic `savePNGOnly` evalScript with the 5-argument form and its existing `"true"` / `"ERROR:"` return contract.

#### BUG 4

3.8 WHEN `renderTemplateCardMarkup` renders a thumbnail THEN the system SHALL CONTINUE TO pass an already-`file:///` value through verbatim, SHALL CONTINUE TO prefix and `encodeURI` a non-`file:///` value, and SHALL CONTINUE TO emit a stable `<img class="thumb-img">` patch target for a media card whose thumbnail is still pending.

3.9 WHEN the keyed media card path renders THEN the system SHALL CONTINUE TO reach neither `renderCards`, `renderIcons`, nor `filterAndRender`, as `tests/keyed-media-card-helper.test.js` and `tests/single-card-patch-job-completion.property.test.js` assert.

#### BUG 5

3.10 WHEN nothing about `allTemplates` has changed THEN the system SHALL CONTINUE TO skip the catalog rebuild — `markTemplatesDirty` SHALL be called only where a real mutation occurred, so `ensureCatalogFresh` does not become an unconditional rebuild on the hot render path.

3.11 WHEN a wholesale rewrite of `allTemplates` happens outside `js/templates/templates.js` THEN the system SHALL CONTINUE TO detect it through the existing array-identity, length, first/last-element and `TemplateCatalog.size()` probes; the revision counter is additive and SHALL NOT replace them.

#### BUG 6

3.12 WHEN a startup or background sweep scans a library root THEN the system SHALL CONTINUE TO issue one `getAllTemplates(root, section)` call per entry in `STARTUP_SCAN_SECTIONS`, in the active-section-first order, and SHALL CONTINUE TO flatten the results back into the fixed seven-folder order so a chunked scan stays record-for-record identical to the single all-sections call it replaces.

3.13 WHEN assets are stored under `element/` THEN the system SHALL CONTINUE TO surface them exactly once, under the canonical `overlay` section, with no duplicate records in `allTemplates` or in the persisted index.

#### Cross-cutting constraints

3.14 WHEN any file under `jsx/` is modified THEN the system SHALL CONTINUE TO be valid ExtendScript ES3 — `var` and function declarations only, no ES5+ syntax. No fix in this spec requires an ExtendScript change; the host is read for verification only.

3.15 WHEN any file under `js/` is modified THEN the system SHALL CONTINUE TO be ES5-safe for the older-Chromium CEP runtime: no arrow functions, no `let`/`const`, no template literals, no spread or rest, no `class`, no `async`/`await`, no optional chaining, no nullish coalescing.

3.16 WHEN `tests/media-cep-compatibility.test.js` scans its units THEN the system SHALL CONTINUE TO pass. Whole-file units: `js/core/fastMediaEngine.js`, `js/core/scheduler.js`, `js/core/persistence.js`, `js/core/observability.js`, `js/core/keyedMediaCardHelper.js`. Region units in `js/templates/templates.js`: the `escapeTemplateCardAttribute` and `renderTemplateCardMarkup` function bodies.

3.17 WHEN that test applies its Requirement 7.7 guard THEN the system SHALL CONTINUE TO contain no match for `/\.jsx\b/` in the **raw text** — comments and string literals included — of any scanned unit. Any comment added inside `js/core/persistence.js` or inside the two scanned `templates.js` regions to explain a fix in this spec MUST NOT name an ExtendScript filename; describe the host by role instead.

3.18 WHEN the comp-pipeline suites run THEN the system SHALL CONTINUE TO report 22/22 exploration tests and 47/47 preservation tests passing.

3.19 WHEN the full suite runs under `npx jest --runInBand` THEN the system SHALL CONTINUE TO leave the known pre-existing failures untouched and unfixed — `tests/token-stability`, `tests/shared-systems`, `tests/accent-theme`, `tests/header-contract`, `tests/templates-contract`, `tests/class-contract`, `tests/token-foundation`, `tests/responsive-grid`, `tests/performance/contract-baseline` — holding the baseline at 9 failed suites / 97 failed tests and 109 passed suites / 1304 passed tests. These are out of scope. No count SHALL regress in either direction beyond the tests this spec's fixes legitimately add.
