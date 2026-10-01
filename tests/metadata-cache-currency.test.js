/**
 * Metadata_Cache — validity-key currency predicate (property test)
 * ================================================================
 * Feature: save-import-performance-redesign, Property 30: Validity-key currency predicate
 *
 * Exercises the pure, dependency-injected `MetadataCache.isCurrent(folderPath)`
 * from `js/core/persistence.js` (task 2.1).
 *
 * Property 30: For any recorded validity key and current folder validity key,
 * an entry is classified as current IF AND ONLY IF the two keys are equal, and
 * this classification performs no content rescan.
 *
 * Validates: Requirements 11.7
 */

const fc = require("fast-check");
const { MetadataCache } = require("../js/core/persistence.js");

// A validity key looks like "count:totalSize:maxMtime" but the currency
// predicate treats it opaquely — it only asks whether two keys are equal.
// Generate a mix of composite-looking keys and arbitrary strings so the test
// does not accidentally depend on key shape.
const keyArb = fc.oneof(
    fc
        .tuple(
            fc.nat({ max: 500 }),
            fc.nat({ max: 10_000_000 }),
            fc.nat({ max: 2_000_000_000 })
        )
        .map(([c, s, m]) => `${c}:${s}:${m}`),
    fc.string({ maxLength: 40 })
);

const folderArb = fc
    .array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 5 })
    .map((segs) => segs.join("/"));

describe("Property 30: Validity-key currency predicate", () => {
    test("isCurrent is true iff recorded key equals current folder key", () => {
        fc.assert(
            fc.property(
                folderArb,
                keyArb,
                keyArb,
                fc.boolean(),
                (folderPath, recordedKey, otherKey, forceEqual) => {
                    // Drive the "current" key deterministically via an injected
                    // deriveKey so we control both sides of the comparison.
                    const currentKey = forceEqual ? recordedKey : otherKey;
                    const cache = new MetadataCache({
                        deriveKey: () => currentKey,
                    });

                    cache.put(folderPath, { any: "metadata" }, recordedKey);

                    const expected = recordedKey === currentKey;
                    expect(cache.isCurrent(folderPath)).toBe(expected);
                }
            ),
            { numRuns: 100 }
        );
    });

    test("an absent entry is never current, regardless of the current key", () => {
        fc.assert(
            fc.property(folderArb, keyArb, (folderPath, currentKey) => {
                const cache = new MetadataCache({ deriveKey: () => currentKey });
                // No put() — the folder has no recorded entry.
                expect(cache.isCurrent(folderPath)).toBe(false);
            }),
            { numRuns: 100 }
        );
    });

    test("a null/undefined current key (folder gone/unreadable) is never current", () => {
        fc.assert(
            fc.property(
                folderArb,
                keyArb,
                fc.constantFrom(null, undefined),
                (folderPath, recordedKey, currentKey) => {
                    const cache = new MetadataCache({ deriveKey: () => currentKey });
                    cache.put(folderPath, { any: "metadata" }, recordedKey);
                    expect(cache.isCurrent(folderPath)).toBe(false);
                }
            ),
            { numRuns: 100 }
        );
    });

    test("classification reads directory metadata only and never rescans file contents", () => {
        fc.assert(
            fc.property(
                folderArb,
                fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 6 }),
                fc.boolean(),
                (folderPath, entryNames, mutateAfterRecord) => {
                    // A spy fs whose ONLY supported operations are the directory
                    // metadata reads used to derive a validity key (readdir/stat).
                    // Any attempt to open or read FILE CONTENTS throws, so if the
                    // currency predicate rescanned contents the test would fail.
                    const contentReads = { count: 0 };
                    const trapContent = (name) => () => {
                        contentReads.count++;
                        throw new Error("content rescan attempted via " + name);
                    };
                    let size = 100;
                    let mtime = 1000;
                    const spyFs = {
                        readdirSync: () => entryNames.slice(),
                        statSync: () => ({ size: size, mtimeMs: mtime }),
                        // Content-read surfaces — must never be called.
                        readFileSync: trapContent("readFileSync"),
                        readFile: trapContent("readFile"),
                        createReadStream: trapContent("createReadStream"),
                        openSync: trapContent("openSync"),
                    };

                    const cache = new MetadataCache({ fs: spyFs });

                    // Record the entry with the folder's key at record time.
                    const recordedKey = cache.currentKey(folderPath);
                    cache.put(folderPath, { any: "metadata" }, recordedKey);

                    // Optionally change the folder's observable metadata so the
                    // derived current key diverges — currency must flip to false
                    // using metadata alone, still without any content read.
                    if (mutateAfterRecord) {
                        size += 1;
                        mtime += 1;
                    }

                    const expected = !mutateAfterRecord; // key unchanged => current
                    expect(cache.isCurrent(folderPath)).toBe(expected);
                    // The classification must not have rescanned file contents.
                    expect(contentReads.count).toBe(0);
                }
            ),
            { numRuns: 100 }
        );
    });
});
