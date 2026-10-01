/**
 * Wave 2 targeted example tests
 * =============================
 *
 * Feature: panel-reopen-startup (Wave 2, master prompt items 3, 4, 7)
 *
 * Five narrow claims the Wave 2 property suites either cannot reach or would
 * only sample. Every one of them runs shipped code:
 *
 *   1. `activeSectionScanFolder()` over all nine `SECTIONS` members, plus an
 *      unmapped value and a prototype-shaped one (Requirement 10.3).
 *   2. The three recovery-ladder load reasons — `recovered-staging`,
 *      `recovered-previous`, `version-ahead` — produced by the real
 *      `loadLibraryIndex()` against a fake `localStorage` holding the real
 *      `Index_Store` keys, read back through `getLastLibraryIndexLoadReason()`
 *      (Requirement 9.7).
 *   3. A legacy (pre-Wave-2) stored validity key: every root in the current v2
 *      key is reported changed, and nothing persisted is discarded
 *      (Requirement 8.9).
 *   4. `getCombinedDiskValidityKey(["X"])` honours its argument over the
 *      injected `libraryPaths` / `rootPath` globals (Requirement 8.10).
 *   5. `deriveRootSignature` returns `null` for an unreadable root and for an
 *      absent `fs` (Requirement 8.12 / Wave 2 error handling).
 *
 * _Requirements: 8.9, 8.10, 8.12, 9.7, 10.3_
 *
 * No property test lives in this file: these are examples by design, and the
 * universal claims they support are made by the Wave 2 property suites.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { loadHelpers, REPO_ROOT } = require("../helpers/loadHelpers.js");
const persistence = require("../../js/core/persistence.js");

const PERSISTENCE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "js", "core", "persistence.js"), "utf8");

const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
});

// ─── Harnesses ──────────────────────────────────────────────────────────────

/**
 * A templates.js realm with just enough panel state for the pure Wave 2 helpers
 * (`activeSectionScanFolder`, `changedRootsFromKeys`). The v2 key parser is the
 * REAL one from persistence.js, exactly as the panel has it when both scripts
 * are loaded.
 */
function createTemplatesRealm(overrides) {
    const injected = {
        window: { Date: Date },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        document: {
            getElementById: function () { return null; },
            createElement: function () { return { style: {}, dataset: {}, appendChild: function () { } }; },
        },

        SECTIONS: SECTIONS,
        IMAGE_SECTIONS: IMAGE_SECTIONS,
        escapeAttr: utils.get("escapeAttr"),
        escapeHTML: utils.get("escapeHTML"),
        getTemplateSection: utils.get("getTemplateSection"),
        isTextSection: utils.get("isTextSection"),
        isImageSection: utils.get("isImageSection"),

        allTemplates: [],
        currentSection: SECTIONS.COMP,
        currentCategory: "All",
        tmpBulkSelected: [],
        libraryPaths: [],
        rootPath: null,
        DOM: { "search-box": { value: "" } },

        parseCombinedValidityKey: persistence.parseCombinedValidityKey,
        getLibraryIndex: function () { return null; },
        getLastLibraryIndexLoadReason: function () { return "absent"; },
        getCombinedDiskValidityKey: function () { return ""; },
        saveLibraryIndex: function () { },
        setTimeout: function () { return 0; },
        clearTimeout: function () { },
        updateCount: function () { },
        updateCustomSelect: function () { },
        Settings: { get: function () { return []; }, set: function () { } },
        TextAnim: { attachHoverPreviews: function () { } },
        showToast: function () { },
        nfs: function () { return { existsSync: function () { return false; } }; },
    };
    Object.keys(overrides || {}).forEach(function (key) { injected[key] = overrides[key]; });

    return loadHelpers({
        file: path.join("js", "templates", "templates.js"),
        lenient: false,
        injected: injected,
    }).context;
}

/**
 * The real persistence.js in its own realm over a fake `localStorage`, so the
 * `Index_Store` keys under test are the shipped constants and the reason under
 * test is the shipped reason channel.
 */
function createPersistenceRealm(store, extras) {
    const backing = {};
    Object.keys(store || {}).forEach(function (key) { backing[key] = String(store[key]); });

    const warnings = [];
    const context = {
        console: {
            log: function () { },
            warn: function (message) { warnings.push(String(message)); },
            error: function () { },
        },
        module: { exports: {} },
        exports: {},
        localStorage: {
            getItem: function (key) {
                return Object.prototype.hasOwnProperty.call(backing, key) ? backing[key] : null;
            },
            setItem: function (key, value) { backing[key] = String(value); },
            removeItem: function (key) { delete backing[key]; },
        },
    };
    Object.keys(extras || {}).forEach(function (key) { context[key] = extras[key]; });
    context.window = context;

    vm.createContext(context);
    vm.runInContext(PERSISTENCE_SOURCE, context, { filename: "persistence.js" });

    return { context: context, store: backing, warnings: warnings };
}

/** A synchronous fake filesystem over a flat `path -> node` map. */
function createFakeFs(tree) {
    return {
        readdirSync: function (dir) {
            const node = tree[dir];
            if (!node || node.isDir !== true) throw new Error("ENOENT: " + dir);
            return node.entries.slice();
        },
        statSync: function (target) {
            const node = tree[target];
            if (!node) throw new Error("ENOENT: " + target);
            return {
                size: node.size || 0,
                mtimeMs: node.mtimeMs || 0,
                isDirectory: function () { return node.isDir === true; },
            };
        },
    };
}

/**
 * The signature any `libraryTree(root, 0)` produces, held here independently of
 * the shipped code so the format stays frozen: one `categories:newestCategoryMtime`
 * fold per section folder, in the fixed order
 * `comp, effect, footage, icon, layer, overlay, text`, with `-` for a section the
 * library does not have (Requirement 8.5, design §`Root_Signature`).
 *
 * `libraryTree` only builds `comp`, holding one category whose mtime is 1200, so
 * `comp` folds to `1:1200` and the other six sections are absent. The root's own
 * directory triple appears nowhere: it moved whenever any entry was created or
 * removed in the root — including the metadata cache's temporary sibling — and
 * folding it in made the key invalidate itself on every save.
 *
 * Everything outside those seven folders is deliberately invisible here. A real
 * library root also holds `text_animations`, `preview_assets`,
 * `preview_debug.txt`, `migration.log` and `.compsaver_metadata.json`, all of
 * which CompSaver writes itself; folding them in meant every preview render
 * moved the key, so each reopen reported "stale" and paid a full blocking host
 * rescan for a library that never changed.
 */
const READABLE_SIGNATURE = "1:1200|-|-|-|-|-|-";

/** One library root: the root folder, one category folder, one file in it. */
function libraryTree(root, seed) {
    const tree = {};
    tree[root] = { isDir: true, entries: ["comp"], mtimeMs: 1000 + seed, size: 0 };
    tree[root + "/comp"] = { isDir: true, entries: ["one.aep"], mtimeMs: 1100 + seed, size: 0 };
    tree[root + "/comp/one.aep"] = { isDir: false, entries: [], mtimeMs: 1200 + seed, size: 512 + seed };
    return tree;
}

function mergeTrees() {
    const out = {};
    for (let i = 0; i < arguments.length; i++) {
        const tree = arguments[i];
        Object.keys(tree).forEach(function (key) { out[key] = tree[key]; });
    }
    return out;
}

/** A usable serialized index payload, built through the realm's own class. */
function serializedIndex(context, validityKey, count) {
    const index = new context.LibraryIndex({ validityKey: validityKey });
    for (let i = 0; i < count; i++) {
        index.insertAtHead({
            id: "e" + i,
            name: "Entry " + i,
            category: "Titles",
            section: "comp",
            type: "comp",
            favorite: false,
            folderPath: "C:/lib/alpha/comp/Entry " + i,
            thumbnail: "",
        });
    }
    return index.serialize();
}

// ─── 1. activeSectionScanFolder over every SECTIONS member (Req 10.3) ───────
describe("activeSectionScanFolder", function () {
    // The section -> ExtendScript folder mapping the design declares (design.md
    // §7), stated independently of the shipped SECTION_SCAN_FOLDERS table so this
    // is a real check rather than a restatement.
    const EXPECTED = {
        comp: "comp",
        layer: "layer",
        text: "text",
        text_props: "text",
        footage: "footage",
        effect: "effect",
        icon: "icon",
        overlay: "overlay",
        element: "overlay",
    };

    const context = createTemplatesRealm();

    // Every member of SECTIONS is covered, and the enumeration is checked against
    // SECTIONS itself so a tenth section could not be added without failing here.
    const sectionValues = Object.keys(SECTIONS).map(function (key) { return SECTIONS[key]; });

    test("SECTIONS has exactly the nine members this table covers", function () {
        expect(sectionValues.slice().sort()).toEqual(Object.keys(EXPECTED).slice().sort());
        expect(sectionValues.length).toBe(9);
    });

    sectionValues.forEach(function (section) {
        test('maps "' + section + '" to the "' + EXPECTED[section] + '" section folder', function () {
            context.currentSection = section;
            expect(context.activeSectionScanFolder()).toBe(EXPECTED[section]);
        });
    });

    test("returns the empty string for an unmapped section, so the scoped pre-scan is skipped", function () {
        context.currentSection = "sticker";
        expect(context.activeSectionScanFolder()).toBe("");
    });

    // A prototype-shaped lookup must not leak an inherited member: SECTIONS_SCAN
    // is a plain object, so `SECTION_SCAN_FOLDERS["constructor"]` resolves to
    // Object.prototype.constructor. The shipped typeof-string check is what keeps
    // that from becoming a bridge argument.
    ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"].forEach(function (shape) {
        test('returns the empty string for the prototype-shaped value "' + shape + '"', function () {
            context.currentSection = shape;
            expect(context.activeSectionScanFolder()).toBe("");
        });
    });

    test("returns the empty string for absent and non-string sections", function () {
        [undefined, null, "", 0, false].forEach(function (value) {
            context.currentSection = value;
            expect(context.activeSectionScanFolder()).toBe("");
        });
    });
});

// ─── 2. The three recovery-ladder load reasons (Req 9.7, 9.9) ───────────────
describe("loadLibraryIndex recovery ladder reasons", function () {
    /** Loads through the realm's own singleton and reports what came back. */
    function loadFrom(storeFactory) {
        const seedRealm = createPersistenceRealm({});
        const store = storeFactory(seedRealm.context);

        const realm = createPersistenceRealm(store);
        const singleton = new realm.context.LibraryIndex();
        realm.context.getLibraryIndex = function () { return singleton; };

        const li = realm.context.loadLibraryIndex();
        return {
            realm: realm,
            index: li,
            reason: realm.context.getLastLibraryIndexLoadReason(),
            entries: li ? li._entries.slice() : null,
            validityKey: li ? li.validityKey : null,
        };
    }

    test("the Index_Store keys are the three shipped constants", function () {
        expect(persistence.INDEX_KEY).toBe("compSaver_libraryIndex");
        expect(persistence.INDEX_STAGING_KEY).toBe("compSaver_libraryIndex__staging");
        expect(persistence.INDEX_PREV_KEY).toBe("compSaver_libraryIndex__prev");
    });

    test('reports "recovered-staging" when only the staging key holds a payload', function () {
        const observed = loadFrom(function (context) {
            const store = {};
            store[context.INDEX_STAGING_KEY] = serializedIndex(context, "staged-key", 2);
            return store;
        });

        expect(observed.reason).toBe("recovered-staging");
        expect(observed.entries.length).toBe(2);
        expect(observed.validityKey).toBe("staged-key");
        // Nothing was removed: a load never deletes a payload (Requirement 9.8).
        expect(observed.realm.store[persistence.INDEX_STAGING_KEY]).toBeDefined();
    });

    test('reports "recovered-staging" when the committed key is corrupt and staging verifies', function () {
        const observed = loadFrom(function (context) {
            const store = {};
            store[context.INDEX_KEY] = '{"version":1,"validityKey":"k","entries":[{"folderPath":"a"';
            store[context.INDEX_STAGING_KEY] = serializedIndex(context, "staged-key", 3);
            return store;
        });

        expect(observed.reason).toBe("recovered-staging");
        expect(observed.entries.length).toBe(3);
        expect(observed.validityKey).toBe("staged-key");
        // The corrupt committed payload is left in place, not cleaned up on load.
        expect(observed.realm.store[persistence.INDEX_KEY]).toContain('"folderPath":"a"');
    });

    test('reports "recovered-previous" when only the previous-good key holds a payload', function () {
        const observed = loadFrom(function (context) {
            const store = {};
            store[context.INDEX_PREV_KEY] = serializedIndex(context, "previous-key", 1);
            return store;
        });

        expect(observed.reason).toBe("recovered-previous");
        expect(observed.entries.length).toBe(1);
        expect(observed.validityKey).toBe("previous-key");
    });

    test('reports "recovered-previous" when both the committed and staging keys are unusable', function () {
        const observed = loadFrom(function (context) {
            const store = {};
            store[context.INDEX_KEY] = "not json at all";
            store[context.INDEX_STAGING_KEY] = '"a string, not an object"';
            store[context.INDEX_PREV_KEY] = serializedIndex(context, "previous-key", 4);
            return store;
        });

        expect(observed.reason).toBe("recovered-previous");
        expect(observed.entries.length).toBe(4);
        expect(observed.validityKey).toBe("previous-key");
    });

    test('reports "version-ahead" and consumes nothing for a payload from a newer build', function () {
        let stored = null;
        const observed = loadFrom(function (context) {
            const payload = JSON.parse(serializedIndex(context, "future-key", 5));
            payload.version = context.LIBRARY_INDEX_VERSION + 1;
            stored = JSON.stringify(payload);
            const store = {};
            store[context.INDEX_KEY] = stored;
            return store;
        });

        expect(observed.reason).toBe("version-ahead");
        // Requirement 9.9: no entries consumed, and the stored string untouched.
        expect(observed.entries).toEqual([]);
        expect(observed.validityKey).toBeNull();
        expect(observed.realm.store[persistence.INDEX_KEY]).toBe(stored);
    });

    test("the pre-Wave-2 reasons still come back unchanged", function () {
        const absent = loadFrom(function () { return {}; });
        expect(absent.reason).toBe("absent");

        const parsed = loadFrom(function (context) {
            const store = {};
            store[context.INDEX_KEY] = serializedIndex(context, "committed-key", 2);
            return store;
        });
        expect(parsed.reason).toBe("index-parsed");
        expect(parsed.entries.length).toBe(2);

        const empty = loadFrom(function (context) {
            const store = {};
            store[context.INDEX_KEY] = serializedIndex(context, "committed-key", 0);
            return store;
        });
        expect(empty.reason).toBe("index-empty");
    });
});

// ─── 3. A legacy stored validity key (Req 8.9) ──────────────────────────────
describe("changedRootsFromKeys with a pre-Wave-2 stored key", function () {
    const ROOTS = ["C:/lib/alpha", "D:/shared/gamma"];

    // The current key, built by the shipped v2 writer.
    const v2Key = persistence.buildCombinedValidityKey([
        { path: ROOTS[0], gen: 2, sig: "3:2048:1700|2:0:1650" },
        { path: ROOTS[1], gen: 0, sig: "1:99:1600" },
    ]);

    // What Wave 1 persisted: `path + ":" + count + ":" + size + ":" + mtime`,
    // joined by ";" — no version prefix, no unit separator.
    const legacyKey = "C:/lib/alpha:3:2048:1700;D:/shared/gamma:1:99:1600";

    test("the stored key really is not v2 and the current key really is", function () {
        expect(persistence.parseCombinedValidityKey(legacyKey).version).toBe(1);
        expect(persistence.parseCombinedValidityKey(legacyKey).tokens).toBeNull();
        expect(persistence.parseCombinedValidityKey(v2Key).version).toBe(2);
        expect(Object.keys(persistence.parseCombinedValidityKey(v2Key).tokens)).toEqual(ROOTS);
    });

    test("every root in the current key is reported changed", function () {
        const context = createTemplatesRealm({ libraryPaths: ROOTS.slice(), rootPath: ROOTS[0] });
        expect(context.changedRootsFromKeys(legacyKey, v2Key)).toEqual(ROOTS);
    });

    test("an absent or empty stored key reports every root changed too", function () {
        const context = createTemplatesRealm({ libraryPaths: ROOTS.slice(), rootPath: ROOTS[0] });
        expect(context.changedRootsFromKeys(null, v2Key)).toEqual(ROOTS);
        expect(context.changedRootsFromKeys("", v2Key)).toEqual(ROOTS);
        expect(context.changedRootsFromKeys(undefined, v2Key)).toEqual(ROOTS);
    });

    test("no persisted entry is discarded", function () {
        const index = new persistence.LibraryIndex({ validityKey: legacyKey });
        ROOTS.forEach(function (root, rootIndex) {
            for (let i = 0; i < 3; i++) {
                index.insertAtHead({
                    id: "legacy-" + rootIndex + "-" + i,
                    name: "Legacy " + rootIndex + "-" + i,
                    category: "Titles",
                    section: "comp",
                    type: "comp",
                    favorite: false,
                    folderPath: root + "/comp/Legacy " + rootIndex + "-" + i,
                    sourcePath: root,
                    thumbnail: "",
                });
            }
        });
        const persisted = persistence.LibraryIndex.tryParse(index.serialize());
        expect(persisted.ok).toBe(true);
        expect(persisted.index._entries.length).toBe(6);

        const context = createTemplatesRealm({
            libraryPaths: ROOTS.slice(),
            rootPath: ROOTS[0],
            allTemplates: persisted.index._entries,
            getLibraryIndex: function () { return persisted.index; },
        });

        const before = JSON.stringify(persisted.index._entries);
        const changed = context.changedRootsFromKeys(persisted.index.validityKey, v2Key);

        // Every root reconciles in the background, and the entries warm paint
        // already served are all still there, byte for byte.
        expect(changed).toEqual(ROOTS);
        expect(persisted.index._entries.length).toBe(6);
        expect(JSON.stringify(persisted.index._entries)).toBe(before);
        expect(context.allTemplates.length).toBe(6);
    });

    test("two v2 keys still narrow to the roots whose token moved", function () {
        const context = createTemplatesRealm({ libraryPaths: ROOTS.slice(), rootPath: ROOTS[0] });
        const moved = persistence.buildCombinedValidityKey([
            { path: ROOTS[0], gen: 3, sig: "3:2048:1700|2:0:1650" },
            { path: ROOTS[1], gen: 0, sig: "1:99:1600" },
        ]);
        expect(context.changedRootsFromKeys(v2Key, moved)).toEqual([ROOTS[0]]);
        expect(context.changedRootsFromKeys(v2Key, v2Key)).toEqual([]);
    });
});

// ─── 4. getCombinedDiskValidityKey honours its argument (Req 8.10) ──────────
describe("getCombinedDiskValidityKey path resolution", function () {
    const ARGUMENT_ROOT = "X";
    const GLOBAL_LIBRARY_ROOT = "C:/lib/other";
    const GLOBAL_ROOT_PATH = "C:/lib/rootish";

    function realmWithGlobals() {
        const tree = mergeTrees(
            libraryTree(ARGUMENT_ROOT, 0),
            libraryTree(GLOBAL_LIBRARY_ROOT, 7),
            libraryTree(GLOBAL_ROOT_PATH, 13)
        );
        const fakeFs = createFakeFs(tree);
        return createPersistenceRealm({}, {
            libraryPaths: [GLOBAL_LIBRARY_ROOT],
            rootPath: GLOBAL_ROOT_PATH,
            nfs: function () { return fakeFs; },
        });
    }

    test('getCombinedDiskValidityKey(["X"]) keys only "X", ignoring both globals', function () {
        const realm = realmWithGlobals();
        const key = realm.context.getCombinedDiskValidityKey([ARGUMENT_ROOT]);
        const parsed = persistence.parseCombinedValidityKey(key);

        expect(parsed.version).toBe(2);
        expect(Object.keys(parsed.tokens)).toEqual([ARGUMENT_ROOT]);
        expect(key).not.toContain(GLOBAL_LIBRARY_ROOT);
        expect(key).not.toContain(GLOBAL_ROOT_PATH);
        // A real signature was derived, not the unreadable-root placeholder:
        // generation 0 (never bumped) plus the section folds of libraryTree —
        // `comp` holding one category, the other six sections absent
        // (Requirement 8.5, design §Root_Signature).
        expect(parsed.tokens[ARGUMENT_ROOT]).toBe("0~" + READABLE_SIGNATURE);
        expect(parsed.tokens[ARGUMENT_ROOT]).not.toContain("null");
    });

    test("an absent argument falls back to libraryPaths", function () {
        const realm = realmWithGlobals();
        const parsed = persistence.parseCombinedValidityKey(realm.context.getCombinedDiskValidityKey());
        expect(Object.keys(parsed.tokens)).toEqual([GLOBAL_LIBRARY_ROOT]);
    });

    test("an empty argument array falls back to libraryPaths as well", function () {
        const realm = realmWithGlobals();
        const parsed = persistence.parseCombinedValidityKey(realm.context.getCombinedDiskValidityKey([]));
        expect(Object.keys(parsed.tokens)).toEqual([GLOBAL_LIBRARY_ROOT]);
    });

    test("libraryPaths absent falls back to rootPath, and the argument still wins over it", function () {
        const tree = mergeTrees(libraryTree(ARGUMENT_ROOT, 0), libraryTree(GLOBAL_ROOT_PATH, 13));
        const fakeFs = createFakeFs(tree);
        const realm = createPersistenceRealm({}, {
            libraryPaths: [],
            rootPath: GLOBAL_ROOT_PATH,
            nfs: function () { return fakeFs; },
        });

        expect(Object.keys(persistence.parseCombinedValidityKey(
            realm.context.getCombinedDiskValidityKey()
        ).tokens)).toEqual([GLOBAL_ROOT_PATH]);
        expect(Object.keys(persistence.parseCombinedValidityKey(
            realm.context.getCombinedDiskValidityKey([ARGUMENT_ROOT])
        ).tokens)).toEqual([ARGUMENT_ROOT]);
    });

    test("the argument's generation comes from the Root_Manifest, not from disk", function () {
        const tree = mergeTrees(libraryTree(ARGUMENT_ROOT, 0), libraryTree(GLOBAL_LIBRARY_ROOT, 7));
        const fakeFs = createFakeFs(tree);
        const realm = createPersistenceRealm({}, {
            libraryPaths: [GLOBAL_LIBRARY_ROOT],
            rootPath: null,
            nfs: function () { return fakeFs; },
        });

        realm.context.bumpRootGeneration(ARGUMENT_ROOT);
        realm.context.bumpRootGeneration(ARGUMENT_ROOT);

        const parsed = persistence.parseCombinedValidityKey(
            realm.context.getCombinedDiskValidityKey([ARGUMENT_ROOT])
        );
        expect(parsed.tokens[ARGUMENT_ROOT]).toBe("2~" + READABLE_SIGNATURE);
        expect(realm.context.getRootGeneration(GLOBAL_LIBRARY_ROOT)).toBe(0);
    });
});

// ─── 5. deriveRootSignature on an unreadable root / absent fs (Wave 2) ──────
describe("deriveRootSignature degraded inputs", function () {
    const ROOT = "C:/lib/alpha";

    test("returns null when readdirSync throws", function () {
        const throwingFs = {
            readdirSync: function () { throw new Error("EACCES: permission denied"); },
            statSync: function () { return { size: 0, mtimeMs: 0, isDirectory: function () { return true; } }; },
        };
        expect(persistence.deriveRootSignature(ROOT, throwingFs)).toBeNull();
    });

    test("returns null when no fs is available at all", function () {
        // This module realm has no `nfs` global, which is the ExtendScript case:
        // no Node filesystem, so no signature can be derived.
        expect(persistence.deriveRootSignature(ROOT)).toBeNull();
        expect(persistence.deriveRootSignature(ROOT, null)).toBeNull();
        expect(persistence.deriveRootSignature(ROOT, {})).toBeNull();
        expect(persistence.deriveRootSignature(ROOT, { readdirSync: "not a function" })).toBeNull();
    });

    test("returns null for an empty or absent root path", function () {
        const readableFs = createFakeFs(libraryTree(ROOT, 0));
        expect(persistence.deriveRootSignature("", readableFs)).toBeNull();
        expect(persistence.deriveRootSignature(null, readableFs)).toBeNull();
        expect(persistence.deriveRootSignature(undefined, readableFs)).toBeNull();
    });

    test("returns a signature for a readable root, so null really means unreadable", function () {
        const readableFs = createFakeFs(libraryTree(ROOT, 0));
        const signature = persistence.deriveRootSignature(ROOT, readableFs);
        expect(typeof signature).toBe("string");
        // Directory metadata only (Requirement 8.5): one
        // `<categories>:<newest category mtime>` fold per section folder, in the
        // fixed order comp, effect, footage, icon, layer, overlay, text. `comp`
        // holds one category (mtime 1200) so it folds to `1:1200`; the other six
        // sections are absent and fold to `-`. The .aep file inside the category
        // is never stat'ed, so its 512 bytes appear nowhere.
        expect(signature).toBe(READABLE_SIGNATURE);
        expect(signature).toBe("1:1200|-|-|-|-|-|-");
    });

    test("an unreadable root reaches the validity key as the unreadable placeholder", function () {
        const throwingFs = {
            readdirSync: function () { throw new Error("EACCES: permission denied"); },
        };
        const realm = createPersistenceRealm({}, {
            libraryPaths: [ROOT],
            rootPath: null,
            nfs: function () { return throwingFs; },
        });

        const parsed = persistence.parseCombinedValidityKey(realm.context.getCombinedDiskValidityKey([ROOT]));
        // null never compares equal to a recorded signature, so an unreadable
        // root is treated as changed rather than as fresh.
        expect(parsed.tokens[ROOT]).toBe("0~null");
    });
});
