// ============================================================
// tests/helpers/loadHelpers.js
// Sandbox shim that loads the ExtendScript engine helpers into Node so Jest
// can exercise their pure / extraction-friendly logic against AE-DOM fakes.
//
// Feature: engine-robustness-hardening
//
// Why this exists
// ---------------
// The engine (jsx/*.jsx) has no module system: every function is a bare global
// declaration concatenated by the ExtendScript `//@include` preprocessor. There
// is no `module.exports` and no `require`. Node therefore cannot `require()` the
// helpers directly. This shim:
//
//   1. Reads the target .jsx source FRESH on every call (see design note below),
//   2. Strips ExtendScript-only preprocessor directives (`//@include`, `#include`,
//      `#target`, etc.) that Node's VM cannot parse,
//   3. Evaluates the remaining top-level function declarations inside a
//      `vm` sandbox whose globals are the injected AE-DOM fakes (app, CompItem,
//      dependency functions such as jsonStringify, ...),
//   4. Returns the sandbox context plus a `get(name)` accessor so tests can pull
//      out and call individual helper functions.
//
// Design note (fresh read each call)
// -----------------------------------
// jsx/helpers.jsx may not exist yet, or may be an empty/partial scaffold at the
// time this shim first runs (Task 1 precedes the helper implementation tasks).
// The shim therefore does NOT cache the source. Each `loadHelpers()` call reads
// the file again, so as later tasks flesh out helpers.jsx, the very same shim
// starts exposing the new functions with no changes required here. A missing or
// empty file is tolerated and yields an empty (but usable) sandbox.
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Repo root is two levels up from tests/helpers/.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Default engine file this shim targets. Callers may override via options.file.
const DEFAULT_HELPERS_REL = path.join("jsx", "helpers.jsx");

/**
 * Resolve a jsx-relative-or-absolute path to an absolute path under the repo.
 */
function resolveJsxPath(fileRelOrAbs) {
    if (!fileRelOrAbs) fileRelOrAbs = DEFAULT_HELPERS_REL;
    if (path.isAbsolute(fileRelOrAbs)) return fileRelOrAbs;
    return path.join(REPO_ROOT, fileRelOrAbs);
}

/**
 * Read the source of an engine file fresh. Returns "" when the file is absent,
 * so callers can tolerate a not-yet-authored scaffold.
 */
function readEngineSource(fileRelOrAbs) {
    const abs = resolveJsxPath(fileRelOrAbs);
    if (!fs.existsSync(abs)) return "";
    return fs.readFileSync(abs, "utf8");
}

/**
 * Strip ExtendScript-only preprocessor / host directives that Node's VM cannot
 * evaluate. This is line-oriented and conservative:
 *   //@include "core.jsx"      -> removed
 *   #include "core.jsx"        -> removed
 *   #target aftereffects       -> removed
 *   #targetengine "main"       -> removed
 *   #script "..."              -> removed
 * Also removes a trailing `module.exports = {...}` block if a future author
 * added one (harmless in the VM but avoids ReferenceError on `module`).
 */
function stripExtendScriptDirectives(source) {
    if (!source) return "";
    const lines = source.split(/\r?\n/);
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.replace(/^\s+/, "");
        if (/^\/\/\s*@include\b/.test(trimmed)) continue; // //@include
        if (/^#(include|target|targetengine|script|engine)\b/.test(trimmed)) continue;
        kept.push(line);
    }
    return kept.join("\n");
}

/**
 * Build a sandbox context object. Injected fakes/globals are merged in so the
 * evaluated engine code sees them as ExtendScript globals (app, CompItem, ...).
 *
 * We expose a permissive `CompItem` constructor by default: comp fakes carry a
 * `__isCompFake` flag, and this default `CompItem` returns true from
 * `instanceof` checks for any object flagged as a comp. Callers can override by
 * passing their own `CompItem` in `injected`.
 */
function createSandbox(injected) {
    injected = injected || {};

    const sandbox = {
        // Console for debugging inside helpers if ever needed.
        console: console,
        // A minimal $ (ExtendScript engine object) stub; helpers may reference
        // $.writeln for logging. No-op by default.
        $: injected.$ || { writeln: function () { }, write: function () { } },
    };

    // Default duck-typed CompItem so `x instanceof CompItem` works for fakes
    // marked with __isCompFake. Only installed if the caller didn't provide one.
    if (!("CompItem" in injected)) {
        function CompItem() { }
        Object.defineProperty(CompItem, Symbol.hasInstance, {
            value: function (obj) {
                return !!(obj && obj.__isCompFake === true);
            },
        });
        sandbox.CompItem = CompItem;
    }

    // Merge caller-provided globals (app, dependency fns, overrides, fakes).
    const keys = Object.keys(injected);
    for (let i = 0; i < keys.length; i++) {
        sandbox[keys[i]] = injected[keys[i]];
    }

    // Make the sandbox its own global reference (ExtendScript-style globals).
    sandbox.global = sandbox;
    sandbox.globalThis = sandbox;

    return vm.createContext(sandbox);
}

/**
 * Load an engine .jsx file into a fresh sandbox and return handles to it.
 *
 * options:
 *   file       jsx-relative or absolute path (default jsx/helpers.jsx)
 *   injected   object of globals/fakes to expose to the evaluated code
 *              (e.g. { app, jsonStringify, ensureDeepFolder, ... }).
 *   lenient    when true (default), a syntax error in a partial scaffold is
 *              swallowed and reported on the result as `.error` instead of
 *              throwing, so the harness stays usable while helpers.jsx is
 *              being fleshed out. Set false to surface parse errors.
 *
 * returns { context, source, file, loaded, error, get, has }
 *   context  the vm context (all top-level function declarations become props)
 *   source   the (directive-stripped) source that was evaluated
 *   loaded   list of function names discovered in the context
 *   get(n)   returns the named function/global from the context (or undefined)
 *   has(n)   whether the named function/global exists and is a function
 */
function loadHelpers(options) {
    options = options || {};
    const file = options.file || DEFAULT_HELPERS_REL;
    const injected = options.injected || {};
    const lenient = options.lenient !== undefined ? options.lenient : true;

    const rawSource = readEngineSource(file);
    const source = stripExtendScriptDirectives(rawSource);
    const context = createSandbox(injected);

    let error = null;
    if (source && source.replace(/\s+/g, "") !== "") {
        try {
            vm.runInContext(source, context, { filename: resolveJsxPath(file) });
        } catch (e) {
            if (!lenient) throw e;
            error = e;
        }
    }

    // Discover function-valued globals that were declared (excludes the
    // injected non-function globals and our sandbox plumbing).
    const plumbing = { console: true, $: true, CompItem: true, global: true, globalThis: true };
    const loaded = [];
    const ctxKeys = Object.keys(context);
    for (let i = 0; i < ctxKeys.length; i++) {
        const k = ctxKeys[i];
        if (plumbing[k]) continue;
        if (Object.prototype.hasOwnProperty.call(injected, k)) continue;
        if (typeof context[k] === "function") loaded.push(k);
    }

    return {
        context: context,
        source: source,
        rawSource: rawSource,
        file: file,
        loaded: loaded,
        error: error,
        get: function (name) {
            return context[name];
        },
        has: function (name) {
            return typeof context[name] === "function";
        },
    };
}

module.exports = {
    loadHelpers: loadHelpers,
    readEngineSource: readEngineSource,
    stripExtendScriptDirectives: stripExtendScriptDirectives,
    createSandbox: createSandbox,
    resolveJsxPath: resolveJsxPath,
    REPO_ROOT: REPO_ROOT,
    DEFAULT_HELPERS_REL: DEFAULT_HELPERS_REL,
};
