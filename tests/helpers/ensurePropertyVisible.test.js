// ============================================================
// tests/helpers/ensurePropertyVisible.test.js
// Property-based test for ensurePropertyVisible (Property_Helper, Req 1).
//
// Feature: engine-robustness-hardening, Property 1
// Property 1: Property visibility traversal unhides root->target and selects target
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
// ============================================================

"use strict";

const fc = require("fast-check");
const { loadHelpers } = require("./loadHelpers");
const { createRecorder, createPropertyFake } = require("./aeFakes");

/**
 * Build a property chain of the given depth from an array of level specs.
 * Each spec is { hidden, throwsParent }:
 *   - hidden: initial hidden flag for that level
 *   - throwsParent: when true, reading parentProperty on that level throws,
 *     which should stop the traversal at that level (Req 1.5).
 *
 * Levels are ordered target-first (index 0 = target). Each level's
 * parentProperty points at the next level, except where throwsParent is set
 * or it is the last (root) level.
 *
 * Returns { target, levels } where levels is the array of property fakes in
 * target->root order and `reachable` marks which levels the traversal should
 * actually collect given the throwing accessors.
 */
function buildChain(specs, recorder) {
    const levels = [];
    for (let i = 0; i < specs.length; i++) {
        levels.push(
            createPropertyFake({
                label: "prop" + i,
                recorder: recorder,
                hidden: specs[i].hidden,
            })
        );
    }

    // Determine how far the collection loop can reach. The loop pushes the
    // current node, then reads parentProperty. If that read throws, it stops
    // AFTER having collected the current node. So a throwing parent at level i
    // means levels 0..i are collected, i+1.. are not.
    let reachableCount = specs.length;
    for (let i = 0; i < specs.length; i++) {
        // Wire parentProperty accessor.
        const isLast = i === specs.length - 1;
        if (specs[i].throwsParent) {
            Object.defineProperty(levels[i], "parentProperty", {
                configurable: true,
                enumerable: true,
                get: function () {
                    throw new Error("parentProperty access error at level " + i);
                },
            });
            reachableCount = Math.min(reachableCount, i + 1);
        } else {
            const parent = isLast ? null : levels[i + 1];
            // Reset parentProperty to the intended parent (createPropertyFake
            // defaulted it to null).
            Object.defineProperty(levels[i], "parentProperty", {
                configurable: true,
                enumerable: true,
                get: function () {
                    return parent;
                },
            });
        }
    }

    return { target: levels[0], levels: levels, reachableCount: reachableCount };
}

describe("ensurePropertyVisible (Property 1)", () => {
    test("unhides reachable chain root->target, selects target, never throws, stops at throwing level", () => {
        const levelArb = fc.record({
            hidden: fc.boolean(),
            throwsParent: fc.boolean(),
        });

        fc.assert(
            fc.property(
                // Chains of arbitrary depth (1..8 levels).
                fc.array(levelArb, { minLength: 1, maxLength: 8 }),
                (specs) => {
                    const recorder = createRecorder();
                    const { get } = loadHelpers({ injected: {} });
                    const ensurePropertyVisible = get("ensurePropertyVisible");

                    const { target, levels, reachableCount } = buildChain(specs, recorder);

                    // Function must never throw.
                    let result;
                    expect(() => {
                        result = ensurePropertyVisible(target);
                    }).not.toThrow();

                    // Traversal stops at the throwing level: only `reachableCount`
                    // levels are processed (Req 1.5).
                    expect(result).toBe(reachableCount);

                    // Every reached member is unhidden (Req 1.2).
                    for (let i = 0; i < reachableCount; i++) {
                        expect(levels[i].hidden).toBe(false);
                    }

                    // Unreachable levels beyond the throwing level are untouched:
                    // their hidden flag stays at whatever it was initialized to.
                    for (let i = reachableCount; i < levels.length; i++) {
                        expect(levels[i].hidden).toBe(specs[i].hidden);
                    }

                    // Target ends selected (Req 1.4).
                    expect(target.selected).toBe(true);

                    // Order is root->target: for the reached window, the last
                    // set:hidden event (if any) among reached levels must be the
                    // target (prop0) OR the target had no hidden set because it
                    // was already visible. Verify by scanning recorded set:hidden
                    // events restricted to reached labels and confirming the
                    // sequence of level indices is strictly decreasing.
                    const reachedLabels = {};
                    for (let i = 0; i < reachableCount; i++) reachedLabels["prop" + i] = i;
                    const setHiddenOrder = recorder.events
                        .filter(function (e) {
                            return e.name === "set:hidden" && reachedLabels.hasOwnProperty(e.target);
                        })
                        .map(function (e) {
                            return reachedLabels[e.target];
                        });
                    for (let k = 1; k < setHiddenOrder.length; k++) {
                        // Root has the highest index; target is 0. Processing
                        // root->target means indices appear in decreasing order.
                        expect(setHiddenOrder[k]).toBeLessThan(setHiddenOrder[k - 1]);
                    }
                }
            ),
            { numRuns: 100 }
        );
    });
});
