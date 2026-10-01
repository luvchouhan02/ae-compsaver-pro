# Catalog Patch / Ordering Fixes — Bugfix Design

## Overview

Four defects carried over from `media-card-lifecycle-edge-fixes`, all verified against the working tree in `bugfix.md` and treated here as established fact.

| Bug | Surface | Net change |
| --- | --- | --- |
| **BUG A** | `js/templates/templateCatalog.js` — `patch` | 2 new private helpers, 1 new branch in `patch` |
| **BUG B** | `js/templates/templates.js` — `patchUITemplate`, `removeUITemplate` | both bodies restructured, no new helper |
| **BUG C** | `js/templates/templates.js` — `importCurrentCardToTimeline` | 1 new helper, 3 lines reordered, 1 line changed |
| **BUG D** | `tests/helpers/miniDom.js` | 5 additions (selector lists, `dataset`, `classList`, `style`, `textContent` setter) |

Three files change: `js/templates/templateCatalog.js`, `js/templates/templates.js`, `tests/helpers/miniDom.js`. **`js/core/persistence.js` is not modified** — that is a deliberate outcome of [D3](#d3--bug-bs-ordering-shape-and-the-clone-replacement) and it keeps the whole change set out of `tests/media-cep-compatibility.test.js`'s whole-file scan (clause 3.20). Nothing under `jsx/` changes (clause 3.18).

The six decisions the requirements deferred are resolved in [Design Decisions](#design-decisions). In one line each:

- **D1** — BUG A discriminates a re-key from an add by a **two-route** rule: the caller's pre-patch id, falling back to an identity scan over `byId`. Each route covers a shape the other cannot. Clause 2.8's A-after-B dependency **is kept**.
- **D2** — retirement is an **in-place key swap** in `sectionIds` at the existing index; `sectionCatIds` / `sectionCats` / `counts` are recomputed by the existing `rebuildSectionCategories`; `searchHay` loses the old key and gains a fresh one.
- **D3** — both helpers **resolve first**; `patchUITemplate` then addresses the mutation target by the pre-resolved **index**, `removeUITemplate` by **object identity**. `patchEntry`'s clone replacement is **kept**, and mutating the array slot rather than the pre-resolved reference is what prevents the new divergence.
- **D4** — BUG C keeps clause 2.10's order (element id → name+category scan → `data-folder` segment → `currentSection`) and implements **all four**. The success toast reads the **derived** section.
- **D5** — all five miniDom additions land in the shared helper; the selector split is confined to `querySelectorAll` so `getElementById` stays comma-safe.
- **D6** — order is **D → B → A → C**. D ∥ C ∥ {B → A} are the parallelisable groups; only B → A is a hard edge.

Every line reference below was read against the working tree. All edits are specified by **anchor text**; line numbers are navigation aids.

## Glossary

- **Bug_Condition (C)** — the input predicate that triggers a defect. Four disjoint sub-conditions, one per bug, in [Bug Details](#bug-details).
- **Property (P)** — the required behaviour once C holds. Enumerated in [Correctness Properties](#correctness-properties).
- **Preservation** — behaviour that must be byte-identical after the fix for every input where C does not hold.
- **Re-key** — a `TemplateCatalog.patch` whose record carries an `id` different from the id the catalog indexed it under. Exactly one production caller produces it: `confirmRename` → `patchUITemplate(oldName, cat, { name: newName, id: newId }, newName, undefined)` (`templates.js:2753`).
- **Entry-identity rule** (from the prior spec) — warm paint assigns the index's own entry array with no clone, so a record in `allTemplates`, the same record in `li._entries` and the same record in `TemplateCatalog.byId` are **one object**. `LibraryIndex.patchEntry`'s `self._entries[idx] = merged` (`persistence.js:450`) breaks that rule for the patched entry; repairing the consequence without repairing `patchEntry` is the subtlest part of this spec.
- **Shared shape / cloned shape** — `allTemplates === li._entries` (every reopened panel, set at `templates.js:53` and `:1160`) versus `allTemplates` holding its own record objects. `bugfix.md` calls these `aliasing: "shared"` / `"cloned"`.
- **`R` / `M`** — in the shared shape, `R` is the record object resolved before `li.patchEntry` runs; `M` is the merged clone `patchEntry` puts in its array slot. After `patchEntry`, `allTemplates[idx] === M` and `TemplateCatalog.byId[oldId] === R`.
- **Derived index state** — `searchHay` (`hayFor`: name, category, type, section, dim — `templateCatalog.js:51-54`), `sectionCatIds`, `sectionCats` and `counts`. All are snapshots; `byId` and `sectionIds` hold references and ids.
- **S1-S7** — the prior spec's `markTemplatesDirty` call-site table (its D3). This spec **relocates** S4 and S5 and changes neither their count nor their effect.
- **Shape probe** — the array-identity / length / first-element / last-element / `TemplateCatalog.size()` tests in `catalogSourceChanged` (`templates.js:699-710`). They cannot see a middle-of-array field write.

## Bug Details

### Bug Condition

```
FUNCTION isBugCondition(input)
  INPUT:  input — one panel operation with its model / index / catalog state
  OUTPUT: boolean

  RETURN isBugA(input) OR isBugB(input) OR isBugC(input) OR isBugD(input)
END FUNCTION
```

#### BUG A — `TemplateCatalog.patch` treats a re-key as an add

```
FUNCTION isBugA(input)
  INPUT:  input.t        — the record passed to TemplateCatalog.patch
          input.previous — the caller's pre-patch snapshot, or undefined
  OUTPUT: boolean

  id := recordId(input.t)
  RETURN id IS NOT NULL
         AND byId[id] IS undefined
         AND theCatalogAlreadyIndexesThisRecord(input.t, input.previous)
         // i.e. one of:
         //   input.previous.id is present, differs from id, and byId[input.previous.id] exists
         //   OR some key k has byId[k] === input.t
END FUNCTION
```

#### BUG B — the UI mutation helpers scan an array their own index call already rewrote

```
FUNCTION isBugB(input)
  INPUT:  input.entryPoint — patchUITemplate or removeUITemplate
          input.name, input.cat, input.patchObj
  OUTPUT: boolean

  RETURN allTemplates IS li._entries                       // the shared shape
         AND aRecordMatches(input.name, input.cat, currentSection)
         AND (
              input.entryPoint = removeUITemplate           // removeEntry splices
              OR movesTheMatchKey(input.patchObj)           // patchEntry pre-applies name/category
              OR NOT input.patchObj.favorite IS undefined   // before is read from the merged clone
         )
END FUNCTION
```

The third disjunct is 1.9: the favourite-toggle path's scan *does* match, but `before` is computed from `M`, so `before.favorite === mutated.favorite`, `TemplateCatalog.patch`'s `p.favorite !== t.favorite` test (`templateCatalog.js:183`) is false, and nothing recomputes `counts[section].favorites`.

#### BUG C — the import section is read from global state

```
FUNCTION isBugC(input)
  INPUT:  input.card — the card node importCurrentCardToTimeline was handed
  OUTPUT: boolean

  RETURN sectionRecoverableFromCard(input.card) IS NOT NULL
         AND sectionRecoverableFromCard(input.card) <> currentSection
END FUNCTION
```

Latent: no current caller violates it, because the click handler is attached once to all six grids (`templates.js:2025-2031`) and exactly one grid is visible at a time. Nothing enforces it.

#### BUG D — the imperative DOM patch is unreached

```
FUNCTION isBugD(input)
  INPUT:  input.document — the document supplied to the vm realm
  OUTPUT: boolean

  RETURN input.document IS a miniDom document
         AND input.document.querySelectorAll(".card, .icon-card").length = 0
             WHILE matching cards exist in the tree
END FUNCTION
```

### Examples

**BUG A.** Three records in one `comp` section, ids `a` / `b` / `c`, category `Cat`. Rename the middle one, which patches `id` to `b-new`. Verified against the real module in a vm realm:

| | before | after (unfixed) | after (fixed) |
| --- | --- | --- | --- |
| `size()` | 3 | **4** | 3 |
| `idsFor("comp","All")` | `["a","b","c"]` | **`["a","b","c","b-new"]`** | `["a","b-new","c"]` |
| `sectionCounts("comp")` | `{all:3,cats:{Cat:3}}` | **`{all:4,cats:{Cat:4}}`** | `{all:3,cats:{Cat:3}}` |
| `idsFor("comp","All", oldName)` | `["b"]` | **`["b"]`** | `[]` |
| `get("b")` | the record | **the record** | `undefined` |

- Two successive renames of the same record: unfixed gives `["a","b","c","b1","b2"]` and `counts.all` 5 — one leaked entry per rename, cumulative. Fixed gives `["a","b2","c"]` and `counts.all` 3.
- Rename then delete: unfixed leaves `byId[oldId]` and the old `sectionIds` entry alive — a ghost record the grid still renders. Fixed leaves nothing.
- Edge case, **no change**: `patch(fresh)` where `fresh` is a record the catalog has never indexed. Still an add. This is `tests/template-catalog.test.js:152-154` and what `renderOptimisticCard` (`templates.js:3093-3094`) depends on.
- Edge case, **no change**: `patch(t)` where `recordId(t)` is `null`. See [D1](#d1--bug-as-discriminator).

**BUG B.** Reopen the panel (shared shape), rename the third of five cards.

- Unfixed: `li.patchEntry` replaces `allTemplates[2]` with `M`; the scan looks for the old name at that index, misses, and falls through — so the `TemplateCatalog.patch` mirror, the `before` snapshot and S5's `markTemplatesDirty()` all sit in a branch that never runs. Array identity, length, first element, last element and `TemplateCatalog.size()` are all unchanged, `catalogSourceChanged()` returns `false`, no rebuild happens, and `TemplateCatalog.get(oldId).name` is the pre-rename name for the rest of the session.
- Fixed: the record is resolved before `patchEntry`, so the mirror and the mark are reached, `catalogSourceChanged()` is true at the instant of the mark, and the trailing `filterAndRender()` spends exactly one rebuild.
- Favourite toggle in the shared shape, unfixed: a catalog over three unfavourited records patched with an already-merged `favorite: true` clone reports `favorites: 0` where a rebuild reports `1`, and `updateCategoryCountsOnly()` (`templates.js:2281`) renders that stale count because it reads `TemplateCatalog.sectionCounts` without `ensureCatalogFresh()`.
- Edge case, **no change**: `removeUITemplate` in the shared shape already removes the record exactly once, via `removeEntry`'s splice on the shared array. The fix must not splice it a second time.
- Edge case, **no change**: `li.patchEntry` failing. `_mutate` restores `this._entries` to a fresh array of copies, so `allTemplates` is no longer the index's array and still holds `R` at its slot; the mutation and the mirror land on `R` exactly as they do today, and `needsFullScan` is raised as today.

**BUG C.** A card whose record is in `footage` imported while `currentSection` is `comp`. The payload carries `section: "comp"`, so `csDispatchImport` selects `importCompDirect` and the footage is imported as a composition rather than video — and the absolute `folderPath` locator is forwarded only on the image and footage branches, so a `media-<hex>` folder segment becomes unresolvable. The folder itself still resolves (the host probes the exact path then scans all eight section folders), which is why the reported folder consequence does not occur and the routine consequence does.

- Edge case, **no change**: a card whose record *is* in the active section. Every route returns `currentSection`, so the payload is byte-identical.
- Edge case, **no throw**: `makeCardFake()` — `{ dataset, style, classList }`, no `id`, no `getAttribute`. `card.id` is `undefined`, so route 1 is skipped by a `typeof` guard; `dataset.folder` is `"C:/lib/comp/Cat/T1"`, whose third-from-last segment is `comp`, so route 3 answers `"comp"` — which equals the harness's `currentSection`.

**BUG D.** `document.querySelectorAll(".card, .icon-card")` under miniDom returns `[]`, because `matchesSelector` compares the whole remainder `"card, .icon-card"` against the element's class tokens. The loop body never iterates and **no exception is raised**. Reach the body and it throws on four separate counts: `c.dataset` is `undefined`; `c.classList` is `undefined`; `box.style` / `badge.style` are `undefined`; and `MiniElement.prototype.textContent` has a getter only, so `badge.textContent = "!"` throws under `"use strict"`.

- Edge case, **no change**: a folder matching no card. Both loops complete without entering the body and touch nothing.

## Expected Behavior

### Preservation Requirements

**Unchanged behaviours.**

- `TemplateCatalog.patch(t)` on a record the catalog has never indexed still adds it — `addToLists` plus `rebuildSectionCategories` (3.1). The favourite-toggle and category-change cases at `tests/template-catalog.test.js:101` and `:116` keep their incremental-equals-rebuild parity (3.2).
- `patch` and `remove` still leave `sourceRevision` unstamped; only `build` and `stampSource` re-stamp (3.3).
- `byId` and `sectionIds` still hold **references and ids**, never clones, and `categories(section)` still returns `["All","Favorites",…discovery order]` with no duplicates (3.4).
- `patchUITemplate` still calls `li.patchEntry(folderPath, patchObj)` then `saveLibraryIndex()`, still calls `TemplateCatalog.patch(mutated, before)`, still calls `markTemplatesDirty()` (S5), and still chooses between `filterAndRender` and `patchTemplateCard` by the existing `recordChangedView` test including its `structural` and `currentCategory === "Favorites"` clauses and its `buildCategoryTabs` / `buildCategoryPanel` calls (3.5).
- `removeUITemplate` still calls `li.removeEntry(folderPath)` and `saveLibraryIndex()` exactly once, still calls `TemplateCatalog.remove(removed)` (S4) and `markTemplatesDirty()`, and still ends in `filterAndRender()` (3.6).
- `_getTemplateFolderPath` is **not edited** — its signature, its media early return and its non-media reconstruction are untouched, so the prior spec's `P1` (2000 generated non-media records, byte equality) holds by construction. `patchEntry` still pins `merged.folderPath = key` (3.7).
- The index still rolls back on a rejected mutation, records `lastError` and raises `needsFullScan`; the fixed helpers still leave `needsFullScan()` false on every successful media and non-media mutation (3.8).
- A wholesale rewrite performed outside `templates.js` is still caught by the shape probes with no counter involvement, and a sequence of renders with no intervening mutation still builds at most once (3.9).
- The import payload for a card in the active section is byte-identical: same `rootPath`, same `templates[0].{id,name,category,section,sourcePath,folderPath}`. In particular `id` stays the **name** and `rootPath` / `sourcePath` stay `getTemplateSourcePath(name, cat)` (3.10).
- Exactly one `importBatch` bridge call through `callHost` with `{ timeoutMs: 120000 }`, the engine backstop at `130000`, `.importing` added on start and removed on settle, and a timeout surfaced as an error toast naming that After Effects did not respond (3.11).
- The success toast still branches on the same `section` local it branches on today, and produces the same "Applied to text" / "Composition imported" / "Imported successfully" outcomes for every card in the active section (3.12). See [D4](#d4--bug-cs-derivation-order-and-the-toast).
- A card object with no `id` and no `getAttribute` still completes the import without throwing (3.13).
- miniDom still applies single left-to-right attribute-entity decoding, so a record id containing entity-like text survives escape-then-parse unchanged (3.14).
- Every existing miniDom surface behaves identically, including single-selector `querySelector` / `querySelectorAll`, `getElementById`, `innerHTML` get and set, and the `textContent` **getter**'s concatenation semantics (3.15).
- The three suites that extend the helper keep working: `startup-reconcile.property` installs an `outerHTML` accessor and a live `innerHTML` getter, `startup-warm-paint.property` installs `insertAdjacentHTML` per element, `startup-lifecycle.property` reuses the `innerHTML` descriptor (3.16).
- The model-and-index halves of `refreshCardThumbnail` and `markCardFailed` are **not touched**: `refreshCardThumbnail` still patches the index with `{ thumbStatus: "ready", thumbnailPath: <raw> }`, writes three fields, and calls `TemplateCatalog.patch` with **no** `markTemplatesDirty()`; `markCardFailed` still patches `{ thumbStatus: "failed" }`, writes `thumbStatus`, and calls `markTemplatesDirty()` (S6) with **no** catalog mirror (3.17).
- ES5-safe `js/**`; `templateCatalog.js` stays ES5 (3.19). `tests/media-cep-compatibility.test.js` green, including its raw-text `/\.jsx\b/` guard (3.20, 3.21). Comp-pipeline 22/22 and 47/47 (3.22). `E3` stays red with its `DIAGNOSTIC` label and `P2c` stays green (3.23). The full-suite baseline of 10 failed suites / 98 failed tests and 110 passed suites / 1383 passed tests holds, with movement only from the cases items 1-8 authorize and the tests this spec adds (3.24).

**Scope.** Inputs where `isBugCondition` is false are untouched:

- `TemplateCatalog.patch` for a genuinely new record, for an unchanged id, or for a `null` id.
- `TemplateCatalog.remove`, `build`, `idsFor`, `categories`, `sectionCounts`, `get`, `size`, `clear`, `stampSource`, `sourceStamp`.
- Both UI mutation helpers in the **cloned** shape, where the pre-resolved record and the array slot are the same object throughout.
- Every import of a card whose record is in the active section.
- Every miniDom consumer that uses a single selector, does not touch `dataset` / `classList` / `style`, and only reads `textContent`.
- `js/core/persistence.js`, `js/core/keyedMediaCardHelper.js`, `js/core/fastMediaEngine.js`, `VirtualGrid`, and everything under `jsx/`.

## Hypothesized Root Cause

Each item was read against source before being written here.

1. **A single test doing two jobs (BUG A).** `patch`'s guard is `if (id === null || byId[id] === undefined)` (`templateCatalog.js:172-176`). `byId[id] === undefined` is being used to mean "this record is new", but it only means "this *id* is not indexed". The two coincide for every caller that does not move an id, and exactly one caller does. The record was mutated in place, so `byId[oldId]` still points at the very same object — which is why `rebuildSectionCategories` resolves both ids to one record and counts it twice (`:157`, `:159`, `:164`, `:165`), and why a later `remove` (`:206`) computes only the new id and leaves the old key and the old `sectionIds` entry alive. The category *list* escapes because `catOrder` dedupes by name (`:155`).

2. **A mutation ordered before the scan that identifies its own target (BUG B).** `patchUITemplate` calls `li.patchEntry(folderPath, patchObj)` at `:2239`, then scans for `name` + `category` + `section` at `:2243-2244`. `patchEntry` (`persistence.js:428-452`) replaces the element with a merged clone carrying the new values, so in the shared shape the scan is searching for a value the call it just made has already overwritten. `removeUITemplate` has the same shape at `:2223`: `removeEntry` splices at `persistence.js:463` before the scan. Because the mirror, the `before` snapshot and S4/S5 all live **inside the loop body**, a missed match silently skips all three — and an extra `markTemplatesDirty()` cannot reach it, because the call would sit in the branch that never executes.

3. **A second-order consequence of the same ordering (BUG B, 1.9).** Even when the scan matches — the favourite toggle — `before` is read from `allTemplates[i]`, which in the shared shape is the clone `patchEntry` already merged the new value into. So `before` is not a *before*. `TemplateCatalog.patch`'s only favourites adjustment is the `p.favorite !== t.favorite` delta at `:183-187`, and a favourite toggle is not `structural`, so `rebuildSectionCategories` — the only other writer of `counts[section].favorites` (`:164`) — does not run either.

4. **One function deriving two fields of one record by two rules (BUG C).** `importCurrentCardToTimeline` reads `name`, `cat` and `folderPath` from the card, derives `rootPath` and `sourcePath` from `getTemplateSourcePath(name, cat)` — a section-agnostic `allTemplates` match (`:2138-2151`) — and then takes `section` from `currentSection` (`:2542`). The card carries a `tpl-<record id>` element id (`:818`, `:823-829`) and a `data-folder` whose third segment from the end is the section, so the section was recoverable all along; nothing read it. The invariant that makes the current derivation correct is a coincidence of the UI (one grid visible at a time, `filterAndRender` repainting on every switch, `resolveSectionGridId` collapsing several sections onto one grid so those switches repaint), not a contract.

5. **A selector the helper's matcher cannot parse (BUG D).** `matchesSelector` (`tests/helpers/miniDom.js`) branches on the first character and then compares the **whole remainder** of the string against the element's class tokens, so `".card, .icon-card"` is treated as one class name `card, .icon-card`. Zero matches, no throw, and the four pieces of shipped UI behaviour behind the loop have never executed under a test. The four things that *would* throw once the body is reached — `dataset`, `classList`, `style`, the `textContent` setter — are absences in the helper's surface, not defects in the production code; hypothesis 5 therefore has two halves, and only the first explains the silence.

## Design Decisions

### D1 — BUG A's discriminator

The question `patch` has to answer is not "is this id indexed?" but **"has the catalog already indexed this record under a different id?"** Four mechanisms can answer it.

| # | Mechanism | Cost | Covers the in-place re-key (cloned shape) | Covers the object-replaced re-key (shared shape) | Needs caller cooperation | New state to maintain |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `previous.id` — the caller's pre-patch id | O(1) | yes | **yes** | yes | none |
| 2 | identity scan over `byId` for `byId[k] === t` | O(N) | **yes** | no | no | none |
| 3 | reverse map object → indexed id | O(1) | yes | no | no | 6 write sites |
| 4 | non-enumerable marker property stamped on the record | O(1) | yes | no | no | foreign-object mutation |

**Chosen: 1 with 2 as the fallback, in that order.** Not belt-and-braces — each route covers a shape the other structurally cannot, and both shapes occur in production:

- In the **cloned** shape `patchUITemplate` mutates the record in place, so the object the catalog holds *is* the object being patched. Route 2 answers with no caller cooperation at all.
- In the **shared** shape `li.patchEntry` has already replaced the array element, so `patch` is handed `M` while the catalog holds `R`. Route 2 returns `null` — the catalog has genuinely never seen `M` — and only the caller can assert that `M` and `byId[oldId]` are one record. Route 1 is the only route that works here, and it is the shape every reopened panel is in.

Route 2's cost is acceptable and bounded: it runs **only** on the `byId[id] === undefined` branch, which is one user-initiated rename or one `renderOptimisticCard` insert. `size()` already performs a `for…in` over `byId` on every `catalogSourceChanged()` call, which is a far hotter path, so this adds no new order of cost to the module.

**Rejected.**

- *Route 1 alone.* A future caller that mutates an id in place and passes no `previous` silently reproduces BUG A in full. Route 2 closes that hole for six lines.
- *Route 2 alone.* Does not fix the shared-shape rename — the path the bug report describes — so the fix would only ever engage in the cloned shape, and clause 2.1 would hold in one aliasing mode out of two.
- *Route 3 (reverse map).* Needs `WeakMap` (an ES6 built-in) in a module whose header declares it dependency-free ES5, or a plain object keyed by a synthetic handle, which is route 4 by another name. It must be maintained by `build`, `clear`, `patch`, `remove`, `addToLists` and `removeFromLists` — six write sites for one read site, each a place to forget — and it still cannot see through an object replacement, so route 1 would be needed anyway. O(1) on a once-per-rename path is not worth that.
- *Route 4 (marker property).* Non-enumerable, so `_snapshotEntries`' `for…in`, `normalizeLibraryEntry` and `JSON.stringify` would all skip it and it would not leak into the persisted index. But it mutates records the catalog explicitly does not own, and any shallow `for…in` clone — `_publishDurable` makes them by the arrayful — silently loses it, making it no more reliable than route 2 at the cost of a foreign-object write.

**No false positives.** Route 2 can only match when some `byId[k] === t` while `recordId(t) !== k`, which *is* a re-key by definition. A brand-new record that happens to carry the same *field values* as an indexed one is a different object, so it is added — and that case is asserted (case A7 below), because it is the only way the identity scan could be got wrong.

**Ordering dependency: KEPT, and stated explicitly.** Route 1 requires `previous.id` to be the record's **pre-patch** id, and `patchUITemplate` can only supply that once BUG B's ordering is fixed. Clause 2.8's A-after-B dependency therefore **does not disappear**. Route 2 narrows what breaks if the order is violated — the cloned shape is still repaired — but the shared-shape rename, which is the user-visible defect, needs B. See [D6](#d6--implementation-order).

**Deliberate non-change: `recordId(t) === null`.** The existing guard sends a `null` id straight to `addToLists`, which registers it under the string key `"null"`. A record whose id has become `null` while indexed under a real id would still leak. No caller produces it, `null` ids are a pathology rather than a rename, and routing them through the re-key path would change the add behaviour clause 3.1 protects. Left exactly as it is, recorded here so it is a decision rather than an oversight.

### D2 — BUG A's retirement semantics

**Chosen: in-place key swap in `sectionIds` at the existing index; every derived structure recomputed by the existing `rebuildSectionCategories`.**

```
sectionIds[section][at] = newId          // `at` is the old id's index — position preserved
delete byId[oldId];      byId[newId] = t
delete searchHay[oldId]; searchHay[newId] = hayFor(t)
rebuildSectionCategories(section)
```

Why the swap and not remove-then-insert-at-index. Both preserve position, but `sectionIds[section].splice(at, 1)` followed by `splice(at, 0, newId)` is two array rewrites to express one substitution, and it leaves a window in which the section's length is wrong — irrelevant today because nothing observes it mid-call, which is exactly the kind of "irrelevant today" this spec exists to remove. The swap is one assignment and cannot get the position wrong.

Why `rebuildSectionCategories` rather than hand-patching `sectionCatIds` / `sectionCats` / `counts`. Because it is already the function that derives all four from `sectionIds` order, and after the swap `sectionIds` is exactly what a full `build` over the same records would produce — same length, same order, the record's own new id at the record's own position. So `rebuildSectionCategories` reproduces a full build's `sectionCatIds`, its first-discovery `catOrder`, its `counts.cats`, its `counts.favorites` (assigned, `:164`) and its `counts.all = ids.length` (`:165`). Hand-patching would need to know whether the category *also* moved, whether the favourite flag moved, and whether the old id's category bucket had emptied — three conditions the rebuild answers for free. `patch` already documents this reasoning for its same-id structural path ("the id keeps its position in `sectionIds`, so recomputing category lists from that order reproduces exactly what a full rebuild's discovery order would be"); the re-key path is the same argument with one substitution first.

This also means the favourite delta at `:183-187` is not needed on the re-key path and is not reached: `rebuildSectionCategories` **assigns** `counts.favorites`, so a delta applied first would be overwritten and a delta not applied costs nothing.

**`searchHay` handling.** `delete searchHay[oldId]` then `searchHay[newId] = hayFor(t)`. Both halves are load-bearing and neither is optional:

- The delete is what makes `idsFor(section, "All", oldName)` stop returning the record. Without it the old id's haystack survives, `byId` no longer resolves it, and `idsFor`'s filter (`searchHay[out[j]]`) would silently never see it — but only because the old id is also gone from `sectionIds`. Relying on that would make search correctness depend on list membership. Deleted explicitly.
- The re-stamp is not a copy: `hayFor(t)` is recomputed from the record's *current* name, category, type, section and dim, so a rename is findable under its new name immediately (2.2).

**Cross-section re-key.** The old id may sit in a different section's bucket than `sectionOf(t)` — 1.4's latent variant, with no production caller today. Handled: the old id is spliced out of the bucket that holds it, the new id is pushed into the new section's bucket (creating it via `sectionBuckets` if needed), and **both** sections are rebuilt. The bucket that holds the old id is found by scanning `sectionIds`, not by trusting `previous.section`, so the answer is right even for a caller that passes a stale or absent snapshot.

**No new exports.** The two helpers stay private. The tests assert through the public surface (`size`, `idsFor`, `categories`, `sectionCounts`, `get`) against a full rebuild over the same records, which is what clause 2.1 actually requires; a unit test on a private helper would pin an implementation detail instead.

### D3 — BUG B's ordering shape, and the clone replacement

Clause 2.5 permits two shapes. They are not symmetric, and the two helpers legitimately take different ones.

**`patchUITemplate`: resolve first, then address the mutation target by the pre-resolved index.**

Match-by-identity is not merely worse here, it does not work. To have an identity to match on you must already have resolved the record — so "match by identity" is really "resolve first, then re-find by identity", and in the shared shape `allTemplates.indexOf(target)` after `patchEntry` returns the slot only because `patchEntry` preserves indices; the *object* at that slot is `M`, not `target`. A literal identity re-find would therefore still miss, in the same shape and for the same reason as today. Resolve-first is the shape that works.

Resolve-first also gives clause 2.7 for free. `before` is read off the resolved record **before** `li.patchEntry` runs, so `before.category`, `before.favorite` and `before.section` are genuinely pre-patch and `TemplateCatalog.patch`'s `p.favorite !== t.favorite` test sees a real transition. It additionally makes `before.id` available and trustworthy, which is [D1](#d1--bug-as-discriminator)'s route 1. Match-by-identity gives none of that.

**`removeUITemplate`: resolve first, then match by object identity.**

`removeEntry` splices, so the pre-resolved *index* is invalid the moment it returns and only the *reference* survives. `allTemplates.indexOf(removed)` after the call is then exactly the right question, and `-1` is exactly the right answer: in the shared shape `removeEntry` already spliced this object out, so there is nothing left to splice. Re-scanning by `name` + `category` would risk splicing a second same-named record; splicing unconditionally would corrupt the length. Identity is the only rule that is correct in both shapes.

So: same resolve-first prologue, different epilogue, because `patchEntry` preserves indices and `removeEntry` does not.

**The clone replacement, and the divergence it would otherwise create.**

`persistence.js:450` does `self._entries[idx] = merged`. In the shared shape that replaces the model element, so after `patchEntry` there are two objects: `R` (pre-resolved, indexed by the catalog) and `M` (in the array slot, carrying the merged fields and the pinned `folderPath`). Mutating `R` — the obvious reading of "resolve the record first" — would leave the catalog pointing at an object the array no longer contains: a **new** divergence, and one that outlives the call.

**Chosen: mutate the array slot, not the pre-resolved reference. The pre-resolved record is used only for the `before` snapshot.**

```js
var target = _findUITemplateRecord(name, cat);      // pre-patch: the before snapshot
var slot   = target ? allTemplates.indexOf(target) : -1;
// … li.patchEntry(folderPath, patchObj); saveLibraryIndex();
var rec = (slot !== -1 && allTemplates[slot]) ? allTemplates[slot] : target;   // the mutation target
```

`rec` is `M` in the shared shape and `target` in the cloned shape. In both, `rec` is the object the model array holds, the object `li._entries` holds, and — because the mirror is `TemplateCatalog.patch(rec, before)` — the object `byId` ends up holding. The entry-identity rule is restored for the patched entry, and the catalog is exact with no rebuild required. `before` is still pre-patch because it was read off `target` before `patchEntry` ran; that split of roles between the reference and the index is the whole trick.

`slot` is stable across `patchEntry` by construction: `patchEntry` assigns `_entries[idx]` and never splices, so length and order are preserved; and in the cloned shape `allTemplates` is not touched at all. Verified against `persistence.js:428-452`.

**`js/core/persistence.js` is not modified.** Three alternatives were considered and rejected:

- *Mutate `current` in place instead of replacing it (`patchEntry`).* Breaks `_mutate`'s transactional guarantee: the rollback restores `this._entries` from an array of fresh copies, so an in-place mutation on a shared record object would leave the record's fields merged even though the entry list was rolled back. It also flips `F4-S5-aliasing-rename-edges`' element-identity probes to `false`, removing a detection mechanism clause 3.9 requires to keep working. And it edits a whole-file CEP-scanned unit (3.20).
- *Fold `M`'s fields back onto `R` and restore `R` into the slot.* Correct, and it would let route 2 alone discriminate the re-key, but it is strictly more code than mutating the slot, it flips the same element-identity probes, and "become the clone" needs a key-deletion pass to be faithful to `patchEntry`'s `undefined`-deletes-key semantics. Mutating the slot achieves the same invariant by keeping the object `patchEntry` produced.
- *Have the catalog adopt `M` under the old id before patching.* Needs new `TemplateCatalog` API for an operation route 1 already expresses through `previous.id`.

**Two consequences of keeping the clone, recorded rather than worked around.**

1. `patchObj` values of `undefined` behave differently in the two views: `patchEntry` deletes the key from `merged`, while the in-memory loop assigns `undefined`. Under the shared shape those are the same object, so the delete wins and then the assignment re-adds the key with value `undefined`. `JSON.stringify` (via `serialize`) and `normalizeLibraryEntry` both drop `undefined` values, so nothing persists differently, and no production caller passes `undefined` — the three shapes are `{favorite}`, `{name,id}` and `{category}`. Pre-existing, unchanged by this fix, named so it is not mistaken for a regression.
2. The `folderPath` pin. In the shared shape the in-memory loop writes `patchObj`'s fields onto the very object `patchEntry` pinned, so a caller that puts `folderPath` in `patchObj` moves the entry away from its key. That is today's behaviour and it stays today's behaviour — but after the fix it holds for the rename and move shapes too, not only for the shapes whose scan happened to match. `F2-pin` currently records this in prose; see item 4 of [Tests That Pin Current Behaviour](#tests-that-pin-current-behaviour-and-need-attention), which promotes it to an assertion.

**`_getTemplateFolderPath` is not edited, and its signature does not change.** Both helpers will now call `_findUITemplateRecord` twice — once inside `_getTemplateFolderPath`, once for `target` — because both calls happen before any index call and against the same array, so they return the same object (the invariant `_findUITemplateRecord`'s own comment states). Adding an optional record parameter to skip the second scan was considered and rejected: it would put a new argument on the function the prior spec's `P1` pins over 2000 generated records, to save one O(N) scan per user-initiated rename, move or favourite toggle. Not worth it.

**S4 and S5 are relocated, not added or removed.** Both `markTemplatesDirty()` calls move from inside the deleted scan loop to the resolved-record branch. Their guard changes from "the scan matched" to "a record was resolved" — which is the entire point — and their count stays exactly one per operation, so the prior spec's `expectedMarks: 1` for both sites is unchanged. No other S-site moves.

### D4 — BUG C's derivation order, and the toast

**Chosen: clause 2.10's order, unchanged, with all four routes implemented.**

| # | Route | Why it sits here | Guard |
| --- | --- | --- | --- |
| 1 | `card.id` → strip `"tpl-"` → `TemplateCatalog.get(id).section` | The only **exact** route: it identifies the record rather than matching one, so it is right even when two sections hold a card with the same name and category. O(1). The id round-trips through escape-then-parse unchanged (`escapeTemplateCardAttribute` escapes `&` first), which `tests/single-card-patch-job-completion.property.test.js` already pins. | `typeof card.id === "string"`, prefix check, `typeof TemplateCatalog !== "undefined"`, record found, `record.section` truthy |
| 2 | section-agnostic `allTemplates` match on `name` + `category` | The rule `getTemplateSourcePath` already applies to the same card in the same payload, so where routes 1 and 2 agree the payload stops deriving two fields by two rules — 1.10's actual complaint. Where they disagree, route 1 is right, which is why it is first. | record found, `record.section` truthy |
| 3 | third-from-last segment of `card.dataset.folder` | The only route that needs **no model state**, so it is the one that still answers when the DOM and `allTemplates` have diverged — precisely the condition 1.13 says makes the current derivation unsafe. `mediaRootFromFolderPath` already strips exactly these three segments, so the shape is established. | ≥ 4 segments after normalising separators and trailing slashes, and the segment must be an own key of `SECTION_SCAN_FOLDERS` |
| 4 | `currentSection` | Today's behaviour. Reached only when nothing else answered, so no card that works now stops working (2.12). | — |

Routes 1 and 2 read `record.section` directly rather than `getTemplateSection(record)`. Deliberate: `getTemplateSection` falls back to `t.type`, which for a media record is `"media"` — not a section. The single normalisation happens once at the end, on the derived string.

**Why all four rather than a subset.** Each route's guard is 1-2 conditions and the whole chain is ~20 lines in one helper, so the marginal cost is small; and dropping any one loses a distinct class:

- Drop 1 and the derivation becomes a name+category match, which is ambiguous across sections — the thing route 1 exists to avoid.
- Drop 2 and a card whose element id no longer resolves (a stale node, a catalog rebuilt without it) skips straight past the model even though the model has the answer.
- Drop 3 and a card with no resolvable id and no matching record falls to `currentSection` — the exact latent failure 1.13 describes — and `makeCardFake()` loses its answer.
- Drop 4 and clause 2.12 is violated.

**`SECTION_SCAN_FOLDERS` is the validity set for route 3.** Its keys are exactly the nine canonical sections (`comp`, `layer`, `text`, `text_props`, `footage`, `effect`, `icon`, `overlay`, `element`), it lives in the same file, and it is already the map the file uses to decide whether a section is one it knows. No new table.

**Normalisation (2.11).** The derived string replaces `currentSection` in the existing `section` local, and `normSection` keeps being computed as `getTemplateSection({ section: section })` from that local. So the value `csDispatchImport` switches on goes through the identical normalisation it goes through today. `normalizeSectionName` is the identity on every `SECTIONS.*` value (its three remappings are the legacy spellings `transition`, `png`, `textprops` / `text-properties` / `text_properties`), so for every card in the active section the payload's `section` is byte-identical (3.10).

**The success toast reads the DERIVED section (3.12).** It already branches on the `section` local, and the fix reassigns that local — so **no line in the toast block changes** and the branch still reads "the same value it branches on today". The reason to want the derived value: the toast tells the user what happened, and what happened is decided by the routine the host selected from the section. A toast reading "Composition imported" after an image was routed to the image importer would be a lie, and it would be a lie in exactly the case the fix exists to make possible. For every card in the active section the derived value equals `currentSection`, so the three existing outcomes are unchanged.

**Two consumers ride along, both correctly.** `resolveCached` reconstructs `folderPath` from `template.section` when the card supplied none (`:2581-2590`) and now gets the derived value, closing 1.13's metadata-cache miss. `template.folderPath` still takes `card.dataset.folder` first, so nothing changes for a card that supplied one.

**Not reused: the record found by route 1 or 2 is not fed to `rootPath` / `sourcePath`.** Those stay `getTemplateSourcePath(name, cat)`. Clause 3.10 pins the payload byte-for-byte, and rewiring two more fields would risk it for no requirement. Where route 1's record and `getTemplateSourcePath`'s record differ, the residual inconsistency is inside `getTemplateSourcePath` and is out of scope — recorded here so it is not rediscovered as a new defect.

**No new `data-*` attribute** (2.10). None is needed; the section is recoverable three ways.

**Comment placement (3.21).** The new helper and the edited lines sit outside both `tests/media-cep-compatibility.test.js` region-scanned bodies (`escapeTemplateCardAttribute`, `renderTemplateCardMarkup`), so the raw-text `/\.jsx\b/` guard does not reach them. The comments nevertheless describe the host **by role** — "the host selects the import routine by this value" — and name no ExtendScript file, so the text stays safe if a future refactor moves it.

### D5 — BUG D's helper additions

**Chosen: extend the shared `tests/helpers/miniDom.js`.** `bugfix.md` measured a probe implementation of all five additions at zero movement across the 15 consuming suites (1 failed / 171 passed / 172 total, identical) and across the full suite (the exact stated baseline). A scoped fake would leave the shared helper unable to express the selector the production code actually uses, and would have to be duplicated by the next suite that needs it. Clause 2.15 makes the measured baseline the acceptance criterion: if the real implementation moves any count, that is an implementation defect, not a reason to fall back.

**1 — comma-separated selector lists (2.13).** The split lands in `querySelectorAll` only; `collect` is changed to take an **array** of selectors and `matchesSelector` is not touched at all.

- One traversal, matching any selector in the list, so results stay in **document order** with **no duplicates** — an element matching both `.card` and `.icon-card` appears once. Running `collect` per selector and concatenating would produce neither, and `querySelectorAll(".card, .icon-card").length` is exactly the kind of thing a new test will assert.
- `document.getElementById` keeps calling `collect` directly, now with a **one-element array** `["#" + id]`. This is load-bearing: ids in this codebase are `"tpl-" + <record id>` and the property suites generate hostile record ids, so splitting an id on commas would be a real regression. Routing the split through `querySelectorAll` alone makes that structurally impossible.
- Single-selector behaviour is unchanged by construction: a selector with no comma yields a one-element list and reaches the same untouched `matchesSelector` (3.15).

**2 — `dataset` (2.14).** A lazily created, per-element **`Proxy`** over the element's `data-*` attributes, cached on the element and read through on every access so it can never go stale after a `setAttribute`.

- Traps: `get`, `set`, `has`, `deleteProperty`, `ownKeys`, `getOwnPropertyDescriptor`. The last two are required together — a `Proxy` reporting `ownKeys` without matching descriptors throws on `Object.keys` — and they make `for…in` over `dataset` work.
- Key mapping is the standard one: `dataset.folder` ↔ `data-folder`, `dataset.mediaType` ↔ `data-media-type`. Note the card markup emits `data-mediatype` all-lowercase, so it reads as `dataset.mediatype`; that is the DOM's own rule, not a helper quirk.
- `get` and `has` return early for non-string keys. Without that, a symbol probe — Jest's printer and `util.inspect` both make several — would reach `String(symbol)` and throw.
- Why a `Proxy` and not accessor properties defined per key at parse time: a write to a key with no `data-*` attribute yet (`c.dataset.thumb = url` on an element built by `createElement`, or `btn.dataset.cat = cat` in `buildCategoryTabs`) would silently become a plain own property and never reach an attribute. `tests/**` is outside clause 3.19's ES5 constraint, which scopes to `js/**`.

**3 — `classList` (2.14).** A fresh object per access, backed by `className`, with `add`, `remove`, `toggle` and `contains`.

- `add` and `remove` are variadic like the real DOM; `toggle` takes the optional `force` argument and returns the resulting state (`header.js` and `modals.js` both use `toggle(name, cond)`).
- Token order is preserved and duplicates are never introduced. A write rewrites `class` as `tokens.join(" ")`, which normalises whitespace — but only on a write, so a read-only `contains` leaves `className` byte-identical (3.15).
- Fresh per access rather than cached, so it cannot go stale after a `className` reassignment. It is only ever used transiently (`card.classList.add("importing")`), so there is nothing to gain from caching.
- Scope: the four methods clause 2.14 names. No `length`, no index access, no `replace` — nothing in `js/**` uses them.

**4 — `style` (2.14).** A lazily created plain object, cached on the element, so writes are observable. Deliberately **not** a CSS parser and **not** reflected into or out of the `style` attribute: nothing in `js/**` reads `getAttribute("style")`, and `badge.style.cssText = "…"` only needs to be readable back. Documented as a limitation in the helper so a future test does not assume otherwise.

**5 — `textContent` setter (2.14).** Added **at the original `Object.defineProperty` call**, because the existing descriptor is non-configurable and cannot be redefined from outside. The setter detaches all children, appends a single `MiniText` for a non-empty value, and appends nothing for `""` / `null` / `undefined`. It also updates the cached `_innerHTML` to the entity-escaped text so the `innerHTML` getter stays consistent with the children. The getter's concatenation semantics are untouched (3.15), and the descriptor stays non-configurable — making it configurable would be an unrequested behaviour change, and the three suites that extend the helper redefine `innerHTML` / `outerHTML` / `insertAdjacentHTML`, never `textContent` (3.16).

**Reachability side effect, named rather than discovered.** Two of these additions make production code paths reachable that previously threw. `buildCategoryTabs` (`btn.dataset.cat = cat`, `btn.textContent = label`) and `buildCategoryPanel` (`item.dataset.cat = cat`) now run to completion under miniDom instead of throwing, and `updateCategoryCountsOnly` can now read those rows back. `bugfix.md`'s probe measured the full suite unmoved, so no current assertion depends on the throw — but a reviewer seeing new code execute in an old suite should find this paragraph rather than a surprise.

**Not needed.** `title` is left as a plain property: `badge.title = "…"` assigns and reads back fine, so a test must assert `badge.title` rather than `getAttribute("title")`. `badge.setAttribute("aria-label", …)` is a real attribute already. Adding a reflected `title` accessor would be a sixth addition clause 2.14 does not ask for.

### D6 — Implementation order

**Order: BUG D → BUG B → BUG A → BUG C.**

| Edge | Reason |
| --- | --- |
| **D first** | Independent of all three code fixes and confined to `tests/helpers/miniDom.js`. Landing it alone lets clause 2.15's measured baseline be re-confirmed against a change set that contains nothing else, so if a count moves it is unambiguously the helper. Every later suite that needs a parsed card inherits a helper already known good. |
| **D → C** | A *test* dependency, not a code one. BUG C's derivation is best proved against a card produced by the real `renderTemplateCardMarkup` and parsed by miniDom — which requires `dataset`. Without D, C's tests would have to hand-roll card objects and would no longer prove the `tpl-<id>` escape-then-parse round trip. |
| **B → A** | Clause 2.8. BUG A's primary discriminator is `previous.id`, and `patchUITemplate` can only supply a pre-patch `before` once the ordering is fixed. The `before.id` addition ships **with B**, as part of B's own edit to the `before` literal, so A arrives with its discriminator already in place. |
| **not A → B** | Landing A first is safe but pointless: in the shared shape the mirror is never called, so A's fix would be unreachable on the path the bug report describes and only the cloned shape would be repaired. |
| **B alone is a temporary regression, bounded** | Between B and A, the shared-shape rename reaches `TemplateCatalog.patch(M, before)`; `byId[before.id]` exists, but with A absent the `byId[id] === undefined` guard still takes the add branch, so the duplication fires — masked by S5's `markTemplatesDirty()` and the trailing `filterAndRender()`, exactly as it is masked today. No worse than the current behaviour, and it is why B and A should land as one reviewable pair. |
| **C last** | Independent. It touches a function none of the others touch and its only constraint (3.21's comment placement) is local. |

**Parallelisable groups:** `{D}`, `{B → A}`, `{C}` — with the caveat that C's *tests* want D landed first. B and A can be developed against `templates.js` and `templateCatalog.js` respectively with no textual overlap; only their combined behaviour is ordered.

## Correctness Properties

Property 1: Bug Condition — A re-keyed record stays one record

_For any_ `TemplateCatalog.patch(t, previous)` where the bug condition holds — `recordId(t)` is absent from `byId` and the catalog already indexes that record under a different id, by either the caller's pre-patch id or object identity — the fixed catalog SHALL retire the old `byId` key, the old `sectionIds` entry and the old `searchHay` entry, and SHALL leave `size()`, `idsFor(section, category)`, `idsFor(section, "All", query)`, `categories(section)` and `sectionCounts(section)` identical to what a full `build` over the same records produces; the new id SHALL occupy the old id's **position** in `sectionIds[section]`; `idsFor(section, "All", oldName)` SHALL no longer return the record and `idsFor(section, "All", newName)` SHALL; and a subsequent `remove` SHALL leave no surviving `byId` key, no surviving `sectionIds` entry and `counts[section].all` equal to the number of records that remain.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — The add path and the catalog's contracts are unmoved

_For any_ `TemplateCatalog.patch(t)` where the bug condition does not hold, the fixed catalog SHALL behave identically to the original: a record the catalog has never indexed is **added** via `addToLists` plus `rebuildSectionCategories` — including a fresh record that duplicates an indexed record's field values but is a different object, and a record whose `recordId` is `null`; an unchanged id takes the existing incremental path with the same observable result as a full rebuild for a favourite toggle and for a category change; `patch` and `remove` still leave `sourceRevision` unstamped; `byId` and `sectionIds` still hold references and ids rather than clones; and `categories(section)` still returns `["All","Favorites",…discovery order]` with no duplicates.

**Validates: Requirements 2.4, 3.1, 3.2, 3.3, 3.4**

Property 3: Bug Condition — The UI mutation helpers reach their mirror in both aliasing shapes

_For any_ `patchUITemplate` or `removeUITemplate` call where the bug condition holds — `allTemplates` is the index's own entry array and the operation rewrites the element the match rule keys on — the fixed helper SHALL resolve the record before any index call, SHALL call its `TemplateCatalog` mirror exactly once and `markTemplatesDirty()` exactly once, SHALL leave `catalogSourceChanged()` true at the instant of that mark, and SHALL leave the catalog, after the operation and before any rebuild, in the state a full `build` over the resulting `allTemplates` would produce — so `TemplateCatalog.get(newId)` resolves to the mutated record, `get(oldId)` resolves to nothing, and `TemplateCatalog.size()` is unchanged by a rename. `patchUITemplate`'s `before` snapshot SHALL carry the record's pre-patch `id`, `category`, `favorite` and `section`, so a favourite toggle adjusts `counts[section].favorites` exactly once with no rebuild.

**Validates: Requirements 2.5, 2.6, 2.7**

Property 4: Preservation — Both helpers keep every call, count and render decision

_For any_ `patchUITemplate` or `removeUITemplate` call where the bug condition does not hold — the cloned shape, or a patch that does not move the match key — the fixed helper SHALL produce the same result as the original: `li.patchEntry` / `li.removeEntry` followed by exactly one `saveLibraryIndex()`; exactly one `TemplateCatalog.patch(mutated, before)` / `TemplateCatalog.remove(removed)`; exactly one `markTemplatesDirty()`; the same `recordChangedView` decision between `filterAndRender` and `patchTemplateCard`, including its `structural` and `currentCategory === "Favorites"` clauses and its `buildCategoryTabs` / `buildCategoryPanel` calls; `allTemplates.length` reduced by exactly one on a removal in **both** shapes; `_getTemplateFolderPath` byte-identical for every media and non-media record; `merged.folderPath` still pinned to the index key; `needsFullScan()` false on every successful mutation and the existing rollback, `lastError` and `needsFullScan` behaviour on a rejected one; and the shape probes still detecting a wholesale rewrite performed outside `templates.js` with no counter involvement.

**Validates: Requirements 3.5, 3.6, 3.7, 3.8, 3.9**

Property 5: Bug Condition — The import section describes the card

_For any_ `importCurrentCardToTimeline(card)` where the bug condition holds — the card's section is recoverable and differs from `currentSection` — the fixed function SHALL send the **card-derived** section, resolved by the first of these routes that answers: the record reached from the card's `tpl-<id>` element id through `TemplateCatalog.get`; a section-agnostic `allTemplates` match on `name` + `category`; the third-from-last segment of `card.dataset.folder` when it names a known section; and SHALL pass it through the same `getTemplateSection` / `normalizeSectionName` normalisation the current code applies to `currentSection`. No new `data-*` attribute SHALL be introduced.

**Validates: Requirements 2.9, 2.10, 2.11**

Property 6: Preservation — Every import that works today is byte-identical

_For any_ `importCurrentCardToTimeline(card)` where the bug condition does not hold — a card whose record is in the active section, or a card that resolves no section at all — the fixed function SHALL produce a byte-identical payload: same `rootPath`, same `templates[0].{id,name,category,section,sourcePath,folderPath}`; SHALL issue exactly one `importBatch` bridge call through the timeout-guarded `callHost` with `{ timeoutMs: 120000 }` and the engine backstop at `130000`; SHALL add `.importing` on start and remove it on settle; SHALL surface a timeout as an error toast naming that After Effects did not respond; SHALL choose the success toast by branching on the same `section` local it branches on today, yielding the unchanged "Applied to text" / "Composition imported" / "Imported successfully" outcomes; and SHALL complete without throwing for a card object carrying no `id` and no `getAttribute`, degrading through the fallback chain to `currentSection`.

**Validates: Requirements 2.12, 3.10, 3.11, 3.12, 3.13**

Property 7: Bug Condition — The DOM patch loops are reached and correct

_For any_ `refreshCardThumbnail` or `markCardFailed` call under a `miniDom` document where the bug condition holds — matching cards exist in the tree — `document.querySelectorAll(".card, .icon-card")` SHALL return those cards in document order with no duplicates, and the loop body SHALL execute against a parsed document without throwing, performing: the in-place `img.src` swap and the `data-thumb` update; the `<img class="thumb-img" src=… alt="" loading="lazy">` insertion into a `.thumb-box` holding no `<img>`; the removal of a pre-existing `.thumb-fail-badge` on success; the `thumb-failed` class removal on success and addition on failure; the construction and insertion of the failure badge with its `title`, its `aria-label` and its `!` text; and the `.icon-card` variant, whose inserted `<img>` carries **no** class. A folder matching no card SHALL leave the DOM untouched and raise nothing.

**Validates: Requirements 2.13, 2.16**

Property 8: Preservation — The shared helper's existing surface and its consumers are unmoved

_For any_ use of `tests/helpers/miniDom.js` that does not exercise a new addition, the extended helper SHALL behave identically to the original: single left-to-right attribute-entity decoding, so a record id containing entity-like text survives escape-then-parse unchanged; identical `createElement`, `createDocumentFragment`, `getElementById` — including for an id containing a comma — `innerHTML` get and set, `children`, `childNodes`, `appendChild`, `removeChild`, `parentNode`, `contains`, single-selector `querySelector` / `querySelectorAll`, `get`/`set`/`has`/`removeAttribute`, the reflected `id` and `className`, the `textContent` **getter**'s concatenation semantics, and the void-element set; and it SHALL keep letting `startup-reconcile.property`, `startup-warm-paint.property` and `startup-lifecycle.property` redefine `innerHTML` / `outerHTML` / `insertAdjacentHTML`. The 15 consuming suites SHALL hold at 1 failed / 171 passed / 172 total. The model-and-index halves of `refreshCardThumbnail` and `markCardFailed` SHALL be unchanged: `{ thumbStatus: "ready", thumbnailPath: <raw> }` plus a direct `TemplateCatalog.patch` and **no** `markTemplatesDirty()` for the former; `{ thumbStatus: "failed" }` plus `markTemplatesDirty()` (S6) and **no** catalog mirror for the latter.

**Validates: Requirements 2.14, 2.15, 3.14, 3.15, 3.16, 3.17**

Property 9: Preservation — Runtime and scan constraints hold

_For any_ file modified by this spec, the source SHALL remain ES5-safe for the older-Chromium CEP runtime — no arrow functions, `let`/`const`, template literals, spread/rest, `class`, `async`/`await`, optional chaining or nullish coalescing — with `js/templates/templateCatalog.js` remaining ES5; no file under `jsx/` SHALL be modified; `js/core/persistence.js` SHALL be unmodified, so `tests/media-cep-compatibility.test.js` SHALL continue to pass including its raw-text `/\.jsx\b/` guard over every whole-file unit and both region-scanned bodies; comp-pipeline SHALL report 22/22 exploration and 47/47 preservation; `tests/media-card-lifecycle-exploration.test.js` SHALL report 1 failed / 9 passed with `E3` red and labelled `DIAGNOSTIC` and `P2c` green; and the full-suite baseline of 10 failed suites / 98 failed tests and 110 passed suites / 1383 passed tests SHALL hold, with movement only from the pre-authorized cases and the tests this spec adds.

**Validates: Requirements 3.18, 3.19, 3.20, 3.21, 3.22, 3.23, 3.24**

## Fix Implementation

Three files. Every edit is specified by anchor text; line numbers are navigation aids only.

### BUG A — `js/templates/templateCatalog.js`

**New helper 1.** Insert immediately after `removeFromLists` (ends at `:105`), before `clear`.

```js
    // The id this record is ALREADY indexed under, when that differs from the id
    // it now carries — i.e. the record was RE-KEYED rather than created. The
    // rename path patches `id`, and byId[id] === undefined alone cannot tell the
    // two apart: it means "this id is not indexed", not "this record is new".
    //
    // Two routes, because each covers a shape the other structurally cannot:
    //   1. the caller's pre-patch snapshot. The only route that works when the
    //      caller also REPLACED the record object — the panel's shared-array
    //      shape, where the library index hands patchUITemplate a merged clone,
    //      so the object arriving here has genuinely never been indexed and only
    //      the caller can assert it is the same record.
    //   2. an identity scan over byId. The only route that works when the caller
    //      passed no snapshot but mutated the record's id in place. O(N), and
    //      reached only on the id-absent branch — one user rename, or one
    //      optimistic insert — so it is the same order as the size() scan
    //      catalogSourceChanged already runs on every render.
    // null for a record the catalog has never indexed, which keeps patch() an
    // ADD. A fresh object carrying an indexed record's field values is a
    // different object, so it is added, not re-keyed.
    function priorIndexedId(t, previous, id) {
        if (previous && previous.id !== undefined && previous.id !== null &&
            previous.id !== id && byId[previous.id] !== undefined) {
            return previous.id;
        }
        for (var k in byId) {
            if (Object.prototype.hasOwnProperty.call(byId, k) && byId[k] === t) return k;
        }
        return null;
    }
```

**New helper 2.** Insert immediately after `priorIndexedId`.

```js
    // Move an already-indexed record from oldId to newId IN PLACE: the id keeps
    // its slot in sectionIds, so a rename does not reorder the grid. Only
    // sectionIds / byId / searchHay are touched; sectionCatIds, sectionCats and
    // counts are derived from sectionIds order by the rebuildSectionCategories
    // the caller runs next, which is exactly how a full build derives them — so
    // a category that moved in the same patch, an emptied category bucket and
    // the favourites count all come out right without a special case.
    // The bucket holding oldId is found by scanning rather than trusting
    // previous.section, so a caller with a stale or absent snapshot is still
    // handled. Returns that section, or null when the id was in none.
    function reindexRecord(t, oldId, newId) {
        var oldSection = null;
        var at = -1;
        for (var s in sectionIds) {
            if (!Object.prototype.hasOwnProperty.call(sectionIds, s)) continue;
            at = sectionIds[s].indexOf(oldId);
            if (at !== -1) { oldSection = s; break; }
        }
        var newSection = sectionOf(t);
        delete byId[oldId];
        delete searchHay[oldId];
        if (oldSection !== null && oldSection === newSection) {
            sectionIds[oldSection][at] = newId;        // position preserved
        } else {
            if (oldSection !== null) sectionIds[oldSection].splice(at, 1);
            sectionBuckets(newSection);
            sectionIds[newSection].push(newId);
        }
        byId[newId] = t;
        searchHay[newId] = hayFor(t);
        return oldSection;
    }
```

**Edit `patch`** (`:170`). One new branch above the existing guard; the guard itself and everything below it are unchanged.

```js
    function patch(t, previous) {
        if (!sectionOf) return;
        var id = recordId(t);

        // ── added ──────────────────────────────────────────────────────────
        // A re-key is one record under a new id, not a new record. Taking the
        // add branch here pushed a SECOND sectionIds entry and registered a
        // SECOND byId key per rename — cumulative — inflated counts.all and
        // counts.cats[cat], left the pre-rename searchHay findable under the old
        // name, and left byId[oldId] alive through a later remove, so a
        // rename-then-delete left a ghost record the grid still rendered.
        if (id !== null && byId[id] === undefined) {
            var oldId = priorIndexedId(t, previous, id);
            if (oldId !== null) {
                var fromSection = reindexRecord(t, oldId, id);
                var toSection = sectionOf(t);
                rebuildSectionCategories(toSection);
                if (fromSection !== null && fromSection !== toSection) {
                    rebuildSectionCategories(fromSection);
                }
                return;
            }
        }
        // ── /added ─────────────────────────────────────────────────────────

        if (id === null || byId[id] === undefined) {
            addToLists(t);
            rebuildSectionCategories(sectionOf(t));
            return;
        }
        // ── unchanged below this line ──
```

No export is added; `_rebuildSectionCategories` stays the module's only underscore export. ES5 throughout: `var`, `function`, `for…in` with a `hasOwnProperty` guard, `indexOf`, `delete`.

### BUG B — `js/templates/templates.js`

**`removeUITemplate`** (`:2219-2233`). Replace in full.

```js
function removeUITemplate(name, cat) {
    var folderPath = _getTemplateFolderPath(name, cat);
    // Resolve BEFORE the index call. In the shared-array shape — allTemplates IS
    // li._entries, which is every reopened panel — li.removeEntry splices the
    // element out of the very array a scan would walk, so a scan run afterwards
    // found nothing and the catalog mirror and the staleness mark below, which
    // used to live inside that scan's loop body, were both skipped.
    var removed = _findUITemplateRecord(name, cat);
    var li = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;
    if (li) { li.removeEntry(folderPath); saveLibraryIndex(); }
    if (removed) {
        // Object identity, not another name + category scan: removeEntry may
        // already have spliced this exact object out of the shared array, and
        // indexOf returning -1 is precisely that signal. Re-scanning by name
        // could splice a second same-named record; splicing unconditionally
        // would corrupt the length.
        var at = allTemplates.indexOf(removed);
        if (at !== -1) allTemplates.splice(at, 1);
        if (typeof TemplateCatalog !== "undefined") TemplateCatalog.remove(removed);
        markTemplatesDirty();          // S4 — relocated out of the removed scan; one call per removal, unchanged
    }
    filterAndRender();
}
```

**`patchUITemplate`** (`:2234-2290`). Replace the head and the loop; everything from `var structural =` onward is unchanged.

```js
function patchUITemplate(name, cat, patchObj, newName, newCat) {
    var folderPath = _getTemplateFolderPath(name, cat);
    // Resolve BEFORE the index call. li.patchEntry REPLACES its array element
    // with a merged clone already carrying the new name / category / id
    // (persistence.js, self._entries[idx] = merged), so in the shared-array
    // shape a scan run afterwards for the OLD name walked straight past it —
    // taking the catalog mirror, the staleness mark and the `before` snapshot
    // with it, all three of which used to live inside that scan's loop body.
    var target = _findUITemplateRecord(name, cat);
    var slot = target ? allTemplates.indexOf(target) : -1;
    // Pre-patch by construction: read off `target` while li.patchEntry has not
    // run yet. `id` lets TemplateCatalog.patch recognise a rename as a re-key
    // rather than an add; `favorite` lets its p.favorite !== t.favorite test see
    // a real transition, so the favourites count is adjusted exactly once — read
    // from the merged clone it saw no transition at all and, a favourite toggle
    // not being structural, nothing else recomputed the count.
    var before = target ? {
        id: target.id,
        category: target.category,
        favorite: target.favorite,
        section: getTemplateSection(target)
    } : null;
    var li = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;
    if (li) {
        li.patchEntry(folderPath, patchObj);
        saveLibraryIndex();
    }
    var mutated = null;
    if (target) {
        // patchEntry assigns _entries[idx] and never splices, so `slot` still
        // addresses this record. Mutate whatever the array HOLDS there — the
        // original under a cloned model, patchEntry's merged clone under the
        // shared alias — so the object the model holds, the object the index
        // holds and the object the catalog indexes stay ONE object. Mutating the
        // pre-resolved reference instead would leave the catalog pointing at an
        // element the array no longer contains.
        var rec = (slot !== -1 && allTemplates[slot]) ? allTemplates[slot] : target;
        for (var key in patchObj) {
            if (patchObj.hasOwnProperty(key)) rec[key] = patchObj[key];
        }
        if (newName !== undefined) rec.name = newName;
        if (newCat !== undefined) rec.category = newCat;
        mutated = rec;
        if (typeof TemplateCatalog !== "undefined") TemplateCatalog.patch(mutated, before);
        markTemplatesDirty();          // S5 — relocated out of the removed scan; one call per patch, unchanged
    }

    var structural = newName !== undefined || newCat !== undefined;
    // ── unchanged below this line ──
```

Two incidental notes on this edit:

- The `var liEntry = null;` / `liEntry = li.patchEntry(…)` pair is dropped. `patchEntry` returns `_mutate`'s **boolean**, and `liEntry` is never read anywhere in the function. Removed as part of restructuring the head rather than left as a dead local.
- If `li.patchEntry` fails, `_mutate` restores `this._entries` to a fresh array of copies, so `allTemplates` is no longer the index's array and `allTemplates[slot]` is still `target`; the mutation and the mirror land on `target` exactly as they do today, and `needsFullScan` is raised as today. No special case needed.

`_getTemplateFolderPath`, `_findUITemplateRecord`, `markTemplatesDirty`, `catalogSourceChanged`, `ensureCatalogFresh` and `js/core/persistence.js` are **not modified**.

### BUG C — `js/templates/templates.js`

**New helper.** Insert immediately after `getTemplateSourcePath` (ends at `:2151`), above the `safeCategorySegment` comment block. Outside both CEP-scanned regions.

```js
// ── The section a CARD belongs to ──────────────────────────────────
// Derived from the card, not from the active section. This value is sent to the
// host, which uses it to select the import ROUTINE — a composition imported as
// flattened layers, or an image as a project file — and only the image and
// footage routines forward the absolute folderPath locator, so a misrouted media
// card also loses the only locator that can resolve its hashed folder segment.
// It therefore has to describe the card rather than whatever grid happens to be
// on screen. Reading currentSection was safe only by coincidence: one grid is
// visible at a time, filterAndRender repaints on every section switch, and
// resolveSectionGridId collapses several sections onto one grid so those
// switches repaint rather than leave stale cards. Nothing enforced it.
//
// Four routes, in preference order, each covering a failure of the one before:
//   1. the stable element id, "tpl-<record id>". Exact — it identifies the
//      record, whose own section field is canonical — and O(1). The id
//      round-trips through escapeTemplateCardAttribute and an attribute parse
//      unchanged, so stripping the prefix yields the record id exactly.
//   2. a section-agnostic name + category scan, which is the rule
//      getTemplateSourcePath already applies to this same card for this same
//      payload's rootPath and sourcePath. Where 1 and 2 agree the payload stops
//      deriving two fields of one record by two different rules.
//   3. the third-from-last segment of data-folder, which the writer builds as
//      <root>/<section>/<safeCategory>/<leaf>. The only route needing no model
//      state, so it still answers when the DOM and allTemplates have diverged.
//   4. currentSection — today's behaviour, so no card that works now changes.
// section is read directly rather than through getTemplateSection because that
// helper falls back to t.type, which for a media record is "media" — not a
// section. Normalization happens once, at the call site, on the result.
// card.id is read as a PROPERTY and getAttribute is never called, so a plain
// object carrying only dataset / style / classList degrades to route 3 or 4
// instead of throwing.
function sectionForCard(card, name, cat) {
    if (!card) return currentSection;

    var domId = card.id;
    if (typeof domId === "string" && domId.indexOf("tpl-") === 0 &&
        typeof TemplateCatalog !== "undefined" && TemplateCatalog.get) {
        var rec = TemplateCatalog.get(domId.substring(4));
        if (rec && rec.section) return rec.section;
    }

    for (var i = 0; i < allTemplates.length; i++) {
        var r = allTemplates[i];
        if (r && r.name === name && r.category === cat && r.section) return r.section;
    }

    var folder = ("" + ((card.dataset && card.dataset.folder) || ""))
        .replace(/\\/g, "/").replace(/\/+$/, "");
    if (folder) {
        var parts = folder.split("/");
        if (parts.length >= 4) {
            var seg = parts[parts.length - 3];
            if (seg && Object.prototype.hasOwnProperty.call(SECTION_SCAN_FOLDERS, seg)) return seg;
        }
    }

    return currentSection;
}
```

**Edit `importCurrentCardToTimeline`** (`:2542-2546`). The `name` and `cat` reads move above the derivation — both are plain `dataset` reads with no side effects — and `section` changes source. Nothing else in the function is touched.

```js
    // before
    var section = currentSection;
    var normSection = typeof getTemplateSection === "function" ? getTemplateSection({ section: section }) : section.toLowerCase();
    var name = card.dataset.file;
    var cat = card.dataset.cat;
    var cardFolder = (card.dataset.folder || "").replace(/\\/g, "/");

    // after
    var name = card.dataset.file;
    var cat = card.dataset.cat;
    var section = sectionForCard(card, name, cat);
    var normSection = typeof getTemplateSection === "function" ? getTemplateSection({ section: section }) : section.toLowerCase();
    var cardFolder = (card.dataset.folder || "").replace(/\\/g, "/");
```

The payload's `section: normSection` (`:2615`) and the success-toast block (`:2641-2643`) are **unedited**: the toast already branches on the `section` local, so it now reads the derived value with no textual change (3.12). The payload's `id: name`, `rootPath` and `sourcePath` are unedited, so 3.10 holds for every card in the active section by construction.

### BUG D — `tests/helpers/miniDom.js`

**1 — selector lists.** Add two functions above `collect`, change `collect`'s parameter, and update three call sites.

```js
// A comma-separated selector list, matched as "any of". The split lives here
// and NOT in matchesSelector, so getElementById — which builds "#" + id and
// calls collect directly — can never split a record id containing a comma.
function splitSelectorList(selector) {
    var raw = String(selector).split(",");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var one = raw[i].replace(/^\s+|\s+$/g, "");
        if (one) out.push(one);
    }
    return out;
}

function matchesAny(element, selectors) {
    for (var i = 0; i < selectors.length; i++) {
        if (matchesSelector(element, selectors[i])) return true;
    }
    return false;
}
```

```js
// `selectors` is an ARRAY. One traversal matching any of them, so results stay
// in document order with no duplicates — an element matching two selectors in
// the list appears once, which concatenating per-selector results would not do.
function collect(element, selectors, out) {
    for (var i = 0; i < element.childNodes.length; i++) {
        var child = element.childNodes[i];
        if (child.nodeType !== 1) continue;
        if (matchesAny(child, selectors)) out.push(child);
        collect(child, selectors, out);
    }
    return out;
}
```

- `MiniElement.prototype.querySelectorAll` → `return collect(this, splitSelectorList(selector), []);`
- `document.querySelectorAll` → `return collect(document.documentElement, splitSelectorList(selector), []);`
- `document.getElementById` → `collect(document.documentElement, ["#" + String(id)], [])` — a one-element array, never split.
- `MiniElement.prototype.querySelector` and `document.querySelector` are unchanged; they delegate.
- `matchesSelector` is unchanged, so single-selector behaviour is identical by construction.

**2 — `dataset`.** Add two mapping functions and one accessor near the `className` accessor.

```js
function datasetKeyToAttribute(key) {
    return "data-" + String(key).replace(/[A-Z]/g, function (ch) { return "-" + ch.toLowerCase(); });
}
function attributeToDatasetKey(name) {
    return String(name).substring(5).replace(/-([a-z0-9])/g, function (m, ch) { return ch.toUpperCase(); });
}

// Live in both directions, read through on every access so a setAttribute can
// never leave it stale. A Proxy rather than per-key accessors because a write to
// a key with no data-* attribute yet — c.dataset.thumb = url on an element built
// by createElement — must still reach an attribute. Non-string keys short-circuit
// so a Symbol probe (Jest's printer makes several) cannot reach String(symbol).
Object.defineProperty(MiniElement.prototype, "dataset", {
    get: function () {
        if (this._dataset) return this._dataset;
        var element = this;
        this._dataset = new Proxy({}, {
            get: function (ignored, key) {
                if (typeof key !== "string") return undefined;
                var value = element.getAttribute(datasetKeyToAttribute(key));
                return value === null ? undefined : value;
            },
            set: function (ignored, key, value) {
                element.setAttribute(datasetKeyToAttribute(key), value);
                return true;
            },
            has: function (ignored, key) {
                return typeof key === "string" && element.hasAttribute(datasetKeyToAttribute(key));
            },
            deleteProperty: function (ignored, key) {
                if (typeof key === "string") element.removeAttribute(datasetKeyToAttribute(key));
                return true;
            },
            ownKeys: function () {
                var keys = [];
                for (var name in element._attributes) {
                    if (!Object.prototype.hasOwnProperty.call(element._attributes, name)) continue;
                    if (name.indexOf("data-") === 0) keys.push(attributeToDatasetKey(name));
                }
                return keys;
            },
            getOwnPropertyDescriptor: function (ignored, key) {
                if (typeof key !== "string") return undefined;
                var attribute = datasetKeyToAttribute(key);
                if (!element.hasAttribute(attribute)) return undefined;
                return {
                    value: element.getAttribute(attribute),
                    writable: true, enumerable: true, configurable: true
                };
            }
        });
        return this._dataset;
    }
});
```

**3 — `classList`.** Add one helper and one accessor.

```js
function classTokens(element) {
    var parts = String(element.className).split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
    return out;
}

// A fresh view per access, so it cannot go stale after a className reassignment.
// Token order is preserved and duplicates are never introduced. Only a MUTATION
// rewrites the class attribute, so a read-only contains() leaves className
// byte-identical. add/remove are variadic and toggle takes the optional force
// argument, matching the calls js/** already makes.
Object.defineProperty(MiniElement.prototype, "classList", {
    get: function () {
        var element = this;
        function write(tokens) { element.setAttribute("class", tokens.join(" ")); }
        return {
            contains: function (name) { return classTokens(element).indexOf(String(name)) !== -1; },
            add: function () {
                var tokens = classTokens(element);
                for (var i = 0; i < arguments.length; i++) {
                    var name = String(arguments[i]);
                    if (name && tokens.indexOf(name) === -1) tokens.push(name);
                }
                write(tokens);
            },
            remove: function () {
                var tokens = classTokens(element);
                for (var i = 0; i < arguments.length; i++) {
                    var at = tokens.indexOf(String(arguments[i]));
                    if (at !== -1) tokens.splice(at, 1);
                }
                write(tokens);
            },
            toggle: function (name, force) {
                var tokens = classTokens(element);
                var at = tokens.indexOf(String(name));
                var on = (force === undefined) ? (at === -1) : !!force;
                if (on && at === -1) tokens.push(String(name));
                if (!on && at !== -1) tokens.splice(at, 1);
                write(tokens);
                return on;
            }
        };
    }
});
```

**4 — `style`.** Add one accessor.

```js
// A write-observable bag, deliberately NOT a CSS parser: it does not reflect
// into or out of the style ATTRIBUTE, because nothing in js/** reads
// getAttribute("style") and badge.style.cssText only needs to read back.
Object.defineProperty(MiniElement.prototype, "style", {
    get: function () {
        if (!this._style) this._style = {};
        return this._style;
    }
});
```

**5 — `textContent` setter.** Edit the **existing** `Object.defineProperty(MiniElement.prototype, "textContent", …)` call to add a `set`. The descriptor is non-configurable, so it cannot be added from outside; it stays non-configurable, since nothing redefines it.

```js
Object.defineProperty(MiniElement.prototype, "textContent", {
    get: function () { /* unchanged */ },
    // Added. Detaches every child and appends one text node, or none for an
    // empty value. _innerHTML is kept in step with the children so the
    // innerHTML getter does not report superseded markup; the getter above is
    // untouched, including its concatenation semantics.
    set: function (value) {
        for (var i = 0; i < this.childNodes.length; i++) this.childNodes[i].parentNode = null;
        this.childNodes = [];
        var text = (value === undefined || value === null) ? "" : String(value);
        this._innerHTML = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (text !== "") this.appendChild(new MiniText(this.ownerDocument, text));
    }
});
```

No change to `decodeEntities`, `parseAttributes`, `matchesSelector`, `parseInto`, the `VOID_ELEMENTS` set, `MiniFragment`, `parseSingleElement`, or the module's exports.

## Testing Strategy

### Validation Approach

Two phases. First surface counterexamples on the **unfixed** code, one per root-cause hypothesis, so a refutation sends that bug back to re-hypothesis rather than into an implementation. Then verify the fix holds for every input satisfying the bug condition and that behaviour is unchanged for every input that does not.

**Where each bug's coverage lands, and why.**

| Bug | Existing file extended | New file | Reason |
| --- | --- | --- | --- |
| A | `tests/template-catalog.test.js` | — | The catalog's own suite, 6/6 today, already built around the incremental-equals-rebuild invariant that is exactly clause 2.1. Clause 3.2 explicitly anticipates "new cases only from this spec". A new file would have to re-erect the same vm realm and the same brute-force cross-check. |
| B | `tests/media-card-lifecycle-preservation.property.test.js` | — | It already owns `patchUITemplate` / `removeUITemplate`, already generates both aliasing shapes, and already has the eight pre-authorized cases. Splitting B across two files would put the pre-fix and post-fix statements of the same behaviour in different places. |
| C | — | `tests/import-section-derivation.property.test.js` | `tests/comp-pipeline-integration.test.js` FLOW 6 must not be weakened (item 10) and its harness is built for transport failure, not for section derivation. A focused file can drive the real `renderTemplateCardMarkup` → parse → derive round trip, which FLOW 6's hand-rolled card cannot. |
| D | — | `tests/helpers/miniDom.contract.test.js` and `tests/card-thumbnail-dom-patch.test.js` | The helper's own contract and the production loops are different subjects with different harnesses. Adding either to the preservation suite would move the 70/70 clause 3.22 pins for reasons unrelated to preservation. |

Both new property files load `js/templates/templates.js` through `tests/helpers/loadHelpers.js` with `lenient: false`, following `tests/media-card-lifecycle-preservation.property.test.js`'s realm pattern.

Verification command:

```
npx jest tests/template-catalog.test.js tests/media-card-lifecycle-exploration.test.js tests/media-card-lifecycle-preservation.property.test.js tests/import-section-derivation.property.test.js tests/helpers/miniDom.contract.test.js tests/card-thumbnail-dom-patch.test.js tests/comp-pipeline-integration.test.js tests/comp-pipeline-bug-exploration.test.js tests/comp-pipeline-preservation.property.test.js tests/media-cep-compatibility.test.js tests/keyed-media-card-helper.test.js tests/single-card-patch-job-completion.property.test.js tests/media-async-io.property.test.js tests/media-hover-controller.test.js tests/media-hover-controller.property.test.js tests/media-import-coordinator.test.js tests/media-index-migration.property.test.js tests/media-pipeline-integration.test.js tests/performance/cold-start-progressive.property.test.js tests/performance/fast-media-terminal-regression.test.js tests/performance/startup-lifecycle.property.test.js tests/performance/startup-reconcile.property.test.js tests/performance/startup-warm-paint.property.test.js --runInBand
```

Then the baseline: `npx jest --runInBand`, expecting 10 failed suites / 98 failed tests and 110 passed suites / 1383 passed tests **plus** this spec's new passes, with nothing else moved (3.24).

### Exploratory Bug Condition Checking

**Goal.** Counterexamples on unfixed code, before any fix lands, confirming or refuting each root cause.

Cases go in a new `tests/catalog-patch-ordering-exploration.test.js`, labelled per case, so the pre-fix evidence lives in one place and the post-fix statements live in the suites above.

1. **X1 — a re-key duplicates** (will fail). Build over three records in one section; mutate the middle record's `id` in place; `catalog.patch(record, { category, favorite, section })`. Assert `size() === 3`, `idsFor(section,"All").length === 3` and `sectionCounts(section).all === 3`. Confirms hypothesis 1.
2. **X2 — the leak is cumulative** (will fail). Two successive re-keys of the same record. Assert `idsFor(section,"All")` still has three entries. Distinguishes "one duplicate" from "one per rename".
3. **X3 — the old name stays searchable** (will fail). After a re-key, assert `idsFor(section,"All", oldName)` is empty and `idsFor(section,"All", newName)` returns the record. Confirms 1.3.
4. **X4 — rename-then-delete leaves a ghost** (will fail). Re-key, then `remove`. Assert `get(oldId)` is `undefined`, `idsFor(section,"All").length === 2` and `sectionCounts(section).all === 2`. Confirms 1.4 — the consequence `bugfix.md` found beyond the original report.
5. **X5 — the shared-shape middle rename fires nothing** (will fail). Five records, shared shape, rename at index 2 with `filterAndRender` stubbed. Assert `TemplateCatalog.get(newId)` is the mutated record. Confirms hypothesis 2 and pins the exact gap.
6. **X6 — the shared-shape favourite toggle loses the count** (will fail). Three unfavourited records, shared shape, `patchUITemplate(name, cat, { favorite: true })` with `filterAndRender` stubbed. Assert `sectionCounts(section).favorites === 1`. Confirms hypothesis 3 — the second-order consequence, which is invisible in the cloned shape.
7. **X7 — the import section ignores the card** (will fail). Render a `footage` record's card, parse it, set `currentSection` to `comp`, capture `importTemplates`' payload. Assert `payload.templates[0].section === "footage"`. Confirms hypothesis 4. **Requires BUG D landed** for `dataset`; until then the case is skipped with that reason in its label.
8. **X8 — the selector list matches nothing** (will fail). Parse two cards, one `.card` and one `.icon-card`, into a miniDom document. Assert `document.querySelectorAll(".card, .icon-card").length === 2`. Confirms hypothesis 5's first half — and asserts, deliberately, that **no exception is raised** today, correcting the originally reported mechanism.
9. **X9 — the loop body throws on four counts** (will fail, four times). With the selector list patched locally in the test only, call `refreshCardThumbnail` and `markCardFailed` and record which of `dataset`, `classList`, `style` and the `textContent` setter throws. Confirms hypothesis 5's second half and proves the fix needs four additions, not one.
10. **X10 — edge case, the genuinely-new add still adds** (expected to **pass** on unfixed code). `catalog.patch(fresh)` for a record never indexed. A failure here means the add path is already broken and BUG A's premise is wrong.
11. **X11 — edge case, the card carries no section attribute** (expected to **pass**). Assert a rendered card's parsed attributes include `data-file`, `data-cat`, `data-folder`, `data-thumb` and an `id` of `"tpl-" + record.id`, and **no** `data-section`. A failure refutes the premise that the section must be derived rather than read.

**Expected counterexamples.**

- X1-X4: `size()` 4 not 3; `idsFor` `["a","b","c","b-new"]`; `counts` `{all:4,cats:{Cat:4}}`; `idsFor(…, oldName)` returning the stale id; `get(oldId)` still resolving after `remove`. Cause: `byId[id] === undefined` read as "new record".
- X5: `realm.catalog.patch.length === 0`, `realm.marks.length === 0`, `catalogSourceChanged() === false`, `TemplateCatalog.get(oldId).name` still the old name, and every shape probe unmoved. Cause: the scan searching for a value `patchEntry` already overwrote.
- X6: `sectionCounts(section).favorites === 0` where a rebuild reports `1`, with `before.favorite === mutated.favorite`. Cause: `before` read from the merged clone.
- X7: `payload.templates[0].section === "comp"` while `sourcePath` was derived from the `footage` record — the two-rules-for-one-record signature.
- X8: `length === 0`, and no thrown error anywhere in the call.
- X9: `TypeError: Cannot read properties of undefined (reading 'folder')`, then `… (reading 'remove')`, then `… (setting 'cssText')`, then `TypeError: Cannot set property textContent of #<MiniElement> which has only a getter`.

### Fix Checking

**Goal.** For every input where the bug condition holds, the fixed code produces the expected behaviour.

```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixed(input)
  ASSERT expectedBehavior(result)
END FOR
```

**BUG A → Property 1.** New cases in `tests/template-catalog.test.js`, each cross-checked against an independent `build` over the same records, in the file's existing style.

| Case | Shape | Asserts |
| --- | --- | --- |
| A1 | re-key in place, `previous` carries the pre-patch id | `size`, `idsFor(section,"All")`, `idsFor(section,cat)`, `categories`, `sectionCounts` all equal a fresh rebuild's; the new id sits at the old id's index |
| A2 | re-key with the record **object replaced** (`patch(clone, {id: oldId, …})`) — the shared shape | same parity assertions. The case only route 1 can discriminate |
| A3 | re-key in place with **no** `previous` | same parity assertions. The case only route 2 can discriminate |
| A4 | two successive re-keys | `size()` and `idsFor` length unchanged; no leaked entry |
| A5 | re-key then `remove` | `get(oldId)` and `get(newId)` both `undefined`; `idsFor` and `counts.all` equal a rebuild over the remaining records |
| A6 | re-key then search | `idsFor(section,"All",oldName)` empty; `idsFor(section,"All",newName)` returns the record |
| A8 | re-key **and** section change together | removed from the old section's `sectionIds`, present in the new one, counted once; both sections' `counts` and `categories` equal a rebuild's |
| A10 | property, 500 generated re-key sequences over 1-40 records × {in place, replaced} × {with, without `previous`} × {same, different category} | after every step, the whole public surface equals a rebuild over the same records |

**BUG B → Property 3.** New cases in `tests/media-card-lifecycle-preservation.property.test.js`, all with `filterAndRender` / `patchTemplateCard` / `buildCategoryTabs` / `buildCategoryPanel` stubbed, so the mirror's own effect is observable **before** any rebuild can mask it. This is the point: these cases prove the fix, not the mask.

| Case | Asserts |
| --- | --- |
| B1 | shared shape, rename at a MIDDLE index: `realm.catalog.patch.length === 1`, `realm.marks.length === 1`, `marks[0].sourceChanged === true`, `realm.catalog.build === 0`, `get(newId) === allTemplates[MID]`, `get(oldId) === undefined`, `size()` unchanged, `idsFor(section,"All")[MID] === newId` |
| B2 | shared shape, **move** (category change) at a MIDDLE index: same shape, plus `sectionCounts(section).cats` equal to a rebuild's and `categories(section)` equal to a rebuild's |
| B3 | shared shape, favourite toggle: `sectionCounts(section).favorites === 1` with `realm.catalog.build === 0`, and equal to a rebuild's — clause 2.7's executable form and X6's inverse |
| B4 | shared shape, `removeUITemplate`: `realm.catalog.remove.length === 1`, `realm.marks.length === 1`, `allTemplates.length === N - 1` (no double splice), `TemplateCatalog.size() === N - 1`, `li.has(folder) === false`, `li.needsFullScan() === false` |
| B5 | property over {shared, cloned} × {favorite, rename, move} × index ∈ {0, middle, last}: the mirror count, the mark count and the post-call catalog state are **mode-independent**, and the catalog equals a rebuild over the resulting `allTemplates` in every cell |
| B6 | `li.patchEntry` rejected (a folder the index does not hold): rollback, `needsFullScan() === true`, `lastError()` non-null, and the in-memory mutation plus the mirror still landing on the resolved record — byte-identical to the pre-fix behaviour, computed in-test |

**BUG C → Property 5.** In `tests/import-section-derivation.property.test.js`.

| Case | Asserts |
| --- | --- |
| C1 | route table: id resolves / id absent but name+category matches / both absent but `data-folder` well formed / nothing → the expected section for each, over all nine sections |
| C2 | property, 400 generated records × 9 `currentSection` values: for a card produced by the real `renderTemplateCardMarkup` and parsed by miniDom, the derived section equals the record's own `section` **regardless of `currentSection`**, and the payload's `section` equals `getTemplateSection({section: record.section})` |
| C4 | route-3 guards: a `data-folder` whose third-from-last segment is not a `SECTION_SCAN_FOLDERS` key falls through; so does one with fewer than four segments; so does an empty one. Each lands on `currentSection` |
| C5 | the toast reads the derived section: a `comp` card imported while `currentSection` is `icon` produces "Composition imported"; a `text_props` card produces "Applied to text"; every other section produces "Imported successfully" |

**BUG D → Property 7.** In `tests/card-thumbnail-dom-patch.test.js`, driving the real functions against a parsed document.

| Case | Asserts |
| --- | --- |
| D1 | `.card` with an existing `<img>`: `img.src === url`, `c.dataset.thumb === url`, no new element inserted, `thumb-failed` removed |
| D2 | `.card` with a `.thumb-box` holding **no** `<img>` (a non-media record with no thumbnail, so the renderer emitted the placeholder SVG): one `<img class="thumb-img" src=… alt="" loading="lazy">` inserted, `src` decoding back to the busted URL |
| D3 | a pre-existing `.thumb-fail-badge` is removed on success and is the **only** node removed |
| D4 | `markCardFailed`: `thumb-failed` added, one `.thumb-fail-badge` inserted into the box with `badge.title === "Thumbnail render failed"`, `getAttribute("aria-label")` the same string, `textContent === "!"`, and a `style.cssText` containing `position:absolute` |
| D5 | `markCardFailed` twice for the same folder inserts exactly one badge |
| D6 | the `.icon-card` variant (markup authored in the test, since the prior spec deleted `renderIcons`): the inserted `<img>` carries **no** `class` attribute |
| D7 | `window.getComputedStyle` present and returning `{position:"static"}` with a bare `getComputedStyle` global injected → `box.style.position === "relative"`. Without the bare global the `ReferenceError` is caught and `position` is set anyway; with `window` present but no `getComputedStyle`, `box.style` is never written. All three realms asserted, because production checks `window.getComputedStyle` and then calls the **bare** global |
| D8 | no-match: a folder matching no card leaves every card's attributes, classes and children byte-identical and raises nothing |
| D9 | `querySelectorAll(".card, .icon-card")` over a tree containing one of each plus an element carrying **both** classes returns three nodes, in document order, with no duplicates |

### Preservation Checking

**Goal.** For every input where the bug condition does not hold, the fixed code produces the same result as the original.

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT original(input) = fixed(input)
END FOR
```

**Testing approach.** Property-based, because the preservation obligations here are universally quantified over records, mutation sequences, category strings and selector strings — exactly where hand-picked examples miss. For BUG A and BUG B the "original" side is computed **inside the test** from a fresh rebuild or from the pre-fix expression, so equality is asserted against the old rule rather than against a snapshot. Observation-first for BUG D: the 15 consuming suites are run on unfixed code and their counts recorded before the helper is touched.

| Case | Property | Asserts |
| --- | --- | --- |
| P1 | 2 | `tests/template-catalog.test.js:152-154` unmodified and green — `patch(fresh)` is still an add. Named as the regression witness |
| P2 | 2 | **the identity-scan false-positive guard.** `patch(freshClone)` where `freshClone` carries an indexed record's exact field values including its `id`… and where it carries a *different* id but identical everything else. Both must **add**, not re-key. This is the only way route 2 could be got wrong, so it is asserted rather than argued |
| P3 | 2 | `tests/template-catalog.test.js:101` and `:116` unmodified and green; plus a property over 500 same-id patches (favourite, category, both) asserting the whole public surface equals a rebuild's |
| P4 | 2 | `recordId(t) === null` behaves exactly as before — the deliberate non-change in D1, made executable |
| P5 | 2 | after `patch` and after `remove`, `sourceStamp()` is unchanged; only `build` and `stampSource` move it |
| P6 | 2 | `byId[id] === t` and `sectionIds` holds ids, never clones, after a re-key; `categories(section)` has no duplicate |
| P7 | 4 | `tests/media-card-lifecycle-preservation.property.test.js`'s `P1` (`_getTemplateFolderPath` over 2000 generated non-media records) unmodified and green — the helper is not edited, so this holds by construction and is re-run to confirm it |
| P8 | 4 | `F2-remove` and `F2-patch` with `expectMirror` collapsed to `1`: every patched field on the backing entry, `folderPath` unmoved, `needsFullScan()` false, `lastError()` null, `li.size()` unchanged, neighbours untouched, `saveLibraryIndex` exactly once, no warnings |
| P9 | 4 | `P8`'s `recordChangedView` routing property, unmodified: `filterAndRender` exactly when `recordChangedView` holds and `patchTemplateCard` otherwise, over favourite/rename/move × search × `currentCategory === "Favorites"` |
| P10 | 4 | `P5` (build fires once across K renders with no mutation), `P6` (`refreshCardThumbnail` exclusion witness) and `P7` (constant-length clone rewrite detected by the element-identity probes) unmodified and green. `P7` matters here: D3 keeps `patchEntry`'s clone replacement precisely so those probes stay live |
| P11 | 6 | the payload byte-identity property: for 400 generated records rendered in their **own** section, the whole payload computed by the fixed code equals the payload computed from the pre-fix rule (`currentSection`), field by field |
| P12 | 6 | `tests/comp-pipeline-integration.test.js` FLOW 6, both tests, unmodified and green — `makeCardFake()` completes without throwing and the `.importing` / `.imported` and toast assertions are untouched |
| P13 | 8 | the miniDom preservation table: single-selector `querySelector` / `querySelectorAll` byte-identical to the pre-fix results over 300 generated trees; `getElementById` for ids containing commas, entities, spaces and `#`; the entity round trip `escapeTemplateCardAttribute` → parse → `.id` over 1000 generated record ids; `innerHTML` get/set; the `textContent` **getter** over nested trees; the void-element set |
| P14 | 8 | the three extending suites still install their own descriptors: `startup-reconcile.property`, `startup-warm-paint.property`, `startup-lifecycle.property` run unmodified |
| P15 | 8 | the 15 consuming suites at 1 failed / 171 passed / 172 total, and the four startup performance suites unmodified — the measured baseline of clause 2.15 re-checked after the real implementation, not the probe |
| P16 | 8 | `refreshCardThumbnail`'s and `markCardFailed`'s model-and-index halves: the index patch fields, the record field writes, the presence of `TemplateCatalog.patch` with no mark for one and of the mark with no mirror for the other. `E3` still red and labelled, `P2c` still green |
| P17 | 9 | `tests/media-cep-compatibility.test.js` unmodified and green. Holds by construction: no whole-file unit is edited, `persistence.js` is untouched, and neither `escapeTemplateCardAttribute` nor `renderTemplateCardMarkup` is edited, so both region scans extract identical text at a shifted start line |
| P18 | 9 | an ES5 syntax scan over the two edited `js/**` files: no arrow, `let`/`const`, template literal, spread/rest, `class`, `async`/`await`, `?.` or `??`. `tests/**` is out of scope for this property |

### Unit Tests

- `priorIndexedId`: route 1 hit; route 1 with a `previous.id` equal to the current id; route 1 with a `previous.id` the catalog does not hold (falls through to route 2); route 2 hit; both miss; `previous` `undefined`, `null` and `{}`.
- `reindexRecord`: same-section swap at index 0, middle and last; cross-section move; an `oldId` in no bucket at all; a section with exactly one record.
- `sectionForCard`: each of the four routes in isolation and each guard failing into the next; `card` `null`; a card with `id` present but not `tpl-`-prefixed; a card whose `tpl-` id resolves to a record with no `section`; `TemplateCatalog` absent from the realm; `dataset` absent from the card object.
- `splitSelectorList`: one selector; two; three with irregular whitespace; a trailing comma; an empty string; a selector containing a comma inside no quotes (documented as unsupported and returning both halves).
- miniDom `dataset`: read a missing key (`undefined`, not `null`); write then read; write then `getAttribute`; `delete`; `in`; `Object.keys`; a camelCase key; a symbol key.
- miniDom `classList`: `add` a duplicate; `remove` an absent token; `toggle` with and without `force`; order after a mixed sequence; `contains` leaving `className` byte-identical.
- miniDom `textContent` setter: `""`, `null`, `undefined`, a value containing `<`, `&` and `>`, and a set over an element that already had parsed children; the getter re-read after each.

### Property-Based Tests

- Generate re-key sequences over 1-40 records and assert the catalog's entire public surface equals a rebuild after every step — the executable form of "incremental equals rebuild" for the new branch.
- Generate {aliasing shape} × {patch kind} × {index position} and assert the mirror count, the mark count and the resulting catalog state are independent of the aliasing shape.
- Generate records across all nine sections, render and parse each card, and assert the derived section is independent of `currentSection`.
- Generate hostile record ids (entities, commas, `#`, spaces, quotes) and assert `getElementById("tpl-" + id)` and the `tpl-<id>` round trip are unchanged by the selector-list split.
- Generate trees and single selectors and assert the fixed `querySelectorAll` result is identical to the pre-fix result computed in-test.

### Integration Tests

- Full reopen-then-rename: persist an index, run the real `startupWarmPaint` (shared shape), rename a middle card through `confirmRename`, and assert the grid's next paint shows the new name, the category counts are right, a search for the old name misses and a search for the new name hits — the compound BUG A + BUG B failure, end to end.
- Full rename-then-delete: rename a middle card, delete it, and assert nothing resolvable survives in the catalog or the persisted index.
- Full cross-section import: render a `footage` card, switch `currentSection` to `comp` without repainting, import the stale card, and assert the payload carries `footage` and the success toast reads "Imported successfully".
- Full thumbnail lifecycle under a parsed document: render a card with no thumbnail, call `markCardFailed` (badge appears, `thumb-failed` added), then `refreshCardThumbnail` (badge removed, `thumb-failed` removed, `<img>` inserted with the busted URL, `data-thumb` updated) — the four pieces of shipped UI behaviour that had never been executed, in the order a user hits them.

## Tests That Pin Current Behaviour and Need Attention

### Pre-authorized to change — items 1-8, all in `tests/media-card-lifecycle-preservation.property.test.js`

**Item 1 — `F4-S5-aliasing-rename`** ("S5 rename in shared mode at a MIDDLE index: nothing fires"). Rename the test to say that everything fires, and replace the 32-line `RECORDED, NOT ENDORSED` comment with a description of the fixed behaviour.

| Assertion | Now | After | Why |
| --- | --- | --- | --- |
| `expect(ctx.allTemplates[MID].name).toBe(oldName + " R")` | passes | **unchanged** | the rename still lands on the shared array |
| `expect(ctx.allTemplates[MID]).not.toBe(target)` | passes | **unchanged** | D3 keeps `patchEntry`'s clone replacement |
| `expect(realm.getIndex().needsFullScan()).toBe(false)` | passes | **unchanged** | — |
| `expect(realm.marks.length).toBe(0)` | 0 | **`1`** | S5 is reached |
| — | — | **add `expect(realm.marks[0].sourceChanged).toBe(true)`** | matches the favourite case; clause 2.6 |
| `expect(realm.catalog.patch.length).toBe(0)` | 0 | **`1`** | the mirror is reached |
| `expect(ctx._templatesRevision).toBe(revisionBefore)` | equal | **`revisionBefore + 1`** | one mark |
| the five `shapeProbeDelta` assertions, all `false` | pass | **unchanged** | the point of the case: the counter, not a probe, is the mechanism |
| — | — | **add `expect(realm.catalog.build).toBe(1)`** | `structural` is true, so `recordChangedView` holds and the trailing real `filterAndRender()` spends exactly one rebuild |
| `expect(ctx.catalogSourceChanged()).toBe(false)` | false | **unchanged — for the opposite reason** | `bugfix.md` item 1 predicted `true`; that is wrong. The mark is raised *and then absorbed* by the entry point's own `filterAndRender`, so it reads `false` at the point the case measures. `F4-S4-aliasing-shared` already shows this pattern. The new `build === 1` assertion is what distinguishes "absorbed" from "never raised" |
| `expect(ctx.TemplateCatalog.get("t2").name).toBe(oldName)` | the old record | **`expect(ctx.TemplateCatalog.get("t2")).toBeUndefined()`** | the old id must not resolve. `get` returns `byId[id]`, so an absent key is `undefined`, not `null` |
| — | — | **add `expect(ctx.TemplateCatalog.get("t2-renamed")).toBe(ctx.allTemplates[MID])`** | the catalog indexes the object the array holds — D3's invariant, asserted |
| — | — | **add `expect(ctx.TemplateCatalog.size()).toBe(SIZE)`** | no duplication (BUG A) |
| — | — | **add `expect(ctx.TemplateCatalog.idsFor(SECTION, "All")[MID]).toBe("t2-renamed")`** | position preserved (clause 2.2) |

Because the trailing rebuild masks the mirror here, the catalog-exactness claims are *also* asserted with `filterAndRender` stubbed, in new case **B1** — so this case proves the signal and B1 proves the fix.

**Item 2 — `F4-S5-aliasing-rename-edges`** ("FIRST and LAST index: the element-identity probes cover it").

| Assertion | Now | After |
| --- | --- | --- |
| `expect(realm.marks.length).toBe(0)` | 0 | **`1`** for both indices |
| `expect(realm.catalog.patch.length).toBe(0)` | 0 | **`1`** for both indices |
| `expect(delta.firstElementMoved).toBe(true)` / `expect(delta.lastElementMoved).toBe(true)` | pass | **unchanged** — D3 keeps the clone replacement, so the replaced element is still a new object |
| `expect(realm.catalog.build).toBe(1)` | passes | **unchanged** — one rebuild, now attributable to the mark as well as the probe |
| `expect(ctx.catalogSourceChanged()).toBe(false)` | passes | **unchanged** |
| `expect(ctx.TemplateCatalog.get("renamed-" + idx).name).toBe(oldName + " R")` | passes | **unchanged** |
| — | — | **add `expect(ctx.TemplateCatalog.get(oldIdFor(idx))).toBeUndefined()`** for both indices |

The comment "Same missed scan as the middle-index case…" must go; the scan no longer misses in either case.

**Item 3 — `F4-S4-aliasing-shared`** ("removeEntry splices the shared array before the scan runs"). Rename; the title's premise is now false.

| Assertion | Now | After |
| --- | --- | --- |
| `expect(realm.marks.length).toBe(0)` | 0 | **`1`** |
| `expect(realm.catalog.remove.length).toBe(0)` | 0 | **`1`** |
| `expect(ctx._templatesRevision).toBe(revisionBefore)` | equal | **`revisionBefore + 1`** |
| — | — | **add `expect(realm.marks[0].sourceChanged).toBe(true)`** |
| `expect(li.has(target.folderPath)).toBe(false)` | passes | **unchanged** |
| `expect(li.needsFullScan()).toBe(false)` | passes | **unchanged** |
| `expect(ctx.allTemplates.length).toBe(SIZE - 1)` | passes | **unchanged** — the identity check prevents a second splice |
| `expect(ctx.allTemplates.indexOf(target)).toBe(-1)` | passes | **unchanged** |
| `expect(delta.lengthMoved).toBe(true)` | passes | **unchanged** |
| `expect(realm.catalog.build).toBe(1)` | passes | **unchanged** |
| `expect(ctx.catalogSourceChanged()).toBe(false)` | passes | **unchanged** |
| `expect(ctx.TemplateCatalog.size()).toBe(SIZE - 1)` | passes | **unchanged** |

**Item 4 — `F2-pin`** ("a patch that tries to move `folderPath` is pinned to the index key"). The four `expect` calls all read the **cloned** world and stay green, unchanged. Two changes:

1. The `note` string's factual claim survives — under D3 the in-memory loop still writes `patchObj`'s fields onto the object `patchEntry` pinned, so the shared entry still moves away from its key — but its *rationale* is now stale: the case is stated in cloned mode because the aliasing overwrites the pin, not because the shared scan happened to match. Rewrite the rationale and add that after this spec the overwrite reaches the rename and move shapes too, not only the shapes whose scan matched.
2. Promote the observation to assertions, so the claim cannot rot: **add `expect(shared.li.getEntry(shared.folder)).toBeNull()`** and **`expect(shared.li.has("Z:/moved")).toBe(true)`**, and drop `sharedStillResolvable` from the `observe` payload. It is deterministic after the fix, so recording it in prose is strictly weaker than asserting it.

**Item 5 — `F2-remove`** ("removeUITemplate drops the backing entry…").

- `const expectMirror = w.aliased ? 0 : 1;` → **`const expectMirror = 1;`**, consumed unchanged by `expect(w.realm.catalog.remove.length).toBe(expectMirror)`. Inline the literal and delete the variable, or keep the name for diff legibility — either is fine, but the aliasing conditional must go, and with it the comment "Removal always moves the match target, so the mirror fires only when the array is NOT the index's own entry list."
- `expect(aliasSeen.shared).toBeGreaterThan(0)` and `expect(aliasSeen.cloned).toBeGreaterThan(0)` **stay**. Both shapes must still be generated — that is now the *point*, since the expectation is mode-independent.
- Add `expect(w.realm.marks.length).toBe(1)`, which the case does not currently assert in either mode.

**Item 6 — `F2-patch`** ("patchUITemplate lands every patched field on the backing entry…").

- `const expectMirror = (w.aliased && movesMatchKey) ? 0 : 1;` → **`const expectMirror = 1;`**. The `movesMatchKey` computation becomes dead and is deleted with it.
- `expect(mirrorSeen["0"]).toBeGreaterThan(0)` — **removed, not inverted.** `mirrorSeen` is keyed by `String(expectMirror)`, and `expectMirror` is now the constant `1`, so `mirrorSeen["0"]` can never be incremented: the guard is unsatisfiable, not merely wrong. Inverting it to `toBe(0)` or `toBeUndefined()` would assert that a bucket of a now-constant tally is empty — a tautology restating the line above it, with no failure mode that means anything. The non-vacuity it was protecting is now carried entirely by `aliasSeen`-style coverage, so the honest replacement is to delete `mirrorSeen` altogether and add **`expect(aliasSeen.shared).toBeGreaterThan(0)`** / **`expect(aliasSeen.cloned).toBeGreaterThan(0)`** in its place, mirroring `F2-remove`. That preserves exactly the property the guard existed for — both aliasing shapes were generated — and states it about the input space, where it is checkable, rather than about a derived expectation.
- `expect(mirrorSeen["1"]).toBeGreaterThan(0)` — removed with the tally, subsumed by `expect(w.realm.catalog.patch.length).toBe(1)` running on every generated case.
- `expect(kindSeen.favorite / .rename / .move).toBeGreaterThan(0)` **stay** unchanged.
- Add `expect(w.realm.marks.length).toBe(1)`.
- The comment "The mirror is skipped exactly when the array is aliased AND the patch moves a field the match rule keys on" must go.

**Item 7 — the `S_SITES` table entries for `S4`, `S5`, `S6`, `S7`.**

- **S4** (`removeUITemplate`): the comment "Cloned aliasing: … The shared shape — where it does not — is pinned separately in the aliasing block below" is now false and must be rewritten. `aliasing: "cloned"` may stay — the site's `drive` assertions (`realm.catalog.remove.length === 1`, `needsFullScan() === false`) are now mode-independent — but switching it to `"shared"` is the stronger statement and costs nothing. Recommended: keep `"cloned"` for the table's default and let new case **B4** carry the shared shape, so the table stays a like-for-like comparison across all seven sites.
- **S5** (`patchUITemplate`, favourite toggle): already mode-independent before this spec, because a favourite toggle does not move the match key. Its `aliasing: "cloned"` was never load-bearing; the comment that explains why it matches in both modes stays accurate. No change required. New case **B3** carries the favourites-count claim the site cannot make.
- **S6** (`markCardFailed`) and **S7** (`renderOptimisticCard`): `aliasing: "cloned"` **stays and stays justified.** `markCardFailed` scans by `folderPath` with no index call before it, so it is already mode-independent; `renderOptimisticCard` calls `li.insertAtHead` and then `allTemplates.unshift(tpl)`, which in the shared shape inserts the record **twice**. That is a pre-existing aliasing defect in `renderOptimisticCard`, outside all four bugs in this spec, and recorded here so the `"cloned"` mode is understood as deliberate rather than incidental. It should get its own spec.
- `expectedMarks: 1` is unchanged for all four sites: S4 and S5 are relocated, not duplicated.

**Item 8 — the `describe` block comment at "The aliasing boundary S4 and S5 sit on."** The 27-line narrative of the four-way case split must be rewritten. Its replacement should keep the four-way table — it is still the clearest statement of what the shapes are — but restate each row's outcome, and replace the closing "it needs its own spec" with a pointer to this one. The specific sentences that become false: "in that shape NEITHER runs"; "The middle-index rename is an aliasing defect in patchUITemplate's own ordering, NOT something an extra markTemplatesDirty could reach"; and the whole "If a later change fixes the ordering, this case goes RED with the new behaviour" paragraph, which has now happened.

### Not pre-authorized — must NOT be weakened

**Item 9 — `tests/template-catalog.test.js`.** `:152-154` (`catalog.patch(fresh)` acts as an **add**), `:101` (favourite toggle) and `:116` (category change) are **unmodified**, and every incremental-equals-rebuild cross-check in the file stays. The file's 6/6 becomes 6 + the new cases, all passing. New case **P2** exists specifically to make the identity scan's only failure mode — mistaking a fresh clone for a re-key — executable, so the `:152-154` guarantee is defended by two tests rather than one.

**Item 10 — `tests/comp-pipeline-integration.test.js` FLOW 6.** **Unmodified.** `makeCardFake()` has no `id` and no `getAttribute`; the derivation reads `card.id` as a property behind a `typeof` guard and never calls `getAttribute`, so route 1 is skipped and route 3 answers `"comp"` from `dataset.folder`'s third-from-last segment — which equals the harness's default `currentSection` of `SECTIONS.COMP`. Both tests assert on `.importing` / `.imported` and on the toast text, neither asserts the payload's `section`, and both surface error toasts rather than success toasts, so the toast decision in D4 cannot reach them. Re-run to confirm, not edited.

**Item 11 — `tests/media-card-lifecycle-exploration.test.js` case `E3`.** **Unmodified and still red**, keeping its `DIAGNOSTIC` label. Its post-fix inverse `P2c` stays green. Nothing in this spec touches `refreshCardThumbnail`'s index patch, which is what `E3` asserts against and what the prior spec's D1 deliberately declines to satisfy. The file stays at 1 failed / 9 passed (3.23).

### Expected to be unaffected — listed so the assumption is checked

- The 15 miniDom-consuming suites, measured by `bugfix.md`'s probe at zero movement. Re-measured against the real implementation as **P15**, since a probe is not the implementation.
- `tests/media-cep-compatibility.test.js`: no whole-file unit is edited, `js/core/persistence.js` is untouched, and neither region-scanned body is touched. **P17**.
- `tests/comp-pipeline-bug-exploration.test.js` (22/22) and `tests/comp-pipeline-preservation.property.test.js` (47/47). Neither drives `patchUITemplate`, `removeUITemplate` or `TemplateCatalog.patch`.
- `tests/media-card-lifecycle-preservation.property.test.js`'s other 60-plus cases, in particular `P1`, `P5`, `P6`, `P7` and `P8` — named as **P7**, **P9** and **P10** above.
- The four startup performance suites. They never rename, never remove and never import.

## Conflicts and Ordering

| Overlap | Detail | Resolution |
| --- | --- | --- |
| **BUG B and the prior spec's S4 / S5** | Both `markTemplatesDirty()` calls sit **inside** the scan loops BUG B deletes. This is the only place this spec touches the prior spec's S1-S7 table. | Relocate, do not re-add. S4 moves into `removeUITemplate`'s `if (removed)` block, S5 into `patchUITemplate`'s `if (target)` block. Count unchanged (one per operation), effect unchanged, guard changed from "the scan matched" to "a record was resolved" — which is the fix. Keep the `// S4` / `// S5` markers so the prior spec's table stays greppable. |
| **BUG C's helper insertion shifts BUG B's anchors** | `sectionForCard` is inserted after `getTemplateSourcePath` (`:2151`), above `removeUITemplate` (`:2219`). | Apply by anchor text and the order is free. If applying by line number, **B before C**. |
| **BUG B and BUG C both edit `templates.js`** | Disjoint function bodies: `removeUITemplate` / `patchUITemplate` (`:2219-2290`) versus `importCurrentCardToTimeline` (`:2539-2660`) plus the new helper at `:2151`. | No textual overlap. Only the line-number shift above. |
| **BUG A and BUG B** | Different files (`templateCatalog.js`, `templates.js`). | No textual conflict. The dependency is behavioural only: `before.id` ships with B, so A must land after B. See [D6](#d6--implementation-order). |
| **BUG D and everything else** | `tests/helpers/miniDom.js` only. | No conflict. But D must land before C's tests, which need `dataset` to drive a parsed card. |
| **BUG D's five additions among themselves** | Four are new accessors on `MiniElement.prototype`; the fifth **edits an existing** `Object.defineProperty` call. | The `textContent` edit is the only one that modifies existing code. Apply it last so the four additive accessors can be reviewed independently of it. |
| **`_getTemplateFolderPath` — a near-miss** | BUG B needs a record resolved before the index call, and `_getTemplateFolderPath` already resolves one internally. | Not edited. Adding an optional record parameter would touch the function the prior spec's `P1` pins over 2000 generated records. The duplicate O(N) scan is accepted; see [D3](#d3--bug-bs-ordering-shape-and-the-clone-replacement). |
| **`js/core/persistence.js` — the one that would have conflicted** | `patchEntry`'s clone replacement is the source of BUG B's second-order damage, and changing it looks like the direct fix. | **Not edited.** D3 achieves the invariant by mutating the array slot instead. This keeps a whole-file CEP-scanned unit out of the change set (3.20) and keeps `_mutate`'s rollback semantics and the element-identity shape probes intact (3.9). |

**Recommended order: BUG D → BUG B → BUG A → BUG C.**

## Traceability — every change and the test that proves it

| Change | File | Function | Proved by |
| --- | --- | --- | --- |
| `priorIndexedId` — the two-route discriminator | `js/templates/templateCatalog.js` | new, module-private | A2 (route 1 only), A3 (route 2 only), P2 (no false positive), A10 (property) |
| `reindexRecord` — in-place key swap | `js/templates/templateCatalog.js` | new, module-private | A1 (position), A6 (`searchHay`), A8 (cross-section), A10 |
| the re-key branch in `patch` | `js/templates/templateCatalog.js` | `patch` | A1, A4 (cumulative leak), A5 (rename-then-delete), P1 / P3 / P4 (the add and same-id paths unmoved) |
| resolve-first + identity splice | `js/templates/templates.js` | `removeUITemplate` | B4, item 3 (`F4-S4-aliasing-shared`), item 5 (`F2-remove`), S4's table row |
| resolve-first + slot mutation + `before.id` | `js/templates/templates.js` | `patchUITemplate` | B1 / B2 (catalog exact, no rebuild), B3 (favourites count, clause 2.7), B5 (mode independence), B6 (rejected patch), item 1 (`F4-S5-aliasing-rename`), item 2 (edges), item 6 (`F2-patch`), P9 (`recordChangedView` routing unmoved) |
| `sectionForCard` — four-route derivation | `js/templates/templates.js` | new, top-level | C1 (route table), C2 (property, independent of `currentSection`), C4 (route-3 guards) |
| the derivation call site + reordered `dataset` reads | `js/templates/templates.js` | `importCurrentCardToTimeline` | C2, C5 (toast reads the derived section), P11 (payload byte-identity), P12 (FLOW 6 unmodified) |
| comma-separated selector lists | `tests/helpers/miniDom.js` | `splitSelectorList`, `matchesAny`, `collect`, both `querySelectorAll` | D9 (order, dedup), X8 (the pre-fix counterexample), P13 (`getElementById` comma safety, single-selector parity) |
| `dataset` | `tests/helpers/miniDom.js` | new accessor + two mappers | D1 (`data-thumb` write), the `dataset` unit table, P13 |
| `classList` | `tests/helpers/miniDom.js` | new accessor + `classTokens` | D1 / D4 (`thumb-failed` remove / add), the `classList` unit table |
| `style` | `tests/helpers/miniDom.js` | new accessor | D4 (`cssText`), D7 (`position`) |
| `textContent` setter | `tests/helpers/miniDom.js` | existing descriptor, `set` added | D4 (`badge.textContent === "!"`), the `textContent` unit table, P13 (getter unchanged) |
| both DOM patch loops, newly reached | `js/templates/templates.js` | `refreshCardThumbnail`, `markCardFailed` — **not edited** | D1-D9, P16 (the model-and-index halves unchanged, `E3` red, `P2c` green) |
| `js/core/persistence.js` — **not edited** | — | — | P17 (`tests/media-cep-compatibility.test.js` green), P10 (`P7`'s element-identity probes still live) |
| `jsx/**` — **not edited** | — | — | P17, and clause 3.18 by inspection of the change set |
