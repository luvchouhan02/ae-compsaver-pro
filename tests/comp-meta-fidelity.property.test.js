// ============================================================
// tests/comp-meta-fidelity.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.13)
//
// Property 1 — metadata slice: "meta.json carries the composition's format".
//
//   For ANY host result object, the written meta.json carries width, height, dim,
//   pixelAspect, frameRate, duration, mainFile, schemaVersion, section and type,
//   and assetsDir whenever assets were copied.
//
// The pre-fix defects this generalizes:
//   1.9   the host result carried no width/height/pixelAspect/frameRate/duration,
//         so the panel had nothing to write and `dim` — the field
//         parseMetaContent has always READ — was written by nobody.
//   1.10  the host result carried no `section`/`type`, and the panel gated
//         assetsDir on `resObj.section === "comp"`, a field the host never sent,
//         so assetsDir was silently dropped from every comp save.
//
// How the panel's construction is exercised
// -----------------------------------------
// The meta.json document is built inline inside `scheduleBackground` in
// js/templates/templates.js — a deeply nested closure inside a function that
// needs the DOM, CSInterface and Node's fs. Rather than reimplement it (which
// would test the test), the REAL source region is sliced verbatim, from
// `var now = new Date().toISOString();` up to but excluding
// `await fs.promises.writeFile(folderPath + "/meta.json"`, and evaluated in a
// `vm` with its only free variables bound: resObj, templateId and assetsList.
// The write itself is modeled as JSON.parse(JSON.stringify(metaObj, null, 4)),
// which is exactly what production hands to fs.promises.writeFile — so a field
// that is `undefined` is dropped by JSON.stringify here for the same reason it is
// dropped on disk.
//
// typeof-guard branches exercised
// ------------------------------
// None. This region is plain panel JavaScript with no cross-file guard; its only
// conditionals are the documented value validations (`typeof resObj.width ===
// "number" && resObj.width > 0`, `metaObj.section === "comp"`, and the per-type
// blocks), all of which are exercised by the generators below — including the
// LEGACY host result that omits every format field, which must still produce
// exactly the previous document.
//
// **Validates: Requirements 2.9, 2.10**
// ============================================================
"use strict";

const fc = require("fast-check");
const vm = require("vm");
const H = require("./helpers/compPipelineHarness");

// ─────────────────────────────────────────────────────────────
// The real construction region, sliced verbatim
// ─────────────────────────────────────────────────────────────
const META_REGION = H.sliceRegion(
    H.TEMPLATES_JS,
    "var now = new Date().toISOString();",
    'await fs.promises.writeFile(folderPath + "/meta.json"'
);

// Sanity: the slice really is the construction, and really is self-contained.
const REQUIRED_MARKERS = [
    "var metaObj = {",
    "schemaVersion: 2",
    "mainFile:",
    "dim:",
    'if (metaObj.section === "comp")',
    "metaObj.assetsDir",
];

/**
 * Run the sliced region with `resObj`, `templateId` and `assetsList` bound, then
 * model the write the way production performs it.
 */
function buildMeta(resObj, templateId, assetsList) {
    const ctx = vm.createContext({ resObj: resObj, templateId: templateId, assetsList: assetsList });
    vm.runInContext(META_REGION + "\nthis.__metaObj = metaObj;", ctx, { filename: "templates.js#metaObj" });
    return JSON.parse(JSON.stringify(ctx.__metaObj, null, 4));
}

// ─────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────
const arbName = fc.constantFrom("My Title", "Lower Third 01", "a-b_c", "\u65e5\u672c\u8a9e", "");
const arbCategory = fc.constantFrom("Titles", "Lower-Thirds", "x", "");
const arbSection = fc.constantFrom("comp", "layer", "text", "footage", "effect", "icon", "overlay");

// The format values a live composition can actually carry, INCLUDING the
// degenerate ones the panel's validation must reject rather than write:
// frameRate 0 (a still), duration 0, and a negative/NaN leak from a failed read.
const arbFormat = fc.record({
    width: fc.oneof(fc.integer({ min: 1, max: 7680 }), fc.constantFrom(0, -1, NaN)),
    height: fc.oneof(fc.integer({ min: 1, max: 4320 }), fc.constantFrom(0, -1, NaN)),
    pixelAspect: fc.constantFrom(1, 0.9, 1.5, 2, 0, -1),
    frameRate: fc.constantFrom(0, 1, 23.976, 25, 29.97, 30, 120, -1),
    duration: fc.constantFrom(0, 0.04, 5, 3600, -1),
});

const arbAssetsList = fc.array(
    fc.record({ fsPath: fc.constantFrom("C:/a/clip.mp4", "C:/a/logo.png"), name: fc.constantFrom("clip.mp4", "logo.png") }),
    { minLength: 0, maxLength: 4 }
);

/** A comp save's host result, the shape F1 now returns. */
const arbCompResult = fc
    .tuple(arbName, arbCategory, arbFormat, fc.boolean())
    .map(function (t) {
        const name = t[0], cat = t[1], fmt = t[2], withSection = t[3];
        const res = {
            ok: true, templateId: name, name: name, category: cat,
            folderPath: "C:/lib/comp/Titles/" + name,
            oldId: "", needsThumbnail: true,
            width: fmt.width, height: fmt.height, pixelAspect: fmt.pixelAspect,
            frameRate: fmt.frameRate, duration: fmt.duration,
            renderComp: name, renderFrame: 50,
        };
        // 2.10: the panel must record assetsDir even when the host omitted
        // `section`, because it keys off the SAME normalized value it writes.
        if (withSection) { res.section = "comp"; res.type = "comp"; }
        return res;
    });

/** A layer-family host result, the shape F2 now returns. */
const arbLayerResult = fc
    .tuple(arbName, arbCategory, arbFormat, fc.constantFrom("layer", "text", "footage", "effect"))
    .map(function (t) {
        const name = t[0], cat = t[1], fmt = t[2], kind = t[3];
        return {
            ok: true, templateId: name, name: name, category: cat,
            section: kind, type: kind,
            folderPath: "C:/lib/" + kind + "/Titles/" + name,
            oldId: "", needsThumbnail: true,
            width: fmt.width, height: fmt.height, pixelAspect: fmt.pixelAspect,
            frameRate: fmt.frameRate, duration: fmt.duration,
            renderComp: name, renderFrame: 12,
            layerCount: 2, isAdjustment: false, is3D: false, blendMode: 1, label: 0,
            layerState: { switches: { enabled: true }, markers: [] },
            effectCount: 1, effectNames: "Glow", saveMode: "selected",
        };
    });

const arbTemplateId = fc.constantFrom("My Title", "a-b_c", "x");

/** The panel's own validation rule, re-derived independently. */
function validPositive(v) { return typeof v === "number" && v > 0 ? v : undefined; }
function validNonNegative(v) { return typeof v === "number" && v >= 0 ? v : undefined; }

// ============================================================
describe("Property 1 (metadata) — the sliced region is the production construction", () => {
    test("the slice contains the whole metaObj construction and the assetsDir gate", () => {
        REQUIRED_MARKERS.forEach(function (marker) {
            expect(META_REGION).toContain(marker);
        });
        // Self-contained: no fs, no await, no DOM and no CSInterface in the CODE
        // (the region's prose comments mention some of those words, so the check
        // runs on the comment-stripped source).
        const code = META_REGION.replace(/\/\/[^\n]*/g, "");
        expect(code).not.toMatch(/\bfs\s*\./);
        expect(code).not.toMatch(/\bawait\b/);
        expect(code).not.toMatch(/\bdocument\s*\./);
        expect(code).not.toMatch(/csInterface/i);
        expect(code).not.toMatch(/\brequire\s*\(/);
        // ...and its only free variables are the three the harness binds.
        expect(code).toContain("resObj.");
        expect(code).toContain("templateId");
        expect(code).toContain("assetsList.length");
    });
});

describe("Property 1 (metadata) — every required key is present", () => {
    test("a comp save records schemaVersion, id, name, section, type, category, mainFile and thumbnail", () => {
        fc.assert(
            fc.property(arbCompResult, arbTemplateId, arbAssetsList, (res, templateId, assets) => {
                const meta = buildMeta(res, templateId, assets);
                expect(meta.schemaVersion).toBe(2);
                expect(meta.id).toBe(templateId);
                expect(meta.name).toBe(res.name);
                expect(meta.category).toBe(res.category);
                expect(meta.mainFile).toBe("project.aep");
                expect(meta.thumbnail).toBe("thumbnail.png");
                // 2.10: `section` and `type` default to "comp", so a host result
                // that omits them still produces the comp document.
                expect(meta.section).toBe("comp");
                expect(meta.type).toBe("comp");
                expect(meta.hasFrames).toBe(false);
                expect(meta.frameCount).toBe(0);
                expect(typeof meta.createdAt).toBe("string");
                expect(typeof meta.updatedAt).toBe("string");
                expect(Number.isNaN(Date.parse(meta.createdAt))).toBe(false);
            }),
            { numRuns: 600 }
        );
    });

    test("a usable format is recorded, and `dim` is written whenever width AND height are", () => {
        fc.assert(
            fc.property(arbCompResult, arbTemplateId, arbAssetsList, (res, templateId, assets) => {
                const meta = buildMeta(res, templateId, assets);
                const w = validPositive(res.width);
                const h = validPositive(res.height);

                expect(meta.width).toBe(w);
                expect(meta.height).toBe(h);
                expect(meta.pixelAspect).toBe(validPositive(res.pixelAspect));
                expect(meta.frameRate).toBe(validPositive(res.frameRate));
                expect(meta.duration).toBe(validNonNegative(res.duration));

                // 2.9: `dim` is the string field parseMetaContent has always read
                // and nothing wrote.
                if (w !== undefined && h !== undefined) {
                    expect(meta.dim).toBe(w + "x" + h);
                } else {
                    expect("dim" in meta).toBe(false);
                }
                // A degenerate value is OMITTED, never written as 0 / -1 / NaN.
                Object.keys(meta).forEach(function (k) {
                    if (typeof meta[k] === "number") {
                        expect(Number.isNaN(meta[k])).toBe(false);
                    }
                });
            }),
            { numRuns: 800 }
        );
    });

    test("a real 1920x1080 comp writes the full format block", () => {
        const res = {
            ok: true, templateId: "My Title", name: "My Title", category: "Titles",
            section: "comp", type: "comp", folderPath: "C:/lib/comp/Titles/My Title",
            width: 1920, height: 1080, pixelAspect: 1, frameRate: 25, duration: 10,
            renderComp: "My Title", renderFrame: 75, needsThumbnail: true, oldId: "",
        };
        const meta = buildMeta(res, "My Title", [{ fsPath: "C:/a/clip.mp4", name: "clip.mp4" }]);
        expect(meta).toMatchObject({
            schemaVersion: 2,
            id: "My Title",
            name: "My Title",
            section: "comp",
            type: "comp",
            category: "Titles",
            mainFile: "project.aep",
            thumbnail: "thumbnail.png",
            width: 1920,
            height: 1080,
            dim: "1920x1080",
            pixelAspect: 1,
            frameRate: 25,
            duration: 10,
            assetsDir: "assets/",
        });
    });
});

describe("Property 1 (metadata) — assetsDir tracks whether assets were copied", () => {
    test("a comp save records assetsDir: \"assets/\" when assets were copied, \"\" when none were", () => {
        fc.assert(
            fc.property(arbCompResult, arbTemplateId, arbAssetsList, (res, templateId, assets) => {
                const meta = buildMeta(res, templateId, assets);
                expect("assetsDir" in meta).toBe(true);
                expect(meta.assetsDir).toBe(assets.length > 0 ? "assets/" : "");
            }),
            { numRuns: 600 }
        );
    });

    test("the gate keys off the SAME normalized section the document records", () => {
        fc.assert(
            fc.property(arbSection, arbTemplateId, arbAssetsList, fc.boolean(),
                (section, templateId, assets, omitSection) => {
                    const res = {
                        ok: true, name: "n", category: "c",
                        folderPath: "C:/lib/x", oldId: "",
                        width: 1920, height: 1080, pixelAspect: 1, frameRate: 25, duration: 5,
                    };
                    if (!omitSection) res.section = section;
                    res.type = section;

                    const meta = buildMeta(res, templateId, assets);
                    // An omitted section normalizes to "comp", and the gate uses
                    // that normalized value — not the raw resObj field.
                    const effective = omitSection ? "comp" : section;
                    expect(meta.section).toBe(effective);
                    expect("assetsDir" in meta).toBe(effective === "comp");
                    if (effective === "comp") {
                        expect(meta.assetsDir).toBe(assets.length > 0 ? "assets/" : "");
                    }
                }),
            { numRuns: 600 }
        );
    });

    test("a non-comp section records no assetsDir", () => {
        fc.assert(
            fc.property(arbLayerResult, arbTemplateId, arbAssetsList, (res, templateId, assets) => {
                fc.pre(res.section !== "comp");
                const meta = buildMeta(res, templateId, assets);
                expect("assetsDir" in meta).toBe(false);
            }),
            { numRuns: 400 }
        );
    });
});

describe("Property 1 (metadata) — the layer family keeps its own fields AND gains the format", () => {
    test("a layer save records layerState plus the format block", () => {
        fc.assert(
            fc.property(arbLayerResult, arbTemplateId, arbAssetsList, (res, templateId, assets) => {
                fc.pre(res.type === "layer");
                const meta = buildMeta(res, templateId, assets);
                expect(meta.section).toBe("layer");
                expect(meta.type).toBe("layer");
                expect(meta.layerCount).toBe(2);
                expect(meta.isAdjustment).toBe(false);
                expect(meta.is3D).toBe(false);
                expect(meta.blendMode).toBe(1);
                expect(meta.label).toBe(0);
                expect(meta.layerState).toEqual({ switches: { enabled: true }, markers: [] });
                // ...and the format the pre-window capture supplied.
                expect(meta.width).toBe(validPositive(res.width));
                expect(meta.height).toBe(validPositive(res.height));
                expect(meta.frameRate).toBe(validPositive(res.frameRate));
                expect(meta.mainFile).toBe("project.aep");
                expect(meta.schemaVersion).toBe(2);
            }),
            { numRuns: 400 }
        );
    });

    test("text / footage record a layerCount, and effect records its effect fields", () => {
        fc.assert(
            fc.property(arbLayerResult, arbTemplateId, arbAssetsList, (res, templateId, assets) => {
                const meta = buildMeta(res, templateId, assets);
                if (res.type === "text" || res.type === "footage") {
                    expect(meta.layerCount).toBe(res.layerCount || 1);
                }
                if (res.type === "effect") {
                    expect(meta.effectCount).toBe(res.effectCount);
                    expect(meta.effectNames).toBe(res.effectNames);
                    expect(meta.saveMode).toBe(res.saveMode);
                }
                expect(meta.section).toBe(res.section);
                expect(meta.type).toBe(res.type);
            }),
            { numRuns: 400 }
        );
    });

    test("a Utility Pre-Comp layer keeps its assetKind and precompName", () => {
        const res = {
            ok: true, name: "Util", category: "Titles", section: "layer", type: "layer",
            width: 1920, height: 1080, pixelAspect: 1, frameRate: 25, duration: 5,
            layerCount: 1, layerState: { switches: {}, markers: [] },
            assetKind: "precomp", precompName: "Inner Comp",
        };
        const meta = buildMeta(res, "Util", []);
        expect(meta.assetKind).toBe("precomp");
        expect(meta.precompName).toBe("Inner Comp");
        expect("assetsDir" in meta).toBe(false);
    });
});

describe("Property 1 (metadata) — a LEGACY host result still produces the previous document", () => {
    test("a result with no format fields omits every format key rather than writing zeros", () => {
        fc.assert(
            fc.property(arbTemplateId, arbAssetsList, arbName, arbCategory,
                (templateId, assets, name, cat) => {
                    // The pre-F1 host result, verbatim: no width/height/pixelAspect/
                    // frameRate/duration, and no section/type.
                    const legacy = {
                        ok: true, templateId: templateId, name: name, category: cat,
                        folderPath: "C:/lib/comp/Titles/" + name,
                        assetsList: assets, oldId: "", needsThumbnail: true,
                    };
                    const meta = buildMeta(legacy, templateId, assets);

                    ["width", "height", "dim", "pixelAspect", "frameRate", "duration"]
                        .forEach(function (k) { expect(k in meta).toBe(false); });
                    // The document is still a valid, scannable comp record.
                    expect(meta.schemaVersion).toBe(2);
                    expect(meta.section).toBe("comp");
                    expect(meta.type).toBe("comp");
                    expect(meta.mainFile).toBe("project.aep");
                    expect(meta.thumbnail).toBe("thumbnail.png");
                    // ...and 2.10's assetsDir is recorded from the normalized section.
                    expect(meta.assetsDir).toBe(assets.length > 0 ? "assets/" : "");
                }),
            { numRuns: 400 }
        );
    });

    test("the written document always survives a JSON round trip", () => {
        fc.assert(
            fc.property(fc.oneof(arbCompResult, arbLayerResult), arbTemplateId, arbAssetsList,
                (res, templateId, assets) => {
                    const meta = buildMeta(res, templateId, assets);
                    const text = JSON.stringify(meta, null, 4);
                    expect(function () { JSON.parse(text); }).not.toThrow();
                    expect(JSON.parse(text)).toEqual(meta);
                    // No key is ever written as the literal undefined.
                    expect(text.indexOf("undefined")).toBe(-1);
                }),
            { numRuns: 600 }
        );
    });

    test("the host results the two REAL save engines return produce complete documents", () => {
        // End-to-end on this slice: run the real saveActiveComp / coreSaveLayerType
        // in a vm, feed the ACTUAL result object into the real panel construction,
        // and assert every key Property 1 requires is present.
        const geometry = {
            width: 1920, height: 1080, pixelAspect: 1, duration: 10,
            frameRate: 25, workAreaStart: 0, workAreaDuration: 10,
        };

        const comp = H.buildCompSaveRealm({ invalidateOnOpen: true, geometry: geometry });
        const compRes = JSON.parse(comp.run("My Title", "Titles", "C:/lib"));
        expect(compRes.ok).toBe(true);
        const compMeta = buildMeta(compRes, compRes.templateId, [{ fsPath: "C:/a/x.png", name: "x.png" }]);
        ["schemaVersion", "id", "name", "section", "type", "category", "mainFile",
            "thumbnail", "width", "height", "dim", "pixelAspect", "frameRate",
            "duration", "assetsDir"].forEach(function (k) {
                expect(k in compMeta).toBe(true);
            });
        expect(compMeta.dim).toBe("1920x1080");
        expect(compMeta.assetsDir).toBe("assets/");
        expect(compMeta.section).toBe("comp");

        const layer = H.buildLayerSaveRealm({ invalidateOnOpen: true, geometry: geometry });
        const layerRes = layer.run("layer");
        expect(typeof layerRes).toBe("object");
        // The wrapper (jsx/templates_save.jsx:1386) adds section/type/templateId
        // around coreSaveLayerType's return before the panel sees it.
        const forPanel = Object.assign({}, layerRes, {
            section: "layer", type: "layer", templateId: "Name", name: "Name", category: "Cat",
        });
        const layerMeta = buildMeta(forPanel, "Name", []);
        ["schemaVersion", "id", "name", "section", "type", "category", "mainFile",
            "thumbnail", "width", "height", "dim", "pixelAspect", "frameRate",
            "duration", "layerCount", "layerState"].forEach(function (k) {
                expect(k in layerMeta).toBe(true);
            });
        expect(layerMeta.dim).toBe("1920x1080");
        expect("assetsDir" in layerMeta).toBe(false);
    });
});
