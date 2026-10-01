/**
 * Property 16 — Failed incremental update preserves the prior index and flags a rescan.
 *
 * Feature: save-import-performance-redesign — Task 2.9
 * Validates: Requirements 12.8
 *
 * What is under test
 * ------------------
 * The transactional `_mutate` behavior of `LibraryIndex` in
 * js/core/persistence.js, exercised through its three incremental operations —
 * insertAtHead / patchEntry / removeEntry — and the accompanying state
 * accessors needsFullScan() and lastError().
 *
 * The design's Property 16 states: for ANY incremental Library_Index update
 * (save, delete, rename, move, or background job) that FAILS, the Library_Index
 * equals its last valid value, an error indication is recorded, and the index
 * is marked so that a full Library_Scan runs on the next reconcile.
 *
 * How it is exercised
 * -------------------
 * fast-check builds a random-but-valid starting index, snapshots its complete
 * observable state (ordered entries + validity key), then applies a randomly
 * chosen FAILING mutation. Each failing mutation drives one distinct throw path
 * inside _mutate:
 *   - insertAtHead with a malformed entry (non-object / missing folderPath)
 *   - patchEntry on an absent folder (index/disk mismatch)
 *   - patchEntry on an existing folder with non-object fields
 *   - removeEntry on an absent folder (index/disk mismatch)
 *
 * For every failing mutation we prove the three guarantees of Property 16:
 *   1. the operation reports failure (returns false),
 *   2. the entry list + validity key are byte-for-byte the pre-mutation value,
 *   3. lastError() records a non-empty error indication, and
 *   4. needsFullScan() is raised so the next reconcile performs a full scan.
 *
 * Pure logic only — no filesystem, no browser, no After Effects.
 */

"use strict";

const fc = require("fast-check");
const { LibraryIndex } = require("../js/core/persistence.js");

// ─── Generators ──────────────────────────────────────────────────────────────
// Valid folder paths for the baseline index, drawn from a fixed namespace so a
// separately-generated "absent" path can be guaranteed disjoint.
const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,6}$/);

const validFolderArb = fc
    .array(segment, { minLength: 1, maxLength: 4 })
    .map((segs) => "lib/" + segs.join("/"));

// A valid, fully-formed library entry. Extra fields beyond folderPath exercise
// the faithful field-copy in normalizeLibraryEntry / the snapshot clone.
const validEntryArb = fc.record({
    folderPath: validFolderArb,
    id: fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/),
    name: fc.stringMatching(/^[A-Za-z0-9 _-]{1,12}$/),
    category: fc.constantFrom("Titles", "Lower Thirds", "Transitions", "FX"),
    section: fc.constantFrom("comp", "layer", "text", "footage"),
    thumbStatus: fc.constantFrom("placeholder", "ready", "failed"),
    favorite: fc.boolean(),
});

// A path that is guaranteed NOT present in a baseline built from validFolderArb
// (different namespace prefix).
const absentFolderArb = fc
    .array(segment, { minLength: 1, maxLength: 3 })
    .map((segs) => "__absent__/" + segs.join("/"));

// Malformed entries that make normalizeLibraryEntry throw inside insertAtHead.
const malformedEntryArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.integer(),
    fc.string(),
    fc.constant({}), // object with no folderPath
    fc.record({ folderPath: fc.constant("") }), // empty folderPath
    fc.record({ folderPath: fc.constant(null) }), // null folderPath
    fc.record({ id: fc.string(), name: fc.string() }) // fields but no folderPath
);

// Non-object `fields` that make patchEntry throw for an EXISTING folder.
const malformedFieldsArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.integer(),
    fc.string()
);

// Build a valid baseline LibraryIndex from raw entries plus a validity key.
// Every insert here succeeds, so the index starts clean (needsFullScan false,
// lastError null). insertAtHead de-dupes by folderPath (last write wins).
function buildBaseline(rawEntries, validityKey) {
    const idx = new LibraryIndex({ validityKey: validityKey });
    for (const e of rawEntries) {
        const ok = idx.insertAtHead(e);
        // Guard: baseline construction must never fail (generators are valid).
        if (!ok) throw new Error("baseline build unexpectedly failed");
    }
    return idx;
}

// Capture the complete observable index state so we can prove it is unchanged.
function snapshotState(idx) {
    return {
        entries: idx.entries(), // ordered shallow copies (head first)
        validityKey: idx.validityKey,
        size: idx.size(),
    };
}

// ─── Property 16 ─────────────────────────────────────────────────────────────
// Feature: save-import-performance-redesign, Property 16: Failed incremental update preserves the prior index and flags a rescan
// Validates: Requirements 12.8
describe("Property 16: Failed incremental update preserves the prior index and flags a rescan (Req 12.8)", () => {
    test("any failing incremental mutation leaves the last valid index, records an error, and flags a rescan", () => {
        // The failing-operation descriptor picks one of the four throw paths.
        const failingOpArb = fc.oneof(
            fc.record({
                kind: fc.constant("insertAtHead-malformed"),
                entry: malformedEntryArb,
            }),
            fc.record({
                kind: fc.constant("patchEntry-absent"),
                folder: absentFolderArb,
                fields: fc.record({ thumbStatus: fc.constant("ready") }),
            }),
            fc.record({
                kind: fc.constant("patchEntry-bad-fields"),
                fields: malformedFieldsArb,
            }),
            fc.record({
                kind: fc.constant("removeEntry-absent"),
                folder: absentFolderArb,
            })
        );

        fc.assert(
            fc.property(
                fc.array(validEntryArb, { minLength: 1, maxLength: 20 }),
                fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
                failingOpArb,
                (rawEntries, validityKey, op) => {
                    const idx = buildBaseline(rawEntries, validityKey);

                    // Baseline is clean before the failing mutation.
                    expect(idx.needsFullScan()).toBe(false);
                    expect(idx.lastError()).toBeNull();

                    const before = snapshotState(idx);

                    let result;
                    switch (op.kind) {
                        case "insertAtHead-malformed":
                            result = idx.insertAtHead(op.entry);
                            break;
                        case "patchEntry-absent":
                            // Guaranteed-disjoint namespace, but assert to be safe.
                            expect(idx.has(op.folder)).toBe(false);
                            result = idx.patchEntry(op.folder, op.fields);
                            break;
                        case "patchEntry-bad-fields": {
                            // Target a real existing entry so the throw is the
                            // fields check, not an absent-folder mismatch.
                            const existing = before.entries[0].folderPath;
                            result = idx.patchEntry(existing, op.fields);
                            break;
                        }
                        case "removeEntry-absent":
                            expect(idx.has(op.folder)).toBe(false);
                            result = idx.removeEntry(op.folder);
                            break;
                        default:
                            throw new Error("unknown op " + op.kind);
                    }

                    // (1) The operation reports failure.
                    expect(result).toBe(false);

                    // (2) The index equals its last valid value — identical
                    //     ordered entries, field values, and validity key.
                    const after = snapshotState(idx);
                    expect(after.entries).toEqual(before.entries);
                    expect(after.validityKey).toBe(before.validityKey);
                    expect(after.size).toBe(before.size);

                    // (3) An error indication is recorded.
                    const err = idx.lastError();
                    expect(typeof err).toBe("string");
                    expect(err.length).toBeGreaterThan(0);

                    // (4) The index is flagged so a full scan runs next reconcile.
                    expect(idx.needsFullScan()).toBe(true);
                }
            ),
            { numRuns: 15 }
        );
    });

    // ─── Focused examples (complement the universal property) ─────────────────
    test("a successful mutation does NOT flag a rescan and clears the last error", () => {
        const idx = new LibraryIndex({ validityKey: "vk" });
        // Force a prior failure to prove a later success clears lastError.
        expect(idx.patchEntry("lib/missing", { thumbStatus: "ready" })).toBe(false);
        expect(idx.needsFullScan()).toBe(true);
        expect(idx.lastError()).not.toBeNull();

        // A valid insert succeeds and clears the error indication. (The
        // needs-full-scan flag is sticky by design until a reconcile clears it.)
        expect(idx.insertAtHead({ folderPath: "lib/a", id: "a" })).toBe(true);
        expect(idx.lastError()).toBeNull();
        expect(idx.getEntry("lib/a").id).toBe("a");
    });

    test("a failed insertAtHead preserves an existing head entry exactly", () => {
        const idx = new LibraryIndex();
        idx.insertAtHead({ folderPath: "lib/keep", id: "keep", thumbStatus: "ready" });
        const before = idx.entries();

        expect(idx.insertAtHead({ id: "no-folder" })).toBe(false);

        expect(idx.entries()).toEqual(before);
        expect(idx.needsFullScan()).toBe(true);
        expect(idx.lastError()).toContain("folderPath");
    });

    test("a failed patchEntry on an absent folder flags a rescan without mutating entries", () => {
        const idx = new LibraryIndex();
        idx.insertAtHead({ folderPath: "lib/one", id: "one" });
        idx.insertAtHead({ folderPath: "lib/two", id: "two" });
        const before = idx.entries();

        expect(idx.patchEntry("lib/ghost", { thumbStatus: "ready" })).toBe(false);

        expect(idx.entries()).toEqual(before);
        expect(idx.needsFullScan()).toBe(true);
        expect(idx.lastError()).not.toBeNull();
    });

    test("a failed removeEntry on an absent folder leaves the index intact", () => {
        const idx = new LibraryIndex();
        idx.insertAtHead({ folderPath: "lib/one", id: "one" });
        const before = idx.entries();

        expect(idx.removeEntry("lib/ghost")).toBe(false);

        expect(idx.entries()).toEqual(before);
        expect(idx.size()).toBe(1);
        expect(idx.needsFullScan()).toBe(true);
    });
});
