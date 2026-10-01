/**
 * Metadata_Cache — malformed-input degradation property test
 * ==========================================================
 * Exercises the pure `MetadataCache.parse()` corruption-tolerance path from
 * `js/core/persistence.js` (task 2.1) against arbitrary/malformed serialized
 * input. The design guarantees that a persisted cache that cannot be trusted
 * degrades to "all entries missing" (recomputed on access) rather than raising
 * an unrecoverable error.
 *
 *   Property 29: Malformed persisted cache degrades to all-missing without error
 *                (Validates: Requirements 11.6)
 */

const fc = require("fast-check");
const {
    MetadataCache,
} = require("../js/core/persistence.js");

// Feature: save-import-performance-redesign, Property 29: Malformed persisted cache degrades to all-missing without error

// ─── Malformed-input generators ──────────────────────────────────────────────
// Every family below produces input that is NOT a well-formed serialized cache
// carrying usable entries, so a correct parse() must yield an EMPTY cache.

// Probe folder paths used to confirm every entry reads as missing/not-current.
const arbProbePaths = fc.array(
    fc.oneof(
        fc.constant(""),
        fc.string(),
        fc.constantFrom("a/b/c", "C:/lib/tmpl", "x", "folder/one", "folder/two")
    ),
    { minLength: 0, maxLength: 5 }
);

// 1. Non-JSON garbage. Leading "}" guarantees JSON.parse throws.
const arbNonJson = fc.string().map((s) => "}{" + s);

// 2. Valid JSON of a wrong (non-cache) top-level type.
const arbWrongTypeJson = fc
    .oneof(
        fc.integer(),
        fc.double({ noNaN: true }),
        fc.boolean(),
        fc.constant(null),
        fc.string(), // becomes a JSON string literal after stringify
        fc.array(fc.anything()) // top-level array, not an { entries } object
    )
    .map((v) => JSON.stringify(v));

// 3. Object shape but `entries` missing or not an array.
const arbBadEntriesField = fc
    .record(
        {
            version: fc.option(fc.integer(), { nil: undefined }),
            entries: fc.option(
                fc.oneof(
                    fc.integer(),
                    fc.string(),
                    fc.boolean(),
                    fc.constant(null),
                    fc.record({ nope: fc.anything() })
                ),
                { nil: undefined }
            ),
            junk: fc.option(fc.anything(), { nil: undefined }),
        },
        { requiredKeys: [] }
    )
    .map((o) => JSON.stringify(o));

// 4. Object with an `entries` ARRAY, but every element is unusable garbage
//    (no resolvable folderPath), so all entries are dropped -> empty cache.
const arbGarbageEntry = fc.oneof(
    fc.constant(null),
    fc.integer(),
    fc.boolean(),
    fc.string(),
    fc.array(fc.anything()),
    // objects lacking a usable folderPath
    fc.record({ metadata: fc.anything() }, { requiredKeys: [] }),
    // folderPath values that all normalize (strip \ and trailing /) to "" and
    // are therefore dropped as unusable by parse().
    fc.record(
        {
            folderPath: fc.constantFrom("", null, undefined, "/", "//", "///", "\\", "\\\\"),
            validityKey: fc.anything(),
            metadata: fc.anything(),
        },
        { requiredKeys: [] }
    )
);
const arbAllGarbageEntries = fc
    .record(
        {
            version: fc.option(fc.integer(), { nil: undefined }),
            entries: fc.array(arbGarbageEntry, { minLength: 0, maxLength: 8 }),
        },
        { requiredKeys: ["entries"] }
    )
    .map((o) => JSON.stringify(o));

// 5. Non-string inputs handed directly to parse() (null/number/object/array).
const arbNonStringInput = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.integer(),
    fc.boolean(),
    fc.array(fc.anything()),
    fc.object()
);

const arbMalformed = fc.oneof(
    arbNonJson,
    arbWrongTypeJson,
    arbBadEntriesField,
    arbAllGarbageEntries,
    arbNonStringInput
);

// Inject a deriveKey so isCurrent() exercises its currency comparison without
// touching Node fs; entries are absent regardless, so currency must be false.
const parseOpts = { deriveKey: () => "current-key" };

describe("Property 29: malformed persisted Metadata_Cache degrades to all-missing without error", () => {
    it("parses arbitrary malformed input without throwing and yields an all-missing cache", () => {
        fc.assert(
            fc.property(arbMalformed, arbProbePaths, (input, probes) => {
                // Must not raise an unrecoverable error on any malformed input.
                let cache;
                expect(() => {
                    cache = MetadataCache.parse(input, parseOpts);
                }).not.toThrow();

                // Malformed input -> every template entry treated as missing.
                expect(cache.size()).toBe(0);
                expect(cache.entries()).toEqual([]);

                // Every probed folder reads as missing and not-current, i.e. it
                // will be recomputed on access.
                probes.forEach((p) => {
                    expect(cache.has(p)).toBe(false);
                    expect(cache.get(p)).toBeNull();
                    expect(cache.getEntry(p)).toBeNull();
                    expect(cache.isCurrent(p)).toBe(false);
                });
            }),
            { numRuns: 200 }
        );
    });
});
