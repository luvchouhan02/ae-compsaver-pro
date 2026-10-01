# Master Prompt 02 — Make Panel Reopen and Startup Fast

Copy this entire file into a **new Kiro session**. Solve only this issue.

## Prompt
You are repairing only CompSaver **Problem 2: after closing the CEP panel, reopening it from Window > Extensions takes too long before templates become visible**. Work in one bounded implementation pass: no Spec/tasks explosion, no visual redesign, no dependency installation, and no work on media transcoding, tool algorithms, or AE rendering. Read `Agent.md`, mandated skills, `docs/architecture.md`, `js/main.js`, `js/core/state.js`, `js/core/persistence.js`, and `js/templates/templates.js` first. Preserve existing libraries and CEP/older-Chromium support.

### Confirmed evidence to verify
- `templates.js::loadTemplates` has a fast `LibraryIndex` path, but any validity mismatch or `_needsFullScan` waits for `getAllTemplates()` bridge scans for all roots before cards appear.
- Even the warm path assigns all entries, derives sections for every entry, rebuilds category UIs, filters, and renders the full matching grid.
- `main.js` loads the index and starts validation; `beforeunload` disposes lifecycle resources. Reopening may create a fresh CEF context, so in-memory state cannot be assumed.
- Persisted index serialization/parsing and validity-key computation can themselves become startup bottlenecks at 1,000–5,000 entries.

### Diagnose before changing architecture
Instrument a single startup trace with named phases: script/init, settings/root discovery, index file read, JSON parse/normalize, validity key, cache decision and exact miss reason, bridge scan per root, category/index build, first viewport render, background reconcile, and interactive-ready. Capture cold start, immediate reopen, reopen after one template mutation, corrupt index, and 150/1,000/5,000 deterministic records. Remove or gate noisy production logs.

### Required implementation
1. Make persisted `LibraryIndex` the source for immediate warm paint. Hydrate a normalized, versioned, compact record shape; do not expose raw/nested records directly to `renderCards`.
2. Separate **first usable viewport** from **disk reconciliation**. On a valid or usable stale index, show cached cards first, then validate changed roots/folders in the background and patch state incrementally. Never blank the grid while reconciling.
3. Replace expensive whole-tree validity work with a cheap manifest/root-generation strategy or equivalent incremental invalidation. Update that generation atomically on CompSaver-controlled create/rename/move/delete/import operations. External changes may trigger background reconciliation, not block first paint.
4. Make persistence atomic and crash-safe (temporary file + replace where applicable), schema-versioned, and tolerant of absent/corrupt/old records. Keep the last valid index until a replacement is fully written; never destroy the only usable cache on parse failure.
5. Build section/category lookup data in one pass during hydration and render only the initial viewport/bounded batch. Do not solve full virtualization here if Prompt 04 has not run; expose clean state/hooks for it and keep startup scope narrow.
6. Guard initialization and disposal so listeners/timers/queues are registered once per context and released on `beforeunload`. Late scan callbacks must not mutate a disposed or newer session.
7. Cold/no-cache startup must display a responsive shell immediately and perform scans without freezing; progressively publish safe batches if bridge contracts allow it. Preserve multi-root behavior and source paths.

### Hard acceptance gates
- Warm reopen with an unchanged 5,000-record index: panel interaction feedback ≤100 ms, first usable template viewport target ≤500 ms on the same test machine, and no `templates.scan` bridge call before first paint.
- One changed template does not force a blocking whole-library scan; unchanged roots remain cache hits. Corrupt/missing index degrades to responsive cold recovery with a clear state, not a blank/hung panel.
- No duplicate listeners, timers, records, stale-session updates, schema loss, or invalid path rendering across 10 close/reopen cycles.
- Report before/after phase timings, cache hit/miss reason, scan count, first-paint/interactive time, changed files, and any machine-dependent limits.

### Validation
Run `npx jest tests/performance/startup-containment.test.js tests/performance/app-lifecycle.property.test.js tests/library-index-roundtrip.test.js tests/library-index-full-scan-trigger.property.test.js tests/library-index-failed-update.property.test.js tests/library-single-mutation-locality.property.test.js tests/metadata-cache-roundtrip.test.js --runInBand`. Manually verify unchanged reopen, one add/rename/delete, multiple library roots, external folder edit, corrupt/truncated index, no library connected, and 10 reopen cycles. Fix all regressions before stopping.

Do not claim success from unit tests alone: real After Effects CEP timing evidence is required. If template scrolling/category switching remains slow after first paint, report it as Prompt 04 scope rather than broadening this repair.