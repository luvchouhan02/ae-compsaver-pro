/**
 * Property 33 — Full scan is triggered only when the persisted index is unusable.
 *
 * Feature: save-import-performance-redesign — Task 2.11
 * Validates: Requirements 12.4
 *
 * What is under test
 * ------------------
 * The pure, dependency-injected full-scan trigger predicate
 * `LibraryIndex.fullScanRequired(serialized, currentDiskKey)` from
 * js/core/persistence.js.
 *
 * The design's Property 33 states: for ANY persisted-index state, a full
 * Library_Scan is triggered IF AND ONLY IF the persisted index is
 *   (a) absent, OR
 *   (b) fails to parse, OR
 *   (c) its recorded validity key does not equal the current disk validity key.
 *
 * How it is exercised
 * -------------------
 * Because this is a biconditional, every generated case carries an EXPECTED
 * boolean derived from how the case was CONSTRUCTED (not from the predicate
 * under test), so the test is a genuine oracle rather than a tautology:
 *
 *   - absent      : serialized ∈ {null, undefined, ""}            → expect true
 *   - unparseable : invalid JSON, or valid JSON of the wrong shape → expect true
 *   - valid       : a real serialized LibraryIndex with a known
 *                   recorded validity key                          → expect
 *                   (recordedKey !== currentDiskKey)
 *
 * The "valid" arm independently generates the recorded key and the current disk
 * key AND sometimes forces them equal, so both sides of the biconditional (key
 * match → no scan, key mismatch → scan) are exercised.
 *
 * Pure logic only — no filesystem, no browser, no After Effects.
 */

"use strict";

const fc = require("fast-check");
const { LibraryIndex } = require("../js/core/persistence.js");

// ─── Generators ──────────────────────────────────────────────────────────────

const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,6}$/);

const folderPathArb = fc
    .array(segment, { minLength: 1, maxLength: 4 })
    .map((segs) => "lib/" + segs.join("/"));

// A validity key as produced/recorded at runtime: string / number, or null when
// a key could not be derived. No NaN (JSON would coerce it to null).
const validityKeyArb = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.constant(null)
);

// Build a real, parseable serialized LibraryIndex with a known recorded key.
function serializedValidIndex(rawEntries, recordedKey) {
    const idx = new LibraryIndex({ validityKey: recordedKey });
    for (const e of rawEntries) idx.insertAtHead({ folderPath: e });
    return idx.serialize();
}

// ─── Case generators, each pairing a `serialized` input with the EXPECTED result ─

// (a) Absent persisted index → a full scan is always required.
const absentCaseArb = fc.record({
    serialized: fc.constantFrom(null, undefined, ""),
    currentDiskKey: validityKeyArb,
    expected: fc.constant(true),
    label: fc.constant("absent"),
});

// (b) Unparseable persisted index → a full scan is always required.
//   - not valid JSON at all, OR
//   - valid JSON but the wrong shape (not an object with an `entries` array).
const notJsonArb = fc.constantFrom(
    "{",
    "not json",
    "]]",
    "{ entries: }",
    "undefined",
    "%%%"
);
const wrongShapeArb = fc.oneof(
    fc.constant("123"),                 // a bare number
    fc.constant("\"a string\""),        // a bare string
    fc.constant("true"),                // a bare boolean
    fc.constant("null"),                // JSON null
    fc.constant("[1,2,3]"),             // an array, not an object envelope
    fc.constant("{}"),                  // object with no entries array
    fc.constant("{\"entries\":5}"),     // entries present but not an array
    fc.constant("{\"entries\":\"x\"}")  // entries a string, not an array
);
const unparseableCaseArb = fc.record({
    serialized: fc.oneof(notJsonArb, wrongShapeArb),
    currentDiskKey: validityKeyArb,
    expected: fc.constant(true),
    label: fc.constant("unparseable"),
});

// (c) Valid persisted index → scan required IFF recorded key !== current disk key.
//   Sometimes force the current key equal to the recorded key so the
//   "keys match → no scan" branch is exercised alongside the mismatch branch.
const validCaseArb = fc
    .record({
        entries: fc.array(folderPathArb, { maxLength: 12 }),
        recordedKey: validityKeyArb,
        otherKey: validityKeyArb,
        forceEqual: fc.boolean(),
    })
    .map(({ entries, recordedKey, otherKey, forceEqual }) => {
        const currentDiskKey = forceEqual ? recordedKey : otherKey;
        return {
            serialized: serializedValidIndex(entries, recordedKey),
            currentDiskKey: currentDiskKey,
            // Strict equality, mirroring the predicate's key comparison. The
            // recorded key survives JSON round-trip unchanged for string/number/
            // null, so this construction-time oracle is exact.
            expected: recordedKey !== currentDiskKey,
            label: "valid",
        };
    });

const caseArb = fc.oneof(absentCaseArb, unparseableCaseArb, validCaseArb);

// ─── Property 33 ─────────────────────────────────────────────────────────────
// Feature: save-import-performance-redesign, Property 33: Full scan is triggered only when the persisted index is unusable
// Validates: Requirements 12.4
describe("Property 33: Full scan is triggered only when the persisted index is unusable (Req 12.4)", () => {
    test("fullScanRequired is true iff the index is absent, unparseable, or key-mismatched", () => {
        fc.assert(
            fc.property(caseArb, (c) => {
                const actual = LibraryIndex.fullScanRequired(c.serialized, c.currentDiskKey);
                expect(actual).toBe(c.expected);
            }),
            { numRuns: 15 }
        );
    });

    // ─── Focused examples (complement the universal property) ─────────────────
    test("absent persisted index requires a full scan regardless of the disk key", () => {
        expect(LibraryIndex.fullScanRequired(null, "12:4096:1700000000000")).toBe(true);
        expect(LibraryIndex.fullScanRequired(undefined, null)).toBe(true);
        expect(LibraryIndex.fullScanRequired("", "k")).toBe(true);
    });

    test("unparseable persisted index requires a full scan", () => {
        expect(LibraryIndex.fullScanRequired("{ not json", "k")).toBe(true);
        expect(LibraryIndex.fullScanRequired("[]", "k")).toBe(true); // wrong shape
        expect(LibraryIndex.fullScanRequired("{}", "k")).toBe(true); // no entries array
    });

    test("valid persisted index with a matching key does NOT require a full scan", () => {
        const idx = new LibraryIndex({ validityKey: "12:4096:1700000000000" });
        idx.insertAtHead({ folderPath: "lib/a", id: "a" });
        const serialized = idx.serialize();
        expect(LibraryIndex.fullScanRequired(serialized, "12:4096:1700000000000")).toBe(false);
    });

    test("valid persisted index with a mismatched key requires a full scan", () => {
        const idx = new LibraryIndex({ validityKey: "12:4096:1700000000000" });
        idx.insertAtHead({ folderPath: "lib/a", id: "a" });
        const serialized = idx.serialize();
        expect(LibraryIndex.fullScanRequired(serialized, "99:1:0")).toBe(true);
    });

    test("a null recorded key matches a null current disk key (no scan)", () => {
        const idx = new LibraryIndex({ validityKey: null });
        idx.insertAtHead({ folderPath: "lib/a", id: "a" });
        const serialized = idx.serialize();
        expect(LibraryIndex.fullScanRequired(serialized, null)).toBe(false);
    });

    test("string vs number keys are compared strictly (mismatch requires a scan)", () => {
        const idx = new LibraryIndex({ validityKey: 5 });
        idx.insertAtHead({ folderPath: "lib/a", id: "a" });
        const serialized = idx.serialize();
        expect(LibraryIndex.fullScanRequired(serialized, "5")).toBe(true);
        expect(LibraryIndex.fullScanRequired(serialized, 5)).toBe(false);
    });
});
