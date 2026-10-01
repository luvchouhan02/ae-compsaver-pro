// ============================================================
// core/analysisHelpers.js — code-checkable slices of the analysis deliverables
// ------------------------------------------------------------
// Feature: save-import-performance-redesign (Task 10.1)
//
// The Bottleneck_Profile (Requirement 7) and MNTOOLS_Comparison (Requirement
// 14) are written analysis deliverables — prose + measured tables — that live
// outside this code plan. This module implements ONLY their pure,
// input-varying, machine-checkable slices so the deliverables can be generated
// and validated deterministically:
//
//   1. rankBottlenecks(stages)      — order measured stages by descending
//                                     millisecond cost, breaking ties on equal
//                                     cost by stage name in ascending
//                                     alphabetical order (Req 7.2 / Property 35).
//
//   2. flagBottlenecks(stages, opts) — classify any stage whose measured time
//                                     is >= 10% of total measured import time
//                                     as a bottleneck (Req 7.4).
//
//   3. deriveImportTarget(...)      — derive a Requirement 6 performance target
//   / deriveImportTargets(...)        as the recorded median Baseline_Import_Time
//                                     for a size class multiplied by the target
//                                     factor stated in Requirement 6 (Req 14.3).
//
// The module owns no DOM and no CSInterface reference; it is pure and
// dependency-free so jest + fast-check can validate it without After Effects.
// ============================================================

// The single import performance target factor stated in Requirement 6.1:
// the Import_Engine must complete within 1.2x the median Baseline_Import_Time.
var IMPORT_TARGET_FACTOR = 1.2;

// The bottleneck-classification threshold from Requirement 7.4: a stage whose
// measured cost is 10% or more of total measured import time is a bottleneck.
var BOTTLENECK_THRESHOLD = 0.1;

/**
 * @typedef {Object} MeasuredStage
 * @property {string} name   Stage name (e.g. "asset relinking", "project open").
 * @property {number} ms     Measured time cost of the stage, in milliseconds.
 */

/**
 * @typedef {Object} FlaggedStage
 * @property {string}  name          Stage name.
 * @property {number}  ms            Measured time cost, in milliseconds.
 * @property {number}  percent       Share of total measured time in [0, 1].
 * @property {boolean} isBottleneck  True iff percent >= BOTTLENECK_THRESHOLD.
 */

/**
 * Coerce an input value to a finite, non-negative millisecond number.
 * Non-numeric, NaN, Infinity, and negative inputs collapse to 0 so ranking and
 * flagging stay total over arbitrary input (an unmeasured stage should be
 * supplied via the deliverable's "unmeasured" record, not a bogus number).
 * @param {*} value
 * @returns {number}
 */
function toMs(value) {
    var n = typeof value === "number" ? value : Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return n;
}

/**
 * Coerce an input value to a string stage name (empty string when absent).
 * @param {*} value
 * @returns {string}
 */
function toName(value) {
    return value == null ? "" : "" + value;
}

/**
 * Rank measured import stages in descending order of measured time cost in
 * milliseconds, breaking ties between equal time costs by stage name in
 * ascending (case-sensitive, locale-independent) alphabetical order.
 *
 * The comparator is total (handles both keys), so the result does not depend on
 * the engine's sort stability. The input array is never mutated (Req 7.2 /
 * Property 35).
 *
 * @param {MeasuredStage[]} stages
 * @returns {MeasuredStage[]} A new array ordered by (−ms, +name).
 */
function rankBottlenecks(stages) {
    var list = [];
    if (stages && stages.length) {
        for (var i = 0; i < stages.length; i++) {
            var s = stages[i] || {};
            list.push({ name: toName(s.name), ms: toMs(s.ms) });
        }
    }
    list.sort(function (a, b) {
        // Primary key: descending millisecond cost.
        if (a.ms !== b.ms) return b.ms - a.ms;
        // Tie-break: ascending alphabetical stage name.
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
    });
    return list;
}

/**
 * Sum the measured millisecond cost across a set of stages.
 * @param {MeasuredStage[]} stages
 * @returns {number}
 */
function totalMeasuredMs(stages) {
    var total = 0;
    if (stages && stages.length) {
        for (var i = 0; i < stages.length; i++) {
            total += toMs((stages[i] || {}).ms);
        }
    }
    return total;
}

/**
 * Classify each stage as a bottleneck iff its measured time cost is 10% or more
 * of total measured import time (Req 7.4).
 *
 * The total defaults to the sum of the supplied stages' costs, but a caller may
 * pass an explicit `total` (e.g. total import time that includes unmeasured
 * stages) via `opts.total`. When the total is 0 no stage can reach the
 * threshold, so none are flagged. The input array is never mutated.
 *
 * @param {MeasuredStage[]} stages
 * @param {{ total?: number }} [opts]
 * @returns {FlaggedStage[]} One entry per input stage, in input order, each
 *   annotated with its `percent` share and `isBottleneck` classification.
 */
function flagBottlenecks(stages, opts) {
    opts = opts || {};
    var total = opts.total != null ? toMs(opts.total) : totalMeasuredMs(stages);
    var out = [];
    if (stages && stages.length) {
        for (var i = 0; i < stages.length; i++) {
            var s = stages[i] || {};
            var ms = toMs(s.ms);
            var percent = total > 0 ? ms / total : 0;
            out.push({
                name: toName(s.name),
                ms: ms,
                percent: percent,
                isBottleneck: total > 0 && percent >= BOTTLENECK_THRESHOLD
            });
        }
    }
    return out;
}

/**
 * Derive a single Requirement 6 Import_Engine performance target as the
 * recorded median Baseline_Import_Time for a size class multiplied by the
 * target factor stated in Requirement 6 (Req 14.3).
 *
 * @param {number} medianBaselineMs   Median Baseline_Import_Time for the size class, in ms.
 * @param {number} [factor]           Target factor (defaults to IMPORT_TARGET_FACTOR = 1.2).
 * @returns {number} The derived target in milliseconds (median × factor).
 */
function deriveImportTarget(medianBaselineMs, factor) {
    var median = toMs(medianBaselineMs);
    var f = typeof factor === "number" && isFinite(factor) && factor >= 0
        ? factor
        : IMPORT_TARGET_FACTOR;
    return median * f;
}

/**
 * Derive the Requirement 6 performance target for every size class from a map
 * of recorded median Baseline_Import_Time values.
 *
 * @param {Object.<string, number>} medianBaselinesBySizeClass
 *        e.g. { small: 120, medium: 640, large: 3100 } (ms).
 * @param {number} [factor]  Target factor (defaults to IMPORT_TARGET_FACTOR = 1.2).
 * @returns {Object.<string, number>} A new map size class -> derived target (ms).
 */
function deriveImportTargets(medianBaselinesBySizeClass, factor) {
    var out = {};
    var src = medianBaselinesBySizeClass || {};
    for (var key in src) {
        if (Object.prototype.hasOwnProperty.call(src, key)) {
            out[key] = deriveImportTarget(src[key], factor);
        }
    }
    return out;
}

// Dual-load guard: CommonJS for jest, bare global for CEP browser inclusion.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        rankBottlenecks: rankBottlenecks,
        flagBottlenecks: flagBottlenecks,
        totalMeasuredMs: totalMeasuredMs,
        deriveImportTarget: deriveImportTarget,
        deriveImportTargets: deriveImportTargets,
        IMPORT_TARGET_FACTOR: IMPORT_TARGET_FACTOR,
        BOTTLENECK_THRESHOLD: BOTTLENECK_THRESHOLD
    };
}
