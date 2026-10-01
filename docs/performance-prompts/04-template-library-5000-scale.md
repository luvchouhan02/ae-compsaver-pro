# Master Prompt 04 — Scale Template Library to 1,000–5,000+

Copy this entire file into a **new Kiro session**. Solve only this issue.

## Prompt
Repair only CompSaver **Problem 4: the library lags at ~150 templates and must stay smooth at 1,000–5,000+ while switching sections/categories, searching, and scrolling**. This is a data/index/rendering performance task, not a visual redesign. Do not alter AE save/render algorithms, media transcoding, or Toolkit. Do not install a framework/virtual-list dependency; implement a small CEP-safe vanilla JS solution. Read `Agent.md`, mandated skills, architecture rules, `js/templates/templates.js`, `js/core/persistence.js`, state/mutation helpers, grid CSS, and existing template/responsive tests.

### Confirmed evidence to verify
- `getSectionTemplates` scans all records. `getSectionCategories` performs repeated array `indexOf` checks. `buildCategoryPanel` rescans section records for every category, making counts O(N×C).
- `setCategory` rebuilds tabs, rebuilds the panel, rescans/filter/searches, and replaces the entire grid.
- `renderCards` builds HTML for every matching template and assigns one giant `innerHTML`; `content-visibility:auto` defers some paint but not string creation, DOM nodes, image requests, listeners, or retained memory.
- Timed smooth `scrollIntoView` and full reattachment of hover previews can add layout/listener work.

### Build a reproducible baseline first
Use deterministic in-memory fixtures at 150, 1,000, and 5,000 records across all sections/categories without modifying the user’s real library. Measure startup hydration, section/category switch p50/p95, search input-to-results, first viewport render, DOM node count, long tasks >50 ms, scroll FPS/jank, image requests, and heap after 20 switch cycles. Capture first and last card correctness.

### Required implementation
1. Build one normalized catalog/index in a single pass: stable ID/path map, section → ordered IDs, section+category → ordered IDs, favorite sets, and one-pass counts. Mutations (add/rename/move/delete/favorite) must patch indexes incrementally instead of forcing full scans.
2. Separate data selection from DOM rendering. Category selection should update active UI classes/counts without rebuilding static controls; search should be normalized once per record and debounced about 100–150 ms with cancellation/versioning.
3. Replace all-card rendering with a CEP-safe windowed/virtual grid. Keep only viewport rows plus overscan mounted, preserve stable total scroll height, responsive column/card calculations, keyboard/focus behavior, selection, context actions, drag/bulk actions, hover preview, and scroll position per section/category.
4. Use delegated grid events and one hover-preview binding, not per-card listeners after every render. Patch a visible card by stable ID; update offscreen state so it is correct when remounted.
5. Batch DOM reads, then writes; schedule bounded rendering with `requestAnimationFrame`; avoid smooth auto-scroll during category rebuild and avoid layout reads inside card loops. Provide a fallback for older CEP Chromium APIs.
6. Keep UI state across switches: current category/search, selection, focus where possible, and scroll offset. No blank gaps when rapidly scrolling or jumping to the last item.
7. Preserve exact existing sort order, favorites, all categories, card actions, path/import contracts, responsive layouts, empty states, and current public function contracts unless all callers are updated coherently.

### Hard acceptance gates
- At 5,000 records, mounted card nodes remain bounded to viewport+overscan (target under 200 in ordinary panel sizes), not proportional to total records.
- On the same machine, category/section switch p95 target ≤100 ms for cached/indexed data, interaction feedback ≤100 ms, no repeated >50 ms render task, and sustained scrolling visually near 55–60 FPS where CEF permits.
- Search results, counts, order, first/last cards, favorites, bulk selection, context menus, import, and hover remain correct after add/rename/move/delete and 20 rapid switches; heap/node counts return near baseline rather than growing each cycle.
- Report fixture shape, before/after p50/p95, DOM/heap/long-task evidence, changed files, and any CEP frame-rate limit.

### Validation
Run `npx jest tests/templates-contract.test.js tests/responsive-grid.test.js tests/collection-controller.test.js tests/library-index-insert-at-head.property.test.js tests/library-single-mutation-locality.property.test.js tests/optimistic-card-placeholder.property.test.js tests/single-card-patch-job-completion.property.test.js tests/thumbnail-cache-busting.property.test.js --runInBand`. Manually test 180 px/narrow, medium, and wide panels at all three fixture sizes, rapid wheel/scrollbar drag to bottom, resize during scroll, category/search switching, bulk mode, and all card actions. Fix regressions before stopping.

Do not solve thumbnail file generation here: only bound which visible cards request assets and expose clean hooks. Prompt 05 handles thumbnail correctness/decoding.