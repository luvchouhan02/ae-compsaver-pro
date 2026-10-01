// ============================================================
// tests/media-card-lifecycle-preservation.property.test.js
//
// Feature: media-card-lifecycle-edge-fixes (bugfix spec, task 2)
//
// PRESERVATION BASELINE — every case here PASSES on UNFIXED source
// ----------------------------------------------------------------
// Task 1 (tests/media-card-lifecycle-exploration.test.js) recorded what the
// unfixed code gets WRONG. This file records what it gets RIGHT, so the six
// fixes have something to be measured against. A red case here is a regression,
// never a discovery.
//
// Observation-first methodology, applied literally: for every non-bug input
// class the unfixed code was RUN first and its actual output recorded, and only
// then was that output encoded as the assertion. Nothing below encodes a belief
// about what the code ought to do. Where the unfixed behaviour is surprising it
// is asserted as observed and the surprise is written down next to it.
//
// Case map (the design's Preservation Checking list):
//
//   P1  -> Property 4  (3.4)  non-media folder-path resolution, byte-identical
//   P2  -> Property 2  (3.2, 3.3)  warm paint leaves thumbnailPath alone
//   P2c -> Property 2  (3.1)  refreshCardThumbnail's in-session contract
//   P3  -> Property 6  (3.6)  clean categories are unmoved by the cleanName fold
//   P4  -> Property 6  (3.7)  the PNG host call's 5-argument monolithic form
//   P5  -> Property 9  (3.10) freshness stays conditional — THE BINDING TEST
//   P6  -> Property 9  (3.10) refreshCardThumbnail exclusion witness
//   P7  -> Property 9  (3.11) the clone-rewrite probes stay live
//   P8  -> Property 4  (3.5)  patchUITemplate matching + routing
//   P9  -> Property 7  (3.8, 3.9) the renderTemplateCardMarkup URL guard
//   P10 -> Property 10 (3.12, 3.13, 2.12) the startup scan section list
//   P12 -> Property 2  the four startup performance suites are inert fixtures
//
// The fix-checking cases the bug tasks add here, each next to the preservation
// case it is the counterpart of:
//
//   F1  -> Property 1  (2.1, 2.2) warm paint renders a persisted thumbnail —
//          generated raw paths through hydrateWarmPaintThumbnail, the helper's
//          decision table, buildBustedThumbUrl's unit table, and the
//          close-and-reopen integration case (task 6.5)
//   F2  -> Property 3  (2.3, 2.4) the mutation helpers address a media entry's
//          real folder — generated media entries through removeUITemplate and
//          patchUITemplate, plus the _findUITemplateRecord /
//          _getTemplateFolderPath unit tables (task 4.3)
//   F3  -> Property 5  (2.5, 2.6) category segment parity with the host — the
//          unit table, 2000 hostile generated categories, and E7's integration
//          form re-driven on fixed code (task 3.5)
//   F4  -> Property 8  (2.9, 2.10) the seven markTemplatesDirty sites, each
//          driven through its real entry point; the shared-vs-cloned aliasing
//          boundary S4 and S5 sit on; the generated mutation-sequence property;
//          and the revision-counter unit case (task 5.8)
//   F4-exclusions -> Property 9 (3.1, 3.10, 3.11) the executable form of task
//          5.7's audit: exactly eight occurrences of the identifier in js/**,
//          none in js/core/persistence.js, none in any of the five functions D3
//          dropped, and the hayFor / counts claim that exclusion rests on
//          verified against js/templates/templateCatalog.js rather than assumed
//
// ONE PRESERVATION CASE WAS INVERTED, not added: P1's media-boundary case. It
// records where P1's byte-identity guarantee stops — the single input class
// BUG 2 is permitted to move. Pre-fix it stated that boundary from the pre-fix
// side (a media record resolves by name); post-fix it states the same boundary
// from the other side (a media record resolves to its own folderPath, and NOT
// to the name-based reconstruction, which is still recomputed in-test). See
// task 4.3.
//
// F1, F2, F3 and F4 have landed (tasks 6.5, 4.3, 3.5 and 5.8). Each sits
// directly below the preservation case it is the counterpart of — F1 below P2,
// F2 below P1, F3 below P3, and F4 with its sequence property and exclusion
// audit below P7, since P5, P6 and P7 are all Property 9.
//
// P4, P9's never-reached-renderer half and P12 are POINTERS to tests that
// already exist. They locate each witness by CONTENT — see findWitnessLine —
// and assert it still says what the design says it says, reporting the
// discovered line number for the reader. They deliberately do NOT restate the
// witness's own assertions, and they modify nothing.
//
// FOUR ASSERTIONS WERE DEFERRED, because they reference helpers that do not
// exist until a fix lands and therefore could not pass on unfixed source. Each
// had a labelled marker at the exact spot naming the task that picks it up.
// ALL FOUR HAVE NOW LANDED and every marker is gone:
//
//   P3  — safeCategorySegment equality, landed by task 3.5 in both halves of P3
//         (the 3000-run clean-category property and the divergence boundary case)
//   P2  — hydrateWarmPaintThumbnail returns false, landed by task 6.5 inside
//         P2's per-entry forEach
//   P2c — buildBustedThumbUrl byte-identity against the frozen 51-row corpus,
//         landed by task 6.5 as its own test in P2c
//   P9  — renderIcons absent from the source and no unguarded js/** <img src>
//         builder left, landed by task 8.3 as its own test in P9
//
// NOTHING IS STILL OPEN: there is no live marker left in this file.
//
// A live marker is a standalone banner comment opening with "[DEFERRED -> task".
// Where a deferral has been picked up, the spot keeps a backward-looking note
// prefixed "(was [DEFERRED -> task N])" so the history stays readable — those
// are NOT open work, and grepping the bracket alone will find them too.
//
// Harness
// -------
// The same realm builder, host oracle wiring and index seeding as task 1: the
// real js/templates/templates.js loaded through tests/helpers/loadHelpers.js
// with `lenient: false`, a real parsed DOM (tests/helpers/miniDom.js), a real
// LibraryIndex round-tripped through serialize()/tryParse(), the real panel
// sanitizers from js/core/pathBuilders.js, and the real TemplateCatalog
// evaluated into the same realm. TemplateCatalog.build / patch / remove are
// wrapped in the realm so freshness can be counted rather than inferred.
//
// Property-based throughout, because these obligations are universally
// quantified over path strings, category strings and mutation sequences. For
// BUG 2 (P1) and BUG 3 (P3) the "original" side is RECOMPUTED INSIDE THE TEST
// from the pre-fix expression, so equality is asserted against the old rule and
// not against a frozen snapshot string.
//
// No file under js/ or jsx/ is modified by this task, and no pre-existing test
// file is touched.
//
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10,
//   3.11, 3.12, 3.13**
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const { loadHelpers, REPO_ROOT } = require("./helpers/loadHelpers.js");
const SA = require("./helpers/static-analysis");
const { createMiniDocument } = require("./helpers/miniDom.js");
const { LibraryIndex } = require("../js/core/persistence.js");
const persistence = require("../js/core/persistence.js");
const pathBuilders = require("../js/core/pathBuilders.js");

const TEMPLATES_REL = path.join("js", "templates", "templates.js");
// The markup the panel is built from (Shell plus View_Fragments), repo-relative.
const MARKUP_FILES = SA.listMarkupFiles();
const CATALOG_SRC = fs.readFileSync(
    path.join(REPO_ROOT, "js", "templates", "templateCatalog.js"),
    "utf8"
);

// ─── Real shared panel modules ──────────────────────────────────────────────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
});
const escapeAttr = utils.get("escapeAttr");
const normalizeSectionName = utils.get("normalizeSectionName");
const getTemplateSectionUtil = utils.get("getTemplateSection");

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
// One representative observation per case, captured from the FIRST generated
// run, so the recorded baseline is visible in the run output rather than only
// implied by a green tick.
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

// ─── The panel realm ────────────────────────────────────────────────────────
/**
 * One panel world: a fresh vm realm holding the real templates.js and the real
 * TemplateCatalog, a real parsed DOM with all six grids, and the real panel
 * sanitizers. Only the environment is substituted at the boundary — timers are
 * recorded rather than run, console output is captured so a swallowed throw is
 * visible, and `nfs()` exposes an existsSync keyed on the RAW paths the caller
 * declares to exist (there is no disk here).
 *
 * TemplateCatalog.build / patch / remove are wrapped so catalog freshness can
 * be counted. The wrappers delegate to the real implementations.
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
    const warnings = [];
    const spies = { saveLibraryIndex: 0, updateCount: 0, updateCustomSelect: 0 };
    const indexHolder = { index: opts.libraryIndex || null };
    const existsPaths = [];
    const existsSet = Object.create(null);
    (opts.existsRaw || []).forEach(function (p) { existsSet["" + p] = true; });

    const DOM = Object.assign(
        { "search-box": { value: opts.search || "" } },
        opts.DOM || {}
    );

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

        // No disk in this realm. existsSync answers from the declared raw-path
        // set, and statSync is absent so refreshCardThumbnail's mtime probe is
        // skipped exactly as it is under the startup performance harnesses.
        nfs: function () {
            return {
                existsSync: function (p) {
                    existsPaths.push(p);
                    return existsSet["" + p] === true;
                },
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

    // The real catalog, in the same realm, exactly as index.html loads it.
    vm.runInContext(CATALOG_SRC, handle.context, { filename: "templateCatalog.js" });

    // ── Catalog spies ───────────────────────────────────────────────────────
    // ensureCatalogFresh resolves `TemplateCatalog.build` as a property at call
    // time, so wrapping the property is enough and the real implementation
    // still runs.
    const catalog = { build: 0, buildArgs: [], patch: [], remove: [] };
    const TC = handle.context.TemplateCatalog;
    const realBuild = TC.build;
    const realPatch = TC.patch;
    const realRemove = TC.remove;
    TC.build = function (records, resolver, revision) {
        catalog.build++;
        catalog.buildArgs.push({ length: records ? records.length : -1, revision: revision });
        return realBuild.apply(TC, arguments);
    };
    TC.patch = function (t, previous) {
        catalog.patch.push({ record: t, before: previous });
        return realPatch.apply(TC, arguments);
    };
    TC.remove = function (t) {
        catalog.remove.push(t);
        return realRemove.apply(TC, arguments);
    };

    // ── markTemplatesDirty recorder ─────────────────────────────────────────
    // Task 5.8 / F4 needs to observe catalogSourceChanged() at the INSTANT the
    // model was marked dirty, because four of the seven S-sites sit in entry
    // points that end with filterAndRender() — by the time the call returns the
    // trailing render has already absorbed the mark and the flag reads false
    // again. Reading the flag inside the wrapper is the only way to state
    // "true afterwards" about the mutation rather than about the render.
    //
    // templates.js is evaluated by vm.runInContext, so its top-level
    // `function markTemplatesDirty()` is a writable property of the realm
    // global and every internal call site resolves it there at call time.
    // Replacing the property therefore intercepts the seven production calls,
    // not just external ones. The wrapper delegates to the real implementation,
    // so the revision counter still moves exactly once per call.
    const marks = [];
    const realMark = handle.context.markTemplatesDirty;
    handle.context.markTemplatesDirty = function () {
        const revision = realMark.apply(null, arguments);
        marks.push({
            revision: revision,
            sourceChanged: handle.context.catalogSourceChanged(),
        });
        return revision;
    };

    return {
        context: handle.context,
        document: document,
        grids: grids,
        timers: timers,
        toasts: toasts,
        warnings: warnings,
        spies: spies,
        catalog: catalog,
        marks: marks,
        existsPaths: existsPaths,
        DOM: DOM,
        existsSync: function (p) { return existsSet["" + p] === true; },
        declareExists: function (p) { existsSet["" + p] = true; },
        resetCatalogSpies: function () {
            catalog.build = 0;
            catalog.buildArgs.length = 0;
            catalog.patch.length = 0;
            catalog.remove.length = 0;
            marks.length = 0;
        },
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

function shallowClone(o) {
    const out = {};
    for (const k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    }
    return out;
}

function repoText(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function repoLines(relPath) {
    return repoText(relPath).split(/\r?\n/);
}

// ─── Content-anchored witness lookup ────────────────────────────────────────
//
// The witness-pointer cases (P4, P4-idempotence, P9-witnesses, P12) used to
// address their witness by a FIXED LINE NUMBER. Their job — per the design's
// property map — is to make "already covered by an existing test" ENFORCEABLE:
// they must go red if the witness is deleted or weakened. Pinning a LOCATION
// was never part of that job; the line numbers were only how the design
// happened to cite each witness.
//
// A fixed line number is also actively wrong for this spec. Task 3.1 adds one
// line to tests/save-return-shape.test.js and moved both P4 anchors down by
// one; tasks 3.3 through 8.1 all edit js/templates/templates.js and task 8.1
// deletes 64 lines from it. So the lookup below is anchored on CONTENT, and the
// line number is DISCOVERED and reported rather than asserted.
//
// EXACTLY ONE match is required, which is what preserves the original strength:
// a witness that has been deleted (0 matches) is a regression, and so is one
// that has been duplicated or diluted (2+ matches) — in both cases the "already
// covered" claim can no longer be trusted and has to be re-established by hand.
// The thrown diagnostic names the file and the anchor so that re-establishing it
// does not require reading this helper.

function witnessLookupFailure(relPath, needle, options, hits) {
    const opts = options || {};
    return new Error(
        "witness lookup failed in " + relPath + ": expected exactly 1 line containing " +
        JSON.stringify(needle) +
        (opts.precededBy ? ", immediately below a line containing " + JSON.stringify(opts.precededBy) : "") +
        ", found " + hits.length +
        (hits.length
            ? " at line(s) " + hits.map(function (h) { return h.line; }).join(", ")
            : "") +
        ". This witness backs an \"already covered\" claim in the design's property " +
        "map — it was moved out of recognisable shape, weakened, deleted or " +
        "duplicated. Re-establish it before trusting that claim."
    );
}

/**
 * Locate the single line of `relPath` that contains `needle`.
 *
 * @param {string} relPath repo-relative path of the witness file.
 * @param {string} needle literal substring identifying the witness line.
 * @param {{precededBy?: string}} [options] `precededBy` disambiguates a needle
 *        that legitimately recurs in its file: the line immediately above the
 *        match must contain it as well. Both parts together still have to
 *        resolve to exactly one line.
 * @returns {{line: number, text: string}} the DISCOVERED 1-based line number and
 *          the raw (untrimmed) line text.
 */
function findWitnessLine(relPath, needle, options) {
    const opts = options || {};
    const lines = repoLines(relPath);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(needle) === -1) continue;
        if (opts.precededBy) {
            const above = i > 0 ? lines[i - 1] : "";
            if (above.indexOf(opts.precededBy) === -1) continue;
        }
        hits.push({ line: i + 1, text: lines[i] });
    }
    if (hits.length !== 1) throw witnessLookupFailure(relPath, needle, opts, hits);
    return hits[0];
}

/**
 * Locate every line of `relPath` containing `needle`, requiring exactly
 * `expectedCount` of them. Used where the design names SEVERAL sibling
 * witnesses in one file (P12's two thumbnail seeds in startup-lifecycle), so
 * "unique and identifiable" means the known set and nothing else.
 *
 * @returns {Array<{line: number, text: string}>} in ascending line order.
 */
function findWitnessLines(relPath, needle, expectedCount) {
    const lines = repoLines(relPath);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(needle) !== -1) hits.push({ line: i + 1, text: lines[i] });
    }
    if (hits.length !== expectedCount) {
        throw new Error(
            "witness lookup failed in " + relPath + ": expected exactly " + expectedCount +
            " line(s) containing " + JSON.stringify(needle) + ", found " + hits.length +
            (hits.length
                ? " at line(s) " + hits.map(function (h) { return h.line; }).join(", ")
                : "") +
            ". The fixture set this witness describes has changed; re-confirm the " +
            "design's claim about it before adjusting the count."
        );
    }
    return hits;
}

/**
 * The contiguous block that opens at the unique line containing `needle` and
 * closes at the first following line whose TRIMMED text is exactly `closer`
 * (inclusive). Content-anchored on both ends, so the block survives edits
 * above it and grows or shrinks with its own body.
 *
 * @returns {{startLine: number, endLine: number, lines: string[], text: string}}
 */
function findWitnessBlock(relPath, needle, closer) {
    const open = findWitnessLine(relPath, needle);
    const lines = repoLines(relPath);
    for (let i = open.line; i < lines.length; i++) {
        if (lines[i].trim() !== closer) continue;
        const block = lines.slice(open.line - 1, i + 1);
        return {
            startLine: open.line,
            endLine: i + 1,
            lines: block,
            text: block.join("\n"),
        };
    }
    throw new Error(
        "witness lookup failed in " + relPath + ": found the block opening at line " +
        open.line + " (" + JSON.stringify(needle) + ") but no closing line " +
        JSON.stringify(closer) + " below it. The witness block is no longer " +
        "delimited the way the design describes."
    );
}

/**
 * The body of a `function NAME(...) {` declaration, located by content.
 *
 * Task 5.7 has to say "this function contains no markTemplatesDirty() call" and
 * make that enforceable. A line-number span cannot do that job in this spec:
 * tasks 3.3 through 8.1 all edit js/templates/templates.js and 8.1 deletes 64
 * lines from it, so any fixed span would be pointing somewhere else by the time
 * the plan finishes. Both ends are therefore anchored on content.
 *
 * The closer is matched on INDENTATION: the declaration's own leading whitespace
 * plus `}`. Every nested block inside the body is indented further, so the first
 * line matching that exact string is the function's own close. This works for the
 * bare top-level declarations in templates.js (indent "") and for the ones nested
 * inside templateCatalog.js's IIFE (indent four spaces) with the same helper,
 * which a trim-based closer cannot do — it would stop at the first inner `}`.
 *
 * The block is rejected if a sibling declaration at the SAME indent appears
 * inside it, which catches an over-run if the formatting convention ever breaks.
 *
 * @param {string} relPath repo-relative source path.
 * @param {string} name the function's declared name.
 * @returns {{name: string, indent: string, startLine: number, endLine: number, lines: string[], text: string}}
 */
function findFunctionBody(relPath, name) {
    const lines = repoLines(relPath);
    const opener = new RegExp("^(\\s*)function " + name + "\\s*\\(");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        const m = opener.exec(lines[i]);
        if (m) hits.push({ index: i, indent: m[1] });
    }
    if (hits.length !== 1) {
        throw new Error(
            "function-body lookup failed in " + relPath + ": expected exactly 1 " +
            "declaration of `function " + name + "(`, found " + hits.length +
            (hits.length
                ? " at line(s) " + hits.map(function (h) { return h.index + 1; }).join(", ")
                : "") +
            ". This function backs an exclusion claim in the design's BUG 5 " +
            "call-site table; re-establish it before trusting that claim."
        );
    }
    const start = hits[0].index;
    const indent = hits[0].indent;
    const closer = indent + "}";
    const sibling = new RegExp("^" + indent + "function\\s");
    for (let i = start + 1; i < lines.length; i++) {
        if (sibling.test(lines[i])) {
            throw new Error(
                "function-body lookup failed in " + relPath + ": the block opening at " +
                "line " + (start + 1) + " (function " + name + ") ran into a sibling " +
                "declaration at line " + (i + 1) + " without closing on " +
                JSON.stringify(closer) + ". The formatting this lookup relies on has changed."
            );
        }
        if (lines[i] !== closer) continue;
        const block = lines.slice(start, i + 1);
        return {
            name: name,
            indent: indent,
            startLine: start + 1,
            endLine: i + 1,
            lines: block,
            text: block.join("\n"),
        };
    }
    throw new Error(
        "function-body lookup failed in " + relPath + ": no closing " +
        JSON.stringify(closer) + " below the declaration of " + name + "."
    );
}

/** Count non-overlapping occurrences of the bare identifier `id` in `text`. */
function countIdentifier(text, id) {
    const matches = text.match(new RegExp("\\b" + id + "\\b", "g"));
    return matches ? matches.length : 0;
}

/** Every repo-relative .js path under js/, in a stable order. */
function jsSourceFiles() {
    const out = [];
    (function walk(rel) {
        const abs = path.join(REPO_ROOT, rel);
        const names = fs.readdirSync(abs).sort();
        for (let i = 0; i < names.length; i++) {
            const childRel = rel + "/" + names[i];
            const stat = fs.statSync(path.join(REPO_ROOT, childRel));
            if (stat.isDirectory()) walk(childRel);
            else if (/\.js$/.test(names[i])) out.push(childRel);
        }
    })("js");
    return out;
}

// ─── Generator alphabets ────────────────────────────────────────────────────
// Deliberately hostile: reserved device stems, traversal names, C0 controls,
// reserved separators, whitespace runs, over-length segments, non-BMP. The
// sanitizers are the product's one canonical rule (see
// tests/sanitizer-cross-implementation.property.test.js), so a preservation
// property that only fed them tame input would prove nothing.
const NAME_POOL = [
    "Intro", "Lower Third 01", "a-b_c-1", "x", "interior.dots.are.fine",
    "CON", "con", "com1.txt", "LPT9", "nul",
    "name.", "name ", " name ", "  spaced  out  ",
    "My  Name", "My\tName", "My\r\nName", "My\n \tName",
    "a/b", "a\\b", "a:b", 'q"t', "a<b>c", "a|b", "a*b?c",
    "\u00e9\u00e8\u00ea", "\u65e5\u672c\u8a9e", "\ud83d\ude00emoji",
    "\u0000zero", "\u001fus", "\u007fdel",
    ".", "..", "...", "",
    new Array(255 + 1).join("A"), new Array(300 + 1).join("D") + ".",
];
const CAT_POOL = [
    "Titles", "Uncategorized", "Logos", "Brands", "Lower-Thirds",
    "All", "Favorites",
    "My  Cat", "My\tCat", " My Cat ", "My\r\nCat", "My\n \tCat",
    "a:b", "a/b", "LPT9", "cat.", "cat ", "",
    "\u0417\u0430\u0433\u043e\u043b\u043e\u0432\u043a\u0438", "caf\u00e9",
    new Array(300 + 1).join("C"),
];
const ROOT_POOL = [
    "C:/lib", "C:/lib/", "C:\\lib\\", "C:\\lib\\sub",
    "D:/shared/gamma", "//server/share/lib", "/var/lib/cs",
    "E:/archive//delta/", "",
];
// Non-media types only: isMediaIndexEntry keys on type === "media" or an id
// prefixed "media-" / "legacy-", and P1 is the NON-media obligation (3.4).
const NON_MEDIA_TYPE_POOL = [
    "comp", "layer", "text", "text_props", "footage", "effect", "icon",
    "overlay", "element", "aep", "",
];

const nonMediaRecordArb = fc.record({
    nameIdx: fc.integer({ min: 0, max: NAME_POOL.length - 1 }),
    catIdx: fc.integer({ min: 0, max: CAT_POOL.length - 1 }),
    rootIdx: fc.integer({ min: 0, max: ROOT_POOL.length - 1 }),
    sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
    typeIdx: fc.integer({ min: 0, max: NON_MEDIA_TYPE_POOL.length - 1 }),
    // A record absent from allTemplates is the fourth case in the design's
    // _getTemplateFolderPath unit list: getTemplateSourcePath falls back to
    // rootPath. Included so the fallback branch is covered too.
    present: fc.boolean(),
    decoys: fc.integer({ min: 0, max: 3 }),
});

// ════════════════════════════════════════════════════════════════════════════
// P1 -> Property 4 (clause 3.4)
// Non-media folder-path resolution is BYTE-IDENTICAL to the pre-fix rule.
//
// The "original" side is recomputed here from the pre-fix expression, so the
// obligation is stated against the OLD RULE rather than against a snapshot
// string. BUG 2's fix adds an early return gated on isMediaIndexEntry(rec) &&
// rec.folderPath, so for every input below the fixed code must fall through to
// this same unmodified expression.
// ════════════════════════════════════════════════════════════════════════════
describe("P1 — non-media _getTemplateFolderPath is byte-identical to the pre-fix rule", function () {
    /**
     * js/templates/templates.js _getTemplateFolderPath, reproduced from the
     * unfixed source. `sourcePath` is the real getTemplateSourcePath's answer —
     * that helper is not modified by any task in this spec, so calling it is
     * part of the unchanged expression rather than a re-implementation.
     */
    function preFixFolderPath(sourcePath, cat, name, section) {
        const safeCat = pathBuilders.getSafeName(cat);
        const safeName = pathBuilders.generateTemplateId(name);
        const normRoot = persistence.normalizeFolderPath(sourcePath);
        const normSection = normalizeSectionName(section);
        return normRoot + "/" + normSection + "/" + safeCat + "/" + safeName;
    }

    test("2000 generated non-media records resolve to the pre-fix string exactly", function () {
        // **Validates: Requirements 3.4**
        const realm = createPanelRealm({});
        const ctx = realm.context;
        let nonMediaChecked = 0;
        let presentRuns = 0;
        let absentRuns = 0;

        fc.assert(
            fc.property(nonMediaRecordArb, function (spec) {
                const name = NAME_POOL[spec.nameIdx];
                const cat = CAT_POOL[spec.catIdx];
                const root = ROOT_POOL[spec.rootIdx];
                const section = SECTION_VALUES[spec.sectionIdx];
                const type = NON_MEDIA_TYPE_POOL[spec.typeIdx];

                const target = {
                    id: "tpl-target",
                    name: name,
                    category: cat,
                    section: section,
                    type: type,
                    favorite: false,
                    sourcePath: root,
                    folderPath: root + "/" + section + "/seeded/target",
                };

                // Decoys share the section but never the name+category pair the
                // helper matches on, so the match rule itself is exercised.
                const records = [];
                for (let d = 0; d < spec.decoys; d++) {
                    records.push({
                        id: "tpl-decoy-" + d,
                        name: name + "~decoy" + d,
                        category: cat + "~decoy" + d,
                        section: section,
                        type: type,
                        sourcePath: "Z:/decoy",
                        folderPath: "Z:/decoy/" + d,
                    });
                }
                if (spec.present) records.splice(spec.decoys > 0 ? 1 : 0, 0, target);

                ctx.allTemplates = records;
                ctx.currentSection = section;

                // Non-vacuity: the generator really is producing non-media
                // records, so a passing run cannot be a media record sneaking
                // through the branch this property is not about.
                if (spec.present) {
                    expect(ctx.isMediaIndexEntry(target)).toBe(false);
                    nonMediaChecked++;
                    presentRuns++;
                } else {
                    absentRuns++;
                }

                const sourcePath = ctx.getTemplateSourcePath(name, cat);
                const expected = preFixFolderPath(sourcePath, cat, name, section);
                const actual = ctx._getTemplateFolderPath(name, cat);

                observe("P1", "unfixed _getTemplateFolderPath output for the first generated record", {
                    name: JSON.stringify(name),
                    category: JSON.stringify(cat),
                    section: section,
                    recordPresent: spec.present,
                    resolvedSourcePath: sourcePath,
                    observedFolderPath: actual,
                    recomputedPreFixFolderPath: expected,
                });

                expect(actual).toBe(expected);
                // The fallback really is rootPath when the record is absent.
                if (!spec.present) expect(sourcePath).toBe(ctx.rootPath);
            }),
            { numRuns: 2000, seed: 20260901 }
        );

        expect(nonMediaChecked).toBeGreaterThan(0);
        expect(presentRuns).toBeGreaterThan(0);
        expect(absentRuns).toBeGreaterThan(0);
    }, 120000);

    test("a media record with the SAME name+category resolves to its OWN folderPath, not the name-derived one", function () {
        // **Validates: Requirements 3.4**
        //
        // THE BOUNDARY OF THE PROPERTY ABOVE, stated post-fix. P1 proves the
        // 2000 non-media records are byte-identical to the pre-fix rule; this
        // case proves media records — and ONLY media records — moved. Together
        // the two pin BUG 2's blast radius to exactly one input class.
        //
        // Pre-fix this same case asserted the OPPOSITE, because the media
        // branch did not exist yet and a media record resolved through the very
        // same name-derived expression: that was the divergence E4/E5 exploit.
        // BUG 2's fix inverts precisely that, so the case is inverted with it.
        // The pre-fix expression is still RECOMPUTED below rather than
        // snapshotted, so the assertion stays anchored to the old rule: the
        // claim is not "the answer changed" but "the answer is now the entry's
        // own folderPath and specifically NOT the name-based reconstruction".
        const realm = createPanelRealm({ currentSection: SECTIONS.FOOTAGE, rootPath: "C:/lib" });
        const ctx = realm.context;
        const mediaFolder = "C:/lib/footage/Broll/media-0063-006c-0069-0070";
        const media = {
            id: "media-1730000000000-1",
            name: "clip",
            category: "Broll",
            section: SECTIONS.FOOTAGE,
            type: "media",
            mediaType: "video",
            folderPath: mediaFolder,
            sourcePath: "D:/incoming/clip.mp4",
        };
        ctx.allTemplates = [media];

        const actual = ctx._getTemplateFolderPath("clip", "Broll");
        const preFix = preFixFolderPath(
            ctx.getTemplateSourcePath("clip", "Broll"), "Broll", "clip", SECTIONS.FOOTAGE
        );
        // The index key the entry's own folderPath normalizes to. This is the
        // string removeEntry / patchEntry / has / getEntry key on, which is why
        // it is the correct answer and the reconstruction was not.
        const ownKey = persistence.normalizeFolderPath(media.folderPath);

        observe("P1-media-boundary", "fixed source resolves a media record by its own folderPath, not by name", {
            storedFolderPath: mediaFolder,
            normalizedOwnKey: ownKey,
            observedFolderPath: actual,
            recomputedPreFixFolderPath: preFix,
            isMediaIndexEntry: ctx.isMediaIndexEntry(media),
            matchesOwnFolderPath: actual === ownKey,
            differsFromPreFixReconstruction: actual !== preFix,
        });

        // Non-vacuity: the case really is exercising the media branch.
        expect(ctx.isMediaIndexEntry(media)).toBe(true);
        // The one input class BUG 2 moved, stated from the post-fix side.
        expect(actual).toBe(ownKey);
        expect(actual).not.toBe(preFix);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// F2 -> Property 3 (clauses 2.3, 2.4) — BUG 2's FIX CHECK
//
// P1 above is the preservation half: a non-media entry resolves to the pre-fix
// string, byte for byte. F2 is the fix half: a MEDIA entry's mutation must land
// on the index entry that actually backs the card.
//
// Five parts, in widening then narrowing scope:
//
//   1. removeUITemplate over generated media entries — li.has(folderPath) is
//      false, li.needsFullScan() stays false, and no record remains in
//      allTemplates;
//   2. patchUITemplate over the THREE patch shapes production actually issues
//      (templates.js:2323 favourite, :2757 rename, :2813 move) — the persisted
//      entry carries every patched field and its folderPath is unmoved;
//   3. the folderPath pin on its own, because it is the one obligation the
//      index enforces rather than the caller;
//   4. the _findUITemplateRecord unit table;
//   5. the _getTemplateFolderPath unit table.
//
// TWO ALIASING MODES are generated, because production has both and they are
// NOT equivalent:
//
//   * "shared"  — allTemplates IS li._entries. This is what loadTemplates'
//                 warm-paint branch produces (clause 1.2), so it is the shape a
//                 REOPENED panel mutates, and clause 2.4's "survives a panel
//                 reopen" is about exactly this mode. E4/E5 use it too.
//   * "cloned"  — allTemplates holds distinct record objects, which is what a
//                 host scan produces.
//
// The aliasing changes ONE observable, and it is recorded rather than smoothed
// over: whether the hand-written TemplateCatalog mirror fires. li.removeEntry /
// li.patchEntry run FIRST and rewrite the shared array, so by the time the
// allTemplates scan runs its match target has already moved and the mirror call
// is skipped. It is skipped exactly when the array is aliased AND the mutation
// changes something the match rule keys on — removal always does; a patch does
// only when it carries a different `name` or `category`. That rule is asserted
// as an equality, not weakened to a range, so a change in it goes red. The
// data-level obligation F2 owns holds in every mode: persisted and in-memory
// agree, because under aliasing they are the same object.
//
// Note this is reachable only BECAUSE the fix works. Pre-fix, patchEntry and
// removeEntry threw on the name-derived key, the index rolled the mutation back
// untouched, and the allTemplates scan always found its target. The generic
// staleness signal for the skipped mirror is BUG 5's job (task 5.3 S4, task 5.4
// S5); P8 pins the mirror obligation for the non-aliased case.
//
// **Validates: Requirements 2.3, 2.4**
// ════════════════════════════════════════════════════════════════════════════

// ─── Media folder shape (test INPUT data, not code under test) ──────────────
// The media writer composes <root>/<section>/<mediaSafeName(cat)>/<idSegment>,
// where the id segment is "media" followed by one dash-separated 4-hex-digit
// group per code unit of the entry id, and mediaSafeName replaces the reserved
// separator class with "_" and trims the ends. Both are reproduced here only to
// build realistic seed paths — neither is code under test, and the module that
// owns them is not loaded by this suite.
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

function mediaSafeNameFixture(value, fallback) {
    const safe = String(value || "").replace(/[<>:"/\\|?*]+/g, "_").replace(/^\s+|\s+$/g, "");
    return safe || fallback;
}

describe("F2 — the mutation helpers address a media entry's real folder", function () {

    const F2_ROOT = "C:/lib";
    // isMediaIndexEntry accepts type === "media" OR an id prefixed media- /
    // legacy-, so the id prefix is generated as a third dimension: the early
    // return must key on "is a media index entry", not on the folder segment
    // happening to read media-<hex>.
    const ID_PREFIXES = ["media", "legacy", "m"];
    const ALIAS_MODES = ["shared", "cloned"];

    const f2Arb = fc.record({
        prefixIdx: fc.integer({ min: 0, max: ID_PREFIXES.length - 1 }),
        stamp: fc.integer({ min: 1600000000000, max: 1799999999999 }),
        counter: fc.integer({ min: 0, max: 99 }),
        nonce: fc.constantFrom("", "-7f3a", "-z9", "-\u00e9"),
        nameIdx: fc.integer({ min: 0, max: NAME_POOL.length - 1 }),
        catIdx: fc.integer({ min: 0, max: CAT_POOL.length - 1 }),
        sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
        aliasIdx: fc.integer({ min: 0, max: ALIAS_MODES.length - 1 }),
        neighbours: fc.integer({ min: 0, max: 3 }),
        kind: fc.constantFrom("favorite", "rename", "move"),
    });

    function mediaIdFrom(spec) {
        return ID_PREFIXES[spec.prefixIdx] + "-" + spec.stamp + "-" + spec.counter + spec.nonce;
    }

    /**
     * One media card, seeded into a real LibraryIndex at the folder the media
     * writer would have created, with `neighbours` sibling media entries that
     * must survive the mutation untouched.
     *
     * @returns {{realm: object, ctx: object, li: object, folder: string,
     *            entry: object, neighbourFolders: string[], aliased: boolean,
     *            name: string, cat: string, section: string}}
     */
    function seedMediaWorld(spec) {
        const id = mediaIdFrom(spec);
        const name = NAME_POOL[spec.nameIdx];
        const cat = CAT_POOL[spec.catIdx];
        const section = SECTION_VALUES[spec.sectionIdx];
        const aliased = ALIAS_MODES[spec.aliasIdx] === "shared";
        const catSegment = mediaSafeNameFixture(cat, "Imported");
        const dir = F2_ROOT + "/" + String(section).toLowerCase() + "/" + catSegment + "/";
        const folder = dir + mediaIdFolderSegmentFixture(id);

        const entry = {
            id: id,
            name: name,
            category: cat,
            section: section,
            type: "media",
            mediaType: "video",
            folderPath: folder,
            // A media entry's sourcePath is the ORIGINAL imported file, never a
            // library root — which is why the name-based reconstruction could
            // not be repaired by reading it.
            sourcePath: "D:/incoming/clip.mp4",
            mediaFile: "clip.mp4",
            thumbnailPath: folder + "/thumbnail.png",
            thumbStatus: "ready",
            favorite: false,
        };

        const neighbourFolders = [];
        const seeds = [entry];
        for (let n = 0; n < spec.neighbours; n++) {
            const nid = id + "-n" + n;
            const nf = dir + mediaIdFolderSegmentFixture(nid);
            neighbourFolders.push(persistence.normalizeFolderPath(nf));
            seeds.push({
                id: nid,
                // A distinct name, so the match rule can never pick a neighbour.
                name: name + "~n" + n,
                category: cat,
                section: section,
                type: "media",
                mediaType: "image",
                folderPath: nf,
                sourcePath: "D:/incoming/n" + n + ".png",
                thumbnailPath: nf + "/thumbnail.png",
                thumbStatus: "ready",
                favorite: true,
            });
        }

        const li = persistIndex(seeds);
        const allTemplates = aliased ? li._entries : li._entries.map(shallowClone);
        const realm = createPanelRealm({
            libraryIndex: li,
            allTemplates: allTemplates,
            currentSection: section,
            currentCategory: "All",
            libraryPaths: [F2_ROOT],
            rootPath: F2_ROOT,
        });

        return {
            realm: realm,
            ctx: realm.context,
            li: li,
            folder: persistence.normalizeFolderPath(folder),
            entry: entry,
            neighbourFolders: neighbourFolders,
            aliased: aliased,
            name: name,
            cat: cat,
            section: section,
        };
    }

    // ── Part 1: removeUITemplate ────────────────────────────────────────────
    test("removeUITemplate drops the backing entry, leaves needsFullScan false, and empties the model", function () {
        // **Validates: Requirements 2.3, 2.4**
        const aliasSeen = {};
        const prefixSeen = {};

        fc.assert(
            fc.property(f2Arb, function (spec) {
                const w = seedMediaWorld(spec);
                const ctx = w.ctx;

                // The render path is recorded, not run: filterAndRender repaints
                // a grid, which is not what this property is about.
                let renders = 0;
                ctx.filterAndRender = function () { renders++; };

                const resolved = ctx._getTemplateFolderPath(w.name, w.cat);
                const sizeBefore = w.li.size();
                w.realm.resetCatalogSpies();

                ctx.removeUITemplate(w.name, w.cat);

                const remaining = ctx.allTemplates.filter(function (r) {
                    return r.name === w.name && r.category === w.cat && r.section === w.section;
                });
                // Removal always moves the match target, so the mirror fires
                // only when the array is NOT the index's own entry list.
                const expectMirror = w.aliased ? 0 : 1;

                aliasSeen[w.aliased ? "shared" : "cloned"] =
                    (aliasSeen[w.aliased ? "shared" : "cloned"] || 0) + 1;
                prefixSeen[ID_PREFIXES[spec.prefixIdx]] =
                    (prefixSeen[ID_PREFIXES[spec.prefixIdx]] || 0) + 1;

                observe("F2-remove", "removeUITemplate against a generated media entry", {
                    aliasMode: w.aliased ? "shared" : "cloned",
                    entryId: w.entry.id,
                    category: JSON.stringify(w.cat),
                    seededFolderPath: w.folder,
                    resolvedFolderPath: resolved,
                    resolvedIsTheSeededKey: resolved === w.folder,
                    liSizeBefore: sizeBefore,
                    liSizeAfter: w.li.size(),
                    stillHasEntry: w.li.has(w.folder),
                    needsFullScan: w.li.needsFullScan(),
                    lastError: w.li.lastError(),
                    allTemplatesLength: ctx.allTemplates.length,
                    matchingRecordsLeft: remaining.length,
                    catalogRemoveCalls: w.realm.catalog.remove.length,
                    filterAndRenderCalls: renders,
                });

                // ── The helper addressed the real folder ────────────────────
                expect(ctx.isMediaIndexEntry(w.entry)).toBe(true);
                expect(resolved).toBe(w.folder);

                // ── F2's three obligations ──────────────────────────────────
                expect(w.li.has(w.folder)).toBe(false);
                expect(w.li.needsFullScan()).toBe(false);
                expect(remaining.length).toBe(0);

                // ── And nothing beyond the one card moved ───────────────────
                expect(w.li.lastError()).toBeNull();
                expect(w.li.size()).toBe(sizeBefore - 1);
                w.neighbourFolders.forEach(function (nf) {
                    expect(w.li.has(nf)).toBe(true);
                });
                expect(ctx.allTemplates.length).toBe(spec.neighbours);
                expect(w.realm.catalog.remove.length).toBe(expectMirror);
                expect(w.realm.spies.saveLibraryIndex).toBe(1);
                expect(renders).toBe(1);
                expect(w.realm.warnings).toEqual([]);

                return true;
            }),
            { numRuns: 250, seed: 20260910 }
        );

        // Non-vacuity: both aliasing modes and all three id prefixes ran.
        expect(aliasSeen.shared).toBeGreaterThan(0);
        expect(aliasSeen.cloned).toBeGreaterThan(0);
        expect(prefixSeen.media).toBeGreaterThan(0);
        expect(prefixSeen.legacy).toBeGreaterThan(0);
        expect(prefixSeen.m).toBeGreaterThan(0);
    }, 240000);

    // ── Part 2: patchUITemplate ─────────────────────────────────────────────
    test("patchUITemplate lands every patched field on the backing entry without moving it", function () {
        // **Validates: Requirements 2.3, 2.4**
        const kindSeen = {};
        const mirrorSeen = {};

        fc.assert(
            fc.property(f2Arb, function (spec) {
                const w = seedMediaWorld(spec);
                const ctx = w.ctx;

                let renders = 0;
                const patched = [];
                ctx.filterAndRender = function () { renders++; };
                ctx.patchTemplateCard = function (rec) { patched.push(rec); return true; };
                ctx.buildCategoryTabs = function () { };
                ctx.buildCategoryPanel = function () { };

                const resolved = ctx._getTemplateFolderPath(w.name, w.cat);
                w.realm.resetCatalogSpies();

                // The three shapes production actually issues.
                let patchObj, newName, newCat;
                if (spec.kind === "favorite") {
                    patchObj = { favorite: true };
                } else if (spec.kind === "rename") {
                    newName = w.name + " renamed";
                    patchObj = { name: newName, id: pathBuilders.generateTemplateId(newName) };
                } else {
                    newCat = w.cat === "Logos" ? "Brands" : "Logos";
                    patchObj = { category: newCat };
                }

                // The mirror is skipped exactly when the array is aliased AND
                // the patch moves a field the match rule keys on.
                const movesMatchKey =
                    (Object.prototype.hasOwnProperty.call(patchObj, "name") && patchObj.name !== w.name) ||
                    (Object.prototype.hasOwnProperty.call(patchObj, "category") && patchObj.category !== w.cat);
                const expectMirror = (w.aliased && movesMatchKey) ? 0 : 1;

                ctx.patchUITemplate(w.name, w.cat, patchObj, newName, newCat);

                const persisted = w.li.getEntry(w.folder);
                kindSeen[spec.kind] = (kindSeen[spec.kind] || 0) + 1;
                mirrorSeen[String(expectMirror)] = (mirrorSeen[String(expectMirror)] || 0) + 1;

                observe("F2-patch", "patchUITemplate against a generated media entry", {
                    aliasMode: w.aliased ? "shared" : "cloned",
                    kind: spec.kind,
                    entryId: w.entry.id,
                    category: JSON.stringify(w.cat),
                    seededFolderPath: w.folder,
                    resolvedFolderPath: resolved,
                    resolvedIsTheSeededKey: resolved === w.folder,
                    patchObj: patchObj,
                    persistedExists: persisted !== null,
                    persistedFolderPath: persisted ? persisted.folderPath : null,
                    folderPathUnmoved: persisted ? persisted.folderPath === w.folder : null,
                    needsFullScan: w.li.needsFullScan(),
                    lastError: w.li.lastError(),
                    catalogPatchCalls: w.realm.catalog.patch.length,
                    expectedCatalogPatchCalls: expectMirror,
                    filterAndRenderCalls: renders,
                    patchTemplateCardCalls: patched.length,
                });

                // ── The helper addressed the real folder ────────────────────
                expect(resolved).toBe(w.folder);

                // ── The patch landed on the entry that backs the card ───────
                expect(persisted).not.toBeNull();
                for (const key in patchObj) {
                    if (Object.prototype.hasOwnProperty.call(patchObj, key)) {
                        expect(persisted[key]).toBe(patchObj[key]);
                    }
                }

                // ── And the entry did not move ──────────────────────────────
                expect(persisted.folderPath).toBe(w.folder);
                expect(w.li.has(w.folder)).toBe(true);
                expect(w.li.needsFullScan()).toBe(false);
                expect(w.li.lastError()).toBeNull();
                expect(w.li.size()).toBe(spec.neighbours + 1);

                // ── The in-memory record agrees with the persisted one ──────
                const model = ctx.allTemplates.filter(function (r) {
                    return persistence.normalizeFolderPath(r.folderPath) === w.folder;
                });
                expect(model.length).toBe(1);
                for (const key2 in patchObj) {
                    if (Object.prototype.hasOwnProperty.call(patchObj, key2)) {
                        expect(model[0][key2]).toBe(patchObj[key2]);
                    }
                }

                // ── Neighbours untouched ────────────────────────────────────
                w.neighbourFolders.forEach(function (nf) {
                    const n = w.li.getEntry(nf);
                    expect(n).not.toBeNull();
                    expect(n.favorite).toBe(true);
                    expect(n.folderPath).toBe(nf);
                });

                expect(w.realm.catalog.patch.length).toBe(expectMirror);
                expect(w.realm.spies.saveLibraryIndex).toBe(1);
                expect(w.realm.warnings).toEqual([]);

                return true;
            }),
            { numRuns: 250, seed: 20260911 }
        );

        // Non-vacuity: all three shapes ran, and BOTH mirror outcomes occurred.
        expect(kindSeen.favorite).toBeGreaterThan(0);
        expect(kindSeen.rename).toBeGreaterThan(0);
        expect(kindSeen.move).toBeGreaterThan(0);
        expect(mirrorSeen["0"]).toBeGreaterThan(0);
        expect(mirrorSeen["1"]).toBeGreaterThan(0);
    }, 240000);

    // ── Part 3: the folderPath pin ──────────────────────────────────────────
    test("a patch that tries to move folderPath is pinned to the index key", function () {
        // **Validates: Requirements 2.4**
        //
        // patchEntry sets merged.folderPath = key unconditionally
        // (persistence.js), so the identity key survives a caller that puts
        // folderPath in the patch object. No production caller does — the three
        // shapes are {favorite}, {name,id} and {category} — so this is the
        // index's own guarantee rather than a caller contract, and it is stated
        // in the CLONED mode for that reason: under the shared alias the
        // in-memory write that follows patchEntry lands on the very object the
        // index just pinned and overwrites folderPath again, which is a property
        // of the aliasing and not of the pin. Recorded, not asserted as correct.
        const spec = {
            prefixIdx: 0, stamp: 1730000000000, counter: 1, nonce: "",
            nameIdx: 0, catIdx: 0, sectionIdx: 0, aliasIdx: 1, neighbours: 1,
            kind: "favorite",
        };
        const cloned = seedMediaWorld(spec);
        cloned.ctx.filterAndRender = function () { };
        cloned.ctx.patchTemplateCard = function () { return true; };
        cloned.ctx.patchUITemplate(cloned.name, cloned.cat, { favorite: true, folderPath: "Z:/moved" });

        const shared = seedMediaWorld(Object.assign({}, spec, { aliasIdx: 0 }));
        shared.ctx.filterAndRender = function () { };
        shared.ctx.patchTemplateCard = function () { return true; };
        shared.ctx.patchUITemplate(shared.name, shared.cat, { favorite: true, folderPath: "Z:/moved" });

        const clonedEntry = cloned.li.getEntry(cloned.folder);
        observe("F2-pin", "a folderPath-bearing patch, in both aliasing modes", {
            seededFolderPath: cloned.folder,
            clonedPersistedFolderPath: clonedEntry ? clonedEntry.folderPath : null,
            clonedPersistedFavorite: clonedEntry ? clonedEntry.favorite : null,
            sharedStillResolvable: shared.li.getEntry(shared.folder) !== null,
            sharedNeedsFullScan: shared.li.needsFullScan(),
            note: "cloned: the index pin holds. shared: the aliased in-memory " +
                "write re-applies folderPath over the pin, so the entry is no " +
                "longer reachable at its old key — an aliasing effect, and no " +
                "production caller patches folderPath.",
        });

        expect(clonedEntry).not.toBeNull();
        expect(clonedEntry.folderPath).toBe(cloned.folder);
        expect(clonedEntry.favorite).toBe(true);
        expect(cloned.li.needsFullScan()).toBe(false);
    });

    // ── Part 4: the _findUITemplateRecord unit table ─────────────────────────
    //
    // Every value below was RUN before it was asserted. The one worth naming:
    // a record whose name+category match but whose section does not is NOT
    // returned, and the SAME record IS returned once currentSection is switched
    // to its section — so the section clause is load-bearing rather than the
    // record merely being unreachable.
    describe("the _findUITemplateRecord unit table", function () {
        const A = {
            id: "a", name: "clip", category: "Broll", section: SECTIONS.FOOTAGE,
            type: "media", folderPath: "C:/lib/footage/Broll/media-a",
        };
        const WRONG_SECTION = {
            id: "b", name: "clip", category: "Broll", section: SECTIONS.ICON,
            type: "media", folderPath: "C:/lib/icon/Broll/media-b",
        };
        const OTHER_CAT = {
            id: "c", name: "clip", category: "Other", section: SECTIONS.FOOTAGE,
            type: "media", folderPath: "C:/lib/footage/Other/media-c",
        };

        function findIn(records, section, name, cat) {
            const ctx = createPanelRealm({
                allTemplates: records, currentSection: section, rootPath: "C:/lib",
            }).context;
            return ctx._findUITemplateRecord(name, cat);
        }

        test("no match returns null, for an unknown name, an unknown category and an empty model", function () {
            // **Validates: Requirements 2.3**
            expect(findIn([A, WRONG_SECTION, OTHER_CAT], SECTIONS.FOOTAGE, "nope", "Broll")).toBeNull();
            expect(findIn([A, WRONG_SECTION, OTHER_CAT], SECTIONS.FOOTAGE, "clip", "nope")).toBeNull();
            expect(findIn([], SECTIONS.FOOTAGE, "clip", "Broll")).toBeNull();
        });

        test("a match in the wrong section is not returned, and the section clause is what excludes it", function () {
            // **Validates: Requirements 2.3**
            expect(findIn([WRONG_SECTION], SECTIONS.FOOTAGE, "clip", "Broll")).toBeNull();
            // Same record, same query, only currentSection differs.
            const found = findIn([WRONG_SECTION], SECTIONS.ICON, "clip", "Broll");
            expect(found).not.toBeNull();
            expect(found.id).toBe("b");
        });

        test("duplicate names in different categories resolve to the queried category", function () {
            // **Validates: Requirements 2.3**
            const all = [A, WRONG_SECTION, OTHER_CAT];
            expect(findIn(all, SECTIONS.FOOTAGE, "clip", "Broll").id).toBe("a");
            expect(findIn(all, SECTIONS.FOOTAGE, "clip", "Other").id).toBe("c");
        });

        test("two records with the same name, category and section resolve to the first", function () {
            // **Validates: Requirements 2.3**
            //
            // Recorded because it is the rule removeUITemplate and
            // patchUITemplate follow too (both `break` on the first match), so
            // the path resolved here and the record they mutate stay the same
            // card even for a duplicate the index cannot hold.
            const d1 = {
                id: "d1", name: "clip", category: "Broll", section: SECTIONS.FOOTAGE,
                type: "media", folderPath: "C:/lib/footage/Broll/media-d1",
            };
            const d2 = {
                id: "d2", name: "clip", category: "Broll", section: SECTIONS.FOOTAGE,
                type: "media", folderPath: "C:/lib/footage/Broll/media-d2",
            };
            expect(findIn([d1, d2], SECTIONS.FOOTAGE, "clip", "Broll").id).toBe("d1");
        });
    });

    // ── Part 5: the _getTemplateFolderPath unit table ────────────────────────
    //
    // The `expected` column is what the helper ACTUALLY returned when this table
    // was first run, recorded before any assertion was written. Three results
    // were worth writing down:
    //
    //   * The EMPTY-folderPath media entry falls through and reconstructs from
    //     "C:/lib" — the LIBRARY ROOT — not from its own sourcePath. A reading
    //     of getTemplateSourcePath that stopped at `return rec.sourcePath ||
    //     rootPath` would predict "D:/incoming/clip.mp4/footage/Broll/clip",
    //     i.e. a path rooted inside an imported FILE. It does not happen because
    //     getTemplateSourcePath has its own media branch that routes through
    //     mediaRootFromFolderPath and falls back to rootPath when that yields
    //     nothing. That branch predates this spec and is not modified by it, and
    //     it is the reason the fall-through is a safe degradation instead of a
    //     nonsense path.
    //
    //   * A folderPath of "/" — and a missing one — take the same fall-through
    //     as "", because normalizeFolderPath strips every trailing slash and
    //     what is left is empty. The early return's non-empty test is what
    //     catches all three.
    //
    //   * On the fall-through the category segment is NOT folded but the name
    //     segment IS: "My  Cat" survives as-is while "My  Clip" becomes
    //     "My Clip", because generateTemplateId folds cleanName in and
    //     getSafeName does not. That asymmetry is the pre-fix rule P1 pins, and
    //     BUG 3's safeCategorySegment deliberately does not reach here — it is
    //     scoped to the two PNG save sites.
    describe("the _getTemplateFolderPath unit table", function () {
        const MEDIA_SEG = mediaIdFolderSegmentFixture("media-1730000000000-1");

        function resolveIn(records, section, name, cat) {
            const ctx = createPanelRealm({
                allTemplates: records, currentSection: section, rootPath: "C:/lib",
            }).context;
            return {
                actual: ctx._getTemplateFolderPath(name, cat),
                sourcePath: ctx.getTemplateSourcePath(name, cat),
                isMedia: records.length ? ctx.isMediaIndexEntry(records[0]) : null,
            };
        }

        function mediaRec(folderPath, extra) {
            return Object.assign({
                id: "media-1730000000000-1", name: "clip", category: "Broll",
                section: SECTIONS.FOOTAGE, type: "media", folderPath: folderPath,
                sourcePath: "D:/incoming/clip.mp4",
            }, extra || {});
        }

        const ROWS = [
            {
                label: "media entry with a usable folderPath",
                records: [mediaRec("C:/lib/footage/Broll/" + MEDIA_SEG)],
                section: SECTIONS.FOOTAGE, name: "clip", cat: "Broll",
                expected: "C:/lib/footage/Broll/" + MEDIA_SEG,
                viaEarlyReturn: true,
            },
            {
                label: "media entry whose folderPath has backslashes and a trailing slash",
                records: [mediaRec("C:\\lib\\footage\\Broll\\" + MEDIA_SEG + "\\")],
                section: SECTIONS.FOOTAGE, name: "clip", cat: "Broll",
                expected: "C:/lib/footage/Broll/" + MEDIA_SEG,
                viaEarlyReturn: true,
            },
            {
                label: "media entry recognised by its id prefix alone (type is the section)",
                records: [mediaRec("C:/lib/footage/Broll/" + MEDIA_SEG, { type: "footage" })],
                section: SECTIONS.FOOTAGE, name: "clip", cat: "Broll",
                expected: "C:/lib/footage/Broll/" + MEDIA_SEG,
                viaEarlyReturn: true,
            },
            {
                label: "legacy- id prefix, folder segment NOT media-<hex>",
                records: [mediaRec("C:/lib/footage/Broll/legacy-thing", { id: "legacy-abc", type: "footage" })],
                section: SECTIONS.FOOTAGE, name: "clip", cat: "Broll",
                expected: "C:/lib/footage/Broll/legacy-thing",
                viaEarlyReturn: true,
            },
            {
                label: "media entry with an EMPTY folderPath — falls through",
                records: [mediaRec("")],
                section: SECTIONS.FOOTAGE, name: "clip", cat: "Broll",
                expected: "C:/lib/footage/Broll/clip",
                viaEarlyReturn: false,
            },
            {
                label: "media entry with NO folderPath at all — falls through",
                records: [mediaRec(undefined)],
                section: SECTIONS.FOOTAGE, name: "clip", cat: "Broll",
                expected: "C:/lib/footage/Broll/clip",
                viaEarlyReturn: false,
            },
            {
                label: 'media entry whose folderPath is "/" — falls through',
                records: [mediaRec("/")],
                section: SECTIONS.FOOTAGE, name: "clip", cat: "Broll",
                expected: "C:/lib/footage/Broll/clip",
                viaEarlyReturn: false,
            },
            {
                label: "media entry with an EMPTY folderPath and a whitespace-bearing category",
                records: [mediaRec("", { name: "My  Clip", category: "My  Cat" })],
                section: SECTIONS.FOOTAGE, name: "My  Clip", cat: "My  Cat",
                expected: "C:/lib/footage/My  Cat/My Clip",
                viaEarlyReturn: false,
            },
            {
                label: "non-media entry",
                records: [{
                    id: "tpl-1", name: "Intro", category: "Titles", section: SECTIONS.COMP,
                    type: "comp", folderPath: "C:/lib/comp/Titles/seeded", sourcePath: "C:/lib",
                }],
                section: SECTIONS.COMP, name: "Intro", cat: "Titles",
                expected: "C:/lib/comp/Titles/Intro",
                viaEarlyReturn: false,
            },
            {
                label: "a name absent from allTemplates",
                records: [],
                section: SECTIONS.FOOTAGE, name: "ghost", cat: "Nowhere",
                expected: "C:/lib/footage/Nowhere/ghost",
                viaEarlyReturn: false,
            },
        ];

        test("every row returns the recorded value, and only the media rows take the early return", function () {
            // **Validates: Requirements 2.3, 3.4**
            const rows = ROWS.map(function (row) {
                const got = resolveIn(row.records, row.section, row.name, row.cat);
                return {
                    label: row.label,
                    actual: got.actual,
                    expected: row.expected,
                    resolvedSourcePath: got.sourcePath,
                    isMediaIndexEntry: got.isMedia,
                    tookEarlyReturn: row.records.length > 0 &&
                        got.actual === persistence.normalizeFolderPath(row.records[0].folderPath) &&
                        persistence.normalizeFolderPath(row.records[0].folderPath) !== "",
                };
            });

            observe("F2-units", "_getTemplateFolderPath, one row per unit case, as observed", { rows: rows });

            ROWS.forEach(function (row, i) {
                expect(rows[i].actual).toBe(row.expected);
                expect(rows[i].tookEarlyReturn).toBe(row.viaEarlyReturn);
            });

            // Every fall-through row is byte-identical to P1's pre-fix rule, so
            // an empty-folderPath media entry degrades to exactly the string a
            // non-media entry gets — nothing new is invented for it.
            ROWS.filter(function (r) { return !r.viaEarlyReturn; }).forEach(function (row) {
                const got = resolveIn(row.records, row.section, row.name, row.cat);
                const normRoot = persistence.normalizeFolderPath(got.sourcePath);
                const normSection = normalizeSectionName(row.section);
                expect(got.actual).toBe(
                    normRoot + "/" + normSection + "/" +
                    pathBuilders.getSafeName(row.cat) + "/" +
                    pathBuilders.generateTemplateId(row.name)
                );
            });

            // The table is not vacuous: both branches were reached.
            expect(ROWS.filter(function (r) { return r.viaEarlyReturn; }).length).toBeGreaterThan(0);
            expect(ROWS.filter(function (r) { return !r.viaEarlyReturn; }).length).toBeGreaterThan(0);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// P2 -> Property 2 (clauses 3.2, 3.3)
// Warm paint leaves every other entry untouched.
//
// The part observable pre-fix, and the part that must still hold once BUG 1's
// read-side derivation lands:
//   - thumbnailPath is never written, so it stays the RAW forward-or-back
//     slashed disk path an existsSync/statSync probe can resolve (3.2),
//   - an entry that already carries a thumbnail whose thumbStatus is not
//     "ready" keeps that value, and an entry with no thumbnailPath keeps the
//     placeholder (3.3),
//   - warm paint touches no filesystem at all.
//
// The two BUG-1 classes ("thumbnailPath present, thumbStatus ready" and
// "thumbnailPath present, thumbnail falsy") are deliberately NOT asserted on
// their `thumbnail` value: that is the value the fix is supposed to start
// writing. Their current value is recorded in the observation log instead.
// ════════════════════════════════════════════════════════════════════════════
const WARM_CLASSES = ["bug-ready", "bug-falsy-thumb", "keeps-in-session", "no-thumbpath"];
const NO_PATH_STATUS = ["ready", "placeholder", "failed"];
const ABSENT = "\u0000<absent>";

const warmEntrySpecArb = fc.record({
    klass: fc.constantFrom.apply(fc, WARM_CLASSES),
    isMedia: fc.boolean(),
    backslashes: fc.boolean(),
    noPathStatusIdx: fc.integer({ min: 0, max: NO_PATH_STATUS.length - 1 }),
    catIdx: fc.integer({ min: 0, max: 3 }),
    favorite: fc.boolean(),
});

const warmScenarioArb = fc.record({
    sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
    rootIdx: fc.integer({ min: 0, max: 3 }),
    entries: fc.array(warmEntrySpecArb, { minLength: 1, maxLength: 14 }),
});

/**
 * The admission rule hydrateWarmPaintThumbnail applies, evaluated against a
 * record AS IT STANDS. Added by task 6.5 as the classifier P2's re-entrant
 * probe and F1's generated property both need.
 *
 * WHY THIS IS NOT THE SAME PREDICATE AS P2's `bugCondition`, which is computed
 * from the PRE-warm-paint snapshot. Once startupWarmPaint has run, a
 * bug-condition entry of the "thumbnailPath present, thumbnail falsy,
 * thumbStatus not ready" class has LEFT the condition: it now carries a
 * non-empty thumbnail with a non-"ready" status, which is precisely the class
 * clause 3.3 protects. So a second hydration of that entry correctly returns
 * false. That is idempotence, not a miss — a non-"ready" card is never
 * re-busted on a later warm paint. The "ready" class, by contrast, is
 * re-derived every time, which is the design's stale-token argument.
 *
 * This mirrors production logic, so it is pinned by the literal decision table
 * in "F1-units — the hydrateWarmPaintThumbnail decision table" below rather
 * than trusted on its own: if the shipped guards ever drift from these four
 * lines, the table goes red before this classifier can quietly agree with the
 * wrong thing.
 */
function hydrationAdmits(rec) {
    if (!rec || typeof rec !== "object") return false;
    const raw = rec.thumbnailPath;
    if (typeof raw !== "string" || raw === "") return false;
    const hasThumb = typeof rec.thumbnail === "string" && rec.thumbnail !== "";
    if (hasThumb && rec.thumbStatus !== "ready") return false;
    return true;
}

describe("P2 — warm paint never writes thumbnailPath and never disturbs a non-bug entry", function () {
    const WARM_CATS = ["Logos", "Titles", "Uncategorized", "Brands"];
    const WARM_ROOTS = ["C:/lib", "D:/shared/gamma", "//server/share/lib", "/var/lib/cs"];

    function buildSeed(scenario) {
        const section = SECTION_VALUES[scenario.sectionIdx];
        const root = WARM_ROOTS[scenario.rootIdx];
        const entries = [];
        const rawThumbPaths = [];

        scenario.entries.forEach(function (spec, i) {
            const cat = WARM_CATS[spec.catIdx];
            const folderPath = root + "/" + section + "/" + cat + "/item-" + i;
            const entry = {
                id: "tpl-" + i,
                name: "T" + i,
                category: cat,
                section: section,
                type: spec.isMedia ? "media" : section,
                favorite: spec.favorite,
                folderPath: folderPath,
                sourcePath: root,
            };
            if (spec.isMedia) {
                entry.mediaType = "video";
                entry.mediaFile = "clip-" + i + ".mp4";
            }

            if (spec.klass === "no-thumbpath") {
                // No thumbnailPath and no thumbnail: the placeholder class.
                entry.thumbStatus = NO_PATH_STATUS[spec.noPathStatusIdx];
            } else {
                const raw = spec.backslashes
                    ? (folderPath + "/thumbnail.png").replace(/\//g, "\\")
                    : folderPath + "/thumbnail.png";
                entry.thumbnailPath = raw;
                rawThumbPaths.push(raw);
                if (spec.klass === "bug-ready") {
                    entry.thumbStatus = "ready";
                } else if (spec.klass === "bug-falsy-thumb") {
                    entry.thumbStatus = "placeholder";
                    entry.thumbnail = "";
                } else {
                    // keeps-in-session: a good URL with a NON-ready status, the
                    // exact class clause 3.3 protects.
                    entry.thumbStatus = "placeholder";
                    entry.thumbnail = "file:///" + encodeURI(folderPath.replace(/^\//, "")) +
                        "/thumbnail.png?v=1700000000000-" + (i + 1);
                }
            }
            entries.push(entry);
        });

        return { section: section, root: root, entries: entries, rawThumbPaths: rawThumbPaths };
    }

    test("startupWarmPaint: thumbnailPath survives raw, non-bug thumbnails survive, zero disk calls", function () {
        // **Validates: Requirements 3.2, 3.3**
        let bugClassRuns = 0;
        let keepsRuns = 0;
        let noPathRuns = 0;
        let hydrateTrueRuns = 0;
        let hydrateFalseRuns = 0;

        fc.assert(
            fc.property(warmScenarioArb, function (scenario) {
                const seed = buildSeed(scenario);
                const li = persistIndex(seed.entries);

                // Snapshot the PERSISTED shape (post round-trip), which is what
                // warm paint actually reads.
                const before = {};
                li._entries.forEach(function (e) {
                    before[e.folderPath] = {
                        thumbnailPath: Object.prototype.hasOwnProperty.call(e, "thumbnailPath")
                            ? e.thumbnailPath : ABSENT,
                        thumbnail: Object.prototype.hasOwnProperty.call(e, "thumbnail")
                            ? e.thumbnail : ABSENT,
                        thumbStatus: e.thumbStatus,
                        type: e.type,
                    };
                });

                const realm = createPanelRealm({
                    libraryIndex: li,
                    currentSection: seed.section,
                    currentCategory: "All",
                    libraryPaths: [seed.root],
                    rootPath: seed.root,
                    existsRaw: seed.rawThumbPaths,
                });
                const ctx = realm.context;

                const diskCallsBefore = realm.existsPaths.length;
                const result = ctx.startupWarmPaint(li);
                const diskCallsDuringWarmPaint = realm.existsPaths.length - diskCallsBefore;

                expect(result.painted).toBe(true);
                expect(ctx.allTemplates.length).toBe(seed.entries.length);
                // Clause 2.2's "before filterAndRender" ordering is not
                // observable pre-fix; what IS observable is that warm paint
                // reached no filesystem, which the fix must preserve (D1).
                expect(diskCallsDuringWarmPaint).toBe(0);
                expect(realm.warnings).toEqual([]);

                const firstObservation = { section: seed.section, entries: [] };

                ctx.allTemplates.forEach(function (rec) {
                    const snap = before[rec.folderPath];
                    expect(snap).toBeDefined();

                    const hasPath = Object.prototype.hasOwnProperty.call(rec, "thumbnailPath");
                    const nowPath = hasPath ? rec.thumbnailPath : ABSENT;
                    const nowThumb = Object.prototype.hasOwnProperty.call(rec, "thumbnail")
                        ? rec.thumbnail : ABSENT;

                    firstObservation.entries.push({
                        folderPath: rec.folderPath,
                        type: rec.type,
                        thumbStatus: rec.thumbStatus,
                        thumbnailPathBefore: snap.thumbnailPath,
                        thumbnailPathAfter: nowPath,
                        thumbnailBefore: snap.thumbnail,
                        thumbnailAfter: nowThumb,
                    });

                    // ── Clause 3.2: thumbnailPath is never written ──────────
                    expect(nowPath).toBe(snap.thumbnailPath);
                    if (typeof nowPath === "string" && nowPath !== ABSENT) {
                        expect(/^file:/i.test(nowPath)).toBe(false);
                        expect(nowPath.indexOf("?v=")).toBe(-1);
                        // Probe-compatible: the fake existsSync is keyed on the
                        // RAW strings the entries were seeded with.
                        expect(realm.existsSync(nowPath)).toBe(true);
                    }

                    // ── Clause 3.3: the two non-bug classes keep `thumbnail` ─
                    const bugCondition = typeof snap.thumbnailPath === "string" &&
                        snap.thumbnailPath !== ABSENT && snap.thumbnailPath !== "" &&
                        (snap.thumbStatus === "ready" ||
                            snap.thumbnail === ABSENT || !snap.thumbnail);
                    if (bugCondition) {
                        bugClassRuns++;
                    } else {
                        expect(nowThumb).toBe(snap.thumbnail);
                        if (nowPath === ABSENT) noPathRuns++;
                        else keepsRuns++;
                    }

                    // ── Clause 3.3: no thumbnailPath -> placeholder artwork ──
                    // Scoped to entries that also carry no `thumbnail`, which is
                    // exactly the placeholder class the clause names; an entry
                    // with a thumbnail but no thumbnailPath renders that
                    // thumbnail, on unfixed and fixed source alike.
                    if (nowPath === ABSENT && !nowThumb) {
                        const markup = ctx.renderTemplateCardMarkup(rec, seed.section, []);
                        expect(markup.indexOf('<img class="thumb-img" src="')).toBe(-1);
                        if (rec.type === "media") {
                            // Media cards always keep one stable patch target.
                            expect(markup).toContain('<div class="thumb-box"><img class="thumb-img" alt=""></div>');
                        } else if (seed.section === SECTIONS.EFFECT) {
                            expect(markup).toContain('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>');
                        } else {
                            expect(markup).toContain('<rect x="3" y="3" width="18" height="18" rx="3"/>');
                        }
                    }

                    // ── P2's hydrateWarmPaintThumbnail half ─────────────────
                    // (was [DEFERRED -> task 6.5]; the helper lands in task 6.2)
                    //
                    // The obligation: the helper is a NO-OP on every entry
                    // outside the admission rule, and says so by returning
                    // false. `entry.thumbnail` must come back === its prior
                    // value, INCLUDING the absent case — hence the ABSENT
                    // sentinel on both sides, which also makes a
                    // property-present-but-undefined entry compare correctly.
                    //
                    // The predicate is hydrationAdmits(rec), read off the
                    // record as it stands, NOT the pre-warm-paint bugCondition
                    // above. See hydrationAdmits' own note: startupWarmPaint has
                    // already hydrated the bug-condition entries by now, so this
                    // probe is a SECOND hydration and the two predicates
                    // legitimately disagree for one class.
                    const admitsNow = hydrationAdmits(rec);
                    const thumbBeforeProbe = Object.prototype.hasOwnProperty.call(rec, "thumbnail")
                        ? rec.thumbnail : ABSENT;
                    const hydratedAgain = ctx.hydrateWarmPaintThumbnail(rec);
                    const thumbAfterProbe = Object.prototype.hasOwnProperty.call(rec, "thumbnail")
                        ? rec.thumbnail : ABSENT;

                    expect(hydratedAgain).toBe(admitsNow);
                    if (hydratedAgain) {
                        hydrateTrueRuns++;
                        expect(typeof thumbAfterProbe).toBe("string");
                        expect(thumbAfterProbe.indexOf("file:///")).toBe(0);
                    } else {
                        hydrateFalseRuns++;
                        expect(thumbAfterProbe).toBe(thumbBeforeProbe);
                    }
                });

                // Hydration reached no filesystem either — the probes above ran
                // after diskCallsBefore was taken, so this covers warm paint AND
                // every hydrateWarmPaintThumbnail call in the loop.
                expect(realm.existsPaths.length).toBe(diskCallsBefore);

                observe("P2", "unfixed warm paint: every entry after startupWarmPaint", {
                    diskCallsDuringWarmPaint: diskCallsDuringWarmPaint,
                    painted: result,
                    detail: firstObservation,
                });

                return true;
            }),
            { numRuns: 30, seed: 20260902 }
        );

        // Non-vacuity: all three input classes were actually reached.
        expect(bugClassRuns).toBeGreaterThan(0);
        expect(keepsRuns).toBeGreaterThan(0);
        expect(noPathRuns).toBeGreaterThan(0);
        // And both sides of the hydration probe fired, so neither branch of the
        // no-op obligation is vacuous.
        expect(hydrateTrueRuns).toBeGreaterThan(0);
        expect(hydrateFalseRuns).toBeGreaterThan(0);

        observe("P2-hydrate", "the re-entrant hydrateWarmPaintThumbnail probe, by outcome", {
            returnedTrue: hydrateTrueRuns,
            returnedFalse: hydrateFalseRuns,
            note: "false is the no-op branch: thumbnail came back === its prior value",
        });
    }, 180000);

    test("loadTemplates' warm branch preserves the same three invariants", function () {
        // **Validates: Requirements 3.2, 3.3**
        //
        // The second warm-paint implementation (loadTemplates:47-58) takes the
        // same fix in task 6.4, so it takes the same preservation obligation.
        fc.assert(
            fc.property(warmScenarioArb, function (scenario) {
                const seed = buildSeed(scenario);
                const li = persistIndex(seed.entries);
                const before = {};
                li._entries.forEach(function (e) {
                    before[e.folderPath] = {
                        thumbnailPath: Object.prototype.hasOwnProperty.call(e, "thumbnailPath")
                            ? e.thumbnailPath : ABSENT,
                        thumbnail: Object.prototype.hasOwnProperty.call(e, "thumbnail")
                            ? e.thumbnail : ABSENT,
                        thumbStatus: e.thumbStatus,
                    };
                });

                const realm = createPanelRealm({
                    libraryIndex: li,
                    currentSection: seed.section,
                    libraryPaths: [seed.root],
                    rootPath: seed.root,
                    existsRaw: seed.rawThumbPaths,
                });
                const ctx = realm.context;

                ctx.loadTemplates();

                expect(ctx.allTemplates.length).toBe(seed.entries.length);
                expect(realm.existsPaths.length).toBe(0);

                ctx.allTemplates.forEach(function (rec) {
                    const snap = before[rec.folderPath];
                    const hasPath = Object.prototype.hasOwnProperty.call(rec, "thumbnailPath");
                    const nowPath = hasPath ? rec.thumbnailPath : ABSENT;
                    const nowThumb = Object.prototype.hasOwnProperty.call(rec, "thumbnail")
                        ? rec.thumbnail : ABSENT;

                    expect(nowPath).toBe(snap.thumbnailPath);
                    if (typeof nowPath === "string" && nowPath !== ABSENT) {
                        expect(/^file:/i.test(nowPath)).toBe(false);
                        expect(nowPath.indexOf("?v=")).toBe(-1);
                        expect(realm.existsSync(nowPath)).toBe(true);
                    }

                    const bugCondition = typeof snap.thumbnailPath === "string" &&
                        snap.thumbnailPath !== ABSENT && snap.thumbnailPath !== "" &&
                        (snap.thumbStatus === "ready" ||
                            snap.thumbnail === ABSENT || !snap.thumbnail);
                    if (!bugCondition) expect(nowThumb).toBe(snap.thumbnail);
                });

                observe("P2-loadTemplates", "the second warm-paint branch, same invariants", {
                    entries: ctx.allTemplates.length,
                    backgroundReconcileTimersScheduled: realm.timers.length,
                });

                return true;
            }),
            { numRuns: 25, seed: 20260903 }
        );
    }, 180000);
});

// ════════════════════════════════════════════════════════════════════════════
// F1 -> Property 1 (clauses 2.1, 2.2) — added by task 6.5.
//
// The FIX-CHECKING counterpart of P2, which is why it sits here. P2 says warm
// paint leaves every other entry alone; F1 says it actually repairs the ones it
// is supposed to. Exploration cases E1 and E2 are the two scoped witnesses (one
// per warm-paint branch); F1 is the universally quantified form over the input
// space they sample.
//
// The obligation, per the design's Property 1 and task 6.5:
//   - hydrateWarmPaintThumbnail returns true for every admitted entry,
//   - the value it writes starts "file:///",
//   - it DECODES BACK to the raw path, so no path information is lost or
//     double-escaped on the way through encodeURI,
//   - it carries a "?v=" token distinct from the previous token issued for that
//     folder, so the embedded browser cannot answer from its cache,
//   - renderTemplateCardMarkup emits '<img class="thumb-img" src="…">' for it,
//     which is the symptom the bug report actually described, and
//   - hydration touches NO FILESYSTEM. The realm's `existsPaths` array is
//     already the counter for that: createPanelRealm's nfs() pushes every probed
//     path into it, so "zero nfs() calls" is "existsPaths did not grow".
//
// ONE REALM, memoized. hydrateWarmPaintThumbnail, buildBustedThumbUrl and
// renderTemplateCardMarkup are all pure functions of their arguments plus the
// per-folder token sequence, so a realm per generated run would buy nothing and
// cost 400 evaluations of templates.js. The token sequence is realm state and is
// deliberately SHARED across runs — that is what makes "distinct from the
// previous token issued for that folder" a real claim rather than a fresh-state
// tautology.
// ════════════════════════════════════════════════════════════════════════════

// Deliberately hostile raw paths: Windows drive roots, UNC in both spellings,
// POSIX absolute, bare relative and empty roots; separator style varied over
// forward / back / mixed; segments covering every encodeURI class (escaped,
// not escaped, already-percent-encoded, C0/DEL controls, non-BMP).
const F1_ROOTS = [
    "C:/lib", "C:\\lib", "D:/Archive", "E:\\archive",
    "//server/share/lib", "\\\\server\\share\\lib",
    "/var/lib/compsaver", "/lib", "lib", "",
];
const F1_SEGMENTS = [
    "icon", "footage", "Logos", "Acme", "Uncategorized",
    "My Cat", "Two  Spaces", "Trailing ", "media-0063-006c",
    "quote\"cat", "angle<lt>gt", "brace{a}b", "pipe|cat", "caret^cat",
    "back`tick", "square[a]b", "percent%cat", "already%20encoded",
    "hash#cat", "query?cat", "amp&cat", "plus+cat", "semi;cat", "at@cat",
    "eq=cat", "dollar$cat", "comma,cat", "colon:cat", "tilde~cat",
    "bang!cat", "star*cat", "apos'cat", "paren(a)b",
    "dash-under_dot.cat", "caf\u00e9", "\u65e5\u672c\u8a9e",
    "\u0417\u0430\u0433\u043e\u043b\u043e\u0432\u043a\u0438",
    "\ud83d\ude00emoji", "tab\tcat", "nl\ncat", "del\u007fcat",
];
const F1_LEAVES = ["thumbnail.png", "thumb 01.png", "th%umb.png", "thumbnail.PNG", "poster.jpeg"];
// Arbitrary thumbStatus, including the values only "ready" is special against.
const F1_STATUSES = ["ready", "placeholder", "failed", "pending", "", "READY", " ready"];
// `thumbnail` present or absent, and present in every shape the guard has to
// classify: empty string (falsy -> admitted), a good busted URL, a raw path, and
// a non-string, which the `typeof … === "string"` half of the guard rejects.
const F1_THUMB_KINDS = ["absent", "empty", "url", "raw", "nonString"];

const f1EntryArb = fc.record({
    rootIdx: fc.integer({ min: 0, max: F1_ROOTS.length - 1 }),
    segIdxs: fc.array(fc.integer({ min: 0, max: F1_SEGMENTS.length - 1 }), { minLength: 1, maxLength: 4 }),
    leafIdx: fc.integer({ min: 0, max: F1_LEAVES.length - 1 }),
    sepStyle: fc.constantFrom("forward", "back", "mixed"),
    // statusIdx === F1_STATUSES.length means "no thumbStatus property at all".
    statusIdx: fc.integer({ min: 0, max: F1_STATUSES.length }),
    thumbKind: fc.constantFrom.apply(fc, F1_THUMB_KINDS),
    isMedia: fc.boolean(),
    sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
});

/** Re-slash `posixPath` in the requested style. */
function applySepStyle(posixPath, style) {
    if (style === "back") return posixPath.replace(/\//g, "\\");
    if (style === "mixed") {
        let n = 0;
        return posixPath.replace(/\//g, function () {
            n++;
            return n % 2 === 0 ? "\\" : "/";
        });
    }
    return posixPath;
}

/** buildBustedThumbUrl's path normalisation, as a test-side oracle. */
function expectedForwardPath(raw) {
    let fwd = ("" + raw).replace(/\\/g, "/");
    if (fwd.charAt(0) === "/") fwd = fwd.substring(1);
    return fwd;
}

/** Split a busted URL into its body and its trailing "?v=" token. */
function splitBustedUrl(url) {
    const cut = url.lastIndexOf("?v=");
    return {
        cut: cut,
        body: cut === -1 ? url : url.substring(0, cut),
        token: cut === -1 ? null : url.substring(cut + 3),
    };
}

function buildF1Entry(spec) {
    const section = SECTION_VALUES[spec.sectionIdx];
    const root = F1_ROOTS[spec.rootIdx];
    const segs = spec.segIdxs.map(function (i) { return F1_SEGMENTS[i]; });
    const folderParts = (root === "" ? [] : [root]).concat(segs);
    const folderPosix = folderParts.join("/");
    const rawPosix = (folderPosix === "" ? "" : folderPosix + "/") + F1_LEAVES[spec.leafIdx];

    const entry = {
        id: "tpl-f1",
        name: "F1",
        category: "Logos",
        section: section,
        type: spec.isMedia ? "media" : section,
        favorite: false,
        folderPath: applySepStyle(folderPosix, spec.sepStyle),
        sourcePath: root,
        thumbnailPath: applySepStyle(rawPosix, spec.sepStyle),
    };
    if (spec.isMedia) entry.mediaType = "video";
    if (spec.statusIdx < F1_STATUSES.length) entry.thumbStatus = F1_STATUSES[spec.statusIdx];

    if (spec.thumbKind === "empty") entry.thumbnail = "";
    else if (spec.thumbKind === "raw") entry.thumbnail = entry.thumbnailPath;
    else if (spec.thumbKind === "nonString") entry.thumbnail = null;
    else if (spec.thumbKind === "url") {
        entry.thumbnail = "file:///" + encodeURI(expectedForwardPath(rawPosix)) + "?v=1700000000000-0";
    }

    return { entry: entry, section: section, rawPosix: rawPosix };
}

let F1_REALM = null;
function f1Realm() {
    if (F1_REALM === null) {
        const realm = createPanelRealm({});
        if (typeof realm.context.hydrateWarmPaintThumbnail !== "function") {
            throw new Error(
                "js/templates/templates.js does not expose hydrateWarmPaintThumbnail. Task 6.2 " +
                "adds it as a top-level declaration; F1 and P2's no-op half both read it."
            );
        }
        F1_REALM = realm;
    }
    return F1_REALM;
}

describe("F1 — hydrateWarmPaintThumbnail turns a persisted thumbnailPath into a renderable card", function () {
    test("every admitted entry gets a decodable, freshly busted file:/// URL the renderer emits, with zero disk calls", function () {
        // **Validates: Requirements 2.1, 2.2**
        const realm = f1Realm();
        const ctx = realm.context;

        let admittedRuns = 0;
        let rejectedRuns = 0;
        const stylesSeen = Object.create(null);
        const kindsSeen = Object.create(null);
        let firstSample = null;

        fc.assert(
            fc.property(f1EntryArb, function (spec) {
                const built = buildF1Entry(spec);
                const entry = built.entry;
                const admits = hydrationAdmits(entry);

                stylesSeen[spec.sepStyle] = true;
                kindsSeen[spec.thumbKind] = true;

                const thumbBefore = Object.prototype.hasOwnProperty.call(entry, "thumbnail")
                    ? entry.thumbnail : ABSENT;

                // "the previous token issued for that folder": issue one, so the
                // comparison is against a real predecessor rather than nothing.
                const normFolder = ("" + entry.folderPath).replace(/\\/g, "/");
                const previousToken = ctx.nextThumbCacheToken(normFolder);

                const diskBefore = realm.existsPaths.length;
                const hydrated = ctx.hydrateWarmPaintThumbnail(entry);
                // Zero nfs() calls: the design forbids any filesystem access
                // here, and the startup harnesses inject an nfs() with no
                // statSync at all, so a probe would throw there as well.
                expect(realm.existsPaths.length).toBe(diskBefore);

                expect(hydrated).toBe(admits);

                if (!hydrated) {
                    rejectedRuns++;
                    const thumbAfter = Object.prototype.hasOwnProperty.call(entry, "thumbnail")
                        ? entry.thumbnail : ABSENT;
                    expect(thumbAfter).toBe(thumbBefore);
                    return true;
                }

                admittedRuns++;
                const url = entry.thumbnail;

                // ── file:/// scheme ─────────────────────────────────────────
                expect(typeof url).toBe("string");
                expect(url.indexOf("file:///")).toBe(0);

                // ── a fresh, distinct busting token ─────────────────────────
                const parts = splitBustedUrl(url);
                expect(parts.cut).toBeGreaterThan(-1);
                expect(parts.token).toMatch(/^\d+-\d+$/);
                expect(parts.token).not.toBe(previousToken);

                // ── decodes back to the raw path ────────────────────────────
                // decodeURI is encodeURI's exact inverse, so a round trip that
                // loses or double-escapes a character shows up here. This is
                // what catches a path mangled on the way to the renderer.
                const body = parts.body.substring("file:///".length);
                expect(decodeURI(body)).toBe(expectedForwardPath(entry.thumbnailPath));

                // ── the one shared rule produced it ─────────────────────────
                expect(url).toBe(ctx.buildBustedThumbUrl(entry.thumbnailPath, parts.token));

                // ── the renderer emits it, which is the reported symptom ────
                // renderTemplateCardMarkup passes an already-file:/// value
                // through verbatim, so the src is exactly escapeAttr(url).
                const markup = ctx.renderTemplateCardMarkup(entry, built.section, []);
                expect(markup).toContain('<img class="thumb-img" src="' + escapeAttr(url) + '" alt="">');

                // thumbnailPath is never written (clause 3.2), on this path too.
                expect(entry.thumbnailPath).toBe(applySepStyle(built.rawPosix, spec.sepStyle));

                if (firstSample === null) {
                    firstSample = {
                        thumbnailPath: entry.thumbnailPath,
                        thumbStatus: entry.thumbStatus,
                        previousToken: previousToken,
                        url: url,
                        decodedBody: decodeURI(body),
                    };
                }

                return true;
            }),
            { numRuns: 400, seed: 20260905 }
        );

        // Non-vacuity: both outcomes reached, every separator style exercised,
        // every `thumbnail` shape classified.
        expect(admittedRuns).toBeGreaterThan(0);
        expect(rejectedRuns).toBeGreaterThan(0);
        expect(Object.keys(stylesSeen).sort()).toEqual(["back", "forward", "mixed"]);
        expect(Object.keys(kindsSeen).sort()).toEqual(F1_THUMB_KINDS.slice().sort());

        observe("F1", "hydrateWarmPaintThumbnail over generated raw paths", {
            admittedRuns: admittedRuns,
            rejectedRuns: rejectedRuns,
            diskCallsDuringHydration: 0,
            firstAdmittedSample: firstSample,
        });
    }, 180000);
});

// ════════════════════════════════════════════════════════════════════════════
// F1-units — the two helpers' literal tables (task 6.5).
//
// The decision table is the pin under hydrationAdmits: the generated properties
// above classify with a re-implementation of the guard, and these rows are what
// stop that re-implementation from silently agreeing with a drifted guard. It
// also carries the null / undefined / non-object / empty-string guard rows the
// design lists — kept in ONE place rather than duplicated into P2, which points
// here instead.
// ════════════════════════════════════════════════════════════════════════════
describe("F1-units — the hydrateWarmPaintThumbnail decision table", function () {
    const FOLDER = "C:/lib/icon/Logos/Acme";
    const RAW = FOLDER + "/thumbnail.png";
    const INSESSION = "file:///C:/lib/icon/Logos/Acme/thumbnail.png?v=1700000000000-7";

    // The full 2x2x2 over (thumbnailPath present?) x (thumbnail present?) x
    // (thumbStatus === "ready"?), mapped onto the four outcome classes the
    // design names.
    const TABLE = [
        {
            label: "no thumbnailPath, no thumbnail, not ready",
            entry: { folderPath: FOLDER, thumbStatus: "placeholder" },
            hydrates: false, klass: "placeholder stands",
        },
        {
            label: "no thumbnailPath, no thumbnail, ready",
            entry: { folderPath: FOLDER, thumbStatus: "ready" },
            hydrates: false, klass: "placeholder stands",
        },
        {
            label: "no thumbnailPath, a thumbnail, not ready",
            entry: { folderPath: FOLDER, thumbStatus: "placeholder", thumbnail: INSESSION },
            hydrates: false, klass: "placeholder stands",
        },
        {
            label: "no thumbnailPath, a thumbnail, ready",
            entry: { folderPath: FOLDER, thumbStatus: "ready", thumbnail: INSESSION },
            hydrates: false, klass: "placeholder stands",
        },
        {
            label: "a thumbnailPath, no thumbnail, not ready",
            entry: { folderPath: FOLDER, thumbnailPath: RAW, thumbStatus: "placeholder" },
            hydrates: true, klass: "hydrate a missing thumbnail",
        },
        {
            label: "a thumbnailPath, no thumbnail, ready",
            entry: { folderPath: FOLDER, thumbnailPath: RAW, thumbStatus: "ready" },
            hydrates: true, klass: "hydrate a missing thumbnail",
        },
        {
            label: "a thumbnailPath, a thumbnail, NOT ready — clause 3.3's protected class",
            entry: { folderPath: FOLDER, thumbnailPath: RAW, thumbStatus: "placeholder", thumbnail: INSESSION },
            hydrates: false, klass: "in-session value stands",
        },
        {
            label: "a thumbnailPath, a thumbnail, ready — re-derived with a fresh token",
            entry: { folderPath: FOLDER, thumbnailPath: RAW, thumbStatus: "ready", thumbnail: INSESSION },
            hydrates: true, klass: "re-derive on ready",
        },
        // An empty thumbnail is falsy, so it is the bug-report shape rather than
        // a protected in-session value: renderOptimisticCard writes exactly this.
        {
            label: "a thumbnailPath and an EMPTY thumbnail — renderOptimisticCard's own shape",
            entry: { folderPath: FOLDER, thumbnailPath: RAW, thumbStatus: "placeholder", thumbnail: "" },
            hydrates: true, klass: "hydrate a missing thumbnail",
        },
        // ── The degenerate-input guard rows ─────────────────────────────────
        { label: "null", entry: null, hydrates: false, klass: "rejected input" },
        { label: "undefined", entry: undefined, hydrates: false, klass: "rejected input" },
        { label: "a non-object: a string", entry: "not an entry", hydrates: false, klass: "rejected input" },
        { label: "a non-object: a number", entry: 42, hydrates: false, klass: "rejected input" },
        { label: "a non-object: a boolean", entry: true, hydrates: false, klass: "rejected input" },
        {
            label: "an empty-string thumbnailPath",
            entry: { folderPath: FOLDER, thumbnailPath: "", thumbStatus: "ready" },
            hydrates: false, klass: "rejected input",
        },
        {
            label: "a non-string thumbnailPath",
            entry: { folderPath: FOLDER, thumbnailPath: 7, thumbStatus: "ready" },
            hydrates: false, klass: "rejected input",
        },
    ];

    test("every row returns the recorded outcome and mutates nothing it declines", function () {
        // **Validates: Requirements 2.1, 2.2, 3.3**
        const realm = f1Realm();
        const ctx = realm.context;

        const rows = TABLE.map(function (row) {
            const isObject = !!row.entry && typeof row.entry === "object";
            const before = isObject && Object.prototype.hasOwnProperty.call(row.entry, "thumbnail")
                ? row.entry.thumbnail : ABSENT;
            // Classify BEFORE invoking: a hydrating row is mutated by the call,
            // and a mutated row no longer describes the input class it names.
            const classifier = hydrationAdmits(row.entry);

            const diskBefore = realm.existsPaths.length;
            const got = ctx.hydrateWarmPaintThumbnail(row.entry);
            const diskCalls = realm.existsPaths.length - diskBefore;

            const after = isObject && Object.prototype.hasOwnProperty.call(row.entry, "thumbnail")
                ? row.entry.thumbnail : ABSENT;

            return {
                label: row.label, klass: row.klass,
                expected: row.hydrates, actual: got, classifier: classifier,
                thumbnailBefore: before, thumbnailAfter: after,
                diskCalls: diskCalls,
            };
        });

        observe("F1-table", "the hydrateWarmPaintThumbnail decision table, as observed", { rows: rows });

        TABLE.forEach(function (row, i) {
            expect(rows[i].actual).toBe(row.hydrates);
            // The classifier the generated properties use agrees on every row,
            // which is what stops hydrationAdmits drifting from the shipped guard.
            expect(rows[i].classifier).toBe(row.hydrates);
            expect(rows[i].diskCalls).toBe(0);
            if (row.hydrates) {
                expect(typeof rows[i].thumbnailAfter).toBe("string");
                expect(rows[i].thumbnailAfter.indexOf("file:///")).toBe(0);
                expect(rows[i].thumbnailAfter).not.toBe(rows[i].thumbnailBefore);
            } else {
                expect(rows[i].thumbnailAfter).toBe(rows[i].thumbnailBefore);
            }
        });

        // The table is not vacuous: all four outcome classes plus the rejected
        // inputs were reached.
        const classes = {};
        TABLE.forEach(function (row) { classes[row.klass] = true; });
        expect(Object.keys(classes).sort()).toEqual([
            "hydrate a missing thumbnail",
            "in-session value stands",
            "placeholder stands",
            "re-derive on ready",
            "rejected input",
        ]);
    });
});

describe("F1-units — buildBustedThumbUrl", function () {
    const T = "1700000000000-1";

    const ROWS = [
        {
            label: "a single leading slash is stripped, so file:/// keeps exactly three",
            raw: "/var/lib/compsaver/icon/Logos/Acme/thumbnail.png",
            url: "file:///var/lib/compsaver/icon/Logos/Acme/thumbnail.png?v=" + T,
        },
        {
            label: "ONLY ONE leading slash is stripped, so a UNC path keeps its second",
            raw: "//server/share/lib/thumbnail.png",
            url: "file:////server/share/lib/thumbnail.png?v=" + T,
        },
        {
            label: "backslashes become forward slashes",
            raw: "C:\\lib\\icon\\Logos\\Acme\\thumbnail.png",
            url: "file:///C:/lib/icon/Logos/Acme/thumbnail.png?v=" + T,
        },
        {
            label: "a mixed-separator path normalises to forward slashes",
            raw: "C:/lib\\icon/Logos\\Acme/thumbnail.png",
            url: "file:///C:/lib/icon/Logos/Acme/thumbnail.png?v=" + T,
        },
        {
            label: "a backslash UNC prefix normalises and keeps both slashes",
            raw: "\\\\server\\share\\lib\\thumbnail.png",
            url: "file:////server/share/lib/thumbnail.png?v=" + T,
        },
        {
            label: "an interior double slash is preserved verbatim",
            raw: "C:/lib/icon/Logos/Acme//thumbnail.png",
            url: "file:///C:/lib/icon/Logos/Acme//thumbnail.png?v=" + T,
        },
        { label: "the empty string short-circuits to \"\"", raw: "", url: "" },
        { label: "null short-circuits to \"\"", raw: null, url: "" },
        { label: "undefined short-circuits to \"\"", raw: undefined, url: "" },
        // The empty check runs BEFORE the leading-slash strip, so a lone
        // separator is NOT the empty case: it survives the check and then strips
        // to nothing, leaving a scheme-only URL. Both spellings agree because
        // the backslash fold runs first.
        {
            label: "a lone forward slash strips to a scheme-only URL",
            raw: "/", url: "file:///?v=" + T,
        },
        {
            label: "a lone backslash folds to \"/\" first, so it lands identically",
            raw: "\\", url: "file:///?v=" + T,
        },
    ];

    // encodeURI escapes these. Backslash is absent on purpose: it is folded to
    // "/" before encodeURI ever sees it, so it can never reach %5C.
    const ESCAPED = [
        [" ", "%20"], ["\"", "%22"], ["<", "%3C"], [">", "%3E"],
        ["{", "%7B"], ["}", "%7D"], ["|", "%7C"], ["^", "%5E"],
        ["`", "%60"], ["[", "%5B"], ["]", "%5D"], ["%", "%25"],
        ["\t", "%09"], ["\n", "%0A"], ["\r", "%0D"], ["\u007f", "%7F"],
        ["\u0000", "%00"], ["\u001f", "%1F"],
        ["\u00e9", "%C3%A9"], ["\u65e5", "%E6%97%A5"], ["\ud83d\ude00", "%F0%9F%98%80"],
    ];

    // encodeURI leaves these alone: the unreserved set plus every reserved URI
    // character. `#` and `?` matter most — they reach the browser unescaped, and
    // that is the pre-fix behaviour the refactor had to preserve byte for byte.
    const NOT_ESCAPED = [
        "#", "?", "&", "+", ";", "@", "=", "$", ",", ":", "/",
        "~", "!", "*", "'", "(", ")", "-", "_", ".",
        "A", "z", "0", "9",
    ];

    test("every row returns the recorded URL", function () {
        // **Validates: Requirements 3.1**
        const ctx = f1Realm().context;
        const observed = ROWS.map(function (row) {
            return { label: row.label, raw: row.raw, actual: ctx.buildBustedThumbUrl(row.raw, T), expected: row.url };
        });
        observe("F1-buildBustedThumbUrl", "the unit table, as observed", { rows: observed });
        ROWS.forEach(function (row, i) {
            expect(observed[i].actual).toBe(row.url);
        });
    });

    test("encodeURI escaping is exactly as inherited: the escaped set and the reserved set", function () {
        // **Validates: Requirements 3.1**
        const ctx = f1Realm().context;

        ESCAPED.forEach(function (pair) {
            const raw = "C:/lib/icon/pre" + pair[0] + "post/thumbnail.png";
            expect(ctx.buildBustedThumbUrl(raw, T))
                .toBe("file:///C:/lib/icon/pre" + pair[1] + "post/thumbnail.png?v=" + T);
        });

        NOT_ESCAPED.forEach(function (ch) {
            const raw = "C:/lib/icon/pre" + ch + "post/thumbnail.png";
            expect(ctx.buildBustedThumbUrl(raw, T))
                .toBe("file:///C:/lib/icon/pre" + ch + "post/thumbnail.png?v=" + T);
        });

        // A pre-encoded path is encoded AGAIN, because the rule is a blind
        // encodeURI. Recorded as inherited behaviour, not endorsed: the frozen
        // corpus row for "already%20encoded" says the same thing, so changing it
        // would be a real behaviour change rather than a fix.
        expect(ctx.buildBustedThumbUrl("C:/lib/icon/already%20encoded/thumbnail.png", T))
            .toBe("file:///C:/lib/icon/already%2520encoded/thumbnail.png?v=" + T);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// F1-integration -> Property 1 (clauses 2.1, 2.2) — task 6.5.
//
// The end-to-end statement of the reported bug, across a panel close and reopen.
// Session one saves an image and shows its thumbnail; session two starts from
// nothing but the serialized index and must show the same picture on its FIRST
// painted grid, before any disk or bridge work.
//
// WHAT "THE SAME <img src>" MEANS HERE, and why the token is excluded. Design
// decision D1 issues a FRESH busting token on every warm paint precisely because
// a persisted one is stale by construction — it is the token the embedded
// browser already cached against. So the two sessions' src values are
// byte-identical up to "?v=" and then deliberately differ. The URL BODY is what
// carries "the same picture"; the token is what makes the browser go and fetch
// it. Both halves are asserted: the body byte-identically, and the token as a
// well-formed fresh value that cannot have come from the index, since the
// persisted entry provably carries no thumbnail at all.
//
// Inequality across the two realms is NOT asserted: the token's clock half is
// Date.now() and its sequence half restarts per realm, so two sessions run in
// the same millisecond of one jest process can legitimately agree. The
// enforceable form of distinctness — successive tokens for the same folder
// WITHIN a session — is asserted below and in F1.
// ════════════════════════════════════════════════════════════════════════════
describe("F1-integration — a card saved in one session paints from the persisted index in the next", function () {
    const IROOT = "C:/My Library";
    const IFOLDER = IROOT + "/icon/Logos/Acme";
    const ITHUMB = IFOLDER + "/thumbnail.png";

    /** The first `<img class="thumb-img" src="…">` in a grid's markup. */
    function firstThumbImgSrc(html) {
        const m = /<img class="thumb-img" src="([^"]*)"/.exec("" + (html || ""));
        return m ? m[1] : null;
    }

    /**
     * Session one: save an image through the real entry points. The optimistic
     * card lands first (thumbnail not yet on disk -> placeholder), then the
     * deferred render completes, then a re-render rebuilds the card from the
     * model — which is the grid the user was looking at when the panel closed.
     *
     * The re-render goes through renderCards rather than filterAndRender. Not a
     * shortcut: filterAndRender delegates to renderWindowedIds, which needs the
     * VirtualGrid module, and this realm loads templates.js and templateCatalog.js
     * only. Without VirtualGrid renderWindowedIds renders an EMPTY grid, so
     * filterAndRender here would paint no cards at all. renderCards degrades to
     * the full innerHTML render on the same code path production uses when the
     * windowing module is absent, and filterStartupRecords supplies the same
     * section/category/search predicate the reopen side filters with — so both
     * sides of the comparison below run the same renderer over the same
     * predicate, and the only thing that differs is where `thumbnail` came from.
     */
    function closingSession() {
        const li = persistIndex([]);
        const realm = createPanelRealm({
            libraryIndex: li,
            allTemplates: [],
            currentSection: SECTIONS.ICON,
            currentCategory: "All",
            libraryPaths: [IROOT],
            rootPath: IROOT,
        });
        const ctx = realm.context;

        ctx.renderOptimisticCard({
            name: "Acme",
            category: "Logos",
            section: SECTIONS.ICON,
            type: SECTIONS.ICON,
            sourcePath: IROOT,
            folderPath: IFOLDER,
            thumbnailPath: ITHUMB,
        });
        ctx.refreshCardThumbnail(IFOLDER, ITHUMB);
        ctx.renderCards(ctx.filterStartupRecords());

        return { realm: realm, li: li, ctx: ctx };
    }

    test("the first painted grid carries the closing session's thumbnail, with zero disk and zero bridge calls", function () {
        // **Validates: Requirements 2.1, 2.2**
        const closing = closingSession();
        const closingSrc = firstThumbImgSrc(closing.realm.activeGrid().innerHTML);
        expect(closingSrc).not.toBeNull();
        expect(closingSrc.indexOf("file:///")).toBe(0);

        // ── The panel closes. Only the serialized index survives. ───────────
        const parsed = LibraryIndex.tryParse(closing.li.serialize());
        expect(parsed.ok).toBe(true);
        const reopened = parsed.index;

        const persistedEntry = reopened.getEntry(IFOLDER);
        expect(persistedEntry).not.toBeNull();
        expect(persistedEntry.thumbStatus).toBe("ready");
        expect(persistedEntry.thumbnailPath).toBe(ITHUMB);
        // D1: nothing renderable was persisted, so whatever the next session
        // paints it must have DERIVED. This is what makes the assertion below a
        // statement about the fix rather than about the serializer.
        expect(Object.prototype.hasOwnProperty.call(persistedEntry, "thumbnail")).toBe(false);
        // Snapshot the key list HERE. Under the entry-identity rule warm paint
        // writes onto this very object, so reading its keys after the paint would
        // report the derived thumbnail and make the log say the opposite of the
        // assertion above.
        const persistedKeysAtOpen = Object.keys(persistedEntry);

        // ── The panel reopens. ──────────────────────────────────────────────
        const realm = createPanelRealm({
            libraryIndex: reopened,
            currentSection: SECTIONS.ICON,
            currentCategory: "All",
            libraryPaths: [IROOT],
            rootPath: IROOT,
        });
        const ctx = realm.context;

        // A LIVE bridge, installed on purpose. templates.js reaches the host
        // through `typeof csInterface`/`typeof encodeBridge` probes, so leaving
        // them undefined would make "zero bridge calls" true by absence. With
        // both present and counting, warm paint has to decline them itself.
        const bridge = [];
        ctx.csInterface = {
            evalScript: function (script, cb) {
                bridge.push({ kind: "evalScript", head: ("" + script).slice(0, 60) });
                if (typeof cb === "function") cb("");
            },
            getHostEnvironment: function () {
                bridge.push({ kind: "getHostEnvironment" });
                return {};
            },
        };
        ctx.encodeBridge = function (v) {
            bridge.push({ kind: "encodeBridge" });
            return "" + v;
        };
        ctx.getCombinedDiskValidityKey = function () {
            bridge.push({ kind: "getCombinedDiskValidityKey" });
            return "vk-1";
        };

        // Snapshot both counters at the instant of every grid write, so "before
        // the first grid write" is measured rather than inferred from a total.
        const grid = realm.activeGrid();
        const gridProto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(grid), "innerHTML");
        const writes = [];
        Object.defineProperty(grid, "innerHTML", {
            configurable: true,
            get: function () { return gridProto.get.call(this); },
            set: function (markup) {
                writes.push({
                    markup: "" + markup,
                    existsCallsSoFar: realm.existsPaths.length,
                    bridgeCallsSoFar: bridge.length,
                });
                gridProto.set.call(this, markup);
            },
        });

        const result = ctx.startupWarmPaint(reopened);

        expect(result.painted).toBe(true);
        expect(result.cards).toBe(1);
        expect(realm.warnings).toEqual([]);
        expect(writes.length).toBeGreaterThan(0);

        const firstWrite = writes[0];
        expect(firstWrite.existsCallsSoFar).toBe(0);
        expect(firstWrite.bridgeCallsSoFar).toBe(0);
        // And nothing was touched across the whole warm paint either.
        expect(realm.existsPaths).toEqual([]);
        expect(bridge).toEqual([]);

        const reopenSrc = firstThumbImgSrc(firstWrite.markup);
        expect(reopenSrc).not.toBeNull();

        const closingParts = splitBustedUrl(closingSrc);
        const reopenParts = splitBustedUrl(reopenSrc);
        expect(reopenParts.cut).toBeGreaterThan(-1);

        // The picture: byte-identical.
        expect(reopenParts.body).toBe(closingParts.body);
        // The token: freshly issued, well formed, and not carried over from the
        // index — which holds no thumbnail to carry it in.
        expect(reopenParts.token).toMatch(/^\d+-\d+$/);

        // A second warm paint in the same session re-derives the "ready" entry
        // with a strictly later token. This is the enforceable form of "distinct
        // from the previous token issued for that folder".
        const secondPaint = ctx.startupWarmPaint(reopened);
        expect(secondPaint.painted).toBe(true);
        const secondSrc = firstThumbImgSrc(writes[writes.length - 1].markup);
        const secondParts = splitBustedUrl(secondSrc);
        expect(secondParts.body).toBe(closingParts.body);
        expect(secondParts.token).not.toBe(reopenParts.token);
        expect(realm.existsPaths).toEqual([]);
        expect(bridge).toEqual([]);

        observe("F1-integration", "one saved image across a close and reopen", {
            closingSessionSrc: closingSrc,
            reopenedFirstGridSrc: reopenSrc,
            sharedUrlBody: reopenParts.body,
            closingToken: closingParts.token,
            reopenToken: reopenParts.token,
            secondPaintToken: secondParts.token,
            persistedEntryKeysAtOpen: persistedKeysAtOpen,
            gridWrites: writes.length,
            existsCallsBeforeFirstGridWrite: firstWrite.existsCallsSoFar,
            bridgeCallsBeforeFirstGridWrite: firstWrite.bridgeCallsSoFar,
        });
    }, 60000);
});

// ════════════════════════════════════════════════════════════════════════════
// P2c -> Property 2 (clause 3.1) — the inverse of exploration case E3.
//
// refreshCardThumbnail's in-session contract, which BUG 1's fix must leave
// byte-identical:
//   - allTemplates[i].thumbnail becomes the cache-busted file:///…?v= URL,
//   - allTemplates[i].thumbnailPath becomes the RAW forward-slashed path,
//   - TemplateCatalog.patch is called once for that record (the hand mirror
//     D3 relies on to keep refreshCardThumbnail off the rebuild path),
//   - and the PERSISTED entry carries { thumbStatus: "ready", thumbnailPath }
//     and — asserted deliberately — NO `thumbnail`, because design decision D1
//     chose read-side derivation and declined to widen the write.
//
// HOW THE PRE-FIX URL CORPUS IS PRESERVED FOR TASK 6.5
// ----------------------------------------------------
// Choice: a COMMITTED JSON FIXTURE, tests/fixtures/prefix-busted-thumb-url.baseline.json.
//
// Rationale. The rule under refactor is deterministic in (rawPath, token) but
// the token is a clock read, so a frozen whole-URL snapshot taken from a live
// run is not reproducible. The fixture therefore freezes (raw, token, url)
// triples: `url` is what the PRE-FIX inline construction at
// refreshCardThumbnail emits for `raw` when handed `token`. Task 6.1 deletes
// that inline construction, so after the fix there is no live expression left
// to compare against — which is exactly why the record has to be frozen data
// rather than a recomputation.
//
// Three things keep the fixture honest, all asserted below on every run:
//   1. every row's `url` equals `preFixInlineBustedUrl(row.raw, row.token)`,
//      the inline rule reproduced verbatim in this file — so a corrupted or
//      hand-edited fixture fails immediately;
//   2. the reproduced rule is proved against PRODUCTION: the real
//      refreshCardThumbnail is driven with every row's `raw`, and its emitted
//      URL is asserted to be byte-identical to the reproduced rule's output up
//      to the token;
//   3. the fixture records the ONE deliberate divergence (see the note on
//      `deliberateDivergences` below) so task 6.5 asserts it instead of
//      tripping over it.
//
// Regeneration procedure, should the fixture ever have to be rebuilt:
//   1. Check out a revision of js/templates/templates.js that still contains
//      refreshCardThumbnail's inline three-line construction.
//   2. Copy those three lines into a throwaway script as preFixInlineBustedUrl.
//   3. Map it over PREFIX_URL_RAW_PATHS (below, read back out of the fixture)
//      with token "1700000000000-<1-based index>".
//   4. Write { schema, feature, source, generatedBy, rule, byteIdenticalRows,
//      deliberateDivergences } to the fixture path.
// Assertion 1 above is what verifies the result, so a mistake in step 2 or 3 is
// caught on the next run rather than silently frozen in.
// ════════════════════════════════════════════════════════════════════════════
const PREFIX_URL_BASELINE_REL = path.join("tests", "fixtures", "prefix-busted-thumb-url.baseline.json");
const PREFIX_URL_BASELINE = JSON.parse(repoText(PREFIX_URL_BASELINE_REL));
const PREFIX_URL_ROWS = PREFIX_URL_BASELINE.byteIdenticalRows;
const PREFIX_URL_RAW_PATHS = PREFIX_URL_ROWS.map(function (r) { return r.raw; });

/**
 * js/templates/templates.js refreshCardThumbnail, the PRE-FIX inline
 * construction (pre-BUG-4 lines 2888-2890), reproduced character for
 * character. This is the rule task 6.1's buildBustedThumbUrl must reproduce.
 */
function preFixInlineBustedUrl(thumbPath, version) {
    var fwd = ("" + thumbPath).replace(/\\/g, "/");
    if (fwd.charAt(0) === "/") fwd = fwd.substring(1);
    return "file:///" + encodeURI(fwd) + "?v=" + version;
}

describe("P2c — refreshCardThumbnail's in-session contract and the pre-fix URL corpus", function () {
    const ROOT = "C:/lib";

    function corpusRealm() {
        const entries = PREFIX_URL_ROWS.map(function (row, i) {
            return {
                id: "tpl-" + i,
                name: "T" + i,
                category: "Corpus",
                section: SECTIONS.ICON,
                type: SECTIONS.ICON,
                favorite: false,
                folderPath: ROOT + "/icon/Corpus/row-" + i,
                sourcePath: ROOT,
                // The exact pre-completion shape renderOptimisticCard leaves:
                // a raw thumbnailPath, a placeholder status, and NO thumbnail.
                thumbnailPath: ROOT + "/icon/Corpus/row-" + i + "/thumbnail.png",
                thumbStatus: "placeholder",
            };
        });
        const li = persistIndex(entries);
        // renderOptimisticCard writes two DISTINCT objects — one index entry and
        // one allTemplates record — so the model records are independent clones
        // here, matching the real save-session shape (see E3's note).
        const model = li._entries.map(shallowClone);
        const realm = createPanelRealm({
            libraryIndex: li,
            allTemplates: model,
            currentSection: SECTIONS.ICON,
            libraryPaths: [ROOT],
            rootPath: ROOT,
        });
        realm.context.ensureCatalogFresh();
        realm.resetCatalogSpies();
        return { realm: realm, li: li, entries: entries };
    }

    test("the frozen corpus matches the pre-fix inline rule row for row", function () {
        // **Validates: Requirements 3.1**
        expect(PREFIX_URL_BASELINE.schema).toBe(1);
        expect(PREFIX_URL_ROWS.length).toBeGreaterThan(40);

        PREFIX_URL_ROWS.forEach(function (row, i) {
            expect(typeof row.raw).toBe("string");
            expect(row.raw).not.toBe("");
            expect(row.token).toBe("1700000000000-" + (i + 1));
            expect(row.url).toBe(preFixInlineBustedUrl(row.raw, row.token));
            // Shape guarantees the renderer depends on: an already-file:///
            // value is passed through verbatim, so the corpus must BE one.
            expect(row.url.indexOf("file:///")).toBe(0);
            expect(row.url.indexOf("?v=" + row.token)).toBe(row.url.length - ("?v=" + row.token).length);
        });

        observe("P2c-fixture", "the frozen pre-fix URL corpus", {
            fixture: PREFIX_URL_BASELINE_REL.replace(/\\/g, "/"),
            rows: PREFIX_URL_ROWS.length,
            firstRow: PREFIX_URL_ROWS[0],
            deliberateDivergences: PREFIX_URL_BASELINE.deliberateDivergences,
        });
    });

    test("the reproduced pre-fix rule is byte-identical to what production emits", function () {
        // **Validates: Requirements 3.1**
        const world = corpusRealm();
        const ctx = world.realm.context;

        const detail = [];
        PREFIX_URL_ROWS.forEach(function (row, i) {
            const folder = ROOT + "/icon/Corpus/row-" + i;
            ctx.refreshCardThumbnail(folder, row.raw);

            const rec = ctx.allTemplates[i];
            expect(rec.folderPath).toBe(folder);

            // The deterministic half of the URL — everything up to and
            // including "?v=" — must be byte-identical to the reproduced rule.
            const bodyPrefix = preFixInlineBustedUrl(row.raw, "");
            expect(typeof rec.thumbnail).toBe("string");
            expect(rec.thumbnail.indexOf(bodyPrefix)).toBe(0);

            // The remainder is the cache-busting token: "<mtimeOrNow>-<seq>".
            const token = rec.thumbnail.substring(bodyPrefix.length);
            expect(token).toMatch(/^\d+-\d+$/);
            expect(rec.thumbnail).toBe(preFixInlineBustedUrl(row.raw, token));

            // Clause 3.1: thumbnailPath is the RAW forward-slashed disk path.
            expect(rec.thumbnailPath).toBe(row.raw.replace(/\\/g, "/"));
            expect(/^file:/i.test(rec.thumbnailPath)).toBe(false);
            expect(rec.thumbnailPath.indexOf("?v=")).toBe(-1);
            expect(rec.thumbStatus).toBe("ready");

            if (i < 3) {
                detail.push({
                    raw: row.raw, emitted: rec.thumbnail, token: token,
                    frozenUrlForFrozenToken: row.url,
                });
            }
        });

        // Clause 3.1: the direct catalog patch stays, once per completion.
        expect(world.realm.catalog.patch.length).toBe(PREFIX_URL_ROWS.length);
        world.realm.catalog.patch.forEach(function (call, i) {
            expect(call.record).toBe(ctx.allTemplates[i]);
        });
        expect(world.realm.warnings).toEqual([]);

        observe("P2c-production", "the pre-fix inline rule, proved against the real refreshCardThumbnail", {
            rowsDriven: PREFIX_URL_ROWS.length,
            catalogPatchCalls: world.realm.catalog.patch.length,
            samples: detail,
        });

        // P2c's buildBustedThumbUrl byte-identity is the next test in this
        // describe (was [DEFERRED -> task 6.5]). This test proves the reproduced
        // rule against PRODUCTION; that one proves the shipped helper against
        // the reproduced rule's frozen output.
    }, 60000);

    // ────────────────────────────────────────────────────────────────────────
    // P2c's deferred half, landed by task 6.5. This is the E3 INVERSE that makes
    // design decision D1 enforceable rather than merely documented: E3 records
    // that the write side withholds `thumbnail` from the index, the test above
    // records that the persisted entry therefore never acquires one, and this
    // test records that the read-side helper reproduces the deleted write-side
    // expression exactly.
    //
    // Byte-identity is the whole licence for task 6.1's refactor. The inline
    // construction it replaced is GONE from js/templates/templates.js, so there
    // is no live expression left to diff against — the frozen corpus is the only
    // remaining record of what the rule used to emit. A red row here is a real
    // defect in buildBustedThumbUrl, never a stale fixture: the test above
    // re-derives every row's `url` from the reproduced rule and drives the real
    // refreshCardThumbnail through the same corpus, so a corrupted fixture is
    // caught there first.
    // ────────────────────────────────────────────────────────────────────────
    test("buildBustedThumbUrl is byte-identical to the frozen pre-fix corpus, row for row", function () {
        // **Validates: Requirements 3.1**
        const realm = createPanelRealm({});
        const ctx = realm.context;
        if (typeof ctx.buildBustedThumbUrl !== "function") {
            throw new Error(
                "js/templates/templates.js does not expose buildBustedThumbUrl. Task 6.1 " +
                "adds it as a top-level declaration; P2c's byte-identity check reads it."
            );
        }

        // The corpus is 51 rows. Pinned, so a silently shortened fixture cannot
        // turn this into a weaker check that still reports green.
        expect(PREFIX_URL_ROWS.length).toBe(51);

        const diverged = [];
        PREFIX_URL_ROWS.forEach(function (row, i) {
            const got = ctx.buildBustedThumbUrl(row.raw, row.token);
            if (got !== row.url) {
                diverged.push({ rowIndex: i, raw: row.raw, token: row.token, frozen: row.url, got: got });
            }
        });

        // Report every diverging row at once, with its index, rather than
        // stopping at the first: a refactor defect in the shared rule usually
        // hits a whole character class, and the class is what identifies it.
        expect(diverged).toEqual([]);

        // ── The recorded deliberate divergences ─────────────────────────────
        // The design's buildBustedThumbUrl short-circuits an empty or absent raw
        // path to "", where the pre-fix inline construction emitted
        // "file:///?v=<token>". Assert the NEW behaviour, and assert that it
        // really does differ from the frozen inline output — otherwise this
        // fixture section would quietly stop describing a divergence at all.
        const divergences = PREFIX_URL_BASELINE.deliberateDivergences;
        expect(divergences.length).toBeGreaterThan(0);
        divergences.forEach(function (d) {
            expect(d.buildBustedThumbUrlExpected).toBe("");
            expect(d.buildBustedThumbUrlExpected).not.toBe(d.inlineUrl);
            expect(ctx.buildBustedThumbUrl(d.raw, d.token)).toBe(d.buildBustedThumbUrlExpected);
        });

        observe("P2c-byte-identity", "buildBustedThumbUrl against the frozen pre-fix corpus", {
            rows: PREFIX_URL_ROWS.length,
            divergingRows: diverged.length,
            deliberateDivergences: divergences.map(function (d) {
                return { raw: d.raw, inlineUrl: d.inlineUrl, now: ctx.buildBustedThumbUrl(d.raw, d.token) };
            }),
        });
    });

    test("the persisted entry gets thumbStatus + thumbnailPath and NO thumbnail (D1 enforced)", function () {
        // **Validates: Requirements 3.1**
        const world = corpusRealm();
        const ctx = world.realm.context;

        const sampled = [];
        PREFIX_URL_ROWS.forEach(function (row, i) {
            const folder = ROOT + "/icon/Corpus/row-" + i;
            ctx.refreshCardThumbnail(folder, row.raw);

            const persisted = world.li.getEntry(folder);
            expect(persisted).not.toBeNull();
            expect(persisted.thumbStatus).toBe("ready");
            expect(persisted.thumbnailPath).toBe(row.raw.replace(/\\/g, "/"));
            // Deliberate: D1 declined to widen the write side, so the persisted
            // entry never acquires a `thumbnail`. E3 is the pre-fix diagnostic
            // that proves it; this is the post-fix enforcement of the decision.
            expect(Object.prototype.hasOwnProperty.call(persisted, "thumbnail")).toBe(false);
            // patchEntry pins folderPath to the key, so a patch cannot move it.
            expect(persisted.folderPath).toBe(folder);

            if (i < 3) sampled.push({ folder: folder, keys: Object.keys(persisted) });
        });

        expect(world.li.needsFullScan()).toBe(false);
        expect(world.li.lastError()).toBeNull();

        observe("P2c-persisted", "the persisted entry after a thumbnail completion", {
            samples: sampled,
            needsFullScan: world.li.needsFullScan(),
        });
    }, 60000);

    test("two completions for the same card emit two different tokens", function () {
        // **Validates: Requirements 3.1**
        const world = corpusRealm();
        const ctx = world.realm.context;
        const folder = ROOT + "/icon/Corpus/row-0";
        const raw = folder + "/thumbnail.png";

        ctx.refreshCardThumbnail(folder, raw);
        const first = ctx.allTemplates[0].thumbnail;
        ctx.refreshCardThumbnail(folder, raw);
        const second = ctx.allTemplates[0].thumbnail;

        const bodyPrefix = preFixInlineBustedUrl(raw, "");
        expect(first.indexOf(bodyPrefix)).toBe(0);
        expect(second.indexOf(bodyPrefix)).toBe(0);
        expect(second).not.toBe(first);

        observe("P2c-tokens", "consecutive completions for one card", { first: first, second: second });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// P3 -> Property 6 (clause 3.6)
// A clean category is unmoved by the cleanName fold, so no existing library
// folder on disk is re-keyed or orphaned.
//
// The host realm from tests/helpers/compPipelineHarness.js is the second half
// of the obligation: clause 3.6 says the folder path is byte-identical "on both
// sides", so the panel segment is compared against the host's own
// getSafeName(cleanStr(cat)) as well as against the panel's raw getSafeName.
//
// ONE CORRECTION TO THE DESIGN, found by task 1 and honoured by the generator
// below. The design's isBug3 lists leading/trailing whitespace as a divergence
// trigger. It is NOT one on its own: sanitizeNameStrict trims before it does
// anything else, so " My Cat " already yields "My Cat" on both sides today. The
// real triggers are a TAB, a CR/LF, and a run of two or more spaces. The clean
// generator therefore excludes interior whitespace other than single spaces,
// and a separate case asserts that padding a clean category with leading and
// trailing spaces still preserves the equality.
// ════════════════════════════════════════════════════════════════════════════
const H = require("./helpers/compPipelineHarness.js");
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

// ─── The panel's safeCategorySegment, read out of a realm ───────────────────
//
// safeCategorySegment is a hoisted top-level declaration in
// js/templates/templates.js, so it is reachable straight off the realm context.
// ONE realm is built and MEMOIZED: the helper is pure, and standing a fresh
// realm up per generated run would cost 3000 evaluations of templates.js to
// observe a string function.
//
// createPanelRealm injects the real `cleanName`, and that is what makes this the
// REAL fold rather than the helper's own `typeof cleanName === "function"`
// fallback. Both guards below are load-bearing: without cleanName the helper
// degrades silently to getSafeName, and every whitespace-bearing category in F3
// would then be measured against the pre-fix rule while still reporting green.
let SAFE_SEG_REALM = null;
function safeSegRealm() {
    if (SAFE_SEG_REALM === null) {
        const realm = createPanelRealm({});
        if (typeof realm.context.safeCategorySegment !== "function") {
            throw new Error(
                "js/templates/templates.js does not expose safeCategorySegment. Task 3.3 " +
                "adds it as a top-level declaration; P3's fixed form and F3 both read it."
            );
        }
        if (typeof realm.context.cleanName !== "function") {
            throw new Error(
                "the panel realm did not inject cleanName, so safeCategorySegment would " +
                "take its typeof fallback and measure the PRE-fix rule."
            );
        }
        SAFE_SEG_REALM = realm;
    }
    return SAFE_SEG_REALM;
}

/** The panel's one category-segment rule, as production computes it. */
function panelCategorySegment(cat) {
    return safeSegRealm().context.safeCategorySegment(cat);
}

// Non-whitespace characters only, so a generated word can never introduce a TAB,
// a CR/LF, a vertical tab, a form feed, an NBSP or any other \s member. Reserved
// separators, C0 controls, DEL and non-BMP are all in, because the sanitizers
// treat them and the fold must still be a no-op across them.
const CLEAN_WORD_CHARS = ("abcdefghijklmnopqrstuvwxyz" +
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_." +
    "\\/:*?\"<>|" + "#%&+=@$~!()[]{}^`',;").split("").concat([
        "\u0000", "\u0001", "\u0008", "\u000e", "\u001f", "\u007f",
        "\u00e9", "\u65e5", "\ud83d\ude00",
    ]);

const CLEAN_NAMED_CATEGORIES = [
    "", "x", "Titles", "Logos", "Uncategorized", "Lower-Thirds", "My Cat",
    "interior.dots.are.fine", "a-b_c-1",
    ".", "..", "...", "cat.", "CON", "con", "prn", "AUX", "nul", "com1",
    "LPT9.txt", "console", "connect",
    new Array(255 + 1).join("A"), new Array(300 + 1).join("C"),
];

const cleanWordArb = fc
    .array(fc.integer({ min: 0, max: CLEAN_WORD_CHARS.length - 1 }), { minLength: 1, maxLength: 12 })
    .map(function (idx) {
        return idx.map(function (i) { return CLEAN_WORD_CHARS[i]; }).join("");
    });

const cleanCategoryArb = fc.oneof(
    {
        weight: 5,
        arbitrary: fc.array(cleanWordArb, { minLength: 1, maxLength: 5 })
            .map(function (words) { return words.join(" "); }),
    },
    { weight: 1, arbitrary: fc.constantFrom.apply(fc, CLEAN_NAMED_CATEGORIES) }
);

/** No TAB, no CR/LF, no other non-space whitespace, no run of 2+ spaces, no padding. */
function isCleanCategory(cat) {
    if (typeof cat !== "string") return false;
    if (/[^\S ]/.test(cat)) return false;
    if (/ {2,}/.test(cat)) return false;
    if (/^ | $/.test(cat)) return false;
    return true;
}

describe("P3 — a clean category is byte-identical with and without the cleanName fold", function () {
    test("3000 generated clean categories: getSafeName(cleanName(cat)) === getSafeName(cat)", function () {
        // **Validates: Requirements 3.6**
        let checked = 0;
        fc.assert(
            fc.property(cleanCategoryArb, function (cat) {
                fc.pre(isCleanCategory(cat));
                checked++;

                const folded = pathBuilders.getSafeName(pathBuilders.cleanName(cat));
                const raw = pathBuilders.getSafeName(cat);
                const shipped = panelCategorySegment(cat);

                observe("P3", "the fold is a no-op for the first generated clean category", {
                    category: JSON.stringify(cat),
                    cleanName: JSON.stringify(pathBuilders.cleanName(cat)),
                    getSafeNameOfFolded: JSON.stringify(folded),
                    getSafeNameOfRaw: JSON.stringify(raw),
                    safeCategorySegment: JSON.stringify(shipped),
                    hostSegment: JSON.stringify(hostGetSafeName(hostCleanStr(cat))),
                });

                // The panel's pre-fix rule and the panel's post-fix rule agree.
                expect(folded).toBe(raw);
                // Clause 3.6's "on both sides": the host already writes the same
                // segment for this input class, which is what makes the fix a
                // pure no-op on disk rather than a re-keying.
                expect(raw).toBe(hostGetSafeName(hostCleanStr(cat)));
                // Clause 3.6 against the SHIPPED helper rather than against a
                // re-implementation of it (was [DEFERRED -> task 3.5]). This is
                // the no-op-on-clean-input guarantee: byte-identical to the
                // pre-fix getSafeName(cat), so no existing library folder on
                // disk is re-keyed or orphaned by BUG 3's fix.
                expect(shipped).toBe(raw);
            }),
            { numRuns: 3000, seed: 20260904 }
        );
        expect(checked).toBeGreaterThan(2000);
    }, 120000);

    test("padding a clean category with leading/trailing spaces preserves the equality", function () {
        // **Validates: Requirements 3.6**
        //
        // The task-1 correction, executable: leading/trailing whitespace is NOT
        // a divergence trigger, because both cleanName and sanitizeNameStrict
        // trim. If the design's isBug3 wording were taken literally this case
        // would have to fail; it does not, on unfixed source or fixed.
        fc.assert(
            fc.property(cleanCategoryArb, fc.constantFrom(" ", "  ", "   "), function (cat, pad) {
                fc.pre(isCleanCategory(cat));
                const padded = pad + cat + pad;

                expect(pathBuilders.cleanName(padded)).toBe(cat);
                expect(pathBuilders.getSafeName(pathBuilders.cleanName(padded)))
                    .toBe(pathBuilders.getSafeName(padded));
                expect(pathBuilders.getSafeName(padded)).toBe(pathBuilders.getSafeName(cat));
                expect(pathBuilders.getSafeName(padded))
                    .toBe(hostGetSafeName(hostCleanStr(padded)));
            }),
            { numRuns: 1500, seed: 20260905 }
        );
    }, 60000);

    test("the divergence boundary: TAB, CR/LF and 2+ space runs move; padding does not", function () {
        // **Validates: Requirements 3.6**
        //
        // The exact edge of P3's guarantee, recorded so a reviewer can see which
        // inputs BUG 3's fix is allowed to move and which it must not. Every row
        // below is an OBSERVATION of the unfixed sanitizers, not a wish.
        const MOVES = ["My\tCat", "My  Cat", "My\r\nCat", "My\n \tCat", "a\u00a0b"];
        const HOLDS = [" My Cat ", "My Cat", "   Padded Cat   ", "  ", "\u00a0"];

        const rows = [];
        MOVES.forEach(function (cat) {
            const folded = pathBuilders.getSafeName(pathBuilders.cleanName(cat));
            const raw = pathBuilders.getSafeName(cat);
            const shipped = panelCategorySegment(cat);
            rows.push({
                category: JSON.stringify(cat), folded: folded, raw: raw,
                shipped: shipped, moves: folded !== raw,
            });
            expect(folded).not.toBe(raw);
            // ...and the folded form is the one the host already writes.
            expect(folded).toBe(hostGetSafeName(hostCleanStr(cat)));
            // The shipped helper lands on the FOLDED side of the boundary, not
            // the raw side (was [DEFERRED -> task 3.5]). These five inputs are
            // precisely the ones BUG 3's fix is ALLOWED to move, and this is
            // where it is required to move them.
            expect(shipped).toBe(folded);
            expect(shipped).toBe(hostCategorySegment(cat));
            expect(shipped).not.toBe(raw);
        });
        HOLDS.forEach(function (cat) {
            const folded = pathBuilders.getSafeName(pathBuilders.cleanName(cat));
            const raw = pathBuilders.getSafeName(cat);
            const shipped = panelCategorySegment(cat);
            rows.push({
                category: JSON.stringify(cat), folded: folded, raw: raw,
                shipped: shipped, moves: folded !== raw,
            });
            expect(folded).toBe(raw);
            // The other side of the boundary: the helper must NOT move these.
            expect(shipped).toBe(raw);
        });

        observe("P3-boundary", "which category inputs the fold moves, and which it leaves alone", { rows: rows });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// F3 -> Property 5 (clauses 2.5, 2.6) — BUG 3's FIX CHECK
//
// P3 above is the preservation half: the fold must not move a clean category.
// F3 is the fix half: for EVERY category, including the hostile ones, the
// panel's derived segment must equal the segment the host actually creates.
//
// Three parts, in widening scope:
//
//   1. the unit table, written observation-first — every row below was RUN
//      before it was asserted, and the surprises are recorded next to it;
//   2. 2000 generated categories over a deliberately hostile alphabet, against
//      the real host realm as the oracle;
//   3. the integration form of exploration case E7, re-driven on fixed code:
//      the real confirmSave PNG flow, asserting the optimistic card's folder
//      and refreshCardThumbnail's folder are equal TO EACH OTHER and to the
//      host-derived path. E7 exists because one call site is not enough.
//
// The oracle is the REAL ExtendScript host realm (compPipelineHarness), the same
// mechanism tests/sanitizer-cross-implementation.property.test.js uses. Neither
// sanitizer is re-implemented here.
//
// **Validates: Requirements 2.5, 2.6**
// ════════════════════════════════════════════════════════════════════════════
describe("F3 — the panel's category segment equals the host's for every category", function () {
    // ── Part 1: the unit table ──────────────────────────────────────────────
    //
    // The `segment` column is what safeCategorySegment ACTUALLY returned when
    // this table was first run, recorded before any assertion was written. The
    // `raw` column is the pre-fix rule, kept alongside so a reader can see which
    // rows the fix moves. Two results were surprising enough to write down:
    //
    //   * null and undefined both come out as "" — and so did they PRE-fix, but
    //     by a different internal route. Pre-fix, getSafeName(null) hits
    //     sanitizeNameStrict's null guard, which returns { ok:false, value:"" }.
    //     Post-fix, cleanName absorbs the null first (it returns "" for both
    //     null and undefined) and sanitizeNameStrict hits its EMPTY-STRING guard
    //     instead, which also returns { ok:false, value:"" }. Two different
    //     branches, same byte output, so the fix is invisible on these inputs —
    //     and the host agrees, because cleanStr has the identical null guard.
    //     Neither side ever produces the "_untitled" fallback for a nullish
    //     category, which is what preserves the shape of existing empty-category
    //     folder paths.
    //
    //   * a reserved device stem comes out PREFIXED — "CON" -> "_CON" — and that
    //     is the pre-fix behaviour too, because getSafeName already escapes
    //     device names. The fold changes nothing for a bare stem. It DOES change
    //     things for a stem carrying interior whitespace: "C\tON" folds to "CON"
    //     and is then escaped to "_CON", where the pre-fix rule saw "C_ON" and
    //     never recognised a device name at all. That row is in the table.
    const UNIT_ROWS = [
        { label: 'TAB inside a word', cat: "a\tb", segment: "ab", raw: "a_b" },
        { label: 'space runs plus padding', cat: "  a  b  ", segment: "a b", raw: "a  b" },
        { label: 'CRLF inside a word', cat: "a\r\nb", segment: "ab", raw: "a__b" },
        { label: 'LF + space + TAB', cat: "a\n \tb", segment: "a b", raw: "a_ _b" },
        { label: 'null', cat: null, segment: "", raw: "" },
        { label: 'undefined', cat: undefined, segment: "", raw: "" },
        { label: 'empty string', cat: "", segment: "", raw: "" },
        { label: 'reserved device stem', cat: "CON", segment: "_CON", raw: "_CON" },
        { label: 'device stem split by a TAB', cat: "C\tON", segment: "_CON", raw: "C_ON" },
        { label: 'trailing dot', cat: "cat.", segment: "cat", raw: "cat" },
    ];

    test("the unit table: safeCategorySegment returns the observed value, and the host agrees", function () {
        // **Validates: Requirements 2.5**
        const rows = UNIT_ROWS.map(function (row) {
            const shipped = panelCategorySegment(row.cat);
            return {
                label: row.label,
                category: row.cat === null ? "null" : row.cat === undefined ? "undefined" : JSON.stringify(row.cat),
                cleanName: JSON.stringify(pathBuilders.cleanName(row.cat)),
                segment: JSON.stringify(shipped),
                expectedSegment: JSON.stringify(row.segment),
                preFixRaw: JSON.stringify(pathBuilders.getSafeName(row.cat)),
                hostSegment: JSON.stringify(hostCategorySegment(row.cat)),
                fixMovesIt: shipped !== pathBuilders.getSafeName(row.cat),
            };
        });

        observe("F3-units", "safeCategorySegment, one row per unit case, as observed", { rows: rows });

        UNIT_ROWS.forEach(function (row) {
            const shipped = panelCategorySegment(row.cat);
            // The recorded observation.
            expect(shipped).toBe(row.segment);
            // The pre-fix rule, also recorded, so the table shows the delta.
            expect(pathBuilders.getSafeName(row.cat)).toBe(row.raw);
            // Property 5: the host writes the same segment.
            expect(shipped).toBe(hostCategorySegment(row.cat));
        });

        // Nullish and empty categories collapse to "" on BOTH sides — never to
        // the "_untitled" fallback — so an existing empty-category path shape is
        // unchanged. Asserted deliberately, because it is the one place where a
        // divergence would be silent.
        [null, undefined, ""].forEach(function (cat) {
            expect(panelCategorySegment(cat)).toBe("");
            expect(hostCategorySegment(cat)).toBe("");
            expect(pathBuilders.getSafeName(cat)).toBe("");
        });

        // The table is not vacuous: some rows must actually move.
        const moved = rows.filter(function (r) { return r.fixMovesIt; });
        expect(moved.length).toBeGreaterThanOrEqual(5);
    });

    // ── Part 2: the hostile generator ───────────────────────────────────────
    //
    // Atoms rather than characters, so a generated category can carry a CRLF
    // pair, a run of two/three/four spaces, or a whole reserved device stem as
    // one unit — none of which a per-character alphabet reliably produces. The
    // reserved separator class, the C0 controls, DEL, NBSP, VT, FF and non-BMP
    // are all in: the sanitizers treat every one of them, so leaving any out
    // would narrow the property to the inputs it is easiest to satisfy.
    const DEVICE_STEMS = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    const HOSTILE_ATOMS = [
        // Whitespace: the divergence triggers themselves.
        "\t", "\r", "\n", "\r\n", " ", "  ", "   ", "    ",
        "\u000b", "\u000c", "\u00a0",
        // The reserved separator class getSafeName maps to "_".
        "\\", "/", ":", "*", "?", "\"", "<", ">", "|",
        // C0 controls and DEL.
        "\u0000", "\u001f", "\u007f",
        // Ordinary and non-ASCII payload.
        "a", "Z", "9", "-", "_", ".", "..", "...",
        "Titles", "My", "Cat", "caf\u00e9", "\u65e5\u672c\u8a9e", "\ud83d\ude00",
    ].concat(DEVICE_STEMS, ["con", "prn", "aux", "nul", "com1", "lpt9", "Com5", "LpT3"]);

    const hostileCategoryArb = fc.oneof(
        {
            weight: 6,
            arbitrary: fc
                .array(fc.integer({ min: 0, max: HOSTILE_ATOMS.length - 1 }), { minLength: 1, maxLength: 8 })
                .map(function (idx) {
                    return idx.map(function (i) { return HOSTILE_ATOMS[i]; }).join("");
                }),
        },
        {
            // A device stem as the WHOLE segment, optionally padded, split by a
            // whitespace atom and/or carrying an extension. This is the only
            // shape that reaches getSafeName's reserved-device branch, and the
            // split form is where the fold changes whether that branch fires
            // at all.
            weight: 2,
            arbitrary: fc
                .tuple(
                    fc.constantFrom.apply(fc, DEVICE_STEMS),
                    fc.constantFrom("", " ", "  ", "\t", "\r\n"),
                    fc.constantFrom("", ".txt", ".", "..", ".aep"),
                    fc.constantFrom("", "\t", " ", "  ", "\n"),
                    fc.integer({ min: 0, max: 3 })
                )
                .map(function (t) {
                    const stem = t[0];
                    const pad = t[1];
                    const ext = t[2];
                    const splitter = t[3];
                    const at = t[4] % (stem.length + 1);
                    const split = stem.slice(0, at) + splitter + stem.slice(at);
                    return pad + split + ext + pad;
                }),
        },
        {
            // The truncate-then-restrip band around PATH_BUILDER_MAX_NAME_LENGTH,
            // where a fold that shortened the input changes WHICH characters
            // survive truncation.
            weight: 1,
            arbitrary: fc
                .tuple(
                    fc.constantFrom("A", "A ", "A.", "a\tb", "a  b", " "),
                    fc.integer({ min: 60, max: 160 })
                )
                .map(function (t) { return new Array(t[1] + 1).join(t[0]); }),
        }
    );

    test("2000 hostile categories: safeCategorySegment(cat) === host getSafeName(cleanStr(cat))", function () {
        // **Validates: Requirements 2.5, 2.6**
        let checked = 0;
        let moved = 0;
        let firstMove = null;
        fc.assert(
            fc.property(hostileCategoryArb, function (cat) {
                checked++;
                const shipped = panelCategorySegment(cat);
                const host = hostCategorySegment(cat);
                const raw = pathBuilders.getSafeName(cat);
                if (shipped !== raw) {
                    moved++;
                    if (firstMove === null) {
                        firstMove = {
                            category: JSON.stringify(cat),
                            preFix: JSON.stringify(raw),
                            postFix: JSON.stringify(shipped),
                            host: JSON.stringify(host),
                        };
                    }
                }
                // Property 5. A counterexample here is a real panel/host parity
                // finding, not a reason to narrow the alphabet above.
                expect(shipped).toBe(host);
            }),
            { numRuns: 2000, seed: 20260906 }
        );

        observe("F3", "generated parity run, with the first category the fix moves", {
            checked: checked,
            categoriesTheFixMoves: moved,
            firstMove: firstMove,
        });

        expect(checked).toBe(2000);
        // The property would be trivially satisfiable by an alphabet that never
        // triggers the fold, so require that a substantial slice of the corpus
        // actually diverged from the pre-fix rule.
        expect(moved).toBeGreaterThan(200);
    }, 120000);

    // ── Part 3: E7's integration form, on fixed code ────────────────────────
    describe("both PNG derivation sites now address the host-written folder", function () {
        // The real save controller drives the real confirmSave PNG flow.
        // eslint-disable-next-line global-require
        const { runSaveController } = require("../js/core/saveController.js");

        beforeEach(function () { jest.useFakeTimers(); });
        afterEach(function () { jest.clearAllTimers(); jest.useRealTimers(); });

        /** Minimal element fake: input reads, button state, classList toggles. */
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
         * The same harness shape exploration case E7 uses: validateSaveRequest ->
         * itemExists -> savePNGOnly, then the deferred optimistic card and the
         * thumbnail refresh. Only renderOptimisticCard and refreshCardThumbnail
         * are replaced, with recorders, so the two derived folder paths become
         * observable; everything upstream of them is production code.
         */
        function pngHarness(category, section) {
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
                currentSection: section,
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

                // Real panel sanitizers, cleanName included, so the fix is
                // exercised rather than bypassed by its own typeof guard.
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

        // E7 drove "My  Cat" through the icon section. The categories below are
        // E6's four inputs plus the two device-stem shapes, and `overlay` is
        // included once because both derivation sites map the target image
        // section through the same overlay/icon fold — the same two sites, a
        // second path into them.
        const INTEGRATION_CASES = [
            { category: "My  Cat", section: SECTIONS.ICON, folder: "icon" },
            { category: "My\tCat", section: SECTIONS.ICON, folder: "icon" },
            { category: " My Cat ", section: SECTIONS.ICON, folder: "icon" },
            { category: "My\r\nCat", section: SECTIONS.ICON, folder: "icon" },
            { category: "C\tON", section: SECTIONS.ICON, folder: "icon" },
            { category: "My  Cat", section: SECTIONS.OVERLAY, folder: "overlay" },
        ];

        INTEGRATION_CASES.forEach(function (kase) {
            const title = "category " + JSON.stringify(kase.category) +
                " in " + kase.folder + ": optimistic card === thumbnail refresh === host folder";

            test(title, async function () {
                // **Validates: Requirements 2.5, 2.6**
                const h = pngHarness(kase.category, kase.section);

                h.confirmSave();
                await jest.runAllTimersAsync();

                const hostFolder = "/lib/" + kase.folder + "/" +
                    hostCategorySegment(kase.category) + "/" +
                    hostGenerateTemplateId("MyTemplate");

                observe("F3-integration", "the two derivation sites and the host folder, on fixed code", {
                    category: JSON.stringify(kase.category),
                    section: kase.section,
                    hostFolder: hostFolder,
                    optimisticCardFolderPath: h.optimisticCards.length ? h.optimisticCards[0].folderPath : "<none>",
                    refreshFolder: h.thumbRefreshes.length ? h.thumbRefreshes[0].folder : "<none>",
                });

                expect(h.saveCalls.length).toBe(1);
                expect(h.optimisticCards.length).toBe(1);
                expect(h.thumbRefreshes.length).toBe(1);

                // Site 1 — onEssentialSuccess's optFolder.
                expect(h.optimisticCards[0].folderPath).toBe(hostFolder);
                // Site 2 — scheduleBackground's pngFolder.
                expect(h.thumbRefreshes[0].folder).toBe(hostFolder);
                // The two sites agree with EACH OTHER. E7 exists because
                // correcting one of them is not enough, and this is the
                // assertion that stays red if only one is switched.
                expect(h.thumbRefreshes[0].folder).toBe(h.optimisticCards[0].folderPath);
                // The refresh addresses the thumbnail inside that same folder.
                expect(h.thumbRefreshes[0].thumb).toBe(hostFolder + "/thumbnail.png");
                // And the optimistic card's raw thumbnail path is the same
                // folder's thumbnail.png, per clause 3.2's raw-path invariant.
                expect(h.optimisticCards[0].thumbnailPath).toBe(hostFolder + "/thumbnail.png");
            });
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// P4 -> Property 6 (clause 3.7) — WITNESS POINTER, nothing is modified.
//
// The PNG save's single monolithic 5-argument host call and its "true"/"ERROR:"
// return contract are already pinned by tests/save-return-shape.test.js. This
// case does not restate those assertions; it records WHERE they live and fails
// if the witness moves or is weakened, which is what makes "already covered" an
// enforceable claim rather than a note in a document.
//
// Task 3.1 adds ONE line to that file's injected-globals object
// (cleanName: pathBuilders.cleanName) and rewrites NO assertion, so both
// witnesses below must read identically before and after — one line lower,
// which is exactly why they are located by content and not by line number.
// ════════════════════════════════════════════════════════════════════════════
describe("P4 — the existing 5-argument savePNGOnly witnesses are where the design says", function () {
    const SAVE_RETURN_SHAPE = "tests/save-return-shape.test.js";
    const SAVE_PATH_BUILDERS = "tests/save-path-builders.test.js";

    test("save-return-shape.test.js still pins the monolithic host call at both image sections", function () {
        // **Validates: Requirements 3.7**
        //
        // The anchor IS the 5-argument call string, so the lookup itself fails
        // if either witness loses its exact form. Its discovered line number is
        // reported for the reader, never asserted.
        const iconCall = findWitnessLine(
            SAVE_RETURN_SHAPE,
            'savePNGOnly("MyTemplate","TestCat","/lib","icon","")'
        );
        const overlayCall = findWitnessLine(
            SAVE_RETURN_SHAPE,
            'savePNGOnly("MyTemplate","TestCat","/lib","overlay","")'
        );

        observe("P4", "the named regression witnesses for the PNG host call", {
            witnesses: [
                SAVE_RETURN_SHAPE + ":" + iconCall.line,
                SAVE_RETURN_SHAPE + ":" + overlayCall.line,
            ],
            iconCall: iconCall.text.trim(),
            overlayCall: overlayCall.text.trim(),
        });

        expect(iconCall.text).toContain('savePNGOnly("MyTemplate","TestCat","/lib","icon","")');
        expect(overlayCall.text).toContain('savePNGOnly("MyTemplate","TestCat","/lib","overlay","")');
        // Both are equality assertions on the WHOLE call string, which is what
        // makes them a 5-argument-form witness rather than a substring probe.
        expect(iconCall.text).toContain("expect(h.saveEvalCalls[0]).toBe(");
        expect(overlayCall.text).toContain("expect(h.saveEvalCalls[0]).toBe(");
    });

    test("save-path-builders.test.js still pins cleanName idempotence", function () {
        // **Validates: Requirements 3.6, 3.7**
        //
        // The other half of "already covered" in the design's property map:
        // cleanName being idempotent is what lets task 3.3 fold it in without
        // changing an already-folded segment.
        //
        // The block is delimited by its own test declaration and its own closing
        // `});`, so it tracks the witness's body instead of a fixed 8-line span.
        const block = findWitnessBlock(
            SAVE_PATH_BUILDERS,
            'test("idempotent, so folding it into generateTemplateId',
            "});"
        );

        observe("P4-idempotence", "the named cleanName idempotence witness", {
            witness: SAVE_PATH_BUILDERS + ":" + block.startLine + "-" + block.endLine,
            block: block.text,
        });

        expect(block.lines[0]).toContain("idempotent");
        expect(block.text).toContain("cleanName(once)");
        expect(block.text).toContain("fc.assert");
    });
});

// ─── Shared record factory for the catalog-freshness cases ──────────────────
const FRESH_CATS = ["Logos", "Brands", "Titles", "Uncategorized"];

function freshRecord(n, section, root) {
    const cat = FRESH_CATS[n % FRESH_CATS.length];
    return {
        id: "t" + n,
        name: "Lower Third " + n,
        category: cat,
        section: section,
        type: section,
        dim: "1920x1080",
        favorite: n % 3 === 0,
        folderPath: root + "/" + section + "/" + cat + "/T" + n,
        sourcePath: root,
        thumbnail: "",
        thumbnailPath: root + "/" + section + "/" + cat + "/T" + n + "/thumbnail.png",
        thumbStatus: "placeholder",
    };
}

function freshLibrary(size, section, root) {
    const out = [];
    for (let i = 0; i < size; i++) out.push(freshRecord(i, section, root));
    return out;
}

// ════════════════════════════════════════════════════════════════════════════
// P5 -> Property 9 (clause 3.10) — THE BINDING TEST.
//
// A sequence of renders with no intervening mutation rebuilds the catalog
// exactly once. This is what catches an over-broad markTemplatesDirty call-site
// set in task 5: every additional call site that fires on a pure render path
// turns ensureCatalogFresh into an unconditional O(N) rebuild, and this case is
// the thing that notices. Generated over K and over library size rather than
// written as one example, for exactly that reason.
// ════════════════════════════════════════════════════════════════════════════
describe("P5 — K renders with no mutation invoke TemplateCatalog.build exactly once", function () {
    const ROOT = "C:/lib";

    const p5Arb = fc.record({
        size: fc.integer({ min: 1, max: 40 }),
        k: fc.integer({ min: 2, max: 8 }),
        sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
        category: fc.constantFrom("All", "Favorites", "Logos", "Brands", "Uncategorized"),
        search: fc.constantFrom("", "lower", "zzz-no-match"),
    });

    test("build fires once across K mixed filterAndRender / renderWindowedIds calls", function () {
        // **Validates: Requirements 3.10**
        fc.assert(
            fc.property(p5Arb, function (spec) {
                const section = SECTION_VALUES[spec.sectionIdx];
                const records = freshLibrary(spec.size, section, ROOT);
                const realm = createPanelRealm({
                    allTemplates: records,
                    currentSection: section,
                    currentCategory: spec.category,
                    search: spec.search,
                    libraryPaths: [ROOT],
                    rootPath: ROOT,
                });
                const ctx = realm.context;

                // Nothing is built yet, so the FIRST render is the one build the
                // whole sequence is allowed.
                expect(realm.catalog.build).toBe(0);
                const revisionBefore = ctx._templatesRevision;

                const perRender = [];
                for (let i = 0; i < spec.k; i++) {
                    if (i % 2 === 0) {
                        ctx.filterAndRender();
                    } else {
                        const ids = ctx.TemplateCatalog.idsFor(
                            section, spec.category, spec.search.toLowerCase()
                        );
                        ctx.renderWindowedIds(ids, {
                            section: section,
                            listKey: section + "|" + spec.category + "|" + spec.search,
                            restoreScroll: true,
                        });
                    }
                    perRender.push({
                        render: i + 1,
                        buildCalls: realm.catalog.build,
                        sourceChanged: ctx.catalogSourceChanged(),
                    });
                }

                observe("P5", "K renders with no intervening mutation", {
                    librarySize: spec.size,
                    renders: spec.k,
                    section: section,
                    category: spec.category,
                    search: JSON.stringify(spec.search),
                    perRender: perRender,
                    revisionBefore: revisionBefore,
                    revisionAfter: ctx._templatesRevision,
                });

                // The binding assertion.
                expect(realm.catalog.build).toBe(1);
                // ...and nothing marked the model dirty behind the renders' back.
                expect(ctx._templatesRevision).toBe(revisionBefore);
                expect(ctx.catalogSourceChanged()).toBe(false);
                expect(ctx.TemplateCatalog.sourceStamp()).toBe(ctx._templatesRevision);
                expect(realm.warnings).toEqual([]);

                // DISCRIMINATING POWER: "exactly once" must mean "the counter
                // held", not "build never fires here". One explicit dirty mark
                // makes the very next render rebuild, so a real extra call site
                // in task 5 would be counted rather than absorbed.
                ctx.markTemplatesDirty();
                expect(ctx.catalogSourceChanged()).toBe(true);
                ctx.filterAndRender();
                expect(realm.catalog.build).toBe(2);
                expect(ctx.catalogSourceChanged()).toBe(false);

                return true;
            }),
            { numRuns: 30, seed: 20260906 }
        );
    }, 180000);

    test("the surfaces that read the catalog on a render path add no rebuild either", function () {
        // **Validates: Requirements 3.10**
        //
        // buildCategoryTabs, buildCategoryPanel, updateCategoryCountsOnly and
        // getSectionTemplates all consult the catalog. Observed on unfixed
        // source: only the first of them builds, and the DOM-less early returns
        // are reached without a throw.
        const section = SECTIONS.COMP;
        const records = freshLibrary(12, section, ROOT);
        const realm = createPanelRealm({
            allTemplates: records,
            currentSection: section,
            currentCategory: "All",
            libraryPaths: [ROOT],
            rootPath: ROOT,
        });
        const ctx = realm.context;

        ctx.buildCategoryTabs();
        expect(realm.catalog.build).toBe(1);
        ctx.buildCategoryPanel();
        ctx.updateCategoryCountsOnly();
        ctx.getSectionTemplates();
        ctx.filterAndRender();
        ctx.filterAndRender();

        observe("P5-surfaces", "category surfaces + two renders after one build", {
            buildCalls: realm.catalog.build,
            sourceChanged: ctx.catalogSourceChanged(),
            revision: ctx._templatesRevision,
        });

        expect(realm.catalog.build).toBe(1);
        expect(ctx.catalogSourceChanged()).toBe(false);
        expect(realm.warnings).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// P6 -> Property 9 (clause 3.10) — the refreshCardThumbnail EXCLUSION WITNESS.
//
// Design decision D3 deliberately leaves refreshCardThumbnail OUT of BUG 5's
// seven call sites: its hand-written TemplateCatalog.patch is already complete,
// and marking dirty there would force one O(N) rebuild per completed thumbnail,
// i.e. O(N^2) across an N-item import batch — precisely what clause 3.10 exists
// to prevent.
//
// This case is the executable form of that decision. If a later change adds
// markTemplatesDirty() to refreshCardThumbnail, catalogSourceChanged() starts
// returning true and this test fails. That is its whole purpose.
// ════════════════════════════════════════════════════════════════════════════
describe("P6 — M thumbnail completions never advance the revision counter", function () {
    const ROOT = "C:/lib";

    test("catalogSourceChanged() stays false and build is not called again", function () {
        // **Validates: Requirements 3.1, 3.10**
        fc.assert(
            fc.property(
                fc.record({
                    m: fc.integer({ min: 1, max: 8 }),
                    extra: fc.integer({ min: 0, max: 6 }),
                    sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
                }),
                function (spec) {
                    const section = SECTION_VALUES[spec.sectionIdx];
                    const size = spec.m + spec.extra;
                    const entries = freshLibrary(size, section, ROOT);
                    const li = persistIndex(entries);
                    // Independent model records, the real save-session shape.
                    const model = li._entries.map(shallowClone);
                    const realm = createPanelRealm({
                        libraryIndex: li,
                        allTemplates: model,
                        currentSection: section,
                        currentCategory: "All",
                        libraryPaths: [ROOT],
                        rootPath: ROOT,
                    });
                    const ctx = realm.context;

                    ctx.ensureCatalogFresh();
                    expect(realm.catalog.build).toBe(1);
                    expect(ctx.catalogSourceChanged()).toBe(false);

                    const revisionBefore = ctx._templatesRevision;
                    const stampBefore = ctx.TemplateCatalog.sourceStamp();
                    const sizeBefore = ctx.TemplateCatalog.size();
                    realm.resetCatalogSpies();

                    const perCompletion = [];
                    for (let m = 0; m < spec.m; m++) {
                        const folder = model[m].folderPath;
                        ctx.refreshCardThumbnail(folder, folder + "/thumbnail.png");
                        perCompletion.push({
                            card: m,
                            buildCalls: realm.catalog.build,
                            catalogPatchCalls: realm.catalog.patch.length,
                            sourceChanged: ctx.catalogSourceChanged(),
                            revision: ctx._templatesRevision,
                        });
                        // Checked after EVERY completion, not just at the end: a
                        // single dirty mark anywhere in the loop is a failure.
                        expect(ctx.catalogSourceChanged()).toBe(false);
                    }

                    observe("P6", "M thumbnail completions after one build", {
                        librarySize: size,
                        completions: spec.m,
                        section: section,
                        perCompletion: perCompletion,
                    });

                    // The exclusion, stated three ways.
                    expect(realm.catalog.build).toBe(0);
                    expect(ctx._templatesRevision).toBe(revisionBefore);
                    expect(ctx.TemplateCatalog.sourceStamp()).toBe(stampBefore);
                    expect(ctx.catalogSourceChanged()).toBe(false);

                    // Clause 3.1: the hand mirror is still there, once per card,
                    // and it is what makes the exclusion safe.
                    expect(realm.catalog.patch.length).toBe(spec.m);
                    expect(ctx.TemplateCatalog.size()).toBe(sizeBefore);
                    for (let m = 0; m < spec.m; m++) {
                        expect(realm.catalog.patch[m].record).toBe(model[m]);
                        expect(typeof model[m].thumbnail).toBe("string");
                        expect(model[m].thumbnail.indexOf("file:///")).toBe(0);
                        expect(model[m].thumbnail.indexOf("?v=")).toBeGreaterThan(0);
                        expect(model[m].thumbStatus).toBe("ready");
                    }
                    expect(realm.warnings).toEqual([]);

                    // DISCRIMINATING POWER: the probe this exclusion witness
                    // rests on has to be capable of firing. One explicit dirty
                    // mark flips it, so "stayed false" above is evidence that
                    // refreshCardThumbnail did not mark — not that
                    // catalogSourceChanged is stuck.
                    ctx.markTemplatesDirty();
                    expect(ctx.catalogSourceChanged()).toBe(true);
                    ctx.ensureCatalogFresh();
                    expect(realm.catalog.build).toBe(1);
                    expect(ctx.catalogSourceChanged()).toBe(false);

                    return true;
                }
            ),
            { numRuns: 25, seed: 20260907 }
        );
    }, 180000);
});

// ════════════════════════════════════════════════════════════════════════════
// P7 -> Property 9 (clause 3.11)
// A wholesale rewrite performed OUTSIDE templates.js is still caught by the
// shape probes, with no counter involvement.
//
// The rewrite simulated here is MediaEntryRepository._publishDurable's: the
// shared mirror's array IDENTITY is held, `length = 0` clears it, and a shallow
// CLONE of every record is pushed back. Length returns to its original value
// and TemplateCatalog.size() never moves, so the ONLY probe that can fire is
// first/last element identity. Generated over library sizes including 1 and 2,
// where first and last coincide and the two probes collapse into one.
// ════════════════════════════════════════════════════════════════════════════
describe("P7 — a constant-length clone rewrite is detected without markTemplatesDirty", function () {
    const ROOT = "C:/lib";

    test("catalogSourceChanged() is true after the rewrite, counter untouched", function () {
        // **Validates: Requirements 3.11**
        const sizes = [];
        fc.assert(
            fc.property(
                fc.record({
                    size: fc.integer({ min: 1, max: 12 }),
                    sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
                }),
                function (spec) {
                    const section = SECTION_VALUES[spec.sectionIdx];
                    const realm = createPanelRealm({
                        allTemplates: freshLibrary(spec.size, section, ROOT),
                        currentSection: section,
                        currentCategory: "All",
                        libraryPaths: [ROOT],
                        rootPath: ROOT,
                    });
                    const ctx = realm.context;
                    sizes.push(spec.size);

                    ctx.ensureCatalogFresh();
                    expect(realm.catalog.build).toBe(1);
                    expect(ctx.catalogSourceChanged()).toBe(false);

                    const arr = ctx.allTemplates;
                    const lengthBefore = arr.length;
                    const firstBefore = arr[0];
                    const lastBefore = arr[lengthBefore - 1];
                    const revisionBefore = ctx._templatesRevision;
                    const catalogSizeBefore = ctx.TemplateCatalog.size();

                    // _publishDurable's rewrite: identity held, cleared, clones
                    // re-pushed. NO markTemplatesDirty call — that is the point.
                    const clones = arr.map(shallowClone);
                    arr.length = 0;
                    for (let i = 0; i < clones.length; i++) arr.push(clones[i]);

                    const changed = ctx.catalogSourceChanged();

                    observe("P7", "a constant-length clone rewrite of the shared mirror", {
                        librarySize: spec.size,
                        arrayIdentityHeld: ctx.allTemplates === arr,
                        lengthUnchanged: ctx.allTemplates.length === lengthBefore,
                        firstElementMoved: ctx.allTemplates[0] !== firstBefore,
                        lastElementMoved: ctx.allTemplates[ctx.allTemplates.length - 1] !== lastBefore,
                        catalogSizeUnchanged: ctx.TemplateCatalog.size() === catalogSizeBefore,
                        revisionUnchanged: ctx._templatesRevision === revisionBefore,
                        sourceStampStillMatchesRevision:
                            ctx.TemplateCatalog.sourceStamp() === ctx._templatesRevision,
                        catalogSourceChanged: changed,
                    });

                    // The rewrite really is shape-preserving in every dimension
                    // except element identity.
                    expect(ctx.allTemplates).toBe(arr);
                    expect(ctx.allTemplates.length).toBe(lengthBefore);
                    expect(ctx.TemplateCatalog.size()).toBe(catalogSizeBefore);
                    // The counter did NOT move, so detection cannot have come
                    // from it — clause 3.11's "additive, replaces nothing".
                    expect(ctx._templatesRevision).toBe(revisionBefore);
                    expect(ctx.TemplateCatalog.sourceStamp()).toBe(ctx._templatesRevision);
                    // Element identity moved, and that is what fires.
                    expect(ctx.allTemplates[0]).not.toBe(firstBefore);
                    expect(ctx.allTemplates[ctx.allTemplates.length - 1]).not.toBe(lastBefore);
                    expect(changed).toBe(true);

                    // ...and the next ensureCatalogFresh absorbs it.
                    ctx.ensureCatalogFresh();
                    expect(realm.catalog.build).toBe(2);
                    expect(ctx.catalogSourceChanged()).toBe(false);

                    return true;
                }
            ),
            {
                numRuns: 30,
                seed: 20260908,
                // Sizes 1 and 2 are the collapsing cases the design calls out.
                examples: [
                    [{ size: 1, sectionIdx: 0 }],
                    [{ size: 2, sectionIdx: 0 }],
                    [{ size: 1, sectionIdx: 6 }],
                    [{ size: 2, sectionIdx: 6 }],
                ],
            }
        );

        expect(sizes.indexOf(1)).toBeGreaterThan(-1);
        expect(sizes.indexOf(2)).toBeGreaterThan(-1);
    }, 180000);
});

// ─── Shared factory for the BUG 5 S-site cases ─────────────────────────────
//
// freshRecord above deliberately uses a SHORT folder segment ("T3") that does
// not agree with _getTemplateFolderPath's name-based reconstruction, because P5
// through P8 never need the index mutation to land. F4 does: removeUITemplate
// and patchUITemplate call li.removeEntry / li.patchEntry FIRST, and when the
// key misses, the index throws internally, raises needsFullScan and — crucially
// for the aliasing question below — leaves the shared array untouched. A
// mismatched fixture would therefore hide the exact behaviour F4 exists to pin.
//
// So this factory derives folderPath the way the panel derives it, and every
// case asserts ctx._getTemplateFolderPath(name, cat) === record.folderPath as a
// PRECONDITION before it asserts anything about markTemplatesDirty.
function sSiteRecord(n, section, root) {
    const cat = FRESH_CATS[n % FRESH_CATS.length];
    const name = "Lower Third " + n;
    const folder = root + "/" + section + "/" + pathBuilders.getSafeName(cat) +
        "/" + pathBuilders.generateTemplateId(name);
    return {
        id: "t" + n,
        name: name,
        category: cat,
        section: section,
        type: section,
        dim: "1920x1080",
        favorite: n % 3 === 0,
        folderPath: folder,
        sourcePath: root,
        thumbnail: "",
        thumbnailPath: folder + "/thumbnail.png",
        thumbStatus: "placeholder",
    };
}

function sSiteLibrary(size, section, root) {
    const out = [];
    for (let i = 0; i < size; i++) out.push(sSiteRecord(i, section, root));
    return out;
}

/**
 * The five dimensions catalogSourceChanged() probes BESIDES the revision
 * counter: source array identity, length, first-element identity,
 * last-element identity and TemplateCatalog.size(). Property 8 requires the
 * counter to work "without relying on" these, so the sites where none of them
 * moves are the ones that prove it.
 */
function shapeProbes(ctx) {
    const arr = ctx.allTemplates;
    const len = arr ? arr.length : 0;
    return {
        array: arr,
        length: len,
        first: len ? arr[0] : null,
        last: len ? arr[len - 1] : null,
        catalogSize: ctx.TemplateCatalog.size(),
    };
}

function shapeProbeDelta(before, ctx) {
    const after = shapeProbes(ctx);
    return {
        arrayIdentityMoved: before.array !== after.array,
        lengthMoved: before.length !== after.length,
        firstElementMoved: before.first !== after.first,
        lastElementMoved: before.last !== after.last,
        catalogSizeMoved: before.catalogSize !== after.catalogSize,
    };
}

function anyShapeProbeFired(delta) {
    return delta.arrayIdentityMoved || delta.lengthMoved ||
        delta.firstElementMoved || delta.lastElementMoved || delta.catalogSizeMoved;
}

// ════════════════════════════════════════════════════════════════════════════
// F4 -> Property 8 (clauses 2.9, 2.10) — the seven S-sites, one at a time.
//
// Task 5.8. For each site the REAL entry point is driven — not markTemplatesDirty
// called by hand — and three things are asserted:
//
//   1. the site marked the model dirty, exactly as many times as records it
//      touched (so a site that silently stopped firing is caught),
//   2. catalogSourceChanged() read TRUE at the instant of the mark, and
//   3. exactly ONE TemplateCatalog.build absorbs it, whether the entry point
//      rendered internally or not.
//
// (2) is measured inside the markTemplatesDirty wrapper rather than after the
// call returns, because four of the seven entry points end in filterAndRender()
// and the flag is back to false by the time they hand control back. Asserting it
// after the call would be a statement about the render, not about the mutation.
//
// (3) is stated as a TOTAL rather than a delta for the same reason: an entry
// point that renders spends the rebuild itself, one that does not leaves it for
// the following ensureCatalogFresh. Either way the mark costs exactly one
// rebuild — never zero (the mutation went undetected) and never two (something
// marked twice, or the render failed to sync).
//
// `shapeHeld` records which sites need the counter and which only get it for
// free. Where it is true the case additionally asserts that NOT ONE of the five
// shape probes moved, which is Property 8's "without relying on the
// array-identity, length or first/last-element probes" stated literally.
// ════════════════════════════════════════════════════════════════════════════
describe("F4 — each of the seven markTemplatesDirty sites is reached and forces one rebuild", function () {
    const ROOT = "C:/lib";
    const SECTION = SECTIONS.COMP;

    /**
     * One S-site case. `drive` receives the prepared realm and performs the real
     * call; everything around it — baseline build, spy reset, the three
     * assertions — is identical for all seven, which is what makes the table a
     * comparison rather than seven unrelated tests.
     */
    const S_SITES = [
        {
            id: "S1",
            entryPoint: "startupReconcileScanned's processor (matched record)",
            why: "a derived-field write with no catalog mirror and no shape change — the defect itself",
            shapeHeld: true,
            expectedMarks: 5,
            drive: async function (realm) {
                const ctx = realm.context;
                // Every scan record matches an existing one by identity, so the
                // processor takes its copyStartupRecordFields branch every time
                // and never pushes. One MIDDLE record's category differs, which
                // is the field the catalog derives into searchHay, counts and
                // sectionCats.
                const flat = ctx.allTemplates.map(function (r, i) {
                    const clone = JSON.parse(JSON.stringify(r));
                    if (i === 2) clone.category = "Brands";
                    return clone;
                });
                const scannedByRoot = {};
                scannedByRoot["r:" + ROOT] = flat;
                ctx.startupReconcileScanned(null, null, [ROOT], scannedByRoot, flat, "vk-2");
                // LibraryIndex.reconcile resolves without a timer for a list this
                // small; three microtask turns let its .then chain settle.
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                expect(ctx.allTemplates[2].category).toBe("Brands");
                return { changedField: "category", changedIndex: 2 };
            },
        },
        {
            id: "S2",
            entryPoint: "startupReconcileScanned's processor (added record)",
            why: "additive and free — the length probe already fires",
            shapeHeld: false,
            expectedMarks: 3,
            librarySize: 0,
            drive: async function (realm) {
                const ctx = realm.context;
                // allTemplates starts EMPTY, so the processor cannot take its
                // matched branch and every record is an add. That isolates S2
                // from S1 instead of counting a mixture of the two.
                const flat = sSiteLibrary(3, SECTION, ROOT).map(function (r) {
                    return JSON.parse(JSON.stringify(r));
                });
                const scannedByRoot = {};
                scannedByRoot["r:" + ROOT] = flat;
                ctx.startupReconcileScanned(null, null, [ROOT], scannedByRoot, flat, "vk-2");
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                expect(ctx.allTemplates.length).toBe(3);
                return { added: 3 };
            },
        },
        {
            id: "S3",
            entryPoint: "startupReconcileFinish's removal pass",
            why: "free (the length probe fires); also closes add-1-remove-1, where length returns to its original value",
            shapeHeld: false,
            expectedMarks: 1,
            drive: async function (realm) {
                const ctx = realm.context;
                const lengthBefore = ctx.allTemplates.length;
                // The scan omits the LAST record, so exactly one removal runs.
                const scanned = ctx.allTemplates.slice(0, lengthBefore - 1).map(function (r) {
                    return JSON.parse(JSON.stringify(r));
                });
                const scannedByRoot = {};
                scannedByRoot["r:" + ROOT] = scanned;
                ctx.startupReconcileFinish(
                    null, null, [ROOT], scannedByRoot, true,
                    { added: 0, removed: 0 }, "vk-3", false
                );
                expect(ctx.allTemplates.length).toBe(lengthBefore - 1);
                return { removed: 1 };
            },
        },
        {
            id: "S4",
            entryPoint: "removeUITemplate",
            why: "additive to the TemplateCatalog.remove above, and free: the length probe already fires",
            shapeHeld: false,
            expectedMarks: 1,
            // Cloned aliasing: allTemplates holds its own record objects, which
            // is the shape in which removeUITemplate's own scan still finds the
            // card. The shared shape — where it does not — is pinned separately
            // in the aliasing block below.
            aliasing: "cloned",
            drive: async function (realm) {
                const ctx = realm.context;
                const target = ctx.allTemplates[2];
                expect(ctx._getTemplateFolderPath(target.name, target.category))
                    .toBe(target.folderPath);
                ctx.removeUITemplate(target.name, target.category);
                expect(realm.catalog.remove.length).toBe(1);
                expect(realm.getIndex().has(target.folderPath)).toBe(false);
                expect(realm.getIndex().needsFullScan()).toBe(false);
                return { removedFolder: target.folderPath };
            },
        },
        {
            id: "S5",
            entryPoint: "patchUITemplate (favourite toggle)",
            why: "the manual TemplateCatalog.patch above is incomplete for an id change, so force a rebuild",
            shapeHeld: true,
            expectedMarks: 1,
            aliasing: "cloned",
            drive: async function (realm) {
                const ctx = realm.context;
                const target = ctx.allTemplates[2];
                expect(ctx._getTemplateFolderPath(target.name, target.category))
                    .toBe(target.folderPath);
                // A favourite toggle keeps name and category, so the in-memory
                // scan matches in BOTH aliasing modes and the site is reachable
                // either way. currentCategory is "All" with no search, so
                // recordChangedView is false and the entry point does NOT render
                // — the mark is left standing for the next ensureCatalogFresh.
                ctx.patchUITemplate(target.name, target.category, { favorite: !target.favorite });
                expect(realm.catalog.patch.length).toBe(1);
                expect(realm.getIndex().needsFullScan()).toBe(false);
                return { patchedFolder: target.folderPath, favorite: target.favorite };
            },
        },
        {
            id: "S6",
            entryPoint: "markCardFailed",
            why: "no catalog mirror here at all; fires on terminal render failure, not on every success",
            shapeHeld: true,
            expectedMarks: 1,
            aliasing: "cloned",
            drive: async function (realm) {
                const ctx = realm.context;
                const target = ctx.allTemplates[2];
                ctx.markCardFailed(target.folderPath);
                expect(target.thumbStatus).toBe("failed");
                expect(realm.getIndex().getEntry(target.folderPath).thumbStatus).toBe("failed");
                // The whole point of S6 versus the excluded refreshCardThumbnail:
                // nothing mirrored this write into the catalog.
                expect(realm.catalog.patch.length).toBe(0);
                return { failedFolder: target.folderPath };
            },
        },
        {
            id: "S7",
            entryPoint: "renderOptimisticCard",
            why: "free: both the length and first-element probes already fire",
            shapeHeld: false,
            expectedMarks: 1,
            aliasing: "cloned",
            drive: async function (realm) {
                const ctx = realm.context;
                const folder = ROOT + "/" + SECTION + "/Logos/FreshSave";
                const lengthBefore = ctx.allTemplates.length;
                const out = ctx.renderOptimisticCard({
                    id: "fresh-1",
                    name: "Fresh Save",
                    category: "Logos",
                    section: SECTION,
                    folderPath: folder,
                    thumbnailPath: folder + "/thumbnail.png",
                    sourcePath: ROOT,
                    favorite: false,
                });
                expect(out).not.toBe(null);
                expect(ctx.allTemplates.length).toBe(lengthBefore + 1);
                expect(ctx.allTemplates[0]).toBe(out);
                // Clause 3.2: thumbnailPath stays the raw disk path the
                // existsSync probe read, and the placeholder status stands.
                expect(out.thumbStatus).toBe("placeholder");
                expect(out.thumbnail).toBe("");
                return { insertedFolder: folder };
            },
        },
    ];

    S_SITES.forEach(function (site) {
        test(site.id + " — " + site.entryPoint + " marks dirty and costs exactly one rebuild", async function () {
            // **Validates: Requirements 2.9, 2.10**
            const size = site.librarySize === undefined ? 5 : site.librarySize;
            const seeds = sSiteLibrary(size, SECTION, ROOT);
            const li = persistIndex(seeds);
            // Cloned model: allTemplates holds its own objects, li._entries holds
            // the persisted ones. This is the post-save-session shape.
            const model = site.aliasing === "shared"
                ? li._entries
                : li._entries.map(shallowClone);
            const realm = createPanelRealm({
                libraryIndex: li,
                allTemplates: model,
                currentSection: SECTION,
                currentCategory: "All",
                libraryPaths: [ROOT],
                rootPath: ROOT,
            });
            const ctx = realm.context;

            // Baseline: the catalog is built and stamped, so nothing below can
            // be explained by a first-ever build.
            ctx.ensureCatalogFresh();
            expect(realm.catalog.build).toBe(1);
            expect(ctx.catalogSourceChanged()).toBe(false);

            const revisionBefore = ctx._templatesRevision;
            const probesBefore = shapeProbes(ctx);
            realm.resetCatalogSpies();

            const extras = await site.drive(realm);

            const delta = shapeProbeDelta(probesBefore, ctx);
            const buildsDuringCall = realm.catalog.build;
            const sourceChangedAfterCall = ctx.catalogSourceChanged();

            // (3) One rebuild total — spent inside the entry point when it
            // renders, spent here when it does not.
            ctx.ensureCatalogFresh();

            observe("F4-" + site.id, site.id + " — " + site.entryPoint, {
                why: site.why,
                aliasing: site.aliasing || "n/a",
                marks: realm.marks,
                revisionBefore: revisionBefore,
                revisionAfter: ctx._templatesRevision,
                shapeProbeDelta: delta,
                anyShapeProbeFired: anyShapeProbeFired(delta),
                buildsDuringCall: buildsDuringCall,
                buildsTotal: realm.catalog.build,
                sourceChangedAfterCall: sourceChangedAfterCall,
                extras: extras,
            });

            // (1) The site fired, once per record it touched, and the counter
            // moved by exactly that much.
            expect(realm.marks.length).toBe(site.expectedMarks);
            expect(ctx._templatesRevision).toBe(revisionBefore + site.expectedMarks);

            // (2) At the instant of every mark the model read dirty.
            realm.marks.forEach(function (mark, i) {
                expect(mark.sourceChanged).toBe(true);
                expect(mark.revision).toBe(revisionBefore + i + 1);
                expect(Number.isInteger(mark.revision)).toBe(true);
            });

            // (3) Exactly one rebuild, and the catalog is back in sync.
            expect(realm.catalog.build).toBe(1);
            expect(ctx.catalogSourceChanged()).toBe(false);
            expect(ctx.TemplateCatalog.sourceStamp()).toBe(ctx._templatesRevision);
            expect(realm.warnings).toEqual([]);

            if (site.shapeHeld) {
                // Property 8 literally: detection here CANNOT have come from a
                // shape probe, because not one of them moved.
                expect(delta.arrayIdentityMoved).toBe(false);
                expect(delta.lengthMoved).toBe(false);
                expect(delta.firstElementMoved).toBe(false);
                expect(delta.lastElementMoved).toBe(false);
                expect(delta.catalogSizeMoved).toBe(false);
                expect(anyShapeProbeFired(delta)).toBe(false);
                // ...so the entry point left the mark standing and the rebuild
                // above is the one it caused.
                expect(buildsDuringCall).toBe(0);
                expect(sourceChangedAfterCall).toBe(true);
            } else {
                // The "free" sites: a probe would have caught the mutation
                // anyway, so the mark is additive. Recorded, not required to be
                // the sole mechanism.
                expect(anyShapeProbeFired(delta)).toBe(true);
            }
        });
    });

    // ── The aliasing boundary S4 and S5 sit on ──────────────────────────────
    //
    // Found while verifying BUG 2, and it decides which mode each S-site case
    // above runs in. When allTemplates IS li._entries — the warm-paint /
    // reopened-panel shape, set up at templates.js `allTemplates = li._entries`
    // — removeUITemplate's li.removeEntry and patchUITemplate's li.patchEntry
    // rewrite that shared array BEFORE the function's own
    // name + category + section scan runs:
    //
    //   removeEntry  splices the element out, so the scan finds nothing at all;
    //   patchEntry   REPLACES the element with a merged clone that already
    //                carries the new name / category, so a rename or a move
    //                walks straight past it.
    //
    // The scan body is where BOTH the hand-written TemplateCatalog mirror and
    // the S-site call live, so in that shape NEITHER runs. What is left:
    //
    //   S4, any index        the LENGTH probe fires — covered, counter unused.
    //   S5 rename/move, first or last index   the first/last-element probe fires.
    //   S5 rename/move, MIDDLE index          nothing fires. Recorded below.
    //   S5 favourite         name and category are unchanged, so the scan DOES
    //                        match and the site fires in both modes.
    //
    // The middle-index rename is an aliasing defect in patchUITemplate's own
    // ordering, NOT something an extra markTemplatesDirty could reach — the call
    // would sit in the branch that never executes. It is recorded here so it is
    // not rediscovered, and it needs its own spec. If a later change fixes the
    // ordering, this case goes RED with the new behaviour, which is the point:
    // update the case, do not revert the fix.
    describe("the shared-vs-cloned aliasing modes for S4 and S5", function () {
        const MID = 2;
        const SIZE = 5;

        function buildRealm(mode) {
            const seeds = sSiteLibrary(SIZE, SECTION, ROOT);
            const li = persistIndex(seeds);
            const model = mode === "shared" ? li._entries : li._entries.map(shallowClone);
            const realm = createPanelRealm({
                libraryIndex: li,
                allTemplates: model,
                currentSection: SECTION,
                currentCategory: "All",
                libraryPaths: [ROOT],
                rootPath: ROOT,
            });
            realm.context.ensureCatalogFresh();
            expect(realm.catalog.build).toBe(1);
            expect(realm.context.catalogSourceChanged()).toBe(false);
            realm.resetCatalogSpies();
            return realm;
        }

        test("S5 favourite toggle: the site fires in BOTH modes, and the counter is the only mechanism", function () {
            // **Validates: Requirements 2.9, 2.10, 3.11**
            const seen = [];
            ["cloned", "shared"].forEach(function (mode) {
                const realm = buildRealm(mode);
                const ctx = realm.context;
                const target = ctx.allTemplates[MID];
                const probesBefore = shapeProbes(ctx);
                const revisionBefore = ctx._templatesRevision;

                ctx.patchUITemplate(target.name, target.category, { favorite: !target.favorite });

                const delta = shapeProbeDelta(probesBefore, ctx);
                seen.push({
                    mode: mode,
                    marks: realm.marks.length,
                    catalogPatchCalls: realm.catalog.patch.length,
                    buildsDuringCall: realm.catalog.build,
                    sourceChangedAfterCall: ctx.catalogSourceChanged(),
                    shapeProbeDelta: delta,
                    favoriteAfter: ctx.allTemplates[MID].favorite,
                });

                // Reachable in both modes: name and category did not move, so
                // patchUITemplate's scan still matches the (possibly replaced)
                // element at MID.
                expect(realm.marks.length).toBe(1);
                expect(realm.marks[0].sourceChanged).toBe(true);
                expect(realm.catalog.patch.length).toBe(1);
                expect(ctx._templatesRevision).toBe(revisionBefore + 1);
                // A favourite toggle is not a view change under "All" with no
                // search, so nothing rendered and nothing absorbed the mark.
                expect(realm.catalog.build).toBe(0);
                expect(ctx.catalogSourceChanged()).toBe(true);
                // MID is a middle index, so no shape probe can explain it even
                // in shared mode, where patchEntry did replace the element.
                expect(delta.arrayIdentityMoved).toBe(false);
                expect(delta.lengthMoved).toBe(false);
                expect(delta.firstElementMoved).toBe(false);
                expect(delta.lastElementMoved).toBe(false);
                expect(delta.catalogSizeMoved).toBe(false);
                // ...and one rebuild absorbs it.
                ctx.ensureCatalogFresh();
                expect(realm.catalog.build).toBe(1);
                expect(ctx.catalogSourceChanged()).toBe(false);
                expect(realm.warnings).toEqual([]);
            });

            observe("F4-S5-aliasing-favorite", "a favourite toggle reaches S5 in both aliasing modes", { modes: seen });
        });

        test("S4 in shared mode: the scan misses, so neither the mirror nor the site runs — the length probe covers it", function () {
            // **Validates: Requirements 2.9, 3.11**
            const realm = buildRealm("shared");
            const ctx = realm.context;
            const li = realm.getIndex();
            const target = ctx.allTemplates[MID];
            const probesBefore = shapeProbes(ctx);
            const revisionBefore = ctx._templatesRevision;

            ctx.removeUITemplate(target.name, target.category);

            const delta = shapeProbeDelta(probesBefore, ctx);
            observe("F4-S4-aliasing-shared", "removeEntry splices the shared array before the scan runs", {
                marks: realm.marks.length,
                catalogRemoveCalls: realm.catalog.remove.length,
                buildsDuringCall: realm.catalog.build,
                shapeProbeDelta: delta,
                lengthAfter: ctx.allTemplates.length,
                indexSizeAfter: li.size(),
                needsFullScan: li.needsFullScan(),
                sourceChangedAfterCall: ctx.catalogSourceChanged(),
            });

            // The removal really happened, and it happened ONCE — li.removeEntry
            // did it, on the array both views share.
            expect(li.has(target.folderPath)).toBe(false);
            expect(li.needsFullScan()).toBe(false);
            expect(ctx.allTemplates.length).toBe(SIZE - 1);
            expect(ctx.allTemplates.indexOf(target)).toBe(-1);
            // Neither the hand mirror nor S4 was reached: both live in the loop
            // body whose scan no longer matches.
            expect(realm.marks.length).toBe(0);
            expect(realm.catalog.remove.length).toBe(0);
            expect(ctx._templatesRevision).toBe(revisionBefore);
            // The length probe is what fires, and the trailing filterAndRender
            // spends the rebuild — clause 3.11's probes doing their job.
            expect(delta.lengthMoved).toBe(true);
            expect(realm.catalog.build).toBe(1);
            expect(ctx.catalogSourceChanged()).toBe(false);
            expect(ctx.TemplateCatalog.size()).toBe(SIZE - 1);
            expect(realm.warnings).toEqual([]);
        });

        test("S5 rename in shared mode at a MIDDLE index: nothing fires — recorded, out of BUG 5's reach", function () {
            // **Validates: Requirements 2.9, 3.11**
            const realm = buildRealm("shared");
            const ctx = realm.context;
            const target = ctx.allTemplates[MID];
            const oldName = target.name;
            const probesBefore = shapeProbes(ctx);
            const revisionBefore = ctx._templatesRevision;

            ctx.patchUITemplate(
                oldName, target.category,
                { name: oldName + " R", id: "t2-renamed" },
                oldName + " R", undefined
            );

            const delta = shapeProbeDelta(probesBefore, ctx);
            observe("F4-S5-aliasing-rename", "patchEntry pre-applies the new name, so the scan walks past it", {
                marks: realm.marks.length,
                catalogPatchCalls: realm.catalog.patch.length,
                buildsDuringCall: realm.catalog.build,
                shapeProbeDelta: delta,
                modelNameAtMid: ctx.allTemplates[MID].name,
                catalogNameForOldId: ctx.TemplateCatalog.get("t2") && ctx.TemplateCatalog.get("t2").name,
                sourceChangedAfterCall: ctx.catalogSourceChanged(),
                needsFullScan: realm.getIndex().needsFullScan(),
            });

            // The rename DID land on the shared array — li.patchEntry replaced
            // the element with a merged clone carrying the new name.
            expect(ctx.allTemplates[MID].name).toBe(oldName + " R");
            expect(ctx.allTemplates[MID]).not.toBe(target);
            expect(realm.getIndex().needsFullScan()).toBe(false);
            // ...and patchUITemplate's own scan, which looks for the OLD name,
            // therefore matched nothing. Both the mirror and S5 sit in that
            // unexecuted branch.
            expect(realm.marks.length).toBe(0);
            expect(realm.catalog.patch.length).toBe(0);
            expect(ctx._templatesRevision).toBe(revisionBefore);
            // MID is neither first nor last, so no shape probe fires either.
            expect(delta.arrayIdentityMoved).toBe(false);
            expect(delta.lengthMoved).toBe(false);
            expect(delta.firstElementMoved).toBe(false);
            expect(delta.lastElementMoved).toBe(false);
            expect(delta.catalogSizeMoved).toBe(false);
            // RECORDED, NOT ENDORSED: the catalog keeps the pre-rename record and
            // nothing asks for a rebuild. Adding a markTemplatesDirty() call
            // cannot fix this — it would go in the branch that never ran. The
            // repair belongs in patchUITemplate's ordering and needs its own
            // spec. If that lands, this case goes red; update it, do not revert.
            expect(ctx.catalogSourceChanged()).toBe(false);
            expect(ctx.TemplateCatalog.get("t2").name).toBe(oldName);
            expect(realm.warnings).toEqual([]);
        });

        test("S5 rename in shared mode at the FIRST and LAST index: the element-identity probes cover it", function () {
            // **Validates: Requirements 3.11**
            const seen = [];
            [0, SIZE - 1].forEach(function (idx) {
                const realm = buildRealm("shared");
                const ctx = realm.context;
                const target = ctx.allTemplates[idx];
                const oldName = target.name;
                const probesBefore = shapeProbes(ctx);

                ctx.patchUITemplate(
                    oldName, target.category,
                    { name: oldName + " R", id: "renamed-" + idx },
                    oldName + " R", undefined
                );

                const delta = shapeProbeDelta(probesBefore, ctx);
                seen.push({
                    index: idx,
                    marks: realm.marks.length,
                    catalogPatchCalls: realm.catalog.patch.length,
                    buildsDuringCall: realm.catalog.build,
                    shapeProbeDelta: delta,
                    sourceChangedAfterCall: ctx.catalogSourceChanged(),
                });

                // Same missed scan as the middle-index case...
                expect(realm.marks.length).toBe(0);
                expect(realm.catalog.patch.length).toBe(0);
                // ...but the replaced element IS the first or the last one, so a
                // shape probe fires and the structural repaint rebuilds.
                if (idx === 0) expect(delta.firstElementMoved).toBe(true);
                else expect(delta.lastElementMoved).toBe(true);
                expect(realm.catalog.build).toBe(1);
                expect(ctx.catalogSourceChanged()).toBe(false);
                expect(ctx.TemplateCatalog.get("renamed-" + idx).name).toBe(oldName + " R");
                expect(realm.warnings).toEqual([]);
            });

            observe("F4-S5-aliasing-rename-edges", "a shared-mode rename at an edge index is probe-covered", { indices: seen });
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// F4-sequences -> Property 8 / Property 9 (clauses 2.9, 2.10, 3.10, 3.11)
//
// The per-site table above proves each of the seven sites is REACHED. This
// property proves the resulting signal is EXACT over sequences: dirty whenever
// something changed since the last sync, clean whenever nothing did.
//
// Each mutating op is applied the way production applies it — the four that go
// through templates.js pair their array operation with markTemplatesDirty()
// exactly as S1-S7 do, and the clone rewrite does NOT, because it happens in
// MediaEntryRepository._publishDurable and relies on the element-identity probe
// (clause 3.11). Modelling them any other way would be testing a rule the code
// does not follow.
//
// The no-op render is the false-positive side: it must never make the flag true,
// which is the same obligation P5 states for TemplateCatalog.build counts.
// ════════════════════════════════════════════════════════════════════════════
describe("F4-sequences — catalogSourceChanged() is true exactly when a mutation landed", function () {
    const ROOT = "C:/lib";
    const SECTION = SECTIONS.COMP;

    const OPS = ["field-write", "push", "splice", "unshift", "clone-rewrite", "noop-render"];

    const seqArb = fc.record({
        size: fc.integer({ min: 1, max: 10 }),
        ops: fc.array(fc.constantFrom.apply(fc, OPS), { minLength: 4, maxLength: 14 }),
        sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
    });

    test("no false negatives across generated mutation sequences, no false positives on a no-op render", function () {
        // **Validates: Requirements 2.9, 2.10, 3.10, 3.11**
        const opsExercised = {};
        let nextId = 1000;

        fc.assert(
            fc.property(seqArb, function (spec) {
                const section = SECTION_VALUES[spec.sectionIdx];
                const realm = createPanelRealm({
                    allTemplates: sSiteLibrary(spec.size, section, ROOT),
                    currentSection: section,
                    currentCategory: "All",
                    libraryPaths: [ROOT],
                    rootPath: ROOT,
                });
                const ctx = realm.context;

                ctx.ensureCatalogFresh();
                expect(ctx.catalogSourceChanged()).toBe(false);

                // The model this property checks the code against: true exactly
                // when at least one real mutation landed since the last sync.
                let mutatedSinceSync = false;
                const trace = [];

                spec.ops.forEach(function (op) {
                    const arr = ctx.allTemplates;
                    let applied = false;

                    if (op === "field-write" && arr.length > 0) {
                        // S1 / S6 shape: an in-place write to a catalog-derived
                        // field, mirrored nowhere.
                        const at = Math.floor(arr.length / 2);
                        arr[at].category = arr[at].category === "Brands" ? "Logos" : "Brands";
                        ctx.markTemplatesDirty();
                        applied = true;
                    } else if (op === "push") {
                        // S2 shape.
                        arr.push(sSiteRecord(nextId++, section, ROOT));
                        ctx.markTemplatesDirty();
                        applied = true;
                    } else if (op === "splice" && arr.length > 0) {
                        // S3 / S4 shape.
                        arr.splice(Math.floor(arr.length / 2), 1);
                        ctx.markTemplatesDirty();
                        applied = true;
                    } else if (op === "unshift") {
                        // S7 shape.
                        arr.unshift(sSiteRecord(nextId++, section, ROOT));
                        ctx.markTemplatesDirty();
                        applied = true;
                    } else if (op === "clone-rewrite" && arr.length > 0) {
                        // _publishDurable's shape: identity held, cleared, clones
                        // re-pushed, and deliberately NO mark.
                        const clones = arr.map(shallowClone);
                        arr.length = 0;
                        for (let i = 0; i < clones.length; i++) arr.push(clones[i]);
                        applied = true;
                    } else if (op === "noop-render") {
                        // Reads the model, changes nothing, and syncs.
                        ctx.filterAndRender();
                        mutatedSinceSync = false;
                    }

                    if (applied) mutatedSinceSync = true;
                    opsExercised[op] = (opsExercised[op] || 0) + 1;

                    const observed = ctx.catalogSourceChanged();
                    trace.push({
                        op: op,
                        applied: applied,
                        length: ctx.allTemplates.length,
                        expected: mutatedSinceSync,
                        observed: observed,
                    });
                    expect(observed).toBe(mutatedSinceSync);
                });

                observe("F4-sequences", "the first generated mutation sequence", {
                    librarySize: spec.size,
                    section: section,
                    trace: trace,
                });

                expect(realm.warnings).toEqual([]);
                return true;
            }),
            { numRuns: 60, seed: 20260912 }
        );

        // Every op class really was exercised, so the property is not green by
        // never having generated the interesting ones.
        OPS.forEach(function (op) {
            expect(opsExercised[op]).toBeGreaterThan(0);
        });
    }, 240000);

    test("K consecutive no-op renders leave the flag false and add no rebuild", function () {
        // **Validates: Requirements 3.10**
        fc.assert(
            fc.property(
                fc.record({
                    size: fc.integer({ min: 1, max: 20 }),
                    k: fc.integer({ min: 2, max: 10 }),
                    sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
                }),
                function (spec) {
                    const section = SECTION_VALUES[spec.sectionIdx];
                    const realm = createPanelRealm({
                        allTemplates: sSiteLibrary(spec.size, section, ROOT),
                        currentSection: section,
                        currentCategory: "All",
                        libraryPaths: [ROOT],
                        rootPath: ROOT,
                    });
                    const ctx = realm.context;

                    ctx.ensureCatalogFresh();
                    expect(realm.catalog.build).toBe(1);

                    for (let i = 0; i < spec.k; i++) {
                        ctx.filterAndRender();
                        expect(ctx.catalogSourceChanged()).toBe(false);
                        expect(realm.catalog.build).toBe(1);
                    }
                    expect(realm.marks.length).toBe(0);
                    expect(realm.warnings).toEqual([]);
                    return true;
                }
            ),
            { numRuns: 25, seed: 20260913 }
        );
    }, 180000);

    test("add-1-remove-1 returns every shape probe to its original reading, and only the counter notices", function () {
        // **Validates: Requirements 2.9, 3.11**
        //
        // S3's stated reason for existing. A push followed by a splice of the
        // pushed element leaves the array identity, the length, the first and
        // last elements and TemplateCatalog.size() all exactly as the catalog
        // last stamped them — so the counter is the ONLY thing left that can
        // report the intervening churn. The second half replays the same two
        // operations with no mark to show what that costs.
        const section = SECTION;

        function seedRealm() {
            const realm = createPanelRealm({
                allTemplates: sSiteLibrary(4, section, ROOT),
                currentSection: section,
                currentCategory: "All",
                libraryPaths: [ROOT],
                rootPath: ROOT,
            });
            realm.context.ensureCatalogFresh();
            expect(realm.catalog.build).toBe(1);
            expect(realm.context.catalogSourceChanged()).toBe(false);
            realm.resetCatalogSpies();
            return realm;
        }

        // ── With the marks the seven sites make ─────────────────────────────
        const marked = seedRealm();
        const mctx = marked.context;
        const mBefore = shapeProbes(mctx);
        mctx.allTemplates.push(sSiteRecord(90, section, ROOT));
        mctx.markTemplatesDirty();                      // S2's mark
        mctx.allTemplates.splice(mctx.allTemplates.length - 1, 1);
        mctx.markTemplatesDirty();                      // S3's mark
        const mDelta = shapeProbeDelta(mBefore, mctx);
        const markedChanged = mctx.catalogSourceChanged();

        // ── The same churn with no mark ─────────────────────────────────────
        const bare = seedRealm();
        const bctx = bare.context;
        const bBefore = shapeProbes(bctx);
        bctx.allTemplates.push(sSiteRecord(90, section, ROOT));
        bctx.allTemplates.splice(bctx.allTemplates.length - 1, 1);
        const bDelta = shapeProbeDelta(bBefore, bctx);
        const bareChanged = bctx.catalogSourceChanged();

        observe("F4-add1remove1", "an add-1-remove-1 window, with and without the counter", {
            withMarks: {
                marks: marked.marks.length,
                shapeProbeDelta: mDelta,
                catalogSourceChanged: markedChanged,
            },
            withoutMarks: {
                marks: bare.marks.length,
                shapeProbeDelta: bDelta,
                catalogSourceChanged: bareChanged,
            },
        });

        // Both windows are shape-identical to the stamped state.
        [mDelta, bDelta].forEach(function (delta) {
            expect(delta.arrayIdentityMoved).toBe(false);
            expect(delta.lengthMoved).toBe(false);
            expect(delta.firstElementMoved).toBe(false);
            expect(delta.lastElementMoved).toBe(false);
            expect(delta.catalogSizeMoved).toBe(false);
        });
        // The counter is what separates them.
        expect(marked.marks.length).toBe(2);
        expect(markedChanged).toBe(true);
        expect(bare.marks.length).toBe(0);
        expect(bareChanged).toBe(false);
        // ...and one rebuild absorbs the marked window.
        mctx.ensureCatalogFresh();
        expect(marked.catalog.build).toBe(1);
        expect(mctx.catalogSourceChanged()).toBe(false);
        expect(marked.warnings).toEqual([]);
        expect(bare.warnings).toEqual([]);
    });

    test("markTemplatesDirty returns a strictly increasing integer, and N marks cost one rebuild", function () {
        // **Validates: Requirements 2.9, 2.10, 3.10**
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 25 }), function (n) {
                const realm = createPanelRealm({
                    allTemplates: sSiteLibrary(6, SECTION, ROOT),
                    currentSection: SECTION,
                    currentCategory: "All",
                    libraryPaths: [ROOT],
                    rootPath: ROOT,
                });
                const ctx = realm.context;

                ctx.ensureCatalogFresh();
                expect(realm.catalog.build).toBe(1);
                realm.resetCatalogSpies();

                const start = ctx._templatesRevision;
                const returned = [];
                for (let i = 0; i < n; i++) {
                    const value = ctx.markTemplatesDirty();
                    returned.push(value);
                    // Strictly increasing, integral, and the same value the
                    // module now reports as its revision.
                    expect(Number.isInteger(value)).toBe(true);
                    expect(value).toBe(start + i + 1);
                    if (i > 0) expect(value).toBeGreaterThan(returned[i - 1]);
                    expect(value).toBe(ctx._templatesRevision);
                    // N marks in a row do not each trigger a rebuild — the
                    // rebuild is deferred to the next freshness check.
                    expect(realm.catalog.build).toBe(0);
                    expect(ctx.catalogSourceChanged()).toBe(true);
                }

                // One ensureCatalogFresh collapses all N into a single build.
                ctx.ensureCatalogFresh();
                expect(realm.catalog.build).toBe(1);
                expect(ctx.catalogSourceChanged()).toBe(false);
                expect(ctx.TemplateCatalog.sourceStamp()).toBe(start + n);
                // ...and a second one adds nothing.
                ctx.ensureCatalogFresh();
                expect(realm.catalog.build).toBe(1);

                if (n === 1) {
                    observe("F4-counter", "the revision counter over N marks", {
                        marks: n,
                        firstReturn: returned[0],
                        revisionAfter: ctx._templatesRevision,
                        buildsForNMarks: realm.catalog.build,
                    });
                }
                return true;
            }),
            { numRuns: 25, seed: 20260914 }
        );
    }, 180000);
});

// ════════════════════════════════════════════════════════════════════════════
// F4-exclusions -> Property 9 (clauses 3.1, 3.10, 3.11) — task 5.7, executable.
//
// D3 dropped three markTemplatesDirty candidates and left four population paths
// alone. 5.7's audit is only worth having if it FAILS when one of them acquires
// a call, so it is written as assertions rather than as an observation:
//
//   - exactly EIGHT occurrences of the identifier in js/** — one definition plus
//     the seven calls, all of them in js/templates/templates.js,
//   - ZERO in js/core/persistence.js, which also keeps that whole-file
//     CEP-scanned unit out of this spec's change set (clause 3.16),
//   - ZERO inside refreshCardThumbnail, markThumbnailForRegen, loadTemplates,
//     startupWarmPaint and mergeSurvivingMediaEntries,
//   - each of the seven calls inside the function D3 assigned it to.
//
// Function bodies are located by CONTENT (findFunctionBody), never by
// line number: task 8.1 deletes 64 lines from this same file.
//
// The hayFor / counts claim D3's refreshCardThumbnail exclusion RESTS ON is
// verified here rather than assumed, both from the source and behaviourally. If
// thumbnail, thumbnailPath or thumbStatus ever starts participating, the
// exclusion stops being safe and this block is where that surfaces.
// ════════════════════════════════════════════════════════════════════════════
describe("F4-exclusions — the dropped markTemplatesDirty candidates stay uncalled", function () {
    const TEMPLATES = "js/templates/templates.js";
    const CATALOG = "js/templates/templateCatalog.js";
    const PERSISTENCE = "js/core/persistence.js";
    const SIGNAL = "markTemplatesDirty";

    test("js/** holds exactly eight occurrences: one definition and seven calls", function () {
        // **Validates: Requirements 3.10, 3.11**
        const perFile = [];
        let total = 0;
        jsSourceFiles().forEach(function (rel) {
            const n = countIdentifier(repoText(rel), SIGNAL);
            if (n > 0) perFile.push({ file: rel, occurrences: n });
            total += n;
        });

        // Counted off repoLines rather than a regex over the raw text: this file
        // is CRLF and templateCatalog.js is LF, so a `$`-anchored pattern would
        // silently behave differently in the two.
        const templatesLines = repoLines(TEMPLATES);
        let definitions = 0;
        let calls = 0;
        templatesLines.forEach(function (line) {
            const trimmed = line.trim();
            if (trimmed === "function markTemplatesDirty() {") definitions++;
            else if (trimmed.indexOf("markTemplatesDirty();") === 0) calls++;
        });

        observe("F4-exclusions-count", "every js/** occurrence of the staleness signal", {
            totalOccurrences: total,
            perFile: perFile,
            definitions: definitions,
            calls: calls,
            filesScanned: jsSourceFiles().length,
        });

        expect(total).toBe(8);
        expect(perFile).toEqual([{ file: TEMPLATES, occurrences: 8 }]);
        expect(definitions).toBe(1);
        expect(calls).toBe(7);
        expect(definitions + calls).toBe(total);
        // Clause 3.16: the whole-file CEP-scanned unit is untouched.
        expect(countIdentifier(repoText(PERSISTENCE), SIGNAL)).toBe(0);
    });

    test("the seven calls sit in the seven functions D3 assigned them to", function () {
        // **Validates: Requirements 3.10, 3.11**
        //
        // S1 and S2 share startupReconcileScanned (its processor), so that body
        // carries two. Every other owner carries one.
        const OWNERS = [
            { fn: "startupReconcileScanned", calls: 2, sites: "S1, S2" },
            { fn: "startupReconcileFinish", calls: 1, sites: "S3" },
            { fn: "removeUITemplate", calls: 1, sites: "S4" },
            { fn: "patchUITemplate", calls: 1, sites: "S5" },
            { fn: "markCardFailed", calls: 1, sites: "S6" },
            { fn: "renderOptimisticCard", calls: 1, sites: "S7" },
        ];

        const found = [];
        let accounted = 0;
        OWNERS.forEach(function (owner) {
            const body = findFunctionBody(TEMPLATES, owner.fn);
            const n = countIdentifier(body.text, SIGNAL);
            found.push({
                fn: owner.fn,
                sites: owner.sites,
                at: TEMPLATES + ":" + body.startLine + "-" + body.endLine,
                occurrences: n,
            });
            expect(n).toBe(owner.calls);
            accounted += n;
        });

        observe("F4-exclusions-owners", "where the seven calls live, located by content", { owners: found });

        expect(accounted).toBe(7);
    });

    test("refreshCardThumbnail keeps its direct catalog patch and gains no dirty mark", function () {
        // **Validates: Requirements 3.1, 3.10**
        const body = findFunctionBody(TEMPLATES, "refreshCardThumbnail");

        observe("F4-exclusions-refresh", "the media hot path stays out of the call-site set", {
            at: TEMPLATES + ":" + body.startLine + "-" + body.endLine,
            signalOccurrences: countIdentifier(body.text, SIGNAL),
            hasDirectCatalogPatch: body.text.indexOf("TemplateCatalog.patch(allTemplates[a])") !== -1,
        });

        // Clause 3.10: one O(N) rebuild per completed thumbnail is O(N^2) across
        // an import batch. P6 is the behavioural half of this; this is the
        // source-level half, and it also covers the case where the call is added
        // on a path P6's generator happens not to reach.
        expect(countIdentifier(body.text, SIGNAL)).toBe(0);
        // Clause 3.1: the hand mirror that makes the exclusion safe must remain.
        expect(body.text).toContain("TemplateCatalog.patch(allTemplates[a])");
        // ...and so must the three field writes it mirrors.
        expect(body.text).toContain('allTemplates[a].thumbStatus = "ready"');
        expect(body.text).toContain("allTemplates[a].thumbnailPath =");
        expect(body.text).toContain("allTemplates[a].thumbnail = url");
    });

    test("markThumbnailForRegen gains no dirty mark and never touches allTemplates", function () {
        // **Validates: Requirements 3.10**
        const body = findFunctionBody(TEMPLATES, "markThumbnailForRegen");

        observe("F4-exclusions-regen", "the marker-file writer mutates no model", {
            at: TEMPLATES + ":" + body.startLine + "-" + body.endLine,
            signalOccurrences: countIdentifier(body.text, SIGNAL),
            allTemplatesOccurrences: countIdentifier(body.text, "allTemplates"),
            writesMarkerFile: body.text.indexOf(".needsthumb") !== -1,
        });

        // Clause 3.10 permits the call only where a real mutation occurred. This
        // function writes a marker file and nothing else, so there is nothing to
        // mark.
        expect(countIdentifier(body.text, SIGNAL)).toBe(0);
        expect(countIdentifier(body.text, "allTemplates")).toBe(0);
        expect(body.text).toContain(".needsthumb");
    });

    test("the four wholesale-reassignment paths gain no dirty mark — the array-identity probe fires instead", function () {
        // **Validates: Requirements 3.11**
        const REASSIGNERS = [
            { fn: "loadTemplates", expectAssignments: 3 },
            { fn: "startupWarmPaint", expectAssignments: 1 },
        ];
        const detail = [];

        REASSIGNERS.forEach(function (r) {
            const body = findFunctionBody(TEMPLATES, r.fn);
            const assignments = (body.text.match(/^\s*allTemplates = /gm) || []).length;
            detail.push({
                fn: r.fn,
                at: TEMPLATES + ":" + body.startLine + "-" + body.endLine,
                signalOccurrences: countIdentifier(body.text, SIGNAL),
                wholesaleAssignments: assignments,
            });
            expect(countIdentifier(body.text, SIGNAL)).toBe(0);
            // The mechanism the exclusion relies on: the array is REPLACED, so
            // _catalogSyncRef !== allTemplates on the next check.
            expect(assignments).toBe(r.expectAssignments);
        });

        // mergeSurvivingMediaEntries builds and returns a NEW array; its callers
        // are the assignment sites counted above.
        const merge = findFunctionBody(TEMPLATES, "mergeSurvivingMediaEntries");
        detail.push({
            fn: "mergeSurvivingMediaEntries",
            at: TEMPLATES + ":" + merge.startLine + "-" + merge.endLine,
            signalOccurrences: countIdentifier(merge.text, SIGNAL),
            returnsNewArray: merge.text.indexOf("var merged = []") !== -1 &&
                merge.text.indexOf("return merged;") !== -1,
        });
        expect(countIdentifier(merge.text, SIGNAL)).toBe(0);
        expect(merge.text).toContain("var merged = []");
        expect(merge.text).toContain("return merged;");
        // It assigns nothing itself, so it cannot be the site of a mutation.
        expect((merge.text.match(/^\s*allTemplates = /gm) || []).length).toBe(0);

        observe("F4-exclusions-reassigners", "the population paths that replace the array outright", { paths: detail });

        // The behavioural half: a wholesale replacement really is detected with
        // no counter involvement, which is why no call is needed at any of them.
        const realm = createPanelRealm({
            allTemplates: sSiteLibrary(5, SECTIONS.COMP, "C:/lib"),
            currentSection: SECTIONS.COMP,
            currentCategory: "All",
            libraryPaths: ["C:/lib"],
            rootPath: "C:/lib",
        });
        const ctx = realm.context;
        ctx.ensureCatalogFresh();
        expect(ctx.catalogSourceChanged()).toBe(false);
        const revisionBefore = ctx._templatesRevision;
        ctx.allTemplates = ctx.allTemplates.map(shallowClone);
        expect(ctx.catalogSourceChanged()).toBe(true);
        expect(ctx._templatesRevision).toBe(revisionBefore);
        expect(realm.marks.length).toBe(0);
    });

    test("none of thumbnail, thumbnailPath or thumbStatus participates in hayFor or counts", function () {
        // **Validates: Requirements 3.1, 3.10**
        //
        // THE CLAIM D3's refreshCardThumbnail EXCLUSION RESTS ON, verified rather
        // than assumed. The catalog holds record REFERENCES, so an in-place write
        // to a field it does not derive is visible through byId for free and the
        // hand TemplateCatalog.patch is sufficient. That is only true while these
        // three fields stay out of the derived snapshots.
        const THUMB_FIELDS = ["thumbnail", "thumbnailPath", "thumbStatus"];
        const catalogText = repoText(CATALOG);

        // ── Source half: the derived-snapshot producers ─────────────────────
        const DERIVERS = ["hayFor", "addToLists", "removeFromLists", "rebuildSectionCategories"];
        const perDeriver = [];
        DERIVERS.forEach(function (name) {
            // These are nested declarations inside the TemplateCatalog IIFE, so
            // they are indented — anchor on the declaration and close on the
            // matching indented brace.
            const block = findFunctionBody(CATALOG, name);
            const hits = {};
            THUMB_FIELDS.forEach(function (f) { hits[f] = countIdentifier(block.text, f); });
            perDeriver.push({
                fn: name,
                at: CATALOG + ":" + block.startLine + "-" + block.endLine,
                thumbFieldOccurrences: hits,
            });
            THUMB_FIELDS.forEach(function (f) { expect(hits[f]).toBe(0); });
        });

        // Stronger, and the form that cannot be dodged by moving code between
        // those four functions: the three fields appear NOWHERE in the module.
        const wholeFile = {};
        THUMB_FIELDS.forEach(function (f) { wholeFile[f] = countIdentifier(catalogText, f); });

        // hayFor's five fields, stated positively so a SIXTH being added is
        // caught as well as one of these three being added.
        const hay = findFunctionBody(CATALOG, "hayFor");

        observe("F4-exclusions-hayfor", "the derived snapshots and the fields they read", {
            hayFor: { at: CATALOG + ":" + hay.startLine + "-" + hay.endLine, body: hay.text },
            perDeriver: perDeriver,
            thumbFieldOccurrencesInWholeModule: wholeFile,
        });

        THUMB_FIELDS.forEach(function (f) { expect(wholeFile[f]).toBe(0); });
        expect(hay.text).toContain("t.name");
        expect(hay.text).toContain("t.category");
        expect(hay.text).toContain("t.type");
        expect(hay.text).toContain("t.section");
        expect(hay.text).toContain("t.dim");
        // Exactly five record reads in the haystack — no sixth field crept in.
        expect((hay.text.match(/t\.[A-Za-z]+/g) || []).length).toBe(5);

        // ── Behavioural half ───────────────────────────────────────────────
        // Writing only the three fields must leave every derived snapshot
        // byte-identical, which is what makes the hand patch complete.
        const section = SECTIONS.COMP;
        const realm = createPanelRealm({
            allTemplates: sSiteLibrary(6, section, "C:/lib"),
            currentSection: section,
            currentCategory: "All",
            libraryPaths: ["C:/lib"],
            rootPath: "C:/lib",
        });
        const ctx = realm.context;
        ctx.ensureCatalogFresh();

        const countsBefore = JSON.stringify(ctx.TemplateCatalog.sectionCounts(section));
        const catsBefore = JSON.stringify(ctx.TemplateCatalog.categories(section));
        const idsBefore = JSON.stringify(ctx.TemplateCatalog.idsFor(section, "All", "lower"));
        const favIdsBefore = JSON.stringify(ctx.TemplateCatalog.idsFor(section, "Favorites", ""));

        ctx.allTemplates.forEach(function (rec, i) {
            rec.thumbnail = "file:///C:/lib/x" + i + ".png?v=" + i;
            rec.thumbnailPath = "C:/lib/x" + i + ".png";
            rec.thumbStatus = i % 2 === 0 ? "ready" : "failed";
            ctx.TemplateCatalog.patch(rec);
        });

        expect(JSON.stringify(ctx.TemplateCatalog.sectionCounts(section))).toBe(countsBefore);
        expect(JSON.stringify(ctx.TemplateCatalog.categories(section))).toBe(catsBefore);
        expect(JSON.stringify(ctx.TemplateCatalog.idsFor(section, "All", "lower"))).toBe(idsBefore);
        expect(JSON.stringify(ctx.TemplateCatalog.idsFor(section, "Favorites", ""))).toBe(favIdsBefore);
        // Not one of the three fields is searchable, so searchHay did not move.
        expect(ctx.TemplateCatalog.idsFor(section, "All", "?v=")).toEqual([]);
        expect(ctx.TemplateCatalog.idsFor(section, "All", "failed")).toEqual([]);
        // And the records the catalog hands back DO carry the new values, because
        // it holds references — the reason the hand patch is enough.
        expect(ctx.TemplateCatalog.get("t0").thumbStatus).toBe("ready");
        expect(ctx.TemplateCatalog.get("t1").thumbStatus).toBe("failed");
        expect(realm.warnings).toEqual([]);
    });

    test("the media-completion publish path is left to the element-identity probes", function () {
        // **Validates: Requirements 3.11**
        //
        // The shared-model mutation on media completion is
        // MediaEntryRepository._publishDurable, which clears the mirror and
        // re-pushes fresh clones — every element identity changes, so the
        // first/last probes fire with no counter. Excluding it is also what keeps
        // js/core/persistence.js, a whole-file CEP-scanned unit, unmodified.
        const publish = findWitnessLine(PERSISTENCE, "MediaEntryRepository.prototype._publishDurable = function");

        observe("F4-exclusions-publish", "the external rewrite stays probe-detected", {
            at: PERSISTENCE + ":" + publish.line,
            signalOccurrencesInModule: countIdentifier(repoText(PERSISTENCE), SIGNAL),
        });

        expect(countIdentifier(repoText(PERSISTENCE), SIGNAL)).toBe(0);
        // P7 is the behavioural half of this exclusion; it asserts the rewrite is
        // still detected with the counter provably unmoved.
    });
});

// ════════════════════════════════════════════════════════════════════════════
// P8 -> Property 4 (clause 3.5)
// patchUITemplate keeps its matching rule, its catalog call and its routing.
//
// Three obligations, none of which BUG 2 or BUG 5 may move:
//   - the in-memory match is name + category + SECTION (so a same-named card in
//     another section is never the one that changes),
//   - TemplateCatalog.patch(mutated, before) is still called, with `before`
//     carrying the PRE-patch category / favorite / section,
//   - the render path is filterAndRender exactly when the existing
//     recordChangedView test holds, and patchTemplateCard otherwise.
//
// Generated over the three real call shapes (favourite toggle, rename, move —
// templates.js:2269, :2703, :2759), with and without an active search, and with
// currentCategory === "Favorites".
// ════════════════════════════════════════════════════════════════════════════
describe("P8 — patchUITemplate matching, catalog call and render routing", function () {
    const ROOT = "C:/lib";

    const p8Arb = fc.record({
        sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
        size: fc.integer({ min: 1, max: 8 }),
        targetPick: fc.integer({ min: 0, max: 7 }),
        kind: fc.constantFrom("favorite", "rename", "move"),
        search: fc.constantFrom("", "  ", "lower"),
        currentCategory: fc.constantFrom("All", "Favorites", "Logos", "Brands"),
        withDecoys: fc.boolean(),
    });

    test("the matched record, the before shape and the render path are all unmoved", function () {
        // **Validates: Requirements 3.4, 3.5**
        const kindsSeen = {};
        const routesSeen = {};

        fc.assert(
            fc.property(p8Arb, function (spec) {
                const section = SECTION_VALUES[spec.sectionIdx];
                const otherSection = SECTION_VALUES[(spec.sectionIdx + 1) % SECTION_VALUES.length];
                const records = freshLibrary(spec.size, section, ROOT);
                const t = spec.targetPick % records.length;
                const target = records[t];
                const name = target.name;
                const cat = target.category;

                // Decoys the matching rule must skip. All share `sourcePath`, so
                // getTemplateSourcePath's name+category-only match cannot change
                // the reconstructed folder path whichever one it finds first.
                const decoys = [];
                if (spec.withDecoys && otherSection !== section) {
                    decoys.push({
                        id: "decoy-section", name: name, category: cat,
                        section: otherSection, type: otherSection, favorite: !target.favorite,
                        folderPath: ROOT + "/decoy-section/" + t, sourcePath: ROOT,
                    });
                }
                if (spec.withDecoys) {
                    decoys.push({
                        id: "decoy-cat", name: name, category: cat + "~other",
                        section: section, type: section, favorite: !target.favorite,
                        folderPath: ROOT + "/decoy-cat/" + t, sourcePath: ROOT,
                    });
                    decoys.push({
                        id: "decoy-name", name: name + "~other", category: cat,
                        section: section, type: section, favorite: !target.favorite,
                        folderPath: ROOT + "/decoy-name/" + t, sourcePath: ROOT,
                    });
                }
                const all = records.concat(decoys);

                const realm = createPanelRealm({
                    allTemplates: all,
                    currentSection: section,
                    currentCategory: spec.currentCategory,
                    search: spec.search,
                    libraryPaths: [ROOT],
                    rootPath: ROOT,
                });
                const ctx = realm.context;

                // The folder path the helper reconstructs, resolved through the
                // real helper so the index is seeded at the key it will address.
                const fp = ctx._getTemplateFolderPath(name, cat);
                const seedEntries = [{
                    id: target.id, name: name, category: cat, section: section,
                    type: section, favorite: target.favorite, folderPath: fp,
                    sourcePath: ROOT, thumbStatus: "ready",
                    thumbnailPath: fp + "/thumbnail.png",
                }];
                all.forEach(function (rec) {
                    if (rec.folderPath === fp) return;
                    seedEntries.push({
                        id: rec.id, name: rec.name, category: rec.category,
                        section: rec.section, type: rec.type, favorite: rec.favorite,
                        folderPath: rec.folderPath, sourcePath: ROOT,
                    });
                });
                const li = persistIndex(seedEntries);
                realm.setIndex(li);

                ctx.ensureCatalogFresh();
                realm.resetCatalogSpies();

                // Recorders for the two render paths. patchUITemplate resolves
                // both as globals at call time, so replacing the context
                // property is enough.
                const renders = { filterAndRender: 0, patchTemplateCard: [] };
                ctx.filterAndRender = function () { renders.filterAndRender++; };
                ctx.patchTemplateCard = function (record) { renders.patchTemplateCard.push(record); return true; };

                // Pre-patch snapshots.
                const expectedBefore = {
                    category: target.category,
                    favorite: target.favorite,
                    section: getTemplateSectionUtil(target),
                };
                const decoySnapshots = decoys.map(shallowClone);
                const otherSnapshots = records
                    .filter(function (r) { return r !== target; })
                    .map(function (r) { return { ref: r, snap: shallowClone(r) }; });

                // The three real call shapes.
                let patchObj, newName, newCat;
                if (spec.kind === "favorite") {
                    patchObj = { favorite: !target.favorite };
                    newName = undefined; newCat = undefined;
                } else if (spec.kind === "rename") {
                    newName = name + " renamed";
                    patchObj = { name: newName, id: pathBuilders.generateTemplateId(newName) };
                    newCat = undefined;
                } else {
                    newCat = cat === "Logos" ? "Brands" : "Logos";
                    patchObj = { category: newCat };
                    newName = undefined;
                }

                const structural = newName !== undefined || newCat !== undefined;
                const expectChangedView =
                    (spec.currentCategory === "Favorites" &&
                        Object.prototype.hasOwnProperty.call(patchObj, "favorite")) ||
                    structural ||
                    spec.search.trim() !== "";

                ctx.patchUITemplate(name, cat, patchObj, newName, newCat);

                kindsSeen[spec.kind] = (kindsSeen[spec.kind] || 0) + 1;
                const route = expectChangedView ? "filterAndRender" : "patchTemplateCard";
                routesSeen[route] = (routesSeen[route] || 0) + 1;

                observe("P8", "patchUITemplate's matching, catalog call and routing", {
                    section: section,
                    kind: spec.kind,
                    currentCategory: spec.currentCategory,
                    search: JSON.stringify(spec.search),
                    reconstructedFolderPath: fp,
                    expectChangedView: expectChangedView,
                    filterAndRenderCalls: renders.filterAndRender,
                    patchTemplateCardCalls: renders.patchTemplateCard.length,
                    catalogPatchCalls: realm.catalog.patch.length,
                    beforeShape: expectedBefore,
                    observedBefore: realm.catalog.patch.length ? realm.catalog.patch[0].before : null,
                });

                // ── The match is by name + category + section ───────────────
                expect(realm.catalog.patch.length).toBe(1);
                expect(realm.catalog.patch[0].record).toBe(target);

                // ── TemplateCatalog.patch(mutated, before), same before shape ─
                const before = realm.catalog.patch[0].before;
                expect(before).toEqual(expectedBefore);
                expect(Object.keys(before).sort()).toEqual(["category", "favorite", "section"]);

                // ── The patch landed on the matched record only ─────────────
                for (const key in patchObj) {
                    if (Object.prototype.hasOwnProperty.call(patchObj, key)) {
                        expect(target[key]).toBe(patchObj[key]);
                    }
                }
                if (newName !== undefined) expect(target.name).toBe(newName);
                if (newCat !== undefined) expect(target.category).toBe(newCat);

                decoys.forEach(function (d, i) {
                    expect(shallowClone(d)).toEqual(decoySnapshots[i]);
                });
                otherSnapshots.forEach(function (pair) {
                    expect(shallowClone(pair.ref)).toEqual(pair.snap);
                });

                // ── The routing choice ──────────────────────────────────────
                if (expectChangedView) {
                    expect(renders.filterAndRender).toBe(1);
                    expect(renders.patchTemplateCard.length).toBe(0);
                } else {
                    expect(renders.filterAndRender).toBe(0);
                    expect(renders.patchTemplateCard.length).toBe(1);
                    expect(renders.patchTemplateCard[0]).toBe(target);
                }

                // ── The persisted side of the same mutation ─────────────────
                const persisted = li.getEntry(fp);
                expect(persisted).not.toBeNull();
                expect(persisted.folderPath).toBe(fp);
                for (const key2 in patchObj) {
                    if (Object.prototype.hasOwnProperty.call(patchObj, key2)) {
                        expect(persisted[key2]).toBe(patchObj[key2]);
                    }
                }
                expect(li.needsFullScan()).toBe(false);
                expect(realm.spies.saveLibraryIndex).toBe(1);
                expect(realm.warnings).toEqual([]);

                return true;
            }),
            { numRuns: 40, seed: 20260909 }
        );

        // Non-vacuity: all three call shapes and BOTH render routes were reached.
        expect(kindsSeen.favorite).toBeGreaterThan(0);
        expect(kindsSeen.rename).toBeGreaterThan(0);
        expect(kindsSeen.move).toBeGreaterThan(0);
        expect(routesSeen.filterAndRender).toBeGreaterThan(0);
        expect(routesSeen.patchTemplateCard).toBeGreaterThan(0);
    }, 240000);
});

// ════════════════════════════════════════════════════════════════════════════
// P9 -> Property 7 (clauses 3.8, 3.9)
// renderTemplateCardMarkup's URL guard, and the never-reached-renderer
// witnesses.
//
// The part observable pre-fix: an already-file:/// value goes through verbatim,
// anything else is file:///-prefixed and encodeURI-ed, and a media card whose
// thumbnail is still pending keeps its stable <img class="thumb-img"> patch
// target. BUG 4's deletion of renderIcons must leave all three untouched —
// renderTemplateCardMarkup is one of the two regions
// tests/media-cep-compatibility.test.js scans, so it is not edited at all.
// ════════════════════════════════════════════════════════════════════════════
describe("P9 — the renderTemplateCardMarkup thumbnail guard", function () {
    const guardRealm = createPanelRealm({ currentSection: SECTIONS.ICON });
    const gctx = guardRealm.context;

    /** The guard, reproduced from templates.js:805-810 for the expected value. */
    function expectedThumbSrc(thumbnail) {
        let thumbSrc = thumbnail ? ("" + thumbnail).replace(/\\/g, "/") : "";
        if (thumbSrc && !/^file:\/\/\//i.test(thumbSrc)) {
            let fwd = thumbSrc;
            if (fwd.charAt(0) === "/") fwd = fwd.substring(1);
            thumbSrc = "file:///" + encodeURI(fwd);
        }
        return thumbSrc;
    }

    const SHAPES = ["raw", "file-url", "file-url-backslash", "file-url-upper", "empty", "absent"];

    test("already-file:/// passes through verbatim; anything else is prefixed and encoded", function () {
        // **Validates: Requirements 3.8**
        const shapesSeen = {};
        fc.assert(
            fc.property(
                fc.record({
                    rowIdx: fc.integer({ min: 0, max: PREFIX_URL_ROWS.length - 1 }),
                    shape: fc.constantFrom.apply(fc, SHAPES),
                    isMedia: fc.boolean(),
                    sectionIdx: fc.integer({ min: 0, max: SECTION_VALUES.length - 1 }),
                    favorite: fc.boolean(),
                }),
                function (spec) {
                    const row = PREFIX_URL_ROWS[spec.rowIdx];
                    const section = SECTION_VALUES[spec.sectionIdx];
                    shapesSeen[spec.shape] = (shapesSeen[spec.shape] || 0) + 1;

                    const rec = {
                        id: "tpl-" + spec.rowIdx,
                        name: "Card " + spec.rowIdx,
                        category: "Logos",
                        section: section,
                        type: spec.isMedia ? "media" : section,
                        favorite: spec.favorite,
                        folderPath: "C:/lib/" + section + "/Logos/card",
                    };
                    if (spec.isMedia) rec.mediaType = "video";

                    if (spec.shape === "raw") rec.thumbnail = row.raw;
                    else if (spec.shape === "file-url") rec.thumbnail = row.url;
                    else if (spec.shape === "file-url-backslash") rec.thumbnail = "file:///C:\\lib\\icon\\a.png";
                    else if (spec.shape === "file-url-upper") rec.thumbnail = "FILE:///C:/lib/icon/a.png";
                    else if (spec.shape === "empty") rec.thumbnail = "";
                    // "absent": no thumbnail key at all.

                    const markup = gctx.renderTemplateCardMarkup(rec, section, []);
                    const expected = expectedThumbSrc(rec.thumbnail);

                    observe("P9", "the guard's output for the first generated record", {
                        shape: spec.shape,
                        thumbnailIn: rec.thumbnail === undefined ? "<absent>" : rec.thumbnail,
                        expectedSrc: expected,
                        emittedThumbBox: markup.slice(
                            markup.indexOf('<div class="thumb-box">'),
                            markup.indexOf("</div>", markup.indexOf('<div class="thumb-box">')) + 6
                        ),
                    });

                    if (expected) {
                        expect(markup).toContain(
                            '<img class="thumb-img" src="' + escapeAttr(expected) + '" alt="">'
                        );
                        // An already-file:/// value is NOT re-encoded.
                        if (/^file:\/\/\//i.test(("" + rec.thumbnail).replace(/\\/g, "/"))) {
                            expect(expected).toBe(("" + rec.thumbnail).replace(/\\/g, "/"));
                        } else {
                            expect(expected.indexOf("file:///")).toBe(0);
                        }
                    } else if (spec.isMedia) {
                        // Clause 3.8: the stable patch target for a pending card.
                        expect(markup).toContain('<div class="thumb-box"><img class="thumb-img" alt=""></div>');
                    } else if (section === SECTIONS.EFFECT) {
                        expect(markup).toContain('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>');
                        expect(markup.indexOf("<img")).toBe(-1);
                    } else {
                        expect(markup).toContain('<rect x="3" y="3" width="18" height="18" rx="3"/>');
                        expect(markup.indexOf("<img")).toBe(-1);
                    }

                    // data-thumb always mirrors the resolved src.
                    expect(markup).toContain('data-thumb="' + escapeAttr(expected) + '"');
                    return true;
                }
            ),
            { numRuns: 800, seed: 20260910 }
        );

        SHAPES.forEach(function (s) { expect(shapesSeen[s]).toBeGreaterThan(0); });
    }, 60000);

    test("the never-reached-renderer witnesses are where the design says", function () {
        // **Validates: Requirements 3.9**
        //
        // WITNESS POINTER — nothing is modified. Both files stub renderIcons by
        // ASSIGNING over the context global after templates.js has been
        // evaluated, and assert the stub is never called. Task 8.1's deletion of
        // the declaration cannot affect either, which is why D2 chose delete
        // over align. Their own assertions are not restated here.
        const KEYED = "tests/keyed-media-card-helper.test.js";
        const SINGLE = "tests/single-card-patch-job-completion.property.test.js";

        // Located by content, not by line number. The never-invoked assertion
        // recurs in six of keyed-media-card-helper's tests; the one the design
        // cites is the insert-and-patch case, which is the only one sitting
        // directly below that file's single-successful-patch assertion — so the
        // pair together still resolves to exactly one line.
        const keyedLine = findWitnessLine(KEYED, "expect(panel.rendererCalls).toEqual([]);", {
            precededBy: "expect(panel.patches).toEqual([true]);",
        });
        const singleLine = findWitnessLine(SINGLE, "expect(panel.rendererCalls).toEqual([]);");

        observe("P9-witnesses", "the named never-reached-renderer witnesses", {
            witnesses: [KEYED + ":" + keyedLine.line, SINGLE + ":" + singleLine.line],
            keyedLine: keyedLine.text.trim(),
            singleLine: singleLine.text.trim(),
        });

        expect(keyedLine.text).toContain("expect(panel.rendererCalls).toEqual([])");
        expect(singleLine.text).toContain("expect(panel.rendererCalls).toEqual([])");
        // ...and both really do stub renderIcons by assignment, which is what
        // makes them survive the deletion.
        expect(repoText(KEYED)).toContain("renderIcons");
        expect(repoText(SINGLE)).toContain("renderIcons");

        // P9's renderIcons-absent half is the next test in this describe
        // (was [DEFERRED -> task 8.3]). The two witness lines asserted above
        // still read identically after the deletion, which is the check that
        // deleting the declaration broke neither of them.
    });

    // ────────────────────────────────────────────────────────────────────────
    // P9's deferred half, landed by task 8.3. Two obligations, in the order the
    // design states them:
    //
    //   1. renderIcons is GONE from js/templates/templates.js and unreferenced
    //      anywhere in js/** or index.html. Exploration case E9 recorded the
    //      pre-fix state — exactly one occurrence, its own declaration, zero
    //      references — which is what licensed deleting it instead of aligning
    //      it (design decision D2).
    //   2. No remaining js/** markup builder emits an <img src> derived from a
    //      `thumbnail` without the scheme-prefix-and-encodeURI handling.
    //
    // The second obligation is quantified over the whole of js/**, not over a
    // named list, so a NEW unguarded builder fails it too. Emission sites are
    // discovered by scanning for a string literal that opens an <img> tag, and
    // the function enclosing each one is resolved by INDENTATION (the same
    // technique findFunctionBody uses) so it works for templates.js's bare
    // top-level declarations and for textanim.js's IIFE-nested ones alike.
    //
    // The guard rule: any enclosing body that BOTH reads a `.thumbnail`
    // property AND opens an <img> must carry the handling — inline as
    // `"file:///" + encodeURI(`, or by delegating to buildBustedThumbUrl.
    // renderIcons satisfied neither, which is exactly why it was the asymmetry
    // clause 1.7 named; it is also why this rule is non-vacuous rather than
    // trivially true, and the non-vacuity is asserted rather than assumed.
    // ────────────────────────────────────────────────────────────────────────
    describe("P9 — renderIcons is gone and no unguarded <img src> builder remains", function () {
        const TEMPLATES = "js/templates/templates.js";
        const INDEX = "index.html";

        /** A string literal opening an <img> tag — skips prose mentions in comments. */
        const IMG_EMIT = /['"]<img\b/;
        /** A read of a `thumbnail` property. `.thumbnailPath` must not match. */
        const THUMB_READ = /\.thumbnail\b/;
        /** The two admissible spellings of the scheme-prefix-and-encodeURI rule. */
        const GUARD_INLINE = '"file:///" + encodeURI(';
        const GUARD_HELPER = "buildBustedThumbUrl(";

        /**
         * The named `function` declaration enclosing 0-based line `idx`, resolved
         * by indentation: the nearest declaration above it whose own
         * `<indent>}` closer sits at or below `idx`. Returns null when the line
         * is at file scope.
         */
        function enclosingFunctionAt(lines, idx) {
            for (let i = idx; i >= 0; i--) {
                const m = /^(\s*)function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[i]);
                if (!m) continue;
                const closer = m[1] + "}";
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j] !== closer) continue;
                    if (j < idx) break; // closed above idx — keep walking up
                    return {
                        name: m[2],
                        startLine: i + 1,
                        endLine: j + 1,
                        text: lines.slice(i, j + 1).join("\n"),
                    };
                }
            }
            return null;
        }

        test("renderIcons is absent from templates.js and unreferenced in js/** and index.html", function () {
            // **Validates: Requirements 2.7, 2.8, 3.8**
            const scanned = jsSourceFiles().concat(MARKUP_FILES);
            const occurrences = [];
            scanned.forEach(function (rel) {
                repoLines(rel).forEach(function (line, i) {
                    if (/\brenderIcons\b/.test(line)) {
                        occurrences.push({ file: rel, line: i + 1, text: line.trim() });
                    }
                });
            });

            observe("P9-absent", "every renderIcons occurrence left in js/** and index.html", {
                filesScanned: scanned.length,
                occurrences: occurrences,
            });

            // The declaration itself is gone…
            expect(/\brenderIcons\b/.test(repoText(TEMPLATES))).toBe(false);
            // …and E9's zero-reference claim now holds across the whole surface,
            // declaration included.
            expect(occurrences).toEqual([]);
            // Non-vacuity: the scan really did read the files it claims to.
            expect(scanned.indexOf(TEMPLATES)).toBeGreaterThan(-1);
            expect(scanned.indexOf(INDEX)).toBeGreaterThan(-1);
            expect(repoText(TEMPLATES).length).toBeGreaterThan(4000);
        });

        test("every js/** <img> builder that reads a thumbnail carries the guard", function () {
            // **Validates: Requirements 2.8, 3.8**
            const sites = [];
            jsSourceFiles().forEach(function (rel) {
                const lines = repoLines(rel);
                lines.forEach(function (line, i) {
                    if (!IMG_EMIT.test(line)) return;
                    const fn = enclosingFunctionAt(lines, i);
                    sites.push({
                        file: rel,
                        line: i + 1,
                        fn: fn ? fn.name : "<file scope>",
                        readsThumbnail: !!fn && THUMB_READ.test(fn.text),
                        guardInline: !!fn && fn.text.indexOf(GUARD_INLINE) !== -1,
                        guardHelper: !!fn && fn.text.indexOf(GUARD_HELPER) !== -1,
                    });
                });
            });

            const thumbnailBuilders = sites.filter(function (s) { return s.readsThumbnail; });
            const unguarded = thumbnailBuilders.filter(function (s) {
                return !s.guardInline && !s.guardHelper;
            });

            observe("P9-builders", "every js/** <img> emission site and how it resolves its src", {
                sites: sites,
                thumbnailBuilders: thumbnailBuilders.map(function (s) {
                    return s.file + ":" + s.line + " (" + s.fn + ")" +
                        (s.guardInline ? " inline guard" : "") +
                        (s.guardHelper ? " buildBustedThumbUrl" : "");
                }),
                unguarded: unguarded,
            });

            // The obligation.
            expect(unguarded).toEqual([]);

            // Non-vacuity, three ways: sites were found at all, at least one of
            // them really does derive its src from a `thumbnail`, and the
            // deleted builder is not among them.
            expect(sites.length).toBeGreaterThan(0);
            expect(thumbnailBuilders.length).toBeGreaterThan(0);
            expect(sites.every(function (s) { return s.fn !== "<file scope>"; })).toBe(true);
            expect(sites.some(function (s) { return s.fn === "renderIcons"; })).toBe(false);
            // renderTemplateCardMarkup is the surviving guarded producer, and it
            // guards inline — the copy of the rule D2 declined to duplicate.
            expect(thumbnailBuilders.some(function (s) {
                return s.file === TEMPLATES && s.fn === "renderTemplateCardMarkup" && s.guardInline;
            })).toBe(true);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// P10 -> Property 10 (clauses 3.12, 3.13, 2.12)
// The startup scan section list is unchanged.
//
// This is the EXECUTABLE FORM of BUG 6's no-change decision. `element` stays out
// of STARTUP_SCAN_SECTIONS because the host expands an overlay-filtered chunk to
// both folders; adding it would make the panel issue two chunks that each return
// both, duplicating every overlay and element record. Task 7 adds a comment and
// nothing else, so every assertion below must read the same before and after.
// ════════════════════════════════════════════════════════════════════════════
describe("P10 — STARTUP_SCAN_SECTIONS and the active-section-first scan order", function () {
    const CANONICAL = ["comp", "layer", "text", "footage", "effect", "icon", "overlay"];

    test("the list is exactly the seven canonical folders, in order, with no element", function () {
        // **Validates: Requirements 2.12, 3.12, 3.13**
        const realm = createPanelRealm({ currentSection: SECTIONS.OVERLAY });
        const ctx = realm.context;

        observe("P10", "the panel's startup scan surface", {
            STARTUP_SCAN_SECTIONS: ctx.STARTUP_SCAN_SECTIONS,
            SECTION_SCAN_FOLDERS: ctx.SECTION_SCAN_FOLDERS,
        });

        expect(ctx.STARTUP_SCAN_SECTIONS).toEqual(CANONICAL);
        expect(ctx.STARTUP_SCAN_SECTIONS.length).toBe(7);
        expect(ctx.STARTUP_SCAN_SECTIONS.indexOf("element")).toBe(-1);
        // The alias that makes the seven-folder list complete (clause 3.13).
        expect(ctx.SECTION_SCAN_FOLDERS.element).toBe("overlay");
        // ...and `element` never appears as a scan folder VALUE either, so no
        // chunk can be requested by that name.
        Object.keys(ctx.SECTION_SCAN_FOLDERS).forEach(function (k) {
            expect(CANONICAL.indexOf(ctx.SECTION_SCAN_FOLDERS[k])).toBeGreaterThan(-1);
        });
    });

    test("startupScanSectionOrder puts the active folder first and keeps the other six fixed", function () {
        // **Validates: Requirements 3.12**
        const realm = createPanelRealm({});
        const ctx = realm.context;
        const seen = {};

        fc.assert(
            fc.property(
                fc.constantFrom.apply(fc, SECTION_VALUES.concat(["element", "text_props", "not-a-section", ""])),
                function (section) {
                    ctx.currentSection = section;
                    seen[section] = (seen[section] || 0) + 1;

                    const activeFolder = ctx.SECTION_SCAN_FOLDERS[section];
                    const active = typeof activeFolder === "string" ? activeFolder : "";
                    const expected = [];
                    if (active !== "") expected.push(active);
                    CANONICAL.forEach(function (s) { if (s !== active) expected.push(s); });

                    const order = ctx.startupScanSectionOrder();

                    observe("P10-order", "the scan order for the first generated section", {
                        section: JSON.stringify(section),
                        activeSectionScanFolder: ctx.activeSectionScanFolder(),
                        order: order,
                        expected: expected,
                    });

                    expect(ctx.activeSectionScanFolder()).toBe(active);
                    expect(order).toEqual(expected);
                    // Exactly the seven folders, no duplicates, none added.
                    expect(order.length).toBe(7);
                    expect(order.slice().sort()).toEqual(CANONICAL.slice().sort());
                    expect(order.indexOf("element")).toBe(-1);
                    return true;
                }
            ),
            { numRuns: 200, seed: 20260911 }
        );

        // The two aliased sections and the unknown-section degradation were all
        // exercised, so the flattening rule is not tested vacuously.
        expect(seen["element"]).toBeGreaterThan(0);
        expect(seen["text_props"]).toBeGreaterThan(0);
        expect(seen["not-a-section"]).toBeGreaterThan(0);
    });

    test("element and text_props both fold onto an existing canonical folder", function () {
        // **Validates: Requirements 2.12, 3.13**
        const realm = createPanelRealm({ currentSection: SECTIONS.ELEMENT });
        const ctx = realm.context;

        expect(ctx.activeSectionScanFolder()).toBe("overlay");
        expect(ctx.startupScanSectionOrder()[0]).toBe("overlay");
        ctx.currentSection = SECTIONS.TEXT_PROPS;
        expect(ctx.activeSectionScanFolder()).toBe("text");
        expect(ctx.startupScanSectionOrder()[0]).toBe("text");
    });
});

// ════════════════════════════════════════════════════════════════════════════
// P12 -> Property 2 — WITNESS POINTER, nothing is modified.
//
// The four startup performance suites seed records with `thumbnail: ""` and NO
// thumbnailPath, so BUG 1's warm-paint derivation is INERT for every fixture
// they build: hydrateWarmPaintThumbnail returns false on its second guard
// (`typeof entry.thumbnailPath !== "string"`). That is why all four stay green
// by construction and are re-run as-is rather than edited.
//
// The strongest available witness without copying any of their assertions:
// `thumbnailPath` does not occur ANYWHERE in any of the four files, and every
// `thumbnail: ""` seed write the design cites is still exactly that.
//
// The seeds are located by content and counted, not addressed by line number.
// `seeds` is the number the design names per file (startup-lifecycle has two,
// at what were :548 and :1082); requiring that exact count is what keeps this a
// statement about the KNOWN fixture set — a new seed appearing means the four
// suites need re-confirming as inert, not silently absorbing.
// ════════════════════════════════════════════════════════════════════════════
describe("P12 — the four startup performance suites are inert warm-paint fixtures", function () {
    const WITNESSES = [
        { file: "tests/performance/startup-warm-paint.property.test.js", seeds: 1 },
        { file: "tests/performance/startup-reconcile.property.test.js", seeds: 1 },
        { file: "tests/performance/startup-lifecycle.property.test.js", seeds: 2 },
        { file: "tests/performance/cold-start-progressive.property.test.js", seeds: 1 },
    ];

    test("each suite seeds thumbnail: \"\" and never mentions thumbnailPath", function () {
        // **Validates: Requirements 3.2, 3.3**
        const detail = [];
        WITNESSES.forEach(function (w) {
            const text = repoText(w.file);
            const seedLines = findWitnessLines(w.file, 'thumbnail: "",', w.seeds);
            detail.push({
                file: w.file,
                seedLines: seedLines.map(function (row) {
                    return { line: row.line, text: row.text.trim() };
                }),
                thumbnailPathOccurrences: (text.match(/thumbnailPath/g) || []).length,
            });

            seedLines.forEach(function (row) {
                expect(row.text.trim()).toBe('thumbnail: "",');
            });
            // No thumbnailPath anywhere: the derivation's second guard rejects
            // every one of these fixtures, so all four suites are byte-unaffected.
            expect(text.indexOf("thumbnailPath")).toBe(-1);
        });

        observe("P12", "the four inert startup fixtures", { witnesses: detail });

        // The design also names startup-warm-paint's makeEntry block (:378-389
        // as cited); confirm the seed factory really is that block, by anchoring
        // on its declaration and checking the closing `};` lands where a
        // 12-line factory puts it rather than at a fixed line number.
        const makeEntry = findWitnessBlock(
            WITNESSES[0].file,
            "function makeEntry(",
            "};"
        );
        expect(makeEntry.lines[0]).toContain("function makeEntry(");
        expect(makeEntry.endLine - makeEntry.startLine).toBe(11);
        expect(makeEntry.lines[makeEntry.lines.length - 1].trim()).toBe("};");
        // ...and the inert seed is one of that factory's own fields.
        expect(makeEntry.text).toContain('thumbnail: "",');
    });
});
