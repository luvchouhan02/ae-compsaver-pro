// ============================================================
// tests/catalog-patch-ordering-exploration.test.js
//
// Feature: catalog-patch-ordering-fixes (bugfix spec, task 1)
//
// BUG CONDITION EXPLORATION — failure IS the deliverable
// ------------------------------------------------------
// This suite runs the real, UNFIXED catalog and panel entry points in strict VM
// realms. X1-X6, X8 and both physical halves of X9 are expected to fail; those
// nine failures confirm the four root-cause hypotheses. X10 and X11 are
// refutation guards and must pass. X7 is deliberately skipped until task 3.6:
// a card rendered by the real markup cannot expose dataset through miniDom yet.
//
// Every case is deterministic. Generation belongs to the later fix-checking
// properties; weakening one of these assertions would erase the counterexample
// the eventual fix must flip to green.
//
// No production file is modified by this task.
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
//   1.10, 1.11, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17**
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadHelpers, REPO_ROOT } = require("./helpers/loadHelpers.js");
const {
    createMiniDocument,
    parseSingleElement,
} = require("./helpers/miniDom.js");
const { LibraryIndex } = require("../js/core/persistence.js");
const persistence = require("../js/core/persistence.js");
const pathBuilders = require("../js/core/pathBuilders.js");

const TEMPLATES_REL = path.join("js", "templates", "templates.js");
const CATALOG_REL = path.join("js", "templates", "templateCatalog.js");
const CATALOG_SRC = fs.readFileSync(path.join(REPO_ROOT, CATALOG_REL), "utf8");

// ─── Real shared panel modules ──────────────────────────────────────────────
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

const GRID_IDS = [
    "comp-list-container",
    "icon-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container",
];

// ─── Counterexample recorder ────────────────────────────────────────────────
// Record before asserting so Jest prints the concrete unfixed state even though
// the expected-behaviour assertion fails immediately afterwards.
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

function ids(catalog, section, category, query) {
    return Array.prototype.slice.call(catalog.idsFor(section, category, query || ""));
}

function counts(catalog, section) {
    const value = catalog.sectionCounts(section);
    return {
        all: value.all,
        favorites: value.favorites,
        cats: Object.assign({}, value.cats),
    };
}

// ─── Catalog-only realm (X1-X4, X10) ───────────────────────────────────────
function catalogRecords() {
    return [
        { id: "a", name: "AlphaOnly", category: "Cat", section: SECTIONS.COMP, favorite: false, type: "comp", dim: "1x1" },
        { id: "b", name: "BeforeOnly", category: "Cat", section: SECTIONS.COMP, favorite: false, type: "comp", dim: "1x1" },
        { id: "c", name: "GammaOnly", category: "Cat", section: SECTIONS.COMP, favorite: false, type: "comp", dim: "1x1" },
    ];
}

function loadCatalog(records) {
    const handle = loadHelpers({ file: CATALOG_REL, lenient: false });
    if (handle.error) throw handle.error;
    const catalog = handle.get("TemplateCatalog");
    if (!catalog) throw new Error("TemplateCatalog was not exposed by its VM realm");
    catalog.build(records, function (record) { return record.section; }, 1);
    return catalog;
}

function prePatchSnapshot(record) {
    return {
        category: record.category,
        favorite: record.favorite,
        section: record.section,
    };
}

// ─── Full panel realm (X5-X7, X9, X11) ─────────────────────────────────────
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

    const warnings = [];
    const timers = [];
    const imports = [];
    const indexHolder = { index: opts.libraryIndex || null };
    const recordingConsole = {
        log: function () { },
        info: function () { },
        debug: function () { },
        warn: function () {
            warnings.push(Array.prototype.slice.call(arguments).map(String).join(" "));
        },
        error: function () {
            warnings.push(Array.prototype.slice.call(arguments).map(String).join(" "));
        },
    };

    const injected = {
        console: recordingConsole,
        window: { requestAnimationFrame: null },
        document: document,
        DOM: { "search-box": { value: opts.search || "" } },

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

        allTemplates: opts.allTemplates || [],
        currentSection: opts.currentSection || SECTIONS.COMP,
        currentCategory: opts.currentCategory || "All",
        tmpBulkSelected: [],
        libraryPaths: [opts.rootPath || "C:/lib"],
        rootPath: opts.rootPath || "C:/lib",
        savePath: opts.rootPath || "C:/lib",

        getLibraryIndex: function () { return indexHolder.index; },
        saveLibraryIndex: function () { },
        nfs: function () {
            return { existsSync: function () { return false; } };
        },

        importTemplates: function (deps, request, done) {
            imports.push({ deps: deps, request: request, done: done });
        },
        encodeBridge: function (value) { return "" + value; },
        decodeBridge: function (value) { return "" + value; },
        callHost: function () {
            throw new Error("callHost is unreachable while importTemplates records the request");
        },

        updateCount: function () { },
        updateCustomSelect: function () { },
        Settings: { get: function () { return []; }, set: function () { } },
        TextAnim: { attachHoverPreviews: function () { } },
        showToast: function () { },
        setTimeout: function (fn, delay) {
            timers.push({ fn: fn, delay: delay });
            return timers.length;
        },
        clearTimeout: function () { },
    };

    const handle = loadHelpers({
        file: TEMPLATES_REL,
        injected: injected,
        lenient: false,
    });
    if (handle.error) throw handle.error;

    // index.html evaluates the catalog in the panel realm. Do the same so all
    // templates.js entry points resolve the real global at call time.
    vm.runInContext(CATALOG_SRC, handle.context, { filename: "templateCatalog.js" });

    const observations = { build: 0, patch: [], remove: [], marks: [] };
    const catalog = handle.context.TemplateCatalog;
    const realBuild = catalog.build;
    const realPatch = catalog.patch;
    const realRemove = catalog.remove;
    catalog.build = function () {
        observations.build++;
        return realBuild.apply(catalog, arguments);
    };
    catalog.patch = function (recordValue, before) {
        observations.patch.push({ record: recordValue, before: before });
        return realPatch.apply(catalog, arguments);
    };
    catalog.remove = function (recordValue) {
        observations.remove.push(recordValue);
        return realRemove.apply(catalog, arguments);
    };

    const realMark = handle.context.markTemplatesDirty;
    handle.context.markTemplatesDirty = function () {
        const revision = realMark.apply(null, arguments);
        observations.marks.push({
            revision: revision,
            sourceChanged: handle.context.catalogSourceChanged(),
        });
        return revision;
    };

    return {
        context: handle.context,
        document: document,
        grids: grids,
        warnings: warnings,
        timers: timers,
        imports: imports,
        observations: observations,
        getIndex: function () { return indexHolder.index; },
        resetObservations: function () {
            observations.build = 0;
            observations.patch.length = 0;
            observations.remove.length = 0;
            observations.marks.length = 0;
            warnings.length = 0;
        },
        lastPayload: function () {
            return imports.length ? imports[imports.length - 1].request : null;
        },
    };
}

function persistIndex(entries) {
    const source = new LibraryIndex({ validityKey: "catalog-ordering-x" });
    for (let i = entries.length - 1; i >= 0; i--) source.insertAtHead(entries[i]);
    const parsed = LibraryIndex.tryParse(source.serialize());
    if (!parsed.ok) throw new Error("exploration index failed to round-trip");
    return parsed.index;
}

function panelRecord(index, favorite) {
    const root = "C:/lib";
    const section = SECTIONS.COMP;
    const category = "Cat";
    const name = "Template " + index;
    return {
        id: "t" + index,
        name: name,
        category: category,
        section: section,
        type: section,
        dim: "1920x1080",
        favorite: !!favorite,
        sourcePath: root,
        folderPath: root + "/" + section + "/" + pathBuilders.getSafeName(category) +
            "/" + pathBuilders.generateTemplateId(name),
        thumbnail: "",
        thumbnailPath: "",
        thumbStatus: "placeholder",
    };
}

function sharedPanel(size) {
    const seeds = [];
    for (let i = 0; i < size; i++) seeds.push(panelRecord(i, false));
    const index = persistIndex(seeds);
    const realm = createPanelRealm({
        libraryIndex: index,
        allTemplates: index._entries,
        currentSection: SECTIONS.COMP,
        currentCategory: "All",
        rootPath: "C:/lib",
    });
    const ctx = realm.context;

    ctx.ensureCatalogFresh();
    realm.resetObservations();

    // The exploration must observe the mirror itself, before a rebuild can
    // mask it. Every post-mutation rendering collaborator is therefore inert.
    ctx.filterAndRender = function () { };
    ctx.patchTemplateCard = function () { };
    ctx.updateCategoryCountsOnly = function () { };
    ctx.buildCategoryTabs = function () { };
    ctx.buildCategoryPanel = function () { };

    return realm;
}

function shapeSnapshot(ctx) {
    const records = ctx.allTemplates;
    return {
        array: records,
        length: records.length,
        first: records.length ? records[0] : null,
        last: records.length ? records[records.length - 1] : null,
        catalogSize: ctx.TemplateCatalog.size(),
    };
}

function shapeDelta(before, ctx) {
    const after = shapeSnapshot(ctx);
    return {
        arrayIdentityMoved: before.array !== after.array,
        lengthMoved: before.length !== after.length,
        firstElementMoved: before.first !== after.first,
        lastElementMoved: before.last !== after.last,
        catalogSizeMoved: before.catalogSize !== after.catalogSize,
    };
}

// ─── X1-X4: BUG A ──────────────────────────────────────────────────────────
describe("BUG A — TemplateCatalog.patch mistakes a re-key for an add", function () {
    test("X1 — a middle-record re-key remains one record", function () {
        // **Validates: Requirements 1.1, 1.2**
        const records = catalogRecords();
        const catalog = loadCatalog(records);
        const recordValue = records[1];
        const before = prePatchSnapshot(recordValue);

        recordValue.id = "b-new";
        catalog.patch(recordValue, before);

        const allIds = ids(catalog, SECTIONS.COMP, "All");
        const sectionCount = counts(catalog, SECTIONS.COMP);
        record("X1", "the absent new id took the add branch and duplicated one indexed record", {
            size: catalog.size(),
            idsForAll: allIds,
            counts: sectionCount,
            expectedSize: 3,
            expectedIdsLength: 3,
        });

        expect(catalog.size()).toBe(3);
        expect(allIds.length).toBe(3);
        expect(sectionCount.all).toBe(3);
    });

    test("X2 — successive re-keys do not leak one entry per rename", function () {
        // **Validates: Requirements 1.1, 1.2**
        const records = catalogRecords();
        const catalog = loadCatalog(records);
        const recordValue = records[1];

        recordValue.id = "b-new";
        catalog.patch(recordValue, prePatchSnapshot(recordValue));
        recordValue.id = "b-final";
        catalog.patch(recordValue, prePatchSnapshot(recordValue));

        const allIds = ids(catalog, SECTIONS.COMP, "All");
        record("X2", "each absent id appended another list entry for the same object", {
            idsForAll: allIds,
            length: allIds.length,
            counts: counts(catalog, SECTIONS.COMP),
            expectedLength: 3,
        });

        expect(allIds.length).toBe(3);
    });

    test("X3 — a re-key retires the old search haystack", function () {
        // **Validates: Requirements 1.3**
        const records = catalogRecords();
        const catalog = loadCatalog(records);
        const recordValue = records[1];
        const before = prePatchSnapshot(recordValue);

        recordValue.id = "b-new";
        recordValue.name = "AfterOnly";
        catalog.patch(recordValue, before);

        const oldHits = ids(catalog, SECTIONS.COMP, "All", "beforeonly");
        const newHits = ids(catalog, SECTIONS.COMP, "All", "afteronly");
        record("X3", "the stale id retained the pre-rename haystack", {
            oldNameHits: oldHits,
            newNameHits: newHits,
            expectedOldNameHits: [],
            expectedNewNameHits: ["b-new"],
        });

        expect(oldHits).toEqual([]);
        expect(newHits).toEqual(["b-new"]);
    });

    test("X4 — rename then remove leaves no ghost", function () {
        // **Validates: Requirements 1.4**
        const records = catalogRecords();
        const catalog = loadCatalog(records);
        const recordValue = records[1];
        const oldId = recordValue.id;
        const before = prePatchSnapshot(recordValue);

        recordValue.id = "b-new";
        catalog.patch(recordValue, before);
        catalog.remove(recordValue);

        const remaining = ids(catalog, SECTIONS.COMP, "All");
        const sectionCount = counts(catalog, SECTIONS.COMP);
        record("X4", "remove retired only the current id, leaving the pre-rename key and list entry", {
            oldIdStillResolves: catalog.get(oldId) === recordValue,
            newIdValue: catalog.get("b-new"),
            idsForAll: remaining,
            counts: sectionCount,
            expectedLength: 2,
        });

        expect(catalog.get(oldId)).toBeUndefined();
        expect(remaining.length).toBe(2);
        expect(sectionCount.all).toBe(2);
    });
});

// ─── X5-X6: BUG B ──────────────────────────────────────────────────────────
describe("BUG B — UI mutation helpers scan after rewriting their shared array", function () {
    test("X5 — a shared-shape middle rename reaches the catalog mirror", function () {
        // **Validates: Requirements 1.5, 1.6, 1.7, 1.8**
        const realm = sharedPanel(5);
        const ctx = realm.context;
        const middle = 2;
        const target = ctx.allTemplates[middle];
        const oldId = target.id;
        const oldName = target.name;
        const nextId = "t2-renamed";
        const nextName = oldName + " Renamed";
        const beforeShape = shapeSnapshot(ctx);

        ctx.patchUITemplate(
            oldName,
            target.category,
            { id: nextId, name: nextName },
            nextName,
            undefined
        );

        const delta = shapeDelta(beforeShape, ctx);
        const newRecord = ctx.TemplateCatalog.get(nextId);
        const oldRecord = ctx.TemplateCatalog.get(oldId);
        record("X5", "patchEntry replaced the middle slot before patchUITemplate searched for the old name", {
            catalogPatchCalls: realm.observations.patch.length,
            marks: realm.observations.marks.length,
            catalogSourceChanged: ctx.catalogSourceChanged(),
            oldIdName: oldRecord && oldRecord.name,
            newIdResolves: newRecord !== undefined,
            modelNameAtMiddle: ctx.allTemplates[middle].name,
            modelRecordWasReplaced: ctx.allTemplates[middle] !== target,
            shapeProbeDelta: delta,
        });

        expect(newRecord).toBe(ctx.allTemplates[middle]);
    });

    test("X6 — a shared-shape favourite toggle updates the catalog count", function () {
        // **Validates: Requirements 1.8, 1.9**
        const realm = sharedPanel(3);
        const ctx = realm.context;
        const target = ctx.allTemplates[1];

        ctx.patchUITemplate(target.name, target.category, { favorite: true });

        const observed = counts(ctx.TemplateCatalog, SECTIONS.COMP);
        const rebuilt = loadCatalog(Array.prototype.slice.call(ctx.allTemplates));
        const rebuiltCounts = counts(rebuilt, SECTIONS.COMP);
        const mirror = realm.observations.patch[0] || null;
        record("X6", "the before snapshot came from the already-merged clone, so no favourite delta was applied", {
            catalogPatchCalls: realm.observations.patch.length,
            marks: realm.observations.marks.length,
            beforeFavorite: mirror && mirror.before && mirror.before.favorite,
            mutatedFavorite: mirror && mirror.record && mirror.record.favorite,
            incrementalCounts: observed,
            rebuiltCounts: rebuiltCounts,
        });

        expect(observed.favorites).toBe(1);
    });
});

// ─── X7: BUG C (written now, executable only after BUG D) ──────────────────
describe("BUG C — import section comes from global state", function () {
    test.skip("X7 [SKIPPED until BUG D lands: needs miniDom dataset to drive a parsed card] — a stale footage card imports as footage", function () {
        // **Validates: Requirements 1.10, 1.13**
        const recordValue = {
            id: "footage-1",
            name: "Clip",
            category: "Broll",
            section: SECTIONS.FOOTAGE,
            type: "media",
            mediaType: "video",
            folderPath: "C:/lib/footage/Broll/media-clip",
            sourcePath: "D:/incoming/clip.mp4",
            thumbnail: "",
            favorite: false,
        };
        const realm = createPanelRealm({
            allTemplates: [recordValue],
            currentSection: SECTIONS.COMP,
            rootPath: "C:/lib",
        });
        const ctx = realm.context;
        ctx.TemplateCatalog.build(ctx.allTemplates, ctx.getTemplateSection, 1);

        const card = parseSingleElement(
            ctx.renderTemplateCardMarkup(recordValue, recordValue.section, [])
        );
        ctx.importCurrentCardToTimeline(card);

        const payload = realm.lastPayload();
        record("X7", "the payload mixed a footage source path with the active comp section", {
            currentSection: ctx.currentSection,
            recordSection: recordValue.section,
            payloadSection: payload && payload.templates[0].section,
            payloadSourcePath: payload && payload.templates[0].sourcePath,
        });

        expect(payload.templates[0].section).toBe(SECTIONS.FOOTAGE);
    });
});

// ─── X8-X9: BUG D ──────────────────────────────────────────────────────────
function patchSelectorListLocally(document) {
    const original = document.querySelectorAll.bind(document);
    document.querySelectorAll = function (selector) {
        if (selector !== ".card, .icon-card") return original(selector);
        const combined = original(".card").concat(original(".icon-card"));
        return combined.filter(function (element, index) {
            return combined.indexOf(element) === index;
        });
    };
}

function defineMissingSurface(element, name, value) {
    if (element[name] !== undefined) return element[name];
    Object.defineProperty(element, name, {
        value: value,
        writable: true,
        configurable: true,
        enumerable: true,
    });
    return value;
}

function classListShim(element) {
    function tokens() {
        return element.className.split(/\s+/).filter(Boolean);
    }
    function write(values) {
        element.className = values.join(" ");
    }
    return {
        contains: function (name) { return tokens().indexOf(name) !== -1; },
        add: function (name) {
            const values = tokens();
            if (values.indexOf(name) === -1) values.push(name);
            write(values);
        },
        remove: function (name) {
            const values = tokens();
            const at = values.indexOf(name);
            if (at !== -1) values.splice(at, 1);
            write(values);
        },
        toggle: function (name, force) {
            const values = tokens();
            const at = values.indexOf(name);
            const on = force === undefined ? at === -1 : !!force;
            if (on && at === -1) values.push(name);
            if (!on && at !== -1) values.splice(at, 1);
            write(values);
            return on;
        },
    };
}

function thumbnailRecord() {
    return {
        id: "thumb-1",
        name: "Thumb Card",
        category: "Cat",
        section: SECTIONS.COMP,
        type: "media",
        mediaType: "video",
        folderPath: "C:/lib/comp/Cat/media-thumb",
        sourcePath: "D:/incoming/thumb.mp4",
        thumbnail: "",
        favorite: false,
    };
}

function mountThumbnailCard(realm, recordValue) {
    realm.document.body.innerHTML = realm.context.renderTemplateCardMarkup(
        recordValue,
        recordValue.section,
        []
    );
    patchSelectorListLocally(realm.document);
    const card = realm.document.querySelector(".card");
    if (!card) throw new Error("thumbnail exploration card did not parse");
    return card;
}

function lastWarning(realm) {
    return realm.warnings.length ? realm.warnings[realm.warnings.length - 1] : null;
}

// Jest stops a test at its first failed expect. X9 intentionally checks four
// independently absent surfaces, so collect both failures in each entry-point
// half and throw once. That keeps all four counterexamples visible in one run.
function assertEvery(checks) {
    const failures = [];
    checks.forEach(function (check) {
        try {
            check();
        } catch (error) {
            failures.push(error && error.message ? error.message : String(error));
        }
    });
    if (failures.length) {
        throw new Error("independent X9 failures:\n\n" + failures.join("\n\n"));
    }
}

describe("BUG D — miniDom cannot reach the imperative card patch loops", function () {
    test("X8 — selector lists return both card kinds without throwing", function () {
        // **Validates: Requirements 1.14**
        const document = createMiniDocument();
        document.body.innerHTML =
            '<div id="one" class="card"></div>' +
            '<div id="two" class="icon-card"></div>';

        let thrown = null;
        let found = [];
        try {
            found = document.querySelectorAll(".card, .icon-card");
        } catch (error) {
            thrown = error;
        }

        record("X8", "the selector list silently matched nothing; it did not throw", {
            threw: thrown !== null,
            error: thrown && String(thrown),
            length: found.length,
            ids: found.map(function (element) { return element.id; }),
            expectedLength: 2,
        });

        expect(thrown).toBeNull();
        expect(found.length).toBe(2);
    });

    test("X9a — refreshCardThumbnail exposes the missing dataset and classList surfaces", function () {
        // **Validates: Requirements 1.15, 1.16, 1.17**
        const datasetRecord = thumbnailRecord();
        const datasetRealm = createPanelRealm({
            allTemplates: [datasetRecord],
            currentSection: SECTIONS.COMP,
        });
        mountThumbnailCard(datasetRealm, datasetRecord);
        datasetRealm.context.refreshCardThumbnail(
            datasetRecord.folderPath,
            datasetRecord.folderPath + "/thumbnail.png"
        );
        const datasetError = lastWarning(datasetRealm);

        const classRecord = thumbnailRecord();
        const classRealm = createPanelRealm({
            allTemplates: [classRecord],
            currentSection: SECTIONS.COMP,
        });
        const classCard = mountThumbnailCard(classRealm, classRecord);
        defineMissingSurface(classCard, "dataset", { folder: classRecord.folderPath, thumb: "" });
        classRealm.context.refreshCardThumbnail(
            classRecord.folderPath,
            classRecord.folderPath + "/thumbnail.png"
        );
        const classListError = lastWarning(classRealm);

        record("X9", "refreshCardThumbnail reached the locally enabled loop and failed on dataset", {
            surface: "dataset",
            warning: datasetError,
        });
        record("X9", "after a local dataset shim, the same loop failed on classList.remove", {
            surface: "classList",
            warning: classListError,
        });

        assertEvery([
            function () { expect(datasetError).toBeNull(); },
            function () { expect(classListError).toBeNull(); },
        ]);
    });

    test("X9b — markCardFailed exposes the missing style and textContent-setter surfaces", function () {
        // **Validates: Requirements 1.15, 1.16, 1.17**
        const styleRecord = thumbnailRecord();
        const styleRealm = createPanelRealm({
            allTemplates: [styleRecord],
            currentSection: SECTIONS.COMP,
        });
        const styleCard = mountThumbnailCard(styleRealm, styleRecord);
        defineMissingSurface(styleCard, "dataset", { folder: styleRecord.folderPath });
        defineMissingSurface(styleCard, "classList", classListShim(styleCard));
        styleRealm.context.markCardFailed(styleRecord.folderPath);
        const styleError = lastWarning(styleRealm);

        const textRecord = thumbnailRecord();
        const textRealm = createPanelRealm({
            allTemplates: [textRecord],
            currentSection: SECTIONS.COMP,
        });
        const textCard = mountThumbnailCard(textRealm, textRecord);
        defineMissingSurface(textCard, "dataset", { folder: textRecord.folderPath });
        defineMissingSurface(textCard, "classList", classListShim(textCard));

        // Isolate the final missing surface only. The production assignment is
        // non-strict and therefore drops the write silently; the explicit strict
        // probe records the TypeError the getter-only descriptor produces.
        const originalCreateElement = textRealm.document.createElement;
        textRealm.document.createElement = function (tagName) {
            const element = originalCreateElement(tagName);
            defineMissingSurface(element, "style", {});
            return element;
        };
        textRealm.context.markCardFailed(textRecord.folderPath);
        const badge = textRealm.document.querySelector(".thumb-fail-badge");
        let strictSetterError = null;
        try {
            (function strictTextWrite(element) {
                "use strict";
                element.textContent = "!";
            })(originalCreateElement("div"));
        } catch (error) {
            strictSetterError = error;
        }
        const badgeText = badge ? badge.textContent : null;

        record("X9", "after dataset/classList shims, markCardFailed failed while assigning badge.style.cssText", {
            surface: "style",
            warning: styleError,
        });
        record("X9", "the getter-only textContent descriptor rejected a strict write and production left the badge empty", {
            surface: "textContent setter",
            strictWriteError: strictSetterError && String(strictSetterError),
            productionWarning: lastWarning(textRealm),
            badgeWasInserted: badge !== null,
            badgeText: badgeText,
        });

        assertEvery([
            function () { expect(styleError).toBeNull(); },
            function () {
                expect({
                    strictWriteError: strictSetterError && String(strictSetterError),
                    badgeText: badgeText,
                }).toEqual({ strictWriteError: null, badgeText: "!" });
            },
        ]);
    });
});

// ─── X10-X11: refutation guards ────────────────────────────────────────────
describe("refutation guards — premises that must already hold", function () {
    test("X10 — patching a genuinely fresh record still acts as an add", function () {
        // **Validates: Requirements 1.1**
        const records = catalogRecords();
        const catalog = loadCatalog(records);
        const fresh = {
            id: "fresh",
            name: "FreshOnly",
            category: "Cat",
            section: SECTIONS.COMP,
            favorite: false,
            type: "comp",
            dim: "1x1",
        };

        catalog.patch(fresh);

        expect(catalog.size()).toBe(4);
        expect(catalog.get("fresh")).toBe(fresh);
        expect(ids(catalog, SECTIONS.COMP, "All")).toEqual(["a", "b", "c", "fresh"]);
    });

    test("X11 — rendered card metadata has no data-section attribute", function () {
        // **Validates: Requirements 1.10, 1.11, 1.12, 1.13**
        const recordValue = {
            id: "hostile-&amp;-id",
            name: "Rendered Card",
            category: "Cat",
            section: SECTIONS.FOOTAGE,
            type: "media",
            mediaType: "video",
            mediaFile: "clip.mp4",
            folderPath: "C:/lib/footage/Cat/media-card",
            sourcePath: "D:/incoming/clip.mp4",
            thumbnail: "C:/lib/footage/Cat/media-card/thumbnail.png",
            favorite: false,
        };
        const realm = createPanelRealm({
            allTemplates: [recordValue],
            currentSection: SECTIONS.FOOTAGE,
        });
        const card = parseSingleElement(
            realm.context.renderTemplateCardMarkup(recordValue, recordValue.section, [])
        );

        ["data-file", "data-cat", "data-folder", "data-thumb"].forEach(function (name) {
            expect(card.getAttribute(name)).not.toBeNull();
        });
        expect(card.id).toBe("tpl-" + recordValue.id);
        expect(card.hasAttribute("data-section")).toBe(false);
        expect(card.getAttribute("data-section")).toBeNull();
    });
});

// ─── P18: ES5 source-shape preservation guard ──────────────────────────────
describe("P18 — edited panel sources remain CEP-safe ES5", function () {
    test("P18 — templateCatalog.js and templates.js contain no forbidden modern syntax", function () {
        // **Validates: Requirements 3.19**
        function stripToCode(source) {
            var out = "";
            var templateLiterals = [];
            var line = 1;
            var i = 0;
            var n = source.length;

            function lastCodeChar() {
                for (var k = out.length - 1; k >= 0; k--) {
                    var ch = out.charAt(k);
                    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return ch;
                }
                return "";
            }

            function regexAllowedHere() {
                var prev = lastCodeChar();
                if (prev === "") return true;
                if ("(,=:[!&|?{};+-*%~^<>".indexOf(prev) !== -1) return true;
                return /\b(?:return|typeof|case|in|of|do|else|void|delete|instanceof)\s*$/.test(out);
            }

            function blank(count) {
                return new Array(count + 1).join(" ");
            }

            while (i < n) {
                var c = source.charAt(i);
                var d = source.charAt(i + 1);

                if (c === "\n") { out += "\n"; line++; i++; continue; }

                if (c === "/" && d === "/") {
                    while (i < n && source.charAt(i) !== "\n") i++;
                    continue;
                }

                if (c === "/" && d === "*") {
                    i += 2;
                    while (i < n && !(source.charAt(i) === "*" && source.charAt(i + 1) === "/")) {
                        if (source.charAt(i) === "\n") { out += "\n"; line++; }
                        i++;
                    }
                    i += 2;
                    continue;
                }

                if (c === "\"" || c === "'" || c === "`") {
                    if (c === "`") templateLiterals.push(line);
                    var quote = c;
                    i++;
                    out += " ";
                    while (i < n) {
                        var ch = source.charAt(i);
                        if (ch === "\\") { i += 2; continue; }
                        if (ch === "\n") { out += "\n"; line++; i++; continue; }
                        if (ch === quote) { i++; break; }
                        i++;
                    }
                    continue;
                }

                if (c === "/" && regexAllowedHere()) {
                    var j = i + 1;
                    var inClass = false;
                    var closed = false;
                    while (j < n) {
                        var rc = source.charAt(j);
                        if (rc === "\\") { j += 2; continue; }
                        if (rc === "\n") break;
                        if (rc === "[") inClass = true;
                        else if (rc === "]") inClass = false;
                        else if (rc === "/" && !inClass) { closed = true; j++; break; }
                        j++;
                    }
                    if (closed) {
                        while (j < n && /[a-z]/.test(source.charAt(j))) j++;
                        out += blank(j - i);
                        i = j;
                        continue;
                    }
                }

                out += c;
                i++;
            }

            return { code: out, templateLiterals: templateLiterals };
        }

        function extractRegion(source, marker) {
            var lines = source.split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].indexOf(marker) === -1) continue;
                var indent = /^([ \t]*)/.exec(lines[i])[1];
                var closing = new RegExp("^" + indent + "\\}$");
                for (var end = i + 1; end < lines.length; end++) {
                    if (closing.test(lines[end])) {
                        return {
                            label: TEMPLATES_REL + " [" + marker + "]",
                            startLine: i + 1,
                            text: lines.slice(i, end + 1).join("\n"),
                        };
                    }
                }
                return null;
            }
            return null;
        }

        function findLines(code, pattern, label, startLine) {
            var lines = code.split(/\r?\n/);
            var findings = [];
            for (var i = 0; i < lines.length; i++) {
                var re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
                if (re.test(lines[i])) {
                    findings.push(label + ":" + ((startLine || 1) + i) + " [" + lines[i].trim().slice(0, 100) + "]");
                }
            }
            return findings;
        }

        var forbidden = [
            { id: "arrow-function", pattern: /=>/ },
            { id: "let-const-declaration", pattern: /\b(?:let|const)\s+[A-Za-z_$[{]/ },
            { id: "spread-or-rest", pattern: /\.\.\./ },
            { id: "class-syntax", pattern: /\bclass(?:\s+[A-Za-z_$]|\s*\{)/ },
            { id: "async-await", pattern: /\basync\s+function\b|\basync\s*\(|\bawait\s+[A-Za-z_$(]/ },
            { id: "optional-chaining", pattern: /\?\.(?![0-9])/ },
            { id: "nullish-coalescing", pattern: /\?\?/ },
        ];
        var findings = [];
        var templatesSource = fs.readFileSync(path.join(REPO_ROOT, TEMPLATES_REL), "utf8");
        var units = [{ label: CATALOG_REL, startLine: 1, text: CATALOG_SRC }];
        var requiredTemplateMarkers = [
            "function removeUITemplate(",
            "function patchUITemplate(",
            "function importCurrentCardToTimeline(",
        ];

        // templates.js already contains an out-of-scope async save pipeline.
        // Match the repository's established compatibility policy: scan every
        // surface this spec edits, while templateCatalog.js remains whole-file
        // scanned. The future BUG C helper joins the scan as soon as it exists.
        requiredTemplateMarkers.forEach(function (marker) {
            var region = extractRegion(templatesSource, marker);
            if (!region) findings.push("missing-source-region  " + TEMPLATES_REL + " [" + marker + "]");
            else units.push(region);
        });
        var futureSectionHelper = extractRegion(templatesSource, "function sectionForCard(");
        if (futureSectionHelper) units.push(futureSectionHelper);

        units.forEach(function (unit) {
            var stripped = stripToCode(unit.text);
            forbidden.forEach(function (rule) {
                findLines(stripped.code, rule.pattern, unit.label, unit.startLine).forEach(function (hit) {
                    findings.push(rule.id + "  " + hit);
                });
            });
            stripped.templateLiterals.forEach(function (lineNumber) {
                findings.push("template-literal  " + unit.label + ":" + (unit.startLine + lineNumber - 1));
            });
        });

        expect(findings).toEqual([]);
    });
});
