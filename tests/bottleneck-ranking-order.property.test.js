/**
 * Property 35 — Bottleneck ranking orders by descending cost with alphabetical tie-break.
 *
 * Feature: save-import-performance-redesign — Task 10.2
 * Validates: Requirements 7.2
 *
 * What is under test
 * ------------------
 * The pure ranking helper `rankBottlenecks(stages)` from
 * js/core/analysisHelpers.js (task 10.1). The design's Property 35 states:
 * for ANY set of measured stages (name, milliseconds), the helper orders
 * stages by descending millisecond cost and breaks ties between equal costs
 * by stage name in ascending alphabetical order.
 *
 * How it is exercised
 * -------------------
 * The module is pure CommonJS with no DOM / CSInterface dependency, so it is
 * required directly. fast-check generates random sets of stages (min 100
 * iterations). ms values are drawn from a small integer pool and names from a
 * small alphabet so ties are frequent, forcing the alphabetical tie-break to
 * be exercised rather than left to chance.
 *
 * For each generated set we prove:
 *   - ordering: every adjacent pair is in (descending ms, then ascending name)
 *     order under the same coercion the helper applies;
 *   - permutation: the output is a multiset permutation of the coerced input
 *     (nothing dropped, duplicated, or invented);
 *   - purity: the input array/objects are not mutated.
 */

"use strict";

const fc = require("fast-check");
const { rankBottlenecks } = require("../js/core/analysisHelpers.js");

// Mirror the helper's input coercion so the oracle compares apples to apples:
// non-numeric / NaN / Infinity / negative ms collapse to 0, names to strings.
function toMs(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return n;
}
function toName(value) {
    return value == null ? "" : "" + value;
}

// Small pools so equal costs and equal-cost/different-name collisions are
// common, guaranteeing the tie-break path is exercised.
const msArb = fc.constantFrom(0, 5, 5, 10, 10, 100, 100, 250);
const nameArb = fc.constantFrom("alpha", "beta", "gamma", "Alpha", "Beta", "", "delta");

const stageArb = fc.record({ name: nameArb, ms: msArb });
const stagesArb = fc.array(stageArb, { minLength: 0, maxLength: 12 });

// Feature: save-import-performance-redesign, Property 35: Bottleneck ranking orders by descending cost with alphabetical tie-break
describe("Property 35: Bottleneck ranking orders by descending cost with alphabetical tie-break (Req 7.2)", () => {
    test("for any set of measured stages, output is ordered by (descending ms, ascending name) and is a permutation of the input", () => {
        fc.assert(
            fc.property(stagesArb, (stages) => {
                // Snapshot input to prove purity (no mutation) afterward.
                const before = JSON.stringify(stages);

                const ranked = rankBottlenecks(stages);

                // ---- ordering: every adjacent pair respects the total order ----
                for (let i = 0; i + 1 < ranked.length; i++) {
                    const a = ranked[i];
                    const b = ranked[i + 1];
                    if (a.ms !== b.ms) {
                        // Primary key: strictly descending millisecond cost.
                        expect(a.ms).toBeGreaterThan(b.ms);
                    } else {
                        // Tie-break: ascending (case-sensitive) alphabetical name.
                        expect(a.name <= b.name).toBe(true);
                    }
                }

                // ---- permutation: same multiset of coerced (name, ms) pairs ----
                const key = (s) => JSON.stringify([toName(s.name), toMs(s.ms)]);
                const expected = stages.map(key).sort();
                const actual = ranked.map(key).sort();
                expect(actual).toEqual(expected);

                // ---- purity: the input was not mutated ----
                expect(JSON.stringify(stages)).toBe(before);
            }),
            { numRuns: 200 }
        );
    });
});
