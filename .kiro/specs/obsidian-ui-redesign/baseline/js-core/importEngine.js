// ============================================================
// core/importEngine.js — batching, cache-first import client
// ------------------------------------------------------------
// Feature: save-import-performance-redesign (Task 7.1)
//
// Pure, dependency-injected Import_Engine CEP client. It carries an entire
// user import action (1..500 templates) across the Bridge in EXACTLY ONE
// Bridge_Call, returns cached results without touching the Bridge when the
// result is already known to the Library_Index / Metadata_Cache, and fires an
// "import started" feedback callback the instant it is invoked.
//
// The module owns NO DOM and NO CSInterface reference: the CEP wiring
// (importCurrentCardToTimeline) injects the transport (`callHost`), the cache
// resolver (`resolveCached`), the "started" feedback hook (`onStarted`), and
// the hex codec. This keeps the batching / cache-first logic unit-testable
// with jest + fast-check (Properties 17 & 18) without After Effects.
//
// Contracts (design "Import_Engine" + Requirements 6.2, 9.1, 9.2, 9.4):
//   - onStarted fires synchronously on invocation (feedback < 100ms).
//   - When every requested template's result is already cached, zero
//     Bridge_Calls are issued (Property 18 / Req 9.4).
//   - Otherwise EXACTLY ONE Bridge_Call is issued, whose single payload
//     carries every not-yet-cached template (Property 17 / Req 9.1, 9.2).
//   - The returned result is total over the input: one entry per requested
//     template, in input order, tagged imported | failed | cached.
// ============================================================

/**
 * @typedef {Object} ImportTemplate
 * @property {string}  id           Stable per-template identifier (safe name / folder id).
 * @property {string} [name]        Display name.
 * @property {string} [category]    Category the template lives in.
 * @property {string} [section]     Section kind (comp | layer | text | footage | effect | icon...).
 * @property {string} [folderPath]  Normalized template folder path.
 * @property {string} [sourcePath]  Library root the template belongs to.
 * @property {*}      [metadata]    Optional pre-resolved Template_Metadata.
 */

/**
 * @typedef {Object} ImportRequest
 * @property {string} rootPath                Project/library root path.
 * @property {ImportTemplate[]} templates     The selected templates (1..500 for one action).
 */

/**
 * @typedef {Object} ImportResultEntry
 * @property {string} id
 * @property {"imported"|"failed"|"cached"} status
 * @property {string} [reason]
 */

/**
 * @typedef {Object} BatchImportResult
 * @property {ImportResultEntry[]} perTemplate   One entry per requested template, input order.
 * @property {number} bridgeCalls                Number of Bridge_Calls issued (0 or 1).
 */

/**
 * Build the single JSON-able batch payload sent across the Bridge.
 * Every selected (not-yet-cached) template rides in this one object so the
 * host performs the whole action in a single execution.
 *
 * @param {ImportRequest} request
 * @returns {{ rootPath: string, templates: Array }}
 */
function buildImportPayload(request) {
    request = request || {};
    var templates = request.templates || [];
    var out = { rootPath: request.rootPath || "", templates: [] };
    for (var i = 0; i < templates.length; i++) {
        var t = templates[i] || {};
        out.templates.push({
            id: t.id,
            name: t.name != null ? t.name : t.id,
            category: t.category || "",
            section: t.section || "",
            folderPath: t.folderPath || "",
            sourcePath: t.sourcePath || "",
            metadata: t.metadata != null ? t.metadata : null
        });
    }
    return out;
}

/**
 * Normalize a raw host batch result into an id -> entry map.
 * Tolerates a decoded JSON string or an already-parsed object; on any parse
 * failure returns an empty map so callers mark the affected templates failed.
 *
 * @param {*} raw          Decoded host response (string or object).
 * @returns {{ map: Object, error: (string|null) }}
 */
function parseHostBatchResult(raw) {
    var parsed = raw;
    if (typeof raw === "string") {
        var text = raw;
        if (text === "" || text === "true" || text === "false") {
            return { map: {}, error: text === "" ? "empty host result" : null, bare: text };
        }
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            return { map: {}, error: "unparseable host result" };
        }
    }
    if (!parsed || typeof parsed !== "object") {
        return { map: {}, error: "empty host result" };
    }
    var list = parsed.perTemplate || parsed.results || [];
    var map = {};
    for (var i = 0; i < list.length; i++) {
        var entry = list[i] || {};
        if (entry.id != null) {
            map["" + entry.id] = {
                id: "" + entry.id,
                status: entry.status === "imported" ? "imported" : "failed",
                reason: entry.reason
            };
        }
    }
    // Propagate the host's WHOLE-CALL error (importBatch's
    // {"perTemplate":[],"error":...} envelope) so the reason reaches every
    // entry the host did not report on, instead of the generic
    // "no result for template".
    return { map: map, error: (parsed.error != null ? "" + parsed.error : null) };
}

// CEP hands back these sentinel strings when the host throws or the called
// function is missing (the same list js/core/bridge.js classifies). They are NOT
// hex payloads: decoding one yields a corrupted string, which used to surface as
// an unparseable host result instead of the host error it actually is.
var HOST_ERROR_SENTINELS = {
    "EvalScript error.": true,
    "undefined": true
};

// Grace period for an injected transport that offers no settlement guarantee of
// its own. The production transport (importCurrentCardToTimeline) is the
// timeout-guarded callHost, which owns its own timeout and ALWAYS settles; it
// passes an explicit deps.timeoutMs above that timeout, so this backstop never
// fires in the panel. It exists because `done` must run for every import action
// (Req 2.17): the caller clears the card's `.importing` state in it, and a host
// call that never returned used to leave the card stuck importing forever.
var TRANSPORT_BACKSTOP_MS = 150;

/**
 * Run a batching, cache-first import for a user action.
 *
 * @param {Object} deps
 * @param {function(string, function(*):void):void} deps.callHost
 *        Transport: issues ONE Bridge_Call carrying the hex payload and invokes
 *        the callback with the (hex-encoded) host response. Called at most once.
 * @param {function(ImportTemplate): (ImportResultEntry|null)} [deps.resolveCached]
 *        Returns a cached result entry for a template when it is already known
 *        to the Library_Index / Metadata_Cache, else null. Defaults to "no cache".
 * @param {function(ImportRequest): void} [deps.onStarted]
 *        Fired synchronously on entry to surface "import started" feedback.
 * @param {function(string): string} [deps.encode]   Hex encoder (encodeBridge).
 * @param {function(string): string} [deps.decode]   Hex decoder (decodeBridge).
 * @param {number} [deps.timeoutMs]
 *        Backstop for a transport that never settles. Defaults to
 *        TRANSPORT_BACKSTOP_MS; a transport that owns its own (longer) timeout
 *        passes a value above it so the backstop never pre-empts a live call.
 * @param {ImportRequest} request
 * @param {function(BatchImportResult): void} done   Invoked with the merged result.
 */
function importTemplates(deps, request, done) {
    deps = deps || {};
    request = request || {};
    done = typeof done === "function" ? done : function () { };

    var templates = request.templates || [];
    var resolveCached = typeof deps.resolveCached === "function"
        ? deps.resolveCached
        : function () { return null; };
    var encode = typeof deps.encode === "function" ? deps.encode : function (s) { return s; };
    var decode = typeof deps.decode === "function" ? deps.decode : function (s) { return s; };

    // ── Immediate "import started" feedback (Req 6.2) ───────────────────
    if (typeof deps.onStarted === "function") {
        try { deps.onStarted(request); } catch (e) { /* feedback must never break import */ }
    }

    // ── Cache-first partition (Req 9.4 / Property 18) ───────────────────
    // Results already present in the Library_Index / Metadata_Cache are served
    // straight from cache; only the remainder is sent to the host.
    var order = [];          // input-order ids for deterministic reassembly
    var resolved = {};       // id -> cached entry
    var uncached = [];       // templates needing the host
    for (var i = 0; i < templates.length; i++) {
        var t = templates[i] || {};
        var id = "" + t.id;
        order.push(id);
        var cached = null;
        try { cached = resolveCached(t); } catch (e) { cached = null; }
        if (cached) {
            resolved[id] = {
                id: id,
                status: cached.status || "cached",
                reason: cached.reason
            };
        } else {
            uncached.push(t);
        }
    }

    // ── All cached → zero Bridge_Calls (Property 18 / Req 9.4) ──────────
    if (uncached.length === 0) {
        done({ perTemplate: assemble(order, resolved, {}), bridgeCalls: 0 });
        return;
    }

    // ── EXACTLY ONE Bridge_Call carrying every uncached template ────────
    // (Req 9.1 single template, Req 9.2 batch of 1..500, Property 17.)
    var payloadHex = encode(JSON.stringify(buildImportPayload({
        rootPath: request.rootPath,
        templates: uncached
    })));

    var callHost = typeof deps.callHost === "function" ? deps.callHost : null;
    if (!callHost) {
        // No transport available: mark every uncached template failed, keep
        // cached results. No Bridge_Call was issued.
        done({
            perTemplate: assemble(order, resolved, failAll(uncached, "no transport")),
            bridgeCalls: 0
        });
        return;
    }

    // ── Exactly-one settlement (Req 2.17) ───────────────────────────────
    // A latch drops a duplicate or late transport reply, and a backstop timer
    // covers a transport that never calls back at all, so `done` always runs and
    // the caller can always clear its "importing" feedback state.
    var settled = false;
    var backstopTimer = null;
    var backstopMs = (typeof deps.timeoutMs === "number" && deps.timeoutMs > 0)
        ? deps.timeoutMs
        : TRANSPORT_BACKSTOP_MS;

    function clearBackstop() {
        if (backstopTimer !== null && typeof clearTimeout === "function") {
            clearTimeout(backstopTimer);
        }
        backstopTimer = null;
    }

    function emit(hostMap, wholeCallError) {
        // Fill any template the host omitted (whole-call failure / no result)
        // as failed, leaving those templates' project state unchanged (Req 9.5).
        var results = {};
        for (var j = 0; j < uncached.length; j++) {
            var uid = "" + uncached[j].id;
            if (hostMap && hostMap[uid]) {
                results[uid] = hostMap[uid];
            } else {
                results[uid] = {
                    id: uid,
                    status: "failed",
                    reason: wholeCallError || "no result for template"
                };
            }
        }
        done({ perTemplate: assemble(order, resolved, results), bridgeCalls: 1 });
    }

    function settleFailed(reason) {
        if (settled) return;
        settled = true;
        clearBackstop();
        emit(null, reason);
    }

    function settleFromHost(hexResult) {
        if (settled) return;
        settled = true;
        clearBackstop();
        if (typeof hexResult === "string" && HOST_ERROR_SENTINELS[hexResult] === true) {
            emit(null, "Host error: " + hexResult);
            return;
        }
        var parsed = parseHostBatchResult(decode(hexResult));
        emit(parsed.map, parsed.error);
    }

    // Arm the backstop BEFORE issuing the call so a transport that throws
    // synchronously, or never calls back, still settles.
    if (typeof setTimeout === "function") {
        backstopTimer = setTimeout(function () {
            settleFailed("Import timed out — After Effects did not respond");
        }, backstopMs);
    }

    try {
        callHost(payloadHex, settleFromHost);
    } catch (eTransport) {
        settleFailed("Import transport error: " + eTransport);
    }
}

/**
 * Reassemble a total, input-ordered result list from cached + host entries.
 * @param {string[]} order
 * @param {Object} cached
 * @param {Object} hostResults
 * @returns {ImportResultEntry[]}
 */
function assemble(order, cached, hostResults) {
    var out = [];
    for (var i = 0; i < order.length; i++) {
        var id = order[i];
        if (cached[id]) out.push(cached[id]);
        else if (hostResults[id]) out.push(hostResults[id]);
        else out.push({ id: id, status: "failed", reason: "missing result" });
    }
    return out;
}

/**
 * Build a failed-entry map for a set of templates.
 * @param {ImportTemplate[]} templates
 * @param {string} reason
 * @returns {Object}
 */
function failAll(templates, reason) {
    var map = {};
    for (var i = 0; i < templates.length; i++) {
        var id = "" + templates[i].id;
        map[id] = { id: id, status: "failed", reason: reason };
    }
    return map;
}

// Dual-load guard: CommonJS for jest, bare global for CEP browser inclusion.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        importTemplates: importTemplates,
        buildImportPayload: buildImportPayload,
        parseHostBatchResult: parseHostBatchResult
    };
}
