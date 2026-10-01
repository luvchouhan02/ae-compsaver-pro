# Bugfix Requirements Document

## Introduction

This bugfix covers **four defects** found while completing the `media-card-lifecycle-edge-fixes` spec. All four were recorded there and deliberately **not** fixed, because each needs its own scope. Two are named in that spec's own notes as out-of-scope follow-ups; two were noted only in passing and were verified from scratch for this document.

The surfaces in scope are the normalized catalog mirror (`js/templates/templateCatalog.js`), the panel-side UI mutation helpers and the card import entry point (`js/templates/templates.js`), and the shared test DOM (`tests/helpers/miniDom.js`). The persisted library index (`js/core/persistence.js`) and everything under `jsx/` are read for verification only and are **not** modified.

### Verification outcome per defect

Every claim below was checked against the working tree before this document was written. Two reproduce exactly as reported, one reproduces with a **corrected consequence**, and one reproduces as a coverage gap with a **corrected mechanism** and an **empirically measured** blast radius.

| Bug | Reported | Verification result |
| --- | --- | --- |
| **BUG A** | `TemplateCatalog.patch` duplicates a record on an id change | **Confirmed, and worse than reported.** Reproduced in a vm realm against the real module. A rename leaks one `sectionIds` entry per rename (cumulative), inflates `counts.all` and `counts.cats[cat]`, leaves the pre-rename `searchHay` under the old id so the card stays findable under its **old** name, and — the consequence not reported — leaves `byId[oldId]` alive through a later `remove`, so a rename-then-delete leaves a **ghost record** the grid still renders. The category *list* is unaffected: `rebuildSectionCategories` dedupes by category name. |
| **BUG B** | `patchUITemplate` mutates the index before its own scan runs | **Confirmed exactly as stated,** including the four-way case split. Already pinned by four cases in `tests/media-card-lifecycle-preservation.property.test.js` that label the behaviour "RECORDED, NOT ENDORSED". One additional consequence found: in the favourite-toggle path the scan *does* match, but `before` is computed from the already-merged clone, so `before.favorite === t.favorite` and `TemplateCatalog.patch` **skips the favourites-count adjustment** at `templateCatalog.js:183-187` — and because a favourite toggle is not `structural`, `rebuildSectionCategories` does not run either, so nothing recomputes the count. |
| **BUG C** | `importCurrentCardToTimeline` derives the section from global state, so the host resolves the wrong folder | **Reproduces, but the reported consequence does not.** The section derivation is exactly as described (`templates.js:2542-2543`). The *folder* consequence does **not** occur: the host's `findTemplateFolder` (`jsx/core.jsx:453-473`) probes the exact section path and then falls back to scanning all eight section folders, so a wrong section still finds the folder. The real consequence is larger — `csDispatchImport(t.section, …)` (`jsx/import.jsx:548-568`, called at `:736`) uses the section to select the **import routine**, and the absolute `folderPath` locator is forwarded only on the image and footage branches. **The section IS recoverable from the card**; no new data attribute is required. See the mechanism note below. |
| **BUG D** | The imperative DOM patch is exercised by no test | **Confirmed as a coverage gap, mechanism corrected.** The loops are unreached, but not because `dataset` throws. `miniDom`'s `matchesSelector` handles a single selector only, so `document.querySelectorAll(".card, .icon-card")` returns **zero** elements and the loop body never iterates — no throw occurs at all. Four gaps must close, not one: selector-list support, `dataset`, `classList`, and `style` plus a `textContent` setter. **Blast radius measured: zero.** |

### BUG C — what is actually recoverable from the card

This was settled from the source rather than assumed, because the choice between deriving the section and merely asserting the invariant depends on it. Verified: a card carries `data-file`, `data-cat`, `data-folder`, `data-thumb`, a `tpl-<record id>` element id (`templates.js:818`, `:823-829`) and, for media, `data-type` / `data-mediatype` / `data-mediapath`. It carries **no** section attribute. The section is nevertheless recoverable by three independent routes, so the fix is a derivation, **not** a recorded-and-asserted invariant and **not** an invented attribute:

1. **The stable element id.** `card.id` is `"tpl-" + record.id`, escaped by `escapeTemplateCardAttribute` (`templates.js:744-751`) whose entity escaping round-trips through an attribute parse. Stripping the prefix yields the record id exactly, and `TemplateCatalog.get(id)` returns the record whose own `section` field is canonical.
2. **A section-agnostic record scan.** `getTemplateSourcePath(name, cat)` (`templates.js:2138-2151`) already matches `allTemplates` on `name` + `category` with **no** section clause, and `importCurrentCardToTimeline` already calls it twice for the payload's `rootPath` and `sourcePath`. So the payload's `sourcePath` and its `section` are derived by two different rules today — the inconsistency is internal to one function.
3. **The folder path.** `data-folder` is `<root>/<normalizeSectionName(section)>/<safeCat>/<leaf>`, so the section is the third segment from the end. `mediaRootFromFolderPath` (`templates.js:2125-2136`) already strips exactly those three segments.

### BUG D — the measured blast radius

`tests/helpers/miniDom.js` is consumed by **15 suites**: `keyed-media-card-helper`, `media-async-io.property`, `media-card-lifecycle-exploration`, `media-card-lifecycle-preservation.property`, `media-hover-controller`, `media-hover-controller.property`, `media-import-coordinator`, `media-index-migration.property`, `media-pipeline-integration`, `single-card-patch-job-completion.property`, and `performance/{cold-start-progressive.property, fast-media-terminal-regression, startup-lifecycle.property, startup-reconcile.property, startup-warm-paint.property}`.

A probe implementation of all four additions — a live `data-*`-backed `dataset`, a `className`-backed `classList`, a `style` bag, a `textContent` setter, and comma-separated selector-list support — was applied to the shared helper and the whole suite was run:

| Run | Result |
| --- | --- |
| 15 miniDom suites, before | 1 failed / 171 passed / 172 total |
| 15 miniDom suites, with the probe | 1 failed / 171 passed / 172 total — **identical** |
| Full suite, with the probe | 10 failed suites / 98 failed tests, 110 passed suites / 1383 passed tests — **the exact stated baseline** |

Nothing moved. The one failure in both runs is the permanently-red `E3` diagnostic. **The shared helper is therefore the right place to fix this, not a scoped fake.** The probe has been reverted; the working tree is unmodified.

Two constraints the probe surfaced, which the fix must respect:

- `MiniElement.prototype.textContent` is currently defined **non-configurable**, so a setter cannot be bolted on from outside — it must be added at the original descriptor. Suites that extend `miniDom` (`startup-reconcile.property`, `startup-lifecycle.property`, `startup-warm-paint.property`) redefine `innerHTML` / `outerHTML` and are unaffected.
- Nothing in `js/core/keyedMediaCardHelper.js` or `js/core/fastMediaEngine.js` reads `dataset`, so the keyed media adapter — miniDom's primary consumer — is untouched by the addition.

### Ordering dependency between BUG A and BUG B

BUG A's repair needs to distinguish "a record whose id changed" from "a genuinely new record". The only caller-side information that separates them is the record's **pre-patch** id, and `patchUITemplate` computes its `before` snapshot from `allTemplates[i]` — which, under BUG B's aliasing, is the clone `li.patchEntry` already merged the new id into. So any BUG A fix that keys on a caller-supplied old id is only correct once BUG B's ordering is fixed. This is recorded here so the design phase orders the two deliberately rather than discovering it mid-implementation.

### Impact

BUG A and BUG B compound on the same user action. A rename in a reopened panel — the shape every reopened panel is in — takes BUG B's path, so the catalog keeps the pre-rename record for the rest of the session and the grid shows the old name. Force a rebuild (BUG A's masking mechanism, which the prior spec's S5 installed) and the rebuild is correct; take the un-masked `patch` path and the category counts inflate and the card duplicates. BUG C is latent: no current caller violates the invariant, but nothing enforces it, and the failure mode is the wrong import routine rather than a missing file. BUG D costs no user anything today — it means four pieces of shipped UI behaviour (the in-place `<img src>` swap, the `data-thumb` update, the failure-badge insertion and the `thumb-failed` class toggle) have never been executed by a test.

### Existing tests that pin current behaviour and will need updating

Enumerated up front, per instruction. Every entry names the file, the case and the specific assertion.

**Pre-authorized to change — these assert BUG B's behaviour as "RECORDED, NOT ENDORSED" and their in-file comments state that a fix must update the case rather than revert the fix.** All are in `tests/media-card-lifecycle-preservation.property.test.js`.

| # | Case | Assertions that will move |
| --- | --- | --- |
| 1 | `F4-S5-aliasing-rename` — "S5 rename in shared mode at a MIDDLE index: nothing fires" | `expect(realm.marks.length).toBe(0)` → 1; `expect(realm.catalog.patch.length).toBe(0)` → 1; `expect(ctx._templatesRevision).toBe(revisionBefore)` → `+ 1`; `expect(ctx.catalogSourceChanged()).toBe(false)` → true; `expect(ctx.TemplateCatalog.get("t2").name).toBe(oldName)` → the old id must no longer resolve at all once BUG A lands; `expect(ctx.allTemplates[MID]).not.toBe(target)` depends on whether the ordering fix keeps `patchEntry`'s clone replacement. The five `shapeProbeDelta` assertions (`arrayIdentityMoved`, `lengthMoved`, `firstElementMoved`, `lastElementMoved`, `catalogSizeMoved` all `false`) stay valid — the point of the case is that the counter, not a probe, is the mechanism. |
| 2 | `F4-S5-aliasing-rename-edges` — "FIRST and LAST index: the element-identity probes cover it" | `expect(realm.marks.length).toBe(0)` → 1 and `expect(realm.catalog.patch.length).toBe(0)` → 1 for both indices. `expect(delta.firstElementMoved).toBe(true)` / `expect(delta.lastElementMoved).toBe(true)` hold only if the clone replacement survives the fix. `expect(realm.catalog.build).toBe(1)` and `expect(ctx.TemplateCatalog.get("renamed-" + idx).name).toBe(oldName + " R")` should survive. |
| 3 | `F4-S4-aliasing-shared` — "removeEntry splices the shared array before the scan runs" | `expect(realm.marks.length).toBe(0)` → 1; `expect(realm.catalog.remove.length).toBe(0)` → 1; `expect(ctx._templatesRevision).toBe(revisionBefore)` → `+ 1`. `expect(li.has(target.folderPath)).toBe(false)`, `expect(li.needsFullScan()).toBe(false)`, `expect(ctx.allTemplates.length).toBe(SIZE - 1)`, `expect(delta.lengthMoved).toBe(true)`, `expect(realm.catalog.build).toBe(1)` and `expect(ctx.TemplateCatalog.size()).toBe(SIZE - 1)` all stay. |
| 4 | `F2-pin` — "a patch that tries to move `folderPath` is pinned to the index key" | The four `expect` calls all read the **cloned** world and stay green. The `shared` world is driven but only *observed*, in `note`: "the aliased in-memory write re-applies folderPath over the pin, so the entry is no longer reachable at its old key". After the ordering fix that observation text is wrong and must be re-recorded; `expect(shared.li.getEntry(shared.folder) !== null)` is currently reported through `observe`, not asserted, so nothing goes red — but the note is a factual claim in the file and must be corrected. |
| 5 | `F2-remove` — "removeUITemplate drops the backing entry…" | `const expectMirror = w.aliased ? 0 : 1;` encodes the aliasing rule **as an equality**, consumed by `expect(w.realm.catalog.remove.length).toBe(expectMirror)`. After the fix this becomes `1` unconditionally. The non-vacuity guards `expect(aliasSeen.shared).toBeGreaterThan(0)` / `expect(aliasSeen.cloned).toBeGreaterThan(0)` stay — both modes must still be generated. |
| 6 | `F2-patch` — "patchUITemplate lands every patched field on the backing entry…" | `const expectMirror = (w.aliased && movesMatchKey) ? 0 : 1;` and its consumer `expect(w.realm.catalog.patch.length).toBe(expectMirror)`. After the fix this becomes `1` unconditionally, and the non-vacuity guard `expect(mirrorSeen["0"]).toBeGreaterThan(0)` **can no longer be satisfied** and must be removed or inverted; `expect(mirrorSeen["1"]).toBeGreaterThan(0)` stays. `expect(kindSeen.{favorite,rename,move}).toBeGreaterThan(0)` stay. |
| 7 | The `S_SITES` table entries for `S4`, `S5`, `S6`, `S7` | Each carries `aliasing: "cloned"`, chosen specifically to route around BUG B. Once the ordering is fixed, `S4` and `S5` are reachable in `"shared"` mode too. Their `drive` assertions (`expect(realm.catalog.remove.length).toBe(1)`, `expect(realm.catalog.patch.length).toBe(1)`) become mode-independent. Changing the mode is optional; leaving it is not wrong, but the accompanying comments ("The shared shape — where it does not — is pinned separately in the aliasing block below") become stale. |
| 8 | The `describe` block comment at "The aliasing boundary S4 and S5 sit on" | A 27-line factual narrative of the four-way case split, ending "it needs its own spec". This spec **is** that spec; the comment must be rewritten to describe the fixed behaviour. |

**Not pre-authorized, and must NOT be weakened — these pin behaviour BUG A's fix has to preserve.**

| # | Case | Assertion that must keep passing |
| --- | --- | --- |
| 9 | `tests/template-catalog.test.js:152-154` | `catalog.patch(fresh)` where `fresh` is a genuinely new record with an id absent from `byId` must still act as an **add**. This is the case BUG A's fix must not break while it stops treating a *changed* id as new. Its sibling cases at `:101` (favourite toggle) and `:116` (category change) must also stay green, along with the file's incremental-equals-rebuild cross-checks. |
| 10 | `tests/comp-pipeline-integration.test.js` FLOW 6, `makeCardFake()` | The fake card has `dataset.{file,cat,folder}`, `style`, `classList` — and **no `id` and no `getAttribute`**. BUG C's fix must tolerate that: reading `card.id` on this object yields `undefined`. Both tests then assert on `.importing` / `.imported` class state and on the toast text; neither asserts the payload's `section`, so they should stay green if the derivation is guarded. `dataset.folder` is `"C:/lib/comp/Cat/T1"`, whose third-from-last segment is `comp`. |
| 11 | `tests/media-card-lifecycle-exploration.test.js` case `E3` | The permanently-red diagnostic. Design decision D1 of the prior spec deliberately declines to satisfy it. It must **stay red** and keep its `DIAGNOSTIC` label. Its post-fix inverse `P2c` must stay green. |

**Expected to be unaffected, listed so the assumption is checked rather than assumed.** The 15 miniDom suites (measured above at zero movement); `tests/media-cep-compatibility.test.js` (no whole-file-scanned unit and neither region-scanned body is touched); `tests/comp-pipeline-bug-exploration.test.js` (22/22); `tests/comp-pipeline-preservation.property.test.js` (47/47); `tests/media-card-lifecycle-preservation.property.test.js`'s other 60-plus cases.

### Traceability

| Bug | Current Behavior | Expected Behavior | Unchanged Behavior |
| --- | --- | --- | --- |
| BUG A | 1.1 – 1.4 | 2.1 – 2.4 | 3.1 – 3.4 |
| BUG B | 1.5 – 1.9 | 2.5 – 2.8 | 3.5 – 3.9 |
| BUG C | 1.10 – 1.13 | 2.9 – 2.12 | 3.10 – 3.13 |
| BUG D | 1.14 – 1.17 | 2.13 – 2.16 | 3.14 – 3.17 |
| Cross-cutting constraints | — | — | 3.18 – 3.24 |

### Verification command

```
npx jest tests/template-catalog.test.js tests/media-card-lifecycle-exploration.test.js tests/media-card-lifecycle-preservation.property.test.js tests/comp-pipeline-integration.test.js tests/media-cep-compatibility.test.js --runInBand
```

---

## Bug Analysis

### Current Behavior (Defect)

#### BUG A — `TemplateCatalog.patch` duplicates a record when its id changes

Observable symptom: after renaming a card, the category counts in the panel are inflated, the record appears twice in the section's id list, the card is still findable by searching its **old** name, and if it is then deleted a ghost copy survives in the catalog. Trigger: any `TemplateCatalog.patch(t, previous)` where `t.id` differs from the id the record was indexed under. Exactly one production caller does this: `confirmRename` → `patchUITemplate(oldName, cat, { name: newName, id: newId }, newName, undefined)` (`templates.js:2753`), which patches **`id`**.

1.1 WHEN `TemplateCatalog.patch(t, previous)` (`js/templates/templateCatalog.js:170`) is called with a record whose `id` has changed in place THEN the system evaluates `byId[id] === undefined` (`:173`), finds the **new** id absent, and takes the `addToLists(t)` early-return branch — so the record is `push`ed onto `sectionIds[section]` a second time and registered under a second `byId` key, while `byId[oldId]` still points at the very same object because the record was mutated in place.

1.2 WHEN `rebuildSectionCategories(section)` then runs (`:143`, reached from `:174`) THEN the system iterates `sectionIds[section]`, resolves both the old and the new id through `byId` to the same object, and counts it twice: `counts[section].cats[cat]` gains one (`:157`), `counts[section].favorites` gains one if the record is favourited (`:159`, `:164`), and `counts[section].all` is assigned `ids.length` (`:165`), which now includes the duplicate. Reproduced against the real module: three records in one section, one renamed at the middle index, gives `size()` 3 → 4, `idsFor("comp","All")` `["a","b","c"]` → `["a","b","c","b-new"]`, and `counts` `{all:3,cats:{Cat:3}}` → `{all:4,cats:{Cat:4}}`. Two successive renames of the same record give `["a","b","c","b1","b2"]` and `counts.all` 5 — the leak is one entry per rename, cumulative. The duplicate is **appended**, so the render order changes as well as the count. The category **list** is not affected: `rebuildSectionCategories` dedupes `catOrder` by category name (`:155`), so `categories(section)` stays correct.

1.3 WHEN the record's search haystack is re-stamped THEN the system writes `searchHay[id] = hayFor(t)` for the **new** id only (`:190` is not reached on this branch; `addToLists` writes `:81` for the new id), leaving the pre-rename haystack alive under the old id — so `idsFor(section, "All", oldName)` returns the stale id, `byId` resolves it to the renamed record, and the card is findable under **both** its old and its new name.

1.4 WHEN that record is later removed — `removeUITemplate` → `TemplateCatalog.remove(removed)` (`:206`) — THEN the system computes `recordId(t)` as the **new** id and `removeFromLists` deletes only that one key and only the first matching occurrence in `sectionIds`, so `byId[oldId]` and the old `sectionIds` entry both survive: the deleted card is still resolvable and still listed, and `counts[section].all` reports one more record than exists. A related latent variant: a patch that changes both `section` and `id` also takes the `addToLists` early return, so the record is added to the new section without being removed from the old one and is counted in both. No production caller changes `section` through `patch` today.

#### BUG B — `patchUITemplate` mutates the shared index before its own scan runs

Observable symptom: after renaming or moving a card at a middle grid position in a reopened panel, the catalog keeps the pre-rename record for the rest of the session — `TemplateCatalog.get(oldId).name` is still the old name — so the grid, the counts and the search all show pre-rename state until something else forces a rebuild. Trigger: `allTemplates === li._entries`, which is the shape both warm-paint implementations produce, combined with a patch that moves `name` or `category` on a record that is neither first nor last in the array. Counterexample: reopen the panel, rename the third of five cards.

1.5 WHEN `loadTemplates`' warm-paint branch (`templates.js:53`) or `startupWarmPaint` (`:1159`) runs THEN the system assigns `allTemplates = li._entries` with no clone, so the model array and the library index's own entry array are **one object** — the documented entry-identity rule. This is the shape of every reopened panel.

1.6 WHEN `patchUITemplate(name, cat, patchObj, newName, newCat)` (`:2234`) runs in that shape THEN the system calls `li.patchEntry(folderPath, patchObj)` (`:2239`) **before** its own `name` + `category` + `section` scan at `:2243-2244`, and `patchEntry` (`js/core/persistence.js:428-452`) replaces the element with a merged clone — `self._entries[idx] = merged` (`:450`) — that already carries the new `name` / `category` / `id`. The scan then looks for the **old** name at that index, does not match it, and falls through. `removeUITemplate` (`:2219`) has the same ordering: `li.removeEntry(folderPath)` splices the element out (`persistence.js:463`) before the scan at `:2223`, so the scan finds nothing at all.

1.7 WHEN that scan does not match THEN the system executes neither the hand-written `TemplateCatalog.patch(mutated, before)` / `TemplateCatalog.remove(removed)` mirror nor the `markTemplatesDirty()` call the prior spec installed at S4 (`:2227`) and S5 (`:2258`) — both live inside the loop body. An additional `markTemplatesDirty()` therefore **cannot** repair this: the call would sit in the branch that never executes.

1.8 WHEN the four reachable combinations are enumerated THEN the system leaves exactly one uncovered, verified case by case and pinned today in `tests/media-card-lifecycle-preservation.property.test.js`: `removeUITemplate` at **any** index changes the array length, so `catalogSourceChanged`'s length probe (`:704`) fires; `patchUITemplate` with a favourite toggle does not move `name` or `category`, so the scan matches and both the mirror and the mark fire; `patchUITemplate` renaming or moving at the **first or last** index replaces that element, so the first/last-element probe (`:705`) fires; and `patchUITemplate` renaming or moving at a **middle** index fires nothing — array identity, length, first element, last element and `TemplateCatalog.size()` are all unchanged, `catalogSourceChanged()` returns `false`, no rebuild happens, and the catalog keeps the pre-rename record for the rest of the session.

1.9 WHEN `patchUITemplate` takes the favourite-toggle path in the shared shape THEN the system computes `before` from `previous = allTemplates[i]` (`:2245-2250`) — which is the clone `patchEntry` already merged the new `favorite` value into — so `before.favorite === mutated.favorite`, the `p.favorite !== t.favorite` test in `TemplateCatalog.patch` (`templateCatalog.js:183`) is false, and the favourites count is **not** adjusted. Because a favourite toggle is not `structural`, `rebuildSectionCategories` — the only other writer of `counts[section].favorites` (`:164`) — does not run either, so nothing recomputes it. Reproduced: a catalog built over three unfavourited records, patched with an already-merged `favorite: true` clone, reports `favorites: 0` where a rebuild reports `1`. The prior spec's S5 `markTemplatesDirty()` masks this on any path that renders, but `patchUITemplate`'s non-view-changing branch calls `updateCategoryCountsOnly()` (`:2281`), which reads `TemplateCatalog.sectionCounts` without calling `ensureCatalogFresh()`, so the badge shows the stale count until the next full render.

#### BUG C — `importCurrentCardToTimeline` derives the section from global state

Observable symptom: none today. This is a latent correctness defect — an unenforced invariant whose violation would send the wrong section to the host, which selects the wrong **import routine**, not merely the wrong folder. Trigger: any call with a card that is not in the active section.

1.10 WHEN `importCurrentCardToTimeline(card)` (`templates.js:2539`) runs THEN the system reads `var section = currentSection;` (`:2542`) and derives `normSection` from it (`:2543`), then sends `normSection` as the template's `section` in the import payload (`:2615`) — while reading every other payload field from the card or from a record lookup: `name` and `cat` from `card.dataset.file` / `card.dataset.cat`, `folderPath` from `card.dataset.folder` (`:2544-2546`, `:2617`), and `rootPath` / `sourcePath` from `getTemplateSourcePath(name, cat)` (`:2610`, `:2616`), which matches `allTemplates` on `name` + `category` with **no** section clause. So one function derives two payload fields describing the same record by two different rules.

1.11 WHEN that payload reaches the host THEN the system passes the section straight into `csDispatchImport(t.section, idHex, cHex, rHex, fHex)` (`jsx/import.jsx:736`), which selects the import routine by section (`:548-568`): `comp` → `importCompDirect`, the text-properties spellings → `importTextProperties`, `effect` → `importEffect`, the image sections → `importImageDirect`, `footage` → `importVideoDirect`, and everything else → `importLayerTypeAep`. A wrong section therefore imports a composition as flattened layers, or an image as an `.aep`, rather than merely reading the wrong folder.

1.12 WHEN the reported folder consequence is checked THEN the system does **not** exhibit it: `findTemplateFolder(r, c, id, s)` (`jsx/core.jsx:453-473`) probes `<root>/<normalizeSectionName(s)>/<safeCat>/<safeId>` first and, on a miss, scans all eight section folders — `comp`, `layer`, `text`, `footage`, `effect`, `icon`, `overlay`, `element` — so a wrong section still resolves the folder. The folder is nevertheless reachable indirectly: the absolute `folderPath` locator `fHex` is forwarded only on the `importImageDirect` and `importVideoDirect` branches, so a media card misrouted to any other branch loses the only locator that can resolve a `media-<hex>` folder segment.

1.13 WHEN the invariant that makes the current derivation correct is looked for THEN the system provides no contract for it, only a coincidence: the click handler that reaches this function is attached **once, to all six card grids** (`:2025-2031`), so it is safe only because exactly one grid is visible at a time, because `filterAndRender` repaints the grid on every section switch, and because `resolveSectionGridId` maps several sections onto one grid (`icon-list-container` serves the image sections, `text-list-container` serves both text sections) so those switches repaint rather than leave stale cards. A card rendered before a section switch, or any future path that imports a card outside the active section, breaks it silently. The panel-side `resolveCached` hook is a second consumer: it reconstructs `folderPath` from `template.section` when the card supplied none (`:2581-2590`), so a wrong section also produces a metadata-cache miss. The success toast is a third: it branches on the same `section` local (`:2641-2643`).

#### BUG D — the imperative DOM patch in `refreshCardThumbnail` and `markCardFailed` is exercised by no test

Observable symptom: none for a user. This is a test-coverage gap: four pieces of shipped UI behaviour have never been executed by any test. Trigger: every vm-realm suite that supplies `tests/helpers/miniDom.js` as its document.

1.14 WHEN `refreshCardThumbnail` (`templates.js:2933`) reaches its DOM patch loop (`:2986-3008`) under a `miniDom` document THEN the system evaluates `document.querySelectorAll(".card, .icon-card")` (`:2986`) and receives an **empty** array, because `matchesSelector` (`tests/helpers/miniDom.js`) handles a single selector only — for a `.`-prefixed argument it compares the whole remainder of the string, `"card, .icon-card"`, against the element's class tokens, which can never match. The loop body therefore never iterates and **no exception is raised**: the reported mechanism, a throw into the function's outer `catch`, does not occur. `markCardFailed`'s loop (`:3137-3166`) is unreachable for the same reason.

1.15 WHEN a test does reach either loop body THEN the system throws, and on four separate counts, each verified against the helper: `c.dataset` is `undefined`, so `c.dataset.folder` raises a `TypeError`; `c.classList` is `undefined`, so `c.classList.remove("thumb-failed")` and `.add("thumb-failed")` raise; `box.style` and `badge.style` are `undefined`, so `badge.style.cssText = …` raises; and `MiniElement.prototype.textContent` is defined with a **getter only**, so `badge.textContent = "!"` raises under `"use strict"`. Closing this gap therefore requires four additions to the helper, not one.

1.16 WHEN the shipped behaviour those loops implement is looked for in the test suite THEN the system has **no** coverage anywhere for the in-place `<img src>` swap, the `c.dataset.thumb = url` update, the `<img class="thumb-img">` insertion into an empty `.thumb-box`, the removal of a superseded `.thumb-fail-badge`, the `thumb-failed` class removal on success, the `thumb-failed` class addition on failure, or the failure-badge construction and insertion.

1.17 WHEN the prior spec's BUG 1 verification is re-examined in this light THEN the system leaves it valid: in both functions the library-index patch, the `allTemplates` field writes and the `TemplateCatalog.patch` / `markTemplatesDirty` calls all execute **before** the DOM loop — `refreshCardThumbnail` at `:2952-2984` and `markCardFailed` at `:3121-3133` — so every assertion that spec made about model and index state was made against code that really ran. Only the DOM half was never reached.

### Expected Behavior (Correct)

#### BUG A

2.1 WHEN `TemplateCatalog.patch(t, previous)` is called with a record whose id has changed THEN the system SHALL treat it as one record under a new id — retiring the old `byId` key, the old `sectionIds` entry and the old `searchHay` entry — so that after the patch `size()`, `idsFor(section, category)`, `counts[section].all` and `counts[section].cats[cat]` are identical to what a full `build` over the same records would produce.

2.2 WHEN the record's id has changed THEN the system SHALL keep the record at its existing position in `sectionIds[section]` rather than appending it, so the visible render order is unchanged by a rename; and SHALL re-stamp `searchHay` for the new id only, so `idsFor(section, "All", oldName)` no longer returns the record and `idsFor(section, "All", newName)` does.

2.3 WHEN a record whose id previously changed is later removed THEN the system SHALL remove it completely: no surviving `byId` key, no surviving `sectionIds` entry, and `counts[section].all` equal to the number of records that remain.

2.4 WHEN the design phase chooses the mechanism that distinguishes a changed id from a genuinely new record THEN the system SHALL keep `patch(t)` on a record whose id is absent from the catalog **and** which the catalog has never indexed working as an **add** — the behaviour `tests/template-catalog.test.js:152-154` pins and `renderOptimisticCard` relies on. The available discriminators SHALL be enumerated in the design; the caller-supplied old id is the cheapest and depends on BUG B (see 2.8).

#### BUG B

2.5 WHEN `patchUITemplate` or `removeUITemplate` runs THEN the system SHALL resolve the `allTemplates` record it is about to mutate **before** any call that can rewrite the model array, or SHALL match that record by identity rather than by `name` + `category` + `section` — so the mirror and the staleness mark are reached in the shared-array shape exactly as they are in the cloned shape.

2.6 WHEN a rename or a move is applied at a middle index in the shared-array shape THEN the system SHALL leave `catalogSourceChanged()` true afterwards and SHALL make the next `ensureCatalogFresh()` rebuild, so `TemplateCatalog.get(newId)` resolves to the renamed record and the old id resolves to nothing.

2.7 WHEN `patchUITemplate` computes its `before` snapshot THEN the system SHALL capture the record's pre-patch `category`, `favorite` and `section` — the values that were current before `li.patchEntry` ran — so `TemplateCatalog.patch`'s `p.favorite !== t.favorite` test sees a real transition and the favourites count is adjusted exactly once per toggle.

2.8 WHEN the fix order is decided THEN the system SHALL land BUG B before any BUG A mechanism that keys on a caller-supplied old id, because `patchUITemplate`'s `before` snapshot is only pre-patch once the ordering is fixed. If the design chooses a BUG A mechanism internal to the catalog — an identity lookup over `byId`, or a reverse id map — this dependency disappears and the design SHALL say so explicitly.

#### BUG C

2.9 WHEN `importCurrentCardToTimeline(card)` derives the template's section THEN the system SHALL derive it from the card itself, falling back to `currentSection` only when no card-derived answer is available.

2.10 WHEN the derivation mechanism is specified THEN the system SHALL use the routes verified as available on the card, in a preference order the design fixes: the record resolved from the card's `tpl-<id>` element id through `TemplateCatalog.get`, then a section-agnostic `allTemplates` match on `name` + `category` (the rule `getTemplateSourcePath` already applies in the same function), then the third-from-last segment of `card.dataset.folder`, then `currentSection`. The system SHALL NOT invent a new `data-*` attribute, and SHALL NOT settle for recording the invariant and asserting it — the section **is** recoverable.

2.11 WHEN the derived section is sent to the host THEN the system SHALL send it through the same `getTemplateSection` / `normalizeSectionName` normalization the current code applies to `currentSection`, so the value `csDispatchImport` switches on keeps its existing spelling for every card that is in the active section.

2.12 WHEN a card supplies no usable section — no resolvable id, no matching record, no well-formed `data-folder` — THEN the system SHALL fall back to `currentSection` and produce byte-identical behaviour to today, so no card that works now stops working.

#### BUG D

2.13 WHEN `tests/helpers/miniDom.js` is asked for a comma-separated selector list THEN the system SHALL match an element if it matches **any** of the listed selectors, so `document.querySelectorAll(".card, .icon-card")` returns the cards both production loops iterate.

2.14 WHEN a `miniDom` element's `dataset` is read or written THEN the system SHALL reflect it live against the element's `data-*` attributes with the standard camelCase mapping, so `element.dataset.folder` reads `data-folder` and `element.dataset.thumb = v` writes `data-thumb`; and SHALL additionally supply `classList` backed by `className` (`add`, `remove`, `toggle`, `contains`), a `style` bag, and a `textContent` **setter** — the four additions verified as required, the setter added at the original descriptor because the existing one is non-configurable.

2.15 WHEN the shared helper is extended THEN the system SHALL hold the measured baseline across all 15 consuming suites and across the full suite. Measured with a probe implementation of all four additions: 15 suites at 1 failed / 171 passed / 172 total, unchanged; full suite at 10 failed suites / 98 failed tests and 110 passed suites / 1383 passed tests, unchanged. A scoped fake is therefore **not** required; if the real implementation moves any count, that is a defect in the implementation, not a reason to fall back.

2.16 WHEN coverage is added for the two DOM patch loops THEN the system SHALL exercise, through the real functions against a parsed document: the in-place `img.src` swap and the `data-thumb` update; the `<img class="thumb-img" src=… alt="" loading="lazy">` insertion into a `.thumb-box` that holds no `<img>`; the removal of a pre-existing `.thumb-fail-badge` on success; the `thumb-failed` class removal on success and addition on failure; the construction and insertion of the failure badge with its `title` and `aria-label`; and the `.icon-card` variant, whose inserted `<img>` carries **no** class. The system SHALL also cover the no-match case, where a folder that matches no card leaves the DOM untouched and raises nothing.

### Unchanged Behavior (Regression Prevention)

#### BUG A

3.1 WHEN `TemplateCatalog.patch(t)` is called with a genuinely new record THEN the system SHALL CONTINUE TO add it — `addToLists` plus `rebuildSectionCategories` — exactly as `tests/template-catalog.test.js:152-154` asserts and as `renderOptimisticCard` (`templates.js:3093-3094`) depends on.

3.2 WHEN `TemplateCatalog.patch` is called for a favourite toggle or a category change with the id unchanged THEN the system SHALL CONTINUE TO take its incremental path with the same observable result as a full rebuild, as `tests/template-catalog.test.js:101` and `:116` assert; and SHALL CONTINUE TO recompute only the affected section's category list, preserving discovery order. `tests/template-catalog.test.js` measures **6/6** today and SHALL keep passing, with new cases only from this spec.

3.3 WHEN `patch` or `remove` completes THEN the system SHALL CONTINUE TO leave `sourceRevision` unstamped — only `build` and `stampSource` re-stamp it — so `catalogSourceChanged`'s revision test keeps working as the prior spec wired it, and an incremental patch does not silently advertise itself as a full sync.

3.4 WHEN records are indexed THEN the system SHALL CONTINUE TO hold **references** in `byId` and `sectionIds`, never clones, so an in-place field write on a shared record stays visible through the catalog for free; and `categories(section)` SHALL CONTINUE TO return `["All", "Favorites", …discovery order]` with no duplicates.

#### BUG B

3.5 WHEN `patchUITemplate` applies a patch THEN the system SHALL CONTINUE TO call `li.patchEntry(folderPath, patchObj)` followed by `saveLibraryIndex()`, SHALL CONTINUE TO call `TemplateCatalog.patch(mutated, before)`, SHALL CONTINUE TO call `markTemplatesDirty()` (the prior spec's S5), and SHALL CONTINUE TO choose between `filterAndRender` and the in-place `patchTemplateCard` path by the existing `recordChangedView` test — including its `structural` and `currentCategory === "Favorites"` clauses and its `buildCategoryTabs` / `buildCategoryPanel` calls.

3.6 WHEN `removeUITemplate` removes a card THEN the system SHALL CONTINUE TO call `li.removeEntry(folderPath)` and `saveLibraryIndex()` exactly once, SHALL CONTINUE TO call `TemplateCatalog.remove(removed)` (`:2226`) and `markTemplatesDirty()` (S4, `:2227`), and SHALL CONTINUE TO end in `filterAndRender()`.

3.7 WHEN `_getTemplateFolderPath` resolves a path THEN the system SHALL CONTINUE TO return the media entry's own normalized `folderPath` for a media record and the byte-identical name-derived reconstruction for every non-media record, as the prior spec's `P1` asserts over 2000 generated records; and `patchEntry` SHALL CONTINUE TO pin `merged.folderPath = key` so no patch can move an entry.

3.8 WHEN the library index rejects a mutation THEN the system SHALL CONTINUE TO roll back to its pre-mutation snapshot, record `lastError`, and raise `needsFullScan` — and the fixed helpers SHALL CONTINUE TO leave `needsFullScan()` false on every successful media and non-media mutation, as `F2-remove` and `F2-patch` assert.

3.9 WHEN `allTemplates` is rewritten wholesale outside `templates.js` — the constant-length clone replacement `MediaEntryRepository._publishDurable` performs — THEN the system SHALL CONTINUE TO detect it through the array-identity, length, first/last-element and `TemplateCatalog.size()` probes with no counter involvement, as `P7` asserts; and a sequence of renders with no intervening mutation SHALL CONTINUE TO build the catalog at most once, as `P5` asserts.

#### BUG C

3.10 WHEN a card in the active section is imported THEN the system SHALL CONTINUE TO send a byte-identical payload — same `rootPath`, same `templates[0].{id,name,category,section,sourcePath,folderPath}` — so no import that works today changes shape.

3.11 WHEN the import is dispatched THEN the system SHALL CONTINUE TO issue exactly one `importBatch` bridge call through the timeout-guarded `callHost` with `{ timeoutMs: 120000 }` and the engine backstop at `timeoutMs: 130000`, SHALL CONTINUE TO add `.importing` on start and remove it on settle, and SHALL CONTINUE TO surface a timeout as an error toast naming that After Effects did not respond — as `tests/comp-pipeline-integration.test.js` FLOW 6 asserts.

3.12 WHEN the success toast is chosen THEN the system SHALL CONTINUE TO branch on the same value it branches on today, so the existing "Applied to text" / "Composition imported" / "Imported successfully" outcomes are unchanged for every card in the active section. Whether that branch reads the derived section or `currentSection` SHALL be decided in the design and stated, not left implicit.

3.13 WHEN a card object carries no `id` and no `getAttribute` — the shape `tests/comp-pipeline-integration.test.js`'s `makeCardFake()` supplies — THEN the system SHALL CONTINUE TO complete the import without throwing, degrading through the fallback chain to `currentSection`.

#### BUG D

3.14 WHEN `tests/helpers/miniDom.js` parses markup THEN the system SHALL CONTINUE TO apply single left-to-right attribute-entity decoding, so a record id containing entity-like text survives escape-then-parse unchanged — the property `tests/single-card-patch-job-completion.property.test.js` and `tests/keyed-media-card-helper.test.js` depend on for `tpl-<id>` element identity.

3.15 WHEN the helper's existing surface is used THEN the system SHALL CONTINUE TO behave identically for `createElement`, `createDocumentFragment`, `getElementById`, `innerHTML` get and set, `children`, `childNodes`, `appendChild`, `removeChild`, `parentNode`, `contains`, single-selector `querySelector` / `querySelectorAll`, `get`/`set`/`has`/`removeAttribute`, the reflected `id` and `className`, the `textContent` **getter**, and the void-element set. In particular the `textContent` getter's concatenation semantics SHALL be unchanged by the addition of its setter.

3.16 WHEN suites that extend the helper run THEN the system SHALL CONTINUE TO let them do so: `startup-reconcile.property` installs an `outerHTML` accessor and a live `innerHTML` getter, `startup-warm-paint.property` installs `insertAdjacentHTML` per element, and `startup-lifecycle.property` reuses the `innerHTML` descriptor. None of the four additions SHALL make any of those redefinitions fail.

3.17 WHEN the model-and-index half of `refreshCardThumbnail` and `markCardFailed` runs THEN the system SHALL CONTINUE TO behave exactly as it does today, because it already runs: `refreshCardThumbnail` SHALL CONTINUE TO patch the index with `{ thumbStatus: "ready", thumbnailPath: <raw> }`, write `thumbStatus` / `thumbnailPath` / `thumbnail` onto the matched record, and call `TemplateCatalog.patch` directly with **no** `markTemplatesDirty()`; `markCardFailed` SHALL CONTINUE TO patch the index with `{ thumbStatus: "failed" }`, write `thumbStatus = "failed"`, and call `markTemplatesDirty()` (S6) with **no** catalog mirror. Newly reaching the DOM loop SHALL NOT change either.

#### Cross-cutting constraints

3.18 WHEN any file under `jsx/` is considered THEN the system SHALL CONTINUE TO leave it unmodified. No fix in this spec requires an ExtendScript change; `jsx/import.jsx` and `jsx/core.jsx` are read for verification only. Should a `jsx/` file be touched after all, it SHALL CONTINUE TO be valid ES3 — `var` and function declarations only, no ES5+ syntax.

3.19 WHEN any file under `js/` is modified THEN the system SHALL CONTINUE TO be ES5-safe for the older-Chromium CEP runtime: no arrow functions, no `let`/`const`, no template literals, no spread or rest, no `class`, no `async`/`await`, no optional chaining, no nullish coalescing. `js/templates/templateCatalog.js` is ES5 today and SHALL remain so.

3.20 WHEN `tests/media-cep-compatibility.test.js` scans its units THEN the system SHALL CONTINUE TO pass. Whole-file units: `js/core/fastMediaEngine.js`, `js/core/scheduler.js`, `js/core/persistence.js`, `js/core/observability.js`, `js/core/keyedMediaCardHelper.js`. Region units in `js/templates/templates.js`: the `escapeTemplateCardAttribute` and `renderTemplateCardMarkup` function bodies. No fix in this spec is expected to edit any of them; if one does, the scan SHALL be re-run rather than assumed.

3.21 WHEN that test applies its Requirement 7.7 guard THEN the system SHALL CONTINUE TO contain no match for `/\.jsx\b/` in the **raw text** — comments and string literals included — of any scanned unit. BUG C's comments will necessarily describe the host's dispatch behaviour; any such comment that lands inside a scanned unit MUST describe the host **by role**, never by ExtendScript filename. `importCurrentCardToTimeline` and the UI mutation helpers sit outside both scanned regions, so this constrains only where a comment is placed.

3.22 WHEN the comp-pipeline suites run THEN the system SHALL CONTINUE TO report 22/22 in `tests/comp-pipeline-bug-exploration.test.js` and 47/47 in `tests/comp-pipeline-preservation.property.test.js`, and `tests/media-card-lifecycle-preservation.property.test.js` SHALL CONTINUE TO report 70/70 apart from the cases items 1-8 above authorize changing.

3.23 WHEN `tests/media-card-lifecycle-exploration.test.js` runs THEN the system SHALL CONTINUE TO report 1 failed / 9 passed. The single failure is `E3`, the permanent diagnostic that design decision D1 of the prior spec deliberately declines to satisfy. **`E3` SHALL stay red and SHALL keep its `DIAGNOSTIC` label.** Its post-fix inverse `P2c` — the persisted entry carries `thumbStatus` and `thumbnailPath` and deliberately **no** `thumbnail` — SHALL stay green.

3.24 WHEN the full suite runs under `npx jest --runInBand` THEN the system SHALL CONTINUE TO hold the baseline at **10 failed suites / 98 failed tests and 110 passed suites / 1383 passed tests**, with new passes only from the tests this spec legitimately adds and no count moving in either direction otherwise. The nine pre-existing failures are out of scope and SHALL stay unfixed: `tests/token-stability`, `tests/shared-systems`, `tests/accent-theme`, `tests/header-contract`, `tests/templates-contract`, `tests/class-contract`, `tests/token-foundation`, `tests/responsive-grid`, `tests/performance/contract-baseline`. The tenth failing suite is `tests/media-card-lifecycle-exploration.test.js` at 1 failed / 9 passed, per 3.23.
