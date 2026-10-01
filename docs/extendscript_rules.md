# ExtendScript Host Guidelines & ES3 Constraints

This document outlines the syntax constraints, environment quirks, memory safety rules, and scripting standards for After Effects ExtendScript (JSX) files.

---

## 1. Strict ES3 Engine Syntax Limits

After Effects runs JSX scripts inside an obsolete JavaScript engine based on the **ES3 (ECMAScript 3)** standard. Any modern JS syntax will cause silent crashes, compilation errors, or runtime freezes.

### 🚫 STRICTLY FORBIDDEN (Will crash the JSX engine):
* **No block-scoped declarations**: Do `NOT` use `let` or `const`.
* **No arrow functions**: Do `NOT` use `(x) => x`.
* **No destructuring**: Do `NOT` use `var { activeItem } = app.project;`.
* **No spread/rest operators**: Do `NOT` use `[...layers]` or `function foo(...args)`.
* **No template literals**: Do `NOT` use `` `Layer ${name}` ``. Use string concatenation: `"Layer " + name`.
* **No native modern Array methods**: Do `NOT` use `.forEach()`, `.map()`, `.filter()`, `.reduce()`, `.indexOf()`, `.find()`, or `.includes()` unless a explicit polyfill is loaded.
* **No native promises or async/await**: Do `NOT` use `Promise`, `async`, or `await`.
* **No JSON native support**: Do `NOT` use `JSON.parse` or `JSON.stringify` directly without loading a JSON polyfill script first.

### ✅ MANDATORY (Allowed ES3 syntax):
* **Variable Declaration**: Always use `var`. Declare all variables at the top of the function scope.
* **Loops**: Use traditional `for (var i = 0; i < len; i++)` loops.
* **Functions**: Use standard named or anonymous function syntax: `function myFunction(param) { ... }`.
* **String Concatenation**: Use `+` operator.

---

## 2. Namespace Protection (Global Isolation)

All ExtendScript files loaded into After Effects share a single global execution namespace. If you declare a global variable like `var layers = ...` or a function `function duplicate() { ... }`, it can overwrite variables in other installed extensions and crash AE.

### Rules for Namespace Safety:
1. **The Global Guard**: Wrap all your JSX functions inside a single, unique global object representing your plugin.
   ```javascript
   // At the top of your JSX file:
   var CompSaverGlobal = CompSaverGlobal || {};
   CompSaverGlobal.timeline = CompSaverGlobal.timeline || {};
   ```
2. **Local Scoping**: Wrap helper code in Immediately Invoked Function Expressions (IIFE) to prevent local variables from leaking.
3. **No loose variables**: Every variable declaration inside a function must be explicitly prefixed with `var`. If you omit `var`, the variable leaks to the global window scope.

---

## 3. Undo Group Management

A professional extension should never pollute the user's After Effects history with 50 individual commands when they click a single button.
* **Rule**: Wrap any action that modifies layers, compositions, or keyframes inside an Undo Group.
  ```javascript
  app.beginUndoGroup("CompSaver: Duplicate Layers");
  try {
      // Perform actions here
  } catch (err) {
      // Handle error
  } finally {
      app.endUndoGroup();
  }
  ```

---

## 4. Error Handling and Bridges

ExtendScript runtime errors do not crash the CEP panel; they fail silently, leaving the user with a frozen UI.
* **Rule**: Every JSX function called from the CEP Frontend must wrap its code inside a `try-catch` block.
* **Rule**: Serialize both successful results and errors into a JSON string to be returned to the frontend.
  ```javascript
  function mySafeAction(jsonArgs) {
      try {
          var args = JSON.parse(jsonArgs);
          // execute action ...
          return JSON.stringify({ success: true, data: result });
      } catch (err) {
          return JSON.stringify({ success: false, error: err.toString(), line: err.line });
      }
  }
  ```

---

## 5. Garbage Collection & Memory Leaks

ExtendScript has a weak garbage collector. Referencing multiple heavy After Effects layers or compositions in variables can quickly lead to memory leaks or application slow-down.
* **Rule**: Nullify references to large AE objects (like compositions or layers) at the end of functions:
  ```javascript
  var activeComp = app.project.activeItem;
  // perform tasks...
  activeComp = null; // Free reference for GC
  ```
