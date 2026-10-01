// ============================================================
// tests/template-file-resolution.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.11)
//
// Property 13 — Deterministic Template File Resolution.
//
//   For ANY set of file names in a template folder, resolveTemplateFiles SHALL
//   select the same file on EVERY invocation and under EVERY input permutation,
//   and that file SHALL be the highest-precedence candidate under the documented
//   ladder.
//
// The pre-fix defect: `folder.getFiles("*.aep")[0]` picked from an unspecified,
// filesystem-dependent enumeration order, so a template folder holding more than
// one .aep resolved differently on different machines.
//
// The documented ladder (jsx/core.jsx resolveTemplateFiles + csPickDeterministicFile):
//   1. meta.mainFile, when that exact file exists on disk
//   2. among *.aep     : "project.aep" case-insensitively, else the smallest name
//                        under a TOTAL order (lower-cased first, exact as the
//                        tie-break)
//   3. among *.cseffect: the smallest name under the same total order
//   4. images, in the FIXED extension order png, jpg, jpeg, gif, webp, bmp, tif,
//      tiff — the first non-empty group wins; inside it a name starting with
//      "source" (case-insensitively) wins, else the smallest name under the total
//      order
//   5. otherwise `<folder>/project.aep` as a non-existent File
// Only the tie-break INSIDE each rung became total; the rung ORDER is unchanged,
// which is what keeps getAllTemplates' degraded-record behavior identical (3.14).
//
// The reference implementation of that ladder is re-derived independently below
// from the generated name list, so agreement is a real cross-check rather than a
// restatement of the production code. It found one gap — see the REPORTED FINDING
// block at the end of this file.
//
// typeof-guard branches exercised
// ------------------------------
// `csListTemplateFiles` is `typeof csEnumerateFolderOnce === "function"
// ? csEnumerateFolderOnce(folder, mask) : folder.getFiles(mask)`.
// csEnumerateFolderOnce lives in jsx/import.jsx, so the whole-file jsx/core.jsx
// sandbox does NOT have it. Every property below is asserted on BOTH branches:
//   FALLBACK — no csEnumerateFolderOnce injected, so the direct getFiles path runs
//              (the meta-missing degraded path Req 3.14 must keep working).
//   PRIMARY  — a memoizing csEnumerateFolderOnce IS injected, so the
//              once-per-import enumerator runs and the result must be identical.
// `csReadTemplateMeta` also lives in jsx/import.jsx and is called WITHOUT a guard,
// so it is injected in both configurations — the same injection the exploration
// suite uses.
//
// **Validates: Requirements 2.25, 3.14**
// ============================================================
"use strict";

const fc = require("fast-check");
const path = require("path");
const { loadHelpers } = require("./helpers/loadHelpers");

const FOLDER_PATH = "C:/lib/comp/Cat/T1";

// ─────────────────────────────────────────────────────────────
// The modeled disk
//
// `present` is MUTABLE so one realm can be re-enumerated in many orders:
// jsx/core.jsx is parsed and evaluated once per realm, and permutation testing
// only reorders the array the Folder fake reads.
// ─────────────────────────────────────────────────────────────
function buildRealm(opts) {
    opts = opts || {};
    const present = (opts.names || []).slice();
    const metaBox = { meta: opts.meta || {} };
    const enumCalls = [];

    function FileFake(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        const self = this;
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () {
                return norm.indexOf(FOLDER_PATH + "/") === 0 && present.indexOf(self.name) !== -1;
            },
        });
    }

    /**
     * getFiles(mask) filters by EXACT extension so the reference ladder below is
     * unambiguous. A real Windows `*.tif` may also match `.tiff`; that
     * conflation is a filesystem quirk, not the precedence rule under test.
     */
    function FolderFake(p) {
        const norm = String(p).replace(/\\/g, "/");
        this.fsName = norm;
        this.name = norm.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return norm === FOLDER_PATH; },
        });
        this.getFiles = function (mask) {
            enumCalls.push({ folder: norm, mask: mask === undefined ? null : mask });
            if (norm !== FOLDER_PATH) return [];
            if (!mask) return present.map(function (n) { return new FileFake(norm + "/" + n); });
            const ext = String(mask).replace(/^\*/, "").toLowerCase();
            return present
                .filter(function (n) {
                    const dot = n.lastIndexOf(".");
                    return dot > 0 && n.substring(dot).toLowerCase() === ext;
                })
                .map(function (n) { return new FileFake(norm + "/" + n); });
        };
    }

    const injected = {
        app: {},
        File: FileFake,
        Folder: FolderFake,
        // resolveTemplateFiles calls this WITHOUT a typeof guard (it is a sibling
        // in jsx/import.jsx that ExtendScript hoists into the same global scope).
        csReadTemplateMeta: function () { return metaBox.meta; },
    };

    let memo = null;
    if (opts.memoizedEnumerator) {
        // The PRIMARY branch: the once-per-import memoized enumerator from
        // jsx/import.jsx, modeled so the memo is observable.
        memo = {};
        injected.csEnumerateFolderOnce = function (folder, mask) {
            const key = folder.fsName + "\u0000" + (mask || "");
            if (Object.prototype.hasOwnProperty.call(memo, key)) return memo[key];
            memo[key] = folder.getFiles(mask);
            return memo[key];
        };
    }

    const handle = loadHelpers({ file: path.join("jsx", "core.jsx"), injected: injected });
    return {
        handle: handle,
        FolderFake: FolderFake,
        enumCalls: enumCalls,
        setOrder: function (names) {
            present.length = 0;
            names.forEach(function (n) { present.push(n); });
            if (memo) Object.keys(memo).forEach(function (k) { delete memo[k]; });
        },
        setMeta: function (m) { metaBox.meta = m || {}; },
        resolve: function () {
            return handle.get("resolveTemplateFiles")("C:/lib", "Cat", "T1", "comp");
        },
        pick: handle.get("csPickDeterministicFile"),
        listFolder: function () { return new FolderFake(FOLDER_PATH); },
    };
}

// Two realms, one per typeof branch, reused across every property run.
const DIRECT = buildRealm({ memoizedEnumerator: false });
const MEMOIZED = buildRealm({ memoizedEnumerator: true });

function resolveWith(realm, names, meta) {
    realm.setOrder(names);
    realm.setMeta(meta);
    const res = realm.resolve();
    return res && res.mainFile ? res.mainFile.name : null;
}

// ─────────────────────────────────────────────────────────────
// The reference ladder, derived independently from the name list
// ─────────────────────────────────────────────────────────────
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"];

function extOf(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.substring(dot).toLowerCase() : "";
}

/** The TOTAL order: case-insensitive first, case-sensitive as the tie-break. */
function totalOrderKey(name) {
    return name.toLowerCase() + "\u0000" + name;
}

function smallest(names) {
    let best = null;
    let bestKey = null;
    names.forEach(function (n) {
        const k = totalOrderKey(n);
        if (bestKey === null || k < bestKey) { bestKey = k; best = n; }
    });
    return best;
}

function isSourceName(n) {
    return n.toLowerCase().indexOf("source") === 0;
}

function expectedMainFileName(names, meta) {
    const declared = (meta && meta.mainFile) || "project.aep";
    if (names.indexOf(declared) !== -1) return declared;

    const aeps = names.filter(function (n) { return extOf(n) === ".aep"; });
    if (aeps.length) {
        const preferred = aeps.filter(function (n) { return n.toLowerCase() === "project.aep"; });
        if (preferred.length) return preferred[0];
        return smallest(aeps);
    }

    const cseffects = names.filter(function (n) { return extOf(n) === ".cseffect"; });
    if (cseffects.length) return smallest(cseffects);

    for (let i = 0; i < IMAGE_EXTS.length; i++) {
        const group = names.filter(function (n) { return extOf(n) === IMAGE_EXTS[i]; });
        if (!group.length) continue;
        const sources = group.filter(isSourceName);
        // Inside the source subset production compares LOWER-CASED names only
        // (see the REPORTED FINDING at the end of this file); the generator below
        // excludes case-only source collisions, so a plain lower-cased comparison
        // is unambiguous here.
        if (sources.length) {
            return sources.reduce(function (a, b) {
                return a.toLowerCase() <= b.toLowerCase() ? a : b;
            });
        }
        return smallest(group);
    }

    // Nothing matched: the declared name as a non-existent File.
    return declared;
}

// ─────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────
const STEMS = ["project", "b", "a", "A", "B", "source", "Source", "SOURCE", "main", "zz", "0"];
const EXTS = [".aep", ".cseffect"].concat(IMAGE_EXTS);

const arbFileName = fc
    .tuple(fc.constantFrom.apply(null, STEMS), fc.constantFrom.apply(null, EXTS))
    .map(function (t) { return t[0] + t[1]; });

/**
 * 0..8 files. Exact duplicates are dropped (a folder cannot hold the same name
 * twice), and two `source.*` names that differ ONLY by case are dropped down to
 * one — that collision is the reported gap and has its own test below.
 */
const arbFolderContents = fc
    .array(arbFileName, { minLength: 0, maxLength: 8 })
    .map(function (list) {
        const seen = {};
        const seenSource = {};
        return list.filter(function (n) {
            if (seen[n]) return false;
            seen[n] = true;
            if (isSourceName(n)) {
                const low = n.toLowerCase();
                if (seenSource[low]) return false;
                seenSource[low] = true;
            }
            return true;
        });
    });

const arbMeta = fc.oneof(
    fc.constant({}),
    fc.constant({ mainFile: "project.aep" }),
    fc.constant({ mainFile: "missing.aep" }),
    fc.constant({ mainFile: "b.aep" }),
    fc.constant({ mainFile: "source.png" }),
    fc.constant({ name: "My Title" })
);

/** Forward, reverse, and four deterministic shuffles — bounded work per run. */
function permutations(list) {
    if (list.length <= 1) return [list.slice()];
    const out = [list.slice(), list.slice().reverse()];
    for (let s = 0; s < 4; s++) {
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = (i * 7 + s * 13 + 3) % (i + 1);
            const t = copy[i]; copy[i] = copy[j]; copy[j] = t;
        }
        out.push(copy);
    }
    return out;
}

// ============================================================
describe("Property 13 — resolution is invariant under permutation", () => {
    test("every permutation of the folder contents resolves to the SAME file, on both branches", () => {
        fc.assert(
            fc.property(arbFolderContents, arbMeta, (names, meta) => {
                const orders = permutations(names);
                [DIRECT, MEMOIZED].forEach(function (realm) {
                    const first = resolveWith(realm, orders[0], meta);
                    orders.forEach(function (order) {
                        expect(resolveWith(realm, order, meta)).toBe(first);
                    });
                });
            }),
            { numRuns: 300 }
        );
    });

    test("repeated invocations in the SAME realm resolve to the same file", () => {
        fc.assert(
            fc.property(arbFolderContents, arbMeta, (names, meta) => {
                [DIRECT, MEMOIZED].forEach(function (realm) {
                    realm.setOrder(names);
                    realm.setMeta(meta);
                    const a = realm.resolve();
                    const b = realm.resolve();
                    const c = realm.resolve();
                    expect(b.mainFile.name).toBe(a.mainFile.name);
                    expect(c.mainFile.name).toBe(a.mainFile.name);
                    expect(b.mainFile.fsName).toBe(a.mainFile.fsName);
                });
            }),
            { numRuns: 300 }
        );
    });

    test("the memoized enumerator and the direct getFiles path resolve identically", () => {
        fc.assert(
            fc.property(arbFolderContents, arbMeta, (names, meta) => {
                expect(resolveWith(MEMOIZED, names, meta)).toBe(resolveWith(DIRECT, names, meta));
            }),
            { numRuns: 400 }
        );
    });
});

describe("Property 13 — the resolved file is the documented ladder's winner", () => {
    test("the selection matches the independently derived ladder, on both branches", () => {
        fc.assert(
            fc.property(arbFolderContents, arbMeta, (names, meta) => {
                const expected = expectedMainFileName(names, meta);
                expect(resolveWith(DIRECT, names, meta)).toBe(expected);
                expect(resolveWith(MEMOIZED, names, meta)).toBe(expected);
                DIRECT.setOrder(names);
                DIRECT.setMeta(meta);
                expect(DIRECT.resolve().mainFile.fsName).toBe(FOLDER_PATH + "/" + expected);
            }),
            { numRuns: 600 }
        );
    });

    test("meta.mainFile wins whenever it is on disk", () => {
        fc.assert(
            fc.property(arbFolderContents, arbFileName, (names, declared) => {
                const contents = names.indexOf(declared) === -1 ? names.concat([declared]) : names;
                const meta = { mainFile: declared };
                expect(resolveWith(DIRECT, contents, meta)).toBe(declared);
                expect(resolveWith(MEMOIZED, contents, meta)).toBe(declared);
            }),
            { numRuns: 400 }
        );
    });

    test("project.aep beats every other .aep, in either input order and in either case", () => {
        fc.assert(
            fc.property(
                fc.array(fc.constantFrom("a.aep", "b.aep", "zz.aep", "A.aep"), { minLength: 1, maxLength: 4 }),
                fc.constantFrom("project.aep", "Project.aep", "PROJECT.AEP"),
                (others, projectName) => {
                    const contents = others.filter(function (n) { return n !== projectName; }).concat([projectName]);
                    const meta = { mainFile: "missing.aep" };
                    [contents, contents.slice().reverse()].forEach(function (order) {
                        expect(resolveWith(DIRECT, order, meta)).toBe(projectName);
                        expect(resolveWith(MEMOIZED, order, meta)).toBe(projectName);
                    });
                }
            ),
            { numRuns: 300 }
        );
    });

    test("the rung ORDER is preserved: .aep beats .cseffect beats images, in the fixed extension order", () => {
        const meta = { mainFile: "missing.aep" };
        // .aep over everything.
        expect(resolveWith(DIRECT, ["z.png", "y.cseffect", "b.aep"], meta)).toBe("b.aep");
        // .cseffect over every image.
        expect(resolveWith(DIRECT, ["a.png", "z.cseffect"], meta)).toBe("z.cseffect");
        // Images in the FIXED extension order, not alphabetically.
        IMAGE_EXTS.forEach(function (ext, i) {
            const later = IMAGE_EXTS.slice(i + 1).map(function (e) { return "a" + e; });
            const contents = later.concat(["zz" + ext]);
            expect(resolveWith(DIRECT, contents, meta)).toBe("zz" + ext);
            expect(resolveWith(MEMOIZED, contents, meta)).toBe("zz" + ext);
        });
    });

    test("inside an image group, a \"source.*\" file wins over a lexicographically smaller name", () => {
        fc.assert(
            fc.property(fc.constantFrom("source.png", "Source.png", "SOURCE.png"), (sourceName) => {
                const contents = ["a.png", "b.png", sourceName];
                const meta = { mainFile: "missing.aep" };
                [contents, contents.slice().reverse()].forEach(function (order) {
                    expect(resolveWith(DIRECT, order, meta)).toBe(sourceName);
                    expect(resolveWith(MEMOIZED, order, meta)).toBe(sourceName);
                });
            }),
            { numRuns: 120 }
        );
    });

    test("an EMPTY folder degrades to <folder>/project.aep rather than throwing", () => {
        fc.assert(
            fc.property(arbMeta, (meta) => {
                DIRECT.setOrder([]);
                DIRECT.setMeta(meta);
                const res = DIRECT.resolve();
                expect(res).toBeTruthy();
                expect(res.mainFile.name).toBe((meta && meta.mainFile) || "project.aep");
                expect(res.mainFile.exists).toBe(false);
                // 3.14: a degraded record, never a thrown import or an empty library.
                expect(res.folder.fsName).toBe(FOLDER_PATH);
                expect(res.meta).toEqual(meta);
                expect(res.assetsFolder).toBeTruthy();
            }),
            { numRuns: 60 }
        );
    });

    test("the assets-folder ladder still ends at _Assets", () => {
        DIRECT.setOrder(["project.aep"]);
        DIRECT.setMeta({ name: "My Title" });
        // None of assets / "<name> Assets" / _Assets exists on the modeled disk,
        // so the last rung is what comes back.
        expect(DIRECT.resolve().assetsFolder.fsName).toBe(FOLDER_PATH + "/_Assets");
    });
});

describe("Property 13 — csPickDeterministicFile, on its own", () => {
    test("the pick is invariant under permutation and matches the total order", () => {
        fc.assert(
            fc.property(arbFolderContents,
                fc.oneof(fc.constant(null), fc.constantFrom("project.aep", "b.aep", "PROJECT.AEP")),
                (names, preferred) => {
                    const orders = permutations(names);
                    const results = orders.map(function (order) {
                        DIRECT.setOrder(order);
                        const files = DIRECT.listFolder().getFiles();
                        const picked = DIRECT.pick(files, preferred);
                        return picked ? picked.name : null;
                    });
                    const first = results[0];
                    results.forEach(function (x) { expect(x).toBe(first); });

                    // ...and it is the documented winner. `preferred` matches
                    // case-insensitively, so with a case-only duplicate present the
                    // exact-match rung is order-dependent by design; the generated
                    // stems make that impossible (only one spelling per stem/ext).
                    let expected = null;
                    if (names.length) {
                        const exact = names.filter(function (n) {
                            return preferred && n.toLowerCase() === String(preferred).toLowerCase();
                        });
                        expected = exact.length ? exact[0] : smallest(names);
                    }
                    expect(first).toBe(expected);
                }),
            { numRuns: 300 }
        );
    });

    test("an empty or absent list returns null", () => {
        expect(DIRECT.pick([], "project.aep")).toBe(null);
        expect(DIRECT.pick(null, "project.aep")).toBe(null);
        expect(DIRECT.pick(undefined, null)).toBe(null);
    });

    test("the total order breaks a case-only tie deterministically", () => {
        // The key is `lower + "\u0000" + exact`, so "A.aep" < "a.aep" — a stable
        // answer rather than "whichever the filesystem listed first".
        const meta = { mainFile: "missing.aep" };
        expect(resolveWith(DIRECT, ["a.aep", "A.aep"], meta))
            .toBe(resolveWith(DIRECT, ["A.aep", "a.aep"], meta));
        expect(resolveWith(DIRECT, ["a.aep", "A.aep"], meta)).toBe("A.aep");
        expect(resolveWith(DIRECT, ["b.cseffect", "B.cseffect"], meta)).toBe("B.cseffect");
        expect(resolveWith(DIRECT, ["a.png", "A.png"], meta)).toBe("A.png");
    });
});

// ============================================================
// REPORTED FINDING — the `source.*` sub-selection's tie-break is not total
// ------------------------------------------------------------
// jsx/core.jsx resolveTemplateFiles selects the preferred image inside an
// extension group with
//
//     if (!srcPick || ("" + cand.name).toLowerCase() < ("" + srcPick.name).toLowerCase())
//
// — a LOWER-CASED comparison with no case-sensitive tie-break. `<` is therefore
// false for two `source.*` names that differ only by case, so the FIRST one the
// enumeration happens to yield wins. A template folder containing both
// "Source.jpg" and "SOURCE.jpg" resolves differently in the two input orders,
// which is the class of defect F12 exists to eliminate.
//
// `csPickDeterministicFile` itself is total (its key is
// `nameLower + "\u0000" + name`), so every OTHER rung — including the case-only
// .aep, .cseffect and non-source image ties asserted above — is order-invariant.
// Only the inlined `source.*` scan omits the tie-break, so the fix would be to
// route that scan through csPickDeterministicFile over the source subset.
//
// Shrunk counterexample: names ["Source.jpg", "SOURCE.jpg"] with
// meta = { mainFile: "missing.aep" } resolves "Source.jpg" forward and
// "SOURCE.jpg" reversed.
//
// Reported rather than patched: task 15 changes no production file. The test
// below asserts what Property 13 requires that DOES hold on this input — the
// resolved file is always one of the `source.*` candidates in the
// highest-precedence extension group, so the rung is still correct and the
// library still scans — and pins the order dependence so a future fix surfaces
// here.
// ============================================================
describe("Property 13 — case-only \"source.*\" collision (reported gap)", () => {
    const CASE_SPELLINGS = ["source", "Source", "SOURCE"];

    test("the rung is still correct: the winner is always one of the source candidates", () => {
        fc.assert(
            fc.property(fc.constantFrom.apply(null, IMAGE_EXTS),
                fc.constantFrom("source", "Source", "SOURCE"),
                fc.constantFrom("source", "Source", "SOURCE"),
                (ext, aStem, bStem) => {
                    fc.pre(aStem !== bStem);
                    const a = aStem + ext;
                    const b = bStem + ext;
                    const meta = { mainFile: "missing.aep" };
                    const candidates = [a, b];
                    [[a, b, "zz" + ext], [b, a, "zz" + ext]].forEach(function (order) {
                        const got = resolveWith(DIRECT, order, meta);
                        // Never the non-source file, and never nothing.
                        expect(candidates).toContain(got);
                    });
                }),
            { numRuns: 200 }
        );
    });

    test("the order dependence, pinned: the first-enumerated spelling wins", () => {
        const meta = { mainFile: "missing.aep" };
        for (let i = 0; i < CASE_SPELLINGS.length; i++) {
            for (let j = 0; j < CASE_SPELLINGS.length; j++) {
                if (i === j) continue;
                const a = CASE_SPELLINGS[i] + ".jpg";
                const b = CASE_SPELLINGS[j] + ".jpg";
                expect(resolveWith(DIRECT, [a, b], meta)).toBe(a);
                expect(resolveWith(DIRECT, [b, a], meta)).toBe(b);
            }
        }
    });

    test("csPickDeterministicFile, which the other rungs use, IS total on the same input", () => {
        const files = ["Source.jpg", "SOURCE.jpg"];
        DIRECT.setOrder(files);
        const forward = DIRECT.pick(DIRECT.listFolder().getFiles(), null);
        DIRECT.setOrder(files.slice().reverse());
        const reverse = DIRECT.pick(DIRECT.listFolder().getFiles(), null);
        expect(forward.name).toBe(reverse.name);
        expect(forward.name).toBe("SOURCE.jpg"); // "source.jpg\0SOURCE.jpg" is smallest
    });
});
