// ============================================================
// tests/import-section-derivation.property.test.js
//
// Feature: catalog-patch-ordering-fixes (bugfix spec) — BUG C
//
// TASK 2 SLICE — P11 and P12 ONLY, recorded against UNFIXED source
// ----------------------------------------------------------------
// This file is the home the design gives BUG C's coverage. Task 2 opens it with
// the two PRESERVATION cases; task 6.3 appends the fix-checking cases C1, C2,
// C4 and C5 below the append point at the foot of the file.
//
//   P11 -> Property 6 (3.10)  the import payload, recorded field by field for
//                             400 generated records rendered in their OWN
//                             section, computed by the PRE-FIX rule
//                             (`section = currentSection`, templates.js:2542)
//   P12 -> Property 6 (3.11, 3.13)  tests/comp-pipeline-integration.test.js
//                             FLOW 6, both tests, named as the witnesses that
//                             makeCardFake() completes without throwing and
//                             that the .importing / .imported and toast
//                             assertions hold. NOT modified — located by
//                             content and re-asserted from the outside.
//
// Observation-first, applied literally
// -----------------------------------
// Nothing below encodes what design.md says the fixed code SHOULD do. P11 runs
// the unfixed `importCurrentCardToTimeline`, captures the payload it actually
// hands `importTemplates`, and asserts it against the pre-fix rule RECOMPUTED
// IN-TEST from the realm's own `getTemplateSourcePath` / `getTemplateSection`.
// Equality is therefore asserted against the old rule, never against a frozen
// snapshot string that could rot.
//
// P11 is DEFERRED in one half, on purpose
// ---------------------------------------
// The byte-identity equality AGAINST THE FIXED CODE lands in task 6.5. What is
// recorded here is the pre-fix payload corpus and the rule that reproduces it.
// Because every record is driven with `currentSection === record.section`, all
// four of the fixed derivation's routes answer with that same section, so the
// assertions in this file are expected to stay green verbatim once BUG C lands
// — that is exactly what makes them the preservation baseline. Task 6.5 re-runs
// them and additionally compares field by field against PRE_FIX_PAYLOAD_CORPUS,
// which buildRecordCorpus() below re-derives deterministically from a fixed
// seed. No payload is pasted into this file.
//
// One harness limitation, stated rather than worked around
// -------------------------------------------------------
// BUG D IS NOT LANDED, so tests/helpers/miniDom.js has no `dataset`, no
// `classList` and no `style`. `importCurrentCardToTimeline` reads
// `card.dataset.file` on its third line, so a card produced by the real
// `renderTemplateCardMarkup` and PARSED by miniDom cannot be driven through it
// yet. P11 therefore builds its card object by hand, from the record, with the
// attribute values `renderTemplateCardMarkup` (templates.js:820-829) emits —
// `data-file` = name, `data-cat` = category, `data-folder` = the normalized
// folderPath, plus the `tpl-<record id>` element id. tests/helpers/miniDom.js
// is NOT patched here: task 3 owns that file. The real render -> parse ->
// derive round trip is C2's subject and lands in task 6.3, after BUG D.
//
// Harness
// -------
// The realm pattern of tests/media-card-lifecycle-preservation.property.test.js:
// the real js/templates/templates.js loaded through tests/helpers/loadHelpers.js
// with `lenient: false`, the real js/templates/templateCatalog.js evaluated into
// the same realm, the real js/core/{constants,utils,pathBuilders}.js, and a real
// parsed miniDom document holding the six card grids. Only the environment is
// substituted at the boundary: `importTemplates` is a recorder, so the payload
// is captured exactly as production computed it and no bridge call is made.
//
// **Validates: Requirements 3.10, 3.11, 3.13**
// ============================================================

"use strict";

const crypto = require("crypto");
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

// P12's witness file. Re-run and read, NEVER edited (bugfix.md item 10).
const FLOW6_REL = path.join("tests", "comp-pipeline-integration.test.js");

// ─── Real shared panel modules ──────────────────────────────────────────────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
});

// The nine canonical sections, in SECTIONS declaration order.
const SECTION_VALUES = Object.keys(SECTIONS).map(function (k) { return SECTIONS[k]; });

// The six card grids index.html defines; resolveSectionGridId() picks one.
const GRID_IDS = [
    "comp-list-container",
    "icon-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container",
];

// ─── Observation recorder ───────────────────────────────────────────────────
// One representative observation per case, captured from the first run, so the
// recorded baseline is visible in the runner output rather than only implied by
// a green tick.
const OBSERVED = [];
function observe(caseId, note, data) {
    for (let i = 0; i < OBSERVED.length; i++) {
        if (OBSERVED[i].caseId === caseId) return;
    }
    OBSERVED.push({ caseId: caseId, note: note, data: data });
}

afterAll(function () {
    if (OBSERVED.length === 0) return;
    const lines = ["", "═══ OBSERVED BASELINE (unfixed source) ═══"];
    OBSERVED.forEach(function (entry) {
        lines.push("");
        lines.push("[" + entry.caseId + "] " + entry.note);
        lines.push(JSON.stringify(entry.data, null, 2));
    });
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
});

// ─── The import realm ───────────────────────────────────────────────────────
/**
 * One panel world built for the import path: a fresh vm realm holding the real
 * templates.js and the real TemplateCatalog, a real parsed DOM with all six
 * grids, and the real panel sanitizers.
 *
 * `importTemplates` is a RECORDER. importCurrentCardToTimeline computes the
 * whole payload before calling it, so recording the second argument captures
 * exactly what production computed — and no bridge call, no timer and no toast
 * is reached. That keeps the observation free of the transport, which is FLOW
 * 6's subject (P12) and not this file's.
 *
 * @param {{allTemplates?: object[], currentSection?: string, rootPath?: string}} [opts]
 */
function createImportRealm(opts) {
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

    const imports = [];      // every importTemplates call, in order
    const toasts = [];
    const timers = [];
    const warnings = [];
    const records = opts.allTemplates || [];

    const recordingConsole = {
        log: function () { },
        info: function () { },
        debug: function () { },
        warn: function () { warnings.push(Array.prototype.slice.call(arguments).map(String).join(" ")); },
        error: function () { warnings.push(Array.prototype.slice.call(arguments).map(String).join(" ")); },
    };

    const injected = {
        console: recordingConsole,
        window: { requestAnimationFrame: null },
        document: document,
        DOM: { "search-box": { value: "" } },

        // Real pure helpers from the shipped modules.
        SECTIONS: SECTIONS,
        IMAGE_SECTIONS: IMAGE_SECTIONS,
        escapeAttr: utils.get("escapeAttr"),
        escapeHTML: utils.get("escapeHTML"),
        getTemplateSection: utils.get("getTemplateSection"),
        normalizeSectionName: utils.get("normalizeSectionName"),
        isTextSection: utils.get("isTextSection"),
        isImageSection: utils.get("isImageSection"),

        // Real panel sanitizers (js/core/pathBuilders.js is the runtime rule set).
        getSafeName: pathBuilders.getSafeName,
        generateTemplateId: pathBuilders.generateTemplateId,
        cleanName: pathBuilders.cleanName,
        normalizeFolderPath: persistence.normalizeFolderPath,

        // Panel state templates.js reads.
        allTemplates: records,
        currentSection: opts.currentSection || SECTIONS.COMP,
        currentCategory: "All",
        tmpBulkSelected: [],
        libraryPaths: [opts.rootPath || "C:/lib"],
        rootPath: opts.rootPath || "C:/lib",
        savePath: opts.rootPath || "C:/lib",

        // No library index and no disk in this realm: the import path touches
        // neither.
        getLibraryIndex: function () { return null; },
        saveLibraryIndex: function () { },
        nfs: function () { return { existsSync: function () { return false; } }; },

        // THE CAPTURE SEAM. The payload is the second argument.
        importTemplates: function (deps, request, done) {
            imports.push({ deps: deps, request: request, done: done });
        },

        // Referenced when the deps object literal is built, so it must exist —
        // but never invoked, because the recorder above does not run the engine.
        encodeBridge: function (s) { return "" + s; },
        decodeBridge: function (s) { return "" + s; },
        callHost: function () { throw new Error("callHost is unreachable: importTemplates is a recorder"); },

        // Collaborators outside templates.js.
        updateCount: function () { },
        updateCustomSelect: function () { },
        Settings: { get: function () { return []; }, set: function () { } },
        TextAnim: { attachHoverPreviews: function () { } },
        showToast: function (msg, kind) { toasts.push({ msg: "" + msg, kind: kind }); },

        // Timers are recorded, never run.
        setTimeout: function (fn, delay) { timers.push({ fn: fn, delay: delay }); return timers.length; },
        clearTimeout: function () { },
    };

    const handle = loadHelpers({ file: TEMPLATES_REL, injected: injected, lenient: false });
    if (handle.error) throw handle.error;

    // The real catalog, in the same realm, exactly as index.html loads it.
    vm.runInContext(CATALOG_SRC, handle.context, { filename: "templateCatalog.js" });
    handle.context.TemplateCatalog.build(records, handle.context.getTemplateSection, 1);

    return {
        context: handle.context,
        document: document,
        grids: grids,
        imports: imports,
        toasts: toasts,
        timers: timers,
        warnings: warnings,
        /** The single payload of the most recent import, or null. */
        lastPayload: function () {
            return imports.length ? imports[imports.length - 1].request : null;
        },
    };
}

// ─── The card object importCurrentCardToTimeline is handed ───────────────────
/**
 * The card for `record`, carrying the attribute VALUES
 * renderTemplateCardMarkup emits (templates.js:820-829) — `data-file` = name,
 * `data-cat` = category, `data-folder` = the forward-slashed folderPath,
 * `data-thumb`, and the `tpl-<record id>` element id.
 *
 * Hand-built rather than parsed, because miniDom has no `dataset` until BUG D
 * lands (task 3.2) and the parsed round trip therefore cannot be driven yet.
 * The values are the raw record values, which is what an attribute parse of the
 * escaped markup decodes back to; proving that round trip is C2's job, in task
 * 6.3.
 */
function makeCardForRecord(record) {
    const classes = {};
    return {
        id: "tpl-" + (record.id === undefined || record.id === null ? "" : "" + record.id),
        dataset: {
            file: record.name,
            cat: record.category,
            folder: ("" + (record.folderPath || "")).replace(/\\/g, "/"),
            thumb: ("" + (record.thumbnail || "")).replace(/\\/g, "/"),
        },
        style: { transform: "" },
        classList: {
            add: function (c) { classes[c] = true; },
            remove: function (c) { delete classes[c]; },
            contains: function (c) { return classes[c] === true; },
        },
        __classes: classes,
    };
}

// ─── The pre-fix rule, recomputed in-test ───────────────────────────────────
/**
 * The payload `importCurrentCardToTimeline` builds under the PRE-FIX
 * derivation, expressed as the source expresses it (templates.js:2542-2546,
 * :2610-2618):
 *
 *     var section     = currentSection;                       // THE PRE-FIX RULE
 *     var normSection = getTemplateSection({ section: section });
 *     var name        = card.dataset.file;
 *     var cat         = card.dataset.cat;
 *     var cardFolder  = (card.dataset.folder || "").replace(/\\/g, "/");
 *
 * Note the payload's `id` is the **name**, not the record id — the record id
 * appears only in the card's `tpl-` element id.
 *
 * @param {object} ctx the realm global object (for its own getTemplateSourcePath
 *        and getTemplateSection, so the expected side uses the SAME rule the
 *        production code uses rather than a re-implementation of it).
 * @param {object} card the card handed to importCurrentCardToTimeline.
 * @param {string} activeSection the value of `currentSection` at call time.
 */
function preFixImportPayload(ctx, card, activeSection) {
    const name = card.dataset.file;
    const cat = card.dataset.cat;
    const section = activeSection;
    const normSection = typeof ctx.getTemplateSection === "function"
        ? ctx.getTemplateSection({ section: section })
        : ("" + section).toLowerCase();
    const cardFolder = ("" + (card.dataset.folder || "")).replace(/\\/g, "/");
    return {
        rootPath: ctx.getTemplateSourcePath(name, cat),
        templates: [{
            id: name,
            name: name,
            category: cat,
            section: normSection,
            sourcePath: ctx.getTemplateSourcePath(name, cat),
            folderPath: cardFolder || "",
        }],
    };
}

/** An immutable copy of a captured payload, so nothing can rewrite the record. */
function snapshotPayload(request) {
    const t = (request.templates && request.templates[0]) || {};
    const out = { rootPath: request.rootPath, templates: [{}] };
    Object.keys(t).forEach(function (k) { out.templates[0][k] = t[k]; });
    return out;
}

// The seven payload fields clause 3.10 pins, in the order the source writes them.
const PAYLOAD_TEMPLATE_FIELDS = ["id", "name", "category", "section", "sourcePath", "folderPath"];

// ─── The generated record corpus ────────────────────────────────────────────
// Deterministic by construction: one fixed seed, one fixed size, and every
// derived field computed from the sampled shape. Task 6.5 re-derives the
// comparison corpus by calling buildRecordCorpus() again — the corpus is
// REPRODUCIBLE FROM THIS FILE and no payload is pasted anywhere in it.
const CORPUS_SEED = 20240611;
const CORPUS_SIZE = 400;

const NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.&'".split("");

// Property 6 covers imports that work today. The unfixed catalog stores
// category buckets in plain objects, so Object.prototype key names cannot be
// built successfully and are outside that input class. Keep the generator
// broad while excluding exactly that unrelated pre-existing limitation.
const CATEGORY_BASE_ARB = fc.stringOf(
    fc.constantFrom.apply(fc, NAME_CHARS),
    { minLength: 1, maxLength: 14 }
).filter(function (value) {
    return !Object.prototype.hasOwnProperty.call(Object.prototype, value);
});

const RECORD_SHAPE_ARB = fc.record({
    sectionIndex: fc.nat({ max: SECTION_VALUES.length - 1 }),
    rootIndex: fc.nat({ max: 2 }),
    nameBase: fc.stringOf(fc.constantFrom.apply(fc, NAME_CHARS), { minLength: 1, maxLength: 18 }),
    categoryBase: CATEGORY_BASE_ARB,
    media: fc.boolean(),
    hasFolder: fc.boolean(),
    favorite: fc.boolean(),
});

const CORPUS_ROOTS = ["C:/lib", "D:/Assets Lib", "//server/share/lib"];

/**
 * 400 records, deterministic for a fixed seed.
 *
 * (name, category) is kept UNIQUE across the corpus on purpose. Both
 * `getTemplateSourcePath` (templates.js:2138) and the fixed derivation's route
 * 2 scan `allTemplates` for the FIRST name+category match with no section
 * clause, so a duplicated pair would make the expected `rootPath` / `sourcePath`
 * depend on corpus order rather than on the record — which is not the thing a
 * preservation corpus is for. The ambiguous case belongs to the fix-checking
 * cases, and `## Notes` records it as out of scope for this spec.
 */
function buildRecordCorpus() {
    const shapes = fc.sample(RECORD_SHAPE_ARB, { numRuns: CORPUS_SIZE, seed: CORPUS_SEED });
    const seenKey = Object.create(null);
    const seenId = Object.create(null);
    const out = [];

    for (let i = 0; i < shapes.length; i++) {
        const shape = shapes[i];
        const section = SECTION_VALUES[shape.sectionIndex];
        const root = CORPUS_ROOTS[shape.rootIndex];
        const category = shape.categoryBase;

        let name = shape.nameBase + " " + i;
        while (seenKey[name + "||" + category]) name = name + "~";
        seenKey[name + "||" + category] = true;

        const safeCat = pathBuilders.getSafeName(category);
        const leaf = shape.media
            ? "media-" + i.toString(16)
            : pathBuilders.generateTemplateId(name);
        const folderPath = shape.hasFolder
            ? root + "/" + utils.get("normalizeSectionName")(section) + "/" + safeCat + "/" + leaf
            : "";

        let id = shape.media ? "media-" + i.toString(16) : pathBuilders.generateTemplateId(name);
        while (seenId[id]) id = id + "-" + i;
        seenId[id] = true;

        const record = {
            id: id,
            name: name,
            category: category,
            section: section,
            favorite: shape.favorite,
            folderPath: folderPath,
            // A non-media record's sourcePath IS its library root, which is what
            // getTemplateSourcePath returns for it. A media record's sourcePath
            // is the original imported file — never a root — which is why the
            // media branch derives the root from folderPath instead.
            sourcePath: shape.media ? root + "/incoming/clip" + i + ".mp4" : root,
        };
        if (shape.media) {
            record.type = "media";
            record.mediaType = "video";
            record.mediaFile = "clip" + i + ".mp4";
        }
        out.push(record);
    }
    return out;
}

/** A digest of a payload corpus — reported, never asserted against a constant. */
function corpusDigest(payloads) {
    return crypto.createHash("sha256").update(JSON.stringify(payloads)).digest("hex").substring(0, 16);
}

// Filled by P11 so task 6.5 can compare the fixed code's payloads against the
// recorded pre-fix ones field by field, in this same file.
const PRE_FIX_PAYLOAD_CORPUS = [];

// ─── Content-anchored witness lookup (P12) ──────────────────────────────────
// P12 must go RED if FLOW 6 is deleted or weakened, without pinning a LOCATION:
// this spec edits js/templates/templates.js and tests/helpers/miniDom.js, and
// tests/comp-pipeline-integration.test.js sits above and below code that moves.
// So both ends of every witness are anchored on CONTENT and the line numbers are
// DISCOVERED and reported. Exactly one match is required: a deleted witness (0)
// and a duplicated or diluted one (2+) are both regressions, because in either
// case the "already covered" claim can no longer be trusted.

function repoLines(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8").split(/\r?\n/);
}

/** The single line of `relPath` containing `needle`, as a 1-based line number. */
function findWitnessLine(relPath, needle) {
    const lines = repoLines(relPath);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(needle) !== -1) hits.push({ line: i + 1, text: lines[i] });
    }
    if (hits.length !== 1) {
        throw new Error(
            "witness lookup failed in " + relPath + ": expected exactly 1 line containing " +
            JSON.stringify(needle) + ", found " + hits.length +
            (hits.length ? " at line(s) " + hits.map(function (h) { return h.line; }).join(", ") : "") +
            ". This witness backs a preservation claim in the design's property map (P12) — " +
            "it was moved out of recognisable shape, weakened, deleted or duplicated. " +
            "Re-establish it before trusting that claim."
        );
    }
    return hits[0];
}

/**
 * The block that opens at the unique line containing `needle` and closes at the
 * first following line whose text is exactly the opener's own indentation plus
 * `closerBody`. Every nested block is indented further, so that line is the
 * block's own close — which a trim-based closer cannot do.
 */
function findWitnessBlock(relPath, needle, closerBody) {
    const open = findWitnessLine(relPath, needle);
    const indent = /^\s*/.exec(open.text)[0];
    const closer = indent + closerBody;
    const lines = repoLines(relPath);
    for (let i = open.line; i < lines.length; i++) {
        if (lines[i] !== closer) continue;
        const block = lines.slice(open.line - 1, i + 1);
        return {
            startLine: open.line,
            endLine: i + 1,
            lines: block,
            text: block.join("\n"),
        };
    }
    throw new Error(
        "witness lookup failed in " + relPath + ": the block opening at line " + open.line +
        " (" + JSON.stringify(needle) + ") has no closing line " + JSON.stringify(closer) +
        " below it. The witness block is no longer delimited the way the design describes."
    );
}

// The anchors P12 addresses FLOW 6 by. Content, not line numbers.
const FLOW6_DESCRIBE = 'describe("FLOW 6 — a never-returning host still settles';
const FLOW6_FAKE = "function makeCardFake() {";
const FLOW6_TEST_TIMEOUT = "the transport's own timeout settles the action";
const FLOW6_TEST_SENTINEL = "sentinel is reported as a host error, not decoded as hex";

// ============================================================
// P11 — Property 6 (3.10)
//
// The import payload for a card rendered in its OWN section, recorded field by
// field over 400 generated records, computed by the pre-fix rule.
//
// **Validates: Requirements 3.10**
// ============================================================
describe("P11 — the pre-fix import payload, recorded field by field (Property 6, clause 3.10)", () => {

    test("the harness captures the call importCurrentCardToTimeline actually makes", () => {
        const records = buildRecordCorpus();
        const realm = createImportRealm({ allTemplates: records, currentSection: records[0].section });
        const card = makeCardForRecord(records[0]);

        realm.context.importCurrentCardToTimeline(card);

        // Exactly one import, and the payload is the SECOND argument — the
        // premise every assertion below rests on.
        expect(realm.imports.length).toBe(1);
        const call = realm.imports[0];
        expect(typeof call.deps).toBe("object");
        expect(typeof call.done).toBe("function");
        expect(Object.keys(call.request).sort()).toEqual(["rootPath", "templates"]);
        expect(call.request.templates.length).toBe(1);

        // Observed, not restated from the design: the engine backstop and the
        // hook set the payload recording travels with. FLOW 6 owns the transport
        // itself (P12); this only pins the call shape the capture depends on.
        expect(call.deps.timeoutMs).toBe(130000);
        expect(typeof call.deps.callHost).toBe("function");
        expect(typeof call.deps.onStarted).toBe("function");
        expect(typeof call.deps.resolveCached).toBe("function");

        // The recorder does not run the engine, so onStarted never fires and no
        // class, timer or toast is reached. Recorded so a later reader does not
        // mistake this file for a lifecycle test.
        expect(card.__classes.importing).toBeUndefined();
        expect(realm.timers.length).toBe(0);
        expect(realm.toasts.length).toBe(0);
        expect(realm.warnings).toEqual([]);

        observe("P11-shape", "the call importCurrentCardToTimeline makes, and the payload's own shape", {
            argumentCount: "importTemplates(deps, request, done)",
            depsKeys: Object.keys(call.deps).sort(),
            requestKeys: Object.keys(call.request).sort(),
            templateKeys: Object.keys(call.request.templates[0]),
            engineBackstopMs: call.deps.timeoutMs,
        });
    });

    test("the record corpus is reproducible from this file, not pasted into it", () => {
        const a = buildRecordCorpus();
        const b = buildRecordCorpus();

        expect(a.length).toBe(CORPUS_SIZE);
        expect(b).toEqual(a);            // same seed, same 400 records, every field

        // (name, category) is unique, so getTemplateSourcePath's first-match
        // scan is unambiguous for every record in the corpus.
        const keys = {};
        const ids = {};
        a.forEach(function (r) {
            keys[r.name + "||" + r.category] = (keys[r.name + "||" + r.category] || 0) + 1;
            ids[r.id] = (ids[r.id] || 0) + 1;
        });
        expect(Object.keys(keys).length).toBe(CORPUS_SIZE);
        expect(Object.keys(ids).length).toBe(CORPUS_SIZE);

        // The corpus spans what the payload actually varies on: all nine
        // sections, both the media and the non-media rootPath branch, and both
        // a present and an absent data-folder.
        const sections = {};
        let media = 0;
        let emptyFolder = 0;
        a.forEach(function (r) {
            sections[r.section] = (sections[r.section] || 0) + 1;
            if (r.type === "media") media++;
            if (!r.folderPath) emptyFolder++;
        });
        expect(Object.keys(sections).sort()).toEqual(SECTION_VALUES.slice().sort());
        expect(media).toBeGreaterThan(0);
        expect(a.length - media).toBeGreaterThan(0);
        expect(emptyFolder).toBeGreaterThan(0);

        observe("P11-corpus", "the generated record corpus, reproducible from CORPUS_SEED", {
            seed: CORPUS_SEED,
            size: a.length,
            perSection: sections,
            mediaRecords: media,
            recordsWithNoFolderPath: emptyFolder,
            firstRecord: a[0],
        });
    });

    test("400 records in their own section: every payload field equals the pre-fix rule", () => {
        const records = buildRecordCorpus();
        const realm = createImportRealm({ allTemplates: records, currentSection: records[0].section });
        const ctx = realm.context;

        const mismatches = [];
        let captured = 0;

        for (let i = 0; i < records.length; i++) {
            const record = records[i];

            // "Rendered in its OWN section": the active section IS the record's.
            // This is the input class clause 3.10 pins, and it is the class in
            // which the fixed derivation's four routes all agree with
            // currentSection — which is why this baseline survives the fix.
            ctx.currentSection = record.section;

            const card = makeCardForRecord(record);
            const before = realm.imports.length;
            ctx.importCurrentCardToTimeline(card);
            if (realm.imports.length !== before + 1) {
                mismatches.push({ index: i, field: "<no import issued>", actual: realm.imports.length - before, expected: 1 });
                continue;
            }
            captured++;

            const actual = snapshotPayload(realm.lastPayload());
            const expected = preFixImportPayload(ctx, card, record.section);

            // Field by field, so a failure names the field rather than dumping
            // two objects.
            if (actual.rootPath !== expected.rootPath) {
                mismatches.push({ index: i, field: "rootPath", actual: actual.rootPath, expected: expected.rootPath });
            }
            const gotKeys = Object.keys(actual.templates[0]);
            if (gotKeys.join(",") !== PAYLOAD_TEMPLATE_FIELDS.join(",")) {
                mismatches.push({ index: i, field: "<templates[0] field set>", actual: gotKeys, expected: PAYLOAD_TEMPLATE_FIELDS });
            }
            PAYLOAD_TEMPLATE_FIELDS.forEach(function (field) {
                if (actual.templates[0][field] !== expected.templates[0][field]) {
                    mismatches.push({
                        index: i,
                        field: "templates[0]." + field,
                        actual: actual.templates[0][field],
                        expected: expected.templates[0][field],
                    });
                }
            });

            // The payload's id is the NAME, not the record id. Recorded as its
            // own claim because it is the one field whose name invites the
            // opposite assumption.
            if (actual.templates[0].id !== record.name) {
                mismatches.push({ index: i, field: "templates[0].id !== record.name", actual: actual.templates[0].id, expected: record.name });
            }

            PRE_FIX_PAYLOAD_CORPUS.push({
                recordId: record.id,
                section: record.section,
                currentSection: record.section,
                payload: actual,
            });
        }

        expect(mismatches).toEqual([]);
        expect(captured).toBe(CORPUS_SIZE);
        expect(PRE_FIX_PAYLOAD_CORPUS.length).toBe(CORPUS_SIZE);

        // The pre-fix rule in one line, made executable: with the card in the
        // active section the payload's section is the ACTIVE section's
        // normalization. normalizeSectionName is the identity on all nine
        // SECTIONS values, so it is also the record's own section here — which
        // is precisely why the two rules are indistinguishable in this input
        // class and distinguishable in C2's.
        PRE_FIX_PAYLOAD_CORPUS.forEach(function (entry) {
            expect(entry.payload.templates[0].section)
                .toBe(ctx.getTemplateSection({ section: entry.currentSection }));
            expect(entry.payload.templates[0].section).toBe(entry.section);
        });

        observe("P11", "the pre-fix payload, recorded field by field (first three of 400)", {
            rule: "section = currentSection (js/templates/templates.js:2542-2543)",
            recordedFields: ["rootPath"].concat(PAYLOAD_TEMPLATE_FIELDS.map(function (f) { return "templates[0]." + f; })),
            corpusSize: PRE_FIX_PAYLOAD_CORPUS.length,
            corpusDigest: corpusDigest(PRE_FIX_PAYLOAD_CORPUS),
            samples: PRE_FIX_PAYLOAD_CORPUS.slice(0, 3),
            mediaSample: (function () {
                for (let i = 0; i < records.length; i++) {
                    if (records[i].type === "media") {
                        return { record: records[i], payload: PRE_FIX_PAYLOAD_CORPUS[i].payload };
                    }
                }
                return null;
            })(),
            emptyFolderSample: (function () {
                for (let i = 0; i < records.length; i++) {
                    if (!records[i].folderPath) {
                        return { record: records[i], payload: PRE_FIX_PAYLOAD_CORPUS[i].payload };
                    }
                }
                return null;
            })(),
            deferred: "the byte-identity equality against the FIXED code lands in task 6.5; " +
                "it re-derives this corpus by calling buildRecordCorpus() again",
        });
    });
});

// ============================================================
// P12 — Property 6 (3.11, 3.13)
//
// tests/comp-pipeline-integration.test.js FLOW 6, both tests, named as the
// witnesses that makeCardFake() completes without throwing and that the
// .importing / .imported and toast assertions hold.
//
// CONFIRM-ONLY. The witness file is NOT edited (bugfix.md item 10). In
// particular makeCardFake() is not adjusted, gains no `id` and gains no
// `getAttribute`: the ABSENCE of those two members is the regression witness for
// clause 3.13, so anything that supplied them would destroy the evidence.
//
// **Validates: Requirements 3.11, 3.13**
// ============================================================
describe("P12 — FLOW 6 is the witness for 3.11 and 3.13, unmodified (Property 6)", () => {

    test("FLOW 6 is present and holds exactly its two tests", () => {
        const describeBlock = findWitnessBlock(FLOW6_REL, FLOW6_DESCRIBE, "});");
        const timeoutTest = findWitnessBlock(FLOW6_REL, FLOW6_TEST_TIMEOUT, "});");
        const sentinelTest = findWitnessBlock(FLOW6_REL, FLOW6_TEST_SENTINEL, "});");

        // Both tests live inside FLOW 6's describe.
        [timeoutTest, sentinelTest].forEach(function (t) {
            expect(t.startLine).toBeGreaterThan(describeBlock.startLine);
            expect(t.endLine).toBeLessThan(describeBlock.endLine);
        });
        // Two, and only two.
        const testOpeners = describeBlock.lines.filter(function (l) { return /^\s{4}test\(/.test(l); });
        expect(testOpeners.length).toBe(2);

        // Test 1 — the transport's own timeout. The assertions clause 3.11 rests
        // on, each addressed by content so weakening one goes red here.
        expect(timeoutTest.text).toContain('card.classList.contains("importing")');
        expect(timeoutTest.text).toContain('card.classList.contains("imported")');
        expect(timeoutTest.text).toContain('hostFnName(evalCalls[0])).toBe("importBatch")');
        expect(timeoutTest.text).toContain("expect(evalCalls.length).toBe(1)");
        expect(timeoutTest.text).toContain("toMatch(/timed out/i)");
        expect(timeoutTest.text).toContain("toMatch(/After Effects did not respond/i)");
        expect(timeoutTest.text).toContain("{ timeoutMs: 120000 }");
        expect(timeoutTest.text).toContain("timeoutMs: 130000");

        // Test 2 — the CEP sentinel is a host error, not hex.
        expect(sentinelTest.text).toContain('card.classList.contains("importing")');
        expect(sentinelTest.text).toContain('toContain("EvalScript error.")');

        // Both surface ERROR toasts, so the success-toast branch — the one BUG
        // C's fix reads the derived section through — cannot reach either test.
        expect(timeoutTest.text).toContain("panel.errorToasts()");
        expect(sentinelTest.text).toContain("panel.errorToasts()");
        expect(describeBlock.text.indexOf("Composition imported")).toBe(-1);
        expect(describeBlock.text.indexOf("Imported successfully")).toBe(-1);
        expect(describeBlock.text.indexOf("Applied to text")).toBe(-1);

        // Neither test asserts the payload's section, which is why the
        // derivation change cannot move them.
        expect(describeBlock.text.indexOf("templates[0].section")).toBe(-1);

        observe("P12", "FLOW 6, located by content — line numbers DISCOVERED, not asserted", {
            file: FLOW6_REL,
            describe: { startLine: describeBlock.startLine, endLine: describeBlock.endLine },
            tests: [
                { name: FLOW6_TEST_TIMEOUT, startLine: timeoutTest.startLine, endLine: timeoutTest.endLine },
                { name: FLOW6_TEST_SENTINEL, startLine: sentinelTest.startLine, endLine: sentinelTest.endLine },
            ],
            asserts: [
                ".importing added on start and removed on settle",
                ".imported never added on a failed import",
                "exactly one importBatch bridge call",
                "callHost at { timeoutMs: 120000 }, engine backstop at 130000",
                "the timeout toast names that After Effects did not respond",
                'the "EvalScript error." sentinel is a host error, not hex',
            ],
            neverAsserts: ["the payload's section", "any success toast"],
        });
    });

    test("makeCardFake() supplies { dataset, style, classList } with no id and no getAttribute", () => {
        const block = findWitnessBlock(FLOW6_REL, FLOW6_FAKE, "}");

        // Evaluated, not merely grepped: the shape claim clause 3.13 rests on is
        // a claim about the OBJECT, so it is asserted about the object. The
        // witness file is read, never written.
        const fake = vm.runInNewContext("(" + block.text + ")()");

        expect(typeof fake.dataset).toBe("object");
        expect(typeof fake.style).toBe("object");
        expect(typeof fake.classList).toBe("object");
        expect(typeof fake.classList.add).toBe("function");
        expect(typeof fake.classList.remove).toBe("function");
        expect(typeof fake.classList.contains).toBe("function");

        // THE REGRESSION WITNESS. No `id` — as an own property or anywhere on
        // the chain — and no `getAttribute`. `card.id` reads as `undefined`,
        // which is what the fixed derivation's route 1 has to tolerate, and
        // `getAttribute` is never called at all.
        expect(Object.prototype.hasOwnProperty.call(fake, "id")).toBe(false);
        expect("id" in fake).toBe(false);
        expect(fake.id).toBeUndefined();
        expect(fake.getAttribute).toBeUndefined();
        expect(block.text.indexOf("getAttribute")).toBe(-1);

        // Its own dataset, recorded because the fallback chain's answer for this
        // card is read out of it: data-folder's third-from-last segment is
        // "comp", which equals the harness's default currentSection.
        expect(fake.dataset.file).toBe("T1");
        expect(fake.dataset.cat).toBe("Cat");
        expect(fake.dataset.folder).toBe("C:/lib/comp/Cat/T1");
        const parts = fake.dataset.folder.split("/");
        expect(parts[parts.length - 3]).toBe(SECTIONS.COMP);

        // The pre-fix behaviour this fake exhibits today: with `currentSection`
        // at the harness default, the payload's section is "comp" — and it stays
        // "comp" for this card whatever the derivation becomes, which is why
        // FLOW 6 does not move.
        const realm = createImportRealm({ allTemplates: [], currentSection: SECTIONS.COMP });
        realm.context.importCurrentCardToTimeline(fake);
        expect(realm.imports.length).toBe(1);
        const payload = snapshotPayload(realm.lastPayload());
        expect(payload.templates[0].section).toBe(SECTIONS.COMP);
        expect(payload.templates[0].id).toBe("T1");
        expect(payload.templates[0].folderPath).toBe("C:/lib/comp/Cat/T1");
        expect(realm.warnings).toEqual([]);

        observe("P12-fake", "makeCardFake()'s shape, evaluated out of the unmodified witness file", {
            file: FLOW6_REL,
            block: { startLine: block.startLine, endLine: block.endLine },
            ownKeys: Object.keys(fake),
            hasId: Object.prototype.hasOwnProperty.call(fake, "id"),
            hasGetAttribute: fake.getAttribute !== undefined,
            dataset: fake.dataset,
            folderThirdFromLastSegment: parts[parts.length - 3],
            preFixPayloadForThisCard: payload,
        });
    });
});

// ============================================================
// APPEND POINT — task 6.3 (BUG C fix checking)
//
// C1, C2, C4 and C5 belong below this banner. Reusable from above, with no
// change needed to any of it:
//
//   createImportRealm(opts)      the realm, with importTemplates as a recorder
//                                and TemplateCatalog built over opts.allTemplates
//   makeCardForRecord(record)    the hand-built card. C2 replaces it with the
//                                real renderTemplateCardMarkup -> miniDom parse
//                                round trip, which needs BUG D's `dataset`
//   preFixImportPayload(...)     the pre-fix rule, for P11's deferred equality
//   snapshotPayload(request)     an immutable copy of a captured payload
//   buildRecordCorpus()          the 400-record corpus, deterministic from
//                                CORPUS_SEED — task 6.5 re-derives it from here
//   PRE_FIX_PAYLOAD_CORPUS       what P11 recorded, for the field-by-field
//                                comparison in task 6.5
//   findWitnessBlock(...)        content-anchored source lookup
//   observe(...)                 the run-visible observation log
//
// C5 needs the success toast, which the recorder above does not reach: invoke
// the captured `done` with an { perTemplate: [{ status: "imported" }] } result
// to drive the toast branch, and flush realm.timers for the .imported removal.
// ============================================================
