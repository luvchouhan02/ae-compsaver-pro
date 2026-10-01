# Master Prompt 03 — Make Tools Responsive; Fix Paste Image and Crop

Copy this entire file into a **new Kiro session**. Solve only this issue.

## Prompt
Repair only CompSaver **Problem 3: toolkit clicks feel delayed, Paste Image and Crop are slow/unreliable, and no tool may remain loading or silently fail**. Do not redesign the Toolkit or refactor unrelated template/media/render code. Do not install packages or generate a broad Spec. Read `Agent.md`, mandated skills, `docs/architecture.md`, `docs/extendscript_rules.md`, `js/ui/paste.js`, `js/toolkit/toolkit.js`, `js/core/bridgeRegistry.js`, the bridge adapter/wrapper, and Crop host code `jsx/text.jsx::toolkitCropPrecomp` plus shared-precomp checks. `.jsx` changes must remain strict ES3.

### Confirmed evidence to verify
- `handlePasteBlob` uses `fs.writeFileSync` on the CEP UI thread; fallback creates a binary string byte-by-byte before base64 writing. Both scale badly with large images.
- Paste has no explicit in-flight guard, bridge timeout, cancellation/late-result protection, guaranteed temp cleanup, or visible recovery action; repeated initialization can duplicate the global paste listener.
- Crop click currently performs a shared-precomp bridge check and then a separate synchronous `toolkitCropPrecomp` call. Crop traverses AE layers/properties and `sourceRectAtTime` synchronously.
- Several tool callers use direct `csInterface.evalScript`; error sentinels, timeouts, disabled-button restoration, and structured responses are not uniformly enforced.

### Baseline and audit
Measure click-to-visual-feedback, CEP blocked time, bridge wait, host execution, and completion for every visible Toolkit button. Deep-profile only operations exceeding the budget; prioritize Paste and Crop. Test Explorer image, clipboard screenshot, 4K/8K PNG, rapid repeated paste, normal/shared precomps, many selected precomps, text/shape/footage/precomp layers, expressions, 2D/3D, parented, locked, and separated dimensions. Record actual failures before edits.

### Required implementation
1. Every tool must acknowledge input within 100 ms with pressed/busy feedback while keeping navigation and scrolling responsive. Completion may take longer in AE; do not fake completion or allow double execution.
2. Make clipboard initialization idempotent and disposable. Use one named paste handler, an operation token/lock, and ignore stale callbacks after panel disposal. Preserve normal text paste by preventing default only after a supported image is accepted.
3. Replace synchronous temp writes with `fs.promises.writeFile`/callback-based writing. Avoid byte-by-byte binary strings; use Buffer/chunk-safe conversion when Node is available and a bounded fallback when only CEP FS exists. Generate collision-safe temp names and delete temporary files after import on success, error, and timeout.
4. Route changed calls through the existing bridge registry/adapter or a small shared bounded-call helper: validate arguments, classify `EvalScript error.`/`undefined`, apply operation-specific timeout, return structured success/error, restore controls in one finalizer, and suppress late callbacks. Do not blanket-migrate unrelated bridge calls.
5. Optimize Crop without changing geometry semantics: preflight unsupported/locked/3D/parented/shared sources once; cache repeated property/bounds reads; avoid duplicate source-comp processing; keep one balanced undo group; preserve keyframes/expressions; return warnings and timings. Combine redundant preflight/action work only if the shared-precomp decision UX remains correct.
6. Audit every Toolkit action for stuck disabled/loading state and silent parse failure. Fix common infrastructure first; touch an individual tool only when measured evidence shows its own algorithm is slow/broken.
7. All failures must state cause and recovery (retry/change selection), never leave AE or CEP busy, and never leak AE object references. Preserve bridge contracts or update registry/tests coherently.

### Hard acceptance gates
- No CEP main-thread task over 50 ms caused by writing a pasted image; 4K/8K paste shows feedback ≤100 ms and imports exactly once. Rapid duplicate paste is rejected/queued deterministically; temp files do not accumulate.
- Crop produces identical bounds/centering on supported fixtures, processes each source comp once, balances undo groups on every return path, and cannot leave its button disabled. Shared-precomp cancel/duplicate/all paths still work.
- Every visible tool has a terminal success/error/timeout state and remains usable on the next click. Report per-tool baseline/after timing; do not call an inherently heavy AE operation “instant”—separate instant feedback from host completion.

### Validation
Run `npx jest tests/toolkit-contract.test.js tests/contract-registries.test.js tests/bridge-registry-adapter.test.js tests/bridge-timeout.test.js tests/cep-compat.test.js --runInBand`. Then complete the manual matrix above inside AE, including forced missing temp permissions, malformed bridge result, timeout/late callback, no active comp, no selection, and close panel during operation. Fix failures before stopping.

Finish with changed files, timing table, behavior preserved, and unresolved AE limitations. Do not absorb template-grid, startup, or render-queue work into this session.