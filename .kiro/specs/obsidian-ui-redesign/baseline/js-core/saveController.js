// ============================================================
// core/saveController.js — async Save_Engine CEP controller
// ------------------------------------------------------------
// Feature: save-import-performance-redesign (Task 5.1)
//
// Pure, dependency-injected save controller that drives the CEP side of a
// save. It triggers the Essential_Save_Work across the async Bridge and, the
// instant that essential call settles, transitions the panel OUT of its save
// loading state — regardless of any Non_Essential_Save_Work still pending. All
// DOM, CSInterface, and filesystem access is injected, so the control-flow
// guarantees below are unit-testable with jest + fast-check (Properties 4 & 5)
// without After Effects or a browser.
//
// Guarantees (design "Save_Engine client" + Requirements 1.3, 1.5, 1.6, 5.3,
// 5.4, 5.7):
//
//   • Loading exits on essential completion, independent of background state.
//     `exitLoading()` is called exactly once, BEFORE any background work is
//     scheduled, on both the success and failure branches (Property 4 /
//     Req 1.3, 1.5).
//   • On essential failure the controller also sets an error indication and
//     schedules NO background work; the live project is left untouched by the
//     essential sequence (Req 1.5).
//   • On essential success the completed result is retained; if any subsequent
//     Non_Essential_Save_Work fails, the controller records an error that
//     IDENTIFIES the failed background unit while keeping the retained
//     essential result intact (Property 5 / Req 1.6, 5.7).
//   • While background work is pending, a non-blocking background-activity
//     indicator is shown and hidden when the work settles; the controller never
//     re-enters the blocking loading state for background work, so save
//     controls stay responsive (Req 5.3, 5.4).
//
// The returned Promise resolves as soon as the essential path is handled (Req
// 1.3 — no waiting on Non_Essential_Save_Work). Background outcomes mutate the
// same result/state object the Promise resolves with, via the hooks handed to
// the injected `scheduleBackground`, so callers (and property tests) observe
// background failures on the retained state after the fact.
// ============================================================

/**
 * @typedef {Object} EssentialSaveResult
 * @property {boolean} ok
 * @property {string}  [error]
 * @property {string}  [folderPath]
 * @property {boolean} [needsThumbnail]
 * // ...plus any host-returned fields (name, category, assetsList, etc.)
 */

/**
 * @typedef {Object} SaveControllerState
 * @property {Object}  essential                 Raw async-Bridge outcome ({ ok, result?, error?, timedOut? }).
 * @property {boolean} loadingExited             Set true once the loading state has been exited.
 * @property {boolean} essentialOk               True iff the essential save succeeded.
 * @property {?EssentialSaveResult} essentialResult  Retained parsed essential result (success only).
 * @property {?string} essentialError            Error message when the essential save failed.
 * @property {Array.<{work: string, error: string}>} backgroundErrors  Identified background failures.
 * @property {boolean} backgroundActivityVisible Whether the non-blocking indicator is currently shown.
 * @property {boolean} backgroundSettled         True once all scheduled background work has settled.
 */

/**
 * Default parser for a decoded host essential-save response. Tolerates the two
 * shapes the current host emits — a JSON object string (`{ "ok": true, ... }`)
 * and the monolithic `"true"` sentinel — plus explicit failure strings. Never
 * throws; an unparseable body is treated as a failure.
 *
 * @param {*} decoded
 * @returns {?EssentialSaveResult}
 */
function defaultParseEssential(decoded) {
    if (decoded == null) return null;
    if (typeof decoded === "object") return decoded;
    var s = "" + decoded;
    if (s === "true") return { ok: true };
    if (s === "" || s === "false" || s === "undefined") {
        return { ok: false, error: s === "" ? "Empty response from After Effects" : null };
    }
    if (s.charAt(0) === "{") {
        try {
            return JSON.parse(s);
        } catch (e) {
            return { ok: false, error: "Could not parse save result" };
        }
    }
    // Bare string that is neither JSON nor "true" — treat as an error message
    // (e.g. "ERROR: ..." or a validation string).
    return { ok: false, error: s.indexOf("ERROR:") === 0 ? s.substring(6) : s };
}

/**
 * Derive a user-facing "save did not complete" message from a failed essential
 * outcome / parse. Pure.
 *
 * @param {Object} outcome  Async-Bridge outcome.
 * @param {?EssentialSaveResult} parsed
 * @returns {string}
 */
function deriveEssentialError(outcome, parsed) {
    if (outcome && outcome.timedOut) return "Save timed out — the save did not complete";
    if (outcome && outcome.ok === false && outcome.error) return "Save failed: " + outcome.error;
    if (parsed && parsed.error) return "Save failed: " + parsed.error;
    return "Save did not complete";
}

/**
 * Build the error indication for a failed unit of background work. The message
 * always names the failed work so the user can tell it apart from the (retained,
 * successful) essential save (Req 1.6, 5.7).
 *
 * @param {string} workName
 * @param {*} err
 * @returns {string}
 */
function backgroundErrorMessage(workName, err) {
    var reason = err != null ? String(err && err.message ? err.message : err) : "";
    var label = workName || "background work";
    return "Saved, but " + label + " failed" + (reason ? ": " + reason : "");
}

/**
 * Run the async save controller for one save action.
 *
 * @param {Object} deps
 * @param {function(string, Object=): (Promise<Object>|Object)} deps.callHost
 *        Async Bridge wrapper. Given the essential-save script call, resolves
 *        `{ ok, result?, error?, timedOut? }`. Issued exactly once.
 * @param {function(Object): string} [deps.buildEssentialCall]
 *        (request) -> the ExtendScript expression that performs the essential
 *        save. Defaults to `request.scriptCall`.
 * @param {function(*): ?EssentialSaveResult} [deps.parseEssential]
 *        Parse a decoded host response into an EssentialSaveResult.
 * @param {function(): void} [deps.exitLoading]
 *        Exit the save loading state (re-enable controls). Called exactly once.
 * @param {function(string): void} [deps.setError]
 *        Show an error indication that the essential save did not complete.
 * @param {function(string): void} [deps.setBackgroundError]
 *        Show an error indication identifying failed background work. Falls back
 *        to `setError` when not supplied.
 * @param {function(EssentialSaveResult): void} [deps.onEssentialSuccess]
 *        Called with the retained essential result on success (render the
 *        Optimistic_Card, insert into the Library_Index, etc. — task 5.4).
 * @param {function(EssentialSaveResult, {onWorkFailed: function(string, *): void, onAllSettled: function(): void}): void} [deps.scheduleBackground]
 *        Schedule every unit of Non_Essential_Save_Work. Reports per-unit
 *        failures via `onWorkFailed(workName, err)` and overall completion via
 *        `onAllSettled()`.
 * @param {function(): void} [deps.showBackgroundActivity]
 *        Show the non-blocking background-activity indicator.
 * @param {function(): void} [deps.hideBackgroundActivity]
 *        Hide the background-activity indicator.
 * @param {number} [deps.timeoutMs=30000]  Essential-save Bridge timeout.
 * @param {Object} request  Save request; carries `scriptCall` by default.
 * @returns {Promise<SaveControllerState>} Resolves once the essential path is handled.
 */
function runSaveController(deps, request) {
    deps = deps || {};
    request = request || {};

    var callHost = typeof deps.callHost === "function" ? deps.callHost : null;
    var buildEssentialCall = typeof deps.buildEssentialCall === "function"
        ? deps.buildEssentialCall
        : function (req) { return req && req.scriptCall ? req.scriptCall : ""; };
    var parseEssential = typeof deps.parseEssential === "function"
        ? deps.parseEssential
        : defaultParseEssential;
    var exitLoading = typeof deps.exitLoading === "function" ? deps.exitLoading : function () { };
    var setError = typeof deps.setError === "function" ? deps.setError : function () { };
    var setBackgroundError = typeof deps.setBackgroundError === "function"
        ? deps.setBackgroundError
        : setError;
    var onEssentialSuccess = typeof deps.onEssentialSuccess === "function"
        ? deps.onEssentialSuccess
        : function () { };
    var scheduleBackground = typeof deps.scheduleBackground === "function"
        ? deps.scheduleBackground
        : null;
    var showBackgroundActivity = typeof deps.showBackgroundActivity === "function"
        ? deps.showBackgroundActivity
        : function () { };
    var hideBackgroundActivity = typeof deps.hideBackgroundActivity === "function"
        ? deps.hideBackgroundActivity
        : function () { };
    var timeoutMs = typeof deps.timeoutMs === "number" ? deps.timeoutMs : 30000;

    /** @type {SaveControllerState} */
    var state = {
        essential: null,
        loadingExited: false,
        essentialOk: false,
        essentialResult: null,
        essentialError: null,
        backgroundErrors: [],
        backgroundActivityVisible: false,
        backgroundSettled: false
    };

    // Exit the loading state at most once. Guarded so a later path (or a stray
    // background settle) cannot re-toggle it.
    function exitLoadingOnce() {
        if (state.loadingExited) return;
        state.loadingExited = true;
        try { exitLoading(); } catch (e) { /* UI teardown must never break the flow */ }
    }

    // ── Background hooks handed to the injected scheduler ───────────────
    // A failed unit is recorded and surfaced with a message that IDENTIFIES it,
    // while the retained essential result is never discarded (Req 1.6, 5.7).
    function onWorkFailed(workName, err) {
        var name = workName != null ? "" + workName : "background work";
        state.backgroundErrors.push({
            work: name,
            error: err != null ? String(err && err.message ? err.message : err) : "unknown"
        });
        try { setBackgroundError(backgroundErrorMessage(name, err)); } catch (e) { }
    }

    function onAllSettled() {
        state.backgroundSettled = true;
        if (state.backgroundActivityVisible) {
            state.backgroundActivityVisible = false;
            try { hideBackgroundActivity(); } catch (e) { }
        }
    }

    function handleEssential(outcome) {
        state.essential = outcome || null;

        // (1) ALWAYS exit loading on essential completion, BEFORE touching any
        // background concern, so the transition never depends on
        // Non_Essential_Save_Work state (Property 4 / Req 1.3, 1.5).
        exitLoadingOnce();

        var parsed = (outcome && outcome.ok) ? parseEssential(outcome.result) : null;
        var essentialSucceeded = !!(outcome && outcome.ok && parsed && parsed.ok);

        if (!essentialSucceeded) {
            // (2) Essential failure: error indication, no background work.
            state.essentialOk = false;
            var msg = deriveEssentialError(outcome, parsed);
            state.essentialError = msg;
            try { setError(msg); } catch (e) { }
            return state;
        }

        // (3) Essential success: retain the result and hand it to the optimistic
        // UI, then schedule Non_Essential_Save_Work off the blocking path.
        state.essentialOk = true;
        state.essentialResult = parsed;
        try { onEssentialSuccess(parsed); } catch (e) { }

        if (scheduleBackground) {
            // Non-blocking background-activity indicator while work is pending
            // (Req 5.3). Controls remain responsive because loading already
            // exited above and is never re-entered for background work (Req 5.4).
            state.backgroundActivityVisible = true;
            try { showBackgroundActivity(); } catch (e) { }
            try {
                scheduleBackground(parsed, {
                    onWorkFailed: onWorkFailed,
                    onAllSettled: onAllSettled
                });
            } catch (scheduleErr) {
                // Scheduling itself failed: record it as a background failure and
                // settle the indicator; the essential result stays retained.
                onWorkFailed("background scheduling", scheduleErr);
                onAllSettled();
            }
        }
        return state;
    }

    // Trigger the essential save via the async Bridge (Req 1.4). No transport →
    // still exit loading and surface a failure (never hang).
    if (!callHost) {
        return Promise.resolve(handleEssential({ ok: false, error: "No Bridge transport available" }));
    }

    return Promise.resolve(callHost(buildEssentialCall(request), { timeoutMs: timeoutMs }))
        .then(function (outcome) {
            return handleEssential(outcome);
        }, function (rejectErr) {
            // callHost is contracted never to reject, but stay defensive: a
            // rejection is treated as an essential failure that still exits loading.
            return handleEssential({ ok: false, error: String(rejectErr) });
        });
}

// Dual-load guard: CommonJS for jest, bare global for CEP browser inclusion.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        runSaveController: runSaveController,
        defaultParseEssential: defaultParseEssential,
        deriveEssentialError: deriveEssentialError,
        backgroundErrorMessage: backgroundErrorMessage
    };
}
