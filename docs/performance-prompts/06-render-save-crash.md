# Master Prompt 06 — Reduce Render Time and Prevent AE Crashes

Copy this entire file into a **new Kiro session**. Solve only this high-risk issue, using a copy of real projects/templates.

## Prompt
Repair only CompSaver **Problem 6: template save/thumbnail/preview rendering is very slow and can crash After Effects**. This is high-risk destructive host logic: preserve the live project above speed, make reversible edits, never test on the only copy of user data, and do not change unrelated UI/grid/tools. Do not install dependencies or create a giant Spec. Read `Agent.md`, architecture/ES3 rules, `js/core/saveOrchestrator.js`, actual save callers in `js/templates/templates.js`, background queue in `js/textanim/textanim.js`, and `jsx/templates_save.jsx` including `coreSaveLayerType`, `renderFrameToPng`, and `renderTemplateThumbnail`. Keep JSX strict ES3 and all undo/dialog groups balanced.

### Confirmed evidence to verify
- The safe save sequence requires a protective full-project write, temporary comp/reduce, template full-project write, and exactly one reopen after entering the destructive window. These operations are intrinsically expensive but protect the live project.
- `saveOrchestrator.js` encodes ≤2 writes, restoration, and background render-job rules, while `jsx/templates_save.jsx::coreSaveLayerType` reimplements the destructive sequence; divergence increases crash risk.
- Background thumbnail rendering imports the complete saved `project.aep` into the live project, renders a frame, then removes it. Large/deep projects, plugins, missing assets, and repeated imports can spike AE memory.
- A serialized queue, timeout/retry logic, PNG validation, dialog suppression, and 8-bpc temporary rendering already exist and must not be weakened.

### Diagnose by phase before optimizing
Instrument structured timings and memory observations for: protective save, temp comp/layer copy, property/keyframe scan, reduceProject, template save, footage collection, reopen, queue delay, scratch AEP import, frame render, cleanup, and retry. Reproduce with small comp; huge/deep nested comp; 100+ layers; expressions/plugins; missing footage/fonts; 8/16/32-bpc; unsaved/read-only project; and repeated saves. Record the exact last completed phase for every failure/crash-like hang; do not add unbounded logs.

### Required implementation
1. Establish one canonical, auditable save state machine and invariants: max two full-project writes, no reduce before protective save succeeds, destructive-window flag, exactly one reopen after entering it, one balanced undo group, balanced dialog suppression, and restoration on every error. Reuse logic only through an ES3/CEP-safe interface; never load CommonJS code directly into ExtendScript.
2. Return the essential save result as soon as the template is safely written and the live project restored. Thumbnail/preview generation must remain non-essential background work and must never hold the save button/loading state after essential completion.
3. Serialize all heavy AE render jobs (concurrency 1) with stable job IDs, deduplication, queue cap/backpressure, per-phase timeout policy, max attempts, exponential/bounded retry, and a circuit breaker after repeated crashes/timeouts. A failed job must advance the queue and surface Retry/Skip; no infinite retry or wedged `previewRunning`.
4. Reduce live-project pressure: render bounded thumbnail dimensions/work duration, release imported folders/comps/files/references in `finally`, restore bits-per-channel/viewer state, and do not start background rendering while another destructive save/import is active or the panel is disposing.
5. Prefer rendering a saved AEP outside the live project only after a capability check. An optional `aerender` path must be feature-flagged, use Adobe’s discovered executable (no bundled binary), bounded to one process, quote Windows paths safely, enforce timeout/kill/cleanup, validate PNG output, and fall back to the guarded current path. Do not make external rendering mandatory.
6. Avoid recursive repeated property scans and duplicate layer copies where measured; cache safe scalar results, null heavy AE references, and never retain stale objects across `app.open`.
7. Preserve metadata/thumbnail cache updates, missing-asset handling, preview settings, queue ordering, transparent user recovery, and current file formats. Never trade crash safety or project restoration for a benchmark.

### Hard acceptance gates
- Forced failure at every phase leaves the original project open/intact when restoration is possible, with ≤2 writes, exactly one reopen only after reduce, balanced undo/dialog state, and a usable next operation.
- Essential save completion is independent of render completion. Queue concurrency/process count is 1; every job terminates ready/failed/skipped; timeout/retry cannot wedge the queue or apply a stale callback.
- Complete a 50-save/render soak on copies without unbounded AE/CEP memory growth, orphan `aerender`/FFmpeg processes, blank/corrupt accepted PNGs, or panel crash. Record timing and memory trend; if AE itself crashes, preserve logs and reduce the fixture instead of repeatedly risking data.
- Report phase-by-phase before/after, crash reproduction status, fallback behavior, files changed, invariants proven, and residual plugin/AE limitations.

### Validation
Run `npx jest tests/save-orchestrator.test.js tests/save-full-project-write-bound.test.js tests/save-live-project-survival.test.js tests/save-render-background-only.test.js tests/save-thumbnail-queue.test.js tests/save-background-failure-surfacing.property.test.js tests/save-loading-exit-on-essential.property.test.js tests/background-queue-fifo.property.test.js tests/background-queue-fail-advance.test.js tests/background-jobs-saved-project.test.js --runInBand`. Then run the manual fixture/failure matrix and 50-operation soak on disposable project copies. Fix all deterministic failures before stopping; never automate destructive testing against an unsaved production project.

Finish with evidence, not promises. If isolated rendering cannot be safely discovered on the installed AE version, keep the guarded serialized fallback and clearly document that limit.