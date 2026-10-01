/**
 * Background reconciliation over a warm-painted grid — property suite
 * ===================================================================
 *
 * Feature: panel-reopen-startup
 *
 * What is under test
 * ------------------
 * The REAL background half of `js/templates/templates.js`
 * (`scheduleStartupValidation`, `changedRootsFromKeys`, `rescanChangedRoots`,
 * `startupReconcileScanned`, `startupReconcileFinish`, `patchTemplateCard`,
 * `maybeFinalizeStartup`) running on top of a REAL warm paint, driven over:
 *
 *   - a REAL parsed DOM tree (tests/helpers/miniDom.js),
 *   - a REAL persisted `LibraryIndex` round-tripped through
 *     `serialize()` / `tryParse()`, reconciled by the REAL chunked
 *     `LibraryIndex.prototype.reconcile` (js/core/persistence.js),
 *   - the REAL async validity key `deriveCombinedValidityKeyAsync` over an
 *     in-memory asynchronous filesystem, so "which roots changed" is decided by
 *     shipped code from real directory state,
 *   - the REAL startup trace recorder in `js/core/observability.js`.
 *
 * Only the environment is substituted at the boundary: the CEP bridge
 * (`csInterface.evalScript`, which replays the generated rescan result), the
 * synchronous disk key (a counting stub the warm path must never reach), the
 * idle queue, the `AppLifecycle` handle registry, `updateCount`, and a
 * monotonic clock.
 *
 * DOM fidelity note
 * -----------------
 * `patchTemplateCard` replaces one card by assigning `node.outerHTML`, and
 * `miniDom` ships only the surface the earlier suites needed. This file adds a
 * real `outerHTML` accessor (replace the node at its own index in its parent)
 * and makes a grid's `innerHTML` getter serialize its live children, so node
 * replacement and removal are genuinely observable instead of silently becoming
 * an inert property write. Both are installed from this file only; no helper and
 * no product file is modified.
 *
 * Structure
 * ---------
 * Every helper below the requires is module level and scenario driven so the
 * remaining properties of this suite (changed-root locality, stale
 * continuations) can be appended without touching the harness.
 */

"use strict";

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const { loadHelpers, REPO_ROOT } = require("../helpers/loadHelpers.js");
const { createMiniDocument, MiniElement } = require("../helpers/miniDom.js");
const {
    LibraryIndex,
    parseCombinedValidityKey,
    deriveCombinedValidityKeyAsync,
    getLastLibraryIndexLoadReason,
} = require("../../js/core/persistence.js");

const OBSERVABILITY_SOURCE = nodeFs.readFileSync(
    path.join(REPO_ROOT, "js", "core", "observability.js"),
    "utf8"
);

// The six card grids index.html defines; resolveSectionGridId() picks one of
// them from currentSection, so all six exist in the harness document.
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

// Root_Signature (js/core/persistence.js) fingerprints the SEVEN SECTION FOLDERS
// of a root, never the root directory itself, so a file dropped loose in the root
// is invisible to it. The synthetic library therefore keeps its files where a real
// one does — inside a section folder — which is what makes a generated mutation a
// change the shipped validity key can actually see, and reconciliation reachable.
const SIGNATURE_SEED_FOLDER = "comp";

// ─── Real shared modules loaded once (pure lookup tables + pure helpers) ─────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
});
const SECTION_VALUES = Object.keys(SECTIONS).map(function (key) { return SECTIONS[key]; });

// ─── miniDom extensions used only by this suite ─────────────────────────────
function serializeNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.data);
    let attributes = "";
    const names = Object.keys(node._attributes || {});
    for (let i = 0; i < names.length; i++) {
        attributes += " " + names[i] + '="' +
            String(node._attributes[names[i]]).replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"';
    }
    return "<" + node.localName + attributes + ">" + serializeChildren(node) + "</" + node.localName + ">";
}

function serializeChildren(node) {
    let out = "";
    for (let i = 0; i < node.childNodes.length; i++) out += serializeNode(node.childNodes[i]);
    return out;
}

// Browser `outerHTML` assignment semantics: the node is replaced, in place, by
// the parsed markup — the old node object leaves the tree and the new one takes
// its index. Without this, `patchTemplateCard` would write an inert property and
// "replaced in place" would be untestable.
if (!Object.getOwnPropertyDescriptor(MiniElement.prototype, "outerHTML")) {
    Object.defineProperty(MiniElement.prototype, "outerHTML", {
        configurable: true,
        get: function () { return serializeNode(this); },
        set: function (markup) {
            const parent = this.parentNode;
            if (!parent) return;
            const at = parent.childNodes.indexOf(this);
            if (at === -1) return;
            const holder = this.ownerDocument.createElement("div");
            holder.innerHTML = String(markup);
            const incoming = holder.childNodes.splice(0);
            for (let i = 0; i < incoming.length; i++) incoming[i].parentNode = parent;
            const args = [at, 1].concat(incoming);
            parent.childNodes.splice.apply(parent.childNodes, args);
            this.parentNode = null;
            if (typeof parent.__recordMutation === "function") parent.__recordMutation("patch");
        },
    });
}

// ─── Bridge double: hex transport plus a recording evalScript ────────────────
function encodeHex(value) {
    return Buffer.from(String(value), "utf8").toString("hex");
}
function decodeHex(value) {
    return Buffer.from(String(value), "hex").toString("utf8");
}

function normalizePath(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/\\/g, "/").replace(/\/+$/, "");
}

// ─── Section folders, as ExtendScript sees them ──────────────────────────────
// Reconciliation is section-chunked: templates.js issues one
// `getAllTemplates(rootHex, sectionHex)` per section folder per changed root
// rather than a single all-sections call, because one all-sections call blocks
// After Effects' main thread for the whole library. `jsx/core.jsx` answers each
// call with the records of that one folder, so the harness must too.
//
// The section -> folder map is stated here INDEPENDENTLY of the shipped
// `SECTION_SCAN_FOLDERS` table (two sections share a folder: `text_props` lives
// in `text`, `element` in `overlay`), so the harness is a real oracle for the
// second argument rather than a restatement of it.
const SCAN_FOLDER_FOR_SECTION = {
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

/** The section folder ExtendScript would have found this record in. */
function scanFolderForRecord(record) {
    if (!record) return "";
    const section = typeof record.section === "string" && record.section
        ? record.section
        : record.type;
    const folder = SCAN_FOLDER_FOR_SECTION[section];
    return typeof folder === "string" ? folder : "";
}

/**
 * A recording `csInterface`. `getAllTemplates(<hex root>,<hex section>)` — the
 * chunked form the shipped scanner issues — resolves synchronously with the part
 * of the rescan result `recordsForRoot(root)` returns that lives in that section
 * folder; the one-argument `getAllTemplates(<hex root>)` form still answers with
 * the whole root, so a caller that asks for everything is still served.
 */
function createBridge(recordsForRoot) {
    const calls = [];
    const scanCalls = [];
    const csInterface = {
        evalScript: function (script, callback) {
            const text = String(script);
            calls.push({ script: text });
            const scoped = /^getAllTemplates\("([0-9a-fA-F]*)","([0-9a-fA-F]*)"\)$/.exec(text);
            const all = scoped ? null : /^getAllTemplates\("([0-9a-fA-F]*)"\)$/.exec(text);
            if (!scoped && !all) {
                if (typeof callback === "function") callback("");
                return;
            }
            const root = decodeHex((scoped || all)[1]);
            const folder = scoped ? decodeHex(scoped[2]) : "";
            scanCalls.push({ root: root, section: folder });
            const records = recordsForRoot(root).filter(function (record) {
                return folder === "" || scanFolderForRecord(record) === folder;
            });
            if (typeof callback === "function") callback(encodeHex(JSON.stringify(records)));
        },
    };
    return {
        csInterface: csInterface,
        calls: calls,
        scanCalls: scanCalls,
        encodeBridge: encodeHex,
        decodeBridge: decodeHex,
    };
}

/**
 * The scan calls one root really received, in issue order: the section folder of
 * each, deduplicated by root. `scanCalls` now holds one entry per section per
 * root, so every claim about "which roots were scanned" reads through here.
 */
function scannedRoots(bridge) {
    const seen = {};
    const roots = [];
    bridge.scanCalls.forEach(function (call) {
        const key = "r:" + normalizePath(call.root);
        if (seen[key]) return;
        seen[key] = true;
        roots.push(normalizePath(call.root));
    });
    return roots;
}

/** The section folders scanned for one root, in issue order. */
function scannedSections(bridge, root) {
    const norm = normalizePath(root);
    return bridge.scanCalls
        .filter(function (call) { return normalizePath(call.root) === norm; })
        .map(function (call) { return call.section; });
}

// ─── Controllable idle queue (requestIdleCallback present or absent) ─────────
function createIdleQueue(mode) {
    const queue = [];
    let nextHandle = 1;
    let ran = 0;

    function push(fn, kind) {
        const handle = nextHandle++;
        queue.push({ handle: handle, fn: fn, kind: kind });
        return handle;
    }
    function cancel(handle) {
        for (let i = 0; i < queue.length; i++) {
            if (queue[i].handle === handle) { queue.splice(i, 1); return true; }
        }
        return false;
    }

    const api = {
        mode: mode,
        pending: function () { return queue.length; },
        ran: function () { return ran; },
        setTimeout: function (fn) { return push(fn, "timeout"); },
        clearTimeout: function (handle) { return cancel(handle); },
        drain: function (limit) {
            const guard = typeof limit === "number" ? limit : 2000;
            let steps = 0;
            while (queue.length > 0 && steps < guard) {
                const unit = queue.shift();
                steps++;
                ran++;
                unit.fn();
            }
            return steps;
        },
    };
    if (mode === "idle") {
        api.requestIdleCallback = function (fn) { return push(fn, "idle"); };
        api.cancelIdleCallback = function (handle) { return cancel(handle); };
    }
    return api;
}

// ─── AppLifecycle handle registry double ────────────────────────────────────
function createLifecycleRegistry() {
    const entries = [];
    let nextId = 1;
    const api = {
        entries: entries,
        live: function () {
            return entries.filter(function (entry) { return entry.active; }).length;
        },
        maxLive: 0,
        register: function (kind, handle, cancel) {
            const entry = { id: nextId++, kind: kind, handle: handle, cancel: cancel, active: true, disposals: 0 };
            entries.push(entry);
            if (api.live() > api.maxLive) api.maxLive = api.live();
            return {
                id: entry.id,
                dispose: function () {
                    if (!entry.active) return;
                    entry.active = false;
                    entry.disposals++;
                    if (typeof cancel === "function") cancel(handle);
                },
            };
        },
        onDispose: function (fn) { entries.push({ id: nextId++, kind: "disposer", fn: fn, active: true, disposals: 0 }); },
        disposeAll: function () {
            entries.forEach(function (entry) {
                if (!entry.active) return;
                entry.active = false;
                entry.disposals++;
                if (typeof entry.cancel === "function") entry.cancel(entry.handle);
                if (typeof entry.fn === "function") entry.fn();
            });
        },
    };
    return api;
}

// ─── Asynchronous in-memory filesystem for the real validity key ────────────
function createValidityFilesystem() {
    const dirs = {};
    function ensureDir(dir) {
        if (!dirs[dir]) dirs[dir] = { mtimeMs: 1000, files: {} };
        return dirs[dir];
    }
    return {
        dirs: dirs,
        addDirectory: ensureDir,
        addFile: function (dir, name, size, mtimeMs) {
            const node = ensureDir(dir);
            node.files[name] = { size: size, mtimeMs: mtimeMs };
            if (mtimeMs > node.mtimeMs) node.mtimeMs = mtimeMs;
        },
        fs: {
            readdir: function (dir, callback) {
                const node = dirs[dir];
                if (!node) { callback(new Error("ENOENT: " + dir)); return; }
                callback(null, Object.keys(node.files));
            },
            stat: function (target, callback) {
                const asDir = dirs[target];
                if (asDir) { callback(null, { size: 0, mtimeMs: asDir.mtimeMs }); return; }
                const at = String(target).lastIndexOf("/");
                const parent = dirs[String(target).substring(0, at)];
                const name = String(target).substring(at + 1);
                if (!parent || !parent.files[name]) { callback(new Error("ENOENT: " + target)); return; }
                callback(null, { size: parent.files[name].size, mtimeMs: parent.files[name].mtimeMs });
            },
        },
    };
}

// ─── Scenario → persisted entries ───────────────────────────────────────────
function makeEntry(spec, section, root, suffix) {
    return {
        id: "tpl-id-" + suffix,
        name: spec.name + "-" + suffix,
        category: spec.category,
        section: section,
        type: section,
        favorite: spec.favorite,
        folderPath: root + "/" + section + "/" + suffix,
        sourcePath: root,
        thumbnail: "",
    };
}

/**
 * Turns the generated scenario into the persisted entry list. Every entry gets a
 * unique id and folderPath and a `sourcePath` drawn from the library path set,
 * which is what makes per-root reconciliation observable.
 */
function buildEntries(scenario) {
    const roots = scenario.roots;
    const entries = [];
    scenario.matching.forEach(function (spec, index) {
        entries.push(makeEntry(spec, scenario.section, roots[index % roots.length], "m" + index));
    });
    scenario.others.forEach(function (spec, index) {
        entries.push(makeEntry(spec, spec.section, roots[index % roots.length], "o" + index));
    });
    return entries;
}

/** Persists the entries through the real serialize/tryParse round trip. */
function persistLibraryIndex(entries, validityKey) {
    const source = new LibraryIndex({ validityKey: validityKey });
    for (let i = 0; i < entries.length; i++) source.insertAtHead(entries[i]);
    const parsed = LibraryIndex.tryParse(source.serialize());
    return { ok: parsed.ok, index: parsed.index, serialized: source.serialize() };
}

// ─── The generated reconciliation difference, per root ───────────────────────
/**
 * The rescan result for one root: `keep` replays the record unchanged, `change`
 * rewrites visible fields (name drives data-file/title/card-name, favorite drives
 * the is-fav class) while holding `id`/`category`/`section` stable so record
 * identity and filter membership are untouched, `remove` omits the record
 * entirely, and `addPerRoot` appends records the index has never seen.
 *
 * Computed once per root and memoized, so the bridge, the expectations and a
 * repeated scan can never disagree.
 */
function computeRootDiff(scenario, entries, scanRoot) {
    const norm = normalizePath(scanRoot);
    const inRoot = entries.filter(function (entry) {
        return normalizePath(entry.sourcePath) === norm;
    });

    const records = [];
    const removedIds = [];
    const changedIds = [];
    const addedIds = [];

    inRoot.forEach(function (entry, index) {
        const op = scenario.ops[index % scenario.ops.length];
        if (op === "remove") {
            removedIds.push(entry.id);
            return;
        }
        const copy = JSON.parse(JSON.stringify(entry));
        if (op === "change") {
            copy.name = entry.name + " (rescanned)";
            copy.favorite = !entry.favorite;
            changedIds.push(entry.id);
        }
        records.push(copy);
    });

    for (let a = 0; a < scenario.addPerRoot; a++) {
        const added = makeEntry(
            { name: "Added", category: "Rescanned", favorite: false },
            scenario.section,
            scanRoot,
            "add-" + norm.replace(/[^A-Za-z0-9]/g, "") + "-" + a
        );
        addedIds.push(added.id);
        records.push(added);
    }

    return { records: records, removedIds: removedIds, changedIds: changedIds, addedIds: addedIds };
}

// ─── Grid write / mutation instrumentation ──────────────────────────────────
/**
 * Installs the observation points on one grid:
 *
 *   - `innerHTML` set — the full-replacement path. Every assignment is recorded
 *     WITH the stage it happened in and the markup it carried, which is how
 *     "never blanked, never a placeholder while cards exist" is decided.
 *   - `innerHTML` get — serializes the live children, so the getter stays
 *     coherent after in-place patches and removals.
 *   - `insertAdjacentHTML("beforeend")` — the batch append path.
 *   - `removeChild` — the reconciliation removal path.
 *   - `__recordMutation` — the hook the `outerHTML` setter calls after an
 *     in-place card replacement.
 *
 * Every one of them samples the grid and evaluates the invariants immediately,
 * so a single frame in which the grid was blank would be caught.
 */
function instrumentGrid(document, element, harness) {
    const descriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "innerHTML");
    const realRemoveChild = element.removeChild.bind(element);

    Object.defineProperty(element, "innerHTML", {
        configurable: true,
        get: function () { return serializeChildren(element); },
        set: function (markup) {
            harness.noteAssignment(element, String(markup));
            descriptor.set.call(element, markup);
            harness.note("innerHTML");
        },
    });

    element.insertAdjacentHTML = function (position, markup) {
        if (position !== "beforeend") throw new Error("harness supports beforeend only");
        const holder = document.createElement("div");
        holder.innerHTML = String(markup);
        const moving = holder.children;
        for (let i = 0; i < moving.length; i++) element.appendChild(moving[i]);
        harness.note("append");
    };

    element.removeChild = function (node) {
        const removed = realRemoveChild(node);
        harness.note("remove");
        return removed;
    };

    element.__recordMutation = function (kind) { harness.note(kind); };
}

// ─── The harness ────────────────────────────────────────────────────────────
/**
 * Builds one startup world: a fresh vm realm holding the real templates.js and
 * the real observability.js, a real parsed DOM, a persisted LibraryIndex, the
 * generated per-root rescan result, and every observation point the property
 * reads.
 */
function createReconcileHarness(scenario) {
    const entries = buildEntries(scenario);

    // Disk state: one directory per library root. The generated mutations are
    // applied later, AFTER the stored key was derived.
    const disk = createValidityFilesystem();
    scenario.roots.forEach(function (root, rootIndex) {
        disk.addDirectory(root);
        disk.addDirectory(root + "/" + SIGNATURE_SEED_FOLDER);
        for (let i = 0; i <= rootIndex; i++) {
            disk.addFile(root + "/" + SIGNATURE_SEED_FOLDER, "seed-" + i + ".aep", 1024 + i, 1000 + i);
        }
    });

    const diffs = {};
    function diffFor(root) {
        const key = "r:" + normalizePath(root);
        if (!diffs[key]) diffs[key] = computeRootDiff(scenario, entries, root);
        return diffs[key];
    }
    function recordsForRoot(root) {
        return JSON.parse(JSON.stringify(diffFor(root).records));
    }

    const bridge = createBridge(recordsForRoot);
    const document = createMiniDocument();

    let syncValidityKeyCalls = 0;
    const idle = createIdleQueue(scenario.idleMode);
    const lifecycle = createLifecycleRegistry();
    const consoleCalls = [];
    const spies = { updateCount: 0, hoverAttach: 0, saveLibraryIndex: 0 };
    const persistedIndex = { index: null };

    let clock = 0;
    const windowObject = {
        performance: { now: function () { clock += 1; return clock; } },
        Date: Date,
        console: {
            log: function (message) { consoleCalls.push({ channel: "log", message: message }); },
            warn: function (message) { consoleCalls.push({ channel: "warn", message: message }); },
            error: function (message) { consoleCalls.push({ channel: "error", message: message }); },
        },
    };

    const harness = {
        scenario: scenario,
        entries: entries,
        disk: disk,
        document: document,
        grids: {},
        bridge: bridge,
        idle: idle,
        lifecycle: lifecycle,
        spies: spies,
        consoleCalls: consoleCalls,
        window: windowObject,
        diffFor: diffFor,
        recordsForRoot: recordsForRoot,
        syncValidityKeyCalls: function () { return syncValidityKeyCalls; },
        setIndex: function (index) { persistedIndex.index = index; },
        // Filled by seedPersistedIndex.
        mutatedRoots: [],
        storedKey: null,
        currentKey: null,
        persisted: null,
        // Observation state.
        stage: "boot",
        mutations: [],
        assignments: [],
        samples: 0,
        violations: [],
        painted: null,
        finalize: { calls: 0, rerendered: false, snapshot: null },
    };

    const sandbox = loadHelpers({
        file: path.join("js", "templates", "templates.js"),
        lenient: false,
        injected: {
            // Realm plumbing. observability.js publishes onto `window`, so the
            // trace really is read from window.__csStartupTrace.
            window: windowObject,
            console: windowObject.console,
            document: document,

            // Real pure helpers from the shipped modules.
            SECTIONS: SECTIONS,
            IMAGE_SECTIONS: IMAGE_SECTIONS,
            escapeAttr: utils.get("escapeAttr"),
            escapeHTML: utils.get("escapeHTML"),
            getTemplateSection: utils.get("getTemplateSection"),
            isTextSection: utils.get("isTextSection"),
            isImageSection: utils.get("isImageSection"),

            // Panel state templates.js reads and (for allTemplates) reassigns.
            allTemplates: [],
            currentSection: scenario.section,
            // "All" throughout: a reconciliation difference must never change a
            // record's filter membership, or the finalize re-render would
            // legitimately drop a card and the identity claim would be about the
            // filter rather than about reconciliation.
            currentCategory: "All",
            tmpBulkSelected: [],
            libraryPaths: scenario.roots.slice(),
            rootPath: scenario.roots[0],
            DOM: { "search-box": { value: "" } },

            // Persistence seam: the persisted index plus the REAL async key.
            getLibraryIndex: function () { return persistedIndex.index; },
            getLastLibraryIndexLoadReason: getLastLibraryIndexLoadReason,
            // The REAL versioned-key parser: changedRootsFromKeys recovers each
            // root through it, exactly as the panel does with persistence.js
            // loaded alongside templates.js.
            parseCombinedValidityKey: parseCombinedValidityKey,
            deriveCombinedValidityKeyAsync: function (paths, fsImpl, storedKey) {
                // The versioned (v2) key: templates.js hands its stored key
                // through as the third argument, and an absent stored key still
                // opts in with "", so the harness and the shipped warm/cold
                // decision compare keys in the same format.
                return deriveCombinedValidityKeyAsync(
                    paths, disk.fs, typeof storedKey === "string" ? storedKey : ""
                );
            },
            // Sync_Validity_Key: a counting stub. The startup path must never
            // reach it (Requirement 1.2).
            getCombinedDiskValidityKey: function () {
                syncValidityKeyCalls++;
                return "sync-key-must-not-be-used";
            },
            saveLibraryIndex: function () { spies.saveLibraryIndex++; },

            // Bridge seam.
            csInterface: bridge.csInterface,
            encodeBridge: bridge.encodeBridge,
            decodeBridge: bridge.decodeBridge,

            // Scheduling seam.
            requestIdleCallback: idle.requestIdleCallback,
            cancelIdleCallback: idle.cancelIdleCallback,
            setTimeout: idle.setTimeout,
            clearTimeout: idle.clearTimeout,
            AppLifecycle: lifecycle,

            // Collaborators outside templates.js.
            updateCount: function () { spies.updateCount++; },
            updateCustomSelect: function () { },
            Settings: { get: function () { return []; }, set: function () { } },
            TextAnim: { attachHoverPreviews: function () { spies.hoverAttach++; } },
            showToast: function () { throw new Error("startup must never toast"); },
            nfs: function () { return { existsSync: function () { return false; } }; },
        },
    });

    harness.context = sandbox.context;

    GRID_IDS.forEach(function (gridId) {
        const grid = document.createElement("div");
        grid.id = gridId;
        grid.className = "card-grid";
        document.body.appendChild(grid);
        instrumentGrid(document, grid, harness);
        harness.grids[gridId] = grid;
    });

    // The real trace recorder, in the same realm, publishing onto `window`.
    vm.runInContext(OBSERVABILITY_SOURCE, sandbox.context, { filename: "observability.js" });
    sandbox.context.PerfEvents = windowObject.PerfEvents;
    harness.PerfEvents = windowObject.PerfEvents;

    // The finalize re-render is the one legitimate full grid write after warm
    // paint. Wrapping it (templates.js reaches it as a free identifier, so the
    // wrapper is what the module calls) marks that boundary and snapshots the
    // grid as reconciliation left it, before the re-render replaces every node.
    const realFinalize = sandbox.context.maybeFinalizeStartup;
    sandbox.context.maybeFinalizeStartup = function (session) {
        harness.finalize.calls++;
        const before = harness.mutations.length;
        const snapshot = harness.snapshot();
        const previousStage = harness.stage;
        harness.stage = "finalize";
        let result;
        try {
            result = realFinalize(session);
        } finally {
            harness.stage = previousStage;
        }
        if (harness.mutations.length > before && !harness.finalize.rerendered) {
            harness.finalize.rerendered = true;
            harness.finalize.snapshot = snapshot;
        }
        return result;
    };

    harness.activeGrid = function () {
        return harness.grids[sandbox.context.resolveSectionGridId()];
    };
    harness.cards = function () {
        return harness.activeGrid().querySelectorAll(".card");
    };
    harness.modelById = function () {
        const map = {};
        const model = sandbox.context.allTemplates;
        for (let i = 0; i < model.length; i++) map["i:" + model[i].id] = model[i];
        return map;
    };
    /** The grid as it stands: card ids in order plus id → node. */
    harness.snapshot = function () {
        const cards = harness.cards();
        const ids = [];
        const nodeById = {};
        for (let i = 0; i < cards.length; i++) {
            ids.push(cards[i].id);
            nodeById["n:" + cards[i].id] = cards[i];
        }
        return {
            ids: ids,
            nodeById: nodeById,
            emptyStates: harness.activeGrid().querySelectorAll(".cs-empty-state").length,
        };
    };
    /** The warm-painted grid: the reference every identity claim is made against. */
    harness.capturePainted = function () {
        const model = harness.modelById();
        const cards = harness.cards();
        const painted = [];
        for (let i = 0; i < cards.length; i++) {
            const cardId = cards[i].id;
            const entryId = cardId.indexOf("tpl-") === 0 ? cardId.substring(4) : cardId;
            const entry = model["i:" + entryId];
            painted.push({
                cardId: cardId,
                entryId: entryId,
                node: cards[i],
                index: i,
                root: entry ? entry.sourcePath : "",
                name: cards[i].getAttribute("data-file"),
            });
        }
        harness.painted = painted;
        return painted;
    };

    harness.note = function (kind) {
        harness.mutations.push({ kind: kind, stage: harness.stage });
        harness.checkInvariants(kind);
    };
    harness.noteAssignment = function (element, markup) {
        const surviving = harness.surviving();
        const record = {
            stage: harness.stage,
            gridId: element.id,
            markup: markup,
            cardsInMarkup: (markup.match(/class="card[ "]/g) || []).length,
            placeholder: markup.indexOf("cs-empty-state") !== -1,
            blank: markup.replace(/\s+/g, "") === "",
            // Painted records still live at the moment of the write. Zero means
            // every painted record was deleted from disk, and the per-category
            // empty state is then the correct thing to render.
            surviving: surviving.length,
        };
        harness.assignments.push(record);

        // Requirement 1.6 / 2.6: reconciliation patches nodes, it never writes
        // the grid. The only writes allowed are the warm paint and the one
        // finalize re-render.
        if (record.stage !== "warm-paint" && record.stage !== "finalize") {
            harness.fail("grid.innerHTML assigned during stage " + record.stage);
        }
        if (surviving.length > 0 && (record.blank || record.cardsInMarkup === 0)) {
            harness.fail("grid.innerHTML assigned a card-less value while " +
                surviving.length + " painted cards were still live (stage " + record.stage + ")");
        }
        if (surviving.length > 0 && record.placeholder) {
            harness.fail("grid.innerHTML assigned a placeholder while " +
                surviving.length + " painted cards were still live (stage " + record.stage + ")");
        }
    };
    harness.fail = function (message) {
        if (harness.violations.length < 8) harness.violations.push(message);
    };
    /** Painted cards whose record is still in the model: these must stay on screen. */
    harness.surviving = function () {
        if (!harness.painted) return [];
        const model = harness.modelById();
        return harness.painted.filter(function (card) { return !!model["i:" + card.entryId]; });
    };

    /**
     * The Property 4 invariant set, evaluated at every DOM mutation and at every
     * drained work unit / settled chunk.
     */
    harness.checkInvariants = function (kind) {
        harness.samples++;
        if (!harness.painted) return;

        const state = harness.snapshot();
        const surviving = harness.surviving();
        const where = " [" + kind + " @" + harness.stage + ", sample " + harness.samples + "]";

        if (surviving.length === 0) return;

        if (state.ids.length === 0) {
            harness.fail("grid held 0 cards while " + surviving.length +
                " painted records were still live" + where);
            return;
        }
        if (state.emptyStates > 0) {
            harness.fail("grid showed a placeholder while " + surviving.length +
                " painted records were still live" + where);
        }
        if (state.ids.length < surviving.length) {
            harness.fail("grid held " + state.ids.length + " cards, fewer than the " +
                surviving.length + " live painted records" + where);
        }

        const survivingIds = {};
        surviving.forEach(function (card) { survivingIds["n:" + card.cardId] = true; });

        for (let i = 0; i < surviving.length; i++) {
            const card = surviving[i];
            const node = state.nodeById["n:" + card.cardId];
            if (!node) {
                harness.fail("live painted card " + card.cardId + " left the grid" + where);
                continue;
            }
            // Unchanged roots are never rescanned, so their nodes must be the
            // very same objects — until the finalize re-render, which is a
            // full, legitimate repaint of the same records.
            if (!harness.finalize.rerendered && harness.stage !== "finalize" &&
                harness.changedRoots.indexOf(normalizePath(card.root)) === -1) {
                if (node !== card.node) {
                    harness.fail("unchanged-root card " + card.cardId +
                        " was replaced although its root was never rescanned" + where);
                }
                if (node.getAttribute("data-file") !== card.name) {
                    harness.fail("unchanged-root card " + card.cardId +
                        " changed content although its root was never rescanned" + where);
                }
            }
        }

        // Position: the live painted cards keep their warm-paint order.
        const observed = state.ids.filter(function (id) { return survivingIds["n:" + id] === true; });
        const expected = surviving.map(function (card) { return card.cardId; });
        if (observed.join("|") !== expected.join("|")) {
            harness.fail("live painted cards changed order" + where +
                " expected " + expected.join(",") + " observed " + observed.join(","));
        }
    };

    // Filled in by the property once the real keys are known; every scenario
    // starts out with "nothing changed".
    harness.changedRoots = [];

    return harness;
}

/**
 * Derives the stored key over the pre-mutation disk, persists the index, then
 * applies the generated mutations so the roots in `scenario.mutations` are the
 * only ones whose real key changed.
 */
async function seedPersistedIndex(harness) {
    const scenario = harness.scenario;
    const storedKey = await deriveCombinedValidityKeyAsync(scenario.roots, harness.disk.fs, "");
    const persisted = persistLibraryIndex(harness.entries, storedKey);
    harness.setIndex(persisted.index);
    harness.storedKey = storedKey;
    harness.persisted = persisted;

    scenario.mutations.forEach(function (rootIndex, order) {
        const root = scenario.roots[rootIndex % scenario.roots.length];
        // Inside a section folder, where Root_Signature looks.
        harness.disk.addFile(
            root + "/" + SIGNATURE_SEED_FOLDER,
            "changed-" + order + ".aep", 4096 + order, 5000 + order
        );
        if (harness.mutatedRoots.indexOf(root) === -1) harness.mutatedRoots.push(root);
    });
    harness.currentKey = await deriveCombinedValidityKeyAsync(scenario.roots, harness.disk.fs, storedKey);
    return harness;
}

/**
 * Models the Startup_Controller edits in js/main.js: open the trace, open
 * `startup.init`, run warm paint, close the span.
 */
function runWarmStartup(harness) {
    harness.stage = "warm-paint";
    const trace = harness.PerfEvents.beginStartupTrace({ generation: harness.scenario.generation });
    const initPhase = trace.beginPhase("startup.init");
    const warmPaint = harness.context.startupWarmPaint(harness.context.getLibraryIndex());
    initPhase.end({ warmPainted: warmPaint && warmPaint.painted === true });
    return { trace: trace, warmPaint: warmPaint, report: harness.window.__csStartupTrace };
}

// Yielding through `setImmediate` flushes the pending microtasks (the real
// async validity key and the `LibraryIndex.reconcile` chain); the trailing
// macrotask yield also flushes anything a reconcile chunk deferred with a timer.
async function settle() {
    await new Promise(function (resolve) { setImmediate(resolve); });
}
async function settleTimers() {
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/**
 * Drains the deferred queue one work unit at a time, letting the validity
 * promise, the bridge callbacks and every `LibraryIndex.reconcile` chunk settle
 * between units, and samples the grid after each one.
 */
async function drainDeferredWork(harness) {
    harness.stage = "deferred";
    let steps = 0;
    for (let pass = 0; pass < 4; pass++) {
        while (harness.idle.pending() > 0 && steps < 200) {
            harness.idle.drain(1);
            steps++;
            harness.note("idle-unit");
            await settle();
            harness.note("chunk");
        }
        await settle();
        harness.note("chunk");
    }
    // LibraryIndex.reconcile yields between work units through a REAL timer, and
    // a work unit that overruns its 50 ms budget (a loaded machine is enough)
    // needs more than one macrotask turn to finish. Keep giving the queue timer
    // turns until the deferred-work record says appends, reconciliation and the
    // finalize gate are all done, bounded so a scenario that legitimately never
    // finalizes still terminates. Every turn still samples the grid.
    for (let turn = 0; turn < 60; turn++) {
        await settleTimers();
        harness.idle.drain();
        await settle();
        harness.note("chunk");
        const pending = harness.context._startupPending;
        if ((!pending || pending.finalized === true) && harness.idle.pending() === 0) break;
    }
    return harness;
}

// ─── Generators ─────────────────────────────────────────────────────────────
const ROOT_POOL = ["C:/lib/alpha", "C:/lib/beta", "D:/shared/gamma", "E:/archive/delta"];

const entrySpecArb = fc.record({
    name: fc.constantFrom("Intro", "Lower Third", "Glow", "Kinetic", "Bars", "Logo"),
    category: fc.constantFrom("Titles", "Transitions", "Uncategorized"),
    favorite: fc.boolean(),
    section: fc.constantFrom.apply(fc, SECTION_VALUES),
});

const scenarioArb = fc.record({
    generation: fc.integer({ min: 1, max: 9 }),
    section: fc.constantFrom.apply(fc, SECTION_VALUES),
    roots: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 1, maxLength: 3 }),
    // At least one persisted entry. Small libraries stay inside First_Batch;
    // large ones exceed it, so reconciliation and the idle append batches
    // interleave over the same grid.
    matching: fc.oneof(
        { weight: 3, arbitrary: fc.array(entrySpecArb, { minLength: 1, maxLength: 14 }) },
        { weight: 1, arbitrary: fc.array(entrySpecArb, { minLength: 61, maxLength: 72, size: "max" }) }
    ),
    others: fc.array(entrySpecArb, { maxLength: 6 }),
    // Which roots changed on disk after the index was persisted; only these are
    // rescanned, so only these can carry a difference.
    mutations: fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }),
    // The per-record rescan difference, cycled over each root's records.
    ops: fc.array(fc.constantFrom("keep", "change", "remove"), { minLength: 1, maxLength: 6 }),
    addPerRoot: fc.integer({ min: 0, max: 2 }),
    idleMode: fc.constantFrom("idle", "timeout"),
});

// ─── Properties ─────────────────────────────────────────────────────────────
describe("startup reconciliation", function () {
    test("the grid is never blanked and stale cards are replaced in place", async function () {
        /**
         * Feature: panel-reopen-startup, Property 4: The grid is never blanked and stale cards are replaced in place
         * **Validates: Requirements 1.5, 1.6, 2.6**
         */
        await fc.assert(fc.asyncProperty(scenarioArb, async function (scenario) {
            const harness = createReconcileHarness(scenario);
            await seedPersistedIndex(harness);
            expect(harness.persisted.ok).toBe(true);

            const startup = runWarmStartup(harness);
            expect(startup.warmPaint.painted).toBe(true);
            expect(startup.warmPaint.cards).toBe(Math.min(startup.warmPaint.records, FIRST_BATCH));

            // The warm-painted grid is the reference every claim below is made
            // against, and the roots the shipped differ says changed are the only
            // ones allowed to touch it.
            const painted = harness.capturePainted();
            expect(painted.length).toBe(startup.warmPaint.cards);
            harness.changedRoots = harness.context
                .changedRootsFromKeys(harness.storedKey, harness.currentKey)
                .map(normalizePath);

            await drainDeferredWork(harness);

            // Sampled after every chunk and every DOM mutation: the grid never
            // blanked, never showed a placeholder while cards were live, and no
            // live painted card ever left, changed identity, or changed position
            // (Requirements 1.5, 1.6).
            expect(harness.violations).toEqual([]);
            expect(harness.samples).toBeGreaterThan(0);

            // Requirement 1.6 / 2.6: reconciliation writes no markup into the
            // grid at all. The only full writes are the warm paint and, when the
            // record set really changed, the single finalize re-render.
            const stages = harness.assignments.map(function (record) { return record.stage; });
            expect(stages.filter(function (s) { return s === "warm-paint"; }).length).toBe(1);
            expect(stages.filter(function (s) { return s === "deferred"; }).length).toBe(0);
            expect(stages.filter(function (s) { return s === "finalize"; }).length)
                .toBe(harness.finalize.rerendered ? 1 : 0);
            harness.assignments.forEach(function (record) {
                // No write is ever empty or a placeholder while painted records
                // are still live. When every painted record was deleted from
                // disk there is nothing left to keep, and the per-category empty
                // state is the correct end state.
                if (record.surviving === 0) return;
                expect(record.blank).toBe(false);
                expect(record.cardsInMarkup).toBeGreaterThan(0);
                expect(record.placeholder).toBe(false);
            });

            // Only changed roots were rescanned, and the shipped differ agrees
            // with the real disk state. The scan is section-chunked, so a
            // rescanned root shows up once per section folder: the ROOT SET is
            // what locality is about, and the per-root call count is the shipped
            // section list — read off the module rather than restated here, so
            // the test tracks the product if that list ever changes.
            const sectionFolders = harness.context.STARTUP_SCAN_SECTIONS;
            expect(Array.isArray(sectionFolders)).toBe(true);
            expect(sectionFolders.length).toBeGreaterThan(0);
            const scanned = scannedRoots(harness.bridge).sort();
            expect(scanned).toEqual(harness.changedRoots.slice().sort());
            scanned.forEach(function (root) {
                // Every section exactly once, active section first.
                expect(scannedSections(harness.bridge, root).slice().sort())
                    .toEqual(sectionFolders.slice().sort());
                expect(scannedSections(harness.bridge, root)[0])
                    .toBe(harness.context.activeSectionScanFolder());
            });

            // The grid as reconciliation left it: for a difference that changed
            // the record set, the snapshot taken just before the finalize
            // re-render; otherwise the drained end state.
            const end = harness.finalize.rerendered ? harness.finalize.snapshot : harness.snapshot();
            const model = harness.modelById();
            let replacedInPlace = 0;
            let removedInPlace = 0;

            painted.forEach(function (card) {
                const changedRoot = harness.changedRoots.indexOf(normalizePath(card.root)) !== -1;
                const node = end.nodeById["n:" + card.cardId];

                if (!changedRoot) {
                    // Requirement 1.5: untouched roots keep the very same nodes.
                    expect(node).toBe(card.node);
                    expect(node.getAttribute("data-file")).toBe(card.name);
                    return;
                }

                const diff = harness.diffFor(card.root);
                if (diff.removedIds.indexOf(card.entryId) !== -1) {
                    // Gone from disk: the record leaves the model and its single
                    // node leaves the grid. Nothing else is disturbed.
                    expect(node).toBeUndefined();
                    expect(model["i:" + card.entryId]).toBeUndefined();
                    removedInPlace++;
                    return;
                }

                // Requirement 1.6: a stale card is replaced by a new node at its
                // own position, carrying the rescanned record's fields.
                expect(node).toBeDefined();
                expect(node).not.toBe(card.node);
                expect(model["i:" + card.entryId]).toBeDefined();
                expect(node.getAttribute("data-file")).toBe(model["i:" + card.entryId].name);
                replacedInPlace++;
            });

            // Position, once more, on the end state: the live painted cards are
            // still in warm-paint order.
            const survivors = painted.filter(function (card) { return !!model["i:" + card.entryId]; });
            const survivorIds = {};
            survivors.forEach(function (card) { survivorIds["n:" + card.cardId] = true; });
            expect(end.ids.filter(function (id) { return survivorIds["n:" + id] === true; }))
                .toEqual(survivors.map(function (card) { return card.cardId; }));

            // Non-vacuity: when a root really changed, it really was rescanned
            // and the painted cards it owns really were patched or removed.
            const paintedInChanged = painted.filter(function (card) {
                return harness.changedRoots.indexOf(normalizePath(card.root)) !== -1;
            });
            const report = harness.window.__csStartupTrace;
            if (harness.changedRoots.length > 0) {
                expect(harness.currentKey).not.toBe(harness.storedKey);
                // One bridge call per section per changed root.
                expect(harness.bridge.scanCalls.length)
                    .toBe(harness.changedRoots.length * sectionFolders.length);
                expect(report.validity.decision).toBe("stale");
                expect(replacedInPlace + removedInPlace).toBe(paintedInChanged.length);
                const patchMutations = harness.mutations.filter(function (m) { return m.kind === "patch"; }).length;
                const removeMutations = harness.mutations.filter(function (m) { return m.kind === "remove"; }).length;
                expect(patchMutations).toBeGreaterThanOrEqual(replacedInPlace);
                expect(removeMutations).toBeGreaterThanOrEqual(removedInPlace);
            } else {
                expect(harness.currentKey).toBe(harness.storedKey);
                expect(harness.bridge.scanCalls.length).toBe(0);
                expect(report.validity.decision).toBe("fresh");
                expect(paintedInChanged.length).toBe(0);
                expect(harness.mutations.filter(function (m) { return m.kind === "patch"; }).length).toBe(0);
                expect(harness.mutations.filter(function (m) { return m.kind === "remove"; }).length).toBe(0);
            }

            // The trace agrees about the one legitimate re-render, the warm path
            // never consulted the synchronous whole-tree key, and startup neither
            // toasted nor logged an error.
            expect(report.finalRerender === true).toBe(harness.finalize.rerendered);
            expect(harness.syncValidityKeyCalls()).toBe(0);
            expect(report.bridgeScans.beforeWarmPaint).toBe(0);
            expect(harness.consoleCalls.filter(function (entry) {
                return entry.channel === "error";
            })).toEqual([]);

            return true;
            // The jest budget below is generous by design: every generated run
            // samples the whole grid at every DOM mutation and at every drained
            // work unit, and the same suite runs an order of magnitude slower
            // late in a long aggregate session than it does on its own.
        }), { numRuns: 100, seed: 20260724 });
    }, 300000);

    // ── Property 5 support: multi-root scenarios with a PROPER changed subset ──
    // Same scenario shape as `scenarioArb`, biased so the locality precondition
    // is actually met: 2–3 roots, at least three matching records so the
    // round-robin gives every root records, and a mutation set that is a
    // non-empty PROPER subset of the root indices, so at least one root changed
    // on disk and at least one did not.
    const localityScenarioArb = fc
        .record({
            generation: fc.integer({ min: 1, max: 9 }),
            section: fc.constantFrom.apply(fc, SECTION_VALUES),
            roots: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 2, maxLength: 3 }),
            matching: fc.oneof(
                { weight: 3, arbitrary: fc.array(entrySpecArb, { minLength: 3, maxLength: 14 }) },
                { weight: 1, arbitrary: fc.array(entrySpecArb, { minLength: 61, maxLength: 72, size: "max" }) }
            ),
            others: fc.array(entrySpecArb, { maxLength: 6 }),
            ops: fc.array(fc.constantFrom("keep", "change", "remove"), { minLength: 1, maxLength: 6 }),
            addPerRoot: fc.integer({ min: 0, max: 2 }),
            idleMode: fc.constantFrom("idle", "timeout"),
        })
        .chain(function (base) {
            const indices = base.roots.map(function (root, index) { return index; });
            return fc
                .subarray(indices, { minLength: 1, maxLength: base.roots.length - 1 })
                .map(function (mutations) {
                    const scenario = {};
                    Object.keys(base).forEach(function (key) { scenario[key] = base[key]; });
                    scenario.mutations = mutations;
                    return scenario;
                });
        });

    /**
     * The record set partitioned by `sourcePath`, each root's records serialized
     * in model order. Serializing at capture time is what makes the "before"
     * side a real value rather than a live reference into `allTemplates`, so a
     * later in-place field copy onto an entry object would show up as a diff.
     */
    function partitionRecordsByRoot(records) {
        const grouped = {};
        for (let i = 0; i < records.length; i++) {
            const key = "r:" + normalizePath(records[i].sourcePath);
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(records[i]);
        }
        const serialized = {};
        Object.keys(grouped).forEach(function (key) {
            serialized[key] = JSON.stringify(grouped[key]);
        });
        return serialized;
    }

    test("reconciliation is local to changed roots", async function () {
        // How many generated runs really met the proper-subset precondition, and
        // how many of those really carried a difference: without both counters a
        // pass could be vacuous.
        let properSubsetRuns = 0;
        let runsWithTouchedCards = 0;

        /**
         * Feature: panel-reopen-startup, Property 5: Reconciliation is local to changed roots
         * **Validates: Requirements 1.9, 7.4**
         */
        await fc.assert(fc.asyncProperty(localityScenarioArb, async function (scenario) {
            const harness = createReconcileHarness(scenario);
            await seedPersistedIndex(harness);
            expect(harness.persisted.ok).toBe(true);

            const startup = runWarmStartup(harness);
            expect(startup.warmPaint.painted).toBe(true);
            const painted = harness.capturePainted();

            // Which roots changed is decided by the shipped differ over the two
            // real async disk keys, never by the generator.
            const changedRoots = harness.context
                .changedRootsFromKeys(harness.storedKey, harness.currentKey)
                .map(normalizePath);
            harness.changedRoots = changedRoots;

            const allRoots = scenario.roots.map(normalizePath);
            const unchangedRoots = allRoots.filter(function (root) {
                return changedRoots.indexOf(root) === -1;
            });

            // Precondition, asserted rather than assumed: the changed set is
            // exactly the roots that were mutated on disk, and it is a non-empty
            // PROPER subset of the library's roots.
            expect(changedRoots.slice().sort())
                .toEqual(harness.mutatedRoots.map(normalizePath).sort());
            expect(changedRoots.length).toBeGreaterThan(0);
            expect(unchangedRoots.length).toBeGreaterThan(0);
            expect(changedRoots.length).toBeLessThan(allRoots.length);
            properSubsetRuns++;

            // The reference state: the model as warm paint left it, plus each
            // record's persisted sourcePath tag.
            const before = partitionRecordsByRoot(harness.context.allTemplates);
            const persistedRoot = {};
            harness.entries.forEach(function (entry) {
                persistedRoot["i:" + entry.id] = entry.sourcePath;
            });

            await drainDeferredWork(harness);

            // 1. Requirement 7.4: the rescan visits the changed roots and NOT
            // one call for any unchanged root — those stay cache hits. The scan
            // is section-chunked, so a visited root costs one call per section
            // folder; the count comes from the shipped section list rather than
            // being restated here.
            const sectionFolders = harness.context.STARTUP_SCAN_SECTIONS;
            const scanned = scannedRoots(harness.bridge);
            expect(scanned.slice().sort()).toEqual(changedRoots.slice().sort());
            expect(scanned.length).toBe(changedRoots.length);
            expect(harness.bridge.scanCalls.length)
                .toBe(changedRoots.length * sectionFolders.length);
            unchangedRoots.forEach(function (root) {
                expect(scanned.indexOf(root)).toBe(-1);
                expect(scannedSections(harness.bridge, root)).toEqual([]);
            });

            // 2. Every card the reconciliation patched or removed belongs to a
            // changed root; every other painted card is the very same node,
            // carrying the very same content.
            const end = harness.finalize.rerendered ? harness.finalize.snapshot : harness.snapshot();
            let touched = 0;
            painted.forEach(function (card) {
                const root = normalizePath(card.root);
                const node = end.nodeById["n:" + card.cardId];
                const wasRemoved = node === undefined;
                const wasPatched = !wasRemoved && node !== card.node;
                if (wasRemoved || wasPatched) {
                    expect(changedRoots.indexOf(root)).not.toBe(-1);
                    touched++;
                    return;
                }
                expect(node).toBe(card.node);
                expect(node.getAttribute("data-file")).toBe(card.name);
            });
            if (touched > 0) runsWithTouchedCards++;

            // 3. Requirement 1.9: sourcePath tagging survives reconciliation.
            // A record that was persisted keeps its own root; a record the rescan
            // added is tagged with the changed root it came from.
            const model = harness.context.allTemplates;
            model.forEach(function (record) {
                const original = persistedRoot["i:" + record.id];
                if (original !== undefined) {
                    expect(normalizePath(record.sourcePath)).toBe(normalizePath(original));
                    return;
                }
                expect(changedRoots.indexOf(normalizePath(record.sourcePath))).not.toBe(-1);
            });

            // 4. Requirement 7.4: the unchanged roots' partition of the record
            // set is byte-identical before and after reconciliation — same
            // records, same order, same field values.
            const after = partitionRecordsByRoot(model);
            unchangedRoots.forEach(function (root) {
                expect(after["r:" + root] || "[]").toBe(before["r:" + root] || "[]");
            });

            // Non-vacuity inside the run: the changed roots really were visited,
            // the shipped decision really was "stale", and the warm path still
            // never reached the synchronous whole-tree key.
            expect(harness.window.__csStartupTrace.validity.decision).toBe("stale");
            expect(harness.bridge.scanCalls.length).toBeGreaterThan(0);
            expect(harness.syncValidityKeyCalls()).toBe(0);
            expect(harness.violations).toEqual([]);

            return true;
        }), { numRuns: 100, seed: 20260725 });

        expect(properSubsetRuns).toBeGreaterThan(0);
        expect(runsWithTouchedCards).toBeGreaterThan(0);
        // Same budget note as Property 4: the sampling is what costs the time.
    }, 300000);

    // ── Property 7 support: invalidating the session mid-flight ───────────────
    //
    // The session owner is `CSStartupSession` (js/main.js, published on window).
    // templates.js reads it through guarded `typeof` probes, so the harness can
    // publish one into the vm realm and then either flip `active` to false
    // (AppLifecycle.dispose) or advance `generation` (a newer panel context).
    // It must exist BEFORE warm paint: `queueStartupDeferredWork` captures the
    // generation at that moment, and an absent owner means "no owner", which
    // every guard treats as valid.
    //
    // The five interleaving points, all of them real continuations of the
    // shipped code:
    //   before-first-unit — invalidate before the first idle unit runs
    //   mid-batch         — invalidate after N drained idle units
    //   after-validity    — invalidate between the async key resolving and
    //                       templates.js reading it (our `then` is attached first)
    //   before-bridge     — the scan is issued and recorded, only its CALLBACK
    //                       is held, and it resolves after invalidation
    //   mid-reconcile     — invalidate after the Nth card a reconcile chunk
    //                       really patched, mid-chunk
    // Plus, at the end of every run, the `loadTemplates` cold-path completion
    // guard: a cold scan issued by a live session whose callbacks resolve after
    // the session ended.

    const STALE_POINTS = [
        "before-first-unit",
        "mid-batch",
        "after-validity",
        "before-bridge",
        "mid-reconcile",
    ];

    // The mutation kinds that are real DOM writes. `harness.mutations` also
    // carries the synthetic "idle-unit"/"chunk" sampling markers, which are
    // observations rather than mutations.
    const DOM_KINDS = { innerHTML: true, append: true, remove: true, patch: true };

    function domMutationCount(harness) {
        return harness.mutations.filter(function (entry) {
            return DOM_KINDS[entry.kind] === true;
        }).length;
    }

    const staleScenarioArb = fc.record({
        generation: fc.integer({ min: 1, max: 9 }),
        section: fc.constantFrom.apply(fc, SECTION_VALUES),
        roots: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 1, maxLength: 3 }),
        matching: fc.oneof(
            { weight: 3, arbitrary: fc.array(entrySpecArb, { minLength: 1, maxLength: 14 }) },
            { weight: 1, arbitrary: fc.array(entrySpecArb, { minLength: 61, maxLength: 72, size: "max" }) }
        ),
        others: fc.array(entrySpecArb, { maxLength: 6 }),
        // Non-empty: every run really has a changed root, so the shipped decision
        // is "stale" and the bridge and reconcile continuations really exist to
        // be invalidated.
        mutations: fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 3 }),
        ops: fc
            .array(fc.constantFrom("keep", "change", "remove"), { minLength: 1, maxLength: 6 })
            .map(function (ops) {
                // At least one field change, so a reconcile chunk really patches
                // a card and the mid-reconcile interleaving is reachable.
                return ops.indexOf("change") === -1 ? ops.concat(["change"]) : ops;
            }),
        addPerRoot: fc.integer({ min: 0, max: 2 }),
        idleMode: fc.constantFrom("idle", "timeout"),
        // The interleaving itself.
        point: fc.constantFrom.apply(fc, STALE_POINTS),
        afterUnits: fc.integer({ min: 1, max: 4 }),
        afterPatches: fc.integer({ min: 1, max: 3 }),
        mode: fc.constantFrom("dispose", "generation", "both"),
        disposeHandles: fc.boolean(),
    });

    /**
     * Snapshots everything a continuation could possibly touch, and performs the
     * invalidation itself so the snapshot is taken at exactly the moment the
     * session ended.
     */
    function createStaleController(harness, scenario, session) {
        const controller = {
            fired: false,
            at: null,
            snapshot: null,
            staleUnits: 0,
            patches: 0,
            deferredBridge: [],
            deferAll: false,
            pendingAtInvalidation: 0,
            deferredAtInvalidation: 0,
        };

        controller.capture = function () {
            const li = harness.context.getLibraryIndex();
            const pending = harness.context._startupPending;
            return {
                domMutations: domMutationCount(harness),
                assignments: harness.assignments.length,
                // Every grid, serialized from its live children.
                grids: GRID_IDS.map(function (gridId) {
                    return gridId + "=" + harness.grids[gridId].innerHTML;
                }).join("\u0000"),
                model: JSON.stringify(harness.context.allTemplates),
                modelRef: harness.context.allTemplates,
                saves: harness.spies.saveLibraryIndex,
                counts: harness.spies.updateCount,
                hover: harness.spies.hoverAttach,
                finalizeCalls: harness.finalize.calls,
                scans: harness.bridge.scanCalls.length,
                bridgeCalls: harness.bridge.calls.length,
                indexKey: li ? li.validityKey : null,
                indexEntries: li ? JSON.stringify(li._entries) : null,
                trace: JSON.stringify(harness.window.__csStartupTrace),
                // The deferred-work record's WORK state. `idleToken` is
                // deliberately excluded: a stale unit is REQUIRED to release its
                // own handle first (Req 7.6), which nulls that one field.
                work: pending
                    ? JSON.stringify({
                        session: pending.session,
                        cursor: pending.cursor,
                        total: pending.list.length,
                        appendsDone: pending.appendsDone === true,
                        reconcileDone: pending.reconcileDone === true,
                        dirty: pending.dirty === true,
                        added: pending.added,
                        removed: pending.removed,
                        finalized: pending.finalized === true,
                    })
                    : null,
            };
        };

        controller.invalidate = function (where) {
            if (controller.fired) return;
            controller.fired = true;
            controller.at = where;
            controller.pendingAtInvalidation = harness.idle.pending();
            controller.deferredAtInvalidation = controller.deferredBridge.length;
            const disposing = scenario.mode === "dispose" || scenario.mode === "both";
            if (disposing) session.active = false;
            if (scenario.mode === "generation" || scenario.mode === "both") {
                session.generation = session.generation + 1;
            }
            // AppLifecycle.dispose also cancels the registered handles.
            if (disposing && scenario.disposeHandles) harness.lifecycle.disposeAll();
            controller.snapshot = controller.capture();
        };

        return controller;
    }

    /**
     * Installs the three interception seams on the vm realm's globals. templates.js
     * reads `csInterface`, `deriveCombinedValidityKeyAsync` and `patchTemplateCard`
     * as free identifiers, so replacing the globals is what the module calls; no
     * product file and no harness function is modified.
     */
    function installStaleSeams(harness, scenario, controller) {
        const realBridge = harness.context.csInterface;
        harness.context.csInterface = {
            evalScript: function (script, callback) {
                if (scenario.point !== "before-bridge" && controller.deferAll !== true) {
                    realBridge.evalScript(script, callback);
                    return;
                }
                // The scan is issued and recorded NOW, so only the callback's
                // resolution lands after invalidation.
                let captured = null;
                realBridge.evalScript(script, function (hexData) { captured = hexData; });
                controller.deferredBridge.push(function () {
                    if (typeof callback === "function") callback(captured);
                });
            },
        };

        const realDerive = harness.context.deriveCombinedValidityKeyAsync;
        harness.context.deriveCombinedValidityKeyAsync = function (paths, fsImpl, storedKey) {
            return realDerive(paths, fsImpl, storedKey).then(function (key) {
                if (scenario.point === "after-validity") controller.invalidate("after-validity");
                return key;
            });
        };

        const realPatch = harness.context.patchTemplateCard;
        harness.context.patchTemplateCard = function (record) {
            const patched = realPatch(record);
            if (patched === true) {
                controller.patches++;
                if (scenario.point === "mid-reconcile" && controller.patches >= scenario.afterPatches) {
                    controller.invalidate("mid-reconcile");
                }
            }
            return patched;
        };
    }

    /**
     * Drains the deferred queue one unit at a time, letting the validity promise,
     * the bridge callbacks and every reconcile chunk settle between units, and
     * invalidates the session at the generated point. Every run ends invalidated,
     * so the claim is never vacuous even when the chosen point was unreachable.
     */
    async function runStaleInterleaving(harness, scenario, controller) {
        harness.stage = "deferred";
        if (scenario.point === "before-first-unit") controller.invalidate("before-first-unit");

        let units = 0;
        let steps = 0;
        for (let pass = 0; pass < 4; pass++) {
            while (harness.idle.pending() > 0 && steps < 300) {
                const wasStale = controller.fired;
                harness.idle.drain(1);
                steps++;
                units++;
                if (wasStale) controller.staleUnits++;
                harness.note("idle-unit");
                if (scenario.point === "mid-batch" && units >= scenario.afterUnits) {
                    controller.invalidate("mid-batch");
                }
                await settle();
                harness.note("chunk");
            }
            await settle();
            harness.note("chunk");
        }
        await settleTimers();
        harness.idle.drain();
        await settle();
        harness.note("chunk");

        if (controller.deferredBridge.length > 0) {
            if (!controller.fired) controller.invalidate("before-bridge");
            const queued = controller.deferredBridge.splice(0);
            for (let i = 0; i < queued.length; i++) queued[i]();
            await settle();
            harness.note("chunk");
            await settleTimers();
            harness.idle.drain();
            await settle();
            harness.note("chunk");
        }

        if (!controller.fired) controller.invalidate("fallback");
        await settle();
        harness.idle.drain();
        await settle();
        await settleTimers();
        harness.note("chunk");
    }

    /** Nothing observable moved between the two samples. */
    function expectNothingMutated(before, after) {
        expect(after.domMutations).toBe(before.domMutations);
        expect(after.assignments).toBe(before.assignments);
        expect(after.grids).toBe(before.grids);
        expect(after.model).toBe(before.model);
        // The model array itself was never reassigned.
        expect(after.modelRef).toBe(before.modelRef);
        expect(after.saves).toBe(before.saves);
        expect(after.indexKey).toBe(before.indexKey);
        expect(after.indexEntries).toBe(before.indexEntries);
        expect(after.counts).toBe(before.counts);
        expect(after.hover).toBe(before.hover);
        expect(after.finalizeCalls).toBe(before.finalizeCalls);
        expect(after.scans).toBe(before.scans);
        expect(after.bridgeCalls).toBe(before.bridgeCalls);
        expect(after.trace).toBe(before.trace);
        expect(after.work).toBe(before.work);
    }

    test("stale continuations mutate nothing", async function () {
        // Which interleavings the generator actually reached, and whether the
        // suppressed continuations were real: without these a pass could be
        // vacuous.
        const seen = {
            points: {},
            modes: {},
            staleUnitRuns: 0,
            staleValidityRuns: 0,
            staleBridgeRuns: 0,
            staleReconcileRuns: 0,
            coldPathRuns: 0,
            fallbackRuns: 0,
        };

        /**
         * Feature: panel-reopen-startup, Property 7: Stale continuations mutate nothing
         * **Validates: Requirements 2.12, 7.6**
         */
        await fc.assert(fc.asyncProperty(staleScenarioArb, async function (scenario) {
            const harness = createReconcileHarness(scenario);
            await seedPersistedIndex(harness);
            expect(harness.persisted.ok).toBe(true);

            // The session owner, published before warm paint so the deferred
            // queue really captures a generation.
            const session = {
                generation: scenario.generation,
                active: true,
                isCurrent: function (token) {
                    return this.active === true && this.generation === token;
                },
            };
            harness.context.CSStartupSession = session;

            const controller = createStaleController(harness, scenario, session);
            installStaleSeams(harness, scenario, controller);

            const startup = runWarmStartup(harness);
            expect(startup.warmPaint.painted).toBe(true);
            harness.capturePainted();
            harness.changedRoots = harness.context
                .changedRootsFromKeys(harness.storedKey, harness.currentKey)
                .map(normalizePath);
            // Precondition: there really is background work to invalidate.
            expect(harness.changedRoots.length).toBeGreaterThan(0);
            expect(harness.context._startupPending.session).toBe(scenario.generation);

            await runStaleInterleaving(harness, scenario, controller);

            // Requirements 2.12 / 7.6: every continuation that resolved after the
            // session ended assigned no state, mutated no DOM, and wrote nothing
            // to persistence.
            expect(controller.fired).toBe(true);
            const before = controller.snapshot;
            const after = controller.capture();
            expectNothingMutated(before, after);

            // Every startup-owned handle was released and nothing is still queued.
            expect(harness.lifecycle.live()).toBe(0);
            expect(harness.idle.pending()).toBe(0);
            expect(harness.violations).toEqual([]);
            expect(harness.syncValidityKeyCalls()).toBe(0);

            seen.points[controller.at] = (seen.points[controller.at] || 0) + 1;
            seen.modes[scenario.mode] = (seen.modes[scenario.mode] || 0) + 1;
            if (controller.staleUnits > 0) seen.staleUnitRuns++;
            if (controller.at === "after-validity" && after.scans === 0) seen.staleValidityRuns++;
            if (controller.at === "before-bridge" && controller.deferredAtInvalidation > 0) {
                seen.staleBridgeRuns++;
            }
            if (controller.at === "mid-reconcile" && controller.patches > 0 && after.saves === 0) {
                seen.staleReconcileRuns++;
            }
            if (controller.at === "fallback") seen.fallbackRuns++;

            // ── The loadTemplates completion guard ───────────────────────────
            // A newer panel context begins, issues the background bridge scan,
            // and then ends before the scan's callbacks resolve.
            session.active = true;
            session.generation = session.generation + 1;
            controller.deferAll = true;
            // The persisted index still holds entries, so loadTemplates warm
            // paints synchronously — a full, legitimate grid write by a new
            // panel context — and defers its reconciliation through
            // setTimeout(fn, 0). The stage says so, and the painted reference is
            // re-anchored to the grid that write produced, so the invariant set
            // keeps holding the stale continuations to the CURRENT grid.
            harness.stage = "warm-paint";
            harness.painted = null;
            harness.context.loadTemplates();
            harness.capturePainted();
            harness.stage = "deferred";
            // Draining that timer is what issues the scan. The scan is
            // section-chunked and strictly sequential per root — the call for the
            // next section is issued from inside the previous section's callback
            // — so with every callback held, exactly ONE call per root is in
            // flight: the first section of each root.
            await settleTimers();
            harness.idle.drain();
            await settle();
            expect(controller.deferredBridge.length).toBe(scenario.roots.length);
            // loadTemplates' background reconcile is the only caller of the
            // synchronous whole-tree key: the startup path never reaches it.
            expect(harness.syncValidityKeyCalls()).toBe(1);

            if (scenario.mode === "generation") session.generation = session.generation + 1;
            else session.active = false;

            const coldBefore = controller.capture();
            const coldQueued = controller.deferredBridge.splice(0);
            for (let i = 0; i < coldQueued.length; i++) coldQueued[i]();
            await settle();
            await settleTimers();
            expectNothingMutated(coldBefore, controller.capture());
            expect(harness.violations).toEqual([]);
            seen.coldPathRuns++;

            return true;
        }), { numRuns: 100, seed: 20260726 });

        // Non-vacuity across the run set: every interleaving was reached, and the
        // continuations it suppressed were real ones.
        expect(seen.points["before-first-unit"] || 0).toBeGreaterThan(0);
        expect(seen.points["mid-batch"] || 0).toBeGreaterThan(0);
        expect(seen.staleUnitRuns).toBeGreaterThan(0);
        expect(seen.staleValidityRuns).toBeGreaterThan(0);
        expect(seen.staleBridgeRuns).toBeGreaterThan(0);
        expect(seen.staleReconcileRuns).toBeGreaterThan(0);
        expect(seen.coldPathRuns).toBeGreaterThan(0);
    }, 180000);
});
