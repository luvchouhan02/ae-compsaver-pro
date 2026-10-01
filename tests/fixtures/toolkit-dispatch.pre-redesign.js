"use strict";
/**
 * tests/fixtures/toolkit-dispatch.pre-redesign.js
 * ---------------------------------------------------------------------------
 * Frozen pre-redesign Toolkit_Dispatcher oracle (obsidian-ui-redesign, task 1.2;
 * Requirements 1.2 and 1.3). Property 2 (tests/toolkit-dispatch-oracle.property
 * .test.js, Milestone 4) compares the redesigned `runToolkitAction` against it.
 *
 * WHAT IS FROZEN
 *   VERBATIM_SOURCE below is lines 330-437 of js/toolkit/toolkit.js as they were
 *   before any redesign edit: the `SILENT_SUCCESS_ACTIONS` table the function
 *   reads, and `runToolkitAction(action, mode, btn, event)` itself. The copy is
 *   stored here, not read from toolkit.js, so later edits to toolkit.js cannot
 *   move the oracle. The source file uses CRLF; the template literal holds the
 *   text with LF (a template literal normalizes line terminators) and SOURCE
 *   rejoins it with CAPTURE.eol. On load the module checks that SOURCE hashes to
 *   CAPTURE.sourceSha256, the SHA-256 of the original bytes, and throws if the
 *   copy was altered. The text has no backslash, backtick or "${", so the
 *   literal is the source byte for byte.
 *
 * API
 *   loadPreRedesignDispatcher(options?) -> harness
 *     options.encodeBridge   codec override; default: encodeBridge from the
 *                            unchanged js/core/bridge.js (additive-only core)
 *     options.anchorButtons  what document.querySelectorAll(".tk-ap-btn")
 *                            returns (default [])
 *     options.globals        extra or replacement realm globals, applied last
 *     options.toolBridgeReturn  value the recording ToolBridge.call returns
 *
 *   harness.runToolkitAction(action, mode, btn, event)
 *                            the verbatim function, evaluated in its own VM realm
 *   harness.SILENT_SUCCESS_ACTIONS  the verbatim table from that realm
 *   harness.dispatch(action, mode, { btn, event, shiftKey })
 *                            runs one call and returns only the records it made:
 *                            { calls, handlerCalls, toasts, domQueries, log,
 *                              returned, outcome }. `shiftKey: true|false` builds
 *                            a click event { type: "click", shiftKey }; otherwise
 *                            `event` is passed as given (omit it for "no event").
 *                            outcome is one of
 *                              { kind: "bridge", key, script, timeoutMs }
 *                              { kind: "handler", handler, args }
 *                              { kind: "none" }
 *                            where timeoutMs is the timeout ToolBridge would use
 *                            (a positive number passed as timeoutMs, else 30000).
 *   harness.calls            ToolBridge.call records: { event: "toolbridge", seq,
 *                            key, script, timeoutMs (as passed), effectiveTimeoutMs,
 *                            button, onResult, optionKeys, options }. Call
 *                            onResult({ status, decoded }) to drive the verbatim
 *                            result handling into the recorders below.
 *   harness.handlerCalls     Panel-side handler records: { event: "handler", seq,
 *                            handler, args } for "PasteController.handleImagePaste"
 *                            and handleEffectSave / Apply / Favorite / Rename / Delete
 *   harness.toasts           showToast records { event: "toast", seq, message, type }
 *   harness.monitorRefreshes updateActiveCompMonitor() records
 *   harness.domQueries       document.querySelectorAll records { selector }
 *   harness.consoleCalls     console.error/warn/log/info records { level, args }
 *   harness.log              every record above, in call order
 *   harness.reset()          empties every record list in place (the arrays keep
 *                            their identity) and restarts seq at 1
 *   harness.context          the VM realm global
 *
 *   createFakeButton(id?)    a minimal element: id, disabled, dataset, and a
 *                            classList (add, remove, contains) that logs to
 *                            button.classOps as ["add"|"remove", name]
 *   SOURCE, CAPTURE          the frozen text and its provenance
 *   EXISTING_ACTION_KEYS     the 23 keys of Requirement 1.2, in that order
 *   HOST_ACTION_KEYS         the 17 of them that reach ToolBridge.call
 *   PANEL_SIDE_HANDLERS      the 6 Panel-side keys -> handler name they call
 *   TOOLBRIDGE_DEFAULT_TIMEOUT_MS  30000, ToolBridge's default at capture time
 *
 * REALM GLOBALS (all recording stubs except encodeBridge)
 *   encodeBridge, ToolBridge.call, PasteController.handleImagePaste,
 *   handleEffectSave, handleEffectApply, handleEffectFavorite,
 *   handleEffectRename, handleEffectDelete, showToast, updateActiveCompMonitor,
 *   document.querySelectorAll, console. The verbatim function reads no other
 *   global (no Settings, no csInterface, no callHost).
 *
 * This file is a fixture module, not a suite: jest.config.js collects only
 * tests/**\/*.test.js.
 * ---------------------------------------------------------------------------
 */

const crypto = require("crypto");
const path = require("path");
const vm = require("vm");

const BRIDGE_PATH = path.join(__dirname, "..", "..", "js", "core", "bridge.js");

const CAPTURE = Object.freeze({
    file: "js/toolkit/toolkit.js",
    firstLine: 330,
    lastLine: 437,
    eol: "\r\n",
    sourceSha256: "6e9963b3d61730534d9801d07c58267400968336e256022ecde0284f07bffba2",
    sourceBytes: 4674,
    fileSha256: "7df46d0447e8521aa96bf84f57d64089ae1d7d1e03736e444cc02a95a6ca1810",
    capturedOn: "2026-09-27",
    capturedAt: "obsidian-ui-redesign task 1.2, before Milestone 1",
});

// ── verbatim: js/toolkit/toolkit.js lines 330-437 (do not edit) ─────────────
const VERBATIM_SOURCE = `// Rapid-use tools that should be silent on success
var SILENT_SUCCESS_ACTIONS = { anchor: true, align: true, sequence: true, "guides-on": true, "guides-off": true, "delete-expression": true };

function runToolkitAction(action, mode, btn, event) {
    // Instantly toggle active style on anchor grid cells
    if (action === "anchor" && btn) {
        var apBtns = document.querySelectorAll(".tk-ap-btn");
        for (var i = 0; i < apBtns.length; i++) {
            apBtns[i].classList.remove("active");
        }
        btn.classList.add("active");
    }

    var jsx = "";
    if (action === "anchor") jsx = 'toolkitAnchorPoint("' + encodeBridge(mode) + '")';
    else if (action === "align") jsx = 'toolkitAlignLayers("' + encodeBridge(mode) + '")';
    else if (action === "create") {
        // Special Null behavior: normal click = single parent null for all selected layers
        // Shift+click = per-layer individual nulls (original behavior)
        if (mode === "null" && event && !event.shiftKey) {
            jsx = 'toolkitCreateParentNull()';
        } else {
            jsx = 'toolkitCreateLayer("' + encodeBridge(mode) + '")';
        }
    }
    else if (action === "organize") jsx = "toolkitOrganizeProject()";
    else if (action === "effects") jsx = "toolkitToggleEffects()";
    else if (action === "precompose") jsx = "toolkitPrecompose()";
    else if (action === "unprecompose") jsx = "toolkitUnprecompose()";
    else if (action === "cache") jsx = "toolkitClearCache()";
    else if (action === "multiprecomp") jsx = 'toolkitMultiPrecomp("' + encodeBridge(mode) + '")';
    else if (action === "sequence") jsx = 'toolkitSequenceLayers("' + encodeBridge(mode) + '")';
    else if (action === "truedup") jsx = "toolkitTrueDuplicate()";
    else if (action === "decompose") jsx = "toolkitDeCompose()";
    else if (action === "resize") jsx = 'toolkitResizeCompTree("' + encodeBridge(mode) + '")';
    else if (action === "bounce") jsx = 'toolkitApplyBounce("' + encodeBridge(mode) + '")';
    else if (action === "guides-on") jsx = "toolkitAddGuides()";
    else if (action === "guides-off") jsx = "toolkitClearGuides()";
    else if (action === "delete-expression") jsx = "toolkitRemoveExpressions()";
    else if (action === "effect-save") {
        handleEffectSave(btn);
        return;
    }
    else if (action === "effect-apply") {
        handleEffectApply(btn);
        return;
    }
    else if (action === "effect-favorite") {
        handleEffectFavorite(btn);
        return;
    }
    else if (action === "effect-rename") {
        handleEffectRename(btn);
        return;
    }
    else if (action === "effect-delete") {
        handleEffectDelete(btn);
        return;
    }
    else if (action === "paste") {
        PasteController.handleImagePaste(btn);
        return;
    }

    if (!jsx) return;

    var isSilent = SILENT_SUCCESS_ACTIONS[action];

    ToolBridge.call({
        key: "toolkit." + action,
        script: jsx,
        button: btn || null,
        onResult: function (result) {
            // timeout / host-error / busy / disposed: ToolBridge already
            // toasted an actionable message and restored the button.
            if (result.status !== "success") return;

            var decoded = result.decoded;

            // FX toggle: response message tells us the new state. Reflect it on the button
            // so the UI shows whether effects are currently disabled (engaged) or restored.
            if (action === "effects" && btn) {
                if (decoded.indexOf("Effects disabled") !== -1) {
                    btn.classList.add("active");
                } else if (decoded.indexOf("Effects restored") !== -1) {
                    btn.classList.remove("active");
                }
            }

            if (decoded === "true") {
                // Silent success for rapid-use tools
                if (!isSilent) showToast("Done", "success");
            } else if (decoded.indexOf("OK:") === 0) {
                // FX has its own visual feedback via .active state -- stay silent
                if (action !== "effects") {
                    showToast(decoded.substr(3), "info");
                }
            } else {
                // Error -- always show
                var errMsg = "Toolkit failed";
                if (decoded && decoded.length < 80) errMsg = decoded;
                showToast(errMsg, "error");
                console.error("[CompSaver] Toolkit:", action, decoded);
            }
            updateActiveCompMonitor();
        }
    });
}`;
// ── end verbatim ────────────────────────────────────────────────────────────

const SOURCE = VERBATIM_SOURCE.split("\n").join(CAPTURE.eol);

(function assertFrozen() {
    const digest = crypto.createHash("sha256").update(SOURCE, "utf8").digest("hex");
    if (digest !== CAPTURE.sourceSha256 || Buffer.byteLength(SOURCE, "utf8") !== CAPTURE.sourceBytes) {
        throw new Error(
            "toolkit-dispatch.pre-redesign fixture: the frozen runToolkitAction copy no longer " +
            "matches the pre-redesign bytes (expected sha256 " + CAPTURE.sourceSha256 +
            ", got " + digest + "). Restore it; never re-capture it from the redesigned toolkit.js."
        );
    }
})();

const TOOLBRIDGE_DEFAULT_TIMEOUT_MS = 30000;

const EXISTING_ACTION_KEYS = Object.freeze([
    "anchor", "align", "create", "organize", "effects", "precompose", "unprecompose",
    "decompose", "multiprecomp", "truedup", "sequence", "resize", "bounce", "cache",
    "guides-on", "guides-off", "delete-expression", "paste", "effect-save",
    "effect-apply", "effect-favorite", "effect-rename", "effect-delete",
]);

const PANEL_SIDE_HANDLERS = Object.freeze({
    "paste": "PasteController.handleImagePaste",
    "effect-save": "handleEffectSave",
    "effect-apply": "handleEffectApply",
    "effect-favorite": "handleEffectFavorite",
    "effect-rename": "handleEffectRename",
    "effect-delete": "handleEffectDelete",
});

const HOST_ACTION_KEYS = Object.freeze(EXISTING_ACTION_KEYS.filter(function (key) {
    return !Object.prototype.hasOwnProperty.call(PANEL_SIDE_HANDLERS, key);
}));

function createFakeButton(id) {
    const classes = new Set();
    const classOps = [];
    return {
        id: id || "",
        disabled: false,
        dataset: {},
        classOps: classOps,
        classList: {
            add: function (name) { classes.add(name); classOps.push(["add", name]); },
            remove: function (name) { classes.delete(name); classOps.push(["remove", name]); },
            contains: function (name) { return classes.has(name); },
        },
    };
}

function effectiveTimeout(timeoutMs) {
    return (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : TOOLBRIDGE_DEFAULT_TIMEOUT_MS;
}

function outcomeOf(calls, handlerCalls) {
    if (calls.length === 0 && handlerCalls.length === 0) return { kind: "none" };
    if (calls.length === 1 && handlerCalls.length === 0) {
        return { kind: "bridge", key: calls[0].key, script: calls[0].script, timeoutMs: calls[0].effectiveTimeoutMs };
    }
    if (calls.length === 0 && handlerCalls.length === 1) {
        return { kind: "handler", handler: handlerCalls[0].handler, args: handlerCalls[0].args.slice() };
    }
    // The frozen dispatcher never does this; kept so a harness misuse is visible.
    return { kind: "multiple", calls: calls.slice(), handlerCalls: handlerCalls.slice() };
}

function loadPreRedesignDispatcher(options) {
    const config = options || {};
    const encodeBridge = typeof config.encodeBridge === "function"
        ? config.encodeBridge
        : require(BRIDGE_PATH).encodeBridge;
    const anchorButtons = Array.isArray(config.anchorButtons) ? config.anchorButtons : [];

    const log = [];
    const calls = [];
    const handlerCalls = [];
    const toasts = [];
    const monitorRefreshes = [];
    const domQueries = [];
    const consoleCalls = [];
    let seq = 0;

    function record(list, entry) {
        entry.seq = ++seq;
        list.push(entry);
        log.push(entry);
        return entry;
    }

    function handlerRecorder(name) {
        return function () {
            record(handlerCalls, { event: "handler", handler: name, args: Array.prototype.slice.call(arguments) });
        };
    }

    function consoleRecorder(level) {
        return function () {
            record(consoleCalls, { event: "console", level: level, args: Array.prototype.slice.call(arguments) });
        };
    }

    const sandbox = {
        encodeBridge: encodeBridge,
        ToolBridge: {
            call: function (opts) {
                record(calls, {
                    event: "toolbridge",
                    key: opts.key,
                    script: opts.script,
                    timeoutMs: opts.timeoutMs,
                    effectiveTimeoutMs: effectiveTimeout(opts.timeoutMs),
                    button: opts.button,
                    onResult: opts.onResult,
                    optionKeys: Object.keys(opts),
                    options: opts,
                });
                return config.toolBridgeReturn;
            },
        },
        PasteController: { handleImagePaste: handlerRecorder("PasteController.handleImagePaste") },
        handleEffectSave: handlerRecorder("handleEffectSave"),
        handleEffectApply: handlerRecorder("handleEffectApply"),
        handleEffectFavorite: handlerRecorder("handleEffectFavorite"),
        handleEffectRename: handlerRecorder("handleEffectRename"),
        handleEffectDelete: handlerRecorder("handleEffectDelete"),
        showToast: function (message, type) {
            record(toasts, { event: "toast", message: message, type: type });
        },
        updateActiveCompMonitor: function () {
            record(monitorRefreshes, { event: "monitor" });
        },
        document: {
            querySelectorAll: function (selector) {
                record(domQueries, { event: "dom", method: "querySelectorAll", selector: selector });
                return anchorButtons.slice();
            },
        },
        console: {
            error: consoleRecorder("error"),
            warn: consoleRecorder("warn"),
            log: consoleRecorder("log"),
            info: consoleRecorder("info"),
        },
    };
    if (config.globals) Object.assign(sandbox, config.globals);

    const context = vm.createContext(sandbox);
    vm.runInContext(SOURCE, context, {
        filename: "toolkit-dispatch.pre-redesign/" + CAPTURE.file + "#L" + CAPTURE.firstLine + "-L" + CAPTURE.lastLine,
    });
    const runToolkitAction = context.runToolkitAction;
    if (typeof runToolkitAction !== "function") {
        throw new Error("toolkit-dispatch.pre-redesign fixture: runToolkitAction was not defined in the realm");
    }

    function dispatch(action, mode, dispatchOptions) {
        const d = dispatchOptions || {};
        const event = typeof d.shiftKey === "boolean" ? { type: "click", shiftKey: d.shiftKey } : d.event;
        const mark = {
            calls: calls.length,
            handlerCalls: handlerCalls.length,
            toasts: toasts.length,
            domQueries: domQueries.length,
            log: log.length,
        };
        const returned = runToolkitAction(action, mode, d.btn, event);
        const madeCalls = calls.slice(mark.calls);
        const madeHandlerCalls = handlerCalls.slice(mark.handlerCalls);
        return {
            calls: madeCalls,
            handlerCalls: madeHandlerCalls,
            toasts: toasts.slice(mark.toasts),
            domQueries: domQueries.slice(mark.domQueries),
            log: log.slice(mark.log),
            returned: returned,
            outcome: outcomeOf(madeCalls, madeHandlerCalls),
        };
    }

    function reset() {
        [log, calls, handlerCalls, toasts, monitorRefreshes, domQueries, consoleCalls].forEach(function (list) {
            list.length = 0;
        });
        seq = 0;
    }

    return {
        runToolkitAction: runToolkitAction,
        SILENT_SUCCESS_ACTIONS: context.SILENT_SUCCESS_ACTIONS,
        dispatch: dispatch,
        calls: calls,
        handlerCalls: handlerCalls,
        toasts: toasts,
        monitorRefreshes: monitorRefreshes,
        domQueries: domQueries,
        consoleCalls: consoleCalls,
        log: log,
        reset: reset,
        context: context,
    };
}

module.exports = {
    loadPreRedesignDispatcher: loadPreRedesignDispatcher,
    createFakeButton: createFakeButton,
    SOURCE: SOURCE,
    CAPTURE: CAPTURE,
    EXISTING_ACTION_KEYS: EXISTING_ACTION_KEYS,
    HOST_ACTION_KEYS: HOST_ACTION_KEYS,
    PANEL_SIDE_HANDLERS: PANEL_SIDE_HANDLERS,
    TOOLBRIDGE_DEFAULT_TIMEOUT_MS: TOOLBRIDGE_DEFAULT_TIMEOUT_MS,
};
