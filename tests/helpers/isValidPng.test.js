// ============================================================
// tests/helpers/isValidPng.test.js
// Property-based test for isValidPng + renderFrameToPng (Thumbnail helpers, Req 3).
//
// Feature: engine-robustness-hardening, Property 3
// Property 3: PNG validity classification
//   For any file-like object with { exists, length }, isValidPng returns true
//   exactly when exists is true and length > 64; and renderFrameToPng reports
//   success equal to isValidPng(outFile), reporting failure (never success)
//   when the render throws.
// Validates: Requirements 3.2, 3.3, 3.4
// ============================================================

"use strict";

const fc = require("fast-check");
const { loadHelpers } = require("./loadHelpers");
const { createCompFake, createAppFake, createFileFake } = require("./aeFakes");

// The pure truth-table oracle: a Valid PNG both exists and has byte length > 64.
function expectedValid(exists, length) {
    return !!(exists && length > 64);
}

describe("isValidPng + renderFrameToPng (Property 3)", () => {
    // length arbitrary that deliberately folds in the boundary values 0/64/65
    // (64 is the exclusive threshold) alongside a broader numeric range.
    const lengthArb = fc.oneof(
        fc.constantFrom(0, 64, 65),
        fc.nat({ max: 4096 })
    );
    const existsArb = fc.boolean();

    test("isValidPng returns true exactly when exists && length > 64", () => {
        fc.assert(
            fc.property(existsArb, lengthArb, (exists, length) => {
                const { get } = loadHelpers({ injected: {} });
                const isValidPng = get("isValidPng");

                const file = createFileFake({ exists: exists, length: length });
                expect(isValidPng(file)).toBe(expectedValid(exists, length));
            }),
            { numRuns: 100 }
        );

        // Guard against a null/undefined file (Req 3.3 defensiveness).
        const { get } = loadHelpers({ injected: {} });
        const isValidPng = get("isValidPng");
        expect(isValidPng(null)).toBe(false);
        expect(isValidPng(undefined)).toBe(false);
    });

    test("renderFrameToPng.success === isValidPng(outFile); throwing render yields success:false and still ends suppression", () => {
        fc.assert(
            fc.property(existsArb, lengthArb, fc.boolean(), (exists, length, renderThrows) => {
                const app = createAppFake({});
                const { get } = loadHelpers({ injected: { app: app } });
                const isValidPng = get("isValidPng");
                const renderFrameToPng = get("renderFrameToPng");

                // The output file the render is supposed to produce.
                const outFile = createFileFake({ exists: exists, length: length });

                // A comp fake whose saveFrameToPng either succeeds (no-op: the
                // outFile state is fixed by the generator) or throws to emulate
                // a failed render.
                const comp = createCompFake({});
                comp.saveFrameToPng = function (time, file) {
                    if (renderThrows) {
                        throw new Error("saveFrameToPng failed");
                    }
                };

                const result = renderFrameToPng(comp, 1.5, outFile);

                if (renderThrows) {
                    // Req 3.2: a thrown render reports failure - never success.
                    expect(result.success).toBe(false);
                    expect(typeof result.error).toBe("string");
                } else {
                    // Req 3.3/3.4: success tracks the Valid PNG predicate exactly.
                    expect(result.success).toBe(isValidPng(outFile));
                    expect(result.success).toBe(expectedValid(exists, length));
                }

                // Req 3.1/3.2: suppression is bracketed and always torn down,
                // even when the render throws - depth returns to 0.
                expect(app.suppressDepth()).toBe(0);
                expect(app.calls.filter((c) => c.name === "beginSuppressDialogs").length).toBe(1);
                expect(app.calls.filter((c) => c.name === "endSuppressDialogs").length).toBe(1);
            }),
            { numRuns: 100 }
        );
    });
});
