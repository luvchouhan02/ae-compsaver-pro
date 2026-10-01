/**
 * Metadata_Cache — serialization round-trip
 * ==========================================
 * Exercises the pure, dependency-injected MetadataCache serialize()/parse()
 * pair from `js/core/persistence.js` (task 2.1). The single property here is
 * the design's Property 28: a Metadata_Cache serialized to a string and parsed
 * back must reproduce the identical set of template entries with identical
 * field values (folderPath, validityKey, metadata).
 *
 * fast-check + Jest, 100 iterations. No mocks, no filesystem — the cache is
 * built with explicit validity keys so the round-trip is exercised without
 * touching disk.
 */

const fc = require("fast-check");
const { MetadataCache } = require("../js/core/persistence.js");

// ─── Generators ──────────────────────────────────────────────────────────────
// A folder path built from safe segments joined by either slash style, with an
// optional trailing separator. This exercises path normalization inside put()
// (backslash -> forward slash, trailing-slash trim) as well as ordinary paths.
const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,6}$/);

const folderPathArb = fc
    .record({
        segs: fc.array(segment, { minLength: 1, maxLength: 4 }),
        sep: fc.constantFrom("/", "\\"),
        trailing: fc.constantFrom("", "/", "\\", "//"),
    })
    .map(({ segs, sep, trailing }) => segs.join(sep) + trailing);

// Expensive per-template metadata is JSON-shaped in practice (category,
// dimensions, asset lists, layer state, ...). fc.jsonValue() covers null,
// booleans, numbers, strings, arrays, and nested objects — exactly the values
// that must survive a JSON round trip.
const metadataArb = fc.jsonValue();

// A recorded validity key: a string / number composite in the runtime, or null
// when a folder key could not be derived.
const validityKeyArb = fc.oneof(fc.string(), fc.integer(), fc.constant(null));

const entryArb = fc.record({
    folderPath: folderPathArb,
    metadata: metadataArb,
    validityKey: validityKeyArb,
});

// Build a MetadataCache from a list of raw entries. put() normalizes paths and
// de-duplicates by normalized folderPath (last write wins), so the cache's own
// entries() snapshot is the authoritative "what was serialized" set.
function buildCache(rawEntries) {
    const cache = new MetadataCache();
    for (const e of rawEntries) {
        cache.put(e.folderPath, e.metadata, e.validityKey);
    }
    return cache;
}

// ─── Property 28 ──────────────────────────────────────────────────────────────
describe("MetadataCache serialization round-trip", () => {
    // Feature: save-import-performance-redesign, Property 28: Metadata_Cache serialization round-trips exactly
    // Validates: Requirements 11.5
    test("Property 28: parse(serialize(cache)) yields the identical entry set and field values", () => {
        fc.assert(
            fc.property(fc.array(entryArb, { maxLength: 25 }), (rawEntries) => {
                const original = buildCache(rawEntries);

                const parsed = MetadataCache.parse(original.serialize());

                // Identical set of template entries with identical field values.
                // entries() returns a stable, folderPath-sorted snapshot of
                // { folderPath, validityKey, metadata } on both sides.
                expect(parsed.entries()).toEqual(original.entries());
                // The schema version is preserved across the round trip too.
                expect(parsed.version).toBe(original.version);
            }),
            { numRuns: 100 }
        );
    });

    // ─── Focused examples (complement the universal property) ─────────────────
    test("empty cache round-trips to an empty cache", () => {
        const original = new MetadataCache();
        const parsed = MetadataCache.parse(original.serialize());
        expect(parsed.size()).toBe(0);
        expect(parsed.entries()).toEqual([]);
    });

    test("nested metadata and explicit validity key survive the round trip", () => {
        const original = new MetadataCache();
        const metadata = {
            category: "Titles",
            section: "Lower Thirds",
            dimensions: { w: 1920, h: 1080 },
            assets: ["a.png", "b.mov"],
            layers: [{ name: "text", locked: false }],
        };
        original.put("root/section/cat/id", metadata, "3:2048:1700000000000");

        const parsed = MetadataCache.parse(original.serialize());

        expect(parsed.get("root/section/cat/id")).toEqual(metadata);
        expect(parsed.getEntry("root/section/cat/id").validityKey).toBe(
            "3:2048:1700000000000"
        );
    });

    test("backslash / trailing-slash paths round-trip under normalization", () => {
        const original = new MetadataCache();
        original.put("root\\section\\id\\", { k: 1 }, "vk");
        const parsed = MetadataCache.parse(original.serialize());
        expect(parsed.has("root/section/id")).toBe(true);
        expect(parsed.get("root/section/id")).toEqual({ k: 1 });
    });
});
