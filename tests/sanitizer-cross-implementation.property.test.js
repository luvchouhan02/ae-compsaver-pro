// ============================================================
// tests/sanitizer-cross-implementation.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.4)
//
// Property 7 — One Canonical Sanitizer (RUNTIME half).
// The static half — "the implementation exercised by the tests is the
// implementation index.html loads" — is tests/panel-script-manifest.test.js.
//
//   For ANY name, the panel's getSafeName / generateTemplateId and the host's
//   getSafeName / generateTemplateId return the IDENTICAL string; that string
//   contains no path separator, no C0 control character, no trailing dot or
//   space, is at most 255 characters, and is never "." or "..".
//
// One deviation from the design's literal wording, forced by an implementation
// decision: the design says to compare against `csSanitizeName(n).value`. There
// is no `csSanitizeName`. The host port was deliberately INLINED into
// `getSafeName` in jsx/core.jsx, because both baseline harnesses
// (tests/comp-pipeline-bug-exploration.test.js and
// tests/comp-pipeline-preservation.property.test.js) brace-walk a FIXED function
// name list, and a new sibling would have thrown ReferenceError inside a sliced
// realm. The comment above jsx/core.jsx `getSafeName` records that constraint.
// The invariant is unchanged, with one fewer indirection:
//     pathBuilders.getSafeName(n)        === hostGetSafeName(n)
//     pathBuilders.generateTemplateId(n) === hostGenerateTemplateId(n)
//
// NO RE-KEYING is asserted as its own property: for any name made of letters,
// digits, spaces, dashes and dots-not-at-the-end, the output equals what the
// PRE-FIX rule produced (trim, then replace only \ / : * ? " < > |), so no
// existing library folder is renamed by F5. An EMPTY input still returns ""
// rather than the fallback, preserving the shape of existing empty-category
// paths.
//
// typeof-guard branches exercised
// ------------------------------
//   PRIMARY  — the host is loaded as a WHOLE FILE through
//              tests/helpers/loadHelpers.js, so `getSafeName` reaches the real
//              `trimStr` and `generateTemplateId` reaches the real `cleanStr`.
//              No fallback runs.
//   SLICED   — the same two functions are additionally lifted through the
//              brace-walk harness (the shape the two baseline suites use) and
//              asserted to agree with the whole-file realm, which is what proves
//              the inlining did not create a second rule set.
//   The panel side is a plain CommonJS `require` of js/core/pathBuilders.js.
//
// **Validates: Requirements 2.8, 2.26, 2.27**
// ============================================================
"use strict";

const fc = require("fast-check");
const pathBuilders = require("../js/core/pathBuilders.js");
const H = require("./helpers/compPipelineHarness");

// ── The two implementations under comparison ────────────────────────────────
const hostCore = H.loadHostCore();
const hostGetSafeName = hostCore.get("getSafeName");
const hostGenerateTemplateId = hostCore.get("generateTemplateId");
const hostCleanStr = hostCore.get("cleanStr");

// The SLICED host realm — the brace-walk shape the baseline suites use.
const slicedHost = H.buildRealm(H.CORE_PURE, {});

// ─────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────
// Full BMP code units, so every C0 control, DEL, quote, backslash, separator and
// lone surrogate is reachable.
const arbAnyString = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { minLength: 0, maxLength: 60 })
    .map((codes) => codes.map((c) => String.fromCharCode(c)).join(""));

// The hostile table the design's unit-test list names, verbatim.
const NAMED_CASES = [
    ".", "..", "...", "....",
    "name.", "name ", "name. ", "name .", " name ",
    "", "   ", "\t", "\n", "\r\n", " \t \r\n ",
    "CON", "con", "Con.aep", "PRN", "prn.txt", "AUX", "nul", "NUL.psd",
    "com1", "COM9", "lpt1", "LPT9.txt", "aux.psd", "console", "connect",
    "a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b",
    "a/b\\c:d*e?f\"g<h>i|j",
    "\u0000", "a\u0000b", "\u0007bell", "\u001fus", "\u007fdel",
    "../../etc/passwd", "..\\..\\windows\\system32",
    new Array(255 + 1).join("A"),
    new Array(256 + 1).join("B"),
    new Array(300 + 1).join("C"),
    new Array(300 + 1).join("D") + ".",
    "  leading and trailing  ",
    "interior.dots.are.fine",
    "Lower Third 01", "a-b_c-1", "x",
    "\u00e9\u00e8\u00ea", "\u65e5\u672c\u8a9e", "\ud83d\ude00",
];
const arbNamedCase = fc.constantFrom.apply(null, NAMED_CASES);

// Letters, digits, spaces, dashes and INTERIOR dots only — the class the
// no-re-keying guarantee covers.
const NO_REKEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.";
const arbNoRekeyName = fc
    .array(fc.integer({ min: 0, max: NO_REKEY_CHARS.length - 1 }), { minLength: 1, maxLength: 120 })
    .map((idx) => idx.map((i) => NO_REKEY_CHARS[i]).join(""));

const arbName = fc.oneof(arbNamedCase, arbAnyString, arbNoRekeyName);

// ── The PRE-FIX rule, reproduced verbatim as the no-re-keying reference ──────
// jsx/core.jsx getSafeName before F5: trim, then replace ONLY the illegal
// separator class. Nothing else.
function preFixGetSafeName(s) {
    if (s === null || s === undefined) return "";
    const v = String(s).replace(/^\s+/, "").replace(/\s+$/, "");
    return v.replace(/[\\/:*?"<>|]/g, "_");
}

const RESERVED_STEMS = ("con prn aux nul com1 com2 com3 com4 com5 com6 com7 com8 com9 " +
    "lpt1 lpt2 lpt3 lpt4 lpt5 lpt6 lpt7 lpt8 lpt9").split(" ");

/** Would the PRE-FIX output already have been a safe, non-re-keyed segment? */
function isPreFixStable(out) {
    if (out === "") return true;                 // the preserved empty-category shape
    if (out.length > 255) return false;          // truncation changes it
    if (/[.\s]$/.test(out)) return false;        // trailing dot/space is now stripped
    if (out === "." || out === "..") return false;
    let stem = out.toLowerCase();
    const dot = stem.indexOf(".");
    if (dot > 0) stem = stem.substring(0, dot);
    if (RESERVED_STEMS.indexOf(stem) !== -1) return false; // now escaped with "_"
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(out)) return false;   // now replaced with "_"
    return true;
}

// ============================================================
// Cross-implementation agreement
// ============================================================
describe("Property 7 — the panel and the host compute the same segment", () => {
    test("getSafeName agrees byte-for-byte on every generated name", () => {
        fc.assert(
            fc.property(arbName, (n) => {
                expect(pathBuilders.getSafeName(n)).toBe(hostGetSafeName(n));
            }),
            { numRuns: 2000 }
        );
    });

    test("generateTemplateId agrees byte-for-byte on every generated name", () => {
        fc.assert(
            fc.property(arbName, (n) => {
                expect(pathBuilders.generateTemplateId(n)).toBe(hostGenerateTemplateId(n));
            }),
            { numRuns: 2000 }
        );
    });

    test("the named hostile cases agree, including null and undefined", () => {
        NAMED_CASES.concat([null, undefined]).forEach((n) => {
            expect(pathBuilders.getSafeName(n)).toBe(hostGetSafeName(n));
            expect(pathBuilders.generateTemplateId(n)).toBe(hostGenerateTemplateId(n));
        });
    });

    test("the SLICED host realm computes the same values as the whole-file host realm", () => {
        fc.assert(
            fc.property(arbName, (n) => {
                expect(slicedHost.getSafeName(n)).toBe(hostGetSafeName(n));
                expect(slicedHost.generateTemplateId(n)).toBe(hostGenerateTemplateId(n));
                // ...and therefore also the panel's.
                expect(slicedHost.getSafeName(n)).toBe(pathBuilders.getSafeName(n));
            }),
            { numRuns: 1000 }
        );
    });

    test("generateTemplateId folds in the whitespace normalization on both sides", () => {
        fc.assert(
            fc.property(arbName, (n) => {
                // The host is generateTemplateId(name) = getSafeName(cleanStr(name));
                // the panel is sanitizeNameStrict(cleanName(name)).value. The two
                // normalizations must be the same function.
                expect(pathBuilders.cleanName(n)).toBe(hostCleanStr(n));
                expect(hostGenerateTemplateId(n)).toBe(hostGetSafeName(hostCleanStr(n)));
                expect(pathBuilders.generateTemplateId(n))
                    .toBe(pathBuilders.getSafeName(pathBuilders.cleanName(n)));
            }),
            { numRuns: 1000 }
        );
    });

    test("both are idempotent: sanitizing an already-sanitized segment changes nothing", () => {
        fc.assert(
            fc.property(arbName, (n) => {
                const once = pathBuilders.getSafeName(n);
                expect(pathBuilders.getSafeName(once)).toBe(once);
                expect(hostGetSafeName(once)).toBe(once);
                const idOnce = pathBuilders.generateTemplateId(n);
                expect(pathBuilders.generateTemplateId(idOnce)).toBe(idOnce);
                expect(hostGenerateTemplateId(idOnce)).toBe(idOnce);
            }),
            { numRuns: 1000 }
        );
    });
});

// ============================================================
// The invariants the shared segment must satisfy
// ============================================================
describe("Property 7 — the shared segment is always addressable", () => {
    test("no path separator, no C0 control, no trailing dot or space, <= 255, never \".\" or \"..\"", () => {
        fc.assert(
            fc.property(arbName, (n) => {
                [
                    pathBuilders.getSafeName(n),
                    hostGetSafeName(n),
                    pathBuilders.generateTemplateId(n),
                    hostGenerateTemplateId(n),
                ].forEach((out) => {
                    expect(typeof out).toBe("string");
                    expect(out.indexOf("/")).toBe(-1);
                    expect(out.indexOf("\\")).toBe(-1);
                    expect(out.indexOf(":")).toBe(-1);
                    expect(/[*?"<>|]/.test(out)).toBe(false);
                    // eslint-disable-next-line no-control-regex
                    expect(/[\u0000-\u001f\u007f]/.test(out)).toBe(false);
                    expect(/[.\s]$/.test(out)).toBe(false);
                    expect(out.length).toBeLessThanOrEqual(255);
                    expect(out).not.toBe(".");
                    expect(out).not.toBe("..");
                });
            }),
            { numRuns: 2000 }
        );
    });

    test("a name that is not empty after trimming never sanitizes to the empty string", () => {
        fc.assert(
            fc.property(arbName, (n) => {
                const trimmed = String(n === null || n === undefined ? "" : n)
                    .replace(/^\s+/, "").replace(/\s+$/, "");
                if (trimmed.length === 0) {
                    // The preserved shape: empty in, empty out — NOT the fallback.
                    expect(pathBuilders.getSafeName(n)).toBe("");
                    expect(hostGetSafeName(n)).toBe("");
                } else {
                    expect(pathBuilders.getSafeName(n).length).toBeGreaterThan(0);
                    expect(hostGetSafeName(n).length).toBeGreaterThan(0);
                }
            }),
            { numRuns: 2000 }
        );
    });

    test("the traversal and reserved names are escaped, not passed through", () => {
        [".", "..", "...", "....", "name.", "name ", "\u0000", "   ."].forEach((n) => {
            const out = pathBuilders.getSafeName(n);
            expect(out).toBe(hostGetSafeName(n));
            expect(out).not.toBe(".");
            expect(out).not.toBe("..");
            expect(/[.\s]$/.test(out)).toBe(false);
        });
        RESERVED_STEMS.forEach((stem) => {
            [stem, stem.toUpperCase(), stem + ".aep"].forEach((n) => {
                const out = pathBuilders.getSafeName(n);
                expect(out).toBe(hostGetSafeName(n));
                expect(out.charAt(0)).toBe("_");
            });
        });
    });
});

// ============================================================
// NO RE-KEYING — F5 must not rename a single existing library folder
// ============================================================
describe("Property 7 — no existing library folder is re-keyed", () => {
    test("letters, digits, spaces, dashes and dots-not-at-the-end reproduce the PRE-FIX output exactly", () => {
        fc.assert(
            fc.property(arbNoRekeyName, (n) => {
                const before = preFixGetSafeName(n);
                fc.pre(isPreFixStable(before));
                expect(hostGetSafeName(n)).toBe(before);
                expect(pathBuilders.getSafeName(n)).toBe(before);
            }),
            { numRuns: 3000 }
        );
    });

    test("an EMPTY input returns \"\", not the fallback, on both sides", () => {
        ["", "   ", "\t", "\n", " \r\n ", null, undefined].forEach((n) => {
            expect(hostGetSafeName(n)).toBe("");
            expect(pathBuilders.getSafeName(n)).toBe("");
            expect(hostGenerateTemplateId(n)).toBe("");
            expect(pathBuilders.generateTemplateId(n)).toBe("");
        });
        // The {ok,...} envelope moved to sanitizeNameStrict, which DOES report the
        // empty input — the string-returning wrappers keep the legacy "" shape.
        expect(pathBuilders.sanitizeNameStrict("").ok).toBe(false);
        expect(pathBuilders.sanitizeNameStrict("").value).toBe("");
    });

    test("an already-safe curated set is byte-identical to its input", () => {
        [
            "Lower Third 01", "My Title", "a-b_c-1", "x",
            "interior.dots.are.fine", "Titles", "Lower-Thirds",
            new Array(255 + 1).join("A"),
        ].forEach((n) => {
            expect(hostGetSafeName(n)).toBe(n);
            expect(pathBuilders.getSafeName(n)).toBe(n);
        });
    });

    test("the ONLY names that change are ones that had no valid folder on disk", () => {
        fc.assert(
            fc.property(arbNoRekeyName, (n) => {
                const before = preFixGetSafeName(n);
                const after = hostGetSafeName(n);
                if (after === before) return;
                // A change is permitted only for a pre-fix output that Windows
                // could not address as a folder in the first place.
                expect(isPreFixStable(before)).toBe(false);
            }),
            { numRuns: 3000 }
        );
    });
});
