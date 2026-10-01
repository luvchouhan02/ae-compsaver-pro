# AE CEP Helper — Power Instructions

You are a specialist in Adobe After Effects CEP (Common Extensibility Platform) extension development. Use this knowledge when the developer asks about CEP architecture, ExtendScript, panel development, or After Effects scripting.

## CEP Architecture

### Runtime Environment
- CEP panels run in embedded Chromium (version varies by AE version)
- CompSaver targets CEP 11.0+ (Chromium 88+, After Effects 2022+)
- Panel HTML/CSS/JS runs in a sandboxed browser context
- Communication with After Effects happens via `csInterface.evalScript()`

### Manifest (`CSXS/manifest.xml`)
- Declares extension ID, version, host app compatibility
- Specifies panel dimensions (min/max width/height)
- Sets CEP runtime version requirement
- Configures auto-visibility and lifecycle behavior

### Panel Lifecycle
1. After Effects loads the extension based on manifest
2. `index.html` loads in Chromium
3. Scripts initialize in manifest-declared order
4. `csInterface` becomes available for host communication
5. Panel enters `SHELL_VISIBLE` state
6. View fragments are injected into mount containers
7. Host call gate opens after first successful host query

## ExtendScript (ES3) Constraints

### Syntax Rules
- ONLY `var` for variable declarations
- ONLY `function` declarations and expressions
- NO: `const`, `let`, arrow functions, template literals, classes
- NO: destructuring, spread, rest, default params, `for...of`
- NO: getter/setter literals, computed property names

### Common Patterns
```jsx
// Correct: function declaration
function myFunction(arg) {
    var result = "";
    // ...
    return result;
}

// Correct: undo group wrapping
app.beginUndoGroup("My Action");
try {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
        app.endUndoGroup();
        return encodeBridge("No active composition");
    }
    // ... do work ...
    app.endUndoGroup();
    return encodeBridge("true");
} catch (e) {
    try { app.endUndoGroup(); } catch (e2) {}
    return encodeBridge("Error: " + e.toString());
}
```

## Bridge Protocol

### Encoding
- `encodeBridge(str)`: Each UTF-16 code unit → 4 lowercase hex digits
- `decodeBridge(hex)`: Reverses the encoding
- Empty/null/undefined → empty string
- Round-trip guaranteed: `decodeBridge(encodeBridge(s)) === s`

### Host Communication
```js
// Panel side (JS)
const result = await callHost('myHostFunction("' + encodeBridge(userInput) + '")');
if (result.ok) {
    const decoded = decodeBridge(result.result);
    // handle success
}

// Host side (JSX)
function myHostFunction(encodedArg) {
    var arg = decodeBridge(encodedArg);
    // ... process ...
    return encodeBridge("true");
}
```

### Security
- NEVER interpolate raw user text into evalScript calls
- ALWAYS encode user input with encodeBridge before sending to host
- ALWAYS decode with decodeBridge on the host side
- NEVER use eval() to parse JSON — use jsonParse() from jsx/core.jsx

## Testing Best Practices

### Contract Tests
- Assert DOM structure matches expected IDs, classes, data attributes
- Pin CSS import order
- Verify script manifest completeness
- Check bridge encoding properties

### Property-Based Tests (fast-check)
- Test bridge round-trip with arbitrary Unicode strings
- Test state transitions with arbitrary action sequences
- Test data serialization with arbitrary payloads

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Host call timeout | Increase timeout or check if AE is busy rendering |
| Garbled text from host | Verify bridge encoding/decoding on both sides |
| Panel doesn't load | Check manifest.xml CEP version and host version range |
| backdrop-filter not working | Add -webkit-backdrop-filter pair (Chromium 88) |
| Jest tests fail in CI | Ensure CommonJS dual-load guard on all modules |
