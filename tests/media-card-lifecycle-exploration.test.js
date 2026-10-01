// ============================================================
// tests/media-card-lifecycle-exploration.test.js
//
// Feature: media-card-lifecycle-edge-fixes (bugfix spec, task 1)
//
// BUG CONDITION EXPLORATION — failure IS the deliverable
// ------------------------------------------------------
// This file exists to surface counterexamples on UNFIXED source, so each
// hypothesised root cause is confirmed (or refuted) before a fix is written.
//
//   E1, E2, E3, E4, E5, E6, E7, E8  are EXPECTED TO FAIL here.
//   E9, E10                          are refutation guards, EXPECTED TO PASS.
//
// A passing E1-E8 on unfixed source would mean the hypothesis is wrong, the
// fix already landed, or the case does not exercise the path it claims to —
// none of which may be papered over by weakening an assertion.
//
// E3 IS A PERMANENT DIAGNOSTIC. See the comment above it: design decision D1
// chose read-side derivation, so E3 stays red after every fix in this spec
// lands. It must never be "fixed" and must never be deleted.
//
// What is under test
// ------------------
// The REAL entry points of js/templates/templates.js, loaded through
// tests/helpers/loadHelpers.js with `lenient: false` (the harness shape
// tests/performance/startup-warm-paint.property.test.js uses), driven over:
//
//   - a REAL parsed DOM tree (tests/helpers/miniDom.js),
//   - a REAL persisted LibraryIndex round-tripped through
//     serialize() / tryParse() (js/core/persistence.js),
//   - the REAL panel sanitizers from js/core/pathBuilders.js,
//   - the REAL TemplateCatalog (js/templates/templateCatalog.js), evaluated
//     into the same vm realm,
//   - the REAL save controller (js/core/saveController.js) for the confirmSave
//     PNG flow.
//
// The BUG 3 oracle is the REAL ExtendScript host realm from
// tests/helpers/compPipelineHarness.js, whose CORE_PURE_NAMES already exposes
// `cleanStr` and `getSafeName` — the same mechanism
// tests/sanitizer-cross-implementation.property.test.js uses. Nothing about
// either sanitizer is re-implemented here.
//
// Every case is scoped to concrete deterministic inputs rather than generated:
// each bug reproduces on a fixed input, and generation belongs to the
// fix-checking properties in the preservation suite.
//
// No file under js/ or jsx/ is modified by this task.
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
//   1.10, 1.11, 1.12**
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadHelpers, REPO_ROOT } = require("./helpers/loadHelpers.js");
const SA = require("./helpers/static-analysis");
const { createMiniDocument } = require("./helpers/miniDom.js");
const { LibraryIndex } = require("../js/core/persistence.js");
const persistence = require("../js/core/persistence.js");
const pathBuilders = require("../js/core/pathBuilders.js");
const { runSaveController } = require("../js/core/saveController.js");
const H = require("./helpers/compPipelineHarness.js");

const TEMPLATES_REL = path.join("js", "templates", "templates.js");
// The markup the panel is built from (Shell plus View_Fragments), repo-relative.
const MARKUP_FILES = SA.listMarkupFiles();
const CATALOG_SRC = fs.readFileSync(
    path.join(REPO_ROOT, "js", "templates", "templateCatalog.js"),
    "utf8"
);

// ─── The host realm: the BUG 3 parity oracle ────────────────────────────────
const hostCore = H.loadHostCore();
const hostCleanStr = hostCore.get("cleanStr");
const hostGetSafeName = hostCore.get("getSafeName");
const hostGenerateTemplateId = hostCore.get("generateTemplateId");
if (typeof hostCleanStr !== "function" || typeof hostGetSafeName !== "function" ||
    typeof hostGenerateTemplateId !== "function") {
    throw new Error("host realm did not expose cleanStr / getSafeName / generateTemplateId");
}

/** The category segment the host writes: getSafeName(cleanStr(cat)). */
function hostCategorySegment(cat) {
    return hostGetSafeName(hostCleanStr(cat));
}

// ─── Real shared panel modules ──────────────────────────────────────────────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
});

// The six card grids index.html defines; resolveSectionGridId() picks one.
const GRID_IDS = [
    "comp-list-container",
    "icon-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container",
];

// ─── Counterexample recorder ────────────────────────────────────────────────
// Observations are recorded BEFORE the assertion runs, so a failing case still
// reports the concrete values that make it fail.
const COUNTEREXAMPLES = [];
function record(caseId, note, data) {
    COUNTEREXAMPLES.push({ caseId: caseId, note: note, data: data });
}

afterAll(function () {
    if (COUNTEREXAMPLES.length === 0) return;
    const lines = ["", "═══ RECORDED COUNTEREXAMPLES (unfixed source) ═══"];
    COUNTEREXAMPLES.forEach(function (entry) {
        lines.push("");
        lines.push("[" + entry.caseId + "] " + entry.note);
        lines.push(JSON.stringify(entry.data, null, 2));
    });
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
});

// ─── Media folder shape (test INPUT data, not code under test) ──────────────
// The media writer composes <root>/<section>/<mediaSafeName(cat)>/<idSegment>,
// where the id segment is "media" followed by one dash-separated 4-hex-digit
// group per code unit of the entry id (js/core/fastMediaEngine.js). Reproduced
// here only to build a realistic seed path.
function mediaIdFolderSegmentFixture(id) {
    let encoded = "media";
    const value = String(id);
    for (let i = 0; i < value.length; i++) {
        let code = value.charCodeAt(i).toString(16);
        while (code.length < 4) code = "0" + code;
        encoded += "-" + code;
    }
    return encoded;
}

// ─── The panel realm ────────────────────────────────────────────────────────
/**
 * One panel world: a fresh vm realm holding the real templates.js and the real
 * TemplateCatalog, a real parsed DOM with all six grids, and the real panel
 * sanitizers. Only the environment is substituted at the boundary — timers are
 * recorded rather than run, and `nfs()` exposes an existsSync that always
 * misses (there is no disk here).
 */
function createPanelRealm(opts) {
    opts = opts || {};

    const document = createMiniDocument();
    const grids = {};
    GRID_IDS.forEach(function (id) {
        const grid = document.createElement("div");
        grid.id = id;
        grid.className = "card-grid";
        document.body.appendChild(grid);
        grids[id] = grid;
    });

    const timers = [];
    const toasts = [];
    const spies = { saveLibraryIndex: 0, updateCount: 0, updateCustomSelect: 0 };
    const indexHolder = { index: opts.libraryIndex || null };
    const existsPaths = [];

    const DOM = Object.assign(
        { "search-box": { value: opts.search || "" } },
        opts.DOM || {}
    );

    const injected = {
        window: { requestAnimationFrame: null },
        document: document,
        DOM: DOM,

        // Real pure helpers from the shipped modules.
        SECTIONS: SECTIONS,
        IMAGE_SECTIONS: IMAGE_SECTIONS,
        escapeAttr: utils.get("escapeAttr"),
        escapeHTML: utils.get("escapeHTML"),
        getTemplateSection: utils.get("getTemplateSection"),
        normalizeSectionName: utils.get("normalizeSectionName"),
        isTextSection: utils.get("isTextSection"),
        isImageSection: utils.get("isImageSection"),

        // Real panel sanitizers. `cleanName` is a bare panel global in
        // production (index.html loads pathBuilders.js before utils.js), so it
        // is injected here too — otherwise the BUG 3 fix would be silently
        // bypassed by its own typeof guard when it lands.
        getSafeName: pathBuilders.getSafeName,
        generateTemplateId: pathBuilders.generateTemplateId,
        cleanName: pathBuilders.cleanName,
        normalizeFolderPath: persistence.normalizeFolderPath,

        // Panel state templates.js reads and (for allTemplates) reassigns.
        allTemplates: opts.allTemplates || [],
        currentSection: opts.currentSection || SECTIONS.ICON,
        currentCategory: opts.currentCategory || "All",
        tmpBulkSelected: [],
        libraryPaths: opts.libraryPaths || ["C:/lib"],
        rootPath: opts.rootPath || "C:/lib",
        savePath: opts.savePath || "C:/lib",

        // Persistence seam.
        getLibraryIndex: function () { return indexHolder.index; },
        saveLibraryIndex: function () { spies.saveLibraryIndex++; },

        // No disk in this realm. renderOptimisticCard's probe must miss, and
        // refreshCardThumbnail's mtime probe must be skipped (no statSync).
        nfs: function () {
            return {
                existsSync: function (p) { existsPaths.push(p); return false; },
            };
        },

        // Collaborators outside templates.js.
        updateCount: function () { spies.updateCount++; },
        updateCustomSelect: function () { spies.updateCustomSelect++; },
        Settings: { get: function () { return []; }, set: function () { } },
        TextAnim: { attachHoverPreviews: function () { } },
        showToast: function (msg, kind) { toasts.push({ msg: msg, kind: kind }); },

        // Timers are recorded, never run: the deferred startup queue and the
        // background reconcile must not fire during an observation.
        setTimeout: function (fn, delay) {
            timers.push({ fn: fn, delay: delay });
            return timers.length;
        },
        clearTimeout: function () { },
    };

    const handle = loadHelpers({ file: TEMPLATES_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;

    // The real catalog, in the same realm, exactly as index.html loads it
    // (after utils.js, before templates.js — declaration order is irrelevant
    // because templates.js resolves TemplateCatalog at call time).
    vm.runInContext(CATALOG_SRC, handle.context, { filename: "templateCatalog.js" });

    return {
        context: handle.context,
        document: document,
        grids: grids,
        timers: timers,
        toasts: toasts,
        spies: spies,
        existsPaths: existsPaths,
        DOM: DOM,
        setIndex: function (index) { indexHolder.index = index; },
        getIndex: function () { return indexHolder.index; },
        activeGrid: function () { return grids[handle.context.resolveSectionGridId()]; },
    };
}

/** Persist entries through the real serialize / tryParse round trip. */
function persistIndex(entries, validityKey) {
    const source = new LibraryIndex({ validityKey: validityKey || "vk-1" });
    for (let i = entries.length - 1; i >= 0; i--) source.insertAtHead(entries[i]);
    const parsed = LibraryIndex.tryParse(source.serialize());
    if (!parsed.ok) throw new Error("seed index failed to round-trip");
    return parsed.index;
}

// ════════════════════════════════════════════════════════════════════════════
// BUG 1 — warm-paint cross-session blank card (clauses 1.1, 1.2)
// ════════════════════════════════════════════════════════════════════════════
describe("BUG 1 — a persisted thumbnail blanks on reopen", function () {
    const ROOT = "C:/lib";
    const ICON_FOLDER = ROOT + "/icon/Logos/Acme";
    const MEDIA_FOLDER = ROOT + "/icon/Logos/media-0061";

    /**
     * The exact entry shape renderOptimisticCard + refreshCardThumbnail leave
     * behind: thumbnailPath and thumbStatus recorded, `thumbnail` never
     * written (templates.js renderOptimisticCard's 8-field literal, then
     * refreshCardThumbnail's 2-field patchEntry).
     */
    function seedEntries() {
        return [
            {
                id: "Acme",
                name: "Acme",
                category: "Logos",
                section: SECTIONS.ICON,
                type: SECTIONS.ICON,
                folderPath: ICON_FOLDER,
                sourcePath: ROOT,
                thumbnailPath: ICON_FOLDER + "/thumbnail.png",
                thumbStatus: "ready",
                favorite: false,
            },
            {
                id: "media-a",
                name: "clip",
                category: "Logos",
                section: SECTIONS.ICON,
                type: "media",
                mediaType: "video",
                folderPath: MEDIA_FOLDER,
                sourcePath: "D:/incoming/clip.mp4",
                thumbnailPath: MEDIA_FOLDER + "/thumbnail.png",
                thumbStatus: "ready",
                favorite: false,
            },
        ];
    }

    function buildWarmRealm() {
        const li = persistIndex(seedEntries());
        const panel = createPanelRealm({
            libraryIndex: li,
            currentSection: SECTIONS.ICON,
            currentCategory: "All",
            libraryPaths: [ROOT],
            rootPath: ROOT,
        });
        return { panel: panel, li: li };
    }

    test("E1 — startupWarmPaint renders placeholder artwork for an on-disk thumbnail", function () {
        // **Validates: Requirements 1.1, 1.2**
        const world = buildWarmRealm();
        const ctx = world.panel.context;

        const result = ctx.startupWarmPaint(world.li);

        const entry = ctx.allTemplates[0];
        const markup = ctx.renderTemplateCardMarkup(entry, ctx.currentSection, []);
        const mediaMarkup = ctx.renderTemplateCardMarkup(ctx.allTemplates[1], ctx.currentSection, []);

        record("E1", "warm paint painted a card whose thumbnail.png is on disk as a placeholder", {
            warmPaint: result,
            entryThumbnailPath: entry.thumbnailPath,
            entryThumbStatus: entry.thumbStatus,
            entryThumbnail: entry.thumbnail,
            entryHasThumbnailKey: Object.prototype.hasOwnProperty.call(entry, "thumbnail"),
            nonMediaThumbHTML: markup.slice(markup.indexOf('<div class="thumb-box">'), markup.indexOf("</div>", markup.indexOf('<div class="thumb-box">')) + 6),
            mediaThumbHTML: mediaMarkup.slice(mediaMarkup.indexOf('<div class="thumb-box">'), mediaMarkup.indexOf("</div>", mediaMarkup.indexOf('<div class="thumb-box">')) + 6),
            gridHTMLContainsImgSrc: /<img class="thumb-img" src="/.test(world.panel.activeGrid().innerHTML),
            filesystemCallsDuringWarmPaint: world.panel.existsPaths.length,
        });

        expect(result.painted).toBe(true);
        expect(entry.thumbnailPath).toBe(ICON_FOLDER + "/thumbnail.png");
        expect(markup).toContain('<img class="thumb-img" src="file:///');
    });

    test("E2 — loadTemplates' warm branch blanks it too (both warm-paint implementations)", function () {
        // **Validates: Requirements 1.1, 1.2**
        const world = buildWarmRealm();
        const ctx = world.panel.context;

        ctx.loadTemplates();

        const entry = ctx.allTemplates[0];
        const markup = ctx.renderTemplateCardMarkup(entry, ctx.currentSection, []);

        record("E2", "the second warm-paint implementation (loadTemplates:47-58) blanks the same card", {
            entriesAdopted: ctx.allTemplates.length,
            entryThumbnail: entry.thumbnail,
            entryThumbnailPath: entry.thumbnailPath,
            thumbHTML: markup.slice(markup.indexOf('<div class="thumb-box">'), markup.indexOf("</div>", markup.indexOf('<div class="thumb-box">')) + 6),
            backgroundReconcileScheduled: world.panel.timers.length,
        });

        expect(ctx.allTemplates.length).toBe(2);
        expect(markup).toContain('<img class="thumb-img" src="file:///');
    });

    // ────────────────────────────────────────────────────────────────────────
    // E3 IS A PERMANENT DIAGNOSTIC — DO NOT FIX, DO NOT DELETE.
    //
    // It proves the WRITE-side half of hypothesis 1: refreshCardThumbnail
    // computes the cache-busted display URL, writes it to allTemplates, and
    // deliberately withholds it from the library-index entry it patches in the
    // same breath.
    //
    // Design decision D1 resolved BUG 1 by deriving the display URL on READ,
    // in both warm-paint branches, and explicitly declined to widen the write
    // side: a write-side fix cannot repair entries already persisted by
    // earlier sessions, and a persisted busting token is stale by construction
    // (it is the one the embedded browser already cached against).
    //
    // So this case stays RED after every fix in this spec lands. That is the
    // intended end state, not an outstanding defect. Its post-fix inverse —
    // asserting the persisted entry carries thumbStatus and thumbnailPath and
    // NO thumbnail — is P2c in tests/media-card-lifecycle-preservation.property.test.js,
    // which is what keeps the decision enforced rather than merely documented.
    // ────────────────────────────────────────────────────────────────────────
    test("E3 [DIAGNOSTIC — stays failing after the fix by design] refreshCardThumbnail withholds `thumbnail` from the index", function () {
        // **Validates: Requirements 1.1**
        //
        // The save-session pair, driven through the real entry points: an
        // empty index, then renderOptimisticCard (which inserts an 8-field
        // index entry AND a separate allTemplates record — two distinct
        // objects, unlike warm paint's shared-identity model), then the
        // thumbnail completion.
        const li = persistIndex([]);
        const panel = createPanelRealm({
            libraryIndex: li,
            allTemplates: [],
            currentSection: SECTIONS.ICON,
            currentCategory: "All",
            libraryPaths: [ROOT],
            rootPath: ROOT,
        });
        const ctx = panel.context;

        const tpl = ctx.renderOptimisticCard({
            name: "Acme",
            category: "Logos",
            section: SECTIONS.ICON,
            type: SECTIONS.ICON,
            sourcePath: ROOT,
            folderPath: ICON_FOLDER,
            thumbnailPath: ICON_FOLDER + "/thumbnail.png",
        });

        const entryAfterInsert = li.getEntry(ICON_FOLDER);

        ctx.refreshCardThumbnail(ICON_FOLDER, ICON_FOLDER + "/thumbnail.png");

        const persisted = li.getEntry(ICON_FOLDER);
        const inMemory = ctx.allTemplates[0];

        record("E3", "the display URL was computed and written to the model, then withheld from the persisted entry", {
            insertedEntryKeys: Object.keys(entryAfterInsert),
            insertedEntryHasThumbnailKey:
                Object.prototype.hasOwnProperty.call(entryAfterInsert, "thumbnail"),
            persistedEntryKeys: Object.keys(persisted),
            persistedThumbnail: persisted.thumbnail,
            persistedThumbnailPath: persisted.thumbnailPath,
            persistedThumbStatus: persisted.thumbStatus,
            inMemoryThumbnail: inMemory.thumbnail,
            optimisticRecordIsTheIndexEntry: tpl === persisted,
            note: "renderOptimisticCard writes two distinct objects, so the URL lands only on the model one",
        });

        expect(typeof persisted.thumbnail).toBe("string");
        expect(persisted.thumbnail).not.toBe("");
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BUG 2 — media folder path reconstruction in the UI mutation helpers
//         (clauses 1.3, 1.4)
// ════════════════════════════════════════════════════════════════════════════
describe("BUG 2 — media delete and patch never reach the backing index entry", function () {
    const ROOT = "C:/lib";
    const MEDIA_ID = "media-1730000000000-1";
    const MEDIA_FOLDER = ROOT + "/footage/Broll/" + mediaIdFolderSegmentFixture(MEDIA_ID);
    const NAME = "clip";
    const CAT = "Broll";

    function mediaEntry() {
        return {
            id: MEDIA_ID,
            name: NAME,
            category: CAT,
            section: SECTIONS.FOOTAGE,
            type: "media",
            mediaType: "video",
            folderPath: MEDIA_FOLDER,
            // Media entries carry the ORIGINAL imported file path here, never a
            // library root (js/core/fastMediaEngine.js).
            sourcePath: "D:/incoming/clip.mp4",
            mediaFile: "clip.mp4",
            thumbnailPath: MEDIA_FOLDER + "/thumbnail.png",
            thumbStatus: "ready",
            favorite: false,
        };
    }

    function buildMediaRealm() {
        const li = persistIndex([mediaEntry()]);
        const panel = createPanelRealm({
            libraryIndex: li,
            allTemplates: li._entries,
            currentSection: SECTIONS.FOOTAGE,
            currentCategory: "All",
            libraryPaths: [ROOT],
            rootPath: ROOT,
        });
        return { panel: panel, li: li };
    }

    test("E4 — removeUITemplate leaves the persisted entry in place and raises needsFullScan", function () {
        // **Validates: Requirements 1.3, 1.4**
        const world = buildMediaRealm();
        const ctx = world.panel.context;

        const reconstructed = ctx._getTemplateFolderPath(NAME, CAT);
        const sizeBefore = world.li.size();

        ctx.removeUITemplate(NAME, CAT);

        record("E4", "the helper addressed a name-derived folder that is not in the index", {
            realFolderPath: MEDIA_FOLDER,
            reconstructedFolderPath: reconstructed,
            reconstructedHasMediaSegment: /\/media-/.test(reconstructed),
            sizeBefore: sizeBefore,
            sizeAfter: world.li.size(),
            stillHasEntry: world.li.has(MEDIA_FOLDER),
            needsFullScan: world.li.needsFullScan(),
            lastError: world.li.lastError(),
            allTemplatesLength: ctx.allTemplates.length,
        });

        expect(world.li.has(MEDIA_FOLDER)).toBe(false);
        expect(world.li.needsFullScan()).toBe(false);
    });

    test("E5 — patchUITemplate never lands the patch on the persisted entry", function () {
        // **Validates: Requirements 1.3, 1.4**
        const world = buildMediaRealm();
        const ctx = world.panel.context;

        const reconstructed = ctx._getTemplateFolderPath(NAME, CAT);

        ctx.patchUITemplate(NAME, CAT, { favorite: true });

        const persisted = world.li.getEntry(MEDIA_FOLDER);

        record("E5", "the patch was applied to allTemplates only; the index rolled the failed mutation back", {
            realFolderPath: MEDIA_FOLDER,
            reconstructedFolderPath: reconstructed,
            persistedFavorite: persisted ? persisted.favorite : "<no entry>",
            inMemoryFavorite: ctx.allTemplates[0] ? ctx.allTemplates[0].favorite : "<no record>",
            needsFullScan: world.li.needsFullScan(),
            lastError: world.li.lastError(),
        });

        expect(persisted).not.toBeNull();
        expect(persisted.favorite).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BUG 3 — category sanitization parity for PNG saves (clauses 1.5, 1.6)
// ════════════════════════════════════════════════════════════════════════════
describe("BUG 3 — the panel's category segment diverges from the host's", function () {
    const CASES = ["My\tCat", "My  Cat", " My Cat ", "My\r\nCat"];

    test("E6 — the panel segment does not equal getSafeName(cleanStr(cat)) for whitespace-bearing categories", function () {
        // **Validates: Requirements 1.5, 1.6**
        const panel = createPanelRealm({ currentSection: SECTIONS.ICON });
        const ctx = panel.context;

        // The panel's single derivation rule for that segment. Before the fix
        // there is no named helper and both PNG call sites inline
        // `getSafeName(cat)`; after the fix `safeCategorySegment` is that one
        // rule. Reading whichever exists is what lets this case flip to
        // passing when the fix lands, without ever restating the rule here.
        const panelSegment = typeof ctx.safeCategorySegment === "function"
            ? ctx.safeCategorySegment
            : ctx.getSafeName;

        const observed = CASES.map(function (cat) {
            return {
                category: JSON.stringify(cat),
                panel: panelSegment(cat),
                host: hostCategorySegment(cat),
                equal: panelSegment(cat) === hostCategorySegment(cat),
            };
        });

        record("E6", "panel vs host category segment, per input", {
            usedNamedHelper: typeof ctx.safeCategorySegment === "function",
            cases: observed,
        });

        observed.forEach(function (row) {
            expect(row.panel).toBe(row.host);
        });
    });

    describe("E7 — both PNG derivation sites address the wrong folder", function () {
        beforeEach(function () { jest.useFakeTimers(); });
        afterEach(function () { jest.clearAllTimers(); jest.useRealTimers(); });

        // A minimal element fake: enough for the input reads, button state
        // mutations and classList toggles the save flow performs.
        function makeEl(props) {
            return Object.assign(
                {
                    value: "",
                    disabled: false,
                    textContent: "",
                    checked: false,
                    classList: {
                        add: function () { }, remove: function () { },
                        contains: function () { return false; }, toggle: function () { },
                    },
                    focus: function () { }, select: function () { },
                    setAttribute: function () { },
                    style: {},
                    querySelector: function () { return null; },
                    querySelectorAll: function () { return []; },
                },
                props || {}
            );
        }

        /**
         * The real confirmSave PNG flow, driven end to end: validateSaveRequest
         * -> itemExists -> savePNGOnly, then the deferred optimistic card and
         * thumbnail refresh. renderOptimisticCard / refreshCardThumbnail are
         * replaced with recorders so the two derived folder paths are
         * observable; everything upstream of them is production code.
         */
        function pngHarness(category) {
            const optimisticCards = [];
            const thumbRefreshes = [];
            const saveCalls = [];
            const toasts = [];

            const DOM = {
                "input-name": makeEl({ value: "MyTemplate" }),
                "input-new-cat": makeEl({ value: "" }),
                "btn-confirm-save": makeEl({ disabled: false, textContent: "Save" }),
                "save-modal": makeEl({}),
                "cat-select-wrapper": makeEl({}),
                "search-box": makeEl({ value: "" }),
            };

            function hostEval(jsx, cb) {
                if (jsx.indexOf("validateSaveRequest") !== -1) { cb("true"); return; }
                if (jsx.indexOf("itemExists") !== -1) { cb("false"); return; }
                saveCalls.push(jsx);
                cb("true");
            }

            const injected = {
                DOM: DOM,
                SECTIONS: SECTIONS,
                IMAGE_SECTIONS: IMAGE_SECTIONS,
                MODULES: { TEMPLATES: "templates" },
                selectedCatValue: category,
                selectedSaveType: "png",
                currentSection: SECTIONS.ICON,
                currentCategory: "All",
                currentMainModule: "templates",
                savePath: "/lib",
                rootPath: "/lib",
                libraryPaths: [],
                allTemplates: [],
                tmpBulkSelected: [],

                // Identity codecs: the fake host hands back plain strings.
                encodeBridge: function (s) { return String(s); },
                decodeBridge: function (s) { return String(s); },

                // Real panel sanitizers, including cleanName (see the realm
                // builder's note): the fix must be exercised, not bypassed.
                getSafeName: pathBuilders.getSafeName,
                generateTemplateId: pathBuilders.generateTemplateId,
                cleanName: pathBuilders.cleanName,
                normalizeFolderPath: persistence.normalizeFolderPath,

                escapeAttr: utils.get("escapeAttr"),
                escapeHTML: utils.get("escapeHTML"),
                getTemplateSection: utils.get("getTemplateSection"),
                normalizeSectionName: utils.get("normalizeSectionName"),
                isTextSection: utils.get("isTextSection"),
                isImageSection: utils.get("isImageSection"),
                getSaveTypeLabel: function () { return "Image"; },

                showToast: function (msg, kind) { toasts.push({ msg: msg, kind: kind }); },
                Settings: { get: function () { return false; }, set: function () { } },
                FocusTrap: { activate: function () { }, deactivate: function () { } },
                confirm: function () { return true; },
                document: {
                    querySelectorAll: function () { return []; },
                    createElement: function () { return makeEl({}); },
                    getElementById: function () { return null; },
                },
                nfs: function () { return null; },
                getNodePath: function () { return null; },
                TextAnim: {
                    enqueueThumbnailRender: function () { },
                    enqueuePreviewRender: function () { },
                    attachHoverPreviews: function () { },
                },
                csInterface: { evalScript: function (jsx, cb) { hostEval(jsx, cb); } },
                callHost: function (scriptCall) {
                    return new Promise(function (resolve) {
                        hostEval(scriptCall, function (raw) {
                            if (!raw) { resolve({ ok: false, error: "Empty host response" }); return; }
                            resolve({ ok: true, result: String(raw) });
                        });
                    });
                },
                runSaveController: runSaveController,
                setTimeout: function () { return global.setTimeout.apply(global, arguments); },
                clearTimeout: function () { return global.clearTimeout.apply(global, arguments); },
            };

            const handle = loadHelpers({ file: TEMPLATES_REL, injected: injected, lenient: false });
            if (handle.error) throw handle.error;
            handle.context.loadTemplates = function () { };
            handle.context.renderOptimisticCard = function (t) {
                optimisticCards.push(t);
                return {};
            };
            handle.context.refreshCardThumbnail = function (folder, thumb) {
                thumbRefreshes.push({ folder: folder, thumb: thumb });
            };

            return {
                context: handle.context,
                confirmSave: handle.get("confirmSave"),
                optimisticCards: optimisticCards,
                thumbRefreshes: thumbRefreshes,
                saveCalls: saveCalls,
                toasts: toasts,
            };
        }

        test("the optimistic card and the thumbnail refresh both miss the host-written folder", async function () {
            // **Validates: Requirements 1.5, 1.6**
            const CATEGORY = "My  Cat";
            const h = pngHarness(CATEGORY);

            h.confirmSave();
            await jest.runAllTimersAsync();

            const hostFolder = "/lib/icon/" + hostCategorySegment(CATEGORY) + "/" +
                hostGenerateTemplateId("MyTemplate");

            record("E7", "one host folder, two panel paths that do not name it", {
                category: JSON.stringify(CATEGORY),
                hostCall: h.saveCalls[0],
                hostFolder: hostFolder,
                optimisticCardFolderPath: h.optimisticCards.length ? h.optimisticCards[0].folderPath : "<none>",
                optimisticCardThumbnailPath: h.optimisticCards.length ? h.optimisticCards[0].thumbnailPath : "<none>",
                refreshFolder: h.thumbRefreshes.length ? h.thumbRefreshes[0].folder : "<none>",
                refreshThumb: h.thumbRefreshes.length ? h.thumbRefreshes[0].thumb : "<none>",
                tabCategoryForReference: {
                    category: JSON.stringify("My\tCat"),
                    host: "/lib/icon/" + hostCategorySegment("My\tCat"),
                    panel: "/lib/icon/" + pathBuilders.getSafeName("My\tCat"),
                },
            });

            expect(h.saveCalls.length).toBe(1);
            expect(h.optimisticCards.length).toBe(1);
            expect(h.thumbRefreshes.length).toBe(1);
            // Site 1: onEssentialSuccess (templates.js:3666).
            expect(h.optimisticCards[0].folderPath).toBe(hostFolder);
            // Site 2: scheduleBackground's PNG branch (templates.js:3400).
            expect(h.thumbRefreshes[0].folder).toBe(hostFolder);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BUG 5 — the staleness signal has no callers (clauses 1.9, 1.10)
// ════════════════════════════════════════════════════════════════════════════
describe("BUG 5 — an unmirrored derived-field write is undetectable", function () {
    const ROOT = "C:/lib";

    function templateRecord(n, category) {
        return {
            id: "t" + n,
            name: "T" + n,
            category: category,
            section: SECTIONS.COMP,
            type: SECTIONS.COMP,
            folderPath: ROOT + "/comp/" + category + "/T" + n,
            sourcePath: ROOT,
            favorite: false,
            thumbnail: "",
        };
    }

    test("E8 — catalogSourceChanged() cannot see a middle-of-array category change", async function () {
        // **Validates: Requirements 1.9, 1.10**
        const seeds = [0, 1, 2, 3, 4].map(function (n) { return templateRecord(n, "Logos"); });
        const li = persistIndex(seeds);
        const panel = createPanelRealm({
            libraryIndex: li,
            allTemplates: li._entries,
            currentSection: SECTIONS.COMP,
            currentCategory: "All",
            libraryPaths: [ROOT],
            rootPath: ROOT,
        });
        const ctx = panel.context;
        const TemplateCatalog = ctx.TemplateCatalog;

        // The catalog is built and stamped against the current model.
        ctx.ensureCatalogFresh();
        expect(ctx.catalogSourceChanged()).toBe(false);

        const arrayBefore = ctx.allTemplates;
        const lengthBefore = ctx.allTemplates.length;
        const firstBefore = ctx.allTemplates[0];
        const lastBefore = ctx.allTemplates[lengthBefore - 1];
        const revisionBefore = ctx._templatesRevision;

        // One scan record differs, on the MIDDLE record, in `category` only —
        // a field the catalog derives into searchHay, counts and sectionCats.
        // No adds (every record matches by id), no removes (every allTemplates
        // record is present in the scan).
        const flat = ctx.allTemplates.map(function (r, i) {
            const clone = JSON.parse(JSON.stringify(r));
            if (i === 2) clone.category = "Brands";
            return clone;
        });
        const scannedByRoot = {};
        scannedByRoot["r:" + ROOT] = flat;

        ctx.startupReconcileScanned(null, null, [ROOT], scannedByRoot, flat, "vk-2");
        // LibraryIndex.reconcile resolves without a timer for a list this
        // small; two microtask turns let its .then chain settle.
        await Promise.resolve();
        await Promise.resolve();

        const changed = ctx.catalogSourceChanged();

        record("E8", "the field write landed on the model; every freshness probe still reads clean", {
            modelCategoryAfter: ctx.allTemplates[2].category,
            catalogSourceChanged: changed,
            templatesRevisionBefore: revisionBefore,
            templatesRevisionAfter: ctx._templatesRevision,
            catalogSourceStamp: TemplateCatalog.sourceStamp(),
            arrayIdentityUnchanged: ctx.allTemplates === arrayBefore,
            lengthUnchanged: ctx.allTemplates.length === lengthBefore,
            firstElementUnchanged: ctx.allTemplates[0] === firstBefore,
            lastElementUnchanged: ctx.allTemplates[ctx.allTemplates.length - 1] === lastBefore,
            catalogSize: TemplateCatalog.size(),
            staleCategoryCounts: TemplateCatalog.sectionCounts(SECTIONS.COMP).cats,
            searchForNewCategoryFinds: TemplateCatalog.idsFor(SECTIONS.COMP, "All", "brands"),
            searchForOldCategoryStillFinds: TemplateCatalog.idsFor(SECTIONS.COMP, "All", "logos"),
        });

        // The mutation really happened, and it really is invisible to the
        // shape probes — that is the gap the signal exists to close.
        expect(ctx.allTemplates[2].category).toBe("Brands");
        expect(ctx.allTemplates).toBe(arrayBefore);
        expect(ctx.allTemplates.length).toBe(lengthBefore);
        expect(changed).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Refutation guards — E9 and E10 are EXPECTED TO PASS on unfixed source.
// A failure here refutes a requirements clause and re-opens the bug; it is
// reported, never worked around.
//
// E9 has since been inverted, by approval, because task 8.1 deleted the very
// declaration its pre-fix form recorded. See the comment inside it. E10 is
// unchanged and still passes in its original form.
// ════════════════════════════════════════════════════════════════════════════
describe("refutation guards for the two bugs that do not reproduce", function () {
    function walkJsFiles(dir, out) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.forEach(function (entry) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walkJsFiles(full, out); return; }
            if (/\.js$/i.test(entry.name)) out.push(full);
        });
        return out;
    }

    test("E9 — `renderIcons` has zero occurrences of any kind in js/** and index.html (clause 1.8)", function () {
        const files = walkJsFiles(path.join(REPO_ROOT, "js"), []);
        MARKUP_FILES.forEach(function (rel) { files.push(path.join(SA.ROOT, rel)); });

        const hits = [];
        files.forEach(function (file) {
            const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
            lines.forEach(function (line, i) {
                if (!/\brenderIcons\b/.test(line)) return;
                hits.push({
                    file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"),
                    line: i + 1,
                    text: line.trim(),
                    isDeclaration: /^\s*function\s+renderIcons\s*\(/.test(line),
                });
            });
        });

        const references = hits.filter(function (h) { return !h.isDeclaration; });

        record("E9", "every renderIcons occurrence in js/** and index.html", {
            filesScanned: files.length,
            occurrences: hits,
            nonDeclarationReferences: references,
        });

        // INVERTED after the fix landed, by approval. Pre-fix this recorded
        // exactly ONE occurrence — the declaration in js/templates/templates.js
        // — with ZERO references to it. That is the dead-code finding design
        // decision D2 acted on: delete beats align, because aligning would
        // duplicate the scheme-prefix-and-encode rule in code no caller can
        // reach. Task 8.1 performed the deletion, so the presence half of this
        // guard is obsolete by design and cannot hold against an empty array.
        //
        // Post-fix it records that the declaration is gone too. Zero total
        // occurrences is strictly stronger than the original zero-references
        // claim and subsumes it: no reference can exist if no occurrence does.
        expect(hits).toEqual([]);
    });

    test("E10 — the panel scan list stays seven folders with element aliased to overlay (clause 2.11)", function () {
        const panel = createPanelRealm({ currentSection: SECTIONS.OVERLAY });
        const ctx = panel.context;

        record("E10", "the panel's startup scan surface", {
            STARTUP_SCAN_SECTIONS: ctx.STARTUP_SCAN_SECTIONS,
            SECTION_SCAN_FOLDERS: ctx.SECTION_SCAN_FOLDERS,
            activeSectionScanFolderForOverlay: ctx.activeSectionScanFolder(),
        });

        expect(ctx.STARTUP_SCAN_SECTIONS.length).toBe(7);
        expect(ctx.STARTUP_SCAN_SECTIONS).toEqual(
            ["comp", "layer", "text", "footage", "effect", "icon", "overlay"]
        );
        expect(ctx.STARTUP_SCAN_SECTIONS.indexOf("element")).toBe(-1);
        expect(ctx.SECTION_SCAN_FOLDERS.element).toBe("overlay");
    });
});
