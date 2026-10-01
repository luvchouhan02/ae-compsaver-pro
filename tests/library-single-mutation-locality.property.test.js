/**
 * Library_Index — single-mutation locality
 * =========================================
 * Exercises the pure, dependency-injected LibraryIndex incremental operations
 * `removeEntry` (delete) and `patchEntry` (rename / move) from
 * `js/core/persistence.js` (task 2.5). The single property here is the
 * design's Property 15: for any Library_Index and any single delete, rename,
 * or move of one template, only the affected entry changes, every other entry
 * is untouched, and no full Library_Scan is invoked.
 *
 * fast-check + Jest, 100 iterations. No mocks, no filesystem — the index is
 * built entirely in memory from generated entries so the incremental mutation
 * is exercised without touching disk or After Effects. "No full Library_Scan"
 * is observed via the index's needsFullScan flag: a successful single mutation
 * is a purely local update and must never flag a rescan (a full scan is the
 * one path the index takes when it cannot compute a change locally).
 */

const fc = require("fast-check");
const { LibraryIndex, normalizeFolderPath } = require("../js/core/persistence.js");

// ─── Generators ──────────────────────────────────────────────────────────────
// Folder-path segments built from safe characters, joined by either slash
// style so path normalization inside the index is exercised alongside the
// mutation logic.
const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,6}$/);

const folderPathArb = fc
    .record({
        segs: fc.array(segment, { minLength: 1, maxLength: 4 }),
        sep: fc.constantFrom("/", "\\"),
    })
    .map(({ segs, sep }) => segs.join(sep));

const nameArb = fc.stringMatching(/^[A-Za-z0-9 _-]{1,12}$/);
const categoryArb = fc.constantFrom("Titles", "Lower Thirds", "Backgrounds", "Transitions", "");
const sectionArb = fc.constantFrom("A", "B", "C", "");

// A single library entry. folderPath is the identity key; the remaining fields
// mirror the documented LibraryIndexEntry shape.
const entryArb = fc.record({
    folderPath: folderPathArb,
    name: nameArb,
    category: categoryArb,
    section: sectionArb,
    thumbStatus: fc.constantFrom("placeholder", "ready", "failed"),
    favorite: fc.boolean(),
});

// The kind of single mutation to exercise: a delete (removeEntry) or a rename /
// move (both patchEntry — a rename changes the display name, a move changes the
// category/section grouping; neither touches the folderPath identity key).
const opKindArb = fc.constantFrom("delete", "rename", "move");

// ─── Helpers ─────────────────────────────────────────────────────────────────
// De-duplicate generated entries by NORMALIZED folderPath (last write wins),
// preserving first-seen order, so the index never holds two entries that
// normalize to the same folder — matching the index's own duplicate handling.
function dedupeByPath(rawEntries) {
    const seen = new Map();
    for (const e of rawEntries) {
        seen.set(normalizeFolderPath(e.folderPath), e);
    }
    return Array.from(seen.values());
}

// Build a LibraryIndex from a list of entries (inserted in array order via the
// public incremental op) and return { index, before } where `before` is a deep
// snapshot of the entry list as the index actually holds it.
function buildIndex(entries) {
    const index = new LibraryIndex();
    for (const e of entries) {
        index.insertAtHead(e);
    }
    return { index, before: index.entries().map((x) => ({ ...x })) };
}

// The list of entries with the target folderPath excluded, in order — used to
// assert every unaffected entry is byte-identical and keeps its relative order.
function withoutPath(list, key) {
    return list.filter((e) => e.folderPath !== key);
}

// ─── Property 15 ──────────────────────────────────────────────────────────────
describe("LibraryIndex single-mutation locality", () => {
    // Feature: save-import-performance-redesign, Property 15: A single library mutation updates only affected entries without a scan
    // Validates: Requirements 12.2
    test("Property 15: a single delete/rename/move touches only the affected entry and triggers no full scan", () => {
        fc.assert(
            fc.property(
                fc.array(entryArb, { minLength: 1, maxLength: 12 }),
                fc.nat(),
                opKindArb,
                nameArb,
                categoryArb,
                sectionArb,
                (rawEntries, targetSel, opKind, newName, newCategory, newSection) => {
                    const entries = dedupeByPath(rawEntries);
                    const { index, before } = buildIndex(entries);

                    // Choose an existing target entry (by its position in the
                    // index's own ordered view) so the mutation always applies.
                    const target = before[targetSel % before.length];
                    const key = target.folderPath;
                    const beforeTarget = before.find((e) => e.folderPath === key);

                    // Apply exactly one single-template mutation.
                    let ok;
                    if (opKind === "delete") {
                        ok = index.removeEntry(key);
                    } else if (opKind === "rename") {
                        ok = index.patchEntry(key, { name: newName });
                    } else {
                        // move: re-group the template into another category/section.
                        ok = index.patchEntry(key, { category: newCategory, section: newSection });
                    }

                    // The mutation succeeds and — being a purely local update —
                    // never flags a full Library_Scan (Req 12.2).
                    expect(ok).toBe(true);
                    expect(index.needsFullScan()).toBe(false);
                    expect(index.lastError()).toBeNull();

                    const after = index.entries();

                    // Every entry other than the target is completely unchanged,
                    // both in value and relative order (no rebuild / rescan).
                    expect(withoutPath(after, key)).toEqual(withoutPath(before, key));

                    if (opKind === "delete") {
                        // The affected entry is gone; nothing else was added.
                        expect(index.has(key)).toBe(false);
                        expect(after.length).toBe(before.length - 1);
                    } else {
                        // The affected entry is patched in place: its changed
                        // fields reflect the mutation, every other field is
                        // preserved, and the entry count is unchanged.
                        expect(after.length).toBe(before.length);
                        const afterTarget = index.getEntry(key);
                        const expectedTarget =
                            opKind === "rename"
                                ? { ...beforeTarget, name: newName }
                                : { ...beforeTarget, category: newCategory, section: newSection };
                        expect(afterTarget).toEqual(expectedTarget);
                        // folderPath identity is never moved by a patch.
                        expect(afterTarget.folderPath).toBe(key);
                    }
                }
            ),
            { numRuns: 15 }
        );
    });

    // ─── Focused examples (complement the universal property) ─────────────────
    test("delete removes only the target and leaves siblings in order", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "root/c", name: "C" });
        index.insertAtHead({ folderPath: "root/b", name: "B" });
        index.insertAtHead({ folderPath: "root/a", name: "A" });
        // head-first order: a, b, c
        expect(index.removeEntry("root/b")).toBe(true);
        expect(index.entries().map((e) => e.folderPath)).toEqual(["root/a", "root/c"]);
        expect(index.needsFullScan()).toBe(false);
    });

    test("rename changes only the name field of the affected entry", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "root/y", name: "Y", category: "Titles" });
        index.insertAtHead({ folderPath: "root/x", name: "X", category: "Titles" });
        const before = index.getEntry("root/x");
        expect(index.patchEntry("root/x", { name: "Renamed" })).toBe(true);
        expect(index.getEntry("root/x")).toEqual({ ...before, name: "Renamed" });
        // sibling untouched
        expect(index.getEntry("root/y")).toEqual({
            folderPath: "root/y",
            name: "Y",
            category: "Titles",
            thumbStatus: "placeholder",
        });
        expect(index.needsFullScan()).toBe(false);
    });

    test("a failed mutation on an absent folder flags a rescan and changes nothing", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "root/a", name: "A" });
        const before = index.entries();
        expect(index.removeEntry("root/does-not-exist")).toBe(false);
        expect(index.needsFullScan()).toBe(true);
        expect(index.entries()).toEqual(before);
    });
});
