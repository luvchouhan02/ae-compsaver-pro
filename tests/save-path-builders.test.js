/**
 * Property tests for the pure path-builder module (js/core/pathBuilders.js).
 * ==========================================================================
 * Property (Req 12): Deterministic path construction and sanitization.
 *
 * These tests use fast-check to assert the universal correctness properties
 * defined in Requirement 12 of the save-performance-optimization spec:
 *   - identical inputs produce byte-for-byte identical output (determinism)
 *   - constructed paths never contain "\", "//", or a leading/trailing separator
 *   - sanitized names/ids contain no "/" or "\" and are <= 255 chars
 *   - empty names / names that reduce to zero chars yield the invalid-name error
 *
 * CONTRACT CHANGE (comp-template-pipeline-audit-fix, F5 / Req 2.27)
 * -----------------------------------------------------------------
 * This module used to be the only sanitizer with property tests AND the only one
 * that never ran: it was absent from index.html, so the tested rules were not the
 * runtime rules. F5 makes it the single canonical panel implementation, loaded
 * before its consumers. To be a drop-in replacement for the panel's and host's
 * existing signatures, `getSafeName`/`generateTemplateId` now return **Strings**;
 * the `{ok, value, error}` envelope moved to `sanitizeNameStrict`. The assertions
 * below follow that move — that is the whole point of Req 2.27.
 *
 * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 2.8, 2.26, 2.27**
 */

const fc = require("fast-check");
const {
    buildTemplateFolderPath,
    buildAepPath,
    buildThumbPath,
    getSafeName,
    generateTemplateId,
    cleanName,
    sanitizeNameStrict,
    normalizeSeparators,
    PATH_BUILDER_MAX_NAME_LENGTH,
    PATH_BUILDER_FALLBACK_NAME,
} = require("../js/core/pathBuilders");

// ─── Generators ───────────────────────────────────────────────────────────

// A path segment that may contain separators, spaces, unicode, dots, etc.
// This intentionally includes "/" and "\" so normalization behavior is exercised.
const segmentArb = fc.string({ minLength: 0, maxLength: 40 });

// A non-empty "root" that looks like an absolute-ish path prefix, mixing
// forward and backslashes and runs of separators to stress normalization.
const rootArb = fc.oneof(
    fc.constant("C:/Users/Test/CompSaver_Data"),
    fc.constant("C:\\Users\\Test\\CompSaver_Data"),
    fc.constant("/Users/test/Library"),
    fc.string({ minLength: 1, maxLength: 30 })
);

// A name likely to require sanitization: spaces, unicode, separators.
const dirtyNameArb = fc.string({ minLength: 1, maxLength: 300 });

// A name guaranteed to contain at least one non-whitespace, non-separator char,
// so that after sanitization it is a non-empty result.
const validNameArb = fc
    .tuple(
        fc.string({ minLength: 0, maxLength: 20 }),
        // at least one "solid" character that survives sanitization
        fc.constantFrom("a", "Z", "7", "é", "名", "-", "."),
        fc.string({ minLength: 0, maxLength: 20 })
    )
    .map(([a, solid, b]) => a + solid + b);

// A name guaranteed to satisfy EVERY canonical rule with nothing to escape, so
// sanitizeNameStrict must report ok === true. Prefixed with "t-" so it can never
// collide with a reserved device name, and it never ends in a dot or a space.
const strictOkNameArb = fc
    .array(fc.constantFrom("a", "Z", "7", "é", "名", "-", "_", " ", "."), {
        minLength: 0,
        maxLength: 40,
    })
    .map((chars) => "t-" + chars.join("") + "x");

// A name that reduces to zero characters: only whitespace, which the leading /
// trailing trim removes outright.
const emptyingNameArb = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
        minLength: 1,
        maxLength: 20,
    })
    .map((chars) => chars.join(""));

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasNoBadSeparators(pathStr) {
    return (
        pathStr.indexOf("\\") === -1 &&
        pathStr.indexOf("//") === -1 &&
        pathStr.charAt(0) !== "/" &&
        pathStr.charAt(pathStr.length - 1) !== "/"
    );
}

/**
 * The canonical "is this addressable as a single folder name" predicate — the
 * same one tests/comp-pipeline-bug-exploration.test.js uses for exploration
 * case 8. A non-empty sanitizer output must satisfy all of it (Req 2.8).
 */
function isSafeSegment(seg) {
    if (typeof seg !== "string") return false;
    if (seg === "." || seg === ".." || seg === "") return false;
    if (/[.\s]$/.test(seg)) return false;
    if (/[\\/:*?"<>|]/.test(seg)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(seg)) return false;
    return true;
}

// ─── Req 12.1 — buildTemplateFolderPath ──────────────────────────────────────

describe("Req 12.1 — buildTemplateFolderPath: deterministic, normalized folder path", () => {
    test("identical inputs produce byte-for-byte identical output", () => {
        fc.assert(
            fc.property(rootArb, segmentArb, segmentArb, segmentArb, (root, section, cat, id) => {
                const a = buildTemplateFolderPath(root, section, cat, id);
                const b = buildTemplateFolderPath(root, section, cat, id);
                expect(a).toBe(b);
            })
        );
    });

    test("output never contains a backslash, a double slash, or a leading/trailing separator", () => {
        fc.assert(
            fc.property(rootArb, segmentArb, segmentArb, segmentArb, (root, section, cat, id) => {
                const out = buildTemplateFolderPath(root, section, cat, id);
                expect(hasNoBadSeparators(out)).toBe(true);
            })
        );
    });
});

// ─── Req 12.2 — buildAepPath ─────────────────────────────────────────────────

describe("Req 12.2 — buildAepPath: folderPath/project.aep, normalized", () => {
    test("identical inputs produce byte-for-byte identical output", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 120 }), (folder) => {
                expect(buildAepPath(folder)).toBe(buildAepPath(folder));
            })
        );
    });

    test("output ends with project.aep and has no bad separators", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 120 }), (folder) => {
                const out = buildAepPath(folder);
                // Always ends with the file name; a "/" separator precedes it only
                // when the normalized folder is non-empty (leading separators are
                // stripped per Req 12.2/12.1).
                const normFolder = normalizeSeparators(folder);
                if (normFolder.length > 0) {
                    expect(out).toBe(normFolder + "/project.aep");
                } else {
                    expect(out).toBe("project.aep");
                }
                expect(hasNoBadSeparators(out)).toBe(true);
            })
        );
    });
});

// ─── Req 12.3 — buildThumbPath ───────────────────────────────────────────────

describe("Req 12.3 — buildThumbPath: folderPath/thumbnail.png, normalized", () => {
    test("identical inputs produce byte-for-byte identical output", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 120 }), (folder) => {
                expect(buildThumbPath(folder)).toBe(buildThumbPath(folder));
            })
        );
    });

    test("output ends with thumbnail.png and has no bad separators", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 120 }), (folder) => {
                const out = buildThumbPath(folder);
                const normFolder = normalizeSeparators(folder);
                if (normFolder.length > 0) {
                    expect(out).toBe(normFolder + "/thumbnail.png");
                } else {
                    expect(out).toBe("thumbnail.png");
                }
                expect(hasNoBadSeparators(out)).toBe(true);
            })
        );
    });
});

// ─── Req 12.4 / 2.8 — getSafeName and generateTemplateId return Strings ───────

describe("Req 12.4 + 2.8 — getSafeName / generateTemplateId return a safe String", () => {
    test("getSafeName always returns a String, never an envelope object", () => {
        fc.assert(
            fc.property(dirtyNameArb, (name) => {
                expect(typeof getSafeName(name)).toBe("string");
            })
        );
        expect(typeof getSafeName("")).toBe("string");
        expect(typeof getSafeName(null)).toBe("string");
        expect(typeof getSafeName(undefined)).toBe("string");
    });

    test("generateTemplateId always returns a String, never an envelope object", () => {
        fc.assert(
            fc.property(dirtyNameArb, (name) => {
                expect(typeof generateTemplateId(name)).toBe("string");
            })
        );
        expect(typeof generateTemplateId("")).toBe("string");
        expect(typeof generateTemplateId(null)).toBe("string");
        expect(typeof generateTemplateId(undefined)).toBe("string");
    });

    test("getSafeName: names with a solid char are non-empty, safe, <= 255 chars, deterministic", () => {
        fc.assert(
            fc.property(validNameArb, (name) => {
                const r1 = getSafeName(name);
                const r2 = getSafeName(name);
                expect(r1).toBe(r2); // deterministic
                expect(r1.length).toBeGreaterThan(0);
                expect(isSafeSegment(r1)).toBe(true);
                expect(r1.length).toBeLessThanOrEqual(PATH_BUILDER_MAX_NAME_LENGTH);
                expect(r1.length).toBeLessThanOrEqual(255);
            })
        );
    });

    test("generateTemplateId: names with a solid char are non-empty, safe, <= 255 chars, deterministic", () => {
        fc.assert(
            fc.property(validNameArb, (name) => {
                const r1 = generateTemplateId(name);
                const r2 = generateTemplateId(name);
                expect(r1).toBe(r2); // deterministic
                expect(r1.length).toBeGreaterThan(0);
                expect(isSafeSegment(r1)).toBe(true);
                expect(r1.length).toBeLessThanOrEqual(255);
            })
        );
    });

    test("dirty names (any input) yield either \"\" or a fully safe segment", () => {
        fc.assert(
            fc.property(dirtyNameArb, (name) => {
                const r = getSafeName(name);
                if (r.length === 0) return; // empty-input shape, preserved on purpose
                expect(isSafeSegment(r)).toBe(true);
                expect(r.length).toBeLessThanOrEqual(255);
            })
        );
    });

    test("the illegal class and every C0 control / DEL each map to one underscore", () => {
        fc.assert(
            fc.property(
                fc.array(fc.constantFrom("/", "\\", ":", "*", "?", '"', "<", ">", "|", "\t", "\u0001", "\u007f"), {
                    minLength: 1,
                    maxLength: 20,
                }),
                fc.constantFrom("a", "b", "X"),
                (bad, solid) => {
                    // Solid char FIRST and LAST so the trailing dot/space rule cannot
                    // shorten the result; every bad char in between becomes one "_".
                    const name = solid + bad.join("") + solid;
                    const r = getSafeName(name);
                    expect(r.length).toBe(name.length);
                    expect(r).toBe(solid + "_".repeat(bad.length) + solid);
                    expect(isSafeSegment(r)).toBe(true);
                }
            )
        );
    });

    test("names longer than 255 chars are truncated to 255", () => {
        const long = "a".repeat(400);
        expect(getSafeName(long).length).toBe(255);
        expect(generateTemplateId(long).length).toBe(255);
    });

    test("2.8 — traversal and reserved device names never survive", () => {
        expect(isSafeSegment(getSafeName("."))).toBe(true);
        expect(isSafeSegment(getSafeName(".."))).toBe(true);
        expect(isSafeSegment(getSafeName("..."))).toBe(true);
        expect(isSafeSegment(getSafeName("name."))).toBe(true);
        expect(getSafeName(".")).toBe(PATH_BUILDER_FALLBACK_NAME);
        expect(getSafeName("..")).toBe(PATH_BUILDER_FALLBACK_NAME);
        expect(getSafeName("...")).toBe(PATH_BUILDER_FALLBACK_NAME);
        expect(getSafeName("name.")).toBe("name");
        expect(getSafeName("con")).toBe("_con");
        expect(getSafeName("NUL")).toBe("_NUL");
        expect(getSafeName("lpt9.aep")).toBe("_lpt9.aep");
        // A name that merely CONTAINS a reserved stem is untouched.
        expect(getSafeName("console")).toBe("console");
    });

    test("2.26 — generateTemplateId folds in cleanName, so tab/space-run names agree", () => {
        expect(generateTemplateId("My\tTitle")).toBe(generateTemplateId("MyTitle"));
        expect(generateTemplateId("My   Title")).toBe("My Title");
        expect(generateTemplateId("  My Title  ")).toBe("My Title");
        // Idempotent: sanitizing an already-derived id is a no-op.
        fc.assert(
            fc.property(dirtyNameArb, (name) => {
                const once = generateTemplateId(name);
                expect(generateTemplateId(once)).toBe(once);
                expect(getSafeName(getSafeName(name))).toBe(getSafeName(name));
            })
        );
    });

    test("2.26 — NO RE-KEYING: an already-safe name is byte-identical to the legacy rule", () => {
        // The pre-F5 host rule (jsx/core.jsx getSafeName): trim, then replace the
        // illegal separator class. For any name of letters, digits, spaces, dashes
        // and dots-not-at-the-end the canonical rule must agree exactly.
        const legacy = (s) =>
            s === null || s === undefined
                ? ""
                : String(s).replace(/^\s+/, "").replace(/\s+$/, "").replace(/[\\\/:\*\?"<>\|]/g, "_");

        const alreadySafeArb = fc
            .tuple(
                fc.array(fc.constantFrom("a", "Q", "7", " ", "-", "."), { minLength: 0, maxLength: 40 }),
                fc.constantFrom("a", "Q", "7", "-")
            )
            .map(([chars, tail]) => "n" + chars.join("") + tail);

        fc.assert(
            fc.property(alreadySafeArb, (name) => {
                expect(getSafeName(name)).toBe(legacy(name));
            })
        );

        // The named examples the design calls out.
        ["My Title", "Lower-Thirds", "v1.2 final", "a-b_c-1", "x", "A".repeat(255)].forEach((n) => {
            expect(getSafeName(n)).toBe(legacy(n));
        });
    });
});

// ─── Req 12.5 / 2.8 — sanitizeNameStrict carries the {ok, value, error} envelope ─

describe("Req 12.5 — sanitizeNameStrict reports WHY a name was rejected", () => {
    test("empty string is rejected and still yields the empty-string value", () => {
        const r = sanitizeNameStrict("");
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe("string");
        expect(r.error.length).toBeGreaterThan(0);
        // The empty-input SHAPE is preserved on purpose: an empty category must
        // keep producing "" so existing library paths are not re-keyed.
        expect(r.value).toBe("");
        expect(getSafeName("")).toBe("");
        expect(generateTemplateId("")).toBe("");
    });

    test("null / undefined are rejected and yield the empty-string value", () => {
        [null, undefined].forEach((bad) => {
            const r = sanitizeNameStrict(bad);
            expect(r.ok).toBe(false);
            expect(r.value).toBe("");
        });
        expect(getSafeName(null)).toBe("");
        expect(getSafeName(undefined)).toBe("");
        expect(generateTemplateId(null)).toBe("");
        expect(generateTemplateId(undefined)).toBe("");
    });

    test("whitespace-only names are rejected and yield the empty-string value", () => {
        fc.assert(
            fc.property(emptyingNameArb, (name) => {
                const r = sanitizeNameStrict(name);
                expect(r.ok).toBe(false);
                expect(r.value).toBe("");
                expect(getSafeName(name)).toBe("");
            })
        );
    });

    test("traversal names are rejected with the fallback value", () => {
        // Every all-dot name reaches the fallback through the trailing-dot rule,
        // which runs BEFORE the explicit "." / ".." comparison and strips them to
        // zero characters. The explicit comparison is kept as a defensive backstop
        // so the rule survives any future reordering; what matters to 2.8 is that
        // the value is never a traversing segment.
        [".", "..", "...", ". ", " .. "].forEach((bad) => {
            const r = sanitizeNameStrict(bad);
            expect(r.ok).toBe(false);
            expect(r.value).toBe(PATH_BUILDER_FALLBACK_NAME);
            expect(typeof r.error).toBe("string");
            expect(r.error.length).toBeGreaterThan(0);
        });
    });

    test("reserved device names are rejected with an escaped value", () => {
        ["con", "PRN", "aux", "nul", "com1", "lpt9", "CON.aep"].forEach((bad) => {
            const r = sanitizeNameStrict(bad);
            expect(r.ok).toBe(false);
            expect(r.value).toBe("_" + bad);
            expect(/reserved/i.test(r.error)).toBe(true);
        });
    });

    test("a name that satisfies every rule is accepted, with value === getSafeName", () => {
        fc.assert(
            fc.property(strictOkNameArb, (name) => {
                const r = sanitizeNameStrict(name);
                expect(r.ok).toBe(true);
                expect(r.error).toBeUndefined();
                expect(isSafeSegment(r.value)).toBe(true);
                expect(r.value).toBe(getSafeName(name));
            })
        );
    });

    test("getSafeName is exactly sanitizeNameStrict(...).value for every input", () => {
        fc.assert(
            fc.property(dirtyNameArb, (name) => {
                expect(getSafeName(name)).toBe(sanitizeNameStrict(name).value);
                expect(generateTemplateId(name)).toBe(sanitizeNameStrict(cleanName(name)).value);
            })
        );
    });
});

// ─── cleanName — the panel twin of the host's cleanStr (Req 2.26) ─────────────

describe("cleanName — strips CR/LF/TAB, collapses whitespace runs, trims", () => {
    test("matches the host cleanStr rule on the named examples", () => {
        expect(cleanName("  a  b  ")).toBe("a b");
        expect(cleanName("a\tb")).toBe("ab");
        expect(cleanName("a\r\nb")).toBe("ab");
        expect(cleanName("a\n \tb")).toBe("a b");
        expect(cleanName(null)).toBe("");
        expect(cleanName(undefined)).toBe("");
    });

    test("idempotent, so folding it into generateTemplateId on both sides is safe", () => {
        fc.assert(
            fc.property(dirtyNameArb, (name) => {
                const once = cleanName(name);
                expect(cleanName(once)).toBe(once);
            })
        );
    });
});

// ─── normalizeSeparators direct properties (supports 12.1) ────────────────────

describe("normalizeSeparators — supports Req 12.1 normalization guarantees", () => {
    test("output has no backslash, no double slash, no leading/trailing separator", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 120 }), (raw) => {
                const out = normalizeSeparators(raw);
                if (out.length > 0) {
                    expect(hasNoBadSeparators(out)).toBe(true);
                }
            })
        );
    });

    test("idempotent: normalizing twice equals normalizing once", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 120 }), (raw) => {
                const once = normalizeSeparators(raw);
                expect(normalizeSeparators(once)).toBe(once);
            })
        );
    });

    test("null/undefined normalize to empty string", () => {
        expect(normalizeSeparators(null)).toBe("");
        expect(normalizeSeparators(undefined)).toBe("");
    });
});
