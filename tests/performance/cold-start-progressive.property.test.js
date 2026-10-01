/**
 * Responsive cold start with progressive batches — property suite
 * ===============================================================
 *
 * Feature: panel-reopen-startup (Wave 2, master prompt item 7)
 *
 * What is under test
 * ------------------
 * The REAL cold half of `js/templates/templates.js` — `showStartupLoadingState`,
 * the section-chunked scanner (`startupScanRootBySection`,
 * `startupScanSectionOrder`, `STARTUP_SCAN_SECTIONS`), `activeSectionScanFolder`,
 * `renderCardsFirstBatch`, `appendCardBatch`, `filterStartupRecordsFrom`,
 * `filterAndRender`, `renderCards` — driven end to end over:
 *
 *   - a REAL parsed DOM tree (tests/helpers/miniDom.js), so every card the panel
 *     paints is a parsed element and the grid's card count is a real count,
 *   - a REAL `LibraryIndex` instance from `js/core/persistence.js` whose
 *     `_entries` / `validityKey` writes are observed through instance accessors,
 *     so "nothing persistent is written early" is read off the object the panel
 *     would have persisted,
 *   - the REAL startup trace recorder of `js/core/observability.js`, so the
 *     bridge-scan counts come from shipped instrumentation.
 *
 * Only the CEP bridge is substituted, and only at its own boundary: a recording
 * `csInterface.evalScript` that keeps every call's script string verbatim (so the
 * presence and the value of the second `sHex` argument are observable) and that
 * DEFERS every callback, so the arrival interleaving is generated rather than
 * being a consequence of the call order.
 *
 * The scan contract
 * -----------------
 * `getAllTemplates` is ExtendScript: it runs on After Effects' main thread and
 * blocks the whole application while it walks. Measured on a 326-template
 * library, ONE all-sections call blocks the host for 74 s, while a single-section
 * call costs ~30 ms of fixed overhead plus that section's own templates. So the
 * cold path issues one `getAllTemplates(rHex, sHex)` call PER SECTION FOLDER,
 * sequentially — the call for the next section is issued from inside the previous
 * section's callback, which is the yield that hands the host back — with the
 * ACTIVE section first, and flattens the accumulated sections back into the fixed
 * folder order so the finished record list is byte-identical to the single call it
 * replaces.
 *
 * How "a single unchunked all-sections scan" is decided
 * ----------------------------------------------------
 * Not by re-implementing the merge, and not by a second run of the same code:
 * since every call is now section-scoped there is no unchunked run to compare
 * against. The reference is computed from the synthetic library itself —
 * `unchunkedPayload()` concatenates the seven section folders in the fixed order
 * `jsx/core.jsx` walks them, which IS the record list one all-sections call
 * returns — and the property asserts the shipped fixed order agrees with that
 * table. The completed record set, its ORDER, and the final rendered card set are
 * all compared against it.
 */

"use strict";

const path = require("path");
const fc = require("fast-check");

const { loadHelpers } = require("../helpers/loadHelpers.js");
const { createMiniDocument, MiniElement } = require("../helpers/miniDom.js");
const { LibraryIndex } = require("../../js/core/persistence.js");
const PerfEvents = require("../../js/core/observability.js");

// Two shipped realms per generated case (the healthy run and the failed-section
// run), 100 cases.
jest.setTimeout(600000);

// ─── Real shared modules loaded once (pure lookup tables + pure helpers) ─────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
});
const getTemplateSection = utils.get("getTemplateSection");

const SECTION_VALUES = Object.keys(SECTIONS).map(function (key) { return SECTIONS[key]; });

// The six card grids index.html defines; resolveSectionGridId() picks one.
const GRID_IDS = [
    "comp-list-container",
    "icon-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container",
];

// First_Batch as fixed by the design (Requirement 3.1).
const FIRST_BATCH = 60;

// The section -> ExtendScript folder mapping the design declares (design.md §7).
// Held here INDEPENDENTLY of the shipped SECTION_SCAN_FOLDERS so Requirement 10.3
// ("cover every member of SECTIONS") is a real claim: the property asserts the
// shipped activeSectionScanFolder() agrees with this table for every section, and
// the harness lays its synthetic library out according to this table.
const EXPECTED_FOLDER = {
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

// The seven section folders jsx/core.jsx walks, IN THE ORDER it walks them, and
// which sections a record inside each of them may carry. Two folders are shared
// by two sections, which is what makes a scoped scan a superset of the active
// section's records. The order is the record order one all-sections call
// produces, so it is also the oracle for the flattened chunked result.
const FOLDER_POOL = ["comp", "layer", "text", "footage", "effect", "icon", "overlay"];
const FOLDER_SECTIONS = {
    comp: [SECTIONS.COMP],
    layer: [SECTIONS.LAYER],
    text: [SECTIONS.TEXT, SECTIONS.TEXT_PROPS],
    footage: [SECTIONS.FOOTAGE],
    effect: [SECTIONS.EFFECT],
    icon: [SECTIONS.ICON],
    overlay: [SECTIONS.OVERLAY, SECTIONS.ELEMENT],
};

const CATEGORIES = ["Titles", "Transitions", "Uncategorized"];
const ROOT_POOL = ["C:/lib/alpha", "C:/lib/beta", "D:/shared/gamma"];

// ─── Hex transport, exactly as the bridge encodes it ────────────────────────
function encodeHex(value) {
    return Buffer.from(String(value), "utf8").toString("hex");
}
function decodeHex(value) {
    return Buffer.from(String(value), "hex").toString("utf8");
}

// ─── Generated library layout ───────────────────────────────────────────────
/**
 * The synthetic library, per root: a list of `{ folder, record }` pairs. The
 * folder is where ExtendScript would find the record, so it decides which
 * section-scoped call returns it; the record's `section` decides whether the
 * panel renders it. `sourcePath` is deliberately absent — the panel is the only
 * thing that may add it (Requirement 10.6).
 */
function buildLibrary(scenario) {
    const byRoot = {};
    const activeFolder = EXPECTED_FOLDER[scenario.section];

    scenario.roots.forEach(function (root, rootIndex) {
        const list = [];

        // Guaranteed records in the active section, so the first section arrival
        // always has something to paint and the property is never vacuous.
        for (let i = 0; i < scenario.matchingPerRoot; i++) {
            list.push({
                folder: activeFolder,
                record: makeRecord(root, rootIndex, "m" + i, activeFolder, scenario.section, i),
            });
        }

        // Noise across the other folders (and, where a folder is shared, across
        // the other section that lives in it), so a scoped call really is a
        // filtered slice of the library rather than the whole of it.
        scenario.noise.forEach(function (spec, n) {
            const folder = FOLDER_POOL[spec.folder % FOLDER_POOL.length];
            const sections = FOLDER_SECTIONS[folder];
            const section = sections[spec.section % sections.length];
            list.push({
                folder: folder,
                record: makeRecord(root, rootIndex, "n" + n, folder, section, n),
            });
        });

        byRoot[root] = list;
    });

    return byRoot;
}

function makeRecord(root, rootIndex, suffix, folder, section, index) {
    return {
        id: "t-" + rootIndex + "-" + suffix,
        // Unique per record across the whole library: the rendered card carries
        // it in `data-file`, which is how the grid is compared to an expectation.
        name: "Card " + rootIndex + "-" + suffix,
        category: CATEGORIES[index % CATEGORIES.length],
        section: section,
        type: section,
        favorite: index % 2 === 0,
        folderPath: root + "/" + folder + "/" + suffix,
        thumbnail: "",
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** Records a section-scoped scan of `folder` returns for one root. */
function scopedPayload(library, root, folder) {
    return library[root]
        .filter(function (item) { return item.folder === folder; })
        .map(function (item) { return clone(item.record); });
}

/**
 * The record list ONE unchunked `getAllTemplates(root)` call returns: the seven
 * section folders concatenated in the order jsx/core.jsx walks them. This is the
 * oracle the flattened chunked result is compared against.
 */
function unchunkedPayload(library, root) {
    const out = [];
    FOLDER_POOL.forEach(function (folder) {
        scopedPayload(library, root, folder).forEach(function (record) { out.push(record); });
    });
    return out;
}

/**
 * The completed record set an unchunked cold start would publish: every root's
 * unchunked payload, in library-path order, tagged with its own root and its
 * derived section — exactly the two fields the panel adds.
 */
function expectedMergedRecords(library, roots) {
    const out = [];
    roots.forEach(function (root) {
        unchunkedPayload(library, root).forEach(function (record) {
            const tagged = clone(record);
            tagged.sourcePath = root;
            tagged.section = getTemplateSection(tagged);
            out.push(tagged);
        });
    });
    return out;
}

/** The card names the active section renders, in unchunked record order. */
function expectedRenderedNames(library, roots, section) {
    return expectedMergedRecords(library, roots)
        .filter(function (record) { return getTemplateSection(record) === section; })
        .map(function (record) { return record.name; });
}

/** The records of one root the active section would render, in library order. */
function expectedMatchingNames(library, root, section) {
    return library[root]
        .filter(function (item) { return getTemplateSection(item.record) === section; })
        .map(function (item) { return item.record.name; });
}

// ─── The recording, deferring bridge ────────────────────────────────────────
/**
 * `csInterface.evalScript` keeps every call's script string verbatim and defers
 * its callback. Nothing resolves until the property delivers it, so the arrival
 * interleaving is entirely generated.
 *
 * The scan is strictly sequential per root, so at most one call per root is ever
 * outstanding: delivering a response is what issues the next section's call.
 *
 * `failure` (optional) names one arrival that must go wrong:
 *   { root, ordinal, mode: "missing" }      -> the host does not answer at all
 *   { root, ordinal, mode: "unparseable" }  -> the host answers with non-JSON
 * `ordinal` counts that root's own arrivals from zero, so ordinal 0 is the ACTIVE
 * section — the one the visible grid is waiting for.
 */
function createDeferringBridge(world, library, failure) {
    const calls = [];
    const queue = [];
    const arrivalsByRoot = {};

    const csInterface = {
        evalScript: function (script, callback) {
            const text = String(script);
            const scoped = /^getAllTemplates\("([0-9a-fA-F]*)","([0-9a-fA-F]*)"\)$/.exec(text);
            const all = scoped ? null : /^getAllTemplates\("([0-9a-fA-F]*)"\)$/.exec(text);

            const call = {
                seq: world.nextSeq(), script: text, arg2: null,
                kind: "other", root: null, folder: null,
            };
            if (scoped) {
                call.kind = "scoped";
                call.root = decodeHex(scoped[1]);
                call.arg2 = scoped[2];
                call.folder = decodeHex(scoped[2]);
            } else if (all) {
                call.kind = "all";
                call.root = decodeHex(all[1]);
            }
            calls.push(call);
            queue.push({ call: call, callback: callback, delivered: false });
        },
    };

    return {
        csInterface: csInterface,
        calls: calls,
        queue: queue,
        /** Queue indices of the responses that are in flight right now. */
        pending: function () {
            const out = [];
            for (let i = 0; i < queue.length; i++) if (!queue[i].delivered) out.push(i);
            return out;
        },
        /** Hands one in-flight response to the panel. */
        deliver: function (index) {
            const entry = queue[index];
            if (!entry || entry.delivered) return null;
            entry.delivered = true;

            const root = entry.call.root;
            const ordinal = arrivalsByRoot["r:" + root] || 0;
            arrivalsByRoot["r:" + root] = ordinal + 1;

            const broken = failure && failure.root === root && failure.ordinal === ordinal
                ? failure.mode
                : null;

            let payload = "";
            if (broken === "missing") {
                // No response at all: the host did not answer for this section,
                // so the set is incomplete rather than empty.
                payload = "";
            } else if (broken === "unparseable") {
                payload = encodeHex('[{"name":"truncated"');
            } else if (entry.call.kind === "scoped") {
                payload = encodeHex(JSON.stringify(scopedPayload(library, root, entry.call.folder)));
            } else if (entry.call.kind === "all") {
                payload = encodeHex(JSON.stringify(unchunkedPayload(library, root)));
            }

            world.noteArrival(entry.call, ordinal, broken);
            if (typeof entry.callback === "function") entry.callback(payload);
            world.sample("arrival:" + entry.call.folder);
            return { call: entry.call, ordinal: ordinal, broken: broken };
        },
    };
}

// ─── One cold-start world ───────────────────────────────────────────────────
/**
 * A fresh vm realm holding the real templates.js, a real parsed DOM with all six
 * grids instrumented, a real LibraryIndex whose persistence writes are observed,
 * a real startup trace, and the deferring bridge.
 */
function createColdWorld(scenario, library, failure) {
    const document = createMiniDocument();
    const innerHtmlDescriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "innerHTML");

    let seq = 0;
    const world = {
        scenario: scenario,
        document: document,
        grids: {},
        writes: [],
        samples: [],
        violations: [],
        loadingStateSeq: null,
        // Arrival bookkeeping: how many section responses have landed in total,
        // and how many each root has had. "Every section of every root has
        // arrived" is decided from these.
        sectionsDelivered: 0,
        deliveredByRoot: {},
        brokenArrivals: [],
        sawCards: false,
        everSeenNames: {},
        indexWrites: [],
        saves: [],
        toasts: [],
        consoleErrors: [],
        updateCounts: 0,
        nextSeq: function () { seq += 1; return seq; },
    };

    world.fail = function (message) {
        if (world.violations.length < 8) world.violations.push(message);
    };

    world.noteArrival = function (call, ordinal, broken) {
        world.sectionsDelivered++;
        const key = "r:" + call.root;
        world.deliveredByRoot[key] = (world.deliveredByRoot[key] || 0) + 1;
        if (broken) {
            world.brokenArrivals.push({ root: call.root, folder: call.folder, mode: broken, ordinal: ordinal });
        }
    };

    /** Roots that have answered every section of the shipped section list. */
    world.rootsComplete = function () {
        let done = 0;
        scenario.roots.forEach(function (root) {
            if ((world.deliveredByRoot["r:" + root] || 0) >= world.sectionsPerRoot) done++;
        });
        return done;
    };

    // ── The persisted index: a real LibraryIndex whose two startup-relevant
    // writes are visible. Requirement 10.7 is decided here.
    const li = new LibraryIndex();
    let entriesBacking = li._entries;
    let validityBacking = li.validityKey;
    Object.defineProperty(li, "_entries", {
        configurable: true,
        get: function () { return entriesBacking; },
        set: function (value) {
            world.indexWrites.push({
                field: "_entries",
                sectionsDelivered: world.sectionsDelivered,
                rootsComplete: world.rootsComplete(),
                count: value && typeof value.length === "number" ? value.length : -1,
            });
            entriesBacking = value;
        },
    });
    Object.defineProperty(li, "validityKey", {
        configurable: true,
        get: function () { return validityBacking; },
        set: function (value) {
            world.indexWrites.push({
                field: "validityKey",
                sectionsDelivered: world.sectionsDelivered,
                rootsComplete: world.rootsComplete(),
                value: value,
            });
            validityBacking = value;
        },
    });
    world.index = li;
    world.initialValidityKey = validityBacking;

    const bridge = createDeferringBridge(world, library, failure);
    world.bridge = bridge;

    const trace = PerfEvents.createStartupTrace();
    world.trace = trace;

    const consoleObject = {
        log: function () { },
        warn: function () { },
        error: function (message) { world.consoleErrors.push(String(message)); },
    };
    const windowObject = { Date: Date, console: consoleObject };

    const timers = [];
    const sandbox = loadHelpers({
        file: path.join("js", "templates", "templates.js"),
        lenient: false,
        injected: {
            window: windowObject,
            console: consoleObject,
            document: document,

            SECTIONS: SECTIONS,
            IMAGE_SECTIONS: IMAGE_SECTIONS,
            escapeAttr: utils.get("escapeAttr"),
            escapeHTML: utils.get("escapeHTML"),
            getTemplateSection: getTemplateSection,
            isTextSection: utils.get("isTextSection"),
            isImageSection: utils.get("isImageSection"),

            allTemplates: [],
            currentSection: scenario.section,
            currentCategory: "All",
            tmpBulkSelected: [],
            libraryPaths: scenario.roots.slice(),
            rootPath: scenario.roots[0],
            DOM: { "search-box": { value: "" } },

            // Cold start: a real index object with no entries, so the shipped
            // warm short-circuit declines and the cold half runs.
            getLibraryIndex: function () { return li; },
            getLastLibraryIndexLoadReason: function () { return "absent"; },
            getCombinedDiskValidityKey: function () { return "cold-disk-key"; },
            deriveCombinedValidityKeyAsync: function () {
                return { then: function () { return this; } };
            },
            saveLibraryIndex: function () {
                world.saves.push({
                    sectionsDelivered: world.sectionsDelivered,
                    rootsComplete: world.rootsComplete(),
                });
            },

            csInterface: bridge.csInterface,
            encodeBridge: encodeHex,
            decodeBridge: decodeHex,

            requestIdleCallback: function (fn) { timers.push(fn); return timers.length; },
            cancelIdleCallback: function () { return true; },
            setTimeout: function (fn) { timers.push(fn); return timers.length; },
            clearTimeout: function () { return true; },
            AppLifecycle: {
                register: function () { return { dispose: function () { } }; },
                onDispose: function () { },
            },
            PerfEvents: {
                span: PerfEvents.span,
                startupTrace: function () { return trace; },
            },

            updateCount: function () { world.updateCounts++; },
            updateCustomSelect: function () { },
            Settings: { get: function () { return []; }, set: function () { } },
            TextAnim: { attachHoverPreviews: function () { } },
            showToast: function (message, severity) {
                world.toasts.push({ message: String(message), severity: String(severity) });
            },
            nfs: function () { return { existsSync: function () { return false; } }; },
        },
    });
    world.context = sandbox.context;

    // The shipped section list and the shipped active-section folder: the scan's
    // shape is read off the module, never pinned to a literal here.
    world.sectionFolders = sandbox.context.STARTUP_SCAN_SECTIONS.slice();
    world.sectionsPerRoot = world.sectionFolders.length;
    world.activeFolder = sandbox.context.activeSectionScanFolder();
    world.expectedSectionOrder = [world.activeFolder].concat(
        world.sectionFolders.filter(function (folder) { return folder !== world.activeFolder; })
    );

    world.activeGrid = function () {
        return document.getElementById(sandbox.context.resolveSectionGridId());
    };
    world.cardNames = function () {
        const cards = world.activeGrid().querySelectorAll(".card");
        const names = [];
        for (let i = 0; i < cards.length; i++) names.push(cards[i].getAttribute("data-file"));
        return names;
    };
    world.cardCount = function () {
        return world.activeGrid().querySelectorAll(".card").length;
    };

    /**
     * The one place the running invariants are evaluated: after every grid write
     * and after every delivered response.
     *
     *   - once cards exist the grid never goes back to zero (Requirement 10.8),
     *   - the card count never DECREASES, and
     *   - no card that has ever been painted leaves the grid.
     *
     * The last two are what "no card is removed" means when a section's response
     * is missing or unparseable, and they are decided here rather than only at
     * the end.
     */
    world.sample = function (where) {
        const names = world.cardNames();
        const count = names.length;
        const previous = world.samples.length > 0
            ? world.samples[world.samples.length - 1].cards
            : 0;
        world.samples.push({ where: where, cards: count, seq: seq });

        if (count > 0) {
            world.sawCards = true;
        } else if (world.sawCards) {
            world.fail("grid returned to 0 cards at " + where);
        }
        if (count < previous) {
            world.fail("grid shrank from " + previous + " to " + count + " cards at " + where);
        }
        const present = {};
        names.forEach(function (name) {
            present[name] = true;
            world.everSeenNames[name] = true;
        });
        Object.keys(world.everSeenNames).forEach(function (name) {
            if (!present[name]) world.fail("card " + name + " left the grid at " + where);
        });
        return count;
    };

    GRID_IDS.forEach(function (gridId) {
        const grid = document.createElement("div");
        grid.id = gridId;
        grid.className = "card-grid";
        document.body.appendChild(grid);

        Object.defineProperty(grid, "innerHTML", {
            configurable: true,
            get: function () { return innerHtmlDescriptor.get.call(grid); },
            set: function (markup) {
                const text = String(markup);
                const record = {
                    seq: world.nextSeq(),
                    gridId: gridId,
                    kind: "innerHTML",
                    loadingState: text.indexOf("Loading library…") !== -1,
                    cardsInMarkup: (text.match(/class="card[ "]/g) || []).length,
                };
                world.writes.push(record);
                if (record.loadingState && world.loadingStateSeq === null) {
                    world.loadingStateSeq = record.seq;
                }
                innerHtmlDescriptor.set.call(grid, markup);
                world.sample("innerHTML:" + gridId);
            },
        });

        grid.insertAdjacentHTML = function (position, markup) {
            if (position !== "beforeend") throw new Error("harness supports beforeend only");
            world.writes.push({ seq: world.nextSeq(), gridId: gridId, kind: "append" });
            const holder = document.createElement("div");
            holder.innerHTML = String(markup);
            const moving = holder.children;
            for (let i = 0; i < moving.length; i++) grid.appendChild(moving[i]);
            world.sample("append:" + gridId);
        };

        world.grids[gridId] = grid;
    });

    return world;
}

/**
 * Runs one cold start to completion, draining the generated interleaving.
 *
 * The chunked scan is sequential per root, so the queue cannot be pre-filled and
 * permuted: at every step only the responses actually in flight (at most one per
 * root) can be delivered, and delivering one is what issues the next section's
 * call. The generated `picks` choose among exactly those.
 */
function runColdStart(scenario, library, failure) {
    const world = createColdWorld(scenario, library, failure);

    world.context.loadTemplates();

    const timeline = [];
    let step = 0;
    while (step < 400) {
        const pending = world.bridge.pending();
        if (pending.length === 0) break;
        const choice = scenario.picks[step % scenario.picks.length] % pending.length;
        step++;
        const delivered = world.bridge.deliver(pending[choice]);
        if (!delivered) break;
        timeline.push({
            root: delivered.call.root,
            folder: delivered.call.folder,
            ordinal: delivered.ordinal,
            broken: delivered.broken,
            inFlight: pending.length,
            sectionsDelivered: world.sectionsDelivered,
            rootsComplete: world.rootsComplete(),
            cards: world.cardCount(),
            names: world.cardNames(),
        });
    }

    world.timeline = timeline;
    world.steps = step;
    return world;
}

function sortedCopy(list) {
    return list.slice().sort();
}

/** The section folders one root was asked for, in the order they were issued. */
function issuedSections(world, root) {
    return world.bridge.calls
        .filter(function (call) { return call.root === root; })
        .map(function (call) { return call.folder; });
}

// ─── Generators ─────────────────────────────────────────────────────────────
const scenarioArb = fc.record({
    // Every member of SECTIONS, so Requirement 10.3's "covering every member"
    // is exercised rather than sampled.
    section: fc.constantFrom.apply(fc, SECTION_VALUES),
    roots: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 1, maxLength: 3 }),
    matchingPerRoot: fc.integer({ min: 1, max: 4 }),
    noise: fc.array(
        fc.record({ folder: fc.integer({ min: 0, max: 6 }), section: fc.integer({ min: 0, max: 1 }) }),
        { maxLength: 5 }
    ),
    // Which in-flight response is answered at each step. Nine picks over up to
    // three concurrent roots reach root-serial orders (one root drained to the
    // end before the next answers), round-robin orders, and everything between.
    picks: fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 9, maxLength: 9 }),
    // The section arrival that goes wrong in the failed-scan run. Ordinal 0 is
    // the ACTIVE section — the one the visible grid is waiting for — so both
    // "the section the user is looking at failed" and "a later section failed"
    // are generated.
    failRoot: fc.integer({ min: 0, max: 2 }),
    failOrdinal: fc.integer({ min: 0, max: 6 }),
    failMode: fc.constantFrom("missing", "unparseable"),
});

// ─── Property ───────────────────────────────────────────────────────────────
describe("cold start with progressive batches", function () {
    test("cold start paints from the active section first and converges", function () {
        // Non-vacuity counters over the generated run set.
        let earlyPaintRuns = 0;      // painted while sections were still outstanding
        let appendRuns = 0;          // a later section/root really appended
        let interleavedRuns = 0;     // two roots really had sections in flight at once
        let rootSerialRuns = 0;      // one root really answered everything first
        let failActiveRuns = 0;      // the ACTIVE section's response was the broken one
        let failLaterRuns = 0;       // a later section's response was the broken one
        const failModesSeen = {};

        /**
         * Feature: panel-reopen-startup, Property 18: Cold start paints from the active section first and converges
         * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9**
         */
        fc.assert(fc.property(scenarioArb, function (scenario) {
            const library = buildLibrary(scenario);
            const roots = scenario.roots;
            const total = roots.length;

            // The cards the active section is entitled to across every root, in
            // the order an unchunked scan would produce them, computed from the
            // records handed to the bridge.
            const expectedMerged = expectedMergedRecords(library, roots);
            const expectedRendered = expectedRenderedNames(library, roots, scenario.section);

            const failure = {
                root: roots[scenario.failRoot % total],
                ordinal: scenario.failOrdinal,
                mode: scenario.failMode,
            };

            const healthy = runColdStart(scenario, library, null);
            const broken = runColdStart(scenario, library, failure);

            const sections = healthy.sectionFolders;
            const perRoot = healthy.sectionsPerRoot;

            // ── The shipped scan shape ───────────────────────────────────────
            // The seven folders jsx/core.jsx walks, in the order it walks them:
            // the harness states the table independently, and the module must
            // agree, because that order is the oracle for the flattened result.
            expect(sections).toEqual(FOLDER_POOL);

            // ── Requirement 10.1: the loading state is written before ANY bridge
            // call. Both the write and the call are stamped from the same
            // counter, so the ordering claim is about observed events.
            expect(healthy.loadingStateSeq).not.toBeNull();
            expect(healthy.bridge.calls.length).toBeGreaterThan(0);
            expect(healthy.loadingStateSeq).toBeLessThan(healthy.bridge.calls[0].seq);

            // ── Requirements 10.2, 10.3, 10.5: the FIRST call for every root is
            // section-scoped and carries a NON-EMPTY second argument equal to the
            // active section's folder — the shipped map agrees with the design
            // table for every member of SECTIONS.
            const shippedFolder = healthy.activeFolder;
            expect(shippedFolder).toBe(EXPECTED_FOLDER[scenario.section]);
            expect(shippedFolder).not.toBe("");

            const firstCallByRoot = {};
            healthy.bridge.calls.forEach(function (call) {
                expect(call.kind).toBe("scoped");
                expect(call.arg2).not.toBe("");
                expect(sections.indexOf(call.folder)).toBeGreaterThan(-1);
                expect(call.arg2).toBe(encodeHex(call.folder));
                if (!firstCallByRoot[call.root]) firstCallByRoot[call.root] = call;
            });
            roots.forEach(function (root) {
                const first = firstCallByRoot[root];
                expect(first).toBeDefined();
                expect(first.folder).toBe(shippedFolder);
                expect(first.arg2).toBe(encodeHex(shippedFolder));
                // Every section exactly once, active first, then the shipped
                // fixed order.
                expect(issuedSections(healthy, root)).toEqual(healthy.expectedSectionOrder);
            });
            expect(healthy.bridge.calls[0].folder).toBe(shippedFolder);
            expect(healthy.bridge.calls.length).toBe(total * perRoot);
            expect(sortedCopy(Object.keys(firstCallByRoot))).toEqual(sortedCopy(roots));

            // The shipped trace counted one scan per section per root.
            expect(healthy.trace.report().bridgeScans.total).toBe(total * perRoot);

            // ── Requirement 10.4: cards appear as soon as the FIRST section
            // arrives — without waiting for that root's remaining sections and
            // without waiting for the other roots.
            const firstArrival = healthy.timeline[0];
            expect(firstArrival).toBeDefined();
            expect(firstArrival.ordinal).toBe(0);
            expect(firstArrival.folder).toBe(shippedFolder);
            expect(firstArrival.sectionsDelivered).toBe(1);
            // Nothing has finished: neither this root's other sections nor any
            // other root have answered.
            expect(firstArrival.rootsComplete).toBe(0);
            expect(firstArrival.sectionsDelivered).toBeLessThan(total * perRoot);

            const firstExpected = expectedMatchingNames(library, firstArrival.root, scenario.section);
            expect(firstExpected.length).toBeGreaterThan(0);
            expect(firstArrival.cards).toBe(Math.min(firstExpected.length, FIRST_BATCH));
            expect(firstArrival.names).toEqual(firstExpected.slice(0, FIRST_BATCH));
            earlyPaintRuns++;

            // ── Requirement 10.8: sampled after every grid write and after every
            // arrival — the grid never returns to zero cards, never shrinks, and
            // never loses a card it had already painted.
            expect(healthy.violations).toEqual([]);
            expect(healthy.samples.length).toBeGreaterThan(0);
            expect(healthy.sawCards).toBe(true);

            // ── Requirement 10.7: no LibraryIndex entry and no validityKey write
            // happens before EVERY section of EVERY root has arrived, and each
            // happens exactly once.
            healthy.indexWrites.forEach(function (write) {
                expect(write.sectionsDelivered).toBe(total * perRoot);
                expect(write.rootsComplete).toBe(total);
            });
            healthy.saves.forEach(function (save) {
                expect(save.sectionsDelivered).toBe(total * perRoot);
                expect(save.rootsComplete).toBe(total);
            });
            expect(healthy.indexWrites.filter(function (w) { return w.field === "_entries"; }).length).toBe(1);
            expect(healthy.indexWrites.filter(function (w) { return w.field === "validityKey"; }).length).toBe(1);
            expect(healthy.saves.length).toBe(1);
            expect(healthy.index.validityKey).toBe("cold-disk-key");

            // ── Requirements 10.6, 10.9: convergence on the unchunked result.
            // The completed record set is byte-identical to the one ONE
            // all-sections scan per root would have produced — same records, same
            // ORDER, each tagged with its own root's sourcePath — however the
            // sections interleaved on the way in.
            const merged = healthy.context.allTemplates;
            expect(clone(merged)).toEqual(expectedMerged);
            expect(healthy.index._entries.length).toBe(merged.length);
            expect(clone(healthy.index._entries)).toEqual(expectedMerged);

            // sourcePath, per root, against the records handed to the bridge.
            roots.forEach(function (root) {
                const tagged = merged
                    .filter(function (record) { return record.sourcePath === root; })
                    .map(function (record) { return record.name; });
                expect(tagged).toEqual(unchunkedPayload(library, root).map(function (r) { return r.name; }));
            });
            merged.forEach(function (record) {
                expect(roots.indexOf(record.sourcePath)).toBeGreaterThan(-1);
                expect(record.section).toBe(getTemplateSection(record));
            });

            // The final grid: the same cards, in the same order, a single
            // unchunked cold scan would have shown.
            expect(healthy.cardNames()).toEqual(expectedRendered);

            // Startup neither toasted nor logged: every payload parsed.
            expect(healthy.toasts).toEqual([]);
            expect(healthy.consoleErrors).toEqual([]);

            // Interleaving coverage, from what really happened.
            if (healthy.writes.some(function (write) { return write.kind === "append"; })) appendRuns++;
            if (healthy.timeline.some(function (step) { return step.inFlight > 1; })) interleavedRuns++;
            if (healthy.timeline.slice(0, perRoot).every(function (step) {
                return step.root === firstArrival.root;
            })) rootSerialRuns++;

            // ── A section whose response is missing or unparseable marks the
            // scan FAILED: nothing is persisted and no card is removed.
            //
            // An incomplete scan is not evidence that the library shrank, so the
            // panel must not publish it: persisting a partial set would replace a
            // good index with a truncated one, and the removal pass would delete
            // real templates and then persist the loss.
            const brokenArrival = broken.brokenArrivals[0];
            expect(brokenArrival).toBeDefined();
            expect(brokenArrival.mode).toBe(scenario.failMode);
            expect(brokenArrival.root).toBe(failure.root);
            expect(brokenArrival.ordinal).toBe(failure.ordinal);
            // The scan still ran to the end: a failed section does not abort the
            // remaining sections or the remaining roots.
            expect(broken.bridge.calls.length).toBe(total * perRoot);
            expect(broken.sectionsDelivered).toBe(total * perRoot);
            expect(broken.rootsComplete()).toBe(total);

            // Nothing persisted: no entry write, no validityKey write, no save,
            // and the index still carries exactly what it carried before.
            expect(broken.indexWrites).toEqual([]);
            expect(broken.saves).toEqual([]);
            expect(broken.index._entries.length).toBe(0);
            expect(broken.index.validityKey).toBe(broken.initialValidityKey);
            // The rescan flag is raised instead, so a later launch does not warm
            // paint from a truncated library.
            expect(broken.index._needsFullScan).toBe(true);

            // No card removed: sampled after every write and every arrival, the
            // grid never shrank and never lost a card it had painted.
            expect(broken.violations).toEqual([]);
            const brokenFinal = broken.cardNames();
            Object.keys(broken.everSeenNames).forEach(function (name) {
                expect(brokenFinal.indexOf(name)).toBeGreaterThan(-1);
            });
            expect(broken.toasts).toEqual([]);
            // An unparseable payload is logged; a missing one is silent.
            if (scenario.failMode === "unparseable") {
                expect(broken.consoleErrors.length).toBeGreaterThan(0);
            } else {
                expect(broken.consoleErrors).toEqual([]);
            }

            failModesSeen[scenario.failMode] = (failModesSeen[scenario.failMode] || 0) + 1;
            if (brokenArrival.folder === shippedFolder) failActiveRuns++;
            else failLaterRuns++;

            return true;
        }), { numRuns: 100, seed: 20260726 });

        // The generated runs really covered progressive painting, appends, both
        // arrival shapes, and both sides of the failed-section case.
        expect(earlyPaintRuns).toBeGreaterThan(0);
        expect(appendRuns).toBeGreaterThan(0);
        expect(interleavedRuns).toBeGreaterThan(0);
        expect(rootSerialRuns).toBeGreaterThan(0);
        expect(failActiveRuns).toBeGreaterThan(0);
        expect(failLaterRuns).toBeGreaterThan(0);
        expect(failModesSeen.missing).toBeGreaterThan(0);
        expect(failModesSeen.unparseable).toBeGreaterThan(0);
    });
});
