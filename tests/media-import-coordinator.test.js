/**
 * Media import coordination — focused examples
 * ===========================================
 *
 * Feature: media-engine-lag — Task 7.9
 * Validates: Requirements 1.4-1.5, 2.1-2.8, 3.5-3.7, 5.5, 5.9-5.10, 7.2-7.4
 *
 * What is under test
 * ------------------
 * The REAL `MediaImportCoordinator` and the REAL `MediaWorkCoordinator` it
 * builds (js/core/fastMediaEngine.js), committing through the REAL
 * `MediaEntryRepository` (js/core/persistence.js) and rendering through the REAL
 * `KeyedMediaCardHelper` (js/core/keyedMediaCardHelper.js) with the REAL shared
 * card markup (js/templates/templates.js) against a REAL parsed DOM tree
 * (tests/helpers/miniDom.js).
 *
 * Only the environment is faked: an asynchronous in-memory filesystem, a
 * recording scheduler that runs each admitted job on a microtask, the three
 * stage workers, animation frames, and timers.
 *
 * Why the clock is injected
 * -------------------------
 * The 100 ms budgets in Requirements 2.1, 2.2 and 2.5 are asserted on the values
 * the REAL `MediaScenarioMetrics` recorder (js/core/observability.js) captured,
 * not on wall-clock stopwatches in the test body. The recorder is loaded in its
 * own realm over an injected `performance.now()` whose value is a modeled I/O
 * cost (every fake filesystem operation and every admitted job advances it) plus
 * the real elapsed time of the code under test, so a measurement is deterministic
 * and still attributes real work.
 *
 * These are concrete examples, not properties. Generated coverage for the same
 * code lives in tests/optimistic-card-placeholder.property.test.js (Property 3),
 * tests/performance/media-import-batch.property.test.js (Properties 4 and 5) and
 * tests/performance/fast-media-terminal-regression.test.js (Property 8).
 */

"use strict";

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");

const { MediaEntryRepository, LibraryIndex } = require("../js/core/persistence.js");
const { KeyedMediaCardHelper } = require("../js/core/keyedMediaCardHelper.js");
const { loadHelpers } = require("./helpers/loadHelpers.js");
const { createMiniDocument, MiniElement } = require("./helpers/miniDom.js");

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SCRIPT = new vm.Script(nodeFs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8"), {
    filename: "fastMediaEngine.js",
});
const OBSERVABILITY_SCRIPT = new vm.Script(nodeFs.readFileSync(path.join(ROOT, "js/core/observability.js"), "utf8"), {
    filename: "observability.js",
});

const LIBRARY_ROOT = "C:/library";
const SOURCE_FOLDER = "C:/originals/mixed";
const VALIDITY_KEY = "disk-key-A";
const RESPONSE_BUDGET_MS = 100;
const FS_OP_COST_MS = 2;   // modeled cost of one asynchronous filesystem call
const JOB_COST_MS = 3;     // modeled cost of admitting one background stage job

// ─── The real shared single-card markup (browser module, no module system) ────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: constants.get("SECTIONS"),
        IMAGE_SECTIONS: constants.get("IMAGE_SECTIONS"),
    },
});
const templates = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: constants.get("SECTIONS"),
        IMAGE_SECTIONS: constants.get("IMAGE_SECTIONS"),
        escapeAttr: utils.get("escapeAttr"),
        escapeHTML: utils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
});
const renderTemplateCardMarkup = templates.get("renderTemplateCardMarkup");
if (typeof renderTemplateCardMarkup !== "function") {
    throw new Error("Task 7.9 requires renderTemplateCardMarkup from js/templates/templates.js");
}

// ─── Test-local path canonicalization (no engine helpers) ─────────────────────
function canonicalPath(value) {
    let source = String(value === undefined || value === null ? "" : value).replace(/\\/g, "/");
    let prefix = "";
    let absolute = false;
    if (/^[A-Za-z]:\//.test(source)) {
        prefix = source.charAt(0).toUpperCase() + ":";
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
    const joined = prefix === "/" ? "/" + out.join("/") : (prefix ? prefix + "/" + out.join("/") : out.join("/"));
    return joined.replace(/\/+$/, "");
}

// ─── Injected clock: modeled I/O cost + real elapsed time ────────────────────
function createClock() {
    const startedAt = Date.now();
    let modeled = 0;
    return {
        advance: function (ms) { modeled += ms; },
        modeled: function () { return modeled; },
        now: function () { return modeled + (Date.now() - startedAt); },
    };
}

// ─── The real MediaScenarioMetrics recorder over the injected clock ──────────
function createMetricsRealm(clock) {
    const context = {
        performance: { now: function () { return clock.now(); } },
        Date: Date,
        console: { log: function () { }, warn: function () { }, error: function () { } },
    };
    vm.createContext(context);
    OBSERVABILITY_SCRIPT.runInContext(context);
    if (!context.PerfEvents || typeof context.PerfEvents.createMediaScenarioMetrics !== "function") {
        throw new Error("observability.js did not expose createMediaScenarioMetrics");
    }
    const events = [];
    context.PerfEvents.subscribe(function (event) { events.push(event); });
    return {
        events: events,
        metrics: context.PerfEvents.createMediaScenarioMetrics({ enabled: true }),
        phases: context.PerfEvents.mediaPhases,
    };
}

// ─── Asynchronous in-memory filesystem (no synchronous API is exposed) ───────
function createFakeFilesystem(clock) {
    const nodes = {};
    const calls = [];

    function keyOf(target) { return canonicalPath(target).toLowerCase(); }
    function addDirectory(target) {
        const canonical = canonicalPath(target);
        const key = canonical.toLowerCase();
        if (!nodes[key]) nodes[key] = { dir: true, path: canonical, children: [] };
        return nodes[key];
    }
    function addFile(target) {
        const canonical = canonicalPath(target);
        const key = canonical.toLowerCase();
        if (nodes[key]) return nodes[key];
        const at = canonical.lastIndexOf("/");
        const parent = addDirectory(canonical.substring(0, at));
        parent.children.push(canonical.substring(at + 1));
        nodes[key] = { dir: false, path: canonical, children: [] };
        return nodes[key];
    }
    function statsFor(node) {
        return {
            size: node.dir ? 0 : 4096,
            mtimeMs: 1,
            isDirectory: function () { return node.dir === true; },
            isFile: function () { return node.dir !== true; },
        };
    }

    const promises = {
        stat: function (target) {
            calls.push({ call: "stat", target: canonicalPath(target) });
            clock.advance(FS_OP_COST_MS);
            const node = nodes[keyOf(target)];
            return node ? Promise.resolve(statsFor(node)) : Promise.reject(new Error("ENOENT: " + target));
        },
        readdir: function (target) {
            calls.push({ call: "readdir", target: canonicalPath(target) });
            clock.advance(FS_OP_COST_MS);
            const node = nodes[keyOf(target)];
            if (!node || !node.dir) return Promise.reject(new Error("ENOTDIR: " + target));
            return Promise.resolve(node.children.slice());
        },
        mkdir: function (target) {
            calls.push({ call: "mkdir", target: canonicalPath(target) });
            clock.advance(FS_OP_COST_MS);
            addDirectory(target);
            return Promise.resolve();
        },
    };

    return {
        fs: { promises: promises },
        calls: calls,
        addFile: addFile,
        addDirectory: addDirectory,
        countOf: function (call) {
            return calls.filter(function (entry) { return entry.call === call; }).length;
        },
    };
}

// A filesystem that fails loudly: any use is a library scan the warm path must
// not perform.
function createStrictFilesystem() {
    const calls = [];
    function refuse(name) {
        return function (target) {
            calls.push({ call: name, target: target });
            throw new Error("warm startup must not call fs." + name);
        };
    }
    return {
        calls: calls,
        fs: {
            promises: { stat: refuse("promises.stat"), readdir: refuse("promises.readdir") },
            stat: refuse("stat"),
            readdir: refuse("readdir"),
            readFile: refuse("readFile"),
            readFileSync: refuse("readFileSync"),
            readdirSync: refuse("readdirSync"),
            existsSync: refuse("existsSync"),
            statSync: refuse("statSync"),
        },
    };
}

// ─── Recording scheduler: real admission order, one microtask per job ────────
function createRecordingScheduler(clock, hooks) {
    const jobs = [];
    const lanes = {
        filesystem: { pending: 0, active: 0 },
        thumbnail: { pending: 0, active: 0 },
        ffmpeg: { pending: 0, active: 0 },
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
        jobs: jobs,
        cancelledOwners: [],
        enqueue: function (lane, worker, options) {
            options = options || {};
            const record = {
                index: jobs.length + 1,
                lane: lane,
                stage: options.stage,
                mediaId: options.mediaId,
                sourcePath: options.sourcePath,
                owner: options.owner,
            };
            jobs.push(record);
            if (!lanes[lane]) lanes[lane] = { pending: 0, active: 0 };
            lanes[lane].pending++;
            if (hooks && typeof hooks.onAdmit === "function") hooks.onAdmit(record);
            const promise = Promise.resolve().then(function () {
                lanes[lane].pending--;
                lanes[lane].active++;
                clock.advance(JOB_COST_MS);
                return worker(control);
            }).then(function (result) {
                lanes[lane].active--;
                return result;
            }, function (error) {
                lanes[lane].active--;
                throw error;
            });
            return { promise: promise, lane: lane, cancel: function () { return false; } };
        },
        defer: function (lane, delay, worker, options) { return scheduler.enqueue(lane, worker, options); },
        cancelByOwner: function (owner) { scheduler.cancelledOwners.push(owner); return true; },
        snapshot: function () { return { lanes: lanes, processes: lanes.ffmpeg.active }; },
        stagesFor: function (mediaId) {
            return jobs.filter(function (job) { return job.mediaId === mediaId; }).map(function (job) { return job.stage; });
        },
    };
    return scheduler;
}

// ─── Tracked timers and animation frames ─────────────────────────────────────
function createTimerRegistry() {
    const live = {};
    let next = 1;
    return {
        active: function () { return Object.keys(live).length; },
        set: function (callback, delay) {
            const id = next++;
            const token = { id: id };
            token.handle = setTimeout(function () { delete live[id]; callback(); }, delay);
            live[id] = token.handle;
            return token;
        },
        clear: function (token) {
            if (!token) return;
            clearTimeout(token.handle);
            delete live[token.id];
        },
        disposeAll: function () {
            Object.keys(live).forEach(function (id) { clearTimeout(live[id]); delete live[id]; });
        },
    };
}

function createFrameQueue() {
    let queue = [];
    let next = 1;
    return {
        pending: function () { return queue.length; },
        request: function (callback) {
            const handle = next++;
            queue.push({ handle: handle, callback: callback });
            return handle;
        },
        cancel: function (handle) {
            queue = queue.filter(function (entry) { return entry.handle !== handle; });
        },
        drain: function (limit) {
            let guard = 0;
            while (queue.length && guard++ < (limit || 8)) {
                const due = queue;
                queue = [];
                for (let i = 0; i < due.length; i++) due[i].callback(0);
            }
        },
    };
}

// ─── The engine realm (only environment doubles) ─────────────────────────────
function loadEngine(fakeFs) {
    const context = {
        window: {
            rootPath: LIBRARY_ROOT,
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function () { throw new Error("media import must not create media elements"); },
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
    ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.MediaImportCoordinator !== "function") {
        throw new Error("MediaImportCoordinator was not exposed by the media engine");
    }
    return context.window;
}

// Count full-grid replacements (`grid.innerHTML = ...`) — the renderer path a
// media import must never take.
function watchFullGridReplacement(element) {
    const descriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "innerHTML");
    const state = { assignments: 0 };
    Object.defineProperty(element, "innerHTML", {
        configurable: true,
        get: function () { return descriptor.get.call(element); },
        set: function (value) { state.assignments++; descriptor.set.call(element, value); },
    });
    return state;
}

// Scripted scroll/click dispatch measured through the real recorder.
function createInteractionHarness(clock, metrics, grid) {
    const listeners = {};
    const acknowledged = [];
    listeners.scroll = function (event) {
        grid.setAttribute("data-scrolltop", String(event.value));
    };
    listeners.click = function (event) {
        grid.setAttribute("data-selected", event.label);
    };
    return {
        acknowledged: acknowledged,
        dispatch: function (type, label) {
            const startedAt = clock.now();
            metrics.stageStart("interaction", label);
            let handled = false;
            metrics.phase("panel interaction", function () {
                const handler = listeners[type];
                if (typeof handler !== "function") return;
                handler({ type: type, label: label, value: acknowledged.length + 1 });
                handled = true;
            });
            const record = metrics.stageEnd("interaction", label, "success");
            const entry = {
                type: type,
                label: label,
                handled: handled,
                ackMs: clock.now() - startedAt,
                recordedMs: record ? record.durationMs : null,
            };
            acknowledged.push(entry);
            return entry;
        },
    };
}

function defaultWorkers() {
    return {
        copy: function (item) {
            return Promise.resolve({ ok: true, fileSize: 4096, path: item.destinationMedia });
        },
        thumbnail: function (item) {
            // A `.mov` source models the codec route that needs the FFmpeg lane.
            const needsFfmpeg = item.isVideo && /\.mov$/i.test(item.fileName);
            const result = { ok: true, path: item.destinationThumbnail, status: "available" };
            if (needsFfmpeg) result.needsFfmpeg = true;
            return Promise.resolve(result);
        },
        ffmpeg: function (item) {
            return Promise.resolve({
                ok: true,
                thumbnailPath: item.destinationThumbnail,
                proxyPath: item.destinationFolder + "/proxy.mp4",
            });
        },
    };
}

// ─── Panel fixture: real coordinators, repository, card helper and DOM ───────
function buildPanel(options) {
    options = options || {};
    const panel = {};
    const clock = createClock();
    const realm = createMetricsRealm(clock);
    const metrics = realm.metrics;

    const filesystem = createFakeFilesystem(clock);
    filesystem.addDirectory(SOURCE_FOLDER);
    const files = options.files || [];
    for (let i = 0; i < files.length; i++) filesystem.addFile(files[i]);

    const engine = loadEngine(filesystem.fs);

    const document = createMiniDocument();
    const grid = document.createElement("div");
    grid.className = "card-grid";
    document.body.appendChild(grid);

    const cardFailures = [];
    const cards = new KeyedMediaCardHelper({
        document: document,
        renderCardMarkup: renderTemplateCardMarkup,
        metrics: metrics,
        onFailedUpdate: function (reason) { cardFailures.push(reason); },
    });

    const mirror = [];
    const persisted = [];
    const repository = new MediaEntryRepository({
        entries: options.existing || [],
        allTemplates: mirror,
        validityKey: options.validityKey || VALIDITY_KEY,
        persist: function (serialized) {
            if (options.persistFailure === true) throw new Error("storage unavailable");
            persisted.push(serialized);
        },
    });

    const admitted = [];
    const scheduler = createRecordingScheduler(clock, {
        onAdmit: function (record) {
            admitted.push({ record: record, gridChildren: grid.children.length });
            if (typeof options.onAdmit === "function") options.onAdmit(record, panel);
        },
    });

    const timers = createTimerRegistry();
    const frames = createFrameQueue();
    const categoryUpdates = [];
    const refreshes = [];
    const terminals = [];

    const coordinator = new engine.MediaImportCoordinator({
        fs: filesystem.fs,
        scheduler: scheduler,
        repository: repository,
        cardHelper: cards,
        metrics: metrics,
        grid: grid,
        rootPath: LIBRARY_ROOT,
        caseInsensitivePaths: true,
        reconcileAfterIdle: false,
        progressIntervalMs: 60000,
        idFactory: function (sequence) { return "media-t79-" + sequence; },
        updateCategoryCounts: function (counts, batchId) {
            categoryUpdates.push({ counts: counts, batchId: batchId });
        },
        requestAnimationFrame: frames.request,
        cancelAnimationFrame: frames.cancel,
        setTimeout: timers.set,
        clearTimeout: timers.clear,
        categoryRefresh: function () { refreshes.push("category"); },
        gridRefresh: function () { refreshes.push("grid"); },
        onTerminal: function (item, terminal) { terminals.push({ id: item.id, terminal: terminal }); },
        workers: options.workers || defaultWorkers(),
    });

    panel.clock = clock;
    panel.metrics = metrics;
    panel.metricsEvents = realm.events;
    panel.metricsPhases = realm.phases;
    panel.filesystem = filesystem;
    panel.engine = engine;
    panel.document = document;
    panel.grid = grid;
    panel.gridWatch = watchFullGridReplacement(grid);
    panel.cards = cards;
    panel.cardFailures = cardFailures;
    panel.mirror = mirror;
    panel.persisted = persisted;
    panel.repository = repository;
    panel.scheduler = scheduler;
    panel.admitted = admitted;
    panel.timers = timers;
    panel.frames = frames;
    panel.categoryUpdates = categoryUpdates;
    panel.refreshes = refreshes;
    panel.terminals = terminals;
    panel.coordinator = coordinator;
    panel.interactions = createInteractionHarness(clock, metrics, grid);
    panel.teardown = function () {
        coordinator.dispose();
        cards.dispose();
        timers.disposeAll();
    };
    return panel;
}

function mediaFile(name) {
    return SOURCE_FOLDER + "/" + name;
}

function legacyEntry(index, category, sourceName) {
    return {
        id: "legacy-" + index,
        name: "legacy-" + index,
        category: category,
        section: "footage",
        type: "media",
        mediaType: "video",
        folderPath: LIBRARY_ROOT + "/footage/legacy/" + index,
        sourcePath: "C:/archive/legacy-" + index + "-" + (sourceName || "clip") + ".mp4",
        mainFile: "legacy-" + index + ".mp4",
        thumbStatus: "ready",
        terminalState: "ready",
    };
}

function countByCategory(entries) {
    const counts = {};
    for (let i = 0; i < entries.length; i++) {
        const key = entries[i] && entries[i].category !== undefined ? String(entries[i].category) : "";
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

function classTokens(card) {
    return String(card.className || "").split(/\s+/).filter(function (token) { return !!token; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Req 1.4, 1.5, 2.1, 2.2, 2.5 — instrumented 100 ms budgets
// ─────────────────────────────────────────────────────────────────────────────

describe("instrumented card insertion and interaction budgets (Req 1.4, 1.5, 2.1, 2.2, 2.5)", function () {
    let panel = null;
    afterEach(function () { if (panel) panel.teardown(); panel = null; });

    test("a mixed folder import inserts every card and acknowledges scripted input inside 100 ms", async function () {
        const files = ["shot-1.png", "shot-2.jpg", "clip-1.mp4", "clip-2.mov"].map(mediaFile);
        panel = buildPanel({
            files: files,
            onAdmit: function (record, activePanel) {
                // Scripted scroll and click while the Import_Batch still has
                // pending items (the first two admitted stage jobs).
                if (record.index === 1) activePanel.interactions.dispatch("scroll", "scroll-1");
                if (record.index === 2) activePanel.interactions.dispatch("click", "click-1");
            },
        });

        panel.metrics.start("media-import-mixed", "protocol-mixed-50", { fileCount: files.length });
        panel.metrics.recordPickerResult();
        const result = await panel.coordinator.importSelection([SOURCE_FOLDER], {
            section: "footage",
            category: "Imported",
            batchId: "batch-79-a",
        });
        panel.frames.drain();
        const report = panel.metrics.finishScenario({ childProcesses: 0, videoDecoders: 0 });

        expect(result.ok).toBe(true);
        expect(result.accepted.length).toBe(files.length);

        // Req 2.1: the first Optimistic_Card is visible within 100 ms of Picker_Result.
        expect(report.pickerResultMs).not.toBeNull();
        expect(report.firstCardVisibleMs).not.toBeNull();
        expect(report.firstCardVisibleMs).toBeGreaterThanOrEqual(report.pickerResultMs);
        expect(report.firstCardVisibleMs - report.pickerResultMs).toBeLessThanOrEqual(RESPONSE_BUDGET_MS);
        expect(report.cardVisibility.length).toBe(1);
        expect(report.cardVisibility[0].mediaId).toBe(result.accepted[0].id);

        // Req 2.2: the whole batch is inserted within 100 ms of discovery completion…
        expect(report.discoveryCompleteMs).toBeGreaterThan(0); // discovery really cost measured time
        expect(report.firstCardVisibleMs - report.discoveryCompleteMs).toBeLessThanOrEqual(RESPONSE_BUDGET_MS);
        expect(panel.grid.children.length).toBe(files.length);
        // …and before any per-item background work is admitted.
        expect(panel.admitted.length).toBeGreaterThan(0);
        expect(panel.admitted[0].record.stage).toBe("copy");
        expect(panel.admitted[0].gridChildren).toBe(files.length);

        // Req 2.5 / 1.5: each scripted scroll and click handler ran within 100 ms.
        expect(panel.interactions.acknowledged.length).toBe(2);
        panel.interactions.acknowledged.forEach(function (entry) {
            expect(entry.handled).toBe(true);
            expect(entry.ackMs).toBeLessThanOrEqual(RESPONSE_BUDGET_MS);
            expect(entry.recordedMs).not.toBeNull();
            expect(entry.recordedMs).toBeLessThanOrEqual(RESPONSE_BUDGET_MS);
        });
        expect(panel.grid.getAttribute("data-scrolltop")).toBe("1");
        expect(panel.grid.getAttribute("data-selected")).toBe("click-1");

        // Req 1.4: per-stage durations, lane depths, FFmpeg peak, failed patches.
        result.accepted.forEach(function (entry) {
            const stages = report.stages.filter(function (record) { return record.mediaId === entry.id; });
            const names = stages.map(function (record) { return record.stage; });
            expect(names).toContain("copy");
            expect(names).toContain("thumbnail");
            stages.forEach(function (record) {
                expect(isFinite(record.durationMs)).toBe(true);
                expect(record.durationMs).toBeGreaterThanOrEqual(0);
                expect(record.outcome).toBe("success");
            });
        });
        expect(report.lanes.filesystem.maximumPendingDepth).toBeGreaterThanOrEqual(1);
        expect(report.lanes.thumbnail.maximumPendingDepth).toBeGreaterThanOrEqual(0);
        expect(typeof report.peaks.ffmpegProcesses).toBe("number");
        expect(report.failedKeyedPatches).toBe(0);
        expect(panel.cardFailures).toEqual([]);

        // Req 1.5: every recorded Long_Task carries a known media phase.
        report.longTasks.forEach(function (task) {
            expect(panel.metricsPhases[task.phase] === true || task.phase === "unattributed").toBe(true);
            expect(isFinite(task.durationMs)).toBe(true);
        });
        // Req 1.7: one aggregate summary for the scenario.
        expect(panel.metricsEvents.filter(function (event) { return event.name === "media.scenario"; }).length).toBe(1);

        // Req 3.5 / 3.7: every item settled once and nothing stayed pending.
        const snapshot = panel.coordinator.snapshot("batch-79-a");
        expect(snapshot.pendingCount).toBe(0);
        expect(snapshot.inFlightCount).toBe(0);
        expect(snapshot.terminalCount).toBe(files.length);
        expect(snapshot.idle).toBe(true);
        expect(snapshot.timerCount).toBe(0);
        expect(panel.timers.active()).toBe(0);
        expect(panel.terminals.map(function (entry) { return entry.terminal; })).toEqual(["ready", "ready", "ready", "ready"]);

        // Req 7.2: terminal updates keep the committed category and add the proxy.
        const durable = panel.repository.snapshot();
        expect(durable.length).toBe(files.length);
        durable.forEach(function (entry) {
            expect(entry.category).toBe("Imported");
            expect(entry.terminalState).toBe("ready");
            expect(entry._isPending).toBe(false);
            expect(entry.thumbStatus).toBe("ready");
            const card = panel.document.getElementById("tpl-" + entry.id);
            expect(card).not.toBeNull();
            expect(card.getAttribute("data-terminalstate")).toBe("ready");
            expect(classTokens(card)).not.toContain("media-pending");
        });
        const movEntry = durable.filter(function (entry) { return /\.mov$/i.test(entry.mainFile || ""); })[0];
        expect(movEntry.proxyFile).toBe(movEntry.folderPath + "/proxy.mp4");
        expect(panel.scheduler.stagesFor(movEntry.id)).toEqual(["copy", "thumbnail", "ffmpeg"]);

        // Req 2.3 / 2.8: refreshes were coalesced onto animation frames, not per file.
        expect(panel.frames.pending()).toBe(0);
        expect(panel.refreshes.filter(function (kind) { return kind === "grid"; }).length).toBeGreaterThanOrEqual(1);
        expect(panel.refreshes.filter(function (kind) { return kind === "category"; }).length).toBeGreaterThanOrEqual(1);
        expect(panel.refreshes.length).toBeLessThan(files.length * 2);
        expect(panel.gridWatch.assignments).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Req 2.6, 3.5-3.7, 5.13 — a failed commit admits no stage work
// ─────────────────────────────────────────────────────────────────────────────

describe("persistence failure before stage admission (Req 2.6, 3.5-3.7)", function () {
    let panel = null;
    afterEach(function () { if (panel) panel.teardown(); panel = null; });

    test("a failed commit leaves the durable index unchanged, fails the visible cards, and admits no work", async function () {
        const files = [mediaFile("fail-1.png"), mediaFile("fail-2.mp4")];
        panel = buildPanel({
            files: files,
            existing: [legacyEntry(1, "Alpha"), legacyEntry(2, "Beta")],
            persistFailure: true,
        });
        const before = JSON.stringify(panel.repository.snapshot());

        const result = await panel.coordinator.importSelection(files, {
            section: "footage",
            category: "Imported",
            batchId: "batch-79-b",
        });
        panel.frames.drain();

        // Req 5.13: the last successful durable index survives, with an error indication.
        expect(result.ok).toBe(false);
        expect(result.commit.ok).toBe(false);
        expect(result.commit.operation).toBe("commitOptimisticBatch");
        expect(JSON.stringify(panel.repository.snapshot())).toBe(before);
        expect(panel.repository.snapshot().length).toBe(2);
        expect(panel.repository.lastError().operation).toBe("commitOptimisticBatch");
        expect(panel.persisted.length).toBe(0);
        expect(panel.mirror.length).toBe(0);

        // Req 3.5-3.7: no copy, thumbnail, or FFmpeg work was admitted at all.
        expect(panel.scheduler.jobs.length).toBe(0);
        expect(panel.admitted.length).toBe(0);
        expect(panel.categoryUpdates.length).toBe(0);
        expect(panel.timers.active()).toBe(0);

        // The already visible Optimistic_Cards render the failed state.
        expect(result.accepted.length).toBe(2);
        expect(panel.grid.children.length).toBe(2);
        result.accepted.forEach(function (entry) {
            const card = panel.document.getElementById("tpl-" + entry.id);
            expect(card).not.toBeNull();
            expect(card.getAttribute("data-terminalstate")).toBe("failed");
            expect(card.getAttribute("data-thumbstatus")).toBe("failed");
            expect(card.getAttribute("data-derivativestatus")).toBe("commit-failed");
            expect(classTokens(card)).toContain("thumb-failed");
            expect(classTokens(card)).not.toContain("media-pending");
        });
        expect(panel.cardFailures).toEqual([]);

        // No item is left pending once the batch has settled as failed.
        const snapshot = panel.coordinator.snapshot("batch-79-b");
        expect(snapshot.pendingCount).toBe(0);
        expect(snapshot.inFlightCount).toBe(0);
        expect(snapshot.terminalCount).toBe(2);
        expect(snapshot.idle).toBe(true);
        expect(panel.gridWatch.assignments).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Req 5.9, 5.10, 7.11 — duplicate paths collapse, duplicate names do not
// ─────────────────────────────────────────────────────────────────────────────

describe("duplicate source paths and duplicate display names (Req 5.9, 5.10)", function () {
    let panel = null;
    afterEach(function () { if (panel) panel.teardown(); panel = null; });

    test("one normalized path yields one entry while two paths with the same name yield two", async function () {
        const first = mediaFile("clip.mp4");
        const second = SOURCE_FOLDER + "/two/clip.mp4";
        panel = buildPanel({ files: [first, second, mediaFile("notes.txt")] });

        const selection = [
            first,
            "C:\\originals\\mixed\\clip.mp4",       // backslashes
            SOURCE_FOLDER + "/./clip.mp4",           // dot segment
            first + "/",                             // trailing separator
            SOURCE_FOLDER + "/two/../clip.mp4",      // parent segment
            second,                                  // same display name, distinct path
            mediaFile("notes.txt"),                  // unsupported format
        ];

        const result = await panel.coordinator.importSelection(selection, {
            section: "footage",
            batchId: "batch-79-c",
        });
        panel.frames.drain();

        // Req 5.10: five spellings of one Normalized_Source_Path collapse to one entry.
        // Req 5.9: the same display name at a distinct path stays a second entry.
        expect(result.ok).toBe(true);
        expect(result.accepted.length).toBe(2);
        expect(panel.coordinator.totals.deduplicated).toBe(4);
        expect(result.accepted.map(function (entry) { return entry.sourcePath; })).toEqual([first, second]);
        expect(result.accepted.map(function (entry) { return entry.name; })).toEqual(["clip", "clip"]);

        const ids = result.accepted.map(function (entry) { return entry.id; });
        expect(ids[0]).not.toBe(ids[1]);
        expect(result.accepted[0].folderPath).not.toBe(result.accepted[1].folderPath);

        const durable = panel.repository.snapshot();
        expect(durable.length).toBe(2);
        expect(durable.map(function (entry) { return entry.id; }).sort()).toEqual(ids.slice().sort());
        expect(panel.grid.children.length).toBe(2);
        ids.forEach(function (id) {
            expect(panel.document.querySelectorAll("#tpl-" + id).length).toBe(1);
        });

        // Req 5.10 across batches: re-submitting the same paths adds nothing.
        const repeat = await panel.coordinator.importSelection([first, second], {
            section: "footage",
            batchId: "batch-79-c2",
        });
        expect(repeat.empty).toBe(true);
        expect(panel.repository.snapshot().length).toBe(2);
        expect(panel.grid.children.length).toBe(2);
        expect(panel.cardFailures).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Req 2.7, 7.4 — one exact aggregate count update, and an inert cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe("aggregate category totals after a batch (Req 2.7, 7.4)", function () {
    let panel = null;
    afterEach(function () { if (panel) panel.teardown(); panel = null; });

    test("exactly one aggregate update reports counts equal to index membership", async function () {
        const files = [mediaFile("a.png"), mediaFile("b.jpg"), mediaFile("c.mp4")];
        panel = buildPanel({
            files: files,
            existing: [legacyEntry(1, "Alpha", "one"), legacyEntry(2, "Alpha", "two"), legacyEntry(3, "Beta", "three")],
        });

        const result = await panel.coordinator.importSelection([SOURCE_FOLDER], {
            section: "footage",
            category: "Imported",
            batchId: "batch-79-d",
        });
        panel.frames.drain();

        expect(result.ok).toBe(true);
        expect(panel.categoryUpdates.length).toBe(1);
        expect(panel.coordinator.totals.categoryCountUpdates).toBe(1);
        expect(panel.categoryUpdates[0].batchId).toBe("batch-79-d");

        const durable = panel.repository.snapshot();
        const reported = panel.categoryUpdates[0].counts;
        expect(reported).toEqual(countByCategory(durable));
        expect(reported).toEqual({ Alpha: 2, Beta: 1, Imported: 3 });

        const total = Object.keys(reported).reduce(function (sum, key) { return sum + reported[key]; }, 0);
        expect(total).toBe(durable.length);
        expect(durable.length).toBe(6);

        // Req 2.6: the pre-existing entries are retained and no scan was started.
        ["legacy-1", "legacy-2", "legacy-3"].forEach(function (id) {
            expect(panel.repository.getById(id)).not.toBeNull();
        });
        expect(panel.filesystem.countOf("readdir")).toBe(1);
    });

    test("a cancelled picker leaves the index, card order, and reported counts untouched", async function () {
        const files = [mediaFile("a.png"), mediaFile("b.mp4")];
        panel = buildPanel({ files: files, existing: [legacyEntry(1, "Alpha")] });

        await panel.coordinator.importSelection([SOURCE_FOLDER], {
            section: "footage",
            category: "Imported",
            batchId: "batch-79-e",
        });
        panel.frames.drain();

        const beforeIndex = JSON.stringify(panel.repository.snapshot());
        const beforeCards = panel.grid.children.map(function (card) { return card.id; });
        const beforeCounts = panel.categoryUpdates.length;
        const beforeJobs = panel.scheduler.jobs.length;

        // A cancelled picker returns no selection at all (Req 7.4).
        const cancelled = await panel.coordinator.importSelection([], { section: "footage" });
        panel.frames.drain();

        expect(cancelled.ok).toBe(true);
        expect(cancelled.empty).toBe(true);
        expect(cancelled.accepted).toEqual([]);
        expect(JSON.stringify(panel.repository.snapshot())).toBe(beforeIndex);
        expect(panel.grid.children.map(function (card) { return card.id; })).toEqual(beforeCards);
        expect(panel.categoryUpdates.length).toBe(beforeCounts);
        expect(panel.scheduler.jobs.length).toBe(beforeJobs);
        expect(panel.gridWatch.assignments).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Req 5.5, 7.5 — warm startup projects the index with no library scan
// ─────────────────────────────────────────────────────────────────────────────

describe("warm startup after a completed import (Req 5.5, 7.5)", function () {
    let panel = null;
    afterEach(function () { if (panel) panel.teardown(); panel = null; });

    test("the persisted index renders one card per entry with no full library scan", async function () {
        const files = [mediaFile("warm-1.png"), mediaFile("warm-2.mov")];
        panel = buildPanel({ files: files });

        const result = await panel.coordinator.importSelection([SOURCE_FOLDER], {
            section: "footage",
            category: "Imported",
            batchId: "batch-79-f",
        });
        panel.frames.drain();
        expect(result.ok).toBe(true);

        const endOfImport = JSON.parse(JSON.stringify(panel.repository.snapshot()));
        expect(endOfImport.length).toBe(files.length);

        // The import itself enumerated only the picked folder.
        expect(panel.filesystem.countOf("readdir")).toBe(1);

        // Req 7.5-style projection: the persisted index needs no full scan…
        const serialized = panel.persisted[panel.persisted.length - 1];
        expect(typeof serialized).toBe("string");
        expect(LibraryIndex.fullScanRequired(serialized, VALIDITY_KEY)).toBe(false);
        const warmIndex = LibraryIndex.parse(serialized);
        expect(warmIndex.needsFullScan()).toBe(false);
        expect(warmIndex.validityKey).toBe(VALIDITY_KEY);

        // Req 5.5: every top-level field and value survives to Warm_Startup.
        expect(JSON.parse(JSON.stringify(warmIndex.entries()))).toEqual(endOfImport);

        // Warm render from the index alone: any filesystem use would be a scan.
        const strict = createStrictFilesystem();
        const warmRepository = new MediaEntryRepository({
            entries: warmIndex.entries(),
            validityKey: warmIndex.validityKey,
            fs: strict.fs,
            persist: function () { },
        });
        const warmDocument = createMiniDocument();
        const warmGrid = warmDocument.createElement("div");
        warmGrid.className = "card-grid";
        warmDocument.body.appendChild(warmGrid);
        const warmCards = new KeyedMediaCardHelper({
            document: warmDocument,
            renderCardMarkup: renderTemplateCardMarkup,
        });

        const inserted = warmCards.insertBatch(warmRepository.snapshot(), warmGrid);
        expect(inserted.ok).toBe(true);
        expect(warmGrid.children.length).toBe(endOfImport.length);
        expect(strict.calls).toEqual([]);

        endOfImport.forEach(function (entry) {
            const card = warmDocument.getElementById("tpl-" + entry.id);
            expect(card).not.toBeNull();
            expect(card.getAttribute("data-cat")).toBe(entry.category);
            expect(card.getAttribute("data-folder")).toBe(entry.folderPath);
            expect(card.getAttribute("data-mediapath")).toBe(entry.proxyFile || entry.mediaFile);
            expect(card.getAttribute("data-thumb")).toBe("file:///" + encodeURI(entry.thumbnailPath.replace(/^\//, "")));
            expect(card.querySelectorAll(".thumb-img").length).toBe(1);
            expect(classTokens(card)).not.toContain("media-pending");
        });

        warmCards.dispose();
    });
});

// ─── M9 (task 27): Windows MAX_PATH guard for media storage paths ────────────
//
// mediaIdFolderSegment expands an id to ~85-105 chars and deep library roots
// add another 100-150, so assembled destination paths can exceed MAX_PATH
// (260). The engine must (a) cap the stored filename deterministically so the
// assembled path fits the 240-char budget, (b) prefix long Windows paths with
// \\?\ at the fs boundary, and (c) keep dedupe keyed on the SOURCE path.
describe("M9 — Windows MAX_PATH guard for media storage paths", function () {
    const LONG_ROOT = "C:/vault/projects/archive/2026/client-deliverables/comp-saver/library/of/very/deeply/nested/folders";
    const LONG_FILE_NAME = "an-extremely-descriptive-final-render-approved-v12-with-notes-from-the-review-session.mov";
    const LONG_SOURCE = SOURCE_FOLDER + "/" + LONG_FILE_NAME;

    function makeCoordinator(engine, fakeFs, rootPath, existing) {
        return new engine.MediaImportCoordinator({
            fs: fakeFs,
            repository: { snapshot: function () { return existing.slice(); } },
            rootPath: rootPath,
            caseInsensitivePaths: true,
            idFactory: function (sequence) { return "media-m9-" + sequence; },
        });
    }

    it("caps long destination paths deterministically inside the 240-char budget", function () {
        const filesystem = createFakeFilesystem(createClock());
        const engine = loadEngine(filesystem.fs);
        const coordinator = makeCoordinator(engine, filesystem.fs, LONG_ROOT, []);

        const prepared = coordinator._prepare([LONG_SOURCE], { section: "footage", category: "Imported" });
        const item = prepared.items[0];

        // The assembled destination fits the budget (and MAX_PATH) while the
        // extension survives and an 8-hex fingerprint keeps the name unique.
        expect(item.destinationMedia.length).toBeLessThanOrEqual(240);
        expect(item.destinationMedia.length).toBeLessThan(260);
        expect(item.fileName).toMatch(/-[0-9a-f]{8}\.mov$/);
        expect(item.fileName).not.toBe(LONG_FILE_NAME);
        expect(item.entry.mainFile).toBe(item.fileName);

        // Deterministic: preparing the same source again yields the same
        // capped filename (the id segment differs per import by design).
        const again = makeCoordinator(engine, filesystem.fs, LONG_ROOT, [])._prepare([LONG_SOURCE], { section: "footage", category: "Imported" });
        expect(again.items[0].fileName).toBe(item.fileName);

        // Identity stays on the source path, never on the stored filename.
        expect(item.sourcePath).toBe(LONG_SOURCE);
        expect(item.entry.sourcePath).toBe(item.sourcePath);
    });

    it("leaves short destination paths untouched (backward compatible)", function () {
        const filesystem = createFakeFilesystem(createClock());
        const engine = loadEngine(filesystem.fs);
        const shortSource = SOURCE_FOLDER + "/clip.mov";
        const coordinator = makeCoordinator(engine, filesystem.fs, LIBRARY_ROOT, []);

        const prepared = coordinator._prepare([shortSource], { section: "footage", category: "Imported" });
        const item = prepared.items[0];

        expect(item.fileName).toBe("clip.mov");
        expect(item.destinationMedia).toBe(item.destinationFolder + "/clip.mov");
    });

    it("keeps dedupe keyed on the source path after filename capping", async function () {
        const filesystem = createFakeFilesystem(createClock());
        filesystem.addFile(LONG_SOURCE);
        const engine = loadEngine(filesystem.fs);
        const canonicalSource = canonicalPath(LONG_SOURCE);

        // An entry already committed under the SAME source (with a capped
        // stored name) must suppress re-import via discover.
        const existing = [{ id: "media-m9-existing", sourcePath: canonicalSource, mainFile: "capped-1a2b3c4d.mov" }];
        const withExisting = makeCoordinator(engine, filesystem.fs, LONG_ROOT, existing);
        const rejected = await withExisting.discover([LONG_SOURCE]);
        expect(rejected).toEqual([]);
        expect(withExisting.totals.deduplicated).toBe(1);

        // Without that entry the source is accepted, and duplicates inside a
        // single selection still collapse to one import.
        const fresh = makeCoordinator(engine, filesystem.fs, LONG_ROOT, []);
        const accepted = await fresh.discover([LONG_SOURCE, LONG_SOURCE]);
        expect(accepted).toEqual([canonicalSource]);
        expect(fresh.totals.deduplicated).toBe(1);
    });

    it("prefixes long Windows paths with \\?\ at the fs write boundary only", async function () {
        const writes = [];
        const recordingFs = {
            promises: {
                writeFile: function (target) {
                    writes.push(String(target));
                    return Promise.resolve();
                },
            },
        };
        const engine = loadEngine(recordingFs);
        const work = new engine.MediaWorkCoordinator({});

        const deepFolder = LONG_ROOT + "/footage/imported/" + "media" + "-0061".repeat(24);
        expect(deepFolder.length).toBeGreaterThan(240);
        work._persistMediaMetaFile({
            id: "media-m9-long",
            destinationFolder: deepFolder,
            destinationMedia: deepFolder + "/stored.mov",
            fileName: "stored.mov",
            sourcePath: LONG_SOURCE,
            entry: { sourcePath: LONG_SOURCE, section: "footage", mediaType: "video" },
            isVideo: true,
        }, {});
        await Promise.resolve();
        await Promise.resolve();
        expect(writes.length).toBe(1);
        expect(writes[0].indexOf("\\\\?\\")).toBe(0);
        expect(writes[0].indexOf("/")).toBe(-1);

        // Short folders keep their current on-disk shape — no prefix.
        const shortFolder = LIBRARY_ROOT + "/footage/imported/media-0061";
        work._persistMediaMetaFile({
            id: "media-m9-short",
            destinationFolder: shortFolder,
            destinationMedia: shortFolder + "/stored.mov",
            fileName: "stored.mov",
            sourcePath: LONG_SOURCE,
            entry: { sourcePath: LONG_SOURCE, section: "footage", mediaType: "video" },
            isVideo: true,
        }, {});
        await Promise.resolve();
        await Promise.resolve();
        expect(writes.length).toBe(2);
        expect(writes[1].indexOf("\\\\?\\")).toBe(-1);
    });

    it("rewrites long UNC roots to the \\?\UNC\ extended form", async function () {
        const writes = [];
        const recordingFs = {
            promises: {
                writeFile: function (target) {
                    writes.push(String(target));
                    return Promise.resolve();
                },
            },
        };
        const engine = loadEngine(recordingFs);
        const work = new engine.MediaWorkCoordinator({});

        const uncFolder = "//studio-nas/shared/projects/archive/comp-saver/library/footage/imported/" + "media" + "-0061".repeat(36);
        expect(uncFolder.length).toBeGreaterThan(240);
        work._persistMediaMetaFile({
            id: "media-m9-unc",
            destinationFolder: uncFolder,
            destinationMedia: uncFolder + "/stored.mov",
            fileName: "stored.mov",
            sourcePath: LONG_SOURCE,
            entry: { sourcePath: LONG_SOURCE, section: "footage", mediaType: "video" },
            isVideo: true,
        }, {});
        await Promise.resolve();
        await Promise.resolve();
        expect(writes.length).toBe(1);
        expect(writes[0].toLowerCase().indexOf("\\\\?\\unc\\studio-nas")).toBe(0);
    });
});
