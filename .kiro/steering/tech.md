# CompSaver — Technical Architecture & Conventions

## 1. Dual Runtime Architecture
CompSaver operates across two distinct JavaScript environments running concurrently:

### A. Panel Frontend (CEP / Chromium 88+)
- **Environment:** Embedded Chromium runtime in Adobe CEP 11.
- **Language Level:** ES2020 syntax (async/await, optional chaining, nullish coalescing).
- **Module System:** Classic `<script>` tag loading (No ES module `import`/`export` support in CEP HTML shell).
- **Testing Interoperability:** All panel modules must expose global identifiers and end with a CommonJS dual-load guard:
  ```javascript
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { MyService, helperFunction };
  }
  ```

### B. Host Backend (After Effects ExtendScript)
- **Environment:** Adobe After Effects scripting engine.
- **Language Level:** Strict ECMAScript 3 (ES3).
- **Prohibited Syntax:** Absolutely NO `const`, `let`, arrow functions, template literals (`` ` ``), default parameters, destructuring, classes, or `for...of` loops.
- **Required Syntax:** Traditional `var`, `function`, prototype patterns, and ES3 polyfills provided in `jsx/core.jsx`.
- **Undo Integrity:** Every operation modifying the project must wrap changes in an undo group:
  ```javascript
  app.beginUndoGroup("Operation Name");
  try {
    // Modifications
  } catch (e) {
    // Handle failure
  } finally {
    app.endUndoGroup();
  }
  ```

## 2. Panel-Host Bridge Protocol
Communication between CEP and ExtendScript uses a reliable hex-encoded string protocol:
- **Encoding:** `encodeBridge(str)` translates strings into 4-character UTF-16 hex values.
- **Safety:** Prevents command injection, quotation breakage, and unicode mangling. User strings must **never** be interpolated directly into ExtendScript evaluation strings.
- **Execution:** Calls are executed via `CSInterface.evalScript` encapsulated in `callHost` / `ToolBridge.call` promises with strict 30,000ms timeouts and circuit breakers.
- **Bridge Returns:**
  - Success without payload: `"true"`
  - Success with message: `"OK:message"`
  - Error: Any string describing failure, decoded and mapped to `result.ok = false`.

## 3. High-Performance Design Patterns
- **Template Library Virtualization:** Replaces monolithic `innerHTML` rendering with a windowed virtual grid (`js/templates/virtualGrid.js`), scaling cleanly past 5,000 items.
- **Progressive Hydration:** Instant UI paint on panel open using persistent localStorage/file caches, followed by asynchronous non-blocking reconciliation.
- **Media Engine Bounded Execution:** Asynchronous thumbnail generation (standardized at 320×180) to prevent RAM exhaustion and AE thread stalls.
- **Non-Blocking File I/O:** Asynchronous temp file operations via Node.js APIs (`fs.promises` or callback pattern) rather than blocking `fs.writeFileSync`.

## 4. Testing & Verification Standards
- **Framework:** Jest 29.7.0 with fast-check 3.22.0 property-based testing.
- **Baseline Invariants:** Regression test suite maintaining 1,580+ tests across 130+ suites.
- **DOM & Token Contracts:** DOM IDs and CSS class names are strictly contract-tested against `tests/fixtures/class-contract.baseline.json`.
- **Test Integrity:** Never disable or skip tests using `.skip`, `xit`, or `fit`.
