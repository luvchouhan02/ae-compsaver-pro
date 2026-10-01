// ============================================================
// tests/comp-save-reference-capture.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.1)
//
// Property 3 — Reference Capture Precedes Invalidation.
// Property 4 — Reopen Failure Is Never Success.
//
// Both save engines run FOR REAL inside a `vm` (Harness A) against the
// invalidating-item fake: after `app.open()` is called, EVERY property read on
// the source composition throws, exactly as After Effects behaves once the
// project DOM has been replaced. That makes "was this value captured before the
// destructive window?" directly observable — a field that is still read at
// result-construction time cannot survive.
//
// Generators cover the save scenario space named in the task: section
// (comp / layer / text / footage) x reopen-throws x target-save-throws x
// reduce-throws x protective-throws, plus comp geometry including the degenerate
// frameRate 0 / duration 0 values the capture arithmetic must survive.
//
// typeof-guard branches exercised
// ------------------------------
//   validateLibraryRoot  — lives in jsx/core.jsx and is NOT part of CORE_PURE,
//                          so both engines run their documented INLINE
//                          absolute-path branch. Every generated root here is
//                          absolute, so both branches agree by construction.
//   jsonParse            — never reached; the panel-side JSON.parse in this file
//                          is the test's own decode of the host reply.
//
// **Validates: Requirements 2.1, 2.2, 2.5, 3.3**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

// ─────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────
const arbLayerSection = fc.constantFrom("layer", "text", "footage");

// Geometry including the degenerate values the pre-window capture must survive:
// frameRate 0 makes the renderFrame product 0, duration 0 makes it a zero-length
// comp, and a NaN-producing combination must floor to 0 rather than leak NaN.
const arbGeometry = fc.record({
    width: fc.integer({ min: 1, max: 7680 }),
    height: fc.integer({ min: 1, max: 4320 }),
    pixelAspect: fc.constantFrom(1, 0.9, 1.5, 2),
    duration: fc.constantFrom(0, 0.04, 5, 10, 3600),
    frameRate: fc.constantFrom(0, 1, 23.976, 25, 30, 120),
    workAreaStart: fc.constantFrom(0, 1.5, 4),
    workAreaDuration: fc.constantFrom(0, 1, 10),
});

// The five injection switches the task names. `openThrows` is the Property 4
// trigger; the other four decide WHERE in the sequence the save dies.
const arbInjection = fc.record({
    protectiveSaveThrows: fc.boolean(),
    reduceThrows: fc.boolean(),
    targetSaveThrows: fc.boolean(),
    openThrows: fc.boolean(),
});

const arbName = fc.constantFrom("My Title", "Lower Third 01", "a-b_c", "x");
const arbCategory = fc.constantFrom("Titles", "Lower-Thirds", "x");

/** Every generated root is absolute and its whole subtree already exists. */
const arbAbsoluteRoot = fc.constantFrom("C:/lib", "C:/Users/x/My Library", "D:/AE/Lib");

function compRealm(root, injection, geometry) {
    return H.buildCompSaveRealm(Object.assign({
        // The bug condition: the reference dies the instant app.open runs.
        invalidateOnOpen: true,
        rootPath: root,
        fsSet: {},
        everythingUnderRootExists: true,
        geometry: geometry,
    }, injection));
}

function layerRealm(root, injection, geometry) {
    return H.buildLayerSaveRealm(Object.assign({
        invalidateOnOpen: true,
        rootPath: root,
        fsSet: {},
        everythingUnderRootExists: true,
        geometry: geometry,
    }, injection));
}

/** The frame the engine must have captured BEFORE the window, per F1(a)/F2(a). */
function expectedCapturedFrame(g) {
    let f = Math.round((g.workAreaStart + g.workAreaDuration * 0.3) * g.frameRate);
    if (!(f >= 0)) f = 0;
    return f;
}

// ============================================================
// Property 3 — every field of a successful result predates the reopen
// ============================================================
describe("Property 3 — reference capture precedes invalidation", () => {
    test("saveActiveComp: a successful save never returns an \"Error\" string, and every result field predates app.open", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbName, arbCategory, arbGeometry, (root, name, cat, g) => {
                const h = compRealm(root, {}, g);
                const reply = h.run(name, cat, root);

                // The destructive window really ran and the template really landed.
                expect(h.counters.reduceCalls).toBe(1);
                expect(h.counters.saveCalls.length).toBe(2);
                // The reference really is dead — proving the fields below could
                // not have been read at result-construction time.
                expect(h.latch.invalidated).toBe(true);
                expect(() => h.precomp.width).toThrow();

                expect(reply.indexOf("Error")).not.toBe(0);
                const res = JSON.parse(reply);
                expect(res.ok).toBe(true);

                // Property 3, the observable form: the format the panel writes
                // into meta.json is the pre-window format, not a zero/undefined
                // left behind by a read that threw.
                expect(res.width).toBe(g.width);
                expect(res.height).toBe(g.height);
                expect(res.pixelAspect).toBe(g.pixelAspect);
                expect(res.frameRate).toBe(g.frameRate);
                expect(res.duration).toBe(g.duration);
                // renderComp is the name actually stored inside project.aep
                // (captured AFTER the rename, BEFORE the reduce).
                expect(res.renderComp).toBe(name);
                expect(res.renderFrame).toBe(expectedCapturedFrame(g));
                expect(Number.isNaN(res.renderFrame)).toBe(false);
                expect(res.renderFrame >= 0).toBe(true);
            }),
            { numRuns: 200 }
        );
    });

    test("coreSaveLayerType: a successful save returns an OBJECT, never a \"Save Error\" string", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, arbGeometry, (root, section, g) => {
                const h = layerRealm(root, {}, g);
                const out = h.run(section);

                expect(h.counters.reduceCalls).toBe(1);
                expect(h.counters.saveCalls.length).toBe(2);
                expect(h.latch.invalidated).toBe(true);
                expect(() => h.comp.frameRate).toThrow();

                expect(typeof out).toBe("object");
                expect(out.ok).toBe(true);
                expect(out.width).toBe(g.width);
                expect(out.height).toBe(g.height);
                expect(out.pixelAspect).toBe(g.pixelAspect);
                expect(out.frameRate).toBe(g.frameRate);
                expect(out.duration).toBe(g.duration);
                expect(out.renderComp).toBe("Name");
                expect(out.renderFrame).toBe(expectedCapturedFrame(g));
            }),
            { numRuns: 200 }
        );
    });

    test("at most ONE app.open for any injection point, in either engine", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, arbInjection, arbGeometry,
                (root, section, injection, g) => {
                    const c = compRealm(root, injection, g);
                    c.run("My Title", "Titles", root);
                    expect(c.counters.openCalls.length).toBeLessThanOrEqual(1);

                    const l = layerRealm(root, injection, g);
                    l.run(section);
                    expect(l.counters.openCalls.length).toBeLessThanOrEqual(1);
                }),
            { numRuns: 300 }
        );
    });

    test("a pre-window failure performs ZERO reopens; a post-window failure performs exactly one", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, arbInjection, arbGeometry,
                (root, section, injection, g) => {
                    [compRealm(root, injection, g), layerRealm(root, injection, g)].forEach((h, idx) => {
                        if (idx === 0) h.run("My Title", "Titles", root);
                        else h.run(section);
                        // reduceProject succeeding IS the definition of the window.
                        const entered = h.counters.reduceCalls === 1 && !injection.reduceThrows;
                        if (injection.protectiveSaveThrows) {
                            expect(h.counters.reduceCalls).toBe(0);
                            expect(h.counters.openCalls.length).toBe(0);
                        } else {
                            expect(h.counters.openCalls.length).toBe(entered || injection.reduceThrows ? 1 : 0);
                        }
                    });
                }),
            { numRuns: 300 }
        );
    });
});

// ============================================================
// Property 4 — a thrown reopen is reported, never reported as success
// ============================================================
describe("Property 4 — reopen failure is never success", () => {
    test("saveActiveComp: reduce ok + target save ok + app.open throws => failure naming the template, exactly one reopen", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbName, arbCategory, arbGeometry, (root, name, cat, g) => {
                const h = compRealm(root, { openThrows: true }, g);
                const reply = h.run(name, cat, root);

                // Precondition of Property 4: both writes and the reduce succeeded.
                expect(h.counters.reduceCalls).toBe(1);
                expect(h.counters.saveCalls.length).toBe(2);
                // ...and the live session really is pointed at the template now.
                expect(h.app.project.file.fsName).toContain("/project.aep");

                let parsed = null;
                try { parsed = JSON.parse(reply); } catch (e) { parsed = null; }
                expect(!!(parsed && parsed.ok === true)).toBe(false);

                const message = parsed && parsed.error ? parsed.error : reply;
                // The message states that the live session is pointed at the
                // template rather than the user's project.
                expect(message).toContain("project.aep");
                expect(message).toMatch(/reopen(ing)? your project/i);
                expect(reply).toContain(root);

                expect(h.counters.openCalls.length).toBe(1);
                expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
            }),
            { numRuns: 200 }
        );
    });

    test("coreSaveLayerType: the same save returns a failure STRING that names the template folder", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, arbGeometry, (root, section, g) => {
                const h = layerRealm(root, { openThrows: true }, g);
                const out = h.run(section);

                expect(h.counters.reduceCalls).toBe(1);
                expect(h.counters.saveCalls.length).toBe(2);

                expect(typeof out).toBe("string");
                expect(out).toContain(root + "/" + section + "/");
                expect(out).toMatch(/reopen(ing)? your project/i);
                expect(h.counters.openCalls.length).toBe(1);
                expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
            }),
            { numRuns: 200 }
        );
    });

    test("no injection combination can produce ok:true once app.open has thrown", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbInjection, arbGeometry, (root, injection, g) => {
                const inj = Object.assign({}, injection, { openThrows: true });
                const h = compRealm(root, inj, g);
                const reply = h.run("My Title", "Titles", root);
                let parsed = null;
                try { parsed = JSON.parse(reply); } catch (e) { parsed = null; }
                if (h.counters.openCalls.length > 0) {
                    expect(!!(parsed && parsed.ok === true)).toBe(false);
                }
            }),
            { numRuns: 300 }
        );
    });
});

// ============================================================
// The recorded save-window-invariants counters, unchanged
// (tests/save-window-invariants.test.js is the baseline; these are the same
// numbers re-asserted over generated inputs rather than one fixed example.)
// ============================================================
describe("the save-window-invariants counters are unchanged under capture", () => {
    test("success: 2 writes, 1 reduce, 1 reopen, balanced undo + suppression, reduce-first order", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, arbGeometry, (root, section, g) => {
                const h = layerRealm(root, {}, g);
                const out = h.run(section);
                expect(typeof out).toBe("object");
                expect(out.needsThumbnail).toBe(true);
                expect(h.counters.saveCalls.length).toBe(2);
                expect(h.counters.reduceCalls).toBe(1);
                expect(h.counters.openCalls.length).toBe(1);
                expect(h.counters.undoBegin).toBe(h.counters.undoEnd);
                expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                expect(h.counters.seq).toEqual([
                    "beginUndoGroup",
                    "save(PROTECTIVE)",
                    "addComp",
                    "reduceProject",
                    "save(TARGET)",
                    "endUndoGroup",
                    "beginSuppressDialogs",
                    "open",
                    "endSuppressDialogs",
                ]);
            }),
            { numRuns: 120 }
        );
    });

    test("pre-window failure: only the protective write, zero reduces, zero reopens, undo ends once", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, (root, section) => {
                const h = H.buildLayerSaveRealm({
                    invalidateOnOpen: true, rootPath: root, fsSet: {},
                    everythingUnderRootExists: true, copyThrows: true,
                });
                const out = h.run(section);
                expect(typeof out).toBe("string");
                expect(out).toContain("Save Error");
                expect(h.counters.saveCalls).toEqual(["PROTECTIVE"]);
                expect(h.counters.reduceCalls).toBe(0);
                expect(h.counters.openCalls).toEqual([]);
                expect(h.counters.undoBegin).toBe(1);
                expect(h.counters.undoEnd).toBe(1);
            }),
            { numRuns: 60 }
        );
    });

    test("in-window failure: exactly ONE suppress-balanced reopen", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, (root, section) => {
                const h = layerRealm(root, { targetSaveThrows: true }, H.DEFAULT_COMP_GEOMETRY);
                const out = h.run(section);
                expect(typeof out).toBe("string");
                expect(out).toContain("Template save failed");
                expect(h.counters.reduceCalls).toBe(1);
                expect(h.counters.openCalls).toEqual(["C:/proj/live.aep"]);
                expect(h.counters.suppressBegin).toBe(h.counters.suppressEnd);
                expect(h.counters.undoBegin).toBe(1);
                expect(h.counters.undoEnd).toBe(1);
            }),
            { numRuns: 60 }
        );
    });

    test("protective-save failure: verbatim abort message, zero destructive ops", () => {
        fc.assert(
            fc.property(arbAbsoluteRoot, arbLayerSection, (root, section) => {
                const h = layerRealm(root, { protectiveSaveThrows: true }, H.DEFAULT_COMP_GEOMETRY);
                const out = h.run(section);
                expect(out).toBe("Protective save failed \u2014 aborted, your project is untouched.");
                expect(h.counters.reduceCalls).toBe(0);
                expect(h.counters.openCalls).toEqual([]);
            }),
            { numRuns: 60 }
        );
    });
});
