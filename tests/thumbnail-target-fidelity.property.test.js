// ============================================================
// tests/thumbnail-target-fidelity.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.12)
//
// Property 1 — thumbnail slice: "the recorded render target is the frame
// rendered".
//
//   For ANY (compName, frame, frameRate, duration) the rendered time is
//   frame / frameRate clamped into the comp, the NAMED comp is the one rendered,
//   and omitting either argument reproduces the legacy 30%-of-work-area time.
//
// The pre-fix defect (1.11): renderTemplateThumbnail took TWO arguments, so the
// comp name and frame the save engine captured pre-reopen were discarded — the
// background thumbnail rendered 30% into the work area of whatever composition
// the .aep happened to list first, which is a different frame (and often a
// different comp) than the isolated aerender path produced for the same template.
//
// The REAL renderTemplateThumbnail runs in a `vm` (Harness A) with a recording
// renderFrameToPng, so the rendered composition and time are observed rather than
// inferred. The clamp arithmetic is re-derived independently below.
//
// Regression clauses asserted alongside (3.25, 3.27): the routine still touches
// neither app.project.file nor app.open, always removes its scratch import and its
// wrapper comp, keeps dialog suppression balanced, restores the project's bit
// depth, and still honours a LEGACY two-argument call.
//
// typeof-guard branches exercised
// ------------------------------
//   PRIMARY  — findCompItemInFolderByName IS injected, so the name-targeted lookup
//              runs. It lives in jsx/text.jsx, which is why the production call
//              site guards it.
//   FALLBACK — a dedicated test omits it, so the documented
//              "name-targeted lookup out of scope" path degrades to
//              findCompItemInFolder (the first comp) without failing.
//   decodeBridge / encodeBridge / escapeJSON come from CORE_PURE, so
//   decodeBridge takes its INLINE branch (decodeBridgeStrict is not sliced).
//
// **Validates: Requirements 2.11, 3.25, 3.27**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

const AEP_PATH = "C:/lib/comp/Cat/T/project.aep";
const PNG_PATH = "C:/lib/comp/Cat/T/thumbnail.png";
const THUMB_TARGET_W = 320;

// ─────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────
const arbCompName = fc.constantFrom(
    "Recorded Comp", "Lower Third 01", "My Title", "\u65e5\u672c\u8a9e", "a-b_c"
);
const arbFrame = fc.oneof(
    fc.integer({ min: 0, max: 5000 }),
    fc.constantFrom(0, 1, 29, 30, 100000, 999999)
);
const arbFrameRate = fc.constantFrom(0, 1, 23.976, 24, 25, 29.97, 30, 60, 120);
const arbDuration = fc.constantFrom(0, 0.04, 1, 5, 10, 3600);
const arbWorkAreaStart = fc.constantFrom(0, 1.5, 4);
const arbWorkAreaDuration = fc.constantFrom(0, 1, 10);
// Below and above the 320px bound, so both the direct and the wrapper render
// path are covered.
const arbWidth = fc.constantFrom(1, 160, 320, 321, 1920, 3840);

const arbGeometry = fc.record({
    width: arbWidth,
    height: fc.constantFrom(1, 90, 180, 1080, 2160),
    pixelAspect: fc.constantFrom(1, 0.9, 1.5),
    duration: arbDuration,
    frameRate: arbFrameRate,
    workAreaStart: arbWorkAreaStart,
    workAreaDuration: arbWorkAreaDuration,
});

// ─────────────────────────────────────────────────────────────
// The realm
// ─────────────────────────────────────────────────────────────
function makeComp(name, g) {
    const comp = Object.assign({ __kind: "comp", name: name }, g);
    comp.remove = function () { comp.__removed = true; };
    return comp;
}

/**
 * `opts.byName` false omits findCompItemInFolderByName so the documented
 * typeof FALLBACK runs. `opts.renderFails` makes renderFrameToPng report failure.
 * `opts.wrapperThrows` makes the bounded-resolution wrapper unbuildable, which is
 * the production fall-back-to-source path.
 */
function buildThumbRealm(named, first, opts) {
    opts = opts || {};
    const rendered = [];
    const removals = [];
    const forbidden = [];
    const counters = { suppressBegin: 0, suppressEnd: 0, depthWrites: [] };

    const importedFolder = {
        __kind: "folder", name: "scratch",
        remove: function () { removals.push("importedFolder"); },
    };

    const project = {
        importFile: function () {
            if (opts.importThrows) throw new Error("import exploded");
            return importedFolder;
        },
        items: {
            addComp: function (name, w, h, pa, dur, fps) {
                if (opts.wrapperThrows) throw new Error("addComp failed");
                const wrapper = makeComp(name, {
                    width: w, height: h, pixelAspect: pa, duration: dur, frameRate: fps,
                    workAreaStart: 0, workAreaDuration: 0,
                });
                wrapper.__isWrapper = true;
                wrapper.layers = {
                    add: function (src) {
                        wrapper.__wrapped = src;
                        return {
                            property: function () {
                                return { property: function () { return { setValue: function () { } }; } };
                            },
                        };
                    },
                };
                wrapper.remove = function () { removals.push("wrapperComp"); wrapper.__removed = true; };
                return wrapper;
            },
        },
    };
    // 3.27: the routine must never read app.project.file nor call app.open.
    Object.defineProperty(project, "file", {
        get: function () { forbidden.push("read app.project.file"); return null; },
        set: function () { forbidden.push("write app.project.file"); },
    });
    Object.defineProperty(project, "bitsPerChannel", {
        get: function () { return 16; },
        set: function (v) { counters.depthWrites.push(v); },
    });

    const app = {
        project: project,
        open: function () { forbidden.push("app.open"); },
        beginSuppressDialogs: function () { counters.suppressBegin++; },
        endSuppressDialogs: function () { counters.suppressEnd++; },
    };

    const injected = {
        app: app,
        File: H.createFileCtor({ "C:/lib/comp/Cat/T/project.aep": true }),
        ImportOptions: function ImportOptions(f) { this.file = f; },
        findCompItemInFolder: function () { return first; },
        renderFrameToPng: function (comp, time) {
            rendered.push({
                comp: comp.name, time: time,
                isWrapper: !!comp.__isWrapper, wrapped: comp.__wrapped ? comp.__wrapped.name : null,
                ref: comp,
            });
            if (opts.renderFails) return { success: false, error: "no valid PNG" };
            return { success: true };
        },
    };
    if (opts.byName !== false) {
        injected.findCompItemInFolderByName = function (folder, name) {
            return named && named.name === name ? named : null;
        };
    }

    const ctx = H.buildRealm(
        [H.CORE_PURE, H.sliceFn(H.SAVE_SRC, "renderTemplateThumbnail")].join("\n"),
        injected
    );

    return {
        ctx: ctx, rendered: rendered, removals: removals, forbidden: forbidden,
        counters: counters, importedFolder: importedFolder,
        /**
         * Both `compName` and `frame` undefined models a LEGACY two-argument
         * call. Omitting only ONE of them passes the empty payload in that slot —
         * the positional shape a host result missing `renderComp` or
         * `renderFrame` actually produces — never a positional shift.
         */
        run: function (compName, frame) {
            const e = ctx.encodeBridge;
            const args = [e(AEP_PATH), e(PNG_PATH)];
            if (compName !== undefined || frame !== undefined) {
                args.push(compName === undefined ? "" : e(compName));
            }
            if (frame !== undefined) args.push(e(String(frame)));
            const raw = ctx.renderTemplateThumbnail.apply(null, args);
            return JSON.parse(ctx.decodeBridge(raw));
        },
    };
}

// ─────────────────────────────────────────────────────────────
// The clamp, re-derived independently
// ─────────────────────────────────────────────────────────────
function expectedTime(g, wantFrame) {
    if (wantFrame >= 0 && g.frameRate > 0) {
        let t = wantFrame / g.frameRate;
        let maxTime = g.duration - 1 / g.frameRate;
        if (!(maxTime > 0)) maxTime = 0;
        if (t > maxTime) t = maxTime;
        if (!(t >= 0)) t = 0;
        return t;
    }
    return g.workAreaStart + g.workAreaDuration * 0.3;
}

function legacyTime(g) {
    return g.workAreaStart + g.workAreaDuration * 0.3;
}

/** Common regression assertions (3.25, 3.27) for any completed call. */
function assertNonDestructive(h) {
    expect(h.forbidden).toEqual([]);
    expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
    expect(h.removals).toContain("importedFolder");
    expect(h.counters.depthWrites[0]).toBe(8);
    expect(h.counters.depthWrites[h.counters.depthWrites.length - 1]).toBe(16);
}

// ============================================================
describe("Property 1 (thumbnail) — the recorded frame is the frame rendered", () => {
    test("the arity carries the recorded target: at least four arguments", () => {
        const h = buildThumbRealm(makeComp("A", H.DEFAULT_COMP_GEOMETRY), makeComp("B", H.DEFAULT_COMP_GEOMETRY));
        expect(h.ctx.renderTemplateThumbnail.length).toBeGreaterThanOrEqual(4);
    });

    test("the rendered time is frame / frameRate, clamped into the comp", () => {
        fc.assert(
            fc.property(arbCompName, arbFrame, arbGeometry, (name, frame, g) => {
                const named = makeComp(name, g);
                const first = makeComp("First Comp In Folder", g);
                const h = buildThumbRealm(named, first);

                const res = h.run(name, frame);
                expect(res.ok).toBe(true);
                expect(h.rendered.length).toBe(1);
                expect(h.rendered[0].time).toBeCloseTo(expectedTime(g, frame), 9);
                // Never past the end of the comp, never negative, never NaN.
                expect(Number.isNaN(h.rendered[0].time)).toBe(false);
                expect(h.rendered[0].time).toBeGreaterThanOrEqual(0);
                if (g.frameRate > 0) {
                    const maxTime = Math.max(0, g.duration - 1 / g.frameRate);
                    expect(h.rendered[0].time).toBeLessThanOrEqual(Math.max(maxTime, legacyTime(g)) + 1e-9);
                }
                assertNonDestructive(h);
            }),
            { numRuns: 600 }
        );
    });

    test("the NAMED comp is the one rendered, never the first comp in the folder", () => {
        fc.assert(
            fc.property(arbCompName, arbFrame, arbGeometry, (name, frame, g) => {
                const named = makeComp(name, g);
                const first = makeComp("First Comp In Folder", g);
                fc.pre(name !== first.name);
                const h = buildThumbRealm(named, first);

                expect(h.run(name, frame).ok).toBe(true);
                const rec = h.rendered[0];
                if (g.width > THUMB_TARGET_W) {
                    // Bounded resolution: the wrapper is rendered, and the comp it
                    // wraps is the NAMED one.
                    expect(rec.isWrapper).toBe(true);
                    expect(rec.wrapped).toBe(name);
                    expect(rec.comp).toBe(name + " [Thumb]");
                    expect(h.removals).toContain("wrapperComp");
                } else {
                    expect(rec.isWrapper).toBe(false);
                    expect(rec.ref).toBe(named);
                    expect(rec.comp).toBe(name);
                }
                assertNonDestructive(h);
            }),
            { numRuns: 600 }
        );
    });

    test("a recorded name that is NOT in the .aep degrades to the first comp rather than failing", () => {
        fc.assert(
            fc.property(arbFrame, arbGeometry, (frame, g) => {
                const first = makeComp("First Comp In Folder", g);
                const h = buildThumbRealm(null, first);
                expect(h.run("A Comp That Was Renamed", frame).ok).toBe(true);
                expect(h.rendered.length).toBe(1);
                const rec = h.rendered[0];
                expect(g.width > THUMB_TARGET_W ? rec.wrapped : rec.comp).toBe(first.name);
                // The recorded FRAME is still honoured on the degraded path.
                expect(rec.time).toBeCloseTo(expectedTime(g, frame), 9);
                assertNonDestructive(h);
            }),
            { numRuns: 400 }
        );
    });

    test("the wrapper inherits the source comp's timing, so the clamp is identical either side of 320px", () => {
        fc.assert(
            fc.property(arbCompName, arbFrame, arbGeometry, (name, frame, g) => {
                const small = Object.assign({}, g, { width: 160 });
                const large = Object.assign({}, g, { width: 1920 });
                const a = buildThumbRealm(makeComp(name, small), makeComp("F", small));
                const b = buildThumbRealm(makeComp(name, large), makeComp("F", large));
                expect(a.run(name, frame).ok).toBe(true);
                expect(b.run(name, frame).ok).toBe(true);
                expect(b.rendered[0].time).toBeCloseTo(a.rendered[0].time, 9);
            }),
            { numRuns: 400 }
        );
    });

    test("a failed wrapper build falls back to the source comp at the SAME time", () => {
        fc.assert(
            fc.property(arbCompName, arbFrame, arbGeometry, (name, frame, g) => {
                const large = Object.assign({}, g, { width: 1920 });
                const named = makeComp(name, large);
                const h = buildThumbRealm(named, makeComp("F", large), { wrapperThrows: true });
                expect(h.run(name, frame).ok).toBe(true);
                expect(h.rendered[0].isWrapper).toBe(false);
                expect(h.rendered[0].ref).toBe(named);
                expect(h.rendered[0].time).toBeCloseTo(expectedTime(large, frame), 9);
                expect(h.removals).not.toContain("wrapperComp");
                assertNonDestructive(h);
            }),
            { numRuns: 300 }
        );
    });
});

// ============================================================
// The legacy 2-argument call must reproduce the previous behavior exactly
// ============================================================
describe("Property 1 (thumbnail) — omitting either argument reproduces the legacy time", () => {
    test("a LEGACY two-argument call: the first comp, 30% into its work area", () => {
        fc.assert(
            fc.property(arbGeometry, (g) => {
                const first = makeComp("First Comp In Folder", g);
                const h = buildThumbRealm(makeComp("Recorded Comp", g), first);
                expect(h.run(undefined, undefined).ok).toBe(true);
                const rec = h.rendered[0];
                expect(g.width > THUMB_TARGET_W ? rec.wrapped : rec.comp).toBe(first.name);
                expect(rec.time).toBeCloseTo(legacyTime(g), 9);
                assertNonDestructive(h);
            }),
            { numRuns: 400 }
        );
    });

    test("a comp name but NO frame: the named comp, 30% into its work area", () => {
        fc.assert(
            fc.property(arbCompName, arbGeometry, (name, g) => {
                const named = makeComp(name, g);
                const h = buildThumbRealm(named, makeComp("First Comp In Folder", g));
                expect(h.run(name, undefined).ok).toBe(true);
                const rec = h.rendered[0];
                expect(g.width > THUMB_TARGET_W ? rec.wrapped : rec.comp).toBe(name);
                expect(rec.time).toBeCloseTo(legacyTime(g), 9);
            }),
            { numRuns: 400 }
        );
    });

    test("a frame but NO comp name: the first comp, at the recorded frame", () => {
        fc.assert(
            fc.property(arbFrame, arbGeometry, (frame, g) => {
                const first = makeComp("First Comp In Folder", g);
                const h = buildThumbRealm(makeComp("Recorded Comp", g), first);
                expect(h.run(undefined, frame).ok).toBe(true);
                const rec = h.rendered[0];
                expect(g.width > THUMB_TARGET_W ? rec.wrapped : rec.comp).toBe(first.name);
                expect(rec.time).toBeCloseTo(expectedTime(g, frame), 9);
            }),
            { numRuns: 400 }
        );
    });

    test("an empty or unparseable frame argument falls back to the legacy time", () => {
        fc.assert(
            fc.property(arbCompName, arbGeometry, fc.constantFrom("", "abc", "-1", "NaN", " ", "1.9e"),
                (name, g, raw) => {
                    const named = makeComp(name, g);
                    const h = buildThumbRealm(named, makeComp("First Comp In Folder", g));
                    const e = h.ctx.encodeBridge;
                    const res = JSON.parse(h.ctx.decodeBridge(h.ctx.renderTemplateThumbnail(
                        e(AEP_PATH), e(PNG_PATH), e(name), e(raw)
                    )));
                    expect(res.ok).toBe(true);
                    const parsed = parseInt(raw, 10);
                    const wantFrame = (!isNaN(parsed) && parsed >= 0) ? parsed : -1;
                    expect(h.rendered[0].time).toBeCloseTo(expectedTime(g, wantFrame), 9);
                }),
            { numRuns: 400 }
        );
    });

    test("the FALLBACK branch (no findCompItemInFolderByName in scope) still honours the frame", () => {
        // The typeof guard's false branch: the name-targeted lookup is out of
        // scope, so the first comp is rendered — but at the RECORDED frame, which
        // is the half of 2.11 that does not depend on jsx/text.jsx being loaded.
        fc.assert(
            fc.property(arbCompName, arbFrame, arbGeometry, (name, frame, g) => {
                const first = makeComp("First Comp In Folder", g);
                const h = buildThumbRealm(makeComp(name, g), first, { byName: false });
                expect(h.run(name, frame).ok).toBe(true);
                const rec = h.rendered[0];
                expect(g.width > THUMB_TARGET_W ? rec.wrapped : rec.comp).toBe(first.name);
                expect(rec.time).toBeCloseTo(expectedTime(g, frame), 9);
            }),
            { numRuns: 400 }
        );
    });
});

// ============================================================
// The non-destructive contract (3.25, 3.27)
// ============================================================
describe("Property 1 (thumbnail) — the render stays non-destructive on every path", () => {
    test("neither app.project.file nor app.open is ever touched, on success or failure", () => {
        fc.assert(
            fc.property(arbCompName, arbFrame, arbGeometry,
                fc.constantFrom("ok", "renderFails", "importThrows", "noComp", "wrapperThrows"),
                (name, frame, g, mode) => {
                    const named = mode === "noComp" ? null : makeComp(name, g);
                    const first = mode === "noComp" ? null : makeComp("First Comp In Folder", g);
                    const opts = {};
                    if (mode === "renderFails") opts.renderFails = true;
                    if (mode === "importThrows") opts.importThrows = true;
                    if (mode === "wrapperThrows") opts.wrapperThrows = true;

                    const h = buildThumbRealm(named, first, opts);
                    const res = h.run(name, frame);

                    expect(h.forbidden).toEqual([]);
                    expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                    // The scratch import is always discarded when one was made.
                    if (mode !== "importThrows") expect(h.removals).toContain("importedFolder");
                    // A failure is REPORTED, never a false success.
                    if (mode === "ok" || mode === "wrapperThrows") expect(res.ok).toBe(true);
                    else {
                        expect(res.ok).toBe(false);
                        expect(typeof res.error).toBe("string");
                        expect(res.error.length).toBeGreaterThan(0);
                    }
                }),
            { numRuns: 600 }
        );
    });

    test("a missing .aep, an empty path and a missing output path are all reported", () => {
        const g = H.DEFAULT_COMP_GEOMETRY;
        const h = buildThumbRealm(makeComp("A", g), makeComp("B", g));
        const e = h.ctx.encodeBridge;

        const noAep = JSON.parse(h.ctx.decodeBridge(
            h.ctx.renderTemplateThumbnail(e(""), e(PNG_PATH), e("A"), e("0"))));
        expect(noAep.ok).toBe(false);
        expect(noAep.error).toContain("project.aep path");

        const noPng = JSON.parse(h.ctx.decodeBridge(
            h.ctx.renderTemplateThumbnail(e(AEP_PATH), e(""), e("A"), e("0"))));
        expect(noPng.ok).toBe(false);
        expect(noPng.error).toContain("output png path");

        const missing = JSON.parse(h.ctx.decodeBridge(
            h.ctx.renderTemplateThumbnail(e("C:/lib/comp/Cat/T/gone.aep"), e(PNG_PATH), e("A"), e("0"))));
        expect(missing.ok).toBe(false);
        expect(missing.error).toContain("missing");
        // Nothing was imported, so nothing had to be discarded.
        expect(h.rendered).toEqual([]);
        expect(h.forbidden).toEqual([]);
    });
});
