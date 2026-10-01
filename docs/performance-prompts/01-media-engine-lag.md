# Master Prompt 01 — Fix Media Engine Lag

Copy this entire file into a **new Kiro session**. Solve only this issue.

## Prompt
You are repairing only CompSaver **Problem 1: Media Engine import, thumbnail generation, and hover preview lag**. Work directly in the current CEP extension; do not create a Spec, do not redesign the UI, do not solve the other five performance problems, and do not install dependencies. First read `Agent.md`, the four mandated skill files, `docs/architecture.md`, and `docs/extendscript_rules.md`. Preserve CEP/older-Chromium compatibility and ES3 in every `.jsx` file. Keep all user-visible behavior and library compatibility.

### Confirmed evidence to verify before editing
- `js/core/fastMediaEngine.js::importMediaFile` inserts one record and calls category/grid rebuilding for every imported item; `importMediaFolder` repeats this every 100 ms.
- Image “thumbnails” are full-size file copies. Video frame extraction uses native dimensions and PNG data URLs, causing large decode/canvas/base64 allocations.
- FFmpeg callbacks use synchronous fs operations and query `.card[data-id="safeName"] .card-thumb`, while `js/templates/templates.js::renderCards` emits `#tpl-<uuid>` and `.thumb-img`; completed work can fail to patch the card.
- `processBackgroundCopy` can persist a record whose render fields are nested under `metadata`, while warm rendering expects top-level fields.
- Hover creates and destroys a video decoder on each hover. Existing scheduler and terminal-regression tests must be preserved.

### Baseline first
Add temporary/permanent lightweight `performance.now()`/PerfEvents measurements only where useful. Measure 1 file, a 50-file mixed folder, and if practical a generated 500-record catalog: picker return, optimistic card visibility, copy, thumbnail, proxy, main-thread long tasks, queue depth, peak simultaneous FFmpeg processes, and failed-to-patch cards. Record results before changing behavior; do not leave noisy per-hover console logging enabled in production.

### Required implementation
1. Batch folder discovery and optimistic state insertion; update category counts once and render at most once per animation frame/batch, not once per file. Do not re-render the whole grid if a keyed card can be inserted/patched.
2. Use bounded backpressure: filesystem copy concurrency max 2, thumbnail/decode max 1–2, FFmpeg/transcode max 1. Deduplicate jobs by stable template ID/path and expose terminal `ready` or `failed` state; no unbounded timers/processes.
3. Generate bounded thumbnails (target about 320×180, preserving aspect ratio). Never copy a multi-megapixel original as the thumbnail. Scale video canvas before `toDataURL`; release video/canvas/blob references on success, error, timeout, and panel disposal.
4. Remove synchronous `existsSync/statSync/readFileSync/writeFileSync` work from hot callbacks where async equivalents are available. Keep streamed copies and Scheduler ownership.
5. Normalize the persisted media entry to the same top-level `LibraryIndex` shape consumed by warm startup. Use one stable `id`; fix DOM patching to `#tpl-<escaped/stable-id>` and `.thumb-img` or a shared keyed helper—never use the display name as identity.
6. Keep one controlled hover-preview resource, with hover intent, cancellation token, proxy preference, decode timeout, and cleanup. Reuse safely where CEP supports it; never decode multiple hover videos concurrently.
7. Preserve originals, metadata, imports, category behavior, proxy caching, cancellation/disposal, and missing-FFmpeg fallback. No lossy migration of existing libraries.

### Hard acceptance gates
- Optimistic feedback appears within 100 ms after picker result and the panel remains scroll/click responsive during a 50-file import.
- One batch causes O(1) category/grid refreshes per frame/batch, not O(file count); simultaneous copy/decode/transcode work respects the caps.
- Every imported item reaches `ready` or visible `failed`; no permanent pending card, selector miss, duplicate index entry, or orphan FFmpeg process.
- Generated thumbnails are bounded; warm reopen renders the same metadata/path as the import session; hover never plays more than one decoder.
- Compare before/after timings and report p50/p95 where repeatable, long tasks over 50 ms, memory/process observations, modified files, and residual codec limits.

### Validation
Run targeted, non-watch checks from the workspace using Windows-safe commands: `npx jest tests/performance/fast-media-terminal-regression.test.js tests/performance/scheduler-lanes.property.test.js tests/optimistic-card-placeholder.property.test.js tests/single-card-patch-job-completion.property.test.js --runInBand`. Then manually test PNG/JPEG, MP4, MOV/AVI fallback, missing FFmpeg, duplicate names, cancel picker, rapid hover changes, close/reopen during work, and a 50-file folder. Fix failures before stopping. Do not run the entire suite unless these pass and a shared module changed.

Finish with a concise implementation report and evidence. If a required change expands into generic template virtualization/startup work, stop at the narrow interface and state that Prompt 04 or 02 must be run next; do not silently absorb that scope.