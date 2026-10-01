// ============================================================
// tests/host-json-validity.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.6)
//
// Property 9 — Serialization Always Parses.
//
//   For ANY object containing arbitrary strings — including every control
//   character, quotes, backslashes, newlines and surrogate pairs —
//   JSON.parse(jsonStringify(obj)) SHALL succeed and SHALL reproduce those
//   strings, except that a lone \r SHALL survive as \r rather than being
//   deleted.
//
// The pre-fix defect: escapeJSON passed C0 controls through RAW and DELETED \r
// outright. jsonStringify routes every string AND every key through escapeJSON,
// so a save that fully succeeded could be reported to the user as
// "JSON Parse Error" — the panel's own parseEssential branch at
// js/templates/templates.js. The `\r` clause matters because "a\r\nb" is what a
// multi-line marker comment or a Windows-authored expression actually contains.
//
// typeof-guard branches exercised
// ------------------------------
// None: `jsonStringify` and `escapeJSON` are self-contained by construction (the
// comment above each in jsx/core.jsx records that the brace-walk harnesses lift
// them out of the file, so neither may reference a new sibling or a module-level
// constant). Both are therefore asserted in BOTH realms and the results compared:
//   whole-file host realm (loadHelpers) and sliced host realm (CORE_PURE).
// The `jsonParse` guard is not reached — the panel's native JSON.parse is the
// consumer under test, which is exactly the production shape.
//
// **Validates: Requirement 2.16**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

const vm = require("vm");

const hostCore = H.loadHostCore();
const hostStringify = hostCore.get("jsonStringify");
const hostEscape = hostCore.get("escapeJSON");

const slicedHost = H.buildRealm(H.CORE_PURE, {});

// ─────────────────────────────────────────────────────────────
// HARNESS NOTE — cross-realm arrays
//
// jsonStringify branches on `obj instanceof Array`. A jest-side array is NOT an
// instance of the vm realm's Array, so handing one straight in serializes it as
// an object — a pure artefact of running ExtendScript source inside a second
// realm, not a production behavior (the AE host has exactly one realm). Any
// value that contains an array is therefore rebuilt INSIDE the target realm
// first, which is also what production does: every object jsonStringify sees was
// constructed by host code.
// ─────────────────────────────────────────────────────────────
function intoRealm(ctx, value) {
    const parse = vm.runInContext("(function (t) { return JSON.parse(t); })", ctx);
    return parse(JSON.stringify(value));
}
const intoHost = (v) => intoRealm(hostCore.context, v);

// ─────────────────────────────────────────────────────────────
// String generators
// ─────────────────────────────────────────────────────────────
// Every C0 control character plus DEL, individually reachable.
const ALL_CONTROLS = [];
for (let c = 0; c <= 0x1f; c++) ALL_CONTROLS.push(String.fromCharCode(c));
ALL_CONTROLS.push("\u007f");

const JSON_HAZARDS = [
    '"', "\\", "\\\\", '\\"', "/", "\u0000", "\u0008", "\u000c",
    "\n", "\r", "\r\n", "\n\r", "\t", "\u001f", "\u007f",
    "\u2028", "\u2029",                     // JS line terminators, legal in JSON
    "\ud83d\ude00", "\ud83c\udf89",         // full surrogate PAIRS
    "\u65e5\u672c\u8a9e", "caf\u00e9",
    "{", "}", "[", "]", ":", ",",
    "already \\u0041 escaped",
];

const arbHazardString = fc
    .array(fc.constantFrom.apply(null, JSON_HAZARDS.concat(ALL_CONTROLS, ["a", "B", "1", " "])),
        { minLength: 0, maxLength: 30 })
    .map((parts) => parts.join(""));

// Every BMP code unit, so nothing in the escape table is unreachable.
const arbBmpString = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { minLength: 0, maxLength: 60 })
    .map((codes) => codes.map((c) => String.fromCharCode(c)).join(""));

const arbString = fc.oneof(arbHazardString, arbBmpString, fc.string({ maxLength: 40 }));

// Objects with arbitrary string KEYS as well as values: jsonStringify routes both
// through escapeJSON, so a control character in a key breaks the document too.
// "__proto__" is excluded because assigning it is a JS-object-model quirk, not a
// serialization behavior.
const arbKey = arbString.filter((k) => k !== "__proto__");
const arbFlatObject = fc.dictionary(arbKey, arbString, { maxKeys: 8 });

// A realistic host result: the shape saveActiveComp / coreSaveLayerType return,
// with the generated strings in the places a user's text actually lands.
const arbHostResult = fc.record({
    ok: fc.constant(true),
    templateId: arbString,
    name: arbString,
    category: arbString,
    section: fc.constantFrom("comp", "layer", "text", "footage"),
    type: fc.constantFrom("comp", "layer", "text", "footage"),
    folderPath: arbString,
    renderComp: arbString,
    renderFrame: fc.integer({ min: 0, max: 100000 }),
    width: fc.integer({ min: 1, max: 7680 }),
    height: fc.integer({ min: 1, max: 4320 }),
    pixelAspect: fc.constantFrom(1, 0.9, 1.5),
    frameRate: fc.constantFrom(0, 25, 29.97, 30),
    duration: fc.constantFrom(0, 5, 3600),
    needsThumbnail: fc.boolean(),
    oldId: arbString,
    assetsList: fc.array(fc.record({ fsPath: arbString, name: arbString }), { maxLength: 4 }),
});

// ============================================================
describe("Property 9 — host JSON always parses and round-trips", () => {
    test("JSON.parse(jsonStringify(obj)) succeeds and reproduces every string value", () => {
        fc.assert(
            fc.property(arbFlatObject, (obj) => {
                const doc = hostStringify(obj);
                let parsed;
                expect(() => { parsed = JSON.parse(doc); }).not.toThrow();
                Object.keys(obj).forEach((k) => {
                    expect(parsed[k]).toBe(obj[k]);
                });
                expect(Object.keys(parsed).sort()).toEqual(Object.keys(obj).sort());
            }),
            { numRuns: 1500 }
        );
    });

    test("a lone \\r survives as \\r rather than being deleted", () => {
        fc.assert(
            fc.property(arbString, (s) => {
                const withCr = "a\r" + s + "\r\nb";
                const parsed = JSON.parse(hostStringify({ e: withCr }));
                expect(parsed.e).toBe(withCr);
                expect(parsed.e.indexOf("\r")).toBe(0 + 1);
                expect((parsed.e.match(/\r/g) || []).length)
                    .toBe((withCr.match(/\r/g) || []).length);
            }),
            { numRuns: 800 }
        );
    });

    test("every C0 control character and DEL survives the round trip", () => {
        ALL_CONTROLS.forEach((ch) => {
            const value = "a" + ch + "b";
            const doc = hostStringify({ e: value });
            let parsed;
            expect(() => { parsed = JSON.parse(doc); }).not.toThrow();
            expect(parsed.e).toBe(value);
            // ...and as a KEY, not just a value.
            const keyed = {};
            keyed[value] = 1;
            expect(JSON.parse(hostStringify(keyed))[value]).toBe(1);
        });
    });

    test("a realistic host result document always parses and reproduces its strings", () => {
        fc.assert(
            fc.property(arbHostResult, (res) => {
                const doc = hostStringify(intoHost(res));
                let parsed;
                expect(() => { parsed = JSON.parse(doc); }).not.toThrow();
                expect(parsed.ok).toBe(true);
                ["templateId", "name", "category", "folderPath", "renderComp", "oldId"]
                    .forEach((k) => expect(parsed[k]).toBe(res[k]));
                expect(parsed.renderFrame).toBe(res.renderFrame);
                expect(parsed.assetsList.length).toBe(res.assetsList.length);
                res.assetsList.forEach((a, i) => {
                    expect(parsed.assetsList[i].fsPath).toBe(a.fsPath);
                    expect(parsed.assetsList[i].name).toBe(a.name);
                });
            }),
            { numRuns: 800 }
        );
    });

    test("nested objects and arrays of hostile strings parse and round-trip", () => {
        fc.assert(
            fc.property(
                fc.record({
                    layerState: fc.record({
                        switches: fc.dictionary(arbKey, fc.boolean(), { maxKeys: 5 }),
                        markers: fc.array(fc.record({ time: fc.double({ min: 0, max: 100, noNaN: true }), comment: arbString }), { maxLength: 4 }),
                    }),
                    effectNames: fc.array(arbString, { maxLength: 5 }),
                }),
                (obj) => {
                    const parsed = JSON.parse(hostStringify(intoHost(obj)));
                    expect(parsed.effectNames).toEqual(obj.effectNames);
                    obj.layerState.markers.forEach((m, i) => {
                        expect(parsed.layerState.markers[i].comment).toBe(m.comment);
                    });
                    Object.keys(obj.layerState.switches).forEach((k) => {
                        expect(parsed.layerState.switches[k]).toBe(obj.layerState.switches[k]);
                    });
                }
            ),
            { numRuns: 600 }
        );
    });
});

// ============================================================
// escapeJSON, on its own
// ============================================================
describe("Property 9 — escapeJSON emits a legal JSON string body", () => {
    test("wrapping the output in quotes always yields a parseable JSON string", () => {
        fc.assert(
            fc.property(arbString, (s) => {
                const body = hostEscape(s);
                let parsed;
                expect(() => { parsed = JSON.parse('"' + body + '"'); }).not.toThrow();
                expect(parsed).toBe(s);
            }),
            { numRuns: 2000 }
        );
    });

    test("a control-free string takes the fast path and is byte-identical apart from the mandatory escapes", () => {
        fc.assert(
            // eslint-disable-next-line no-control-regex
            fc.property(arbString.filter((s) => !/[\u0000-\u001f\u007f\\"]/.test(s)), (s) => {
                expect(hostEscape(s)).toBe(s);
            }),
            { numRuns: 1000 }
        );
    });

    test("the sliced realm and the whole-file realm produce identical documents", () => {
        fc.assert(
            fc.property(arbFlatObject, arbString, (obj, s) => {
                expect(slicedHost.jsonStringify(obj)).toBe(hostStringify(obj));
                expect(slicedHost.escapeJSON(s)).toBe(hostEscape(s));
            }),
            { numRuns: 1000 }
        );
    });

    test("the design's named counterexamples now parse", () => {
        // 1.16, first half: a raw C0 control produced an invalid document.
        const ctrlDoc = hostStringify({ e: "a\u0001b" });
        expect(() => JSON.parse(ctrlDoc)).not.toThrow();
        expect(JSON.parse(ctrlDoc).e).toBe("a\u0001b");
        // 1.16, second half: "a\r\nb" lost its \r.
        expect(JSON.parse(hostStringify({ e: "a\r\nb" })).e).toBe("a\r\nb");
    });

    test("null, undefined and non-object inputs keep their documented shapes", () => {
        expect(hostStringify(null)).toBe("null");
        expect(hostStringify(undefined)).toBe("null");
        expect(hostEscape(null)).toBe("");
        expect(hostEscape(undefined)).toBe("");
        expect(hostStringify(true)).toBe("true");
        expect(hostStringify(false)).toBe("false");
        expect(hostStringify(42)).toBe("42");
        expect(JSON.parse(hostStringify(intoHost([1, "a\u0001b", null]))))
            .toEqual([1, "a\u0001b", null]);
    });
});
