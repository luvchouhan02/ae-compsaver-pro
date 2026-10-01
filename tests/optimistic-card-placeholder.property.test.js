/**
 * Optimistic_Card — placeholder thumbnail on a missing thumbnail file
 * ===================================================================
 * Exercises `renderOptimisticCard(template)` from `js/templates/templates.js`
 * (task 5.4) against the design's Property 8.
 *
 * Property 8 (Optimistic card without a thumbnail uses a placeholder):
 *   For any saved template whose thumbnail file does NOT yet exist, the rendered
 *   optimistic card has `thumbStatus = 'placeholder'` and displays a placeholder
 *   thumbnail while remaining a valid, selectable entry.
 * Validates: Requirements 3.2
 *
 * How templates.js is loaded
 * --------------------------
 * templates.js is a browser-side CEP module with no module system: every helper
 * is a bare top-level `function` declaration that depends on injected globals
 * (nfs, getLibraryIndex, allTemplates, filterAndRender, updateCount, ...). It
 * cannot be `require()`d directly, so we reuse the project's `loadHelpers` vm
 * sandbox shim (also used to load the .jsx engine helpers) and inject the
 * globals `renderOptimisticCard` reaches for. Function declarations are hoisted
 * into the sandbox, so the helper is available even though the module also has
 * runtime code that references browser-only globals we do not stub.
 *
 * The "thumbnail file does not exist" precondition is modeled by stubbing
 * `nfs().existsSync` to return false (and never exposing `statSync`), so the
 * decision logic under test always sees a missing thumbnail. A real
 * `LibraryIndex` from `js/core/persistence.js` backs `getLibraryIndex()` so the
 * "remains a valid, selectable entry" and "no full Library_Scan" guarantees are
 * observed on the actual index implementation.
 *
 * fast-check + Jest, 100 iterations. No mocks of the code under test.
 */

const fc = require("fast-check");
const path = require("path");
const { loadHelpers } = require("./helpers/loadHelpers");
const { LibraryIndex, normalizeFolderPath } = require("../js/core/persistence.js");

// ─── Mutable test state shared with the injected globals ─────────────────────
// The injected globals close over these bindings so each fast-check run can
// swap in a fresh Library_Index and reset the in-memory `allTemplates` mirror
// while `renderOptimisticCard` (loaded once) keeps resolving them by reference.
let currentIndex = new LibraryIndex();
const allTemplates = []; // mutated in place by renderOptimisticCard (unshift/splice)
let scanCount = 0; // would increment if a real Library_Scan were triggered

// A filesystem stub that always reports the thumbnail file as MISSING. Only
// existsSync is exposed (no statSync) so the helper's existence check resolves
// to "does not exist" on every path (Property 8 precondition).
const missingThumbFs = {
    existsSync: function () {
        return false;
    },
};

const sandbox = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        // Node fs accessor used by the helper's thumbnail-existence probe.
        nfs: function () {
            return missingThumbFs;
        },
        // The persisted/in-memory Library_Index singleton accessor.
        getLibraryIndex: function () {
            return currentIndex;
        },
        // In-memory Library_Index mirror the canonical renderer reads from.
        allTemplates: allTemplates,
        // Browser globals the module references at various points; harmless stubs.
        showToast: function () { },
        rootPath: "",
    },
});

// `filterAndRender`, `updateCount`, and `loadTemplates` are declared INSIDE
// templates.js, so their real (DOM-touching) implementations override any
// injected stub during module evaluation. We replace them on the loaded vm
// context AFTER evaluation — `renderOptimisticCard` resolves these as free
// globals at call time, so the context override is what actually runs. The
// re-render is a no-op (it is a from-memory render, not a disk scan), and
// `loadTemplates` (the only genuine full Library_Scan entry point) is counted
// so we can assert the optimistic path never triggers a scan.
sandbox.context.filterAndRender = function () { };
sandbox.context.updateCount = function () { };
sandbox.context.loadTemplates = function () {
    scanCount++;
};

const renderOptimisticCard = sandbox.get("renderOptimisticCard");

// ─── Generators ──────────────────────────────────────────────────────────────
const segment = fc.constantFrom("root", "sec", "cat", "id", "a", "b", "c", "1", "2");

// Paths mix slash styles (both normalize identically to forward slashes) but
// avoid trailing separators: templates.js normalizes with a backslash→slash
// replacement only, while LibraryIndex additionally trims a trailing slash, so
// a trailing separator would surface that pre-existing normalization detail
// rather than the placeholder behavior under test (Property 8).
const folderPathArb = fc
    .record({
        segs: fc.array(segment, { minLength: 1, maxLength: 4 }),
        sep: fc.constantFrom("/", "\\"),
    })
    .map(({ segs, sep }) => segs.join(sep));

// templates.js's own path normalization (backslash → forward slash).
function slashNorm(p) {
    return ("" + p).replace(/\\/g, "/");
}

// A just-saved template descriptor. `section` is always a truthy value so the
// helper never falls back to getTemplateSection(). `thumbnailPath`/`thumbnail`
// are sometimes present and sometimes absent — either way the file is reported
// missing, so the outcome must be a placeholder in every case.
const templateArb = fc.record(
    {
        folderPath: folderPathArb,
        name: fc.string({ minLength: 1, maxLength: 12 }),
        id: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
        category: fc.string({ maxLength: 8 }),
        section: fc.constantFrom("comp", "layer", "text", "footage", "effect", "icon", "overlay"),
        thumbnailPath: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
        thumbnail: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
        favorite: fc.option(fc.boolean(), { nil: undefined }),
    },
    { requiredKeys: ["folderPath", "name", "category", "section"] }
);

// Pre-existing library entries so the new optimistic card is inserted alongside
// others — verifying it remains a distinct, selectable entry at the head.
const existingEntryArb = fc.record(
    {
        folderPath: folderPathArb,
        id: fc.string({ maxLength: 8 }),
        name: fc.string({ maxLength: 12 }),
        category: fc.string({ maxLength: 8 }),
        section: fc.constantFrom("comp", "layer", "text", "footage", "effect", "icon", "overlay"),
        thumbStatus: fc.constantFrom("ready", "placeholder", "failed"),
    },
    { requiredKeys: ["folderPath", "id", "name", "category", "section"] }
);

function seedIndex(existing) {
    const index = new LibraryIndex();
    for (const e of existing) {
        index.insertAtHead(e);
        // Mirror into allTemplates so the canonical in-memory list is populated.
        allTemplates.unshift({
            name: e.name,
            category: e.category,
            section: e.section,
            folderPath: normalizeFolderPath(e.folderPath),
            thumbnail: e.thumbStatus === "ready" ? "existing-thumb.png" : "",
            thumbStatus: e.thumbStatus,
        });
    }
    return index;
}

describe("Optimistic_Card placeholder on missing thumbnail (renderOptimisticCard)", () => {
    test("the helper loaded from templates.js", () => {
        expect(typeof renderOptimisticCard).toBe("function");
    });

    // Feature: save-import-performance-redesign, Property 8: Optimistic card without a thumbnail uses a placeholder
    // Validates: Requirements 3.2
    test("Property 8: a saved template with no thumbnail file renders a placeholder, selectable card", () => {
        fc.assert(
            fc.property(
                fc.array(existingEntryArb, { maxLength: 10 }),
                templateArb,
                (existing, template) => {
                    // Fresh state for this run.
                    allTemplates.length = 0;
                    scanCount = 0;
                    currentIndex = seedIndex(existing);

                    const normNew = normalizeFolderPath(template.folderPath);

                    const tpl = renderOptimisticCard(template);

                    // ── The rendered card is a valid entry (not dropped). ──
                    expect(tpl).not.toBeNull();
                    expect(typeof tpl).toBe("object");

                    // ── thumbStatus === 'placeholder' on the returned card … ──
                    expect(tpl.thumbStatus).toBe("placeholder");
                    // … and it carries no concrete thumbnail, so the renderer
                    // emits its placeholder artwork (a placeholder thumbnail).
                    expect(tpl.thumbnail).toBe("");

                    // ── Present & selectable in the in-memory mirror at head. ──
                    expect(slashNorm(allTemplates[0].folderPath)).toBe(slashNorm(template.folderPath));
                    expect(allTemplates[0].thumbStatus).toBe("placeholder");
                    // A selectable/openable card needs an identity + folder to open.
                    expect(allTemplates[0].name).toBe(template.name);
                    // Exactly one entry for this folder (no duplicate cards).
                    const mirrorMatches = allTemplates.filter(
                        (t) => slashNorm(t.folderPath) === slashNorm(template.folderPath)
                    );
                    expect(mirrorMatches.length).toBe(1);

                    // ── Present in the persisted Library_Index as placeholder. ──
                    expect(currentIndex.has(normNew)).toBe(true);
                    const entry = currentIndex.getEntry(normNew);
                    expect(entry).not.toBeNull();
                    expect(entry.thumbStatus).toBe("placeholder");
                    expect(currentIndex.entries()[0].folderPath).toBe(normNew);

                    // ── No full Library_Scan was triggered (Req 3.5/5.2). ──
                    expect(scanCount).toBe(0);
                    expect(currentIndex.needsFullScan()).toBe(false);
                }
            ),
            { numRuns: 100 }
        );
    });

    // ─── Focused examples ─────────────────────────────────────────────────────
    test("template with a thumbnailPath whose file is missing still yields a placeholder", () => {
        allTemplates.length = 0;
        currentIndex = new LibraryIndex();
        const tpl = renderOptimisticCard({
            folderPath: "root/comp/hero",
            name: "Hero",
            category: "Titles",
            section: "comp",
            thumbnailPath: "root/comp/hero/thumb.png",
        });
        expect(tpl.thumbStatus).toBe("placeholder");
        expect(tpl.thumbnail).toBe("");
        expect(currentIndex.getEntry("root/comp/hero").thumbStatus).toBe("placeholder");
    });

    test("template with no thumbnail field at all yields a placeholder", () => {
        allTemplates.length = 0;
        currentIndex = new LibraryIndex();
        const tpl = renderOptimisticCard({
            folderPath: "root/text/lower-third",
            name: "Lower Third",
            category: "Text",
            section: "text",
        });
        expect(tpl.thumbStatus).toBe("placeholder");
        expect(tpl.thumbnail).toBe("");
        expect(currentIndex.entries()[0].folderPath).toBe("root/text/lower-third");
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// media-engine-lag — Property 3: Import batch canonicalization
// =============================================================================
// What is under test
// ------------------
// The REAL `MediaImportCoordinator` (and the REAL `MediaWorkCoordinator` it
// builds) from `js/core/fastMediaEngine.js`, committing through the REAL
// `MediaEntryRepository` from `js/core/persistence.js`. Only the environment is
// faked: an in-memory case-insensitive filesystem (async `stat`/`readdir`), a
// recording scheduler that runs stage jobs inline, a recording keyed-card helper
// standing in for the DOM, and injected stage workers so no real copy/decode
// work is needed to observe *when* stage work is admitted.
//
// Every expectation is derived from an independent reference model in this file
// (`p3Canonical`, `p3Identity`, `p3Model`) rather than from engine helpers, so a
// canonicalization regression cannot agree with itself.
// ─────────────────────────────────────────────────────────────────────────────

const vm = require("vm");
const nodeFs = require("fs");
const { MediaEntryRepository } = require("../js/core/persistence.js");

const P3_ROOT = path.resolve(__dirname, "..");
const P3_ENGINE_SOURCE = nodeFs.readFileSync(path.join(P3_ROOT, "js", "core", "fastMediaEngine.js"), "utf8");
const P3_ENGINE_SCRIPT = new vm.Script(P3_ENGINE_SOURCE, { filename: "fastMediaEngine.js" });

const P3_LIBRARY_ROOT = "C:/library";
const P3_SOURCE_ROOT = "C:/originals";
const P3_EXTERNAL_ROOT = "C:/archive";
const P3_DIRS = ["one", "two"];

// The Supported_Media_File set the Media_Engine must keep accepting.
const P3_SUPPORTED = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".mp4": "video", ".mov": "video", ".webm": "video", ".avi": "video",
};

/** Independent reference canonicalization: slashes, `.`/`..`, drive case, trailing separators. */
function p3Canonical(value) {
    let source = String(value === undefined || value === null ? "" : value).replace(/\\/g, "/");
    let prefix = "";
    let absolute = false;
    if (/^[A-Za-z]:\//.test(source)) {
        prefix = source.charAt(0).toUpperCase() + ":";
        source = source.substring(2);
        absolute = true;
    } else if (source.indexOf("//") === 0) {
        prefix = "//";
        source = source.substring(2);
        absolute = true;
    } else if (source.charAt(0) === "/") {
        prefix = "/";
        source = source.substring(1);
        absolute = true;
    }
    const out = [];
    const parts = source.split("/");
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part || part === ".") continue;
        if (part === "..") {
            if (out.length && out[out.length - 1] !== "..") out.pop();
            else if (!absolute) out.push("..");
            continue;
        }
        out.push(part);
    }
    let joined;
    if (prefix === "//") joined = "//" + out.join("/");
    else if (prefix === "/") joined = "/" + out.join("/");
    else if (prefix) joined = prefix + "/" + out.join("/");
    else joined = out.join("/");
    return joined.replace(/\/+$/, "");
}

/** Normalized_Source_Path identity: Windows-style paths compare case-insensitively. */
function p3Identity(value) {
    const canonical = p3Canonical(value);
    const windowsPath = /^[A-Za-z]:($|\/)/.test(canonical) || canonical.indexOf("//") === 0;
    return windowsPath ? canonical.toLowerCase() : canonical;
}

function p3Ext(value) {
    const at = String(value).lastIndexOf(".");
    return at === -1 ? "" : String(value).substring(at).toLowerCase();
}

/** Case-insensitive in-memory filesystem exposing only asynchronous APIs. */
function p3CreateFilesystem() {
    const nodes = {};
    const readdirCalls = [];
    const statCalls = [];

    function keyOf(target) {
        return p3Canonical(target).toLowerCase();
    }
    function get(target) {
        const node = nodes[keyOf(target)];
        return node || null;
    }
    function addDirectory(target) {
        const canonical = p3Canonical(target);
        const key = canonical.toLowerCase();
        if (!nodes[key]) nodes[key] = { dir: true, path: canonical, children: [] };
        return nodes[key];
    }
    function addFile(target) {
        const canonical = p3Canonical(target);
        const key = canonical.toLowerCase();
        if (nodes[key]) return nodes[key];
        const at = canonical.lastIndexOf("/");
        const parentPath = canonical.substring(0, at);
        const name = canonical.substring(at + 1);
        const parent = addDirectory(parentPath);
        parent.children.push(name);
        nodes[key] = { dir: false, path: canonical, children: [] };
        return nodes[key];
    }
    function statsFor(node) {
        return {
            size: node.dir ? 0 : 64,
            mtimeMs: 1,
            isDirectory: function () { return node.dir === true; },
            isFile: function () { return node.dir !== true; },
        };
    }

    const api = {
        stat: function (target, callback) {
            statCalls.push(p3Canonical(target));
            const node = get(target);
            callback(node ? null : new Error("ENOENT: " + target), node ? statsFor(node) : null);
        },
        readdir: function (target, callback) {
            readdirCalls.push(p3Canonical(target));
            const node = get(target);
            if (!node || !node.dir) {
                callback(new Error("ENOTDIR: " + target), null);
                return;
            }
            callback(null, node.children.slice());
        },
    };

    return {
        fs: api,
        get: get,
        addFile: addFile,
        addDirectory: addDirectory,
        readdirCalls: readdirCalls,
        statCalls: statCalls,
    };
}

/** Load the engine into its own realm with only environment doubles. */
function p3LoadEngine(fakeFs) {
    const context = {
        window: {
            rootPath: P3_LIBRARY_ROOT,
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function () { throw new Error("Property 3 requires no media element"); },
        },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, Date, Buffer,
        Image: function () { },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent,
    };
    context.window.window = context.window;
    vm.createContext(context);
    P3_ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.MediaImportCoordinator !== "function") {
        throw new Error("MediaImportCoordinator was not exposed by the media engine");
    }
    return context.window;
}

/** Path spellings that must all canonicalize to the same Normalized_Source_Path. */
function p3Variant(canonical, variant) {
    if (variant === 1) return canonical.replace(/\//g, "\\");
    if (variant === 2) return canonical + "/";
    if (variant === 3) return canonical.replace(/^([A-Za-z]:)\//, "$1/./");
    if (variant === 4) return canonical.replace(/^([A-Za-z]:)\//, "$1//");
    if (variant === 5) return canonical.replace(/\/([^/]+)$/, "/extra/../$1");
    if (variant === 6) return canonical.toUpperCase();
    return canonical;
}

/**
 * Reference model: discovery order, supported-format filter, first-occurrence
 * deduplication by identity, and the count of skipped duplicates.
 */
function p3Model(rawSelection, filesystem, existingIdentities) {
    const seen = {};
    const accepted = [];
    let deduplicated = 0;
    for (let i = 0; i < rawSelection.length; i++) {
        const canonical = p3Canonical(rawSelection[i]);
        const node = filesystem.get(canonical);
        if (!node) continue;
        const candidates = [];
        if (node.dir) {
            for (let c = 0; c < node.children.length; c++) {
                const childPath = p3Canonical(canonical + "/" + node.children[c]);
                const child = filesystem.get(childPath);
                if (child && !child.dir) candidates.push(childPath);
            }
        } else {
            candidates.push(canonical);
        }
        for (let j = 0; j < candidates.length; j++) {
            const candidate = candidates[j];
            if (!Object.prototype.hasOwnProperty.call(P3_SUPPORTED, p3Ext(candidate))) continue;
            const identity = p3Identity(candidate);
            if (Object.prototype.hasOwnProperty.call(seen, identity) ||
                Object.prototype.hasOwnProperty.call(existingIdentities, identity)) {
                deduplicated++;
                continue;
            }
            seen[identity] = true;
            accepted.push(candidate);
        }
    }
    return { accepted: accepted, deduplicated: deduplicated };
}

/** Run one whole batch import through the real coordinator. */
async function p3Run(scenario) {
    const filesystem = p3CreateFilesystem();
    filesystem.addDirectory(P3_SOURCE_ROOT);
    filesystem.addDirectory(P3_EXTERNAL_ROOT);
    for (let i = 0; i < P3_DIRS.length; i++) filesystem.addDirectory(P3_SOURCE_ROOT + "/" + P3_DIRS[i]);

    // Distinct source files; equal display names across the two folders are kept.
    const files = [];
    const fileKeys = {};
    for (let i = 0; i < scenario.files.length; i++) {
        const spec = scenario.files[i];
        const filePath = p3Canonical(P3_SOURCE_ROOT + "/" + spec.dir + "/" + spec.base + spec.ext);
        const key = filePath.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(fileKeys, key)) continue;
        fileKeys[key] = true;
        filesystem.addFile(filePath);
        files.push(filePath);
    }

    // Pre-existing index: some entries may already own a selected source path.
    const existingEntries = [];
    const existingIdentities = {};
    for (let i = 0; i < scenario.existing.length; i++) {
        const spec = scenario.existing[i];
        const sourcePath = spec.useSelected && files.length
            ? files[spec.ref % files.length]
            : p3Canonical(P3_EXTERNAL_ROOT + "/legacy-" + i + ".mp4");
        const identity = p3Identity(sourcePath);
        if (Object.prototype.hasOwnProperty.call(existingIdentities, identity)) continue;
        existingIdentities[identity] = true;
        existingEntries.push({
            id: "legacy-p3-" + i,
            name: "legacy-" + spec.nameSeed,
            category: spec.category,
            section: "footage",
            type: "media",
            mediaType: "video",
            folderPath: p3Canonical(P3_LIBRARY_ROOT + "/footage/legacy/" + i),
            sourcePath: sourcePath,
            mainFile: "legacy-" + i + ".mp4",
            thumbStatus: "ready",
            terminalState: "ready",
            unknownLegacyField: spec.extra,
        });
    }

    const rawSelection = [];
    for (let i = 0; i < scenario.selection.length; i++) {
        const item = scenario.selection[i];
        let base;
        if (item.kind === "folder") base = P3_SOURCE_ROOT + "/" + P3_DIRS[item.ref % P3_DIRS.length];
        else if (item.kind === "missing") base = P3_SOURCE_ROOT + "/" + P3_DIRS[item.ref % P3_DIRS.length] + "/phantom-" + item.ref + ".png";
        else base = files[item.ref % files.length];
        rawSelection.push(p3Variant(p3Canonical(base), item.variant));
    }

    const engine = p3LoadEngine(filesystem.fs);
    const mirror = [];
    const persisted = [];
    const repository = new MediaEntryRepository({
        entries: existingEntries,
        allTemplates: mirror,
        persist: function (serialized) { persisted.push(serialized); },
    });

    let sequence = 0;
    const commits = [];
    const patches = [];
    const inserts = [];
    const cardPatches = [];
    const jobs = [];
    const countUpdates = [];
    const frames = [];
    const timers = [];

    const repositoryFacade = {
        commitOptimisticBatch: function (entries) {
            const startSeq = sequence++;
            const outcome = repository.commitOptimisticBatch(entries);
            commits.push({ startSeq: startSeq, endSeq: sequence++, count: entries.length });
            return outcome;
        },
        patchById: function (id, fields) {
            patches.push({ seq: sequence++, id: id });
            return repository.patchById(id, fields);
        },
        getById: function (id) { return repository.getById(id); },
        getBySourcePath: function (value) { return repository.getBySourcePath(value); },
        snapshot: function () { return repository.snapshot(); },
        refreshValidityAsync: function () { return repository.refreshValidityAsync(); },
    };

    const cardHelper = {
        insertBatch: function (entries) {
            const ids = [];
            for (let i = 0; i < entries.length; i++) ids.push(entries[i].id);
            inserts.push({ seq: sequence++, ids: ids });
            return { ok: true, inserted: entries.length };
        },
        patchById: function (id) {
            cardPatches.push({ seq: sequence++, id: id });
            return { ok: true };
        },
        unregister: function () { return true; },
        dispose: function () { return true; },
    };

    const control = {
        isCancelled: function () { return false; },
        onCancel: function () { return false; },
        registerCleanup: function () { },
        registerResource: function (resource) { return resource; },
        registerStream: function (stream) { return stream; },
        registerVideo: function (video) { return video; },
        registerObjectUrl: function (url) { return url; },
        registerTimer: function (timer) { return timer; },
        registerChildProcess: function (child) { return child; },
        releaseProcess: function () { return true; },
    };

    const scheduler = {
        enqueue: function (lane, worker, options) {
            jobs.push({
                seq: sequence++,
                lane: lane,
                stage: options && options.stage,
                mediaId: options && options.mediaId,
                sourcePath: options && options.sourcePath,
            });
            let promise;
            try { promise = Promise.resolve(worker(control)); }
            catch (error) { promise = Promise.reject(error); }
            return { promise: promise, lane: lane, cancel: function () { return false; } };
        },
        defer: function (lane, delay, worker, options) { return this.enqueue(lane, worker, options); },
        cancelByOwner: function () { return true; },
        snapshot: function () {
            return {
                lanes: {
                    filesystem: { pending: 0, active: 0 },
                    thumbnail: { pending: 0, active: 0 },
                    ffmpeg: { pending: 0, active: 0 },
                },
                processes: 0,
            };
        },
    };

    const coordinator = new engine.MediaImportCoordinator({
        fs: filesystem.fs,
        scheduler: scheduler,
        repository: repositoryFacade,
        cardHelper: cardHelper,
        rootPath: P3_LIBRARY_ROOT,
        caseInsensitivePaths: false,
        reconcileAfterIdle: false,
        progressIntervalMs: 60000,
        idFactory: function (seq) { return "p3-" + seq; },
        updateCategoryCounts: function (counts) { countUpdates.push(counts); },
        requestAnimationFrame: function (callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrame: function () { },
        setTimeout: function (handler, delay) { timers.push({ handler: handler, delay: delay }); return timers.length; },
        clearTimeout: function () { },
        workers: {
            copy: function (item) { return Promise.resolve({ ok: true, fileSize: 64, path: item.destinationMedia }); },
            thumbnail: function (item) { return Promise.resolve({ ok: true, path: item.destinationThumbnail, status: "available" }); },
            ffmpeg: function (item) { return Promise.resolve({ ok: true, thumbnailPath: item.destinationThumbnail }); },
        },
    });

    const result = await coordinator.importSelection(rawSelection, { section: "footage" });
    const snapshot = result && result.batch ? coordinator.snapshot(result.batch.id) : null;
    coordinator.dispose();

    return {
        result: result,
        batchSnapshot: snapshot,
        model: p3Model(rawSelection, filesystem, existingIdentities),
        existingEntries: existingEntries,
        durable: repository.snapshot(),
        repository: repository,
        totals: coordinator.totals,
        commits: commits,
        patches: patches,
        inserts: inserts,
        cardPatches: cardPatches,
        jobs: jobs,
        countUpdates: countUpdates,
        readdirCalls: filesystem.readdirCalls,
        persisted: persisted,
    };
}

const p3FileArb = fc.record({
    dir: fc.constantFrom("one", "two"),
    base: fc.constantFrom("alpha", "beta", "clip", "shot"),
    ext: fc.constantFrom(".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".webm", ".avi", ".txt", ".psd", ".aep", ".exe"),
});

const p3SelectionArb = fc.record({
    kind: fc.constantFrom("file", "file", "folder", "missing"),
    ref: fc.nat({ max: 11 }),
    variant: fc.integer({ min: 0, max: 6 }),
});

const p3ExistingArb = fc.record({
    nameSeed: fc.constantFrom("alpha", "beta", "clip", "shot"),
    category: fc.constantFrom("Footage", "Clips", "Stills"),
    useSelected: fc.boolean(),
    ref: fc.nat({ max: 11 }),
    extra: fc.string({ maxLength: 8 }),
});

const p3ScenarioArb = fc.record({
    files: fc.array(p3FileArb, { minLength: 1, maxLength: 6 }),
    selection: fc.array(p3SelectionArb, { maxLength: 8 }),
    existing: fc.array(p3ExistingArb, { maxLength: 3 }),
});

describe("media-engine-lag Property 3: import batch canonicalization (MediaImportCoordinator)", () => {
    // Feature: media-engine-lag, Property 3: Import batch canonicalization is lossless and collision-safe
    // **Validates: Requirements 2.2, 2.6, 5.9, 5.10, 7.11**
    test("Property 3: batch preparation is lossless, collision-safe, committed once, and precedes all stage work", async () => {
        await fc.assert(
            fc.asyncProperty(p3ScenarioArb, async (scenario) => {
                const run = await p3Run(scenario);
                const expected = run.model.accepted;

                if (!expected.length) {
                    // Nothing supported and new: no batch, no commit, no stage work,
                    // and the pre-existing index is untouched.
                    expect(run.result.ok).toBe(true);
                    expect(run.result.batch).toBeNull();
                    expect(run.commits.length).toBe(0);
                    expect(run.jobs.length).toBe(0);
                    expect(run.durable).toEqual(run.existingEntries);
                    return;
                }

                expect(run.result.ok).toBe(true);
                const entries = run.result.accepted;

                // ── Every Supported_Media_File is accepted, unsupported filtered ──
                expect(entries.map((entry) => entry.sourcePath)).toEqual(expected);
                for (let i = 0; i < entries.length; i++) {
                    const kind = P3_SUPPORTED[p3Ext(entries[i].sourcePath)];
                    expect(kind).toBeDefined();
                    expect(entries[i].mediaType).toBe(kind);
                }
                expect(run.totals.deduplicated).toBe(run.model.deduplicated);

                // ── One item and one immutable ID per unique normalized path ──
                const ids = entries.map((entry) => entry.id);
                const destinations = entries.map((entry) => entry.folderPath);
                const identities = entries.map((entry) => p3Identity(entry.sourcePath));
                expect(new Set(ids).size).toBe(ids.length);
                expect(new Set(identities).size).toBe(identities.length);
                // ── Distinct paths keep distinct destinations even when names match ──
                expect(new Set(destinations).size).toBe(destinations.length);
                const byName = {};
                for (let i = 0; i < entries.length; i++) {
                    const key = "$" + entries[i].name;
                    (byName[key] = byName[key] || []).push(entries[i]);
                }
                Object.keys(byName).forEach((key) => {
                    const group = byName[key];
                    expect(new Set(group.map((entry) => entry.id)).size).toBe(group.length);
                    expect(new Set(group.map((entry) => entry.folderPath)).size).toBe(group.length);
                });

                // ── Exactly one commit for the whole batch ──
                expect(run.commits.length).toBe(1);
                expect(run.commits[0].count).toBe(entries.length);
                expect(run.result.batch.commitCount).toBe(1);
                expect(run.batchSnapshot.commitCount).toBe(1);
                expect(run.totals.commits).toBe(1);

                // ── Cards precede the commit; no stage work starts before it ──
                expect(run.inserts.length).toBe(1);
                expect(run.inserts[0].ids).toEqual(ids);
                expect(run.inserts[0].seq).toBeLessThan(run.commits[0].startSeq);
                const copyJobs = run.jobs.filter((job) => job.stage === "copy");
                expect(copyJobs.length).toBe(entries.length);
                expect(copyJobs.map((job) => job.mediaId)).toEqual(ids);
                for (let i = 0; i < run.jobs.length; i++) {
                    expect(run.jobs[i].seq).toBeGreaterThan(run.commits[0].endSeq);
                }

                // ── Every pre-existing entry and its relative order survive ──
                const durable = run.durable;
                const retained = durable.filter((entry) =>
                    typeof entry.id === "string" && entry.id.indexOf("legacy-p3-") === 0);
                expect(retained).toEqual(run.existingEntries);
                // No full library scan was initiated for the committed library.
                expect(run.readdirCalls.indexOf(P3_LIBRARY_ROOT)).toBe(-1);

                // ── One durable entry, with its original ID, per unique path ──
                expect(durable.length).toBe(entries.length + run.existingEntries.length);
                const durableIdentities = durable.map((entry) => p3Identity(entry.sourcePath));
                expect(new Set(durableIdentities).size).toBe(durable.length);
                for (let i = 0; i < ids.length; i++) {
                    const stored = run.repository.getById(ids[i]);
                    expect(stored).not.toBeNull();
                    expect(stored.id).toBe(ids[i]);
                    expect(p3Identity(stored.sourcePath)).toBe(identities[i]);
                }

                // ── Exactly one aggregate category-count update after the commit ──
                expect(run.countUpdates.length).toBe(1);
            }),
            { numRuns: 100 }
        );
    });
});
