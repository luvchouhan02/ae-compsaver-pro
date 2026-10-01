// ============================================================
// tests/library-path-containment.property.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.3)
//
// Property 6 — Every Written Path Is Inside The Library.
//
//   For ANY library root, template name and category, the save engine SHALL
//   either reject the request before creating a folder, or produce a target
//   folder path that — once normalized — is a strict descendant of
//   <root>/<section>/<safeCategory> with a non-empty final segment that is
//   neither "." nor "..".
//
// Both real engines run in a `vm` (Harness A) over a modeled disk that records
// EVERY Folder.create(), so "nothing was created outside the library" and
// "nothing was created before the rejection" are directly observable rather than
// inferred from the reply string.
//
// The generated name/category space is the one the task names: ".", "..", "...",
// reserved device names, 300-character names, whitespace-only names, names
// carrying separators and C0 controls, and ordinary safe names.
//
// typeof-guard branches exercised
// ------------------------------
// Every property below is asserted TWICE, once per branch of the engines'
// documented root-validation guard:
//   PRIMARY  — `validateLibraryRoot` sliced in from jsx/core.jsx (absolute-path
//              rule PLUS the on-disk resolvable-parent probe).
//   FALLBACK — the guard's inline `/^([A-Za-z]:\/|\/)/` branch, which is what
//              runs when an engine is executed on its own.
//
// **Validates: Requirements 2.6, 2.7, 2.8**
// ============================================================
"use strict";

const fc = require("fast-check");
const H = require("./helpers/compPipelineHarness");

// ─────────────────────────────────────────────────────────────
// Roots
// ─────────────────────────────────────────────────────────────
// Drive-letter and POSIX absolute roots: these must be ACCEPTED and contained.
const CONTAINED_ROOTS = ["C:/lib", "C:/Users/x/My Library", "D:/AE/Lib", "C:/lib/", "/Users/x/lib"];
// Non-absolute roots: these must be REJECTED before anything is created.
const REJECTED_ROOTS = ["", "   ", "MyLib", "./x", "../x", "lib/sub", "..\\up"];

const arbContainedRoot = fc.constantFrom.apply(null, CONTAINED_ROOTS);
const arbRejectedRoot = fc.constantFrom.apply(null, REJECTED_ROOTS);

// ─────────────────────────────────────────────────────────────
// Names and categories: the hostile set plus ordinary safe names.
// ─────────────────────────────────────────────────────────────
const HOSTILE_NAMES = [
    ".", "..", "...", "....",
    "name.", "name ", "name...", " name ",
    "", "   ", "\t\t", "\n",
    "CON", "con", "con.aep", "PRN", "nul", "com1", "LPT9.txt", "aux.psd",
    "a/b\\c", "c:d", "a*b?c", 'q"uote', "a<b>c", "a|b",
    "\u0000zero", "bell\u0007", "del\u007f",
    "../../etc/passwd", "..\\..\\windows",
    new Array(300 + 1).join("A"),
    new Array(255 + 1).join("B"),
    new Array(256 + 1).join("C") + ".",
];
const arbHostileName = fc.constantFrom.apply(null, HOSTILE_NAMES);
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.";
const arbSafeName = fc
    .array(fc.integer({ min: 0, max: SAFE_CHARS.length - 1 }), { minLength: 1, maxLength: 40 })
    .map((idx) => idx.map((i) => SAFE_CHARS[i]).join(""));
// SAFE_CHARS deliberately includes " " and "." so whitespace-only and dot-only
// names are reachable; tests that must get PAST the empty-name guard use this
// narrowed form instead.
const arbNamedSafeName = arbSafeName.filter((s) => /[A-Za-z0-9]/.test(s));
const arbName = fc.oneof(arbHostileName, arbSafeName);
const arbCategory = fc.oneof(arbHostileName, arbSafeName, fc.constantFrom("Titles", "Lower-Thirds"));

const arbLayerSection = fc.constantFrom("layer", "text", "footage");
const arbUsePrimaryGuard = fc.boolean();

/**
 * A modeled disk on which the root AND every ancestor of it already exist —
 * the realistic first-run shape, and the one `validateLibraryRoot`'s
 * resolvable-parent probe expects. Nothing BELOW the root exists, so every
 * folder the engine needs is genuinely created and lands in `creates`.
 */
function seedDisk(root) {
    const fsSet = {};
    const norm = H.normalizePath(root);
    if (norm === "") return fsSet;
    const parts = norm.split("/");
    let cur = parts[0];
    fsSet[cur] = true;
    for (let i = 1; i < parts.length; i++) {
        cur = cur + "/" + parts[i];
        fsSet[cur] = true;
    }
    fsSet[String(root)] = true;
    return fsSet;
}

/** The path the whole derived tail must sit under. */
function containerOf(root, section) {
    return H.normalizePath(H.normalizePath(root) + "/" + section);
}

/**
 * Property 6's structural check on a derived folder path.
 * `container` is <root>/<section>; the path must be
 * <container>/<safeCategory>/<finalSegment> (the category collapsing away when
 * it sanitizes to the empty string), with a safe, non-traversing final segment.
 */
function assertContained(folderPath, container) {
    const actual = H.normalizePath(folderPath);
    expect(actual.indexOf(container + "/")).toBe(0);

    const tail = actual.substring(container.length + 1).split("/");
    // One segment (category collapsed to "") or two (category + id).
    expect(tail.length).toBeGreaterThanOrEqual(1);
    expect(tail.length).toBeLessThanOrEqual(2);
    tail.forEach((seg) => {
        expect(seg).not.toBe("");
        expect(seg).not.toBe(".");
        expect(seg).not.toBe("..");
        expect(H.isSafeSegment(seg)).toBe(true);
    });
    // Strict descendant: there IS a tail.
    expect(actual.length).toBeGreaterThan(container.length + 1);
    return tail;
}

/** No Folder.create() may touch anything outside the resolved library root. */
function assertCreatesInsideRoot(creates, root) {
    const rootNorm = H.normalizePath(root);
    creates.forEach((c) => {
        const n = H.normalizePath(c);
        expect(n === rootNorm || n.indexOf(rootNorm + "/") === 0).toBe(true);
    });
}

// ============================================================
// saveActiveComp
// ============================================================
describe("Property 6 — saveActiveComp", () => {
    test("an accepted root yields a contained path with a safe, non-traversing final segment", () => {
        fc.assert(
            fc.property(arbContainedRoot, arbCategory, arbName, arbUsePrimaryGuard,
                (root, cat, name, primary) => {
                    const h = H.buildCompSaveRealm({
                        rootPath: root, fsSet: seedDisk(root),
                        injectValidateLibraryRoot: primary, liveReference: true,
                    });
                    const reply = h.run(name, cat, root);
                    let parsed = null;
                    try { parsed = JSON.parse(reply); } catch (e) { parsed = null; }

                    if (!(parsed && parsed.ok === true)) {
                        // Rejected. The ONLY legal reason here is an empty name:
                        // every generated root is absolute and resolvable.
                        expect(reply.indexOf("Error")).toBe(0);
                        expect(h.counters.reduceCalls).toBe(0);
                        expect(h.counters.saveCalls).toEqual([]);
                        assertCreatesInsideRoot(h.creates, root);
                        return;
                    }

                    assertContained(parsed.folderPath, containerOf(root, "comp"));
                    assertCreatesInsideRoot(h.creates, root);
                    // The project.aep that was actually written lives inside it.
                    const written = h.counters.saveCalls.filter((s) => s !== "PROTECTIVE");
                    expect(written.length).toBe(1);
                    expect(H.normalizePath(written[0]))
                        .toBe(H.normalizePath(parsed.folderPath) + "/project.aep");
                }),
            { numRuns: 400 }
        );
    });

    test("a non-absolute root is rejected BEFORE any folder is created and before the destructive window", () => {
        fc.assert(
            fc.property(arbRejectedRoot, arbCategory, arbName, arbUsePrimaryGuard,
                (root, cat, name, primary) => {
                    const h = H.buildCompSaveRealm({
                        rootPath: root, fsSet: {},
                        injectValidateLibraryRoot: primary, liveReference: true,
                    });
                    const reply = h.run(name, cat, root);

                    expect(reply.indexOf("Error")).toBe(0);
                    expect(h.creates).toEqual([]);
                    expect(h.counters.reduceCalls).toBe(0);
                    expect(h.counters.saveCalls).toEqual([]);
                    expect(h.counters.openCalls).toEqual([]);
                    expect(h.counters.undoAttempts).toBe(0);
                }),
            { numRuns: 300 }
        );
    });

    test("an empty or whitespace-only name is rejected before any folder is created", () => {
        fc.assert(
            fc.property(arbContainedRoot, arbCategory, fc.constantFrom("", "   ", "\t", "\n", " \r\n "),
                arbUsePrimaryGuard, (root, cat, name, primary) => {
                    const h = H.buildCompSaveRealm({
                        rootPath: root, fsSet: seedDisk(root),
                        injectValidateLibraryRoot: primary, liveReference: true,
                    });
                    const reply = h.run(name, cat, root);
                    expect(reply).toContain("Please enter a template name.");
                    expect(h.creates).toEqual([]);
                    expect(h.counters.reduceCalls).toBe(0);
                }),
            { numRuns: 120 }
        );
    });

    test("a folder-creation failure aborts before reduceProject", () => {
        fc.assert(
            fc.property(arbContainedRoot, arbCategory, arbNamedSafeName, (root, cat, name) => {
                const h = H.buildCompSaveRealm({
                    rootPath: root, fsSet: seedDisk(root),
                    createFails: true, injectValidateLibraryRoot: true, liveReference: true,
                });
                const reply = h.run(name, cat, root);
                expect(reply).toContain("Failed to create folder");
                expect(h.creates.length).toBeGreaterThan(0);
                assertCreatesInsideRoot(h.creates, root);
                expect(h.counters.reduceCalls).toBe(0);
                expect(h.counters.saveCalls).toEqual([]);
                expect(h.counters.openCalls).toEqual([]);
            }),
            { numRuns: 150 }
        );
    });
});

// ============================================================
// coreSaveLayerType — the layer/text/footage family
//
// The templateId is an ARGUMENT here, derived by the caller as
// generateTemplateId(name) (jsx/templates_save.jsx:1385, :1476, :1542, :1593).
// The suite reproduces that derivation with the realm's own real
// generateTemplateId so the engine sees exactly what production passes it.
// ============================================================
describe("Property 6 — coreSaveLayerType", () => {
    test("an accepted root yields a contained path for every layer-family section", () => {
        fc.assert(
            fc.property(arbContainedRoot, arbLayerSection, arbCategory, arbName, arbUsePrimaryGuard,
                (root, section, cat, name, primary) => {
                    const h = H.buildLayerSaveRealm({
                        rootPath: root, fsSet: seedDisk(root),
                        injectValidateLibraryRoot: primary, liveReference: true,
                    });
                    const templateId = h.ctx.generateTemplateId(name);
                    const out = h.ctx.coreSaveLayerType(
                        name, cat, root, "Layer", "", section, templateId);

                    if (typeof out === "string") {
                        // Rejected: the only legal reason is the empty-name guard.
                        expect(out).toMatch(/Please enter a template name\.|Save Error/);
                        expect(h.counters.reduceCalls).toBe(0);
                        assertCreatesInsideRoot(h.creates, root);
                        return;
                    }

                    expect(out.ok).toBe(true);
                    assertContained(out.folderPath, containerOf(root, section));
                    assertCreatesInsideRoot(h.creates, root);
                }),
            { numRuns: 400 }
        );
    });

    test("a non-absolute root is rejected with \"Save Error\" and zero creates", () => {
        fc.assert(
            fc.property(arbRejectedRoot, arbLayerSection, arbCategory, arbNamedSafeName, arbUsePrimaryGuard,
                (root, section, cat, name, primary) => {
                    const h = H.buildLayerSaveRealm({
                        rootPath: root, fsSet: {},
                        injectValidateLibraryRoot: primary, liveReference: true,
                    });
                    const out = h.ctx.coreSaveLayerType(
                        name, cat, root, "Layer", "", section, h.ctx.generateTemplateId(name));
                    expect(typeof out).toBe("string");
                    expect(out.indexOf("Save Error:")).toBe(0);
                    expect(h.creates).toEqual([]);
                    expect(h.counters.reduceCalls).toBe(0);
                    expect(h.counters.undoAttempts).toBe(0);
                }),
            { numRuns: 300 }
        );
    });
});

// ============================================================
// The sanitizer's traversal defence, stated directly on the segments.
// ============================================================
describe("Property 6 — no derived segment can escape its parent", () => {
    test("every hostile name and category sanitizes to a single addressable segment", () => {
        const h = H.buildCompSaveRealm({ liveReference: true });
        HOSTILE_NAMES.forEach((n) => {
            const id = h.ctx.generateTemplateId(n);
            const cat = h.ctx.getSafeName(n);
            [id, cat].forEach((seg) => {
                expect(seg.indexOf("/")).toBe(-1);
                expect(seg.indexOf("\\")).toBe(-1);
                expect(seg).not.toBe(".");
                expect(seg).not.toBe("..");
                expect(seg.length).toBeLessThanOrEqual(255);
                // An empty segment collapses under normalization; anything
                // non-empty must be fully addressable.
                if (seg !== "") expect(H.isSafeSegment(seg)).toBe(true);
            });
        });
    });
});

// ============================================================
// REPORTED FINDING — UNC library roots
// ------------------------------------------------------------
// `isAbsoluteLibraryRoot` (jsx/core.jsx) explicitly accepts a UNC root
// ("//server/share/x"), but `ensureDeepFolder` rebuilds the path by splitting on
// "/" and skipping empty parts, so the leading "//" prefix is LOST: it walks
// "/server", "/server/share", ... on the current volume instead of the share.
// The final `new Folder(<uncPath>)` therefore does not exist and ensureDeepFolder
// returns null, so the save is refused — the honest-null contract from F4 is what
// stops it. No template is written and the destructive window is never entered,
// which is the half of Property 6 that matters for data safety, and that is what
// this test asserts. The out-of-library `create()` calls that happen first are a
// pre-existing gap in `ensureDeepFolder`, outside this spec's fix list; it is
// reported rather than patched here (no production file is modified by task 15).
// ============================================================
describe("Property 6 — UNC root (reported gap, asserted on the safety half)", () => {
    test("a UNC root never enters the destructive window and never writes a template", () => {
        fc.assert(
            fc.property(fc.constantFrom("//server/share/lib", "//nas/Team/CompSaver"),
                arbCategory, arbNamedSafeName, arbUsePrimaryGuard, (root, cat, name, primary) => {
                    const h = H.buildCompSaveRealm({
                        rootPath: root, fsSet: seedDisk(root),
                        injectValidateLibraryRoot: primary, liveReference: true,
                    });
                    const reply = h.run(name, cat, root);
                    let parsed = null;
                    try { parsed = JSON.parse(reply); } catch (e) { parsed = null; }

                    if (parsed && parsed.ok === true) {
                        // If ensureDeepFolder ever learns to preserve the UNC
                        // prefix, the containment clause must hold outright.
                        assertContained(parsed.folderPath, containerOf(root, "comp"));
                        assertCreatesInsideRoot(h.creates, root);
                        return;
                    }
                    expect(reply.indexOf("Error")).toBe(0);
                    expect(reply).toContain("Failed to create folder");
                    expect(h.counters.reduceCalls).toBe(0);
                    expect(h.counters.saveCalls).toEqual([]);
                    expect(h.counters.openCalls).toEqual([]);
                }),
            { numRuns: 120 }
        );
    });
});
