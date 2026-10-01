// ============================================================
// tests/card-thumbnail-dom-patch.test.js
//
// catalog-patch-ordering-fixes — Task 2, P16 preservation baseline
//
// BUG D is still unfixed, so miniDom's selector-list gap keeps the DOM loops
// unreachable. This file records the model-and-index halves that already run
// before those loops. Task 3.8 appends D1-D9 and the deferred assertion that
// these exact effects remain unchanged while the DOM loops become reachable.
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const { loadHelpers, REPO_ROOT } = require("./helpers/loadHelpers.js");
const { createMiniDocument } = require("./helpers/miniDom.js");
const persistence = require("../js/core/persistence.js");
const pathBuilders = require("../js/core/pathBuilders.js");

const TEMPLATES_REL = path.join("js", "templates", "templates.js");
const CATALOG_SRC = fs.readFileSync(
    path.join(REPO_ROOT, "js", "templates", "templateCatalog.js"),
    "utf8"
);
const constants = loadHelpers({
    file: path.join("js", "core", "constants.js"),
    lenient: false,
});
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
    lenient: false,
});

const OBSERVED = [];
function observe(caseId, note, data) {
    for (let i = 0; i < OBSERVED.length; i++) {
        if (OBSERVED[i].caseId === caseId) return;
    }
    OBSERVED.push({ caseId: caseId, note: note, data: data });
}

afterAll(function () {
    if (!OBSERVED.length) return;
    const lines = ["", "═══ THUMBNAIL MODEL/INDEX PRE-FIX OBSERVATIONS ═══"];
    OBSERVED.forEach(function (entry) {
        lines.push("", "[" + entry.caseId + "] " + entry.note, JSON.stringify(entry.data, null, 2));
    });
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
});

function cloneOwn(value) {
    const out = {};
    Object.keys(value || {}).forEach(function (key) { out[key] = value[key]; });
    return out;
}

function makeRecord(spec) {
    const section = spec.section;
    const folder = "C:/lib/" + section + "/Category/media-" + spec.index;
    return {
        id: "media-" + spec.index,
        name: "clip-" + spec.index,
        category: "Category",
        section: section,
        type: "media",
        mediaType: "video",
        mediaFile: "clip-" + spec.index + ".mov",
        sourcePath: "D:/incoming/clip-" + spec.index + ".mov",
        folderPath: folder,
        thumbnailPath: folder + "/old-thumbnail.png",
        thumbnail: "",
        thumbStatus: "placeholder",
        favorite: false,
    };
}

function buildWorld(record) {
    const document = createMiniDocument();
    const model = cloneOwn(record);
    const li = new persistence.LibraryIndex({ validityKey: "p16" });
    expect(li.insertAtHead(record)).toBe(true);

    const warnings = [];
    const indexPatches = [];
    const realIndexPatch = li.patchEntry;
    li.patchEntry = function (folderPath, fields) {
        indexPatches.push({
            folderPath: persistence.normalizeFolderPath(folderPath),
            fields: cloneOwn(fields),
        });
        return realIndexPatch.apply(li, arguments);
    };

    const injected = {
        console: {
            log: function () { },
            info: function () { },
            debug: function () { },
            warn: function () {
                warnings.push(Array.prototype.slice.call(arguments).map(String).join(" "));
            },
            error: function () {
                warnings.push(Array.prototype.slice.call(arguments).map(String).join(" "));
            },
        },
        window: { requestAnimationFrame: null },
        document: document,
        DOM: { "search-box": { value: "" } },
        SECTIONS: SECTIONS,
        IMAGE_SECTIONS: IMAGE_SECTIONS,
        escapeAttr: utils.get("escapeAttr"),
        escapeHTML: utils.get("escapeHTML"),
        getTemplateSection: utils.get("getTemplateSection"),
        normalizeSectionName: utils.get("normalizeSectionName"),
        isTextSection: utils.get("isTextSection"),
        isImageSection: utils.get("isImageSection"),
        getSafeName: pathBuilders.getSafeName,
        generateTemplateId: pathBuilders.generateTemplateId,
        cleanName: pathBuilders.cleanName,
        normalizeFolderPath: persistence.normalizeFolderPath,
        allTemplates: [model],
        currentSection: record.section,
        currentCategory: "All",
        tmpBulkSelected: [],
        libraryPaths: ["C:/lib"],
        rootPath: "C:/lib",
        savePath: "C:/lib",
        getLibraryIndex: function () { return li; },
        saveLibraryIndex: function () { },
        nfs: function () { return { existsSync: function () { return false; } }; },
        updateCount: function () { },
        updateCustomSelect: function () { },
        Settings: { get: function () { return []; }, set: function () { } },
        TextAnim: { attachHoverPreviews: function () { } },
        showToast: function () { },
        setTimeout: function () { return 1; },
        clearTimeout: function () { },
    };

    const handle = loadHelpers({ file: TEMPLATES_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;
    vm.runInContext(CATALOG_SRC, handle.context, { filename: "templateCatalog.js" });
    handle.context.TemplateCatalog.build(
        handle.context.allTemplates,
        handle.context.getTemplateSection,
        1
    );

    const catalogPatches = [];
    const realCatalogPatch = handle.context.TemplateCatalog.patch;
    handle.context.TemplateCatalog.patch = function (recordValue, previous) {
        catalogPatches.push({ record: recordValue, previous: previous });
        return realCatalogPatch.apply(handle.context.TemplateCatalog, arguments);
    };

    const marks = [];
    const realMark = handle.context.markTemplatesDirty;
    handle.context.markTemplatesDirty = function () {
        const result = realMark.apply(null, arguments);
        marks.push(result);
        return result;
    };

    return {
        context: handle.context,
        document: document,
        model: model,
        index: li,
        indexPatches: indexPatches,
        catalogPatches: catalogPatches,
        marks: marks,
        warnings: warnings,
    };
}

const SECTION_VALUES = Object.keys(SECTIONS).map(function (key) { return SECTIONS[key]; });
const OPERATION_ARB = fc.record({
    operation: fc.constantFrom("ready", "failed"),
    sectionIndex: fc.nat({ max: SECTION_VALUES.length - 1 }),
    index: fc.nat({ max: 100000 }),
    backslashes: fc.boolean(),
});

describe("P16 — model/index effects that precede the currently unreachable DOM loops (Property 8)", () => {
    test("generated success/failure updates retain their exact mirror and dirty-mark split", () => {
        // **Validates: Requirements 3.17**
        const seen = { ready: 0, failed: 0 };
        fc.assert(
            fc.property(OPERATION_ARB, function (spec) {
                const record = makeRecord({
                    section: SECTION_VALUES[spec.sectionIndex],
                    index: spec.index,
                });
                const world = buildWorld(record);
                const normalizedFolder = persistence.normalizeFolderPath(record.folderPath);
                const folderArg = spec.backslashes
                    ? record.folderPath.replace(/\//g, "\\")
                    : record.folderPath;

                if (spec.operation === "ready") {
                    const rawThumb = record.folderPath + "/new thumbnail " + spec.index + ".png";
                    const thumbArg = spec.backslashes ? rawThumb.replace(/\//g, "\\") : rawThumb;
                    const normalizedThumb = rawThumb.replace(/\\/g, "/");

                    world.context.refreshCardThumbnail(folderArg, thumbArg);
                    const persisted = world.index.getEntry(normalizedFolder);

                    expect(world.indexPatches).toEqual([{
                        folderPath: normalizedFolder,
                        fields: { thumbStatus: "ready", thumbnailPath: normalizedThumb },
                    }]);
                    expect(persisted.thumbStatus).toBe("ready");
                    expect(persisted.thumbnailPath).toBe(normalizedThumb);
                    expect(Object.prototype.hasOwnProperty.call(persisted, "thumbnail")).toBe(true);
                    expect(persisted.thumbnail).toBe("");

                    expect(world.model.thumbStatus).toBe("ready");
                    expect(world.model.thumbnailPath).toBe(normalizedThumb);
                    expect(typeof world.model.thumbnail).toBe("string");
                    expect(world.model.thumbnail.indexOf("file:///")).toBe(0);
                    expect(world.model.thumbnail.indexOf("?v=")).toBeGreaterThan(0);
                    expect(world.catalogPatches.length).toBe(1);
                    expect(world.catalogPatches[0].record).toBe(world.model);
                    expect(world.marks.length).toBe(0);

                    observe("P16-ready", "refreshCardThumbnail before its DOM loop", {
                        indexPatch: world.indexPatches[0],
                        persistedKeys: Object.keys(persisted),
                        model: {
                            thumbStatus: world.model.thumbStatus,
                            thumbnailPath: world.model.thumbnailPath,
                            thumbnail: world.model.thumbnail,
                        },
                        catalogPatchCalls: world.catalogPatches.length,
                        markTemplatesDirtyCalls: world.marks.length,
                        selectorListMatches: world.document.querySelectorAll(".card, .icon-card").length,
                    });
                } else {
                    world.context.markCardFailed(folderArg);
                    const persisted = world.index.getEntry(normalizedFolder);

                    expect(world.indexPatches).toEqual([{
                        folderPath: normalizedFolder,
                        fields: { thumbStatus: "failed" },
                    }]);
                    expect(persisted.thumbStatus).toBe("failed");
                    expect(world.model.thumbStatus).toBe("failed");
                    expect(world.catalogPatches.length).toBe(0);
                    expect(world.marks.length).toBe(1);

                    observe("P16-failed", "markCardFailed before its DOM loop", {
                        indexPatch: world.indexPatches[0],
                        persistedThumbStatus: persisted.thumbStatus,
                        modelThumbStatus: world.model.thumbStatus,
                        catalogPatchCalls: world.catalogPatches.length,
                        markTemplatesDirtyCalls: world.marks.length,
                        selectorListMatches: world.document.querySelectorAll(".card, .icon-card").length,
                    });
                }

                // The pre-fix selector-list gap means neither DOM loop iterates;
                // the absence of warnings confirms these assertions concern the
                // already-executing model/index half rather than a swallowed DOM
                // surface error.
                expect(world.document.querySelectorAll(".card, .icon-card").length).toBe(0);
                expect(world.index.needsFullScan()).toBe(false);
                expect(world.index.lastError()).toBeNull();
                expect(world.warnings).toEqual([]);
                seen[spec.operation]++;
            }),
            {
                numRuns: 50,
                seed: 20261021,
                examples: [
                    [{ operation: "ready", sectionIndex: 0, index: 1, backslashes: false }],
                    [{ operation: "failed", sectionIndex: 4, index: 2, backslashes: true }],
                ],
            }
        );
        expect(seen.ready).toBeGreaterThan(0);
        expect(seen.failed).toBeGreaterThan(0);
    }, 120000);

    test("E3 remains the red diagnostic and P2c remains its green inverse witness", () => {
        // **Validates: Requirements 3.17, 3.23**
        const exploration = fs.readFileSync(
            path.join(REPO_ROOT, "tests", "media-card-lifecycle-exploration.test.js"),
            "utf8"
        );
        const preservation = fs.readFileSync(
            path.join(REPO_ROOT, "tests", "media-card-lifecycle-preservation.property.test.js"),
            "utf8"
        );

        expect(exploration).toContain(
            'test("E3 [DIAGNOSTIC — stays failing after the fix by design] refreshCardThumbnail withholds `thumbnail` from the index"'
        );
        expect(exploration).toContain('expect(typeof persisted.thumbnail).toBe("string")');
        expect(preservation).toContain(
            'test("the persisted entry gets thumbStatus + thumbnailPath and NO thumbnail (D1 enforced)"'
        );
        expect(preservation).toContain(
            'expect(Object.prototype.hasOwnProperty.call(persisted, "thumbnail")).toBe(false)'
        );
    });
});

// ============================================================
// APPEND POINT — Task 3.8
//
// D1-D9 and P16's deferred "same model/index effects while the DOM loop is now
// reached" half belong below this banner after miniDom gains its five surfaces.
// ============================================================
