// ============================================================
// core/bridge.js — CEP ⇄ ExtendScript transport encoding
// ------------------------------------------------------------
// Hex-pair codec used to ferry strings across evalScript without
// quoting/escaping hazards. Pure functions; mirrors the identical
// encodeBridge/decodeBridge defined host-side in jsx/compSaver.jsx.
// Loaded before main.js; resolves as globals via the scope chain.
// ============================================================

function encodeBridge(str) {
    var hex = "";
    if (!str && str !== 0) return hex;
    str = "" + str;
    for (var i = 0; i < str.length; i++) {
        var h = str.charCodeAt(i).toString(16);
        while (h.length < 4) h = "0" + h;
        hex += h;
    }
    return hex;
}

// A well-formed Bridge payload is a multiple of 4 hex digits: encodeBridge emits
// exactly one 4-digit UTF-16 code unit per character. Validating the WHOLE string
// once with a single native regex keeps the hot decode loop untouched — no
// per-chunk work, and no array-collect rewrite (that was measured 5x slower
// host-side; see the note above encodeBridge in jsx/core.jsx).
var BRIDGE_HEX_RE = /^[0-9a-fA-F]*$/;

function isWellFormedBridgeHex(hex) {
    if (hex === null || hex === undefined) return false;
    var s = "" + hex;
    if (s.length % 4 !== 0) return false;
    return BRIDGE_HEX_RE.test(s);
}

// Strict decode with an explicit failure result. Both sides of the Bridge run
// this identical algorithm, so a truncated or corrupted transfer can no longer
// decode into two DIFFERENT strings — the panel used to emit U+0000 for a bad
// chunk (String.fromCharCode(NaN)) while the host silently skipped it, and a
// trailing partial chunk produced a plausible but wrong character on both sides.
function decodeBridgeStrict(hex) {
    if (hex === null || hex === undefined || hex === "") return { ok: true, value: "" };
    var s = "" + hex;
    if (!isWellFormedBridgeHex(s)) {
        return {
            ok: false,
            value: "",
            error: "Malformed Bridge payload (" + s.length +
                " chars; expected a multiple of 4 hex digits)"
        };
    }
    var str = "";
    for (var i = 0; i < s.length; i += 4) {
        str += String.fromCharCode(parseInt(s.substr(i, 4), 16));
    }
    return { ok: true, value: str };
}

// Back-compatible wrapper: same signature and return type as before, but a
// malformed payload now yields "" on BOTH sides instead of a silently corrupted
// string. Callers that must distinguish "empty" from "malformed" use
// decodeBridgeStrict — callHost does.
function decodeBridge(hex) {
    return decodeBridgeStrict(hex).value;
}

// ============================================================
// callHost — async, timeout-guarded Bridge_Call wrapper
// ------------------------------------------------------------
// Feature: save-import-performance-redesign
//
// Every Save_Engine / Import_Engine round trip goes through this wrapper.
// It issues a single asynchronous `evalScript`, decodes the host response
// with the (unchanged) hex codec, and resolves a plain result object:
//
//   { ok: true,  result: <decoded string> }              host returned in time
//   { ok: false, timedOut: true }                         no return within timeoutMs
//   { ok: false, error: <string> }                        host reported an error
//
// Design guarantees (Requirements 1.4, 1.7):
//   - The returned Promise NEVER rejects; callers branch on `ok`.
//   - On timeout the pending call is cancelled from the panel's point of view
//     (a `settled` latch drops any late/never-return response) and the result
//     resolves immediately without blocking the UI thread.
//   - The evalScript completion callback does only O(response-length) hex
//     decoding then resolves, so it does not hold the UI thread; no synchronous
//     user work is performed inside it.
//
// The CSInterface transport is resolved from (in order): an injected
// `options.csInterface` (used by tests) or the module-global `csInterface`
// created in state.js. This keeps the wrapper pure/injectable for jest while
// matching the rest of the CEP codebase at runtime.
// ============================================================

// CEP returns these sentinel strings when the host throws or a function is
// missing; the rest of the codebase treats them as failures, so we do too.
var BRIDGE_ERROR_SENTINELS = {
    "EvalScript error.": true,
    "undefined": true
};

/**
 * Issue an asynchronous Bridge_Call with a timeout.
 *
 * @param {string} scriptCall  The ExtendScript expression to evaluate on the host.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=30000]  Cancel + fail the call after this many ms.
 * @param {Object} [options.csInterface]      Injected CSInterface (defaults to the global).
 * @returns {Promise<{ok: boolean, result?: string, error?: string, timedOut?: boolean}>}
 */
function callHost(scriptCall, options) {
    options = options || {};
    var timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30000;
    var iface = options.csInterface ||
        (typeof csInterface !== "undefined" ? csInterface : null);

    return new Promise(function (resolve) {
        var settled = false;
        var timer = null;

        function finish(result) {
            // Latch: the first outcome (host return, error, or timeout) wins.
            // Any later response is ignored, which is how we "cancel" a pending
            // call after a timeout without blocking or double-resolving.
            if (settled) return;
            settled = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            resolve(result);
        }

        // Arm the timeout first so a missing/synchronously-throwing transport
        // still fails cleanly rather than hanging.
        timer = setTimeout(function () {
            finish({ ok: false, timedOut: true });
        }, timeoutMs);

        if (!iface || typeof iface.evalScript !== "function") {
            finish({ ok: false, error: "No CSInterface transport available" });
            return;
        }

        try {
            iface.evalScript(scriptCall, function (raw) {
                // Completion callback — keep it minimal: decode and resolve only.
                if (settled) return; // already timed out: drop the late return
                if (!raw || BRIDGE_ERROR_SENTINELS[raw] === true) {
                    finish({ ok: false, error: raw ? String(raw) : "Empty host response" });
                    return;
                }
                // A malformed/truncated payload is reported, never decoded into a
                // corrupted string that then fails a "true" comparison for an
                // operation that actually succeeded.
                var decoded = decodeBridgeStrict(raw);
                if (!decoded.ok) {
                    finish({ ok: false, error: decoded.error });
                    return;
                }
                finish({ ok: true, result: decoded.value });
            });
        } catch (e) {
            finish({ ok: false, error: String(e) });
        }
    });
}

// Dual-load guard: CommonJS for jest, bare global for CEP panel inclusion.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        encodeBridge: encodeBridge,
        decodeBridge: decodeBridge,
        decodeBridgeStrict: decodeBridgeStrict,
        isWellFormedBridgeHex: isWellFormedBridgeHex,
        callHost: callHost
    };
}
