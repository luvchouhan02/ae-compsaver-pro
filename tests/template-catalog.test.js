// ============================================================
// tests/template-catalog.test.js
//
// Feature: Problem 4 — normalized catalog + incremental mutations
//
// The REAL js/templates/templateCatalog.js in a vm realm. Every
// selection/counts assertion is cross-checked against an independent
// brute-force scan of the same records, and every mutation is checked
// to keep counts, category order, and search results identical to a
// full rebuild (incremental == rebuild invariant).
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "js/templates/templateCatalog.js"), "utf8");

function sectionOf(t) { return t.section; }

function build() {
    const context = { console: { log() { }, warn() { }, error() { } } };
    vm.createContext(context);
    vm.runInContext(SRC, context, { filename: "templateCatalog.js" });
    return context.TemplateCatalog;
}

function makeRecords(n) {
    const out = [];
    const cats = ["Glow", "Blur", "Color", "Glow", "Distort"];
    for (let i = 0; i < n; i++) {
        out.push({
            id: "r" + i, name: "T" + i, category: cats[i % cats.length],
            section: i % 3 === 0 ? "comp" : "layer", favorite: i % 4 === 0,
            type: "media", dim: "1920x1080",
        });
    }
    return out;
}

function bruteIds(records, section, category, query) {
    const q = (query || "").toLowerCase();
    const out = [];
    for (const t of records) {
        if (t.section !== section) continue;
        if (category === "Favorites" && !t.favorite) continue;
        if (category !== "All" && category !== "Favorites" && t.category !== category) continue;
        if (q) {
            const hay = ((t.name || "") + " " + (t.category || "") + " " + (t.type || "") + " " + (t.section || "") + " " + (t.dim || "")).toLowerCase();
            if (hay.indexOf(q) === -1) continue;
        }
        out.push(t.id);
    }
    return out;
}

function bruteCats(records, section) {
    const cats = ["All", "Favorites"];
    for (const t of records) if (t.section === section && t.category && cats.indexOf(t.category) === -1) cats.push(t.category);
    return cats;
}

describe("TemplateCatalog — selection parity and incremental mutations", () => {
    test("idsFor matches brute force for every section/category/search combination", () => {
        const catalog = build();
        const records = makeRecords(300);
        catalog.build(records, sectionOf);
        for (const section of ["comp", "layer"]) {
            for (const category of ["All", "Favorites", "Glow", "Blur", "Missing"]) {
                expect(catalog.idsFor(section, category, "")).toEqual(bruteIds(records, section, category, ""));
                expect(catalog.idsFor(section, category, "t1")).toEqual(bruteIds(records, section, category, "t1"));
            }
        }
    });

    test("categories preserve first-discovery order and one-pass counts match", () => {
        const catalog = build();
        const records = makeRecords(200);
        catalog.build(records, sectionOf);
        expect(catalog.categories("comp")).toEqual(bruteCats(records, "comp"));
        const c = catalog.sectionCounts("comp");
        const brute = { all: 0, favorites: 0, cats: {} };
        for (const t of records) if (t.section === "comp") {
            brute.all++;
            if (t.favorite) brute.favorites++;
            if (t.category) brute.cats[t.category] = (brute.cats[t.category] || 0) + 1;
        }
        expect(c.all).toBe(brute.all);
        expect(c.favorites).toBe(brute.favorites);
        expect(c.cats).toEqual(brute.cats);
    });

    test("favorite toggle patches counts incrementally (== full rebuild)", () => {
        const catalog = build();
        const records = makeRecords(120);
        catalog.build(records, sectionOf);
        const victim = records.find((t) => t.section === "comp" && !t.favorite);
        victim.favorite = true;
        catalog.patch(victim, { category: victim.category, favorite: false, section: victim.section });

        const rebuilt = build();
        rebuilt.build(records, sectionOf);
        expect(catalog.sectionCounts("comp")).toEqual(rebuilt.sectionCounts("comp"));
        expect(catalog.idsFor("comp", "Favorites", "")).toEqual(rebuilt.idsFor("comp", "Favorites", ""));
    });

    test("rename to a new category moves membership and appends the new category in order", () => {
        const catalog = build();
        const records = makeRecords(120);
        catalog.build(records, sectionOf);
        const victim = records.find((t) => t.section === "comp");
        const oldCat = victim.category;
        victim.category = "BrandNew";
        catalog.patch(victim, { category: oldCat, favorite: victim.favorite, section: victim.section });

        const rebuilt = build();
        rebuilt.build(records, sectionOf);
        expect(catalog.categories("comp")).toEqual(rebuilt.categories("comp"));
        expect(catalog.idsFor("comp", "BrandNew", "")).toEqual(rebuilt.idsFor("comp", "BrandNew", ""));
        expect(catalog.idsFor("comp", oldCat, "")).toEqual(rebuilt.idsFor("comp", oldCat, ""));
        expect(catalog.sectionCounts("comp").cats).toEqual(rebuilt.sectionCounts("comp").cats);
    });

    test("remove drops the record, its counts, and an emptied category", () => {
        const catalog = build();
        const records = makeRecords(120);
        catalog.build(records, sectionOf);
        const soloCat = records.find((t) => t.section === "comp");
        const cat = soloCat.category;
        // Make it the only member of its category in comp.
        for (const t of records) if (t !== soloCat && t.section === "comp" && t.category === cat) t.category = "Other";
        catalog.build(records, sectionOf);

        const idx = records.indexOf(soloCat);
        records.splice(idx, 1);
        catalog.remove(soloCat);

        const rebuilt = build();
        rebuilt.build(records, sectionOf);
        expect(catalog.categories("comp")).toEqual(rebuilt.categories("comp"));
        expect(catalog.categories("comp").indexOf(cat)).toBe(-1);
        expect(catalog.size()).toBe(records.length);
        expect(catalog.idsFor("comp", "All", "")).toEqual(rebuilt.idsFor("comp", "All", ""));
    });

    test("add via patch indexes the record and keeps discovery order parity", () => {
        const catalog = build();
        const records = makeRecords(50);
        catalog.build(records, sectionOf);
        const fresh = { id: "fresh1", name: "Fresh", category: "Glow", section: "comp", favorite: false, type: "media", dim: "1x1" };
        records.push(fresh);
        catalog.patch(fresh);

        const rebuilt = build();
        rebuilt.build(records, sectionOf);
        expect(catalog.idsFor("comp", "Glow", "fresh")).toEqual(rebuilt.idsFor("comp", "Glow", "fresh"));
        expect(catalog.categories("comp")).toEqual(rebuilt.categories("comp"));
    });
});


// ============================================================
// catalog-patch-ordering-fixes — Task 2 preservation baseline
//
// P1 is the existing "add via patch" case above and stays byte-for-byte
// unmodified. The existing favourite-toggle and category-change cases are P3's
// named witnesses and likewise stay untouched. The cases below add only the
// preservation input classes that were not already executable in this file.
// Production remains deliberately UNFIXED while these observations are made.
// ============================================================

const task2Fc = require("fast-check");

function task2Clone(record) {
    const out = {};
    Object.keys(record).forEach(function (key) { out[key] = record[key]; });
    return out;
}

function task2Array(value) {
    return Array.prototype.slice.call(value || []);
}

function task2Plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function task2Sections(records) {
    const out = [];
    records.forEach(function (record) {
        if (out.indexOf(record.section) === -1) out.push(record.section);
    });
    return out;
}

function expectTask2CatalogParity(actual, rebuilt, records, queries) {
    expect(actual.size()).toBe(rebuilt.size());

    task2Sections(records).forEach(function (section) {
        const expectedCategories = task2Array(rebuilt.categories(section));
        expect(task2Array(actual.categories(section))).toEqual(expectedCategories);
        expect(task2Plain(actual.sectionCounts(section)))
            .toEqual(task2Plain(rebuilt.sectionCounts(section)));

        expectedCategories.forEach(function (category) {
            (queries || [""]).forEach(function (query) {
                expect(task2Array(actual.idsFor(section, category, query)))
                    .toEqual(task2Array(rebuilt.idsFor(section, category, query)));
            });
        });
    });

    records.forEach(function (record) {
        expect(actual.get(record.id)).toBe(record);
        expect(rebuilt.get(record.id)).toBe(record);
    });
}

describe("TemplateCatalog — catalog-patch-ordering-fixes preservation baseline", () => {
    // P2 — the future identity fallback must not mistake a value-equal fresh
    // object for the object already indexed under another key.
    test("P2 — an exact fresh clone of a re-keyed record is added, not treated as that indexed object", () => {
        // **Validates: Requirements 2.4, 3.1**
        task2Fc.assert(
            task2Fc.property(
                task2Fc.stringOf(task2Fc.constantFrom("a", "b", "c", "1", "2", "-"), {
                    minLength: 1,
                    maxLength: 12,
                }),
                function (suffix) {
                    const indexed = {
                        id: "indexed-old",
                        name: "Clone " + suffix,
                        category: "Cat",
                        section: "comp",
                        favorite: false,
                        type: "comp",
                        dim: "1x1",
                    };
                    const catalog = build();
                    catalog.build([indexed], sectionOf);

                    // The indexed object now carries an absent id, which is the
                    // exact state route 2 will inspect after BUG A lands. The
                    // clone has every field — including that id — but is not the
                    // indexed object, so today's add behavior is the baseline.
                    indexed.id = "clone-" + suffix;
                    const freshClone = task2Clone(indexed);
                    catalog.patch(freshClone);

                    expect(catalog.size()).toBe(2);
                    expect(catalog.get("clone-" + suffix)).toBe(freshClone);
                    expect(task2Array(catalog.idsFor("comp", "All", "")))
                        .toEqual(["indexed-old", "clone-" + suffix]);
                }
            ),
            { numRuns: 100, seed: 20261001 }
        );
    });

    test("P2 — a fresh object with a different id and otherwise identical fields remains an add", () => {
        // **Validates: Requirements 2.4, 3.1**
        task2Fc.assert(
            task2Fc.property(task2Fc.nat({ max: 1000000 }), function (n) {
                const indexed = {
                    id: "indexed-" + n,
                    name: "Same values",
                    category: "Cat",
                    section: "comp",
                    favorite: true,
                    type: "comp",
                    dim: "1x1",
                };
                const catalog = build();
                catalog.build([indexed], sectionOf);
                const fresh = task2Clone(indexed);
                fresh.id = "fresh-" + n;

                catalog.patch(fresh);

                expect(catalog.size()).toBe(2);
                expect(catalog.get(indexed.id)).toBe(indexed);
                expect(catalog.get(fresh.id)).toBe(fresh);
                expect(task2Array(catalog.idsFor("comp", "All", "")))
                    .toEqual([indexed.id, fresh.id]);
            }),
            { numRuns: 100, seed: 20261002 }
        );
    });

    test("P3 — 500 same-id favourite/category patches equal a full rebuild on the whole public surface", () => {
        // **Validates: Requirements 3.2**
        const patchArbitrary = task2Fc.record({
            victim: task2Fc.nat({ max: 17 }),
            kind: task2Fc.constantFrom("favorite", "category", "both"),
            favorite: task2Fc.boolean(),
            category: task2Fc.constantFrom("Glow", "Blur", "Color", "Brand New", "Other"),
        });

        task2Fc.assert(
            task2Fc.property(patchArbitrary, function (spec) {
                const records = makeRecords(18);
                const catalog = build();
                catalog.build(records, sectionOf);
                const victim = records[spec.victim];
                const previous = {
                    id: victim.id,
                    category: victim.category,
                    favorite: victim.favorite,
                    section: victim.section,
                };

                if (spec.kind === "favorite" || spec.kind === "both") {
                    victim.favorite = spec.favorite;
                }
                if (spec.kind === "category" || spec.kind === "both") {
                    victim.category = spec.category;
                }

                catalog.patch(victim, previous);

                const rebuilt = build();
                rebuilt.build(records, sectionOf);
                expectTask2CatalogParity(
                    catalog,
                    rebuilt,
                    records,
                    ["", "t", "glow", "brand", "missing-query"]
                );
            }),
            { numRuns: 500, seed: 20261003 }
        );
    }, 120000);

    test("P4 — a null record id keeps the observed string-key registration behavior", () => {
        // **Validates: Requirements 3.1**
        const catalog = build();
        catalog.build([], sectionOf);
        const record = {
            id: null,
            name: "Null id",
            category: "Cat",
            section: "comp",
            favorite: false,
            type: "comp",
            dim: "1x1",
        };

        catalog.patch(record);

        // Object keys coerce null to "null"; both public lookups therefore
        // resolve the same reference. idsFor preserves the actual null value
        // pushed into sectionIds. This pathology is deliberately not repaired.
        expect(catalog.size()).toBe(1);
        expect(catalog.get(null)).toBe(record);
        expect(catalog.get("null")).toBe(record);
        expect(task2Array(catalog.idsFor("comp", "All", ""))).toEqual([null]);
        expect(task2Plain(catalog.sectionCounts("comp")))
            .toEqual({ all: 1, favorites: 0, cats: { Cat: 1 } });
    });

    test("P5 — patch and remove leave sourceStamp untouched; stampSource and build move it", () => {
        // **Validates: Requirements 3.3**
        task2Fc.assert(
            task2Fc.property(
                task2Fc.integer(),
                task2Fc.integer(),
                task2Fc.integer(),
                function (initialRevision, explicitRevision, rebuiltRevision) {
                    const records = makeRecords(4);
                    const catalog = build();
                    catalog.build(records, sectionOf, initialRevision);
                    expect(catalog.sourceStamp()).toBe(initialRevision);

                    const victim = records[1];
                    const previous = {
                        category: victim.category,
                        favorite: victim.favorite,
                        section: victim.section,
                    };
                    victim.favorite = !victim.favorite;
                    catalog.patch(victim, previous);
                    expect(catalog.sourceStamp()).toBe(initialRevision);

                    records.splice(records.indexOf(victim), 1);
                    catalog.remove(victim);
                    expect(catalog.sourceStamp()).toBe(initialRevision);

                    expect(catalog.stampSource(explicitRevision)).toBe(explicitRevision);
                    expect(catalog.sourceStamp()).toBe(explicitRevision);

                    catalog.build(records, sectionOf, rebuiltRevision);
                    expect(catalog.sourceStamp()).toBe(rebuiltRevision);
                }
            ),
            { numRuns: 100, seed: 20261004 }
        );
    });

    test("P6 — references, id lists, and first-discovery category order retain their shapes", () => {
        // **Validates: Requirements 3.4**
        const categoryArbitrary = task2Fc.array(
            task2Fc.constantFrom("Glow", "Blur", "Glow", "Color", "Distort", "Blur"),
            { minLength: 1, maxLength: 30 }
        );

        task2Fc.assert(
            task2Fc.property(categoryArbitrary, function (categories) {
                const records = categories.map(function (category, index) {
                    return {
                        id: "shape-" + index,
                        name: "Shape " + index,
                        category: category,
                        section: "comp",
                        favorite: index % 3 === 0,
                        type: "comp",
                        dim: "1x1",
                    };
                });
                const catalog = build();
                catalog.build(records, sectionOf);

                const expectedOrder = ["All", "Favorites"];
                categories.forEach(function (category) {
                    if (expectedOrder.indexOf(category) === -1) expectedOrder.push(category);
                });

                expect(task2Array(catalog.categories("comp"))).toEqual(expectedOrder);
                expect(new Set(task2Array(catalog.categories("comp"))).size)
                    .toBe(catalog.categories("comp").length);
                expect(task2Array(catalog.idsFor("comp", "All", "")))
                    .toEqual(records.map(function (record) { return record.id; }));
                records.forEach(function (record) {
                    expect(catalog.get(record.id)).toBe(record);
                    expect(typeof catalog.idsFor("comp", "All", "")[records.indexOf(record)])
                        .toBe("string");
                });

                // Same-id replacement remains a reference update, never a
                // catalog-owned clone, while the ordered id slot is unchanged.
                const at = Math.floor(records.length / 2);
                const replacement = task2Clone(records[at]);
                replacement.name += " replacement";
                catalog.patch(replacement, {
                    category: records[at].category,
                    favorite: records[at].favorite,
                    section: records[at].section,
                });
                expect(catalog.get(replacement.id)).toBe(replacement);
                expect(task2Array(catalog.idsFor("comp", "All", ""))[at])
                    .toBe(replacement.id);
            }),
            { numRuns: 200, seed: 20261005 }
        );
    }, 120000);
});