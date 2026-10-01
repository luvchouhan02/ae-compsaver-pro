# Media Card Lifecycle Edge Fixes — Bugfix Design

## Overview

Six follow-up edge cases in the media card lifecycle. Four require code, two do not.

| Bug | Verdict | Surface | Net change |
| --- | --- | --- | --- |
| BUG 1 | Fix | `js/templates/templates.js` — warm-paint read path | 2 new helpers, 3 call sites |
| BUG 2 | Fix | `js/templates/templates.js` — `_getTemplateFolderPath` | 1 new helper, 1 early return |
| BUG 3 | Fix | `js/templates/templates.js` — PNG folder derivation | 1 new helper, 2 call sites |
| BUG 4 | **Delete dead code** | `js/templates/templates.js` — `renderIcons` | −63 lines |
| BUG 5 | Fix | `js/templates/templates.js` — 7 mutation sites | 7 one-line calls |
| BUG 6 | **No change** | — | comment only |

No file other than `js/templates/templates.js` is modified. `js/core/persistence.js`, `js/core/pathBuilders.js` and everything under `jsx/` are read-only here. That is a deliberate outcome of the BUG 1 and BUG 5 decisions below, and it keeps the whole change set out of `tests/media-cep-compatibility.test.js`'s whole-file scan scope (clause 3.16).

The three design-phase decisions the requirements deferred are resolved in [Design Decisions](#design-decisions). In one word each: BUG 1 derives on **read** as a **cache-busted URL**; BUG 4 is **deleted**; BUG 5 lands on **7 call sites** with `refreshCardThumbnail` deliberately **excluded**.

Every line reference in this document was read against the working tree, not carried over from the requirements.

## Glossary

- **Bug_Condition (C)** — the input predicate that triggers a defect. Six disjoint sub-conditions, one per bug, in [Bug Details](#bug-details).
- **Property (P)** — the required behaviour once C holds. Enumerated in [Correctness Properties](#correctness-properties).
- **Preservation** — behaviour that must be byte-identical after the fix for every input where C does not hold.
- **Warm paint** — the reopen path that renders cards from the persisted library index with no disk and no host round trip. Two implementations exist: `startupWarmPaint` (`templates.js:1150`, the production reopen path, called from `main.js:375`) and the inline branch in `loadTemplates` (`templates.js:47-58`, taken on library-path change and manual refresh). **Both** assign `allTemplates = li._entries` and back-fill `section`. The requirements name only the second; the first is the one users hit on every reopen.
- **Entry-identity rule** — warm paint assigns the index's own entry array with no clone (`templates.js:1168-1171`), and `LibraryIndex.prototype.getEntry` returns the live entry (`persistence.js:487-490`). A record in `allTemplates`, the same record in `li._entries`, and the same record in the catalog are one object.
- **`thumbnailPath`** — the **raw** forward-slashed disk path. `renderOptimisticCard`'s `existsSync`/`statSync` probe consumes it. Never a URL (clause 3.2).
- **`thumbnail`** — the value `renderTemplateCardMarkup` renders. Accepts either shape: an already-`file:///` value passes through verbatim, anything else is `file:///`-prefixed and `encodeURI`-ed (`templates.js:805-810`).
- **Media folder shape** — `<root>/<section>/<mediaSafeName(category)>/<mediaIdFolderSegment(id)>`, written at `js/core/fastMediaEngine.js:1732` from the helpers at `:775` and `:780`. The last segment is `media-<hex>`, derived from the entry **id**, never from the display name.
- **Catalog mirror** — `TemplateCatalog` (`js/templates/templateCatalog.js`) indexes records it does not own. `byId` and `sectionIds` hold **references** (`:82`), so an in-place field write on a shared record is visible through them for free. `searchHay` (`hayFor`, `:51-54` — name, category, type, section, dim), `counts` and `sectionCats` are **derived snapshots** and go stale on an unmirrored write. This distinction drives the whole of BUG 5.
- **Shape probe** — the array-identity / length / first-element / last-element / `TemplateCatalog.size()` tests in `catalogSourceChanged` (`templates.js:678-690`). They catch mutations that change the array's observable shape. They cannot catch a middle-of-array field write.

## Bug Details

### Bug Condition

```
FUNCTION isBugCondition(input)
  INPUT:  input — one panel operation with its model/index state
  OUTPUT: boolean

  RETURN isBug1(input) OR isBug2(input) OR isBug3(input) OR isBug5(input)
END FUNCTION
```

BUG 4 and BUG 6 contribute no clause: neither reproduces (clauses 2.7, 2.11), so no input satisfies a condition for them. Their entries below record the disposition and the preservation obligation only.

#### BUG 1 — warm-paint cross-session blank card

```
FUNCTION isBug1(input)
  INPUT:  input.entry — a persisted library-index entry at warm paint
  OUTPUT: boolean

  RETURN isNonEmptyString(input.entry.thumbnailPath)
         AND (input.entry.thumbStatus === "ready" OR isFalsy(input.entry.thumbnail))
         AND renderTemplateCardMarkup(input.entry, ...) emits no <img src>
END FUNCTION
```

#### BUG 2 — media folder path reconstruction

```
FUNCTION isBug2(input)
  INPUT:  input.name, input.cat — arguments to a UI mutation helper
  OUTPUT: boolean

  entry := allTemplates record matching name + cat + currentSection
  RETURN entry IS NOT NULL
         AND isMediaIndexEntry(entry)
         AND _getTemplateFolderPath(name, cat) !== normalizeFolderPath(entry.folderPath)
END FUNCTION
```

#### BUG 3 — category sanitization parity

```
FUNCTION isBug3(input)
  INPUT:  input.cat — the category of an image/PNG save
  OUTPUT: boolean

  RETURN getSafeName(input.cat) !== getSafeName(hostFold(input.cat))
         // hostFold is the host's decode-time fold: strip CR/LF/TAB,
         // collapse whitespace runs to one space, trim.
         // Equivalently: cat contains a TAB, a CR/LF, a run of 2+ spaces,
         // or leading/trailing whitespace.
END FUNCTION
```

#### BUG 5 — unreachable staleness signal

```
FUNCTION isBug5(input)
  INPUT:  input — one mutation applied to allTemplates
  OUTPUT: boolean

  RETURN mutatesAllTemplates(input)
         AND NOT changesObservableArrayShape(input)   // identity, length, first, last
         AND NOT mirroredIntoCatalog(input)           // no TemplateCatalog.patch/remove
         AND touchesDerivedField(input)               // name, category, type, section, dim, favorite
END FUNCTION
```

The three negated conjuncts are what make this condition narrow, and they are what clause 3.10 is protecting. A mutation that fails any one of them is already detected, and marking it dirty buys a rebuild that changes no rendered byte.

### Examples

**BUG 1.** Save an image into `icon/Logos/Acme`. `renderOptimisticCard` inserts `{ …, thumbnailPath: "C:/lib/icon/Logos/Acme/thumbnail.png", thumbStatus: "placeholder" }` with no `thumbnail` (`:2994-3003`). The render lands, `refreshCardThumbnail` patches the entry with `{ thumbStatus: "ready", thumbnailPath: <raw> }` (`:2897`) — still no `thumbnail`. Reopen the panel: `startupWarmPaint` maps the entry to `allTemplates` unchanged, `renderTemplateCardMarkup` reads `t.thumbnail === undefined`, sets `thumbSrc = ""`, and emits the placeholder `<rect>` SVG for a card whose `thumbnail.png` is on disk. Expected: the same image the closed panel showed.

**BUG 2.** Import `clip.mp4` into `footage/Broll`. The writer creates `C:/lib/footage/Broll/media-636c69702e6d7034`. Delete the card: `_getTemplateFolderPath("clip", "Broll")` returns `C:/lib/footage/Broll/clip`; `li.removeEntry` finds no such folder and throws, `_mutate` rolls back, records `_lastError` and raises `_needsFullScan` (`persistence.js:396-408`, `:456-465`), and the persisted entry survives. `allTemplates` loses the record, so the card disappears — and comes back on the next reopen. Expected: the entry at `…/media-636c69702e6d7034` is removed.

**BUG 3.** Save a PNG into category `"My  Cat"` (two spaces). The host writes `icon/My Cat/<id>`; the panel derives `icon/My  Cat/<id>` and hands that to `renderOptimisticCard` and `refreshCardThumbnail`. The `existsSync` probe misses, the card stays a placeholder forever, and the index carries a folder that does not exist. Same for `"My\tCat"` → host `icon/MyCat`, panel `icon/My_Cat` (TAB is a C0 control, so `sanitizeNameStrict` maps it to `_`). Expected: both sides address one folder.

**BUG 3, edge case, no change.** Category `"My Cat"` — no tab, no CR/LF, no space run. `cleanName` is a no-op, so `getSafeName(cleanName(cat)) === getSafeName(cat)` byte-for-byte and no existing library folder is re-keyed (clause 3.6).

**BUG 5.** Reopen with a stale validity key. The background reconcile scan returns a record whose `category` changed on disk from `Logos` to `Brands`. `copyStartupRecordFields(record, existing)` writes it onto the existing record (`:1833`); `patchTemplateCard(existing)` repaints that one card. No add, no remove — array identity, length, first and last element all unchanged, `TemplateCatalog.size()` unchanged. `searchHay` still says `logos` and `counts.cats` still credits `Logos`, so the category panel shows a phantom `Logos (1)` and a search for `brands` misses the card, for the rest of the session. Expected: the next `ensureCatalogFresh` rebuilds.

**BUG 5, counterexample that must NOT mark dirty.** A thumbnail completes; `refreshCardThumbnail` writes three fields and calls `TemplateCatalog.patch` by hand (`:2922`). The catalog is exact. Marking dirty here would discard that patch and force a full rebuild once per completed thumbnail — O(N²) across an N-item import batch. Clause 3.10 forbids it and the comment at `:2918-2923` exists to prevent it.

## Expected Behavior

### Preservation Requirements

**Unchanged behaviours:**

- `refreshCardThumbnail` keeps writing the cache-busted `file:///…?v=<token>` URL to `thumbnail`, the raw forward-slashed path to `thumbnailPath`, and keeps calling `TemplateCatalog.patch` directly for its middle-of-array mutation (3.1).
- `renderOptimisticCard`'s probe keeps finding a raw disk path in `thumbnailPath` that `existsSync`/`statSync` resolves (3.2).
- An entry that already carries a `thumbnail` and whose `thumbStatus` is not `"ready"` keeps that value untouched; an entry with no `thumbnailPath` keeps the placeholder (3.3).
- Every non-media entry resolves to the byte-identical folder path it resolves to today (3.4).
- `patchUITemplate` keeps matching `allTemplates` by `name` + `category` + `section`, keeps calling `TemplateCatalog.patch(mutated, before)`, and keeps choosing between `filterAndRender` and `patchTemplateCard` by the existing `recordChangedView` test (3.5).
- A category with no tab, no CR/LF and no run of two or more spaces produces a byte-identical folder path on both sides (3.6).
- The name segment keeps using `generateTemplateId(name)`; the PNG save keeps its single monolithic 5-argument host call and its `"true"`/`"ERROR:"` return contract (3.7).
- `renderTemplateCardMarkup` keeps passing an already-`file:///` value through verbatim, keeps prefixing and `encodeURI`-ing anything else, and keeps emitting the stable `<img class="thumb-img">` patch target for a pending media card (3.8).
- The keyed media card path keeps reaching none of `renderCards`, `renderIcons`, `filterAndRender` (3.9).
- A render with no intervening mutation keeps skipping the catalog rebuild (3.10).
- A wholesale rewrite performed outside `templates.js` keeps being caught by the shape probes; the revision counter is additive and replaces nothing (3.11).
- One `getAllTemplates(root, section)` call per `STARTUP_SCAN_SECTIONS` entry, active-section first, flattened back into the fixed seven-folder order (3.12).
- `element/` assets surface exactly once, under the canonical `overlay` section (3.13).
- ES5-safe `js/**` (3.15); `tests/media-cep-compatibility.test.js` green including its raw-text `/\.jsx\b/` guard (3.16, 3.17); 22/22 exploration and 47/47 preservation in comp-pipeline (3.18); the baseline of 9 failed suites / 97 failed tests and 109 passed suites / 1304 passed tests holds, with new passes only from the tests this spec adds (3.19).

**Scope.** Inputs where `isBugCondition` is false are untouched:

- Non-media templates in every UI mutation helper.
- Categories that survive `cleanName` unchanged.
- Entries with no `thumbnailPath`, and entries carrying a good in-session `thumbnail` with `thumbStatus !== "ready"`.
- Mutations already absorbed by a hand-written `TemplateCatalog.patch`/`remove`, and mutations that change the array's observable shape.
- Cold-boot and background-rescan record flows: they receive fresh host records that already carry a renderable `thumbnail`, and are outside the warm-paint derivation.
- Mouse clicks, the keyed media card path, `VirtualGrid`, and everything under `jsx/`.

## Hypothesized Root Cause

Verified against source before this document; each item below was read, not inferred.

1. **Two write sites and two read sites, none of which bridge `thumbnailPath` to `thumbnail` (BUG 1).** `renderOptimisticCard`'s 8-field object literal (`:2994-3003`) has no `thumbnail` key, and `refreshCardThumbnail`'s `li.patchEntry` (`:2897`) deliberately withholds the URL it just computed. On the read side, `loadTemplates:53-58` and `startupWarmPaint:1171-1174` both back-fill only `section`. `LIBRARY_ENTRY_FIELDS` is **not** implicated — `normalizeLibraryEntry` copies every own defined field and `serialize` persists `_entries` whole, so any field present on an entry does round-trip.

2. **A name-derived reconstruction applied to an id-derived folder (BUG 2).** `_getTemplateFolderPath` (`:2162-2169`) composes `<normRoot>/<normSection>/<getSafeName(cat)>/<generateTemplateId(name)>`. For a media entry the fourth segment on disk is `media-<hex>` from `mediaIdFolderSegment(id)`. The two can never agree. The entry already carries the answer in its own `folderPath`; nothing reads it.

3. **A fold applied on one side of the bridge only (BUG 3).** The host folds the category at decode time and then sanitizes: `getSafeName(cleanStr(cat))`. The panel sanitizes the raw string. `getSafeName` performs no whitespace folding — it replaces reserved characters, maps C0 controls to `_`, and strips trailing dots and spaces (`pathBuilders.js:78-107`). The name segment is immune because `generateTemplateId` already folds `cleanName` in (`pathBuilders.js:123-125`). Only the category segment diverges, at exactly two call sites.

4. **A superseded renderer left in the file (BUG 4).** `renderCards`/`renderTemplateCardMarkup`/`VirtualGrid` took over `#icon-list-container`; `renderIcons` was never deleted. Confirmed: `renderIcons` is the only producer of `.icon-card` markup in the repo, and there are zero references to it in `js/**` or `index.html`.

5. **A signal that was designed, documented, and never wired (BUG 5).** `markTemplatesDirty` (`:661-664`) has exactly one occurrence repo-wide. `catalogSourceChanged`'s cheapest test can never fire, so freshness rests on shape probes. The gap those probes leave is not "any in-place write" — the catalog holds record **references** (`templateCatalog.js:82`), so a field write is visible through `byId` for free. The gap is a write to a **derived** field — one of `hayFor`'s five (`templateCatalog.js:51-54`), or `category`/`favorite`/`section`, which feed `counts` and `sectionCats` — with no hand-written mirror. Exactly one code path does that: `copyStartupRecordFields(record, existing)` in `startupReconcileScanned`'s processor (`:1833`), a `for…in` copy of every scanned field with no `TemplateCatalog.patch` after it.

6. **A bidirectional host alias the panel list already relies on (BUG 6).** The host expands an `overlay` filter to `["overlay", "element"]` and normalizes records scanned out of `element/` back to `overlay`. The panel's seven-folder list is therefore already complete. Adding `element` would issue two chunks that each return both folders.

## Design Decisions

### D1 — BUG 1: derived shape and derivation site (clause 2.2)

**Chosen: derive on READ, in both warm-paint branches, as a cache-busted `file:///…?v=<token>` URL, with no disk access.**

Why the URL and not the raw path. Both render — `renderTemplateCardMarkup` prefixes and `encodeURI`s a raw path — so the tiebreaker is cache correctness. An unbusted `file:///C:/lib/…/thumbnail.png` is byte-identical to the URL CEF cached in the previous session. Re-saving over the same folder (the host's image save finalizes in place) replaces `thumbnail.png` while the path stays fixed, so the unbusted URL is exactly the case where CEF serves the superseded image. The busting token costs one integer increment and closes it. `nextThumbCacheToken(normFolder)` already exists (`:2858`) and falls back to `Date.now()` when no mtime is supplied.

Why read and not write. Three reasons, in order of weight:

1. **A write-side fix cannot repair data already on disk.** Every entry persisted before this ships lacks `thumbnail`. Widening the `insertAtHead` literal fixes cards saved from now on; users still see a blank card for every card they already own until a full rescan happens to re-derive it. That is the symptom the bug reports. Read-side derivation fixes the existing corpus on the next reopen.
2. **Persisting a busting token is worse than deriving one.** A token written last session is stale by construction: it is the one CEF cached against. Deriving fresh on read yields a token that has never been requested.
3. **A write-side fix still needs the read-side guard, so it is pure duplication.** Host scan records set `thumbnail` to a raw disk path and omit `thumbnailPath` entirely, so the read path must be conditional in any case (clause 3.3 and the no-`thumbnailPath` case). Adding the write side buys a second place for the same conditional to drift.

Why no disk access. `tests/performance/startup-warm-paint.property.test.js:536` injects `nfs: function () { return { existsSync: function () { return false; } }; }` — only `existsSync`. A `statSync` for a real mtime would throw in that harness as well as violating its no-disk-before-first-paint property. The token is derived without touching the filesystem.

**Rejected alternatives.**
- *Raw path on read.* Loses cross-session cache busting for no saving; the derivation cost is identical.
- *Write side only (widen the `insertAtHead` literal at `:2994-3003` and the `patchEntry` at `:2897`).* Fails on existing data (reason 1) and persists a stale token (reason 2).
- *Both sides.* Strictly more code than read-only, with the write side contributing nothing the read side does not already cover, and it would additionally put a `thumbnail` write into the entry literal that clause 3.2's `existsSync` probe reads next to — an avoidable adjacency.

`thumbnailPath` is never written by this fix, so clause 3.2 holds by construction.

**Accepted consequence, recorded rather than worked around.** Under the entry-identity rule the derived value lands on the index's own entry object, so a later `saveLibraryIndex()` — `startupReconcileFinish` performs one — persists it. Clause 2.2 mandates writing the entry's field before `filterAndRender`, so this is not avoidable without cloning the entry array, which would break the documented identity rule that reconcile patching depends on. The behaviour that follows is exactly what clause 3.3 specifies:

- A `thumbStatus === "ready"` entry is **re-derived** every warm paint, so a persisted token is always replaced by a fresh one. No staleness.
- A `thumbStatus !== "ready"` entry that carries a previously derived `thumbnail` keeps it untouched, which is what 3.3 requires. That entry's thumbnail file did not exist when its card was created and never reached `ready`, so the URL points at a file that most likely still does not exist and the image fails to load — the same placeholder the user sees today. The fix is never worse than the current behaviour for that class.

### D2 — BUG 4: align or delete (clause 2.8)

**Chosen: delete `renderIcons` (`templates.js:722-784`).**

What the three test files actually assert about it, checked before deciding:

| File | Reference | Assertion |
| --- | --- | --- |
| `tests/keyed-media-card-helper.test.js:161` | `templates.context.renderIcons = function () { rendererCalls.push("renderIcons"); }` | `expect(panel.rendererCalls).toEqual([])` at `:255`, `:339`, `:362`, `:406`, `:439`, `:469` — the stub must never be called |
| `tests/single-card-patch-job-completion.property.test.js:247` | same shape | `expect(panel.rendererCalls).toEqual([])` at `:351` |
| `tests/performance/contract-baseline.test.js:613` | `context.renderIcons = context.renderCards` | wiring only; nothing asserts the identity |

All three **assign over** the definition after `templates.js` has been evaluated in the vm context. None reads the original function, and none asserts it exists. Deleting the declaration leaves every assertion intact and still meaningful: the stub is still a context global, it is still never called, and clause 3.9 still holds. **No test breaks, so nothing forces alignment.**

Given that, delete beats align:

- Aligning means a second copy of the scheme-prefix-and-encode rule — the exact class of duplication BUG 3 exists to remove — in code with zero callers.
- Factoring a shared helper instead means `renderTemplateCardMarkup` calls it, which puts the helper inside a `tests/media-cep-compatibility.test.js` region-scanned unit (`REGION_SCOPE`, `:58-61`). Adding scanned surface to serve dead code is a bad trade, and the shared-helper option was the only reason clause 2.8 raised the CEP-scan caveat at all.
- Inlining the guard into `renderIcons` is the smaller of the two align options, but it still leaves 63 lines of unreachable markup builder in the file and pins the asymmetry behind a test nobody exercises.

Deletion consequences, all verified:

- `forceIconGrid` survives: it lives in `js/ui/header.js:56` and keeps two other references (`js/main.js:861` as a call, `js/ui/header.js:296` as a `requestAnimationFrame` argument). `tests/performance/contract-baseline.test.js:605` injects its own stub.
- `#icon-list-container` keeps being populated — by `renderCards` via `resolveSectionGridId`, which is why `renderIcons` went dead in the first place.
- `renderIcons` is the only producer of `.icon-card` markup in `js/**`, so the `.icon-card` selectors in `refreshCardThumbnail:2928`, `markCardFailed:3077` and `js/main.js:388,390` become unreachable for template cards. **They are left alone**: `js/textanim/textanim.js:1260` queries `.icon-card` too, the CSS class stays, and pruning them is scope creep with a live-code blast radius.
- `tests/media-cep-compatibility.test.js:343` requires each scanned source to exceed 4000 characters and `:44` anchors `templates.js` on `renderTemplateCardMarkup` and `escapeTemplateCardAttribute`. Removing 63 lines from a ~3700-line file touches none of that, and `extractRegion` locates its regions by marker text, so the two scanned regions extract identical text at a shifted start line.

### D3 — BUG 5: the final call-site set (clause 2.10)

The decision rule, derived from clause 3.10 and from how `TemplateCatalog` stores records:

> Call `markTemplatesDirty()` at a mutation of `allTemplates` when the mutation is **not fully absorbed** by a hand-written catalog mirror, **or** when the mutation already forces a rebuild through a shape probe (so the call is free). Do **not** call it where a complete hand mirror exists on a hot path.

The rule keys on *presence of a hand mirror*, not on *which fields are derived today*. That is deliberate: a site with a hand mirror stays correct if `hayFor` grows a field, and a site without one does not. Deriving the answer from `hayFor`'s current five fields would make correctness depend on a coincidence.

The "or" clause matters because `TemplateCatalog.patch` (`templateCatalog.js:170`) and `remove` (`:206`) do **not** re-stamp `sourceRevision` — only `build` (via `:123`) and `stampSource` (`:130`) do. So `markTemplatesDirty()` at a site whose mirror is already complete and whose shape is unchanged converts an O(1) incremental patch into an O(N) rebuild. Where the shape changed, the rebuild was going to happen anyway and the call is genuinely free.

**Included — 7 sites.**

| # | Function | Anchor | Shape change? | Existing mirror | `markTemplatesDirty` is… | Why |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `startupReconcileScanned` processor | after `copyStartupRecordFields(record, existing)` (`:1833`) | none | **none** | the entire mechanism | The one path that writes derived fields with no mirror and no shape change. This is the defect. |
| S2 | `startupReconcileScanned` processor | after `allTemplates.push(record)` (`:1838`) | length | none | additive, free | Length probe already fires; makes the invariant unconditional. |
| S3 | `startupReconcileFinish` | after `allTemplates.splice(i, 1)` (`:1897`) | length | none | additive, free | Same. Also closes the add-1-remove-1 case where length returns to its original value. |
| S4 | `removeUITemplate` | after `TemplateCatalog.remove(removed)` (`:2178`) | length | `TemplateCatalog.remove` | additive, free | Length probe already fires — and does so once per iteration of the bulk-delete loop at `:2461-2465` today, so this adds no rebuild that does not already happen. |
| S5 | `patchUITemplate` | after `TemplateCatalog.patch(mutated, before)` (`:2208`), before the `break` at `:2209` | none | `TemplateCatalog.patch` — **incomplete** | additive, **not** free | See note below. |
| S6 | `markCardFailed` | after `allTemplates[a].thumbStatus = "failed"` (`:3070`) | none | **none** | additive, **not** free | See note below. |
| S7 | `renderOptimisticCard` | after `TemplateCatalog.patch(tpl)` (`:3036`) | length + first element | `TemplateCatalog.patch` | additive, free | Both probes already fire. |

**S5, why the manual patch is not sufficient there.** `confirmRename` calls `patchUITemplate(oldName, cat, { name: newName, id: newId }, newName, undefined)` (`:2703`) — it patches **`id`**. `TemplateCatalog.patch` keys on `recordId(t)` and takes its `addToLists` branch when `byId[id] === undefined` (`:172-176`), so with a new id the record is appended to `sectionIds` a **second time** while `byId[oldId]` still points at the same object; the following `rebuildSectionCategories` then counts it twice. Marking dirty forces a rebuild that produces a correct catalog. Clause 3.5 requires the `TemplateCatalog.patch(mutated, before)` call to remain, so this is strictly additive. Cost: one O(N) rebuild per user-initiated favourite toggle (`:2269`), rename (`:2703`) or move (`:2759`) — all three are single user actions, none in a loop. **Out-of-scope observation, recorded not fixed:** the id-change duplication in `TemplateCatalog.patch` is a seventh defect. This design does not repair `patch`; the rebuild means the stale catalog is no longer observable, which is a side effect of wiring the signal, not a fix for `patch`. It should get its own spec.

**S6, why it is included when the near-identical `refreshCardThumbnail` is not.** Both write only thumb-status fields, and neither field is derived today, so neither is stale in the current code. The difference is the rule above: `refreshCardThumbnail` hand-patches the catalog and is therefore correct under any future `hayFor`; `markCardFailed` mirrors nothing and would silently break. The cost difference settles it — `markCardFailed`'s only caller is the render queue's exhausted-retry handler (`js/textanim/textanim.js:1234`), so it fires on terminal failure, while `refreshCardThumbnail` fires on every success. One rebuild per exhausted-retry failure is acceptable; one per completed thumbnail is the O(N²) batch regression clause 3.10 exists to prevent.

**Excluded — 3 candidates, with reasons.**

| Candidate | Verdict | Reason |
| --- | --- | --- |
| `refreshCardThumbnail` field writes (`:2915-2917`) | **DROP** | The hand `TemplateCatalog.patch(allTemplates[a])` at `:2922` is complete: records are shared references so the three field writes are visible through `byId` immediately, and none of `thumbnail`, `thumbnailPath`, `thumbStatus` participates in `hayFor` (`templateCatalog.js:51-54`) or `counts`. Marking dirty would discard that patch and force one O(N) rebuild per completed thumbnail — O(N²) across an N-item import batch, on the media hot path. Precisely what clause 3.10 forbids and what the comment at `:2918-2923` exists to prevent. Clause 3.1 additionally requires the direct patch to remain. Clause 2.10's phrase "every thumbnail-ready event" is read as already satisfied here by that mirror; clause 2.10 delegates the exact set to this phase, and P6 below makes the exclusion executable rather than merely documented. |
| `markThumbnailForRegen` (`:3164`) | **DROP** | It writes a `.needsthumb` marker file. It does not touch `allTemplates` at all. Clause 3.10 permits the call only where a real mutation occurred. |
| media-completion `patchById` path | **DROP** | Every `patchById` call is `MediaEntryRepository.patchById` (`persistence.js:1158`) or the card repository's, reached from `js/core/fastMediaEngine.js:1323,1340,1356,1442,1449,1852,2770,2774`. The mutation of the shared model is `_publishDurable` (`persistence.js:981-1000`), which does `mirror.length = 0` and re-pushes fresh **clones**. The array identity survives but every element identity changes, so the first/last-element probes fire and `catalogSourceChanged` returns true without any counter. Clause 3.11 names those probes as the mechanism for exactly this case and requires them to keep working. Excluding it also keeps `js/core/persistence.js` — a whole-file CEP-scanned unit under 3.16/3.17 — unmodified. |

**Not touched:** `loadTemplates:53`, `:111`, `:190` and `startupWarmPaint:1171` reassign `allTemplates` wholesale (array identity changes → probe fires) and their `section` back-fill runs before the catalog is built for that array. `mergeSurvivingMediaEntries` (`:1677-1700`) returns a new array, likewise assigned. No calls added.

### D4 — BUG 2: where the real `folderPath` comes from

**Chosen: resolve inside `_getTemplateFolderPath`; leave its signature and both callers untouched.** This is a third option, taken over both the ones the requirements offered.

Both callers pass exactly `(name, cat)` and then scan `allTemplates` for `name` + `category` + `section === currentSection` (`:2176`, `:2195`). Changing the signature to accept an entry, or resolving in the callers and bypassing the helper for media, would force each caller to run that scan **before** calling — duplicating it and editing three places instead of one. Resolving internally also means BUG 2's edit and BUG 5's S4/S5 edits fall in **disjoint line ranges** inside `removeUITemplate`/`patchUITemplate` — see [Conflicts and Ordering](#conflicts-and-ordering).

The early return is gated on `isMediaIndexEntry(entry) && entry.folderPath`, so the non-media branch is not merely preserved, it is **not reached**. That is how clause 3.4 is satisfied: byte-identical by virtue of being the same unmodified expression.

`normalizeFolderPath` (`persistence.js:34-36`) is the same normalizer `removeEntry`, `patchEntry`, `has` and `getEntry` apply to their key (`:456`, `:428`, `:484`, `:487`), so the string this returns matches the index key exactly. `patchEntry` additionally pins `merged.folderPath = key` (`:449`), so a patch can never move an entry.

### D5 — BUG 3: how `cleanName` is reached

`cleanName` is a **bare panel global**. `index.html` loads `js/core/pathBuilders.js` before `js/core/utils.js` — asserted by `tests/panel-script-manifest.test.js:68-84` — and that module declares `function cleanName(s)` at `pathBuilders.js:52` alongside `getSafeName` and `generateTemplateId`, which `templates.js` already calls bare. **No new require and no new global access is needed in production.**

The vm harnesses are the constraint. `tests/save-return-shape.test.js:190-191` and `tests/comp-pipeline-integration.test.js:926-927` inject `getSafeName` and `generateTemplateId` but **not** `cleanName`, and `loadHelpers` evaluates `templates.js` with `vm.runInContext` against a context built only from the injected object (`tests/helpers/loadHelpers.js`, `createSandbox`), so a bare reference to an undeclared identifier throws `ReferenceError`. The new helper therefore guards with `typeof cleanName === "function"`, matching the style already used at `templates.js:2164-2166`. `typeof` on an undeclared identifier does not throw, so those suites keep running; with `"TestCat"` as their only category the guarded fallback is byte-identical and no existing assertion moves. The new test injects the real `cleanName`, so the fix is proved rather than silently bypassed.

### D6 — BUG 6: no change, and the dependency that would change it

`STARTUP_SCAN_SECTIONS` (`:226`) stays the seven-folder list `["comp","layer","text","footage","effect","icon","overlay"]`, in that order. `SECTION_SCAN_FOLDERS.element` stays mapped to `"overlay"` (`:28`). No code change.

**Recorded dependency.** The panel's list is complete *only because* the host expands an `overlay`-filtered `getAllTemplates` to `["overlay", "element"]` and normalizes records scanned out of the alias folder back to the canonical `overlay` section. If a future change removes that expansion, `element/` assets stop being scanned and **the panel list becomes the correct place to fix it** — by adding `element` to `STARTUP_SCAN_SECTIONS` and flattening it into the fixed order. Until then, adding it makes the panel issue two chunks that each return both folders, duplicating every overlay and element record in the flattened result and in the persisted index (clauses 2.12, 3.13).

This is recorded as an extension to the existing comment above `STARTUP_SCAN_SECTIONS` (`:222-226`), which is outside both CEP-scanned regions and already names the host file, so clause 3.17 does not apply there.

## Correctness Properties

Property 1: Bug Condition — Warm paint renders a persisted thumbnail

_For any_ persisted library-index entry where the bug condition holds — a non-empty `thumbnailPath` and either `thumbStatus === "ready"` or a falsy `thumbnail` — the fixed warm-paint path SHALL set that entry's `thumbnail` to a `file:///`-schemed, `encodeURI`-ed, `?v=`-busted URL for `thumbnailPath` before `filterAndRender` runs, so `renderTemplateCardMarkup` emits an `<img class="thumb-img" src="…">` rather than placeholder artwork, and SHALL do so without any filesystem call.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation — Warm paint leaves every other entry untouched

_For any_ entry where the bug condition does not hold, the fixed warm-paint path SHALL leave `thumbnail` byte-identical to its pre-fix value — an entry with a `thumbnail` and `thumbStatus !== "ready"` keeps it, an entry with no `thumbnailPath` keeps the placeholder — and SHALL never write `thumbnailPath`, which remains a raw forward-slashed disk path with no `file:` scheme and no `?v=` query for `existsSync`/`statSync`. `refreshCardThumbnail` SHALL continue to produce a byte-identical URL and to patch `TemplateCatalog` directly.

**Validates: Requirements 3.1, 3.2, 3.3**

Property 3: Bug Condition — UI mutation helpers address a media entry's real folder

_For any_ media entry where the bug condition holds — the reconstructed path differs from the entry's stored `folderPath` — `removeUITemplate` SHALL remove, and `patchUITemplate` SHALL patch, the library-index entry that actually backs the card, leaving `li.needsFullScan()` false and the persisted index in agreement with `allTemplates`.

**Validates: Requirements 2.3, 2.4**

Property 4: Preservation — Non-media path resolution is byte-identical

_For any_ non-media entry, `_getTemplateFolderPath(name, cat)` SHALL return a string byte-identical to the pre-fix reconstruction `normalizeFolderPath(getTemplateSourcePath(name,cat)) + "/" + normalizeSectionName(currentSection) + "/" + getSafeName(cat) + "/" + generateTemplateId(name)`, and `patchUITemplate` SHALL continue to match by `name` + `category` + `section`, to call `TemplateCatalog.patch(mutated, before)`, and to choose its render path by the existing `recordChangedView` test.

**Validates: Requirements 3.4, 3.5**

Property 5: Bug Condition — Category segment parity with the host

_For any_ category string, the panel's derived category segment SHALL equal the host's `getSafeName(cleanStr(cat))` for every input, including categories containing tabs, CR/LF, runs of two or more spaces and leading/trailing whitespace, at **both** derivation sites (`templates.js:3400` and `:3666`), so the optimistic card and `refreshCardThumbnail` address the folder the host created.

**Validates: Requirements 2.5, 2.6**

Property 6: Preservation — Clean categories and the save contract are unmoved

_For any_ category containing no tab, no CR/LF and no run of two or more spaces, the derived segment SHALL be byte-identical to `getSafeName(cat)`, so no existing library folder is re-keyed or orphaned; the name segment SHALL continue to be `generateTemplateId(name)`; and the PNG save SHALL continue to issue one monolithic 5-argument host call with its existing `"true"`/`"ERROR:"` return contract.

**Validates: Requirements 3.6, 3.7**

Property 7: Preservation — No icon-path markup builder retains the asymmetry

_For any_ card rendered by the panel, no markup builder in `js/**` SHALL emit an `<img src>` from a `thumbnail` value without the scheme-prefix-and-`encodeURI` handling: `renderIcons` is removed, and `renderTemplateCardMarkup` SHALL continue to pass an already-`file:///` value through verbatim, to prefix and `encodeURI` anything else, and to emit the stable `<img class="thumb-img">` patch target for a pending media card. The keyed media path SHALL continue to reach none of `renderCards`, `renderIcons`, `filterAndRender`.

**Validates: Requirements 2.7, 2.8, 3.8, 3.9**

Property 8: Bug Condition — Unmirrored in-place mutations are detected

_For any_ mutation of `allTemplates` where the bug condition holds — a write to a catalog-derived field that changes no observable array shape and is mirrored into no `TemplateCatalog.patch`/`remove` call — `catalogSourceChanged()` SHALL return true afterwards and the next `ensureCatalogFresh()` SHALL rebuild, without relying on the array-identity, length or first/last-element probes.

**Validates: Requirements 2.9, 2.10**

Property 9: Preservation — Freshness stays conditional and the probes stay live

_For any_ sequence of renders with no intervening mutation, `TemplateCatalog.build` SHALL be invoked at most once, so `ensureCatalogFresh` does not become an unconditional rebuild on the hot render path; `refreshCardThumbnail` SHALL NOT advance the revision counter; and a wholesale rewrite of `allTemplates` performed outside `templates.js` — a constant-length clone replacement — SHALL still be detected by the array-identity, length, first/last-element and `TemplateCatalog.size()` probes with no counter involvement.

**Validates: Requirements 3.10, 3.11**

Property 10: Preservation — The startup scan section list is unchanged

_For any_ startup or background sweep, the panel SHALL issue one `getAllTemplates(root, section)` call per entry of the seven-folder `STARTUP_SCAN_SECTIONS`, active-section first, flattened back into the fixed order; `element` SHALL NOT appear in that list; `SECTION_SCAN_FOLDERS.element` SHALL remain `"overlay"`; and assets stored under `element/` SHALL surface exactly once under the canonical `overlay` section with no duplicate records.

**Validates: Requirements 2.11, 2.12, 3.12, 3.13**

Property 11: Preservation — Runtime and scan constraints hold

_For any_ file modified by this spec, the source SHALL remain ES5-safe for the older-Chromium CEP runtime — no arrow functions, `let`/`const`, template literals, spread/rest, `class`, `async`/`await`, optional chaining or nullish coalescing — `tests/media-cep-compatibility.test.js` SHALL continue to pass including its raw-text `/\.jsx\b/` guard over the `escapeTemplateCardAttribute` and `renderTemplateCardMarkup` bodies, no file under `jsx/` SHALL be modified, comp-pipeline SHALL continue to report 22/22 exploration and 47/47 preservation, and the full-suite baseline of 9 failed suites / 97 failed tests and 109 passed suites / 1304 passed tests SHALL hold with new passes only from the tests this spec adds.

**Validates: Requirements 3.14, 3.15, 3.16, 3.17, 3.18, 3.19**

## Fix Implementation

All edits are in `js/templates/templates.js`. Every new function is a top-level `function` declaration outside both CEP-scanned regions. Line numbers are pre-BUG-4 (see [Conflicts and Ordering](#conflicts-and-ordering)).

### BUG 1 — warm-paint thumbnail derivation

**New helper A — the single URL rule.** Insert immediately above `refreshCardThumbnail` (after `nextThumbCacheToken`, which ends at `:2864`).

```js
// The one cache-busted display URL rule. `raw` is a forward-slashable disk
// path; `token` comes from nextThumbCacheToken. Kept in one place so the
// in-session refresh and the warm-paint derivation cannot drift apart.
function buildBustedThumbUrl(raw, token) {
    var fwd = ("" + (raw || "")).replace(/\\/g, "/");
    if (fwd === "") return "";
    if (fwd.charAt(0) === "/") fwd = fwd.substring(1);
    return "file:///" + encodeURI(fwd) + "?v=" + token;
}
```

**Edit inside `refreshCardThumbnail`.** Replace the three-line construction at `:2888-2890`:

```js
// before
var fwd = ("" + thumbPath).replace(/\\/g, "/");
if (fwd.charAt(0) === "/") fwd = fwd.substring(1);
var url = "file:///" + encodeURI(fwd) + "?v=" + version;

// after
var url = buildBustedThumbUrl(thumbPath, version);
```

Output is byte-identical for every non-empty `thumbPath`, so clause 3.1 is preserved. Nothing else in the function changes: the `li.patchEntry` at `:2897`, the three field writes at `:2915-2917`, the `TemplateCatalog.patch` at `:2922` and the DOM patch all stay.

**New helper B — the read-side derivation.** Insert immediately above `startupWarmPaint`'s comment block (`:1148`).

```js
// Warm paint reads entries persisted by an earlier session. renderOptimisticCard
// and refreshCardThumbnail record thumbnailPath (raw disk path) but never
// thumbnail (the value the renderer reads), so a reopened panel rendered a
// blank placeholder for a card whose thumbnail.png is on disk. Derive the
// renderable value here instead of persisting one: this also repairs entries
// already written by earlier sessions, and it issues a FRESH busting token —
// a persisted token is stale by construction, because it is the one the
// embedded browser already cached against.
//
// No filesystem call: the token falls back to a clock read when no mtime is
// supplied, and warm paint must complete before any disk work.
//
// Returns true when the entry was hydrated. Leaves alone:
//   - an entry with no thumbnailPath            -> placeholder stands
//   - an entry with a thumbnail and a thumbStatus
//     other than "ready"                        -> in-session value stands
function hydrateWarmPaintThumbnail(entry) {
    if (!entry || typeof entry !== "object") return false;
    var raw = entry.thumbnailPath;
    if (typeof raw !== "string" || raw === "") return false;
    var hasThumb = typeof entry.thumbnail === "string" && entry.thumbnail !== "";
    if (hasThumb && entry.thumbStatus !== "ready") return false;
    var norm = ("" + (entry.folderPath || "")).replace(/\\/g, "/");
    var url = buildBustedThumbUrl(raw, nextThumbCacheToken(norm));
    if (url === "") return false;
    entry.thumbnail = url;
    return true;
}
```

**Call site 1 —** `startupWarmPaint`, the production reopen path (`:1171-1174`):

```js
allTemplates = entries;
for (var i = 0; i < allTemplates.length; i++) {
    allTemplates[i].section = getTemplateSection(allTemplates[i]);
    hydrateWarmPaintThumbnail(allTemplates[i]);          // added
}
```

**Call site 2 —** `loadTemplates`'s warm branch (`:53-57`):

```js
for (var k = 0; k < allTemplates.length; k++) {
    if (!allTemplates[k].section) {
        allTemplates[k].section = getTemplateSection(allTemplates[k]);
    }
    hydrateWarmPaintThumbnail(allTemplates[k]);           // added
}
```

Both loops run **before** `filterAndRender` / `renderCardsFirstBatch`, satisfying clause 2.2's ordering requirement. The cold-boot and background-rescan flows are **not** touched: their records come from the host already carrying a renderable `thumbnail`.

No change to `renderOptimisticCard`'s `insertAtHead` literal (`:2994-3003`), to `refreshCardThumbnail`'s `li.patchEntry` (`:2897`), or to `js/core/persistence.js`. Per D1.

### BUG 2 — real `folderPath` for media entries

**New helper.** Insert immediately above `_getTemplateFolderPath` (after the section comment at `:2161`).

```js
// The record a UI mutation helper is about to act on, matched by exactly the
// rule removeUITemplate/patchUITemplate use so the path resolved here and the
// record mutated there are always the same card.
function _findUITemplateRecord(name, cat) {
    for (var i = 0; i < allTemplates.length; i++) {
        var rec = allTemplates[i];
        if (rec && rec.name === name && rec.category === cat && rec.section === currentSection) return rec;
    }
    return null;
}
```

**Edit `_getTemplateFolderPath`** (`:2162-2169`) — one early return, existing body untouched:

```js
function _getTemplateFolderPath(name, cat) {
    // A media entry's last folder segment is a hex id ("media-<hex>") the media
    // writer derived from the entry ID, never from the display name, so the
    // name-based reconstruction below can never reproduce it and the index
    // mutation silently missed. The entry already stores the answer.
    var rec = _findUITemplateRecord(name, cat);
    var isMedia = rec && ((typeof isMediaIndexEntry === "function") ? isMediaIndexEntry(rec) : rec.type === "media");
    if (isMedia) {
        var own = typeof normalizeFolderPath === "function"
            ? normalizeFolderPath(rec.folderPath)
            : ("" + (rec.folderPath || "")).replace(/\\/g, "/").replace(/\/+$/, "");
        if (own !== "") return own;
    }

    // ── unchanged below this line ──
    var sourcePath = getTemplateSourcePath(name, cat);
    var safeCat = typeof getSafeName === "function" ? getSafeName(cat) : cat;
    var safeName = typeof generateTemplateId === "function" ? generateTemplateId(name) : name;
    var normRoot = typeof normalizeFolderPath === "function" ? normalizeFolderPath(sourcePath) : sourcePath;
    var normSection = typeof normalizeSectionName === "function" ? normalizeSectionName(currentSection) : currentSection;
    return normRoot + "/" + normSection + "/" + safeCat + "/" + safeName;
}
```

`removeUITemplate` (`:2171`) and `patchUITemplate` (`:2185`) are **not edited** for BUG 2. Non-media entries never enter the new branch, so their path is the same unmodified expression — clause 3.4 by construction.

### BUG 3 — category segment parity

**New helper.** Insert next to the other pure save-path helpers, at any top-level position before `:3400`; the declaration is hoisted regardless.

```js
// The category segment of an image save folder. The host folds the category at
// decode time and sanitizes the result; the panel sanitized the raw string, so
// any category with a TAB, a CR/LF or a run of two or more spaces produced a
// folder the host had not created — an unfindable folder and a permanently
// blank card. cleanName is the panel twin of that fold and is idempotent, so
// this is a no-op for every already-clean category and re-keys nothing on disk.
// Guarded: a realm that did not load the path-builder module degrades to the
// previous behaviour instead of throwing.
function safeCategorySegment(cat) {
    var folded = (typeof cleanName === "function") ? cleanName(cat) : cat;
    return (typeof getSafeName === "function") ? getSafeName(folded) : folded;
}
```

**Edit 1 —** `scheduleBackground`, PNG branch (`:3400`):

```js
// before
var pngFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + pngSec + "/" + getSafeName(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
// after
var pngFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + pngSec + "/" + safeCategorySegment(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
```

**Edit 2 —** `onEssentialSuccess`, PNG branch (`:3666`):

```js
// before
optFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + optSec + "/" + getSafeName(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
// after
optFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + optSec + "/" + safeCategorySegment(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
```

Only the category segment changes. The name segment stays `generateTemplateId(name)`, and neither the host call shape nor its return contract is touched — clause 3.7.

**Test-harness addition (not an assertion change).** Add `cleanName: pathBuilders.cleanName` to the injected globals in `tests/save-return-shape.test.js` (~`:190`) and `tests/comp-pipeline-integration.test.js` (~`:926`), both of which already `require("../js/core/pathBuilders")`. Both suites use the category `"TestCat"`, for which `cleanName` is the identity, so every existing assertion — including the exact folder strings at `save-return-shape.test.js:571-572`, `:582-583`, `:609-610` — is unchanged. Detailed in [Tests That Pin Current Behaviour](#tests-that-pin-current-behaviour-and-need-attention).

### BUG 4 — delete `renderIcons`

Delete `js/templates/templates.js:722-784` in full — the `function renderIcons(icons) { … }` declaration, from its signature at `:722` through its closing `}` at `:784` — and the blank separator at `:785`. 63 lines of code, 64 with the separator. Nothing replaces it. No import, no export, no call site to update.

`forceIconGrid` keeps its other two references. The `.icon-card` selectors in `refreshCardThumbnail`, `markCardFailed` and `js/main.js` are **left as-is** per D2.

### BUG 5 — wire `markTemplatesDirty`

`markTemplatesDirty` (`:661-664`) itself is **not** modified. Seven one-line calls, per D3.

```js
// S1 + S2 — startupReconcileScanned's processor (:1832-1839)
        if (existing) {
            copyStartupRecordFields(record, existing);
            markTemplatesDirty();          // added — derived-field write, no catalog mirror
            patchTemplateCard(existing);
            return;
        }
        if (typeof getTemplateSection === "function") record.section = getTemplateSection(record);
        allTemplates.push(record);
        markTemplatesDirty();              // added
        counters.added++;

// S3 — startupReconcileFinish's removal pass (:1897-1899)
            allTemplates.splice(i, 1);
            markTemplatesDirty();          // added
            removeTemplateCardNode(entry);
            counters.removed++;

// S4 — removeUITemplate (:2177-2179)
            var removed = allTemplates.splice(i, 1)[0];
            if (removed && typeof TemplateCatalog !== "undefined") TemplateCatalog.remove(removed);
            markTemplatesDirty();          // added — additive to the remove above
            break;

// S5 — patchUITemplate (:2208-2209)
            if (typeof TemplateCatalog !== "undefined") TemplateCatalog.patch(mutated, before);
            markTemplatesDirty();          // added — the manual patch misses an id change
            break;

// S6 — markCardFailed (:3070-3071)
                allTemplates[a].thumbStatus = "failed";
                markTemplatesDirty();      // added — no catalog mirror here at all
                break;

// S7 — renderOptimisticCard (:3035-3036)
        allTemplates.unshift(tpl);
        if (typeof TemplateCatalog !== "undefined") TemplateCatalog.patch(tpl);
        markTemplatesDirty();              // added
```

Each site gets a one-line comment naming why. **No call is added to `refreshCardThumbnail`, to `markThumbnailForRegen`, or anywhere in `js/core/persistence.js`.**

### BUG 6 — no change

No executable change. Extend the existing comment above `STARTUP_SCAN_SECTIONS` (`:222-226`) with the recorded dependency from D6: the seven-folder list is complete only because the host expands an `overlay` filter to both folders; adding `element` would duplicate every overlay and element record; if that host-side expansion is ever removed, this list is the correct place to fix it. That comment sits outside both CEP-scanned regions, so it may keep naming the host file as it does today.

## Testing Strategy

### Validation Approach

Two phases. First, surface counterexamples on the **unfixed** code so each root-cause hypothesis is confirmed or refuted — a refutation sends BUG 1, 2, 3 or 5 back to re-hypothesis. Then verify the fix holds for every input satisfying the bug condition, and that behaviour is unchanged for every input that does not.

Two new files, so the comp-pipeline counts required by clause 3.18 (22/22 exploration, 47/47 preservation) are untouched — neither file is added to a comp-pipeline suite:

- `tests/media-card-lifecycle-exploration.test.js`
- `tests/media-card-lifecycle-preservation.property.test.js`

Both load `js/templates/templates.js` through `tests/helpers/loadHelpers.js` with `lenient: false`, following the harness pattern of `tests/performance/startup-warm-paint.property.test.js`. The host side of the BUG 3 parity property is the sliced host realm from `tests/helpers/compPipelineHarness.js`, whose `CORE_PURE_NAMES` (`:94-99`) already exposes `cleanStr` and `getSafeName` — the same mechanism `tests/sanitizer-cross-implementation.property.test.js` uses.

Verification command (both new files plus every suite these fixes touch):

```
npx jest tests/media-card-lifecycle-exploration.test.js tests/media-card-lifecycle-preservation.property.test.js tests/save-return-shape.test.js tests/comp-pipeline-integration.test.js tests/keyed-media-card-helper.test.js tests/single-card-patch-job-completion.property.test.js tests/media-cep-compatibility.test.js tests/performance/startup-warm-paint.property.test.js tests/performance/startup-reconcile.property.test.js tests/performance/startup-lifecycle.property.test.js tests/template-catalog.test.js tests/sanitizer-cross-implementation.property.test.js --runInBand
```

Then the full baseline check: `npx jest --runInBand`, expecting 9 failed suites / 97 failed tests and 109 passed suites / 1304 passed tests **plus** the new files' passes and nothing else moved (clause 3.19).

### Exploratory Bug Condition Checking

**Goal.** Counterexamples on unfixed code, before any fix lands. Each confirms or refutes a root cause.

**Test plan.** Load the real `templates.js` into a vm realm with a real parsed DOM, a real `LibraryIndex`, and the real `pathBuilders` sanitizers injected. Drive the real entry points. Run on unfixed source and record the failures.

**Test cases** — `tests/media-card-lifecycle-exploration.test.js`:

1. **E1 — warm paint blanks a persisted thumbnail** (will fail on unfixed code). Persist an index entry `{ folderPath, thumbnailPath: "<folder>/thumbnail.png", thumbStatus: "ready" }` with no `thumbnail`. Call `startupWarmPaint(li)`. Assert `renderTemplateCardMarkup(allTemplates[0], section, [])` contains `<img class="thumb-img" src="file:///`. Confirms hypothesis 1's read-side half.
2. **E2 — the same blank through `loadTemplates`' warm branch** (will fail). Same seed, entry point `loadTemplates()`, same assertion. Proves the defect lives in **both** warm-paint implementations, not just the one the requirements cite.
3. **E3 — `refreshCardThumbnail` withholds `thumbnail` from the index** (will fail). Seed an entry, call `refreshCardThumbnail(folder, folder + "/thumbnail.png")`, assert `li.getEntry(folder).thumbnail` is a non-empty string. Confirms hypothesis 1's write-side half — **and is expected to keep failing after the fix**, because D1 chose read-side derivation. Recorded as a *diagnostic* assertion, marked as such in the file, and converted to its inverse in the preservation suite (P2c below) rather than deleted.
4. **E4 — media delete is a persisted no-op** (will fail). Seed `allTemplates` and `li` with a media entry at `<root>/footage/Broll/media-<hex>`. Call `removeUITemplate(name, cat)`. Assert `li.has(folderPath) === false` **and** `li.needsFullScan() === false`. Confirms hypothesis 2.
5. **E5 — media patch is a persisted no-op** (will fail). Same seed, `patchUITemplate(name, cat, { favorite: true })`. Assert `li.getEntry(folderPath).favorite === true`.
6. **E6 — category segment diverges from the host** (will fail). For `"My\tCat"`, `"My  Cat"`, `" My Cat "`, `"My\r\nCat"`: assert the panel's derived segment equals `hostGetSafeName(hostCleanStr(cat))`. Confirms hypothesis 3.
7. **E7 — both PNG call sites diverge** (will fail). Drive the real `confirmSave` PNG path with `selectedCatValue: "My  Cat"`; assert the captured `renderOptimisticCard` argument's `folderPath` **and** the captured `refreshCardThumbnail` folder both equal the host-derived path. Proves the fix must land at two sites, not one.
8. **E8 — an unmirrored derived-field write is undetectable** (will fail). Build the catalog, then run the reconcile processor with a scan record that changes only `category` on a **middle** record (no adds, no removes). Assert `catalogSourceChanged() === true`. Confirms hypothesis 5 and pins the exact gap.
9. **E9 — edge case, `renderIcons` is unreachable** (expected to **pass** on unfixed code). Assert `renderIcons` has zero references in `js/**` and in `index.html`. A failure here refutes clause 1.8 and re-opens BUG 4 as a live defect rather than dead code.
10. **E10 — edge case, the host already covers `element/`** (expected to **pass** on unfixed code). Assert `STARTUP_SCAN_SECTIONS` has exactly seven entries and no `"element"`, and `SECTION_SCAN_FOLDERS.element === "overlay"`. A failure refutes clause 2.11.

**Expected counterexamples.**
- E1, E2: markup contains the placeholder `<rect …/>` SVG, or a bare `<img class="thumb-img" alt="">` for a media record — no `src`. Cause: no `thumbnail` on the entry and no read-side derivation.
- E4, E5: `li.size()` unchanged, `li.needsFullScan() === true`, and `li.lastError()` (`persistence.js:479`) reading `LibraryIndex.removeEntry: no entry for <name-derived path>` — the message names a path with no `media-<hex>` segment. Cause: name-derived reconstruction against an id-derived folder.
- E6, E7: panel `icon/My  Cat/…` vs host `icon/My Cat/…`; panel `icon/My_Cat/…` vs host `icon/MyCat/…`. Cause: the fold applied on one side only.
- E8: `catalogSourceChanged()` returns `false` — `sourceStamp() === _templatesRevision` because the counter never moved, and every shape probe matches. Cause: the signal has no callers.

### Fix Checking

**Goal.** For every input where the bug condition holds, the fixed code produces the expected behaviour.

```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixed(input)
  ASSERT expectedBehavior(result)
END FOR
```

Property-based, in `tests/media-card-lifecycle-preservation.property.test.js` (fix and preservation share the file so each pair reads together):

- **F1 → Property 1.** Generate entries with arbitrary Windows/POSIX raw thumbnail paths, arbitrary `thumbStatus`, and `thumbnail` present or absent. For every entry satisfying the condition: `hydrateWarmPaintThumbnail` returns true, the result starts `file:///`, decodes back to the raw path, carries a `?v=` token distinct from the previous token issued for that folder, and `renderTemplateCardMarkup` emits `<img class="thumb-img" src="…">`. Assert the injected `nfs()` recorded **zero** calls during hydration.
- **F2 → Property 3.** Generate media entries with arbitrary categories and hex id segments. After `removeUITemplate`: `li.has(folderPath) === false`, `li.needsFullScan() === false`, and no record remains in `allTemplates`. After `patchUITemplate(name, cat, patch)`: `li.getEntry(folderPath)` carries every patched field and its `folderPath` is unmoved (`patchEntry` pins `merged.folderPath = key`, `persistence.js:449`).
- **F3 → Property 5.** For 2000 generated category strings drawn from an alphabet that includes TAB, CR, LF, multi-space runs, reserved characters and the reserved device stems: `safeCategorySegment(cat) === hostGetSafeName(hostCleanStr(cat))`. Plus the integration form of E7 re-run on fixed code, asserting the optimistic-card folder and the `refreshCardThumbnail` folder are equal to each other and to the host-derived path.
- **F4 → Property 8.** For each of the seven S-sites, drive the real entry point and assert `catalogSourceChanged()` is true afterwards and that the following `ensureCatalogFresh()` invokes `TemplateCatalog.build` exactly once. `TemplateCatalog.build` is spied by wrapping it in the vm context.

### Preservation Checking

**Goal.** For every input where the bug condition does not hold, the fixed code produces the same result as the original.

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT original(input) = fixed(input)
END FOR
```

**Testing approach.** Property-based, because the preservation obligations here are universally quantified over path strings, category strings and mutation sequences — exactly where hand-picked examples miss. For BUG 2 and BUG 3 the "original" side is computed **inside the test** from the pre-fix expression, so equality is asserted against the old rule rather than against a snapshot.

**Test plan.** Observe the unfixed behaviour first for each non-bug input class, then encode it.

**Test cases:**

1. **P1 → Property 4 (clause 3.4).** For 2000 generated **non-media** records (arbitrary name, category, section, sourcePath): `_getTemplateFolderPath(name, cat)` equals the pre-fix expression recomputed in the test. Byte equality, not a shape check.
2. **P2 → Property 2 (clauses 3.2, 3.3).** For generated entries where the condition does **not** hold: `hydrateWarmPaintThumbnail` returns false and `entry.thumbnail` is `===` its prior value (including `undefined`). Separately, for **every** generated entry: `entry.thumbnailPath` is unchanged, contains no `file:` scheme and no `?v=`, and is accepted by a fake `existsSync` keyed on raw paths. And: an entry with no `thumbnailPath` still renders placeholder artwork.
3. **P2c → Property 2 (clause 3.1), the inverse of E3.** After `refreshCardThumbnail(folder, thumb)`: `allTemplates[i].thumbnail` is a `file:///…?v=` URL, `allTemplates[i].thumbnailPath` is the raw path, `TemplateCatalog.patch` was called once for that record, the persisted entry carries `{ thumbStatus: "ready", thumbnailPath: <raw> }` and — asserted deliberately — **no** `thumbnail`, because D1 chose not to widen the write. Also asserts `buildBustedThumbUrl(thumbPath, token)` is byte-identical to the pre-fix inline expression for 2000 generated paths, which is what licenses the refactor.
4. **P3 → Property 6 (clause 3.6).** For 3000 generated categories containing no TAB, no CR/LF and no run of two or more spaces, with no leading/trailing whitespace: `safeCategorySegment(cat) === getSafeName(cat)`, byte-identical — no existing folder is re-keyed. `cleanName` idempotence is already covered by `tests/save-path-builders.test.js:439-446`.
5. **P4 → Property 6 (clause 3.7).** The PNG host call keeps its 5-argument monolithic form. Already pinned by `tests/save-return-shape.test.js:561` (`savePNGOnly("MyTemplate","TestCat","/lib","icon","")`) and `:608` (the `overlay` form). Named here as the regression witness; **not modified**.
6. **P5 → Property 9 (clause 3.10) — the binding test.** Build the catalog, then perform K renders through `renderWindowedIds`/`filterAndRender` with **no** intervening mutation. Assert `TemplateCatalog.build` was invoked exactly once across all K. This is the test that would catch an over-broad call-site set, so it is generated over K and over library sizes rather than written as a single example.
7. **P6 → Property 9 (clause 3.10), the exclusion witness.** After `ensureCatalogFresh()`, call `refreshCardThumbnail` M times for M distinct cards and assert `catalogSourceChanged()` stays `false` and `TemplateCatalog.build` is not called again. This is the executable form of the D3 decision to exclude `refreshCardThumbnail`: if a later change adds `markTemplatesDirty()` there, this test fails.
8. **P7 → Property 9 (clause 3.11).** Simulate `_publishDurable`: with the array identity held constant, `length = 0` then re-push a shallow clone of every record, with no `markTemplatesDirty` call. Assert `catalogSourceChanged() === true`. Generated over library sizes including 1 and 2, where first and last coincide.
9. **P8 → Property 4 (clause 3.5).** `patchUITemplate` still matches by `name` + `category` + `section`, still calls `TemplateCatalog.patch(mutated, before)` with the same `before` shape, and still routes through `filterAndRender` exactly when `recordChangedView` holds and through `patchTemplateCard` otherwise. Generated over favourite/rename/move patches with and without an active search and with `currentCategory === "Favorites"`.
10. **P9 → Property 7 (clauses 3.8, 3.9).** `renderIcons` is absent from `js/templates/templates.js` and unreferenced in `js/**` and `index.html`; no remaining `js/**` markup builder emits `<img src>` from a `thumbnail` without the guard. The `renderTemplateCardMarkup` guard itself and the never-reached-renderer assertions stay pinned by `tests/single-card-patch-job-completion.property.test.js:351` and `tests/keyed-media-card-helper.test.js:255` — named as witnesses, **not modified**.
11. **P10 → Property 10 (clauses 3.12, 3.13, 2.12).** `STARTUP_SCAN_SECTIONS` is exactly `["comp","layer","text","footage","effect","icon","overlay"]` in that order; it contains no `"element"`; `SECTION_SCAN_FOLDERS.element === "overlay"`; `startupScanSectionOrder()` puts the active section first and keeps the remaining six in fixed order for every section including `element`. This is the executable form of the BUG 6 no-change decision.
12. **P11 → Property 11.** `tests/media-cep-compatibility.test.js` unmodified and green. Reconfirmed by construction: no whole-file-scanned unit is edited, and neither `escapeTemplateCardAttribute` nor `renderTemplateCardMarkup` is edited, so the region scans see identical text.
13. **P12 → Property 2, the existing-fixture witness.** The four startup performance suites seed records with `thumbnail: ""` and **no** `thumbnailPath` (`tests/performance/startup-warm-paint.property.test.js:378-389`, `startup-reconcile.property.test.js:377`, `startup-lifecycle.property.test.js:548`, `:1082`, `cold-start-progressive.property.test.js:192`). `hydrateWarmPaintThumbnail` returns false on its second guard for every one of them, so all four suites are byte-unaffected. Re-run as-is; **no edit**.

### Unit Tests

- `hydrateWarmPaintThumbnail` decision table: the four `(thumbnailPath present?) × (thumbnail present?) × (thumbStatus === "ready"?)` classes, plus `null`, `undefined`, non-object and empty-string inputs.
- `buildBustedThumbUrl`: leading-slash stripping, backslash conversion, empty input returning `""`, and characters `encodeURI` does and does not escape.
- `_findUITemplateRecord`: no match, match in the wrong section, duplicate names in different categories.
- `_getTemplateFolderPath`: media entry with a usable `folderPath`; media entry with an empty `folderPath` (falls through to the reconstruction); non-media entry; entry absent from `allTemplates`.
- `safeCategorySegment`: the named host cases `"a\tb"`, `"  a  b  "`, `"a\r\nb"`, `"a\n \tb"`, `null`, `undefined`, `""`, plus a reserved device stem and a trailing-dot category.
- `markTemplatesDirty` returns a strictly increasing integer and is idempotent in effect (N calls before one `ensureCatalogFresh` yield one rebuild).

### Property-Based Tests

- Generate raw thumbnail paths across Windows drive, UNC and POSIX shapes; assert warm-paint derivation always yields a renderable `<img src>` and never mutates `thumbnailPath`.
- Generate media entries with hex id segments and hostile categories; assert `removeUITemplate`/`patchUITemplate` always hit the backing index entry and never raise `_needsFullScan`.
- Generate category strings over an alphabet including TAB, CR, LF, space runs, reserved characters and device stems; assert panel/host segment parity and byte-identity on clean inputs.
- Generate mutation sequences over `allTemplates` (field write, push, splice, unshift, clone rewrite, no-op render) and assert `catalogSourceChanged()` is true exactly when a mutation occurred since the last sync — no false negatives (correctness) and no false positives on the no-op render (clause 3.10).

### Integration Tests

- Full reopen: persist an index from a session that saved an image, then run the real `startupWarmPaint` and assert the first painted grid carries the same `<img src>` the closing session showed, with zero filesystem and zero bridge calls before that first grid write. Pairs with `tests/performance/startup-warm-paint.property.test.js`, which must stay green.
- Full media delete round trip: import → delete → re-serialize the index → reload → assert the card does not reappear.
- Full PNG save with a tab category: real `confirmSave` → captured host call → optimistic card → `refreshCardThumbnail`, asserting one folder path throughout and a card that flips from placeholder to image.
- Full reconcile: warm paint → stale validity key → reconcile that changes only a middle record's category → assert the category panel counts and a search for the new category both reflect it in the same session.

## Conflicts and Ordering

Two fixes touch the same function, and one shifts every line number in the file.

| Overlap | Detail | Resolution |
| --- | --- | --- |
| **BUG 4 shifts all line numbers** | Deleting `:722-785` moves every subsequent line up by 64. Every other edit in this design is below 722. | **Apply BUG 4 last.** All other line references stay valid until then. If applying by anchor text rather than line number, order is free. |
| **BUG 1 and BUG 5 both touch `refreshCardThumbnail`** | BUG 1 replaces the URL construction at `:2888-2890`; BUG 5 decides *not* to add a call there. | No textual overlap. Apply BUG 1's substitution; leave the rest of the function alone. A reviewer seeing no `markTemplatesDirty()` in this function should read D3's exclusion row, not add one. |
| **BUG 2 and BUG 5 both concern `removeUITemplate` / `patchUITemplate`** | BUG 5 edits `:2178` and `:2208`, inside their bodies. | BUG 2 as designed edits **only** `_getTemplateFolderPath` (`:2162-2169`) and adds `_findUITemplateRecord` above it — the two callers are untouched. This disjointness is one of the reasons D4 rejected changing the helper's signature. |
| **BUG 1 and BUG 5 S7 both concern `renderOptimisticCard`** | BUG 5 adds a line after `:3036`. | BUG 1 under D1 does **not** widen the `insertAtHead` literal at `:2994-3003`, so there is no overlap. Had the write-side option been chosen, these two edits would sit ~40 lines apart in the same function and would need coordinating. |
| **BUG 1 and BUG 5 both edit the 1148-1900 span** | BUG 1 inserts helper B above `:1148` and a call inside `startupWarmPaint`'s loop (`:1173`); BUG 5 edits `:1833`, `:1838`, `:1897`. | Different functions, ~650 lines apart, but BUG 1's insertion shifts BUG 5's anchors down by the helper's length. **Apply BUG 5 before BUG 1**, or anchor by text. |

Recommended order: **BUG 3 → BUG 2 → BUG 5 → BUG 1 → BUG 6 → BUG 4.**

## Tests That Pin Current Behaviour and Need Attention

Nothing in the suite pins the buggy behaviour as *correct*, so no existing assertion is inverted. Three items still need naming rather than silent handling:

1. **`tests/save-return-shape.test.js` (~line 190) and `tests/comp-pipeline-integration.test.js` (~line 926)** — add `cleanName: pathBuilders.cleanName` to the injected-globals object. **Assertion change: none.** Both already `require("../js/core/pathBuilders")`; both use the category `"TestCat"`, for which `cleanName` is the identity, so the folder-path assertions at `save-return-shape.test.js:571-572`, `:582-583`, `:609-610` and the host-call assertions at `:561`, `:608` produce identical strings before and after. Without this addition the fix still works in production but those two suites exercise `safeCategorySegment`'s guarded fallback instead of the real fold, which would leave the fix unverified in the one suite that drives the real `confirmSave` PNG path.

2. **Exploration case E3 will not flip to passing.** It asserts `li.getEntry(folder).thumbnail` is non-empty after `refreshCardThumbnail`, which D1 deliberately declines to make true. It is a *diagnostic* counterexample, not a fix target: it exists to prove the write-side half of hypothesis 1 on unfixed code. It must be labelled as such in the file and its post-fix inverse asserted in P2c (`li.getEntry(folder)` carries `thumbStatus` and `thumbnailPath` and **no** `thumbnail`), so the decision is enforced rather than merely documented.

3. **`tests/performance/contract-baseline.test.js`** is one of the nine known-failing baseline suites (clause 3.19) and contains `context.renderIcons = context.renderCards` at line 613 and a `forceIconGrid` stub at line 605. Both are assignments into a vm context, so they survive the BUG 4 deletion unchanged and neither asserts anything about `renderIcons`. **No edit; no change to its failure count.** Called out only because a `renderIcons` deletion invites the assumption that it must be cleaned up.

Six suites stay green **by construction** and must be re-run to confirm it: `tests/keyed-media-card-helper.test.js` and `tests/single-card-patch-job-completion.property.test.js` stub `renderIcons` by assignment and assert `rendererCalls` is empty (`:255`, `:351`), which the deletion cannot affect; and the four startup performance suites seed no `thumbnailPath`, so the warm-paint derivation is inert for them (P12).
