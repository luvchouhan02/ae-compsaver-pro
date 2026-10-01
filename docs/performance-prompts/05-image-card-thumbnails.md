# Master Prompt 05 — Fix Late, Wipe-Like, and Missing Image Thumbnails

Copy this entire file into a **new Kiro session**. Solve only this issue.

## Prompt
Repair only CompSaver **Problem 5: image-section cards/thumbnails appear very late, reveal with a slow wipe-like effect, lower cards remain blank/loading, and image cards do not behave like comp cards**. Do not redesign cards or solve generic startup/render/tool issues. If Prompt 04 virtualization exists, integrate with it; otherwise implement only the minimum bounded visibility loader and do not build a second competing grid system. Read project rules, `js/templates/templates.js::renderCards/renderIcons`, `js/core/fastMediaEngine.js`, persistence/index normalization, image/card CSS, and thumbnail tests.

### Confirmed evidence to verify
- Normal `renderCards` thumbnail images have neither `loading="lazy"` nor `decoding="async"`; many file URLs can fetch/decode together. `renderIcons` has lazy loading but no complete visibility/error state strategy.
- Cards rely on `content-visibility:auto` and `contain-intrinsic-size`, which can produce progressive reveal/compatibility problems in older CEP Chromium and does not prevent HTML/DOM/image work.
- Image media may use full-resolution originals as thumbnails. FFmpeg completion selectors/classes do not match rendered cards, so generated assets may never patch.
- Media index inserts may nest render fields under `metadata`, while warm render reads top-level `thumbnail/type/mediaFile`; valid thumbnails can appear missing after reopen.
- There is no explicit thumbnail state machine with load/error timeout, retry, corrupt/missing fallback, or guarantee that each visible card reaches a terminal state.

### Baseline first
For cold and warm OS cache, measure first-visible-thumbnail p50/p95, all-visible-settled time, concurrent image decodes/requests, main-thread long tasks, full-resolution bytes decoded, blank cards after scrolling directly to bottom, and states after missing/corrupt thumbnails. Test image, icon, comp, footage, and media cards at 150/1,000/5,000 records. Inspect CSS for opacity/mask/transform/transitions causing the reported wipe before removing anything.

### Required implementation
1. Define one normalized card-thumbnail contract at index hydration/import: stable ID, resolved absolute/URL path, `thumbStatus` (`placeholder|loading|ready|failed`), dimensions/version token, and media fields at predictable top-level keys. Migrate in memory compatibly; never destroy old metadata.
2. Load only visible/near-visible thumbnails. Prefer the Prompt 04 virtualizer hook; otherwise use `IntersectionObserver` with a throttled scroll/resize fallback for older CEP. Cap concurrent decode/load work (for example 4) and cancel/ignore work for unmounted/stale cards.
3. Emit explicit width/height or aspect-ratio space, `decoding="async"`, empty alt for decorative thumbnails, and lazy behavior where supported. Assign `src` only when scheduled; use cache-busting based on real mtime/version, not `Date.now()` on every render.
4. Generate/use bounded thumbnail files rather than originals. Preserve aspect ratio and avoid upscaling. Never decode a 4K/8K source merely to paint a small card when a cached thumbnail can exist.
5. Replace `content-visibility` as the sole loading mechanism with deterministic placeholders and compatibility-safe layout containment. Remove any accidental long wipe/mask/opacity transition; a short optional opacity transition must not delay visibility and must honor reduced motion.
6. Patch cards by stable ID and actual `.thumb-img` contract. On load/error/timeout, move to a terminal ready/failed UI, release queue capacity, and allow one bounded retry after regeneration/file-change—no infinite retry or permanent spinner.
7. Preserve comp/image visual parity, card actions, favorites, hover previews, responsive dimensions, and warm cache. Offscreen cards must load correctly when scrolled into view, including direct scrollbar jump to the final row.

### Hard acceptance gates
- Every visible card reaches `ready` or `failed`; zero indefinite placeholders and zero missing lower rows after repeated top-to-bottom jumps.
- Only viewport+overscan assets are requested/decoded; concurrent work respects the cap; generated thumbnails are bounded. Warm-cache visible thumbnails target ≤200 ms p95 and cold first viewport target ≤500 ms on the same machine, with immediate placeholders and no UI freeze.
- No slow wipe, layout shift, duplicate requests after rerender, selector mismatch, stale thumbnail after replacement, or schema difference between immediate import and reopen.
- Report cold/warm before/after timings, request/decode count, bytes/dimensions, failed-state behavior, modified files, and codec/CEF limits.

### Validation
Run `npx jest tests/thumbnail-cache-busting.property.test.js tests/single-card-patch-job-completion.property.test.js tests/optimistic-card-placeholder.property.test.js tests/metadata-cache-currency.test.js tests/metadata-cache-malformed.test.js tests/library-index-roundtrip.test.js tests/responsive-grid.test.js --runInBand`. Manually test cold/warm cache, 4K/8K images, missing/zero-byte/corrupt thumbnail, renamed/replaced file, rapid scroll and direct bottom jump, narrow/wide resize, close/reopen, and reduced-motion. Fix failures before stopping.

Do not claim completion if only an animation was removed; prove that request/decode scheduling, schema, and terminal states are correct.