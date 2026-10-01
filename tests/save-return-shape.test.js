/**
 * Client save return-shape handling + back-compat unit tests.
 *
 * Spec: save-performance-optimization — Task 6.2
 * Validates: Requirements 9.1, 9.4, 9.5, 9.6, 10.1, 10.2, 11.1
 *
 * What is under test
 * ------------------
 * The `confirmSave` save flow in js/templates/templates.js — specifically the
 * host-response ("return shape") dispatch that runs inside the save
 * evalScript callback:
 *
 *   • Object path ({ ok:true, ... }) is the reduce-first host save. When it
 *     reports `needsThumbnail:true`, the client schedules EXACTLY ONE
 *     background thumbnail job (TextAnim.enqueueThumbnailRender) — deferred via
 *     setTimeout(…,0) so it never blocks the save-response callback — plus
 *     EXACTLY ONE background preview job (TextAnim.enqueuePreviewRender)
 *     (Req 9.1, 9.4, 9.5, 10.1, 10.2).
 *   • A missing (or false) `needsThumbnail` field schedules NO thumbnail job,
 *     preserving back-compat with hosts that still embed the thumbnail
 *     (Req 9.6, 11.1). The background preview is still scheduled.
 *   • The legacy monolithic path ("true") and the error paths (JSON
 *     { ok:false }, a bare error string, an empty response) keep their existing
 *     success/error dispatch unchanged (Req 11.1).
 *
 * How it is exercised
 * -------------------
 * templates.js is a browser-side script with no module system: every function
 * is a bare global declaration that depends on host globals (DOM, csInterface,
 * TextAnim, showToast, nfs()/getNodePath(), SECTIONS, …). Following the same
 * harness pattern the engine suites use (tests/helpers/loadHelpers.js), we load
 * templates.js into a `vm` sandbox, inject fully controllable fakes for every
 * global the save flow touches, and drive the PUBLIC `confirmSave` entry point.
 *
 * The two pre-save host round-trips (validateSaveRequest → "true",
 * itemExists → "false") are answered by the same fake responder — the first
 * synchronously through csInterface.evalScript, the second through the guarded
 * `callHost` the existence probe now uses; the third call (the actual save)
 * returns the per-test "result" string, which is the return shape under test.
 * A "false" reply is not the `{exists:…}` envelope, so it reads as "no existing
 * template" and oldId stays "". Jest fake timers drive the deferred
 * setTimeout chain (80ms save defer → 0ms meta/thumbnail defer → 500ms preview
 * defer), so the scheduling is fully observable and deterministic with no
 * After Effects and no real filesystem.
 */

"use strict";

const path = require("path");
const { loadHelpers } = require("./helpers/loadHelpers");
// The save flow now triggers the essential save over the async Bridge and
// drives the loading/error/background control flow through the pure save
// controller (feature: save-import-performance-redesign, task 5.1). Both are
// bare globals in the CEP panel; the harness injects the real controller plus a
// fake async `callHost` layered over the fake csInterface below.
const { runSaveController } = require("../js/core/saveController");
// Filesystem-safe naming is a bare global in the CEP panel too: index.html loads
// js/core/pathBuilders.js before js/core/utils.js, and that module is the SINGLE
// definition of getSafeName/generateTemplateId on the panel side
// (comp-template-pipeline-audit-fix, F5). The harness injects the real module
// rather than a stub so the folder paths it asserts on are derived by exactly the
// rules production uses.
const pathBuilders = require("../js/core/pathBuilders");

const TEMPLATES_REL = path.join("js", "templates", "templates.js");

// A minimal DOM element fake: enough for the input reads, button state
// mutations, and classList toggles the save flow performs.
function makeEl(props) {
    const el = Object.assign(
        {
            value: "",
            disabled: false,
            textContent: "",
            classList: {
                add: function () { },
                remove: function () { },
                contains: function () { return false; },
                toggle: function () { },
            },
            focus: function () { },
            select: function () { },
            setAttribute: function () { },
            querySelectorAll: function () { return []; },
        },
        props || {}
    );
    return el;
}

/**
 * Build a fresh confirmSave harness in a vm sandbox with controllable fakes.
 *
 * opts:
 *   saveResult  the string the SAVE evalScript returns (the return shape).
 *   name        value of the name input (defaults to a valid name).
 */
function makeHarness(opts) {
    opts = opts || {};

    const thumbCalls = [];
    const previewCalls = [];
    const toasts = [];
    const saveEvalCalls = [];
    const existsEvalCalls = [];
    // Every Node fs call the background finalizer makes, in order. The .fav
    // preservation + old-folder removal branch is only observable here.
    const fsCalls = [];
    let saveResult = opts.saveResult;

    const SECTIONS = {
        COMP: "comp",
        LAYER: "layer",
        TEXT: "text",
        TEXT_PROPS: "text_props",
        FOOTAGE: "footage",
        EFFECT: "effect",
        OVERLAY: "overlay",
        ICON: "icon",
    };

    // Node fs/path fakes. The success path only awaits writeFile (meta.json);
    // the rest are provided so no branch can throw into the catch handler.
    const fsFake = {
        promises: {
            mkdir: async function () { },
            stat: async function () { return { size: 1 }; },
            copyFile: async function () { },
            writeFile: async function (p) { fsCalls.push({ op: "writeFile", path: p }); },
            access: async function (p) { fsCalls.push({ op: "access", path: p }); },
            rm: async function (p) { fsCalls.push({ op: "rm", path: p }); },
        },
        statSync: function () {
            return { isFile: function () { return true; }, mtimeMs: 1, size: 1 };
        },
    };
    const pathFake = {
        join: function () {
            return Array.prototype.slice.call(arguments).join("/");
        },
        dirname: function (p) {
            return String(p).replace(/\/[^/]*$/, "");
        },
    };

    const DOM = {
        "input-name": makeEl({ value: opts.name !== undefined ? opts.name : "MyTemplate" }),
        "input-new-cat": makeEl({ value: "" }),
        "btn-confirm-save": makeEl({ disabled: false, textContent: "Save" }),
        "save-modal": makeEl({}),
        "cat-select-wrapper": makeEl({}),
    };

    // Single host responder shared by the sync pre-save round-trips and the
    // async-Bridge save call. The first two probes answer synchronously so
    // control reaches the save call, whose response is the return shape under test.
    function hostEval(jsx, cb) {
        if (jsx.indexOf("validateSaveRequest") !== -1) { cb("true"); return; }
        // opts.existsReply overrides the existence envelope; the default is the
        // legacy "false" (not an envelope), which reads as "nothing to overwrite".
        if (jsx.indexOf("itemExists") !== -1) {
            existsEvalCalls.push(jsx);
            cb(opts.existsReply !== undefined ? opts.existsReply : "false");
            return;
        }
        saveEvalCalls.push(jsx);
        cb(saveResult);
    }

    const injected = {
        DOM: DOM,
        SECTIONS: SECTIONS,
        MODULES: { TEMPLATES: "templates" },
        selectedCatValue: "TestCat",
        selectedSaveType: opts.selectedSaveType !== undefined ? opts.selectedSaveType : SECTIONS.COMP,
        currentSection: opts.currentSection !== undefined ? opts.currentSection : SECTIONS.COMP,
        currentCategory: "TestCat",
        currentMainModule: "templates",
        savePath: "/lib",
        rootPath: "/lib",
        libraryPaths: [],

        // Host bridge codecs are identity here (the fake csInterface already
        // hands back plain strings).
        encodeBridge: function (s) { return String(s); },
        decodeBridge: function (s) { return String(s); },

        // Pure helpers the save flow calls. getSafeName/generateTemplateId are the
        // real canonical pair from js/core/pathBuilders.js — see the require above.
        getSafeName: pathBuilders.getSafeName,
        generateTemplateId: pathBuilders.generateTemplateId,
        cleanName: pathBuilders.cleanName,
        isTextSection: function (s) { return s === SECTIONS.TEXT || s === SECTIONS.TEXT_PROPS; },
        isImageSection: function (s) { return s === SECTIONS.ICON || s === SECTIONS.OVERLAY; },
        getSaveTypeLabel: function () { return "Comp"; },

        showToast: function (msg, kind) { toasts.push({ msg: msg, kind: kind }); },
        Settings: { get: function () { return false; }, set: function () { } },
        FocusTrap: { activate: function () { }, deactivate: function () { } },
        confirm: function () { return true; },
        document: {
            querySelectorAll: function () { return []; },
            createElement: function () { return makeEl({}); },
            getElementById: function () { return null; },
        },

        // Node access shims used by the save flow. opts.nfsResult overrides the
        // resolved fs module (null simulates a panel without Node.js enabled).
        nfs: function () { return opts.nfsResult !== undefined ? opts.nfsResult : fsFake; },
        getNodePath: function () { return pathFake; },

        // The background render queue — stubbed to RECORD only. Callbacks are
        // intentionally never invoked, so the flow cannot cascade into
        // loadTemplates/refreshCardThumbnail and the jobs stay observable.
        TextAnim: {
            enqueueThumbnailRender: function (aep, thumb, cb) {
                thumbCalls.push({ aep: aep, thumb: thumb, cb: cb });
            },
            enqueuePreviewRender: function (aep, name, cb, flag) {
                previewCalls.push({ aep: aep, name: name, cb: cb, flag: flag });
            },
            attachHoverPreviews: function () { },
        },

        // Fake host bridge. The save flow makes three round-trips: only
        // validateSaveRequest still goes through csInterface.evalScript
        // synchronously; the itemExists existence probe and the save itself both
        // ride the async Bridge `callHost`. hostEval is the single responder all
        // three funnel through.
        csInterface: {
            evalScript: function (jsx, cb) { hostEval(jsx, cb); },
        },

        // Async Bridge wrapper (mirrors js/core/bridge.js callHost) over the
        // fake transport: resolves { ok:true, result } for a normal reply, or
        // { ok:false } for the empty/sentinel responses.
        callHost: function (scriptCall) {
            return new Promise(function (resolve) {
                hostEval(scriptCall, function (raw) {
                    if (!raw || raw === "EvalScript error." || raw === "undefined") {
                        resolve({ ok: false, error: raw ? String(raw) : "Empty host response" });
                        return;
                    }
                    resolve({ ok: true, result: String(raw) });
                });
            });
        },

        // The real pure save controller drives loading exit / essential-error /
        // background-error / activity-indicator control flow.
        runSaveController: runSaveController,

        // Route host timers to the (jest-faked) test-realm globals.
        setTimeout: function () { return global.setTimeout.apply(global, arguments); },
        clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
        setInterval: function () { return global.setInterval.apply(global, arguments); },
        clearInterval: function () { return global.clearInterval.apply(global, arguments); },
    };

    const handle = loadHelpers({ file: TEMPLATES_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;

    // loadTemplates is declared inside templates.js and would otherwise fan out
    // into host template scanning + DOM rendering; neutralize it so the save
    // flow's terminal loadTemplates() call is a no-op.
    handle.context.loadTemplates = function () { };

    // PNG-flow observers: the host-monolithic image save renders its optimistic
    // card and flips its thumbnail through these globals; record instead of run.
    const optimisticCards = [];
    const thumbRefreshes = [];
    handle.context.renderOptimisticCard = function (t) {
        optimisticCards.push(t);
        return {};
    };
    handle.context.refreshCardThumbnail = function (folder, thumb) {
        thumbRefreshes.push({ folder: folder, thumb: thumb });
    };

    const confirmSave = handle.get("confirmSave");
    if (typeof confirmSave !== "function") {
        throw new Error("confirmSave was not defined by templates.js");
    }

    return {
        confirmSave: confirmSave,
        thumbCalls: thumbCalls,
        previewCalls: previewCalls,
        toasts: toasts,
        saveEvalCalls: saveEvalCalls,
        existsEvalCalls: existsEvalCalls,
        fsCalls: fsCalls,
        optimisticCards: optimisticCards,
        thumbRefreshes: thumbRefreshes,
    };
}

function errorToasts(h) {
    return h.toasts.filter(function (t) { return t.kind === "error"; });
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

// ────────────────────────────────────────────────────────────────────────
// Object path with needsThumbnail:true — one thumbnail + one preview, deferred
// (Req 9.1, 9.4, 9.5, 10.1, 10.2)
// ────────────────────────────────────────────────────────────────────────
describe("object result with needsThumbnail:true (Req 9.1, 9.4, 9.5, 10.1, 10.2)", () => {
    const RESULT = JSON.stringify({
        ok: true,
        folderPath: "/lib/comp/TestCat/MyTemplate",
        templateId: "MyTemplate",
        name: "MyTemplate",
        section: "comp",
        type: "comp",
        category: "TestCat",
        needsThumbnail: true,
    });

    test("thumbnail work is deferred (does NOT block the save-response callback)", async () => {
        const h = makeHarness({ saveResult: RESULT });

        h.confirmSave();
        // Fire only the 80ms save-defer timer: the save response is delivered
        // and parsed, but the meta/thumbnail work sits behind setTimeout(…,0).
        // The async variant, because the itemExists existence probe now rides the
        // timeout-guarded callHost — its promise continuation has to drain before
        // the 80ms defer is even scheduled.
        await jest.advanceTimersByTimeAsync(80);

        expect(h.saveEvalCalls.length).toBe(1);
        // Non-blocking: nothing was enqueued synchronously in the response cb.
        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(0);
    });

    test("schedules exactly one thumbnail job and one preview job", async () => {
        const h = makeHarness({ saveResult: RESULT });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.thumbCalls.length).toBe(1);
        expect(h.previewCalls.length).toBe(1);

        // The thumbnail job targets the saved project's .aep + thumbnail.png.
        expect(h.thumbCalls[0].aep).toBe("/lib/comp/TestCat/MyTemplate/project.aep");
        expect(h.thumbCalls[0].thumb).toBe("/lib/comp/TestCat/MyTemplate/thumbnail.png");

        // The preview job rides for the same project under the saved name.
        expect(h.previewCalls[0].aep).toBe("/lib/comp/TestCat/MyTemplate/project.aep");
        expect(h.previewCalls[0].name).toBe("MyTemplate");

        // Success dispatch: no error toast surfaced.
        expect(errorToasts(h).length).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Object path WITHOUT needsThumbnail — no thumbnail job (back-compat)
// (Req 9.6, 11.1)
// ────────────────────────────────────────────────────────────────────────
describe("object result back-compat: missing/false needsThumbnail schedules no thumbnail (Req 9.6, 11.1)", () => {
    test("a missing needsThumbnail field schedules NO thumbnail job (one preview still)", async () => {
        const RESULT = JSON.stringify({
            ok: true,
            folderPath: "/lib/comp/TestCat/MyTemplate",
            templateId: "MyTemplate",
            name: "MyTemplate",
            section: "comp",
            type: "comp",
            category: "TestCat",
            // needsThumbnail intentionally omitted (legacy host embeds thumb).
        });
        const h = makeHarness({ saveResult: RESULT });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(1);
        expect(errorToasts(h).length).toBe(0);
    });

    test("needsThumbnail:false is treated the same as missing (no thumbnail job)", async () => {
        const RESULT = JSON.stringify({
            ok: true,
            folderPath: "/lib/comp/TestCat/MyTemplate",
            templateId: "MyTemplate",
            name: "MyTemplate",
            section: "comp",
            type: "comp",
            category: "TestCat",
            needsThumbnail: false,
        });
        const h = makeHarness({ saveResult: RESULT });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(1);
        expect(errorToasts(h).length).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────
// The existence envelope reaches the background finalizer as a REAL oldId
// (bug conditions 1.13 / 1.14, Req 2.13, 2.14)
//
// The host used to answer with the matched folder's NAME while this call site
// compared it against the literal "true", so `exists` was constant false, `oldId`
// was always "" and the `oldId && oldId !== templateId` branch — .fav
// preservation plus old-folder removal — was unreachable.
// ────────────────────────────────────────────────────────────────────────
describe("a real oldId activates .fav preservation and old-folder removal (Req 2.13, 2.14)", () => {
    const RESULT_WITH_OLD_ID = JSON.stringify({
        ok: true,
        folderPath: "/lib/comp/TestCat/MyTemplate",
        templateId: "MyTemplate",
        oldId: "MyTemplate__v1",
        name: "MyTemplate",
        section: "comp",
        type: "comp",
        category: "TestCat",
    });

    test("the id the host says exists is forwarded, the .fav is preserved and the old folder is removed", async () => {
        const h = makeHarness({
            saveResult: RESULT_WITH_OLD_ID,
            // The envelope: the folder that ACTUALLY exists, not a bare "true".
            existsReply: JSON.stringify({ exists: true, id: "MyTemplate__v1", section: "comp" }),
        });

        h.confirmSave();
        await jest.runAllTimersAsync();

        // Req 2.14: the section being saved rides as the fourth argument, so the
        // host no longer falls back to its "comp" default.
        expect(h.existsEvalCalls).toHaveLength(1);
        expect(h.existsEvalCalls[0]).toBe('itemExists("MyTemplate","TestCat","/lib","comp")');

        // Req 2.13: the save carries the id of the folder that exists, not "".
        expect(h.saveEvalCalls[0]).toContain('"MyTemplate__v1"');

        // Previously unreachable: preserve the favorite, then drop the old folder.
        expect(h.fsCalls).toEqual(expect.arrayContaining([
            { op: "access", path: "/lib/comp/TestCat/MyTemplate__v1/.fav" },
            { op: "writeFile", path: "/lib/comp/TestCat/MyTemplate/.fav" },
            { op: "rm", path: "/lib/comp/TestCat/MyTemplate__v1" },
        ]));
        expect(errorToasts(h).length).toBe(0);
    });

    test("an exists:false envelope keeps oldId empty, so nothing is removed", async () => {
        const h = makeHarness({
            saveResult: RESULT_WITH_OLD_ID.replace('"oldId":"MyTemplate__v1"', '"oldId":""'),
            existsReply: JSON.stringify({ exists: false, section: "comp" }),
        });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.saveEvalCalls[0]).toContain('"MyTemplate","TestCat","/lib",""');
        expect(h.fsCalls.filter((c) => c.op === "rm")).toEqual([]);
        expect(h.fsCalls.filter((c) => c.op === "access")).toEqual([]);
        expect(errorToasts(h).length).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Legacy + error return shapes stay unchanged (Req 11.1)
// ────────────────────────────────────────────────────────────────────────
describe("success/error dispatch is unchanged across return shapes (Req 11.1)", () => {
    test('a plain "true" (monolithic host save) schedules a preview and no thumbnail', async () => {
        const h = makeHarness({ saveResult: "true" });

        h.confirmSave();
        await jest.runAllTimersAsync();

        // Monolithic path: JS only kicks off the background preview render.
        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(1);
        expect(h.previewCalls[0].name).toBe("MyTemplate");
        expect(errorToasts(h).length).toBe(0);
    });

    test('a JSON { ok:false, error } is dispatched as an error (no jobs scheduled)', async () => {
        const RESULT = JSON.stringify({ ok: false, error: "boom" });
        const h = makeHarness({ saveResult: RESULT });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(0);
        const errs = errorToasts(h);
        expect(errs.length).toBeGreaterThanOrEqual(1);
        expect(errs.some(function (t) { return /boom/.test(t.msg); })).toBe(true);
    });

    test("a bare error string is dispatched as an error (no jobs scheduled)", async () => {
        const h = makeHarness({ saveResult: "Something went wrong in AE" });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(0);
        const errs = errorToasts(h);
        expect(errs.length).toBeGreaterThanOrEqual(1);
        expect(errs.some(function (t) { return /Something went wrong in AE/.test(t.msg); })).toBe(true);
    });

    test("an empty response is dispatched as an error (no jobs scheduled)", async () => {
        const h = makeHarness({ saveResult: "" });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(0);
        expect(errorToasts(h).length).toBeGreaterThanOrEqual(1);
    });
});

// ────────────────────────────────────────────────────────────────────────
// PNG (image) saves — host-side monolithic savePNGOnly
//
// The image save is a SINGLE host evalScript: savePNGOnly copies the source
// image, writes thumbnail.png + meta.json and finalizes the old folder before
// replying "true". The panel therefore needs NO Node fs for the essential
// save — the old getPNGSaveInfo + panel-side Node copy produced blank cards
// and missing folders whenever Node was unavailable or the copy failed.
// ────────────────────────────────────────────────────────────────────────
describe("png save via host-side savePNGOnly", () => {
    function pngHarness(opts) {
        return makeHarness(
            Object.assign(
                { saveResult: "true", selectedSaveType: "png", currentSection: "icon" },
                opts || {}
            )
        );
    }

    test("issues ONE savePNGOnly call with the 5-arg monolithic form", async () => {
        const h = pngHarness();

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.saveEvalCalls.length).toBe(1);
        // savePNGOnly(name, category, rootPath, imageSection, oldId) — with the
        // identity codecs the harness injects, the arguments are plain strings.
        expect(h.saveEvalCalls[0]).toBe('savePNGOnly("MyTemplate","TestCat","/lib","icon","")');
    });

    test("optimistic card points at the host-written folder + thumbnail", async () => {
        const h = pngHarness();

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.optimisticCards.length).toBe(1);
        expect(h.optimisticCards[0].folderPath).toBe("/lib/icon/TestCat/MyTemplate");
        expect(h.optimisticCards[0].thumbnailPath).toBe("/lib/icon/TestCat/MyTemplate/thumbnail.png");
    });

    test("flips the card thumbnail via refreshCardThumbnail on success", async () => {
        const h = pngHarness();

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.thumbRefreshes.length).toBe(1);
        expect(h.thumbRefreshes[0].folder).toBe("/lib/icon/TestCat/MyTemplate");
        expect(h.thumbRefreshes[0].thumb).toBe("/lib/icon/TestCat/MyTemplate/thumbnail.png");
        expect(errorToasts(h).length).toBe(0);
        expect(h.toasts.some((t) => t.kind === "success" && /Saved/.test(t.msg))).toBe(true);
    });

    test("succeeds WITHOUT Node fs (root cause: blank card + missing folder)", async () => {
        const h = pngHarness({ nfsResult: null });

        h.confirmSave();
        await jest.runAllTimersAsync();

        // The essential save is host-side; neither the card nor the thumbnail
        // refresh touches Node, so a Node-less panel still completes the save.
        expect(h.saveEvalCalls.length).toBe(1);
        expect(h.optimisticCards.length).toBe(1);
        expect(h.thumbRefreshes.length).toBe(1);
        expect(errorToasts(h).length).toBe(0);
    });

    test("overlay section saves under the overlay folder", async () => {
        const h = pngHarness({ currentSection: "overlay" });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.saveEvalCalls[0]).toBe('savePNGOnly("MyTemplate","TestCat","/lib","overlay","")');
        expect(h.optimisticCards[0].folderPath).toBe("/lib/overlay/TestCat/MyTemplate");
        expect(h.thumbRefreshes[0].folder).toBe("/lib/overlay/TestCat/MyTemplate");
    });

    test("an ERROR: reply surfaces the stripped message and renders NO card", async () => {
        const h = pngHarness({
            saveResult:
                "ERROR:No image layer found in timeline selection. Select a PNG/JPG/etc layer in the Timeline (not the Project panel).",
        });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.optimisticCards.length).toBe(0);
        expect(h.thumbRefreshes.length).toBe(0);
        expect(h.thumbCalls.length).toBe(0);
        expect(h.previewCalls.length).toBe(0);
        const errs = errorToasts(h);
        expect(errs.some((t) => /No image layer found/.test(t.msg))).toBe(true);
    });

    test("a non-true, non-ERROR reply is dispatched as an error (no card)", async () => {
        const h = pngHarness({ saveResult: "Something went wrong in AE" });

        h.confirmSave();
        await jest.runAllTimersAsync();

        expect(h.optimisticCards.length).toBe(0);
        expect(h.thumbRefreshes.length).toBe(0);
        expect(errorToasts(h).length).toBeGreaterThanOrEqual(1);
    });
});
