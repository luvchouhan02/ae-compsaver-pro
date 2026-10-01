/**
 * Unit tests for analysis flagging threshold and target derivation.
 * =================================================================
 * Feature: save-import-performance-redesign (Task 10.3)
 *
 * These are example-based unit tests (not property tests) that exercise the
 * pure analysis helpers in js/core/analysisHelpers.js on representative values,
 * with a focus on boundary conditions:
 *
 *   - flagBottlenecks(): the 10% bottleneck-classification threshold, including
 *     the exactly-10% and just-below-10% cases, plus the unmeasured/zero-total
 *     behavior (Req 7.4, and total-with-unmeasured handling supporting Req 7.5).
 *
 *   - deriveImportTarget() / deriveImportTargets(): the median-baseline × 1.2
 *     target-factor arithmetic on representative size-class values (Req 14.3).
 *
 * Validates: Requirements 7.4, 7.5, 14.3
 */

const {
    flagBottlenecks,
    deriveImportTarget,
    deriveImportTargets,
    IMPORT_TARGET_FACTOR,
    BOTTLENECK_THRESHOLD,
} = require("../js/core/analysisHelpers");

// ─── Req 7.4 — flagBottlenecks 10% threshold boundary ────────────────────────

describe("Req 7.4 — flagBottlenecks: 10% bottleneck-classification threshold", () => {
    test("module constants match the stated Requirement 6/7 values", () => {
        expect(BOTTLENECK_THRESHOLD).toBe(0.1);
        expect(IMPORT_TARGET_FACTOR).toBe(1.2);
    });

    test("a stage at exactly 10% of total is classified as a bottleneck", () => {
        // 100ms of a 1000ms total = exactly 10%. Boundary is inclusive (>=).
        const stages = [
            { name: "asset relinking", ms: 100 },
            { name: "project open", ms: 900 },
        ];
        const flagged = flagBottlenecks(stages);

        const relink = flagged.find((s) => s.name === "asset relinking");
        expect(relink.percent).toBeCloseTo(0.1, 10);
        expect(relink.isBottleneck).toBe(true);
    });

    test("a stage just below 10% of total is NOT classified as a bottleneck", () => {
        // 99ms of a 1000ms total = 9.9%, just below the 10% boundary.
        const stages = [
            { name: "bridge communication", ms: 99 },
            { name: "project open", ms: 901 },
        ];
        const flagged = flagBottlenecks(stages);

        const bridge = flagged.find((s) => s.name === "bridge communication");
        expect(bridge.percent).toBeCloseTo(0.099, 10);
        expect(bridge.isBottleneck).toBe(false);
    });

    test("a stage just above 10% of total is classified as a bottleneck", () => {
        // 101ms of a 1000ms total = 10.1%, just above the 10% boundary.
        const stages = [
            { name: "filesystem ops", ms: 101 },
            { name: "project open", ms: 899 },
        ];
        const flagged = flagBottlenecks(stages);

        const fs = flagged.find((s) => s.name === "filesystem ops");
        expect(fs.percent).toBeCloseTo(0.101, 10);
        expect(fs.isBottleneck).toBe(true);
    });

    test("classifies a representative multi-stage profile with mixed shares", () => {
        // Total = 2000ms. Shares: 60%, 25%, 10% (boundary), 5% (below).
        const stages = [
            { name: "project open", ms: 1200 }, // 60%   -> bottleneck
            { name: "asset relinking", ms: 500 }, // 25%   -> bottleneck
            { name: "thumbnail loading", ms: 200 }, // 10%   -> bottleneck (boundary)
            { name: "repeated parsing", ms: 100 }, // 5%    -> not
        ];
        const flagged = flagBottlenecks(stages);

        expect(flagged.map((s) => s.isBottleneck)).toEqual([true, true, true, false]);
        expect(flagged.map((s) => s.percent)).toEqual([0.6, 0.25, 0.1, 0.05]);
        // Output preserves input order and length.
        expect(flagged.map((s) => s.name)).toEqual([
            "project open",
            "asset relinking",
            "thumbnail loading",
            "repeated parsing",
        ]);
    });

    test("uses an explicit total (including unmeasured stages) when provided (supports Req 7.5)", () => {
        // Measured stages sum to 500ms, but true total import time is 5000ms
        // (the remaining 4500ms is unmeasured). Against the true total, a 500ms
        // stage is exactly 10% and remains a bottleneck; a smaller stage falls
        // below the threshold it would have exceeded against the measured-only sum.
        const stages = [
            { name: "asset relinking", ms: 500 }, // 10% of 5000 -> bottleneck
            { name: "bridge communication", ms: 400 }, // 8% of 5000 -> not
        ];
        const flagged = flagBottlenecks(stages, { total: 5000 });

        const relink = flagged.find((s) => s.name === "asset relinking");
        const bridge = flagged.find((s) => s.name === "bridge communication");
        expect(relink.percent).toBeCloseTo(0.1, 10);
        expect(relink.isBottleneck).toBe(true);
        expect(bridge.percent).toBeCloseTo(0.08, 10);
        expect(bridge.isBottleneck).toBe(false);
    });

    test("when total measured time is zero, no stage is flagged", () => {
        const stages = [
            { name: "project open", ms: 0 },
            { name: "asset relinking", ms: 0 },
        ];
        const flagged = flagBottlenecks(stages);

        flagged.forEach((s) => {
            expect(s.percent).toBe(0);
            expect(s.isBottleneck).toBe(false);
        });
    });

    test("empty or missing stage list yields an empty result", () => {
        expect(flagBottlenecks([])).toEqual([]);
        expect(flagBottlenecks(undefined)).toEqual([]);
        expect(flagBottlenecks(null)).toEqual([]);
    });

    test("does not mutate the input array or its stage objects", () => {
        const stages = [{ name: "project open", ms: 500 }];
        const snapshot = JSON.parse(JSON.stringify(stages));
        flagBottlenecks(stages);
        expect(stages).toEqual(snapshot);
    });
});

// ─── Req 14.3 — deriveImportTarget / deriveImportTargets arithmetic ───────────

describe("Req 14.3 — deriveImportTarget: median baseline × 1.2 target factor", () => {
    test("derives target as median × 1.2 by default for representative baselines", () => {
        // Representative recorded median Baseline_Import_Time values (ms).
        expect(deriveImportTarget(100)).toBeCloseTo(120, 10); // small
        expect(deriveImportTarget(640)).toBeCloseTo(768, 10); // medium
        expect(deriveImportTarget(3100)).toBeCloseTo(3720, 10); // large
    });

    test("uses IMPORT_TARGET_FACTOR (1.2) as the default multiplier", () => {
        const median = 500;
        expect(deriveImportTarget(median)).toBeCloseTo(median * IMPORT_TARGET_FACTOR, 10);
    });

    test("honors an explicit finite non-negative factor override", () => {
        expect(deriveImportTarget(1000, 1.5)).toBeCloseTo(1500, 10);
        expect(deriveImportTarget(1000, 2)).toBeCloseTo(2000, 10);
        expect(deriveImportTarget(1000, 0)).toBe(0);
    });

    test("falls back to the default factor for invalid factor inputs", () => {
        // Non-numeric, NaN, Infinity, and negative factors are rejected in favor
        // of IMPORT_TARGET_FACTOR (1.2).
        expect(deriveImportTarget(1000, "fast")).toBeCloseTo(1200, 10);
        expect(deriveImportTarget(1000, NaN)).toBeCloseTo(1200, 10);
        expect(deriveImportTarget(1000, Infinity)).toBeCloseTo(1200, 10);
        expect(deriveImportTarget(1000, -1)).toBeCloseTo(1200, 10);
    });

    test("coerces invalid median baselines to 0 (target of 0)", () => {
        expect(deriveImportTarget(-100)).toBe(0);
        expect(deriveImportTarget(NaN)).toBe(0);
        expect(deriveImportTarget(Infinity)).toBe(0);
        expect(deriveImportTarget("nope")).toBe(0);
        expect(deriveImportTarget(undefined)).toBe(0);
    });

    test("accepts numeric strings as median baselines (coerced)", () => {
        expect(deriveImportTarget("500")).toBeCloseTo(600, 10);
    });
});

describe("Req 14.3 — deriveImportTargets: per-size-class target map", () => {
    test("derives targets for every size class using the default 1.2 factor", () => {
        const baselines = { small: 120, medium: 640, large: 3100 };
        const targets = deriveImportTargets(baselines);

        expect(targets).toEqual({
            small: 120 * 1.2,
            medium: 640 * 1.2,
            large: 3100 * 1.2,
        });
    });

    test("applies an explicit factor to every size class", () => {
        const baselines = { small: 100, large: 1000 };
        const targets = deriveImportTargets(baselines, 1.5);

        expect(targets.small).toBeCloseTo(150, 10);
        expect(targets.large).toBeCloseTo(1500, 10);
    });

    test("returns a new empty object for empty or missing input", () => {
        expect(deriveImportTargets({})).toEqual({});
        expect(deriveImportTargets(undefined)).toEqual({});
        expect(deriveImportTargets(null)).toEqual({});
    });

    test("does not mutate the input baseline map", () => {
        const baselines = { small: 120, medium: 640 };
        const snapshot = JSON.parse(JSON.stringify(baselines));
        deriveImportTargets(baselines);
        expect(baselines).toEqual(snapshot);
    });

    test("does not include inherited (non-own) properties", () => {
        const proto = { inherited: 999 };
        const baselines = Object.create(proto);
        baselines.small = 100;
        const targets = deriveImportTargets(baselines);

        expect(targets).toEqual({ small: 120 });
        expect(targets).not.toHaveProperty("inherited");
    });
});
