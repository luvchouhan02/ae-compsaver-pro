// ============================================================
// tests/comp-pipeline-units.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 14)
//
// The design's "Testing Strategy > Unit Tests" list, one describe block per
// entry. These are EXAMPLE tests over the new and changed functions from F1-F12;
// the generative half of the same surface lives in the numbered property suites
// (task 15) and must not be duplicated here.
//
// Harnesses (reused, not reinvented)
// ----------------------------------
//   * Whole-file host sandbox — tests/helpers/loadHelpers.js, which strips the
//     ExtendScript preprocessor directives and evaluates jsx/*.jsx in a `vm`
//     whose globals are the injected AE-DOM fakes. Used wherever a function may
//     see its real in-file siblings.
//   * Brace-walk slicing — the sliceFn(src, name) pattern from
//     tests/save-window-invariants.test.js:27-38, used where a function must be
//     lifted in ISOLATION (to exercise a `typeof sibling === "function"`
//     fallback) or where the containing file is not safely whole-file loadable.
//   * AE-DOM fakes — tests/helpers/aeFakes.js (createAppFake / createCompFake /
//     createFileFake) for the suppression counters and the recorded, throwable
//     scalar attributes.
//   * js/core/pathBuilders.js, js/core/bridge.js and js/core/importEngine.js are
//     plain CommonJS and are required directly.
//
// Harness constraints honoured here
// ---------------------------------
//   * jsonParse is NEVER brace-walk sliced: its body contains "{" and "}" inside
//     string literals, which a brace walk cannot survive. Sliced bundles rely on
//     the `typeof jsonParse === "function" ? jsonParse(x) : JSON.parse(x)` guard
//     every host caller already carries.
//   * Several production functions reach a cross-file sibling through a
//     `typeof fn === "function" ? fn(x) : <inline fallback>` guard. Loading such
//     a function in isolation runs the FALLBACK path. Where the distinction
//     matters both branches are exercised and the branch is named in the test
//     title (see decodeBridge and csListTemplateFiles below).
//
// Nothing in this file may modify production code.
//
// **Validates: Requirements 2.6, 2.7, 2.8, 2.11, 2.12, 2.13, 2.14, 2.15, 2.16,
//   2.17, 2.21, 2.22, 2.25, 2.26**
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const { loadHelpers } = require("./helpers/loadHelpers");
const aeFakes = require("./helpers/aeFakes");
const pathBuilders = require("../js/core/pathBuilders.js");
const panelBridge = require("../js/core/bridge.js");
const importEngine = require("../js/core/importEngine.js");

const ROOT = path.resolve(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CORE_SRC = readSrc("jsx/core.jsx");
const SAVE_SRC = readSrc("jsx/templates_save.jsx");
const IMPORT_SRC = readSrc("jsx/import.jsx");
const TEXT_SRC = readSrc("jsx/text.jsx");

// ─────────────────────────────────────────────────────────────
// Harness plumbing
// ─────────────────────────────────────────────────────────────

/** Brace-walk one top-level function out of an engine file. */
function sliceFn(src, name) {
    const start = src.indexOf("function " + name + "(");
    if (start === -1) throw new Error("missing " + name);
    let depth = 0, began = false;
    for (let j = src.indexOf("{", start); j < src.length; j++) {
        if (src[j] === "{") { depth++; began = true; }
        else if (src[j] === "}") { depth--; if (began && depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced " + name);
}

function sliceAll(src, names) {
    return names.map((n) => sliceFn(src, n)).join("\n");
}

/** Duck-typed AE constructor: cross-realm `instanceof` via Symbol.hasInstance. */
function duckCtor(kind) {
    const C = function () { };
    Object.defineProperty(C, Symbol.hasInstance, {
        value: function (o) { try { return !!(o && o.__kind === kind); } catch (e) { return false; } },
    });
    return C;
}

function buildRealm(source, injected) {
    const ctx = Object.assign({ console: console }, injected || {});
    ctx.global = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "comp-pipeline-units-slice" });
    return ctx;
}

/**
 * Filesystem fakes for the Folder/File surface validateLibraryRoot and
 * ensureDeepFolder touch. `create()` is recorded, and its outcome is
 * configurable so the swallowed-failure paths are reachable.
 *
 * ExtendScript's Folder normalizes interior separator runs, so the fake does
 * too (preserving a leading "//" for UNC). That is what makes the documented
 * '"//" runs' case observable rather than an artifact of the fake.
 */
function normPath(p) {
    let s = String(p).replace(/\\/g, "/");
    const unc = s.substr(0, 2) === "//";
    s = s.replace(/\/{2,}/g, "/");
    if (unc) s = "/" + s;
    if (s.length > 1) s = s.replace(/\/+$/, "");
    return s;
}

function makeFsFakes(existing, opts) {
    opts = opts || {};
    const creates = [];
    const set = {};
    (existing || []).forEach((p) => { set[normPath(p)] = true; });

    function FolderFake(p) {
        const key = normPath(p);
        this.fsName = key;
        this.name = key.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return set[key] === true; },
        });
        Object.defineProperty(this, "parent", {
            configurable: true,
            get: function () {
                const i = key.lastIndexOf("/");
                if (i <= 0) return null;
                return new FolderFake(key.substring(0, i));
            },
        });
        this.create = function () {
            creates.push(key);
            if (opts.createThrows) throw new Error("Folder.create() rejected: " + key);
            if (opts.createFalseButCreates) { set[key] = true; return false; }
            if (opts.createFails) return false;
            set[key] = true;
            return true;
        };
        this.getFiles = function () { return []; };
    }

    function FileFake(p) {
        const key = normPath(p);
        this.fsName = key;
        this.name = key.split("/").pop();
        Object.defineProperty(this, "exists", {
            configurable: true,
            get: function () { return set[key] === true; },
        });
    }

    return { Folder: FolderFake, File: FileFake, creates: creates, set: set };
}

/** Whole-file jsx/core.jsx sandbox over a given filesystem fake. */
function loadCore(fsFakes, extraInjected) {
    const injected = Object.assign({
        app: {},
        File: fsFakes.File,
        Folder: fsFakes.Folder,
    }, extraInjected || {});
    const handle = loadHelpers({ file: path.join("jsx", "core.jsx"), injected: injected, lenient: false });
    expect(handle.error).toBe(null);
    return handle;
}

// ============================================================
// 1. validateLibraryRoot / isAbsoluteLibraryRoot  (F4a — Req 2.6)
// ============================================================
describe("validateLibraryRoot / isAbsoluteLibraryRoot (jsx/core.jsx)", () => {
    // Loaded whole-file, so validateLibraryRoot sees the real trimStr and
    // isAbsoluteLibraryRoot siblings — the arrangement production runs in.
    function load(existing, opts) {
        const fsFakes = makeFsFakes(existing, opts);
        const core = loadCore(fsFakes);
        return {
            fsFakes: fsFakes,
            isAbsolute: core.get("isAbsoluteLibraryRoot"),
            validate: core.get("validateLibraryRoot"),
        };
    }

    test.each([
        ["", false, "empty string is not a path prefix"],
        ["MyLib", false, "bare relative name"],
        ["./x", false, "explicitly relative"],
        ["../x", false, "relative traversal"],
        ["C:/x", true, "drive letter, forward slashes"],
        ["C:\\x", true, "drive letter, backslashes (normalized first)"],
        ["//server/share", true, "UNC"],
        ["/Users/x", true, "POSIX absolute"],
        ["C:/lib/", true, "trailing separator"],
        ["   ", false, "whitespace only (trimmed to empty)"],
    ])("isAbsoluteLibraryRoot(%j) === %s — %s", (input, expected) => {
        const h = load(["C:/x", "C:/lib"]);
        expect(h.isAbsolute(input)).toBe(expected);
    });

    test("null and undefined are not absolute roots", () => {
        const h = load([]);
        expect(h.isAbsolute(null)).toBe(false);
        expect(h.isAbsolute(undefined)).toBe(false);
    });

    test('"" is rejected with an explicit reason and no filesystem probe', () => {
        const h = load([]);
        const r = h.validate("");
        expect(r.ok).toBe(false);
        expect(r.error).toBe("No library root path was provided.");
        expect(h.fsFakes.creates).toEqual([]);
    });

    test.each([["MyLib"], ["./x"], ["../x"]])(
        "a relative root (%j) is rejected as not absolute",
        (input) => {
            const h = load([]);
            const r = h.validate(input);
            expect(r.ok).toBe(false);
            expect(r.error).toContain("not an absolute path");
            expect(h.fsFakes.creates).toEqual([]);
        }
    );

    test.each([
        ["C:/x", "C:/x"],
        ["C:\\x", "C:/x"],
        ["//server/share", "//server/share"],
        ["/Users/x", "/Users/x"],
    ])("an existing absolute root (%j) validates and normalizes to %j", (input, expectedPath) => {
        const h = load(["C:/x", "//server/share", "/Users/x"]);
        const r = h.validate(input);
        expect(r.ok).toBe(true);
        expect(r.path).toBe(expectedPath);
    });

    test("a trailing-slash root validates and the separator is stripped from the returned path", () => {
        const h = load(["C:/lib"]);
        const r = h.validate("C:/lib/");
        expect(r.ok).toBe(true);
        // The returned path is what every later "<root>/<section>/..." join uses,
        // so a surviving trailing slash would produce "C:/lib//comp/...".
        expect(r.path).toBe("C:/lib");
    });

    test("a non-existent root with an EXISTING parent validates — a first-run library is still creatable", () => {
        const h = load(["C:/lib"]);
        const r = h.validate("C:/lib/NewLibrary");
        expect(r.ok).toBe(true);
        expect(r.path).toBe("C:/lib/NewLibrary");
    });

    test("a non-existent root with a NON-EXISTENT parent is rejected and names the path", () => {
        const h = load([]);
        const r = h.validate("C:/nope/newroot");
        expect(r.ok).toBe(false);
        expect(r.error).toContain("does not exist and cannot be created");
        expect(r.error).toContain("C:/nope/newroot");
        expect(h.fsFakes.creates).toEqual([]);
    });

    test("a Folder whose .parent read throws is treated as unresolvable, not as valid", () => {
        const fsFakes = makeFsFakes([]);
        const Hostile = function (p) {
            fsFakes.Folder.call(this, p);
            Object.defineProperty(this, "parent", {
                configurable: true,
                get: function () { throw new Error("volume detached"); },
            });
        };
        const core = loadCore({ Folder: Hostile, File: fsFakes.File, creates: fsFakes.creates });
        const r = core.get("validateLibraryRoot")("C:/lib/NewLibrary");
        expect(r.ok).toBe(false);
    });
});

// ============================================================
// 2. ensureDeepFolder  (F4b — Req 2.7)
// ============================================================
describe("ensureDeepFolder (jsx/core.jsx)", () => {
    function load(existing, opts) {
        const fsFakes = makeFsFakes(existing, opts);
        const core = loadCore(fsFakes);
        return { fsFakes: fsFakes, ensure: core.get("ensureDeepFolder") };
    }

    test("already-exists returns the folder and creates nothing", () => {
        const h = load(["C:/lib/comp/Cat/T"]);
        const out = h.ensure("C:/lib/comp/Cat/T");
        expect(out).not.toBe(null);
        expect(out.exists).toBe(true);
        expect(h.fsFakes.creates).toEqual([]);
    });

    test("multi-level creation creates each missing level top-down and returns an existing folder", () => {
        const h = load(["C:/lib"]);
        const out = h.ensure("C:/lib/comp/Cat/T");
        expect(out).not.toBe(null);
        expect(out.exists).toBe(true);
        expect(h.fsFakes.creates).toEqual([
            "C:/lib/comp",
            "C:/lib/comp/Cat",
            "C:/lib/comp/Cat/T",
        ]);
    });

    test("create() returning false with the folder still absent returns null — the honest contract", () => {
        const h = load(["C:/lib"], { createFails: true });
        const out = h.ensure("C:/lib/comp/Cat/T");
        expect(out).toBe(null);
        // It stops at the FIRST level it could not create rather than pressing on.
        expect(h.fsFakes.creates).toEqual(["C:/lib/comp"]);
    });

    test("create() returning false on a volume that DID create it still succeeds (the exists re-test)", () => {
        const h = load(["C:/lib"], { createFalseButCreates: true });
        const out = h.ensure("C:/lib/comp/Cat/T");
        expect(out).not.toBe(null);
        expect(out.exists).toBe(true);
        expect(h.fsFakes.creates).toEqual([
            "C:/lib/comp",
            "C:/lib/comp/Cat",
            "C:/lib/comp/Cat/T",
        ]);
    });

    test("create() throwing returns null instead of propagating", () => {
        const h = load(["C:/lib"], { createThrows: true });
        let out;
        expect(() => { out = h.ensure("C:/lib/comp/Cat/T"); }).not.toThrow();
        expect(out).toBe(null);
    });

    test('a path with "//" runs collapses: no empty segment is ever created', () => {
        const h = load(["C:/lib"]);
        const out = h.ensure("C:/lib//comp///Cat/T");
        expect(out).not.toBe(null);
        expect(out.exists).toBe(true);
        expect(h.fsFakes.creates).toEqual([
            "C:/lib/comp",
            "C:/lib/comp/Cat",
            "C:/lib/comp/Cat/T",
        ]);
        h.fsFakes.creates.forEach((c) => expect(c).not.toMatch(/\/\//));
    });

    test("a throwing Folder constructor returns null rather than escaping", () => {
        const core = loadCore({
            Folder: function () { throw new Error("Folder ctor rejected"); },
            File: function () { },
        });
        let out;
        expect(() => { out = core.get("ensureDeepFolder")("C:/lib/comp"); }).not.toThrow();
        expect(out).toBe(null);
    });

    // The `null` contract is only worth anything if every call site that
    // DEREFERENCES the result checks it. Static sweep over all four host files:
    // each `var X = ensureDeepFolder(...)` must be followed by a
    // `!X || !X.exists` guard. The fire-and-forget sites (which ignore the
    // return value entirely) are deliberately excluded — they never assign it.
    test("every assigning ensureDeepFolder call site guards the null contract", () => {
        const files = [
            "jsx/core.jsx",
            "jsx/templates_save.jsx",
            "jsx/text.jsx",
            "jsx/import.jsx",
        ];
        const sites = [];
        files.forEach((rel) => {
            const src = readSrc(rel);
            const re = /var\s+(\w+)\s*=\s*ensureDeepFolder\(/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                const name = m[1];
                const window = src.substr(m.index, 900);
                const guard = "!" + name + " || !" + name + ".exists";
                sites.push({ file: rel, name: name, guarded: window.indexOf(guard) !== -1 });
            }
        });
        // F4b's contract change landed with seven dereferencing guard sites.
        expect(sites.length).toBe(7);
        expect(sites.filter((s) => !s.guarded)).toEqual([]);
    });
});

// ============================================================
// 3. sanitizeNameStrict (panel) + getSafeName (host)  (F5 — Req 2.8, 2.26)
// ============================================================
describe("sanitizeNameStrict (js/core/pathBuilders.js) and getSafeName (jsx/core.jsx)", () => {
    const core = loadCore(makeFsFakes([]));
    const hostGetSafeName = core.get("getSafeName");
    const hostGenerateTemplateId = core.get("generateTemplateId");

    // The host port was deliberately INLINED into getSafeName rather than added
    // as a separate csSanitizeName: the slice harnesses lift a FIXED function
    // name list, so getSafeName may not depend on a new sibling. getSafeName is
    // therefore the host half of the canonical rule and the function under test.
    test("the host carries the canonical rule inside getSafeName, not a separate csSanitizeName", () => {
        expect(typeof hostGetSafeName).toBe("function");
        expect(core.has("csSanitizeName")).toBe(false);
    });

    const CASES = [
        // input,               strict.ok, safe value
        [".", false, "_untitled"],
        ["..", false, "_untitled"],
        ["...", false, "_untitled"],
        ["name.", true, "name"],
        ["name ", true, "name"],
        ["   ", false, ""],
        ["CON", false, "_CON"],
        ["con.aep", false, "_con.aep"],
        ["a/b\\c", true, "a_b_c"],
        ["a\u0000b", true, "a_b"],
        ["\u0000", true, "_"],
        ["My Title 01", true, "My Title 01"],
        ["v1.2 final", true, "v1.2 final"],
    ];

    test.each(CASES)("sanitizeNameStrict(%j) -> ok=%s value=%j", (input, ok, value) => {
        const r = pathBuilders.sanitizeNameStrict(input);
        expect(r.ok).toBe(ok);
        expect(r.value).toBe(value);
        if (!ok) expect(typeof r.error).toBe("string");
    });

    test('"" returns the empty string, NOT the fallback — existing empty-category path shapes survive', () => {
        expect(pathBuilders.sanitizeNameStrict("").ok).toBe(false);
        expect(pathBuilders.sanitizeNameStrict("").value).toBe("");
        expect(pathBuilders.getSafeName("")).toBe("");
        expect(hostGetSafeName("")).toBe("");
    });

    test.each(CASES)("host getSafeName(%j) agrees with the panel (-> %s / %j)", (input, ok, value) => {
        expect(hostGetSafeName(input)).toBe(value);
        expect(pathBuilders.getSafeName(input)).toBe(value);
    });

    test("an already-safe name is returned unchanged by both implementations", () => {
        ["My Title 01", "Lower Third - Bold", "v1.2 final", "abc123"].forEach((n) => {
            expect(pathBuilders.getSafeName(n)).toBe(n);
            expect(hostGetSafeName(n)).toBe(n);
        });
    });

    test("a 300-character name truncates to 255 on both sides", () => {
        const long = "a".repeat(300);
        expect(pathBuilders.getSafeName(long).length).toBe(255);
        expect(hostGetSafeName(long).length).toBe(255);
        expect(hostGetSafeName(long)).toBe(pathBuilders.getSafeName(long));
    });

    test("truncation re-strips a trailing dot exposed by the cut", () => {
        // 254 x "a" then "." then filler: the 255-char cut ends on the dot, which
        // Windows would silently drop, so it must be stripped again after the cut.
        const name = "a".repeat(254) + "." + "b".repeat(45);
        const expected = "a".repeat(254);
        expect(pathBuilders.getSafeName(name)).toBe(expected);
        expect(hostGetSafeName(name)).toBe(expected);
    });

    test("every produced value is a usable single path segment", () => {
        CASES.forEach((row) => {
            const value = pathBuilders.getSafeName(row[0]);
            if (value === "") return; // the preserved empty-category shape
            expect(value).not.toBe(".");
            expect(value).not.toBe("..");
            expect(value).not.toMatch(/[\\/:*?"<>|]/);
            // eslint-disable-next-line no-control-regex
            expect(value).not.toMatch(/[\u0000-\u001f\u007f]/);
            expect(value).not.toMatch(/[. ]$/);
            expect(value.length).toBeLessThanOrEqual(255);
        });
    });

    test("generateTemplateId folds in the whitespace clean-up identically on both sides", () => {
        ["My  Title\t", "  Spaced  Out  ", "Tab\tSeparated"].forEach((n) => {
            expect(pathBuilders.generateTemplateId(n)).toBe(hostGenerateTemplateId(n));
        });
        expect(pathBuilders.generateTemplateId("My  Title\t")).toBe("My Title");
    });
});

// ============================================================
// 4. escapeJSON  (F8c — Req 2.16)
// ============================================================
describe("escapeJSON (jsx/core.jsx)", () => {
    const core = loadCore(makeFsFakes([]));
    const escapeJSON = core.get("escapeJSON");
    const jsonStringify = core.get("jsonStringify");

    const quote = (s) => JSON.parse('"' + escapeJSON(s) + '"');

    test("every C0 control character round-trips through JSON.parse", () => {
        for (let code = 0; code <= 31; code++) {
            const ch = String.fromCharCode(code);
            expect(quote(ch)).toBe(ch);
            expect(quote("a" + ch + "b")).toBe("a" + ch + "b");
        }
    });

    test("DEL (U+007F) is \\u-escaped and round-trips", () => {
        expect(escapeJSON("\u007F")).toBe("\\u007f");
        expect(quote("\u007F")).toBe("\u007F");
    });

    test.each([
        ["\r", "\\r", "carriage return alone (the old version DELETED it)"],
        ["\r\n", "\\r\\n", "CRLF keeps both halves"],
        ["\n", "\\n", "line feed"],
        ["\t", "\\t", "tab"],
        ["\b", "\\b", "backspace"],
        ["\f", "\\f", "form feed"],
        ['"', '\\"', "double quote"],
        ["\\", "\\\\", "backslash"],
        ["\u0001", "\\u0001", "an otherwise unnamed C0 control"],
        ["\u000B", "\\u000b", "vertical tab"],
    ])("escapeJSON(%j) === %j — %s", (input, expected) => {
        expect(escapeJSON(input)).toBe(expected);
        expect(quote(input)).toBe(input);
    });

    test("a control-free string takes the fast path and is byte-identical to its input", () => {
        const plain = "Lower Third - Bold v1.2 (final) 世界 café";
        expect(escapeJSON(plain)).toBe(plain);
        // The fast path is a single native regex test placed before the escape
        // loop; without it every string in a 326-template scan would be walked.
        expect(core.source).toContain('if (!/[\\u0000-\\u001F\\u007F]/.test(s)) return s;');
    });

    test("null and undefined collapse to the empty string", () => {
        expect(escapeJSON(null)).toBe("");
        expect(escapeJSON(undefined)).toBe("");
    });

    test("jsonStringify always emits a document JSON.parse accepts", () => {
        const obj = {
            plain: "ok",
            cr: "a\r\nb",
            ctrl: "a\u0001b",
            del: "x\u007Fy",
            quoted: 'he said "hi"',
            slashed: "C:\\lib\\comp",
            "key\u0002with control": "v",
        };
        const doc = jsonStringify(obj);
        let parsed;
        expect(() => { parsed = JSON.parse(doc); }).not.toThrow();
        Object.keys(obj).forEach((k) => expect(parsed[k]).toBe(obj[k]));
    });

    test("property: any string survives jsonStringify -> JSON.parse unchanged", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 60 }), (s) => {
                const parsed = JSON.parse(jsonStringify({ v: s }));
                return parsed.v === s;
            }),
            { numRuns: 300 }
        );
    });
});

// ============================================================
// 5. decodeBridgeStrict — BOTH implementations  (F8a/F8b — Req 2.15)
// ============================================================
describe("decodeBridgeStrict (js/core/bridge.js and jsx/core.jsx)", () => {
    const core = loadCore(makeFsFakes([]));
    const impls = [
        ["panel", panelBridge.decodeBridgeStrict, panelBridge.decodeBridge, panelBridge.encodeBridge],
        ["host", core.get("decodeBridgeStrict"), core.get("decodeBridge"), core.get("encodeBridge")],
    ];

    // A well-formed payload is 4 hex digits per UTF-16 code unit.
    const VALID = panelBridge.encodeBridge("Hello");
    const LONG = panelBridge.encodeBridge("世界".repeat(4000)); // 32000 hex chars

    const MALFORMED = [
        ["0", "length 1 mod 4"],
        ["00", "length 2 mod 4"],
        ["000", "length 3 mod 4"],
        ["0048006", "length 3 mod 4 on a realistic truncation"],
        ["00G8", "a non-hex character"],
        ["00480065ZZZZ0074", "a 4-char non-hex chunk"],
        ["  ", "whitespace is not hex"],
    ];

    describe.each(impls)("%s implementation", (label, strict, decode, encode) => {
        test('"" decodes to the empty string and is NOT an error', () => {
            const r = strict("");
            expect(r.ok).toBe(true);
            expect(r.value).toBe("");
            expect(decode("")).toBe("");
        });

        test("null / undefined decode to the empty string", () => {
            expect(strict(null).ok).toBe(true);
            expect(strict(null).value).toBe("");
            expect(strict(undefined).value).toBe("");
        });

        test("a valid payload decodes to its original string", () => {
            expect(strict(VALID)).toEqual({ ok: true, value: "Hello" });
            expect(decode(VALID)).toBe("Hello");
        });

        test.each(MALFORMED)("%j is REPORTED, not decoded — %s", (payload) => {
            const r = strict(payload);
            expect(r.ok).toBe(false);
            expect(r.value).toBe("");
            expect(typeof r.error).toBe("string");
            expect(r.error).toContain("Malformed Bridge payload");
            // The back-compatible wrapper yields "" rather than a corrupted string.
            expect(decode(payload)).toBe("");
        });

        test("a very long valid payload decodes in full", () => {
            const r = strict(LONG);
            expect(r.ok).toBe(true);
            expect(r.value.length).toBe(8000);
            expect(r.value).toBe("世界".repeat(4000));
            expect(encode(r.value)).toBe(LONG);
        });

        test("uppercase hex is accepted", () => {
            expect(strict(VALID.toUpperCase())).toEqual({ ok: true, value: "Hello" });
        });
    });

    test("both implementations agree on ok, value and the malformed set", () => {
        const payloads = [""].concat(MALFORMED.map((m) => m[0]), [VALID, VALID.toUpperCase(), LONG]);
        payloads.forEach((p) => {
            const a = panelBridge.decodeBridgeStrict(p);
            const b = core.get("decodeBridgeStrict")(p);
            expect(b.ok).toBe(a.ok);
            expect(b.value).toBe(a.value);
        });
    });

    test("isWellFormedBridgeHex is the shared predicate on both sides", () => {
        const hostPred = core.get("isWellFormedBridgeHex");
        [""].concat(MALFORMED.map((m) => m[0]), [VALID]).forEach((p) => {
            expect(hostPred(p)).toBe(panelBridge.isWellFormedBridgeHex(p));
        });
        expect(panelBridge.isWellFormedBridgeHex(null)).toBe(false);
        expect(hostPred(null)).toBe(false);
    });

    // The typeof guard: jsx/core.jsx:78 reads
    //   if (typeof decodeBridgeStrict === "function") return decodeBridgeStrict(hex).value;
    // and falls back to the SAME validation + append loop inlined, because the
    // slice harnesses lift decodeBridge by name WITHOUT its sibling. Both
    // branches must behave identically.
    describe("host decodeBridge typeof-guard branches", () => {
        const isolated = buildRealm(sliceFn(CORE_SRC, "decodeBridge"), {});

        test("the sibling is genuinely absent in the sliced realm (fallback branch selected)", () => {
            expect(isolated.decodeBridgeStrict).toBeUndefined();
            expect(typeof isolated.decodeBridge).toBe("function");
        });

        test("the inline fallback matches the guarded branch on every payload", () => {
            const guarded = core.get("decodeBridge");
            const payloads = ["", VALID, VALID.toUpperCase(), LONG].concat(MALFORMED.map((m) => m[0]));
            payloads.forEach((p) => {
                expect(isolated.decodeBridge(p)).toBe(guarded(p));
            });
            expect(isolated.decodeBridge(null)).toBe(guarded(null));
        });
    });
});

// ============================================================
// 6. csPickDeterministicFile  (F12a — Req 2.25)
// ============================================================
describe("csPickDeterministicFile (jsx/core.jsx)", () => {
    const fsFakes = makeFsFakes([]);
    const core = loadCore(fsFakes);
    const pick = core.get("csPickDeterministicFile");
    const F = (name) => new fsFakes.File("C:/lib/comp/Cat/T/" + name);

    test("an empty list yields null", () => {
        expect(pick([], "project.aep")).toBe(null);
        expect(pick(null, "project.aep")).toBe(null);
        expect(pick(undefined, null)).toBe(null);
    });

    test("one file yields that file, preferred or not", () => {
        const only = F("b.aep");
        expect(pick([only], "project.aep")).toBe(only);
        expect(pick([only], null)).toBe(only);
    });

    test("the preferred exact name wins when present", () => {
        const files = [F("a.aep"), F("project.aep"), F("z.aep")];
        expect(pick(files, "project.aep").name).toBe("project.aep");
    });

    test("the preferred name is matched case-insensitively", () => {
        const files = [F("a.aep"), F("PROJECT.AEP")];
        expect(pick(files, "project.aep").name).toBe("PROJECT.AEP");
    });

    test("with the preferred name absent the lexicographically smallest name wins", () => {
        const files = [F("zeta.aep"), F("beta.aep"), F("alpha.aep")];
        expect(pick(files, "project.aep").name).toBe("alpha.aep");
    });

    test("names differing only by case resolve under a TOTAL order (case-sensitive tie-break)", () => {
        const upperFirst = pick([F("B.aep"), F("b.aep")], null).name;
        const lowerFirst = pick([F("b.aep"), F("B.aep")], null).name;
        expect(upperFirst).toBe(lowerFirst);
        // Case-insensitive keys tie, so the case-sensitive tie-break decides:
        // "B" (0x42) sorts before "b" (0x62).
        expect(upperFirst).toBe("B.aep");
    });

    test("both input orders resolve the same file", () => {
        const forward = [F("b.aep"), F("project.aep")];
        const reverse = [F("project.aep"), F("b.aep")];
        expect(pick(forward, "project.aep").name).toBe("project.aep");
        expect(pick(reverse, "project.aep").name).toBe("project.aep");
        expect(pick(forward.slice().reverse(), null).name).toBe(pick(forward, null).name);
    });

    test("non-File entries are ignored", () => {
        const real = F("b.aep");
        expect(pick([{ name: "aaa.aep" }, real], null)).toBe(real);
        expect(pick([{ name: "aaa.aep" }], null)).toBe(null);
    });

    test("property: the pick is invariant under every permutation of the input", () => {
        const names = ["b.aep", "project.aep", "Alpha.aep", "alpha.aep", "z.aep"];
        fc.assert(
            fc.property(
                fc.shuffledSubarray(names, { minLength: names.length, maxLength: names.length }),
                fc.constantFrom("project.aep", null),
                (order, preferred) => {
                    const picked = pick(order.map(F), preferred);
                    const baseline = pick(names.map(F), preferred);
                    return picked.name === baseline.name;
                }
            ),
            { numRuns: 200 }
        );
    });

    // csListTemplateFiles is the enumeration csPickDeterministicFile is fed
    // from. It reaches jsx/import.jsx's memoized enumerator through a
    // `typeof csEnumerateFolderOnce === "function"` guard, so both branches
    // matter.
    describe("csListTemplateFiles typeof-guard branches", () => {
        function folderWith(names, opts) {
            opts = opts || {};
            return {
                fsName: "C:/lib/comp/Cat/T",
                getFiles: function (mask) {
                    if (opts.getFilesThrows) throw new Error("enumeration failed");
                    if (opts.getFilesNull) return null;
                    this.__lastMask = mask;
                    return names.map(F);
                },
            };
        }

        test("guarded branch: the memoized enumerator is used when present", () => {
            const calls = [];
            const handle = loadCore(fsFakes, {
                csEnumerateFolderOnce: function (folder, mask) {
                    calls.push(mask);
                    return [F("memoized.aep")];
                },
            });
            const out = handle.get("csListTemplateFiles")(folderWith(["disk.aep"]), "*.aep");
            expect(calls).toEqual(["*.aep"]);
            expect(out.map((f) => f.name)).toEqual(["memoized.aep"]);
        });

        test("fallback branch: a direct getFiles when the enumerator is absent", () => {
            const handle = loadCore(fsFakes); // no csEnumerateFolderOnce injected
            expect(handle.has("csEnumerateFolderOnce")).toBe(false);
            const out = handle.get("csListTemplateFiles")(folderWith(["disk.aep"]), "*.aep");
            expect(out.map((f) => f.name)).toEqual(["disk.aep"]);
        });

        test("a throwing enumerator degrades to a direct read (the meta-missing path keeps working)", () => {
            const handle = loadCore(fsFakes, {
                csEnumerateFolderOnce: function () { throw new Error("csIo unavailable"); },
            });
            const out = handle.get("csListTemplateFiles")(folderWith(["disk.aep"]), "*.aep");
            expect(out.map((f) => f.name)).toEqual(["disk.aep"]);
        });

        test("a total enumeration failure yields [] rather than throwing", () => {
            const handle = loadCore(fsFakes);
            expect(handle.get("csListTemplateFiles")(folderWith([], { getFilesThrows: true }), "*.aep")).toEqual([]);
            expect(handle.get("csListTemplateFiles")(folderWith([], { getFilesNull: true }), "*.aep")).toEqual([]);
        });
    });
});

// ============================================================
// 7. findCompItemInFolderByName  (F6b — Req 2.11)
// ============================================================
describe("findCompItemInFolderByName (jsx/text.jsx)", () => {
    // Sliced rather than whole-file loaded: this function only needs the
    // CompItem / FolderItem constructors, and jsx/text.jsx is a large engine
    // file whose other functions are irrelevant here.
    const ctx = buildRealm(sliceFn(TEXT_SRC, "findCompItemInFolderByName"), {
        CompItem: duckCtor("comp"),
        FolderItem: duckCtor("folder"),
    });
    const find = ctx.findCompItemInFolderByName;

    function comp(name) { return { __kind: "comp", name: name }; }
    function folder(name, children) {
        const kids = children || [];
        return {
            __kind: "folder",
            name: name,
            get numItems() { return kids.length; },
            item: function (i) { return kids[i - 1]; },
            __children: kids,
        };
    }
    function hostileFolder(name) {
        return {
            __kind: "folder",
            name: name,
            get numItems() { throw new Error("After Effects error: invalid object reference"); },
            item: function () { throw new Error("unreachable"); },
        };
    }

    test("an exact match at depth 1 is found", () => {
        const target = comp("Recorded Comp");
        const root = folder("imported", [comp("Other"), target, comp("Third")]);
        expect(find(root, "Recorded Comp")).toBe(target);
    });

    test("an exact match at depth 3 is found by the breadth-first walk", () => {
        const target = comp("Recorded Comp");
        const root = folder("imported", [
            comp("Shallow Decoy"),
            folder("L1", [folder("L2", [comp("Deep Decoy"), target])]),
        ]);
        expect(find(root, "Recorded Comp")).toBe(target);
    });

    test("an exact match at depth 3 beats a case-differing match at depth 1", () => {
        const exact = comp("Recorded Comp");
        const loose = comp("recorded comp");
        const root = folder("imported", [loose, folder("L1", [folder("L2", [exact])])]);
        expect(find(root, "Recorded Comp")).toBe(exact);
    });

    test("a case-differing name matches when no exact match exists", () => {
        const loose = comp("RECORDED COMP");
        const root = folder("imported", [comp("Other"), loose]);
        expect(find(root, "Recorded Comp")).toBe(loose);
    });

    test("no match yields null", () => {
        const root = folder("imported", [comp("A"), folder("L1", [comp("B")])]);
        expect(find(root, "Recorded Comp")).toBe(null);
    });

    test("a folder whose numItems throws is skipped without aborting the walk", () => {
        const target = comp("Recorded Comp");
        const root = folder("imported", [hostileFolder("broken"), folder("ok", [target])]);
        let out;
        expect(() => { out = find(root, "Recorded Comp"); }).not.toThrow();
        expect(out).toBe(target);
    });

    test("a root whose numItems throws yields null rather than throwing", () => {
        let out;
        expect(() => { out = find(hostileFolder("broken"), "Recorded Comp"); }).not.toThrow();
        expect(out).toBe(null);
    });

    test("an absent folder or an empty name yields null", () => {
        expect(find(null, "Recorded Comp")).toBe(null);
        expect(find(folder("imported", [comp("A")]), "")).toBe(null);
        expect(find(folder("imported", [comp("A")]), null)).toBe(null);
    });

    test("the thumbnail engine reaches this function through a typeof guard", () => {
        // jsx/templates_save.jsx:419 — a host that loaded without jsx/text.jsx
        // must degrade to findCompItemInFolder rather than throw.
        expect(SAVE_SRC).toContain('typeof findCompItemInFolderByName === "function"');
    });
});

// ============================================================
// 8. renderFrameToPng  (F6e — Req 2.12)
// ============================================================
describe("renderFrameToPng (jsx/helpers.jsx)", () => {
    function load() {
        const app = aeFakes.createAppFake();
        const handle = loadHelpers({
            file: path.join("jsx", "helpers.jsx"),
            injected: { app: app },
            lenient: false,
        });
        expect(handle.error).toBe(null);
        return { app: app, render: handle.get("renderFrameToPng") };
    }

    test("the playhead is restored on the success path, suppression balanced", () => {
        const h = load();
        const comp = aeFakes.createCompFake({ time: 5 });
        const seen = [];
        comp.saveFrameToPng = function (t) { seen.push({ t: t, timeAtRender: comp.time }); };

        const result = h.render(comp, 2, aeFakes.createFileFake({ exists: true, length: 4096 }));

        expect(result.success).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0].timeAtRender).toBe(2); // the frame really was focused
        expect(comp.time).toBe(5);            // and then handed back
        expect(h.app.suppressDepth()).toBe(0);
    });

    test("the playhead is restored when the render throws, suppression balanced", () => {
        const h = load();
        const comp = aeFakes.createCompFake({ time: 7 });
        comp.saveFrameToPng = function () { throw new Error("render failed"); };

        const result = h.render(comp, 3, aeFakes.createFileFake({ exists: false, length: 0 }));

        expect(result.success).toBe(false);
        expect(result.error).toContain("render failed");
        expect(comp.time).toBe(7);
        expect(h.app.suppressDepth()).toBe(0);
    });

    test("a rejected comp.time write neither aborts the render nor corrupts the playhead", () => {
        const h = load();
        const comp = aeFakes.createCompFake({ time: 9, throws: { "set:time": true } });
        let rendered = false;
        comp.saveFrameToPng = function () { rendered = true; };

        let result;
        expect(() => {
            result = h.render(comp, 4, aeFakes.createFileFake({ exists: true, length: 4096 }));
        }).not.toThrow();

        expect(rendered).toBe(true);
        expect(result.success).toBe(true);
        expect(comp.time).toBe(9); // never moved, so nothing to restore
        expect(h.app.suppressDepth()).toBe(0);
    });

    test("a rejected RESTORE still releases suppression and keeps the reported result", () => {
        const h = load();
        // The write succeeds once (so timeChanged latches) and the restore is
        // then rejected: the finally must survive it and still end suppression.
        let writes = 0;
        let backing = 11;
        const comp = { __isCompFake: true };
        Object.defineProperty(comp, "time", {
            get: function () { return backing; },
            set: function (v) {
                writes++;
                if (writes > 1) throw new Error("time write rejected");
                backing = v;
            },
        });
        comp.saveFrameToPng = function () { };

        const result = h.render(comp, 6, aeFakes.createFileFake({ exists: true, length: 4096 }));

        expect(result.success).toBe(true);
        expect(writes).toBe(2); // focus + attempted restore
        expect(h.app.suppressDepth()).toBe(0);
    });

    test("suppression is balanced on all three paths, and a sub-64-byte PNG is still a failure", () => {
        const h = load();
        const ok = aeFakes.createCompFake({ time: 1 });
        ok.saveFrameToPng = function () { };
        const boom = aeFakes.createCompFake({ time: 2 });
        boom.saveFrameToPng = function () { throw new Error("nope"); };
        const rejected = aeFakes.createCompFake({ time: 3, throws: { "set:time": true } });
        rejected.saveFrameToPng = function () { };

        h.render(ok, 0.5, aeFakes.createFileFake({ exists: true, length: 4096 }));
        h.render(boom, 0.5, aeFakes.createFileFake({ exists: false, length: 0 }));
        const tiny = h.render(rejected, 0.5, aeFakes.createFileFake({ exists: true, length: 32 }));

        const begins = h.app.calls.filter((c) => c.name === "beginSuppressDialogs").length;
        const ends = h.app.calls.filter((c) => c.name === "endSuppressDialogs").length;
        expect(begins).toBe(3);
        expect(ends).toBe(3);
        expect(h.app.suppressDepth()).toBe(0);
        expect(tiny.success).toBe(false);
    });

    test("an omitted time leaves the playhead completely untouched", () => {
        const h = load();
        const comp = aeFakes.createCompFake({ time: 4 });
        comp.saveFrameToPng = function () { };
        const result = h.render(comp, null, aeFakes.createFileFake({ exists: true, length: 4096 }));
        expect(result.success).toBe(true);
        expect(comp.time).toBe(4);
        expect(comp.calls.filter((c) => c.name === "set:time")).toEqual([]);
    });
});

// ============================================================
// 9. placeLayerAtPlayhead  (F10a — Req 2.21)
// ============================================================
describe("placeLayerAtPlayhead (jsx/templates_save.jsx)", () => {
    const ctx = buildRealm(
        [sliceFn(CORE_SRC, "deselectAllLayers"), sliceFn(SAVE_SRC, "placeLayerAtPlayhead")].join("\n"),
        {}
    );
    const place = ctx.placeLayerAtPlayhead;

    function makeComp() {
        const layers = [];
        const comp = {
            __layers: layers,
            get numLayers() { return layers.length; },
            layer: function (i) { return layers[i - 1]; },
            get selectedLayers() {
                return layers.filter(function (l) { return l.selected; });
            },
        };
        comp.addLayer = function (name, opts) {
            opts = opts || {};
            const layer = {
                name: name,
                selected: false,
                startTime: 0,
                inPoint: opts.inPoint !== undefined ? opts.inPoint : 0,
                __moveTargets: [],
            };
            Object.defineProperty(layer, "index", {
                configurable: true,
                get: function () { return layers.indexOf(layer) + 1; },
            });
            layer.moveBefore = function (other) {
                layer.__moveTargets.push(other);
                if (opts.moveBeforeRejects && opts.moveBeforeRejects(other)) {
                    throw new Error("After Effects error: cannot move before that layer");
                }
                const from = layers.indexOf(layer);
                if (from >= 0) layers.splice(from, 1);
                const to = layers.indexOf(other);
                layers.splice(to < 0 ? 0 : to, 0, layer);
            };
            layers.push(layer);
            return layer;
        };
        return comp;
    }

    /** A layer object that is NOT in the comp — a stale/foreign anchor. */
    function detachedLayer(name, opts) {
        opts = opts || {};
        const layer = { name: name };
        Object.defineProperty(layer, "index", {
            get: function () {
                if (opts.indexThrows) throw new Error("After Effects error: invalid object reference");
                return opts.index !== undefined ? opts.index : 5;
            },
        });
        return layer;
    }

    test("a live anchor is used BY REFERENCE: the new layer lands directly above it", () => {
        const comp = makeComp();
        const top = comp.addLayer("Top");
        const anchor = comp.addLayer("Anchor");
        const newLayer = comp.addLayer("Imported");

        place(comp, newLayer, 3, anchor);

        expect(newLayer.__moveTargets).toEqual([anchor]);
        expect(newLayer.index).toBe(anchor.index - 1);
        expect(comp.__layers.map((l) => l.name)).toEqual(["Top", "Imported", "Anchor"]);
        expect(top.index).toBe(1);
    });

    test("duplicate anchor names no longer decide the placement", () => {
        const comp = makeComp();
        comp.addLayer("BG");                 // the decoy the by-name scan used to find
        const chosen = comp.addLayer("BG");  // the layer the user actually selected
        chosen.selected = true;
        const newLayer = comp.addLayer("Imported");

        place(comp, newLayer, 3, chosen);

        expect(newLayer.index).toBe(chosen.index - 1);
        expect(comp.__layers[comp.__layers.indexOf(newLayer) + 1]).toBe(chosen);
        expect(comp.__layers.map((l) => l.name)).toEqual(["BG", "Imported", "BG"]);
    });

    test("the timing math is applied: startTime === playheadTime - inPoint", () => {
        const comp = makeComp();
        const anchor = comp.addLayer("Anchor");
        const newLayer = comp.addLayer("Imported", { inPoint: 1.25 });

        place(comp, newLayer, 4, anchor);

        expect(newLayer.startTime).toBeCloseTo(2.75, 6);
    });

    test("an unreadable inPoint falls back to startTime = playheadTime", () => {
        const comp = makeComp();
        const anchor = comp.addLayer("Anchor");
        const newLayer = comp.addLayer("Imported");
        Object.defineProperty(newLayer, "inPoint", {
            get: function () { throw new Error("inPoint unavailable"); },
        });

        place(comp, newLayer, 4, anchor);

        expect(newLayer.startTime).toBe(4);
    });

    test("anchorLayer === newLayer is a no-op move, and the layer is still selected", () => {
        const comp = makeComp();
        comp.addLayer("Top");
        const newLayer = comp.addLayer("Imported");
        const before = newLayer.index;

        place(comp, newLayer, 3, newLayer);

        expect(newLayer.__moveTargets).toEqual([]);
        expect(newLayer.index).toBe(before);
        expect(newLayer.selected).toBe(true);
    });

    test("anchorLayer === null leaves the order alone and still selects the new layer", () => {
        const comp = makeComp();
        comp.addLayer("Top");
        const newLayer = comp.addLayer("Imported");

        place(comp, newLayer, 3, null);

        expect(newLayer.__moveTargets).toEqual([]);
        expect(comp.__layers.map((l) => l.name)).toEqual(["Top", "Imported"]);
        expect(newLayer.selected).toBe(true);
    });

    test("the by-name scan is the FALLBACK when moveBefore on the reference is rejected", () => {
        // The liveness probe (.index) succeeds but the move itself is refused —
        // the only way the reference can fail while its name is still readable.
        const comp = makeComp();
        comp.addLayer("Other");
        const liveTwin = comp.addLayer("BG");
        const foreign = detachedLayer("BG", { index: 9 });
        const newLayer = comp.addLayer("Imported", {
            moveBeforeRejects: function (other) { return other === foreign; },
        });

        place(comp, newLayer, 3, foreign);

        expect(newLayer.__moveTargets[0]).toBe(foreign);   // reference attempted first
        expect(newLayer.__moveTargets[1]).toBe(liveTwin);  // then the by-name scan
        expect(newLayer.index).toBe(liveTwin.index - 1);
        expect(comp.__layers.map((l) => l.name)).toEqual(["Other", "Imported", "BG"]);
    });

    test("an anchor whose .index read throws is refused, and no wrong placement is invented", () => {
        // Reading .index on an invalidated reference throws — that IS the
        // liveness probe. In After Effects a reference in that state also throws
        // on .name, so the by-name scan could not help either: the observable
        // outcome is "no move", which is what this asserts. The design text
        // describes the same case as "fallback engaged"; the two are equivalent
        // in effect, because engaging the scan would immediately throw on
        // anchorLayer.name and be swallowed by its own catch.
        const comp = makeComp();
        comp.addLayer("Other");
        comp.addLayer("BG");
        const newLayer = comp.addLayer("Imported");
        const before = newLayer.index;
        const stale = detachedLayer("BG", { indexThrows: true });

        expect(() => place(comp, newLayer, 3, stale)).not.toThrow();

        expect(newLayer.__moveTargets).toEqual([]);
        expect(newLayer.index).toBe(before);
        expect(newLayer.selected).toBe(true);
    });

    test("the new layer ends up selected and everything else deselected", () => {
        const comp = makeComp();
        const a = comp.addLayer("A");
        const b = comp.addLayer("B");
        a.selected = true;
        b.selected = true;
        const newLayer = comp.addLayer("Imported");

        place(comp, newLayer, 3, b);

        expect(comp.selectedLayers).toEqual([newLayer]);
    });
});

// ============================================================
// 10. csResolveImportAnchor  (F10b/F10c/F10d — Req 2.22)
// ============================================================
describe("csResolveImportAnchor (jsx/import.jsx)", () => {
    function buildAnchorRealm() {
        const src = [
            "var __CS_IMPORT_BATCH_ANCHOR = null;",
            sliceAll(CORE_SRC, ["deselectAllLayers", "getTopSelectedLayer"]),
            sliceAll(IMPORT_SRC, [
                "csBatchAnchorBegin", "csBatchAnchorReselect", "csBatchAnchorEnd",
                "csResolveImportAnchor",
            ]),
        ].join("\n");
        return buildRealm(src, {});
    }

    let nextCompId = 100;
    function makeComp() {
        const layers = [];
        const comp = {
            id: nextCompId++,
            __layers: layers,
            get numLayers() { return layers.length; },
            layer: function (i) { return layers[i - 1]; },
            get selectedLayers() {
                return layers.filter(function (l) { return l.selected; });
            },
        };
        comp.addLayer = function (name, opts) {
            opts = opts || {};
            const layer = { name: name, __selected: false };
            Object.defineProperty(layer, "index", {
                configurable: true,
                get: function () { return layers.indexOf(layer) + 1; },
            });
            Object.defineProperty(layer, "selected", {
                configurable: true,
                get: function () { return layer.__selected; },
                set: function (v) {
                    if (opts.selectRejects) throw new Error("After Effects error: invalid object reference");
                    layer.__selected = v;
                },
            });
            layers.push(layer);
            return layer;
        };
        comp.removeLayer = function (layer) {
            const i = layers.indexOf(layer);
            if (i >= 0) layers.splice(i, 1);
        };
        return comp;
    }

    test("no latch (standalone): the resolver IS getTopSelectedLayer", () => {
        const ctx = buildAnchorRealm();
        const comp = makeComp();
        comp.addLayer("Top");
        const chosen = comp.addLayer("Chosen");
        chosen.selected = true;

        expect(ctx.__CS_IMPORT_BATCH_ANCHOR).toBe(null);
        const anchor = ctx.csResolveImportAnchor(comp);
        // Equality with getTopSelectedLayer is also the contract of the
        // `typeof csResolveImportAnchor === "function"` fallback at the four
        // import call sites, which inline exactly this call.
        expect(anchor).toBe(chosen);
        expect(anchor).toBe(ctx.getTopSelectedLayer(comp));
    });

    test("no latch with nothing selected yields null", () => {
        const ctx = buildAnchorRealm();
        const comp = makeComp();
        comp.addLayer("Top");
        expect(ctx.csResolveImportAnchor(comp)).toBe(null);
    });

    test("latch for the SAME comp: the pre-action selection is re-applied and the original anchor returned", () => {
        const ctx = buildAnchorRealm();
        const comp = makeComp();
        comp.addLayer("Top");
        const chosen = comp.addLayer("User Selected");
        chosen.selected = true;

        ctx.csBatchAnchorBegin(comp);
        expect(ctx.__CS_IMPORT_BATCH_ANCHOR.anchor).toBe(chosen);

        // Template 1 inserts a layer and leaves IT selected (placeLayerAtPlayhead
        // always does). Without the latch, template 2 would anchor to this layer.
        const inserted = comp.addLayer("Template 1");
        chosen.selected = false;
        inserted.selected = true;

        const anchor = ctx.csResolveImportAnchor(comp);

        expect(anchor).toBe(chosen);
        expect(chosen.selected).toBe(true);
        expect(inserted.selected).toBe(false);
    });

    test("latch for the same comp is stable across an arbitrary number of templates", () => {
        const ctx = buildAnchorRealm();
        const comp = makeComp();
        const chosen = comp.addLayer("User Selected");
        chosen.selected = true;
        ctx.csBatchAnchorBegin(comp);

        const anchors = [];
        for (let n = 1; n <= 5; n++) {
            anchors.push(ctx.csResolveImportAnchor(comp));
            const inserted = comp.addLayer("Template " + n);
            chosen.selected = false;
            inserted.selected = true;
        }

        expect(anchors).toEqual([chosen, chosen, chosen, chosen, chosen]);
    });

    test("latch for a DIFFERENT comp is ignored: the other comp's own selection wins", () => {
        const ctx = buildAnchorRealm();
        const latched = makeComp();
        const latchedChoice = latched.addLayer("Latched");
        latchedChoice.selected = true;
        ctx.csBatchAnchorBegin(latched);

        const other = makeComp();
        other.addLayer("Top");
        const otherChoice = other.addLayer("Other Selected");
        otherChoice.selected = true;

        const anchor = ctx.csResolveImportAnchor(other);

        expect(anchor).toBe(otherChoice);
        // The foreign comp's selection was not disturbed by the latch.
        expect(other.selectedLayers).toEqual([otherChoice]);
    });

    test("a latch whose anchor went stale yields null without throwing", () => {
        const ctx = buildAnchorRealm();
        const comp = makeComp();
        comp.addLayer("Top");
        const doomed = comp.addLayer("Rolled Back", { selectRejects: false });
        doomed.selected = true;
        ctx.csBatchAnchorBegin(comp);

        // The rollback removed the latched layer; re-selecting a removed
        // reference throws in After Effects, so it must be skipped.
        comp.removeLayer(doomed);
        Object.defineProperty(doomed, "selected", {
            configurable: true,
            get: function () { return false; },
            set: function () { throw new Error("After Effects error: invalid object reference"); },
        });

        let anchor;
        expect(() => { anchor = ctx.csResolveImportAnchor(comp); }).not.toThrow();
        expect(anchor).toBe(null);
        expect(comp.selectedLayers).toEqual([]);
    });

    test("a latch with an EMPTY selection keeps the anchor null for the whole batch", () => {
        const ctx = buildAnchorRealm();
        const comp = makeComp();
        comp.addLayer("Top");
        comp.addLayer("Bottom");

        ctx.csBatchAnchorBegin(comp); // nothing selected
        expect(ctx.__CS_IMPORT_BATCH_ANCHOR.selection).toEqual([]);
        expect(ctx.__CS_IMPORT_BATCH_ANCHOR.anchor).toBe(null);

        // Template 1 selects its insert; the latch must not adopt it.
        const inserted = comp.addLayer("Template 1");
        inserted.selected = true;

        expect(ctx.csResolveImportAnchor(comp)).toBe(null);
        expect(comp.selectedLayers).toEqual([]);
    });

    test("csBatchAnchorEnd restores the pre-action selection and clears the latch", () => {
        const ctx = buildAnchorRealm();
        const comp = makeComp();
        const a = comp.addLayer("A");
        const b = comp.addLayer("B");
        a.selected = true;
        b.selected = true;
        ctx.csBatchAnchorBegin(comp);

        const inserted = comp.addLayer("Template 1");
        a.selected = false;
        b.selected = false;
        inserted.selected = true;

        ctx.csBatchAnchorEnd(comp);

        expect(ctx.__CS_IMPORT_BATCH_ANCHOR).toBe(null);
        expect(comp.selectedLayers.map((l) => l.name).sort()).toEqual(["A", "B"]);
        expect(inserted.selected).toBe(false);
    });

    test("a null comp is tolerated on every entry point", () => {
        const ctx = buildAnchorRealm();
        expect(() => ctx.csBatchAnchorBegin(null)).not.toThrow();
        expect(ctx.__CS_IMPORT_BATCH_ANCHOR).toBe(null);
        expect(ctx.csResolveImportAnchor(null)).toBe(null);
        expect(() => ctx.csBatchAnchorEnd(null)).not.toThrow();
    });
});

// ============================================================
// 11. itemExists  (F7a — Req 2.13, 2.14)
// ============================================================
describe("itemExists (jsx/import.jsx)", () => {
    // Sliced with the pure host utilities it depends on. jsonParse is
    // deliberately EXCLUDED (its body carries braces inside string literals, so
    // a brace walk cannot lift it): the production
    // `typeof jsonParse === "function" ? jsonParse(x) : JSON.parse(x)` guard
    // therefore runs its JSON.parse fallback branch here.
    const HOST_PURE = sliceAll(CORE_SRC, [
        "trimStr", "cleanStr", "getSafeName", "escapeJSON", "jsonStringify",
        "encodeBridge", "decodeBridge", "normalizeSectionName",
    ]);

    function buildDisk(entries) {
        // entries: { "<section>/<cat>/<id>": "<template name>" | null }
        const folders = {};
        const texts = {};
        Object.keys(entries).forEach((key) => {
            const parts = key.split("/");
            const catPath = "C:/lib/" + parts[0] + "/" + parts[1];
            const tplPath = catPath + "/" + parts[2];
            if (!folders[catPath]) folders[catPath] = [];
            folders[catPath].push(parts[2]);
            folders[tplPath] = [];
            const name = entries[key];
            if (name === null) {
                texts[tplPath + "/meta.json"] = "{ this is not json";
            } else if (name !== undefined) {
                texts[tplPath + "/meta.json"] = JSON.stringify({ name: name });
            }
        });
        return { folders: folders, texts: texts };
    }

    function buildItemExistsRealm(disk, opts) {
        opts = opts || {};
        const probes = [];
        const reads = [];

        function FolderFake(p) {
            const key = String(p).replace(/\\/g, "/");
            this.__kind = "folder";
            this.fsName = key;
            this.name = key.split("/").pop();
            probes.push(key);
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () {
                    return Object.prototype.hasOwnProperty.call(disk.folders, key);
                },
            });
            this.getFiles = function () {
                if (opts.getFilesNull) return null;
                const kids = disk.folders[key];
                if (!kids) return null;
                return kids.map(function (k) { return new FolderFake(key + "/" + k); });
            };
        }

        function FileFake(p) {
            const key = String(p).replace(/\\/g, "/");
            this.fsName = key;
            this.name = key.split("/").pop();
            Object.defineProperty(this, "exists", {
                configurable: true,
                get: function () {
                    return Object.prototype.hasOwnProperty.call(disk.texts, key);
                },
            });
        }

        const ctx = buildRealm([HOST_PURE, sliceFn(IMPORT_SRC, "itemExists")].join("\n"), {
            Folder: duckAwareFolder(FolderFake),
            File: FileFake,
            readFileText: function (f) {
                reads.push(f.fsName);
                if (opts.readThrows) throw new Error("read failed: " + f.fsName);
                return disk.texts[f.fsName] || "";
            },
        });

        function ask(name, cat, root, section) {
            const enc = ctx.encodeBridge;
            const args = [enc(name), enc(cat), enc(root)];
            if (section !== undefined) args.push(enc(section));
            const raw = ctx.itemExists.apply(null, args);
            return JSON.parse(ctx.decodeBridge(raw));
        }

        return { ctx: ctx, ask: ask, probes: probes, reads: reads };
    }

    /** `subfolders[i] instanceof Folder` must hold for the fake instances. */
    function duckAwareFolder(Ctor) {
        Object.defineProperty(Ctor, Symbol.hasInstance, {
            configurable: true,
            value: function (o) { try { return !!(o && o.__kind === "folder"); } catch (e) { return false; } },
        });
        return Ctor;
    }

    test("the reply is an encoded {exists, id, section} envelope — never a bare folder name", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My Title": "My Title" }));
        const info = h.ask("My Title", "Titles", "C:/lib", "comp");

        expect(info).toEqual({ exists: true, id: "My Title", section: "comp" });
        expect(typeof info.exists).toBe("boolean");
        expect(typeof info.id).toBe("string");
        expect(typeof info.section).toBe("string");
    });

    test("a hit reports the id of the folder that ACTUALLY exists on disk", () => {
        // The folder id and the display name diverge whenever the name was
        // sanitized. `id` is what the .fav preservation and old-folder removal
        // need, so it must be the folder, not the name.
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My_Title__v2": "My/Title: v2" }));
        const info = h.ask("My/Title: v2", "Titles", "C:/lib", "comp");
        expect(info.exists).toBe(true);
        expect(info.id).toBe("My_Title__v2");
    });

    test("a miss reports exists:false and echoes the searched section", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My Title": "My Title" }));
        const info = h.ask("Not Here", "Titles", "C:/lib", "comp");
        expect(info.exists).toBe(false);
        expect(info.section).toBe("comp");
        expect(info.id).toBeUndefined();
    });

    test("a missing category folder is a clean miss with no enumeration", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My Title": "My Title" }));
        const info = h.ask("My Title", "Ghost Category", "C:/lib", "comp");
        expect(info).toEqual({ exists: false, section: "comp" });
        expect(h.reads).toEqual([]);
    });

    test("an unparseable meta.json is a miss, not a crash and not a false hit", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My Title": null }));
        let info;
        expect(() => { info = h.ask("My Title", "Titles", "C:/lib", "comp"); }).not.toThrow();
        expect(info.exists).toBe(false);
        expect(info.error).toBeUndefined(); // the CHECK itself did not fail
        expect(h.reads).toHaveLength(1);
    });

    test("getFiles() returning null is a clean miss", () => {
        const h = buildItemExistsRealm(
            buildDisk({ "comp/Titles/My Title": "My Title" }),
            { getFilesNull: true }
        );
        const info = h.ask("My Title", "Titles", "C:/lib", "comp");
        expect(info).toEqual({ exists: false, section: "comp" });
    });

    test("a failing read is REPORTED rather than claiming 'no existing template'", () => {
        const h = buildItemExistsRealm(
            buildDisk({ "comp/Titles/My Title": "My Title" }),
            { readThrows: true }
        );
        const info = h.ask("My Title", "Titles", "C:/lib", "comp");
        expect(info.exists).toBe(false);
        expect(typeof info.error).toBe("string");
        expect(info.error).toContain("read failed");
    });

    test("an empty name is a miss and never enumerates", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My Title": "My Title" }));
        const info = h.ask("", "Titles", "C:/lib", "comp");
        expect(info).toEqual({ exists: false, section: "comp" });
        expect(h.probes).toEqual([]);
        expect(h.reads).toEqual([]);
    });

    test.each([
        ["comp", "comp"],
        ["layer", "layer"],
        ["text", "text"],
        ["footage", "footage"],
        ["effect", "effect"],
        ["icon", "icon"],
        ["overlay", "overlay"],
        ["transition", "layer"],       // normalizeSectionName alias
        ["png", "icon"],               // normalizeSectionName alias
        ["image", "icon"],             // normalizeSectionName alias
        ["element", "overlay"],        // normalizeSectionName alias
        ["text_props", "text"],        // normalizeSectionName alias
        ["COMP", "comp"],              // case-insensitive
    ])("section %j searches (and reports) %j", (requested, normalized) => {
        const disk = buildDisk({ [normalized + "/Titles/My Title"]: "My Title" });
        const h = buildItemExistsRealm(disk);
        const info = h.ask("My Title", "Titles", "C:/lib", requested);

        expect(info).toEqual({ exists: true, id: "My Title", section: normalized });
        // Exactly ONE section folder is probed when the section is supplied.
        const catProbes = h.probes.filter((p) => /^C:\/lib\/[a-z_]+\/Titles$/.test(p));
        expect(catProbes).toEqual(["C:/lib/" + normalized + "/Titles"]);
    });

    test("the supplied section is the ONLY one searched — a comp twin is not reported for a layer save", () => {
        const h = buildItemExistsRealm(buildDisk({
            "comp/Titles/My Title": "My Title",
            "layer/Titles/My_Title__layer": "My Title",
        }));
        const info = h.ask("My Title", "Titles", "C:/lib", "layer");
        expect(info).toEqual({ exists: true, id: "My_Title__layer", section: "layer" });
    });

    test("a legacy 3-argument call sweeps every section and reports the one that matched", () => {
        const h = buildItemExistsRealm(buildDisk({ "layer/Titles/My_Title__layer": "My Title" }));
        const info = h.ask("My Title", "Titles", "C:/lib"); // no section argument

        expect(info).toEqual({ exists: true, id: "My_Title__layer", section: "layer" });
        // The four sections the old comp-only default mis-answered come first.
        const catProbes = h.probes.filter((p) => /^C:\/lib\/[a-z_]+\/Titles$/.test(p));
        expect(catProbes[0]).toBe("C:/lib/layer/Titles");
    });

    test("a legacy 3-argument call still finds a comp template, after the four it used to mis-answer", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My Title": "My Title" }));
        const info = h.ask("My Title", "Titles", "C:/lib");

        expect(info).toEqual({ exists: true, id: "My Title", section: "comp" });
        const catProbes = h.probes.filter((p) => /^C:\/lib\/[a-z_]+\/Titles$/.test(p));
        expect(catProbes).toEqual([
            "C:/lib/layer/Titles",
            "C:/lib/text/Titles",
            "C:/lib/footage/Titles",
            "C:/lib/effect/Titles",
            "C:/lib/comp/Titles",
        ]);
    });

    test("a legacy 3-argument miss defaults the reported section to comp", () => {
        const h = buildItemExistsRealm(buildDisk({}));
        const info = h.ask("My Title", "Titles", "C:/lib");
        expect(info).toEqual({ exists: false, section: "comp" });
    });

    test("the stored name is matched case-insensitively", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/Titles/My Title": "MY TITLE" }));
        expect(h.ask("my title", "Titles", "C:/lib", "comp").exists).toBe(true);
    });

    test("the category is sanitized with the canonical rule before it is joined", () => {
        const h = buildItemExistsRealm(buildDisk({ "comp/a_b/My Title": "My Title" }));
        const info = h.ask("My Title", "a/b", "C:/lib", "comp");
        expect(info.exists).toBe(true);
        expect(h.probes[0]).toBe("C:/lib/comp/a_b");
    });
});

// ============================================================
// 12. parseHostBatchResult  (F8e — Req 2.17)
// ============================================================
describe("parseHostBatchResult (js/core/importEngine.js)", () => {
    const { parseHostBatchResult, importTemplates } = importEngine;

    test('{"perTemplate":[],"error":"…"} surfaces the host reason', () => {
        const parsed = parseHostBatchResult('{"perTemplate":[],"error":"Malformed Bridge payload"}');
        expect(parsed.map).toEqual({});
        expect(parsed.error).toBe("Malformed Bridge payload");
    });

    test("an already-parsed envelope is accepted too", () => {
        const parsed = parseHostBatchResult({ perTemplate: [], error: "boom" });
        expect(parsed.map).toEqual({});
        expect(parsed.error).toBe("boom");
    });

    test("a whole-call error alongside reported entries keeps those entries", () => {
        const parsed = parseHostBatchResult(JSON.stringify({
            perTemplate: [{ id: "t1", status: "imported" }],
            error: "batch aborted",
        }));
        expect(parsed.map.t1).toEqual({ id: "t1", status: "imported", reason: undefined });
        expect(parsed.error).toBe("batch aborted");
    });

    test("no error field means no error", () => {
        const parsed = parseHostBatchResult(JSON.stringify({
            perTemplate: [{ id: "t1", status: "imported" }],
        }));
        expect(parsed.error).toBe(null);
    });

    test.each([
        ["", "empty host result"],
        ["not json at all", "unparseable host result"],
    ])("a %j response reports %j", (raw, expected) => {
        expect(parseHostBatchResult(raw).error).toBe(expected);
        expect(parseHostBatchResult(raw).map).toEqual({});
    });

    test("the reason reaches EVERY entry of the requested batch", (done) => {
        const templates = ["t1", "t2", "t3"].map((id) => ({
            id: id, name: id, category: "Cat", section: "comp", sourcePath: "C:/lib",
        }));

        importTemplates(
            {
                callHost: function (payloadHex, cb) {
                    cb('{"perTemplate":[],"error":"Malformed Bridge payload"}');
                },
                decode: function (s) { return s; }, // F8f hands the engine a decoded body
                encode: function (s) { return s; },
                resolveCached: function () { return null; },
            },
            { rootPath: "C:/lib", templates: templates },
            function (res) {
                expect(res.bridgeCalls).toBe(1);
                expect(res.perTemplate.map((e) => e.id)).toEqual(["t1", "t2", "t3"]);
                res.perTemplate.forEach((e) => {
                    expect(e.status).toBe("failed");
                    expect(e.reason).toBe("Malformed Bridge payload");
                });
                done();
            }
        );
    });

    test("cached entries survive a whole-call failure; only the host's share carries the reason", (done) => {
        const templates = ["cached", "t2"].map((id) => ({
            id: id, name: id, category: "Cat", section: "comp", sourcePath: "C:/lib",
        }));

        importTemplates(
            {
                callHost: function (payloadHex, cb) {
                    cb('{"perTemplate":[],"error":"host said no"}');
                },
                decode: function (s) { return s; },
                encode: function (s) { return s; },
                resolveCached: function (t) {
                    return t.id === "cached" ? { status: "imported" } : null;
                },
            },
            { rootPath: "C:/lib", templates: templates },
            function (res) {
                expect(res.perTemplate).toHaveLength(2);
                expect(res.perTemplate[0]).toEqual({ id: "cached", status: "imported", reason: undefined });
                expect(res.perTemplate[1].status).toBe("failed");
                expect(res.perTemplate[1].reason).toBe("host said no");
                done();
            }
        );
    });
});
