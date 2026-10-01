/**
 * Library_Index — serialization round-trip
 * =========================================
 * Exercises the pure, dependency-injected LibraryIndex serialize()/parse()
 * pair from `js/core/persistence.js` (task 2.10). The single property here is
 * the design's Property 32: a Library_Index serialized to a string and parsed
 * back must reproduce the identical set of template entries with identical
 * field values, with no entries added, dropped, or altered.
 *
 * fast-check + Jest, 100 iterations. No mocks, no filesystem — the index is
 * built through its public insertAtHead() mutation (which normalizes and
 * de-duplicates by folderPath) so the round-trip is exercised without disk.
 */

const fc = require("fast-check");
const { LibraryIndex } = require("../js/core/persistence.js");

// ─── Generators ──────────────────────────────────────────────────────────────
// A folder path built from safe segments joined by either slash style, with an
// optional trailing separator. This exercises path normalization inside
// insertAtHead() (backslash -> forward slash, trailing-slash trim).
const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,6}$/);

const folderPathArb = fc
    .record({
        segs: fc.array(segment, { minLength: 1, maxLength: 4 }),
        sep: fc.constantFrom("/", "\\"),
        trailing: fc.constantFrom("", "/", "\\", "//"),
    })
    .map(({ segs, sep, trailing }) => segs.join(sep) + trailing);

// A LibraryIndexEntry. The documented fields plus an occasional extra field to
// prove the round trip preserves any own-enumerable defined field faithfully.
// undefined field values are omitted (never generated) since normalizeLibraryEntry
// drops undefined and serialize/parse cannot represent them.
const thumbStatusArb = fc.constantFrom("placeholder", "ready", "rendering", "failed");

const entryArb = fc.record(
    {
        folderPath: folderPathArb,
        id: fc.string(),
        name: fc.string(),
        category: fc.string(),
        section: fc.string(),
        thumbnailPath: fc.string(),
        thumbStatus: thumbStatusArb,
        favorite: fc.boolean(),
        extra: fc.jsonValue(),
    },
    { requiredKeys: ["folderPath"] }
);

// A recorded whole-library validity key: string / number in the runtime, or
// null when a key could not be derived.
const validityKeyArb = fc.oneof(fc.string(), fc.integer(), fc.constant(null));

// Build a LibraryIndex from a list of raw entries via its public mutation.
// insertAtHead() normalizes paths and de-duplicates by normalized folderPath
// (an index never holds duplicate folders), so the index's own entries()
// snapshot is the authoritative "what was serialized" set.
function buildIndex(rawEntries, validityKey) {
    const index = new LibraryIndex({ validityKey });
    for (const e of rawEntries) {
        index.insertAtHead(e);
    }
    return index;
}

// ─── Property 32 ──────────────────────────────────────────────────────────────
describe("LibraryIndex serialization round-trip", () => {
    // Feature: save-import-performance-redesign, Property 32: Library_Index serialization round-trips exactly
    // Validates: Requirements 12.6
    test("Property 32: parse(serialize(index)) yields the identical entry set and field values", () => {
        fc.assert(
            fc.property(
                fc.array(entryArb, { maxLength: 25 }),
                validityKeyArb,
                (rawEntries, validityKey) => {
                    const original = buildIndex(rawEntries, validityKey);

                    const parsed = LibraryIndex.parse(original.serialize());

                    // Identical set of template entries with identical field
                    // values, in identical order — no entries added, dropped,
                    // or altered. entries() returns an ordered snapshot on both
                    // sides.
                    expect(parsed.entries()).toEqual(original.entries());
                    // Envelope fields survive the round trip too.
                    expect(parsed.size()).toBe(original.size());
                    expect(parsed.version).toBe(original.version);
                    expect(parsed.validityKey).toBe(original.validityKey);
                }
            ),
            { numRuns: 100 }
        );
    });

    // ─── Focused examples (complement the universal property) ─────────────────
    test("empty index round-trips to an empty index", () => {
        const original = new LibraryIndex();
        const parsed = LibraryIndex.parse(original.serialize());
        expect(parsed.size()).toBe(0);
        expect(parsed.entries()).toEqual([]);
    });

    test("full LibraryIndexEntry field set survives the round trip", () => {
        const original = new LibraryIndex({ validityKey: "12:4096:1700000000000" });
        const entry = {
            id: "tpl-1",
            name: "Lower Third",
            category: "Titles",
            section: "Lower Thirds",
            folderPath: "root/section/cat/id",
            thumbnailPath: "root/section/cat/id/thumbnail.png",
            thumbStatus: "ready",
            favorite: true,
        };
        original.insertAtHead(entry);

        const parsed = LibraryIndex.parse(original.serialize());

        expect(parsed.getEntry("root/section/cat/id")).toEqual(entry);
        expect(parsed.validityKey).toBe("12:4096:1700000000000");
    });

    test("backslash / trailing-slash paths round-trip under normalization", () => {
        const original = new LibraryIndex();
        original.insertAtHead({ folderPath: "root\\section\\id\\", name: "X" });
        const parsed = LibraryIndex.parse(original.serialize());
        expect(parsed.has("root/section/id")).toBe(true);
        expect(parsed.getEntry("root/section/id").name).toBe("X");
    });

    test("entry order (head-first) is preserved across the round trip", () => {
        const original = new LibraryIndex();
        original.insertAtHead({ folderPath: "a" });
        original.insertAtHead({ folderPath: "b" });
        original.insertAtHead({ folderPath: "c" }); // head-first: c, b, a

        const parsed = LibraryIndex.parse(original.serialize());

        expect(parsed.entries().map((e) => e.folderPath)).toEqual(["c", "b", "a"]);
    });
});
