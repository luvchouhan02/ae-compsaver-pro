// ============================================================
// tests/bridge-decode-agreement.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.5)
//
// Property 8 — Transport Decode Agreement And Round-Trip Fidelity.
//
//   For ANY string, decodeBridge(encodeBridge(s)) === s on BOTH sides; and for
//   ANY hex payload, decodeBridgeStrict returns the same `ok` flag and the same
//   `value` in the panel and the host, reporting ok:false exactly when the
//   payload's length is not a multiple of four or it contains a non-hex
//   character.
//
// The pre-fix defect this generalizes: the panel emitted U+0000 for a bad chunk
// (String.fromCharCode(NaN)) while the host silently skipped it, so ONE corrupt
// transfer decoded into TWO different strings and neither side reported it. The
// "exactly when" clause is what makes the failure detectable rather than silent.
//
// typeof-guard branches exercised
// ------------------------------
// jsx/core.jsx `decodeBridge` is `typeof decodeBridgeStrict === "function"
// ? decodeBridgeStrict(hex).value : <inline repeat of the same validation and
// loop>`. BOTH branches are exercised and asserted equal:
//   PRIMARY  — the whole-file host realm (loadHelpers) has decodeBridgeStrict in
//              scope, so the guard is true.
//   FALLBACK — the sliced realm built from CORE_PURE deliberately OMITS
//              decodeBridgeStrict (the brace-walk name list the baseline suites
//              use), so the inline branch runs. Proving the two agree is what
//              stops the fallback from becoming a third decoder.
//
// **Validates: Requirements 2.15, 3.6, 3.7**
// ============================================================
"use strict";

const fc = require("fast-check");
const panelBridge = require("../js/core/bridge.js");
const H = require("./helpers/compPipelineHarness");

// ── Panel side ──────────────────────────────────────────────────────────────
const panelEncode = panelBridge.encodeBridge;
const panelDecode = panelBridge.decodeBridge;
const panelStrict = panelBridge.decodeBridgeStrict;
const panelWellFormed = panelBridge.isWellFormedBridgeHex;

// ── Host side, PRIMARY branch (whole file, decodeBridgeStrict in scope) ─────
const hostCore = H.loadHostCore();
const hostEncode = hostCore.get("encodeBridge");
const hostDecode = hostCore.get("decodeBridge");
const hostStrict = hostCore.get("decodeBridgeStrict");
const hostWellFormed = hostCore.get("isWellFormedBridgeHex");

// ── Host side, FALLBACK branch (sliced, decodeBridgeStrict absent) ──────────
const slicedHost = H.buildRealm(H.CORE_PURE, {});

// ─────────────────────────────────────────────────────────────
// String generators
// ─────────────────────────────────────────────────────────────
// Every BMP code unit, so control characters, quotes, backslashes and LONE
// surrogates (0xD800-0xDFFF on their own) all occur.
const arbBmpString = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { minLength: 0, maxLength: 160 })
    .map((codes) => codes.map((c) => String.fromCharCode(c)).join(""));

// Curated real-world text: CJK, accents, emoji (full surrogate PAIRS), RTL,
// and the JSON payload shapes that actually cross the Bridge.
const arbRealWorldString = fc
    .array(
        fc.constantFrom(
            "Lower Third 01", "\u65e5\u672c\u8a9e\u30c6\u30f3\u30d7\u30ec",
            "caf\u00e9 cr\u00e8me", "\ud83d\ude00\ud83c\udf89", "\u0645\u0631\u062d\u0628\u0627",
            '{"ok":true,"name":"A"}', "C:/lib/comp/Titles/My Title",
            "\r\n", "\t", '"', "\\", "\u0000", " ", ""
        ),
        { minLength: 0, maxLength: 24 }
    )
    .map((parts) => parts.join(""));

const arbString = fc.oneof(arbBmpString, arbRealWorldString);

// ─────────────────────────────────────────────────────────────
// Payload generators — well-formed, malformed and adversarial
// ─────────────────────────────────────────────────────────────
const HEX_DIGITS = "0123456789abcdefABCDEF";
const arbHexRun = fc
    .array(fc.integer({ min: 0, max: HEX_DIGITS.length - 1 }), { minLength: 0, maxLength: 40 })
    .map((idx) => idx.map((i) => HEX_DIGITS[i]).join(""));

// A payload that is a MULTIPLE OF FOUR yet corrupt: exactly the case a
// length-only check would wave through.
const arbCorruptAlignedPayload = fc
    .tuple(
        arbHexRun.filter((s) => s.length % 4 === 0),
        // Every alternative is exactly FOUR characters, so the concatenation
        // stays aligned and only the hex-digit clause is violated.
        fc.constantFrom("ZZZZ", "GHIJ", "    ", "%%%%", "0x0x", "\u00e9000", "00-0", "0.00")
    )
    .map(([head, bad]) => head + bad);

const arbTruncatedPayload = fc
    .tuple(arbHexRun, fc.constantFrom("0", "00", "000"))
    .map(([head, tail]) => head + tail)
    .filter((s) => s.length % 4 !== 0);

const arbEncodedPayload = arbString.map((s) => panelEncode(s));

const arbPayload = fc.oneof(
    arbEncodedPayload,
    arbHexRun,
    arbCorruptAlignedPayload,
    arbTruncatedPayload,
    fc.constantFrom(
        "", "0", "00", "000", "0000",
        "0048006",              // length % 4 === 3
        "00480065ZZZZ00",       // 14 chars, one non-hex chunk
        "FFFF", "ffff", "FfFf",
        "d800", "dc00", "d800dc00",
        "  ", "0 00", "-1", "NaN", "undefined"
    )
);

// ============================================================
// Round trip
// ============================================================
describe("Property 8 — round-trip fidelity on both implementations", () => {
    test("decodeBridge(encodeBridge(s)) === s for every generated string, on both sides", () => {
        fc.assert(
            fc.property(arbString, (s) => {
                const panelHex = panelEncode(s);
                const hostHex = hostEncode(s);
                // One encoder, byte-identical output.
                expect(hostHex).toBe(panelHex);
                expect(panelDecode(panelHex)).toBe(s);
                expect(hostDecode(hostHex)).toBe(s);
                // ...and cross-decoded, which is what the Bridge actually does.
                expect(hostDecode(panelHex)).toBe(s);
                expect(panelDecode(hostHex)).toBe(s);
                // The FALLBACK branch decodes it identically.
                expect(slicedHost.encodeBridge(s)).toBe(panelHex);
                expect(slicedHost.decodeBridge(panelHex)).toBe(s);
            }),
            { numRuns: 800 }
        );
    });

    test("the encoding is exactly four hex digits per UTF-16 code unit", () => {
        fc.assert(
            fc.property(arbString, (s) => {
                const hex = panelEncode(s);
                expect(hex.length).toBe(s.length * 4);
                expect(/^[0-9a-f]*$/.test(hex)).toBe(true);
            }),
            { numRuns: 500 }
        );
    });

    test("a >= 1 MB payload round-trips on both sides", () => {
        const chunk = "Lower Third 01 \u65e5\u672c\u8a9e \ud83d\ude00 \"\\\r\n";
        let big = "";
        while (big.length < 1024 * 1024) big += chunk;
        const hex = panelEncode(big);
        expect(hex.length).toBe(big.length * 4);
        expect(panelDecode(hex)).toBe(big);
        expect(hostDecode(hex)).toBe(big);
        expect(slicedHost.decodeBridge(hex)).toBe(big);
    });

    test("neither encoder nor decoder uses the measured-slower join() form (3.29)", () => {
        const encodeSrc = H.sliceFn(H.CORE_SRC, "encodeBridge");
        const decodeSrc = H.sliceFn(H.CORE_SRC, "decodeBridge");
        const strictSrc = H.sliceFn(H.CORE_SRC, "decodeBridgeStrict");
        [encodeSrc, decodeSrc, strictSrc].forEach((src) => {
            expect(/\.join\s*\(/.test(src)).toBe(false);
        });
    });
});

// ============================================================
// Strict decode agreement
// ============================================================
describe("Property 8 — decodeBridgeStrict agrees on ok AND on value", () => {
    test("the panel and the host return the same { ok, value } for every generated payload", () => {
        fc.assert(
            fc.property(arbPayload, (p) => {
                const a = panelStrict(p);
                const b = hostStrict(p);
                expect(b.ok).toBe(a.ok);
                expect(b.value).toBe(a.value);
                if (!a.ok) {
                    // Both name the same reason, including the observed length.
                    expect(typeof a.error).toBe("string");
                    expect(b.error).toBe(a.error);
                    expect(a.value).toBe("");
                }
            }),
            { numRuns: 2000 }
        );
    });

    test("ok:false EXACTLY when the length is not a multiple of four or a non-hex character is present", () => {
        fc.assert(
            fc.property(arbPayload, (p) => {
                const malformed = p.length % 4 !== 0 || !/^[0-9a-fA-F]*$/.test(p);
                expect(panelStrict(p).ok).toBe(!malformed);
                expect(hostStrict(p).ok).toBe(!malformed);
                expect(panelWellFormed(p)).toBe(!malformed);
                expect(hostWellFormed(p)).toBe(!malformed);
            }),
            { numRuns: 2000 }
        );
    });

    test("the back-compatible wrapper yields \"\" for a malformed payload on BOTH branches", () => {
        fc.assert(
            fc.property(arbPayload, (p) => {
                const strict = panelStrict(p);
                expect(panelDecode(p)).toBe(strict.value);
                // PRIMARY host branch (decodeBridgeStrict in scope).
                expect(hostDecode(p)).toBe(strict.value);
                // FALLBACK host branch (sliced realm, sibling absent) — the inline
                // repeat of the validation and the loop must not diverge.
                expect(slicedHost.decodeBridge(p)).toBe(strict.value);
                if (!strict.ok) expect(panelDecode(p)).toBe("");
            }),
            { numRuns: 2000 }
        );
    });

    test("a payload that is a multiple of four AND corrupt is reported, not decoded", () => {
        fc.assert(
            fc.property(arbCorruptAlignedPayload, (p) => {
                expect(p.length % 4).toBe(0);
                const a = panelStrict(p);
                const b = hostStrict(p);
                expect(a.ok).toBe(false);
                expect(b.ok).toBe(false);
                expect(a.value).toBe("");
                expect(b.value).toBe("");
                // Never a U+0000 stand-in for the bad chunk, on either side.
                expect(panelDecode(p).indexOf("\u0000")).toBe(-1);
                expect(hostDecode(p).indexOf("\u0000")).toBe(-1);
            }),
            { numRuns: 800 }
        );
    });

    test("the empty payload is a SUCCESSFUL empty decode, not a malformed one", () => {
        [null, undefined, ""].forEach((p) => {
            expect(panelStrict(p).ok).toBe(true);
            expect(panelStrict(p).value).toBe("");
            expect(hostStrict(p).ok).toBe(true);
            expect(hostStrict(p).value).toBe("");
        });
    });

    test("the design's named counterexamples now agree and report", () => {
        ["0048006", "00480065ZZZZ00"].forEach((p) => {
            const a = panelStrict(p);
            const b = hostStrict(p);
            expect(a.ok).toBe(false);
            expect(b.ok).toBe(false);
            expect(panelDecode(p)).toBe(hostDecode(p));
            expect(panelDecode(p)).toBe("");
            expect(slicedHost.decodeBridge(p)).toBe("");
        });
    });
});
