# CompSaver — Coding Conventions

## General

- inclusion: always

## JavaScript (Panel — `js/`)

### Language Level
- Target: ES2020 (Chromium 88)
- No ES modules (`import`/`export`) — use classic `<script>` loading
- Expose public APIs as globals
- End every module with CommonJS dual-load guard:
  ```js
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { functionName };
  }
  ```

### Naming
- Functions: `camelCase` — `runToolkitAction`, `showToast`
- Constants: `UPPER_SNAKE_CASE` — `TOAST_DURATION`, `MAX_RETRIES`
- DOM IDs: `kebab-case` — `btn-sidebar-templates`, `comp-monitor`
- CSS classes: `kebab-case` — `toast-surface`, `sidebar-item`
- Data attributes: `data-kebab-case` — `data-toolkit-action`, `data-mode`

### Error Handling
- `callHost` returns a Promise that never rejects
- Always check `result.ok` before using `result.result`
- Show user-facing errors via `showToast(msg, 'error')`
- Never silently swallow exceptions in UI event handlers

### DOM
- Query by ID first (`document.getElementById`), class only when needed
- Never use `innerHTML` for user-supplied content
- Always clean up event listeners on view teardown

## ExtendScript (Host — `jsx/`)

### Language Level
- ECMAScript 3 ONLY
- `var` declarations, `function` declarations/expressions
- NO: `const`, `let`, arrow functions, template literals, classes, destructuring, `for...of`, getter/setter literals, spread, rest, default params

### Undo Groups
```jsx
app.beginUndoGroup("Action Name");
try {
    // ... changes ...
} catch (e) {
    // handle error
} finally {
    app.endUndoGroup();  // MUST be called on every path
}
```

### Bridge Returns
- Success (silent): `"true"`
- Success (message): `"OK:message"`
- Error: any other non-empty string describing the failure
- Never return `undefined`, empty string, or non-encoded values
- All string returns must be Bridge_Payload encoded

### User Input Safety
- Always receive user strings as Bridge_Payload arguments
- Decode with `decodeBridge()`
- Parse JSON with `jsonParse()` from `jsx/core.jsx`
- NEVER pass to `eval()` or interpolate into code strings

## CSS

### Token Usage
- Use `var(--cs-*)` design tokens for all colors, radii, fonts
- No literal hex colors in redesigned component stylesheets
- Exempt: `transparent`, `currentColor`, `inherit`, `none`, `0`, `50%`
- Every `backdrop-filter` needs `-webkit-backdrop-filter` pair

### Import Order (Locked)
`style.css` imports exactly 11 modules in this fixed order:
```
base, header, toolkit, effects, flow, templates, colorflow, responsive, textanim, layout, polish
```
Changing this order will fail contract tests.

## Testing

### Adding Tests
- Every new JS module must have at least 1 test
- Every new toolkit action: test success + at least 1 failure path
- Never add `.skip`, `.only`, `xit`, `xtest`, `xdescribe` to existing tests
- Test count must remain ≥ 1,587 tests across ≥ 130 suites

### Property-Based Tests
- Use `fast-check` for bridge encoding, state transitions, data round-trips
- Arbitrary generators in `tests/helpers/`
