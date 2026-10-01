/**
 * Library_Index — optimistic head insertion
 * ==========================================
 * Exercises the pure, dependency-injected LibraryIndex.insertAtHead operation
 * from `js/core/persistence.js` (task 2.5). The single property here is the
 * design's Property 7: inserting an optimistic card for a newly saved template
 * must place the new entry at position 0, preserve every previously present
 * entry in its original relative order, and trigger zero Library_Scan
 * invocations.
 *
 * The LibraryIndex owns no scan machinery of its own — a full Library_Scan is
 * only ever requested through the needs-full-scan flag. So "zero Library_Scan
 * invocations" is observed as: the insert succeeds and the needs-full-scan flag
 * is never raised by the operation.
 *
 * fast-check + Jest, 100 iterations. No mocks, no filesystem — entries carry
 * explicit fields so the ordering guarantee is exercised without touching disk.
 */

const fc = require("fast-check");
const { LibraryIndex, normalizeFolderPath } = require("../js/core/persistence.js");

// ─── Generators ──────────────────────────────────────────────────────────────
// Folder paths are built from a small pool of safe segments joined by either
// slash style with an optional trailing separator. The small pool makes
// folderPath collisions between the pre-existing entries and the newly saved
// template plausible, exercising insertAtHead's replace-at-head branch, while
// path normalization (backslash -> forward slash, trailing-slash trim) is also
// covered.
const segment = fc.constantFrom("root", "sec", "cat", "id", "a", "b", "c", "1", "2");

const folderPathArb = fc
    .record({
        segs: fc.array(segment, { minLength: 1, maxLength: 4 }),
        sep: fc.constantFrom("/", "\\"),
        trailing: fc.constantFrom("", "/", "\\", "//"),
    })
    .map(({ segs, sep, trailing }) => segs.join(sep) + trailing);

// A LibraryIndexEntry-shaped record (design: LibraryIndexEntry). thumbStatus is
// left off sometimes so normalizeLibraryEntry's placeholder default is exercised.
const entryArb = fc.record(
    {
        folderPath: folderPathArb,
        id: fc.string({ maxLength: 8 }),
        name: fc.string({ maxLength: 12 }),
        category: fc.string({ maxLength: 8 }),
        section: fc.constantFrom("comp", "layer", "text", "footage", "effect", "icon", "overlay"),
        thumbnailPath: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
        thumbStatus: fc.option(fc.constantFrom("placeholder", "ready", "failed"), { nil: undefined }),
        favorite: fc.option(fc.boolean(), { nil: undefined }),
    },
    { requiredKeys: ["folderPath", "id", "name", "category", "section"] }
);

// Build a starting LibraryIndex from a list of raw entries by inserting them in
// order. insertAtHead de-duplicates by normalized folderPath (an index never
// holds duplicate folders), so the resulting index.entries() snapshot is the
// authoritative "previously present" set and order.
function buildIndex(rawEntries) {
    const index = new LibraryIndex();
    for (const e of rawEntries) {
        index.insertAtHead(e);
    }
    return index;
}

// ─── Property 7 ──────────────────────────────────────────────────────────────
describe("LibraryIndex optimistic head insertion", () => {
    // Feature: save-import-performance-redesign, Property 7: Optimistic card inserts at head with no scan
    // Validates: Requirements 3.5, 5.2, 12.1
    test("Property 7: insertAtHead places the new entry at position 0, preserves prior order, and triggers no scan", () => {
        fc.assert(
            fc.property(
                fc.array(entryArb, { maxLength: 15 }),
                entryArb,
                (existingEntries, newEntry) => {
                    const index = buildIndex(existingEntries);

                    // Authoritative "previously present" state and order.
                    const before = index.entries();
                    expect(index.needsFullScan()).toBe(false);

                    const ok = index.insertAtHead(newEntry);

                    // The insert of an optimistic card always succeeds …
                    expect(ok).toBe(true);
                    // … and never requests a full Library_Scan (Req 3.5/5.2/12.1).
                    expect(index.needsFullScan()).toBe(false);

                    const after = index.entries();
                    const normNew = normalizeFolderPath(newEntry.folderPath);

                    // New entry sits at position 0.
                    expect(after[0].folderPath).toBe(normNew);

                    // The index never holds duplicate folders.
                    const paths = after.map((e) => e.folderPath);
                    expect(new Set(paths).size).toBe(paths.length);

                    // Every previously present entry survives in its original
                    // relative order — except one whose folderPath equals the new
                    // template's, which is the entry now moved to the head.
                    const expectedTail = before.filter((e) => e.folderPath !== normNew);
                    expect(after.slice(1)).toEqual(expectedTail);
                }
            ),
            { numRuns: 100 }
        );
    });

    // ─── Focused examples (complement the universal property) ─────────────────
    test("inserting into an empty index yields a single head entry", () => {
        const index = new LibraryIndex();
        const ok = index.insertAtHead({ folderPath: "root/sec/id", id: "id", name: "n" });
        expect(ok).toBe(true);
        expect(index.size()).toBe(1);
        expect(index.entries()[0].folderPath).toBe("root/sec/id");
        expect(index.needsFullScan()).toBe(false);
    });

    test("newest inserts appear first while prior entries keep their order", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "a", id: "a" });
        index.insertAtHead({ folderPath: "b", id: "b" });
        index.insertAtHead({ folderPath: "c", id: "c" });
        expect(index.entries().map((e) => e.folderPath)).toEqual(["c", "b", "a"]);
        expect(index.needsFullScan()).toBe(false);
    });

    test("re-saving an existing folder moves it to the head without duplicating", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "a", id: "a", thumbStatus: "ready" });
        index.insertAtHead({ folderPath: "b", id: "b" });
        index.insertAtHead({ folderPath: "c", id: "c" });

        // Re-save "a" (path collision) -> moves to head, order of the rest kept.
        const ok = index.insertAtHead({ folderPath: "a", id: "a", thumbStatus: "placeholder" });
        expect(ok).toBe(true);
        expect(index.entries().map((e) => e.folderPath)).toEqual(["a", "c", "b"]);
        expect(index.getEntry("a").thumbStatus).toBe("placeholder");
        expect(index.needsFullScan()).toBe(false);
    });

    test("backslash / trailing-slash paths normalize and still land at the head", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "root/sec/old", id: "old" });
        const ok = index.insertAtHead({ folderPath: "root\\sec\\new\\", id: "new" });
        expect(ok).toBe(true);
        expect(index.entries()[0].folderPath).toBe("root/sec/new");
        expect(index.needsFullScan()).toBe(false);
    });
});
